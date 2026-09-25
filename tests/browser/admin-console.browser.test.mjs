// Hermetic browser tests for the administration console — the M4-ADMIN-UI-P1 and P2 contracts in
// docs/phase-4/03-backend-control-plane-login-session-blueprint.md §2a — against a
// PRODUCTION build. Chromium never reaches a network: CDP Fetch interception answers every request.
// Admin-host pages, assets and unknown API paths are forwarded to the REAL production listener
// (server/runtime/adminWebServer.ts) on a loopback port and fulfilled with its exact status, headers
// and body, so the shipped serving code and header policy are what Chromium enforces. The scripted
// "runtime" here answers only the session, Command Center and tenant directory routes (the list and
// its two commands, over synthetic tenants); the identity provider is synthetic; everything else is
// failed. The build runs with a sanitized environment.
//
//   tsx --test tests/browser/admin-console.browser.test.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminWebHeaders, apiPathRefusal, isApiPath } from '../../server/runtime/adminWeb.ts';
import { createAdminWebListener, loadAdminBuild } from '../../server/runtime/adminWebServer.ts';
import { encodeTenantCursor } from '../../server/runtime/tenantDirectory.ts';
import { CONSOLE_MODULES } from '../../src/backend-control-plane/console/navigation.ts';
import { findChromium, launch, redact } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_HOST = 'admin.tmpos.test';
const TENANT_HOST = 'tenant.tmpos.test';
const ADMIN = `https://${ADMIN_HOST}`;
const TENANT = `https://${TENANT_HOST}`;
const IDP_HOST = 'identitytoolkit.googleapis.com';
const EVIDENCE = process.env.M4UI_EVIDENCE ?? process.env.M4UI_EVIDENCE_DIR ?? '/tmp/claude-1000/-home-runner-workspace/9a614741-ba2d-401d-9de9-6f8921e35ae8/scratchpad/m4ui-p2/evidence';
const LOGS = join(EVIDENCE, '..', 'logs');
const DESKTOP = [1440, 900, false];
const TABLET = [768, 1024, false];
const MOBILE = [390, 844, true];
const ZOOM_400 = [320, 256, false]; // a 1280×1024 desktop at 400% zoom: the WCAG 1.4.10 reflow width
const CHROMIUM = findChromium();
const SKIP = 'Chromium not found: set CHROMIUM_PATH, or provide /repl/tools/bin/chromium or `chromium` on PATH';

// The admin web policy exactly as production builds it. The auth domain is the committed Firebase
// config the build embeds; it is never printed (redact() masks it), so CSP comparisons use assert.ok.
const AUTH_DOMAIN = JSON.parse(readFileSync(join(ROOT, 'firebase-applet-config.json'), 'utf8')).authDomain;
const WEB = { authDomain: AUTH_DOMAIN, https: true };
const API_POLICY = apiPathRefusal({ https: true }); // the runtime API header policy (HSTS over https)

const UID = 'uid-synthetic-7f3a';
const OTHER_UID = 'uid-synthetic-other-c41d'; // a second synthetic administrator, for the recent sign-in that must not resume
const EMAIL = 'operator@tmpos.test';
const PASSWORD = 'synthetic-password-1';
const TOTP = '123456';
const MFA_INFO = { mfaEnrollmentId: 'totp-enrollment-synthetic', displayName: 'Authenticator', enrolledAt: '2026-01-01T00:00:00Z', totpInfo: {} };
const COOKIE = '__Host-tmpos_admin_session';
const TENANT_COOKIE = '__Host-tmpos_tenant_session';
const SESSION = '/admin/v1/session';
const LOGIN = '/admin/v1/session/login';
const LOGOUT = '/admin/v1/session/logout';
const CC = '/admin/v1/command-center';
const TENANTS = '/admin/v1/tenants';
const RENAME = '/admin/v1/tenants/display-name';
const LIFECYCLE = '/admin/v1/tenants/status';
const KNOWN_API = new Set([`GET ${SESSION}`, `POST ${LOGIN}`, `POST ${LOGOUT}`, `GET ${CC}`, `GET ${TENANTS}`, `PATCH ${RENAME}`, `PATCH ${LIFECYCLE}`]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROBE = '/__probe.html'; // test-only tenant-host pages (no CSP): a blank page and a framer
const FRAMER = '/__framer.html';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const NOTICE = {
  denied: 'Sign-in failed. Check your details and try again.',
  rateLimited: 'Too many attempts. Wait a few minutes, then try again.',
  unavailable: 'Sign-in is temporarily unavailable.',
  expired: 'Your session has ended. Sign in again to continue.',
  loggedOut: 'You have signed out.',
};
const CC_TEXT = {
  partial: 'Some sources are unavailable or not configured. Their sections show no figures.',
  unavailable: "The Command Center didn't load. Try again in a moment.",
  forbidden: "The Command Center isn't available for this account.",
  rateLimited: 'Too many requests. Wait a moment, then refresh.',
  empty: 'Nothing needs attention right now.',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
// The scripted runtime answers under the runtime's own API header policy, as app.ts does.
const JSON_HEADERS = [...Object.entries(API_POLICY.headers), ['Cache-Control', 'no-store']];
const HTML_HEADERS = [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'no-store']];
const CORS = [
  ['access-control-allow-origin', ADMIN], ['access-control-allow-methods', 'POST'],
  ['access-control-allow-headers', 'content-type,x-client-version,x-firebase-gmpid,x-firebase-client,x-firebase-appcheck,x-firebase-locale'],
  ['access-control-max-age', '600'], ['vary', 'origin'],
];
const ERRORS = { 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited', 503: 'unavailable' };
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'host']); // hop-by-hop: never forwarded either way

const token43 = () => randomBytes(32).toString('base64url'); // 43 chars of [A-Za-z0-9_-]
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (role, name) => ({ role, name });
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const line = (r) => `${r.method} ${r.host}${r.path}`;
const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** A synthetic, unsigned Firebase-shaped ID token for `uid`: the SDK parses it, nothing here verifies it. */
function idToken({ mfa, uid = UID }) {
  const now = Math.floor(Date.now() / 1000);
  const firebase = { identities: { email: [EMAIL] }, sign_in_provider: 'password', ...(mfa ? { sign_in_second_factor: 'totp', second_factor_identifier: MFA_INFO.mfaEnrollmentId } : {}) };
  const payload = { iss: 'https://securetoken.google.com/synthetic-project', aud: 'synthetic-project', auth_time: now, iat: now, exp: now + 3600, sub: uid, user_id: uid, email: EMAIL, email_verified: true, firebase };
  return `${b64u({ alg: 'RS256', kid: 'synthetic', typ: 'JWT' })}.${b64u(payload)}.${randomBytes(64).toString('base64url')}`;
}

// A Command Center view in the shape commandCenterView emits (server/runtime/commandCenter.ts),
// relative to now.
const ATTENTION = [{ severity: 'critical', area: 'security', count: 1 }, { severity: 'warning', area: 'provisioning', count: 3 }, { severity: 'info', area: 'billing', count: 2 }];
const SERVICES = [['auth', 'healthy'], ['pos', 'healthy'], ['repairs', 'warning'], ['inventory', 'healthy'], ['identity_link', 'healthy'], ['audit', 'healthy'], ['worker', 'unknown']];
function ccView({ tenants = 12, items = ATTENTION, stale = [], absent = {} } = {}) {
  const now = Date.now();
  const reading = (key, body) => {
    if (absent[key]) return { status: absent[key] };
    const old = stale.includes(key);
    return { status: 'available', asOf: new Date(now - (old ? 20 : 1) * 60_000).toISOString(), stale: old, ...body };
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    sections: {
      posture: reading('posture', { metrics: [{ key: 'tenants', value: tenants }, { key: 'stores', value: 48 }, { key: 'pending_approvals', value: 3 }, { key: 'critical_alerts', value: 1 }] }),
      attention: reading('attention', { items }),
      governance: reading('governance', { signals: [{ key: 'production_locked', state: 'ok' }, { key: 'approvals_enforced', state: 'ok' }, { key: 'audit_recording', state: 'attention' }] }),
      services: reading('services', { services: SERVICES.map(([key, state]) => ({ key, state })) }),
    },
  };
}

// The synthetic platform tenant directory (invented ids and names), oldest first. The script pages it
// DIRECTORY_PAGE at a time — under the limit the page asks for — so the first page carries a cursor.
const HARBOR = { tenantId: '5f0c2a1e-8b3d-4e7a-9c21-0d4b6e8f1a01', displayName: 'Harbor Lane Repairs', status: 'active', version: 3 };
const UNNAMED = { tenantId: '5f0c2a1e-8b3d-4e7a-9c21-0d4b6e8f1a02', displayName: null, status: 'active', version: 1 };
const CEDAR = { tenantId: '5f0c2a1e-8b3d-4e7a-9c21-0d4b6e8f1a03', displayName: 'Cedar Point Mobile', status: 'suspended', version: 7 };
const NORTHWIND = { tenantId: '5f0c2a1e-8b3d-4e7a-9c21-0d4b6e8f1a04', displayName: 'Northwind Trial Shop', status: 'trialing', version: 2 };
const DIRECTORY = [HARBOR, UNNAMED, CEDAR, NORTHWIND];
const DIRECTORY_PAGE = 3;

// ---------------------------------------------------------------------------------------------
// Per-scenario server script + recordings.
//   session: status for GET /admin/v1/session, a number or (request) => number. Default: 200 only
//            when the browser presents the admin cookie this scenario set, else 401.
//   cc:      the GET /admin/v1/command-center answer: a view object, a status number, 'malformed',
//            or (request) => one of those. Default: a full view whenever the session would be 200.
//   actions: the `actions` hint every GET /admin/v1/tenants page carries. Default: both allowed.
//   login / logout: status for those POSTs. provider: 'mfa' | 'password' | 'invalid'.
//   recentAuth: when true, PATCH /admin/v1/tenants/status answers 403 step_up_required unless the presented session
//            was created by a sign-in in this scenario (a seeded cookie never was), as the runtime's recent-auth rule.
//            A login sent with X-TMPOS-Reauthenticate: 1 rotates the session only when the presented cookie is the live
//            one and the bearer's subject is that session's administrator; otherwise 401 and the session is untouched.
//   cspIssues: the exact CSP reports ('directive|type|blockedURL') the scenario provokes on purpose,
//            each allowed once; cspLog: a RegExp for the console lines those same reports print.
//   allowBlocked: the exact refused requests ('METHOD url') the scenario makes on purpose.
function scenarioState({ session, cc, actions = { editDisplayName: true, changeStatus: true }, login = 200, logout = 204, provider = 'mfa', recentAuth = false, cspIssues = [], cspLog = null, allowBlocked = [] } = {}) {
  return {
    session: session ?? ((r) => (hasAdminCookie(r) ? 200 : 401)),
    cc: cc ?? ((r) => (statusFrom(st.session, r) === 200 ? ccView() : 401)),
    tenants: DIRECTORY.map((t) => ({ ...t })), actions,
    login, logout, provider, recentAuth, cspIssues, cspLog, allowBlocked,
    uid: UID, sessionUid: null, fresh: false, revoked: [], // who the provider signs in as; whose session the cookie is
    requests: [], idp: [], statics: [], served: [], blocked: [], csp: [], fontFiles: [], holds: new Map(), releases: [],
    ccHold: null, ccCount: 0, misroute: null, allowNav: new Set(),
    csrfToken: token43(), cookieValue: null, loginCsrf: null, idToken: null, finalizeIdToken: null, mfaPending: null, totpCode: null,
  };
}
let st = scenarioState();
let outDir = null;
let browser = null;
let web = null;
let ENTRY = new Set(); // the scripts index.html references: every other chunk is lazy
const files = new Map();

function hasAdminCookie(r) {
  return st.cookieValue !== null && (r.headers.cookie ?? '').split(/;\s*/).includes(`${COOKIE}=${st.cookieValue}`);
}
const statusFrom = (v, r) => (typeof v === 'function' ? v(r) : v);
const refusal = (status) => ({ status, headers: [...JSON_HEADERS, ...(status === 429 ? [['retry-after', '60']] : [])], body: JSON.stringify({ error: ERRORS[status] ?? 'error', requestId: 'r1' }) });
const active = (extra = []) => ({ status: 200, headers: [...JSON_HEADERS, ...extra], body: JSON.stringify({ status: 'active', csrfToken: st.csrfToken }) });
const postBody = (request) => request.postData ?? (request.postDataEntries ?? []).map((e) => Buffer.from(e.bytes ?? '', 'base64').toString('utf8')).join('');

/** Hold the identity-toolkit or tenant-directory answer for `path` until release() (bounded at 10 s). */
function hold(path) {
  let release;
  st.holds.set(path, new Promise((r) => { release = r; }));
  return () => { st.holds.delete(path); release(); };
}

/** Hold the NEXT Command Center answer until release() (bounded at 10 s); released at scenario end regardless. */
function holdCc() {
  let release;
  st.ccHold = new Promise((r) => { release = r; });
  st.releases.push(() => release());
  return () => release();
}

async function route(ev) {
  const { request } = ev;
  let u;
  try { u = new URL(request.url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null; // browser-internal schemes: refused, not recorded
  if (u.protocol === 'https:' && u.host === ADMIN_HOST) return adminHost(ev, u);
  if (u.protocol === 'https:' && u.host === TENANT_HOST) return tenantHost(ev, u);
  if (u.protocol === 'https:' && u.host === IDP_HOST) return identityToolkit(request, u);
  st.blocked.push(`${request.method} ${u.protocol}//${u.host}${u.pathname}`);
  return null;
}

function apiRecord(ev, u) {
  const { request } = ev;
  const rec = { method: request.method, host: u.host, path: u.pathname, type: ev.resourceType, headers: lower(request.headers), hasPostData: Boolean(request.hasPostData || request.postData), status: null };
  // Judged as the request arrived: a later recent sign-in rotates the cookie and the token.
  rec.cookieOk = hasAdminCookie(rec);
  rec.csrfOk = rec.headers['x-tmpos-session-csrf'] === st.csrfToken;
  st.requests.push(rec);
  return rec;
}

/** The subject of a synthetic bearer (the scripted runtime's stand-in for the verified token's uid), or null. */
function bearerUid(rec) {
  const m = /^Bearer [^.]+\.([^.]+)\./.exec(rec.headers.authorization ?? '');
  try { return m ? JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')).sub ?? null : null; } catch { return null; }
}

/**
 * The admin host. The scripted runtime answers the known session + Command Center routes; every
 * other request — the document, assets, misses, unknown API paths — is the production listener's
 * own answer. `misroute` simulates a misconfigured host that serves the SPA document for an API path.
 */
async function adminHost(ev, u) {
  const s = st; // this scenario's recordings, even when an answer is held past its end
  const { method } = ev.request;
  const api = isApiPath(u.pathname);
  const rec = api ? apiRecord(ev, u) : null;
  let res;
  if (s.misroute === u.pathname) res = await forward('GET', '/admin', ev.request.headers);
  else if (rec && KNOWN_API.has(`${method} ${u.pathname}`)) {
    res = u.pathname === CC ? await commandCenterApi(s) : u.pathname.startsWith(TENANTS) ? await tenantApi(s, rec, u, ev.request) : sessionApi(rec);
  }
  else res = await forward(method, `${u.pathname}${u.search}`, ev.request.headers);
  if (rec) rec.status = res.status;
  s.served.push({ method, path: u.pathname, type: ev.resourceType, status: res.status, headers: lower(Object.fromEntries(res.headers)) });
  if (!api) {
    s.statics.push(`${u.host}${u.pathname}`);
    if (res.status === 200 && FONT_HOSTS.some((h) => res.body.includes(h))) s.fontFiles.push(u.pathname);
  }
  return res;
}

/** Forward to the loopback production listener; its exact status, headers (minus hop-by-hop) and body. */
function forward(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: web.address().port, method, path, agent: false,
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k.toLowerCase()))),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) if (!HOP.has(res.rawHeaders[i].toLowerCase())) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode, headers: pairs, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function tenantHost(ev, u) {
  if (u.pathname === PROBE) return { status: 200, headers: HTML_HEADERS, body: '<!doctype html><title>probe</title>' };
  if (u.pathname === FRAMER) {
    return { status: 200, headers: HTML_HEADERS, body: `<!doctype html><title>framer</title><iframe src="${ADMIN}/admin" title="framed console" width="900" height="600"></iframe>` };
  }
  if (!isApiPath(u.pathname)) {
    st.statics.push(`${u.host}${u.pathname}`);
    const file = files.get(u.pathname) ?? files.get('/index.html'); // the tenant host's SPA fallback, as before
    return { status: 200, headers: [['content-type', TYPES[extname(file)] ?? 'application/octet-stream'], ['cache-control', 'no-store']], body: readFileSync(file) };
  }
  apiRecord(ev, u); // /api/v1 or /admin/v1 off the admin host: refused here and failed by afterScenario
  return null;
}

function sessionApi(rec) {
  switch (`${rec.method} ${rec.path}`) {
    case `GET ${SESSION}`: {
      const status = statusFrom(st.session, rec);
      return status === 200 ? active() : refusal(status);
    }
    case `POST ${LOGIN}`: {
      const status = statusFrom(st.login, rec);
      if (status !== 200) return refusal(status);
      const uid = bearerUid(rec);
      if (rec.headers['x-tmpos-reauthenticate'] !== undefined) {
        // Re-authentication: only the live session's own administrator, presenting that session, is rotated.
        rec.reauth = true;
        if (rec.headers['x-tmpos-reauthenticate'] !== '1' || !hasAdminCookie(rec) || uid === null || uid !== st.sessionUid) return refusal(401);
        st.revoked.push(st.cookieValue);
      }
      st.cookieValue = token43();
      st.csrfToken = st.loginCsrf = token43();
      st.sessionUid = uid;
      st.fresh = true;
      return active([['set-cookie', `${COOKIE}=${st.cookieValue}; Path=/; Secure; HttpOnly; SameSite=Strict`]]);
    }
    case `POST ${LOGOUT}`: {
      const status = statusFrom(st.logout, rec);
      if (status !== 204) return refusal(status);
      return { status: 204, headers: [['cache-control', 'no-store'], ['set-cookie', `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`]] };
    }
    default:
      return refusal(404);
  }
}

async function commandCenterApi(s) {
  const answer = statusFrom(s.cc, s.requests.at(-1)); // decided when asked, even if the reply is held
  const gate = s.ccHold;
  s.ccHold = null;
  if (gate) await Promise.race([gate, sleep(10_000)]);
  if (answer === 'malformed') return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ schemaVersion: 1, generatedAt: 'yesterday', sections: {} }) };
  if (answer === 503) return { status: 503, headers: JSON_HEADERS, body: JSON.stringify({ error: 'service_unavailable', requestId: 'r1' }) };
  if (typeof answer === 'number') return refusal(answer);
  return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(answer) };
}

/**
 * The tenant directory (server/runtime/tenantDirectory.ts) and its two commands over this scenario's
 * synthetic tenants, each refused as the session would be unless that is 200. A read answers a page;
 * a command commits the change, bumps the version and answers 200 with exactly the committed fields.
 * A hold(path) keeps the answer back after the change is made. A malformed command body throws: an
 * interception error.
 */
async function tenantApi(s, rec, u, request) {
  rec.query = u.search;
  rec.body = postBody(request);
  const session = statusFrom(s.session, rec);
  let res;
  if (rec.method === 'GET') {
    const cursor = new URLSearchParams(u.search).get('cursor');
    const start = cursor === null ? 0 : s.tenants.findIndex((t) => encodeTenantCursor(t.tenantId) === cursor) + 1;
    const status = cursor !== null && start === 0 ? 400 : session; // a cursor naming no tenant: 400, as the route answers
    const rows = s.tenants.slice(start, start + DIRECTORY_PAGE);
    const nextCursor = start + DIRECTORY_PAGE < s.tenants.length ? encodeTenantCursor(rows.at(-1).tenantId) : null;
    res = status === 200 ? { status, headers: JSON_HEADERS, body: JSON.stringify({ tenants: rows, nextCursor, actions: s.actions }) } : refusal(status);
  } else if (session !== 200) {
    res = refusal(session);
  } else if (rec.path === LIFECYCLE && s.recentAuth && !s.fresh) {
    res = { status: 403, headers: JSON_HEADERS, body: JSON.stringify({ error: 'step_up_required', requestId: 'r1' }) };
  } else {
    const body = JSON.parse(rec.body);
    const field = rec.path === RENAME ? 'displayName' : 'status';
    const tenant = s.tenants.find((t) => t.tenantId === body.tenantId);
    tenant[field] = body[field];
    tenant.version += 1;
    res = { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ tenantId: tenant.tenantId, [field]: tenant[field], version: tenant.version }) };
  }
  const gate = s.holds.get(rec.path);
  if (gate) await Promise.race([gate, sleep(10_000)]);
  return res;
}

// Shapes confirmed against node_modules/@firebase/auth (v1.12, firebase 12): _performSignInRequest
// throws multi-factor-auth-required when the password response carries mfaPendingCredential;
// MultiFactorResolverImpl merges that response with the finalize {idToken, refreshToken};
// expiresIn falls back to exp - iat of the token; _reloadWithoutSaving requires users[0].
async function identityToolkit(request, u) {
  if (request.method === 'OPTIONS') return { status: 204, headers: CORS };
  const rec = { method: request.method, path: u.pathname, status: null };
  st.idp.push(rec);
  const gate = st.holds.get(u.pathname);
  if (gate) await Promise.race([gate, sleep(10_000)]);
  let body = {};
  try { body = JSON.parse(postBody(request) || '{}'); } catch { /* malformed: treated as empty */ }
  const reply = (status, obj) => { rec.status = status; return { status, headers: [...CORS, ['content-type', 'application/json; charset=UTF-8']], body: JSON.stringify(obj) }; };
  const fail = (message) => reply(400, { error: { code: 400, message, errors: [{ message, domain: 'global', reason: 'invalid' }] } });
  switch (`${request.method} ${u.pathname}`) {
    case 'POST /v1/accounts:signInWithPassword':
      if (st.provider === 'invalid') return fail('INVALID_LOGIN_CREDENTIALS');
      if (st.provider === 'mfa') {
        st.mfaPending = token43();
        return reply(200, { kind: 'identitytoolkit#VerifyPasswordResponse', localId: st.uid, email: EMAIL, displayName: '', registered: true, mfaPendingCredential: st.mfaPending, mfaInfo: [MFA_INFO] });
      }
      st.idToken = idToken({ mfa: false, uid: st.uid });
      return reply(200, { kind: 'identitytoolkit#VerifyPasswordResponse', localId: st.uid, email: EMAIL, displayName: '', registered: true, idToken: st.idToken, refreshToken: token43(), expiresIn: '3600' });
    case 'POST /v2/accounts/mfaSignIn:finalize':
      st.totpCode = body.totpVerificationInfo?.verificationCode ?? null;
      if (body.mfaPendingCredential !== st.mfaPending || body.mfaEnrollmentId !== MFA_INFO.mfaEnrollmentId || !/^\d{6}$/.test(st.totpCode ?? '')) {
        return fail('INVALID_MFA_PENDING_CREDENTIAL');
      }
      st.idToken = st.finalizeIdToken = idToken({ mfa: true, uid: st.uid });
      return reply(200, { idToken: st.idToken, refreshToken: token43() });
    case 'POST /v1/accounts:lookup':
      return reply(200, {
        kind: 'identitytoolkit#GetAccountInfoResponse',
        users: [{
          localId: st.uid, email: EMAIL, emailVerified: true, passwordHash: 'UkVEQUNURUQ=', passwordUpdatedAt: 1767225600000, validSince: '1767225600',
          providerUserInfo: [{ providerId: 'password', federatedId: EMAIL, email: EMAIL, rawId: EMAIL }],
          createdAt: '1767225600000', lastLoginAt: String(Date.now()), lastRefreshAt: new Date().toISOString(),
          ...(st.provider === 'mfa' ? { mfaInfo: [MFA_INFO] } : {}),
        }],
      });
    default:
      st.blocked.push(`${request.method} https://${IDP_HOST}${u.pathname}`);
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Page-side accessibility helpers, serialised into the page. Colours go through a 1x1 canvas so
// oklch()/oklab()/color-mix() computed values (Tailwind v4) resolve to sRGB.
function a11yKit() {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const lum = (c) => {
    const [r, g, b] = c.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // ponytail: ancestor walk only (ignores ancestor opacity and positioned overlap); switch to
  // CSS.getBackgroundColors if a layout ever paints text over a non-ancestor.
  const background = (node) => {
    const layers = [];
    for (let n = node; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== 'none') return null;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    return layers.reverse().reduce((bg, c) => over(c, bg), [255, 255, 255, 1]);
  };
  const COLOR = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/i;
  const layersOf = (value) => {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of value) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    return out.concat(cur);
  };
  return {
    indicator(node) {
      const s = getComputedStyle(node);
      if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && rgba(s.outlineColor)[3] > 0) return true;
      if (s.boxShadow === 'none') return false;
      return layersOf(s.boxShadow).some((layer) => {
        const m = layer.match(COLOR);
        const lengths = (m ? layer.replace(m[0], '') : layer).match(/-?\d*\.?\d+px/g) ?? [];
        return rgba(m ? m[0] : s.color)[3] > 0 && lengths.some((v) => parseFloat(v) !== 0);
      });
    },
    contrast(root = document.body) {
      const fails = [];
      const seen = new Set();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const node = t.parentElement;
        const text = t.textContent.trim();
        if (!text || !node || seen.has(node) || node.closest('script,style,noscript,svg,button:disabled,input:disabled,[aria-disabled="true"]')) continue;
        seen.add(node);
        const r = node.getBoundingClientRect();
        const s = getComputedStyle(node);
        if (r.width <= 1 || r.height <= 1 || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
        const bg = background(node);
        if (!bg) { fails.push({ text: text.slice(0, 40), reason: 'background image or gradient' }); continue; }
        const value = ratio(over(rgba(s.color), bg), bg);
        const size = parseFloat(s.fontSize);
        const min = size >= 24 || (Number(s.fontWeight) >= 700 && size >= 18.66) ? 3 : 4.5;
        if (value < min) fails.push({ text: text.slice(0, 40), ratio: Number(value.toFixed(2)), min, color: s.color });
      }
      return { checked: seen.size, fails };
    },
  };
}
const KIT = `(${a11yKit})()`;
const FOCUS_STOP = `(async () => {
  const node = document.activeElement;
  if (!node || node === document.body || node === document.documentElement) return { left: true };
  await Promise.race([Promise.all(node.getAnimations().map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 300))]);
  const r = node.getBoundingClientRect();
  return {
    nav: (window.__navLinks || []).indexOf(node),
    label: (node.getAttribute('aria-label') || node.textContent || node.tagName).trim().replace(/\\s+/g, ' ').slice(0, 48),
    skip: node.textContent.trim() === 'Skip to main content',
    inView: r.width > 1 && r.height > 1 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
    indicator: ${KIT}.indicator(node),
  };
})()`;
const SURFACES = `(async () => JSON.stringify({
  html: document.documentElement.outerHTML, href: location.href, title: document.title, cookie: document.cookie,
  local: Object.entries(localStorage), session: Object.entries(sessionStorage),
  idb: (await indexedDB.databases()).map((d) => d.name),
}))()`;
const noticeShown = (text) =>
  `[...document.querySelectorAll('[role=alert],[role=status]')].some((n) => [n, ...n.querySelectorAll('p')].some((e) => e.textContent.trim() === ${JSON.stringify(text)}))`;
const CC_LOADED = `[...document.querySelectorAll('#main-content [role=status]')].some((n) => n.textContent.startsWith('Command Center updated at'))`;
const SKELETON_MOTION = `(() => {
  const blocks = [...document.querySelectorAll('#main-content [aria-hidden="true"] [class*="animate-pulse"]')];
  return { blocks: blocks.length, animated: blocks.filter((b) => getComputedStyle(b).animationName !== 'none' || b.getAnimations().length > 0).length };
})()`;

// ---------------------------------------------------------------------------------------------
async function waitVisible(page, target, timeout = 10_000) {
  await page.waitFor(() => page.isVisible(target), timeout, `${target.role} "${target.name}" visible`);
}
const waitNotice = (page, text, timeout = 10_000) => page.waitFor(noticeShown(text), timeout, `notice "${text}"`);
const waitCcLoaded = (page, timeout = 10_000) => page.waitFor(CC_LOADED, timeout, 'the Command Center loaded');
const isDisabled = (page, target) => page.call(target, function () { return this.disabled === true || this.getAttribute('aria-disabled') === 'true'; });
const isH1 = (page, name) => page.call(el('heading', name), function () { return this.tagName === 'H1'; });
const pathname = (page) => page.evaluate('location.pathname');
const mainText = (page) => page.evaluate(`document.getElementById('main-content')?.innerText ?? ''`);
const sectionText = (page, id) => page.evaluate(`document.querySelector('[aria-labelledby=${id}]')?.innerText ?? null`);
const metric = (page, label) => page.evaluate(`[...document.querySelectorAll('#main-content dt')].find((n) => n.textContent.trim() === ${JSON.stringify(label)})?.nextElementSibling?.textContent.trim() ?? null`);
const chips = (page, text) => page.evaluate(`[...document.querySelectorAll('#main-content span')].filter((n) => n.textContent.trim() === ${JSON.stringify(text)}).length`);
const sessionReads = () => st.requests.filter((r) => r.method === 'GET' && r.path === SESSION);
const ccReads = () => st.requests.filter((r) => r.method === 'GET' && r.path === CC);
const logins = () => st.requests.filter((r) => r.method === 'POST' && r.path === LOGIN);
const tenantReads = () => st.requests.filter((r) => r.method === 'GET' && r.path === TENANTS);
const commands = (path) => st.requests.filter((r) => r.method === 'PATCH' && (path === undefined || r.path === path));

// Tenant Management page probes.
const TM = '/admin/tenant-management';
const DIALOG = '[role=dialog]';
const DIALOG_CONFIRM = '[role=dialog] button[aria-busy]'; // the dialog's own confirm: the trigger outside shares its name
const detailsButton = (name) => `button[aria-label=${JSON.stringify(`Open details for ${name}`)}]`;
const detailsStatus = (page) => page.evaluate(`document.querySelector('[aria-labelledby=tenant-details-title] dd')?.textContent.trim() ?? null`);
const rowStatus = (page, name) => page.evaluate(`[...document.querySelectorAll('#main-content tbody tr')].find((tr) => tr.querySelector('th span')?.textContent.trim() === ${JSON.stringify(name)})?.querySelector('td')?.textContent.trim() ?? null`);
const focusedIn = (page, selector) => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})?.contains(document.activeElement)`);
const waitDetailsFocus = (page, name) => page.waitFor(`document.activeElement?.id === 'tenant-details-title' && document.activeElement.textContent.trim() === ${JSON.stringify(name)}`, 5000, `focus moves to the "${name}" details heading`);
// Scrolled into view as focus would scroll it: inside the viewport (scrollbars excluded), and what a
// pointer at its centre hits.
const REACHABLE = `function () {
  this.scrollIntoView({ block: 'center', inline: 'center' });
  const r = this.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= clientWidth && r.bottom <= clientHeight && (hit === this || this.contains(hit));
}`;

/** Press Tab until focus lands on `label`; that focus stop, or null after `max` presses. */
async function tabTo(page, label, max = 60) {
  for (let i = 0; i < max; i += 1) {
    await page.press('Tab');
    const stop = await page.evaluate(FOCUS_STOP);
    if (stop.label === label) return stop;
  }
  return null;
}

/** No horizontal page scroll: nothing is wider than the viewport less its vertical scrollbar. */
async function assertNoOverflow(page, where) {
  const o = await page.evaluate(`({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, win: document.documentElement.clientWidth })`);
  assert.ok(o.doc <= o.win && o.body <= o.win, `no horizontal overflow ${where} (${o.doc}/${o.body} > ${o.win})`);
}

async function openTenants(page) {
  if (st.cookieValue === null) await seedCookie(page);
  await page.goto(`${ADMIN}${TM}`);
  await waitVisible(page, el('heading', 'Tenant Management'));
  await waitNotice(page, `${DIRECTORY_PAGE} tenants loaded.`);
}

async function shoot(page, name, { mobile = false } = {}) {
  await page.screenshot(join(EVIDENCE, `${name}-desktop.png`));
  if (!mobile) return;
  await page.setViewport(...MOBILE);
  await page.screenshot(join(EVIDENCE, `${name}-mobile.png`));
  await page.setViewport(...DESKTOP);
  await page.settle();
}

async function assertContrast(page, where) {
  const { checked, fails } = await page.evaluate(`${KIT}.contrast()`);
  assert.ok(checked >= 5, `contrast audit saw too little text on ${where} (${checked} elements)`);
  assert.deepEqual(fails, [], `WCAG contrast failures on ${where}`);
}

async function openSignIn(page) {
  await page.goto(`${ADMIN}/admin`);
  await waitVisible(page, el('heading', 'Sign in to the Control Plane'));
  assert.equal(await pathname(page), '/admin/sign-in');
}

async function submitPassword(page) {
  await page.fill(el('textbox', 'Email'), EMAIL);
  await page.fill(el('textbox', 'Password'), PASSWORD);
  await page.click(el('button', 'Sign in'));
}

async function signInWithMfa(page) {
  await openSignIn(page);
  await submitPassword(page);
  await waitVisible(page, el('heading', 'Two-step verification'));
  await page.fill(el('textbox', 'Verification code'), TOTP);
  await page.click(el('button', 'Verify'));
  await waitVisible(page, el('heading', 'Command Center'));
}

/** A browser that already holds an admin session cookie: the scripted session answers 200 for it. */
async function seedCookie(page) {
  st.cookieValue = token43();
  st.sessionUid = UID; // the synthetic administrator's session, signed in before this scenario (no recent sign-in)
  await page.send('Network.setCookie', { name: COOKIE, value: st.cookieValue, url: `${ADMIN}/`, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' });
}

async function openShell(page) {
  if (st.cookieValue === null) await seedCookie(page);
  await page.goto(`${ADMIN}/admin`);
  await waitVisible(page, el('heading', 'Command Center'));
}

async function assertNoLeak(page) {
  const seen = JSON.parse(await page.evaluate(SURFACES));
  assert.equal(seen.local.length, 0, 'localStorage is empty');
  assert.equal(seen.session.length, 0, 'sessionStorage is empty');
  assert.ok(!seen.cookie.includes(COOKIE), 'document.cookie does not expose the session cookie');
  // The Firebase client keeps auth in memory only; a page that never loaded it has no IndexedDB at all.
  if (st.statics.some((p) => /firebase/i.test(p))) assert.ok(!seen.idb.includes('firebaseLocalStorageDb'), 'no persisted Firebase auth database');
  else assert.deepEqual(seen.idb, [], 'IndexedDB is empty');
  for (const [label, secret] of [['the session cookie value', st.cookieValue], ['the csrfToken', st.csrfToken], ['the login csrfToken', st.loginCsrf], ['the uid', UID], ['the other uid', OTHER_UID], ['the idToken', st.finalizeIdToken]]) {
    if (secret) assert.ok(!seen.html.includes(secret), `${label} appears in the page markup`);
  }
}

/** The shared hermetic check after every scenario. */
async function afterScenario(page, errorsBefore) {
  const api = st.requests.filter((r) => r.path.toLowerCase().startsWith('/api/v1'));
  assert.equal(api.length, 0, `tenant API requests were made: ${api.map(line).join('; ')}`);
  // A document navigation to an API path is expected only where a scenario makes it: a GET on the
  // admin host, once per path. Anything else in an API namespace must be a known scripted route.
  const navigated = new Set();
  const stray = st.requests.filter((r) => {
    if (api.includes(r)) return false;
    if (r.type === 'Document') {
      const expected = r.host === ADMIN_HOST && r.method === 'GET' && st.allowNav.has(r.path) && !navigated.has(r.path);
      navigated.add(r.path);
      return !expected;
    }
    return r.host !== ADMIN_HOST || !KNOWN_API.has(`${r.method} ${r.path}`);
  });
  assert.equal(stray.length, 0, `unexpected administrative requests: ${stray.map((r) => `${line(r)} [${r.type}]`).join('; ')}`);
  assert.deepEqual(browser.interceptErrors.slice(errorsBefore), [], 'interception handler errors');
  // Nothing else was even attempted: every refused request is one the scenario made on purpose.
  assert.deepEqual(st.blocked.filter((b) => !st.allowBlocked.includes(b)).map(redact), [], 'requests to unserved hosts were attempted');

  // Every Command Center read rides the session cookie: no bearer, no CSRF header, no body.
  for (const r of ccReads()) {
    assert.ok(r.cookieOk, 'a Command Center read carries the admin session cookie');
    assert.equal(r.headers.authorization, undefined, 'a Command Center read carries no Authorization');
    assert.equal(r.headers['x-tmpos-csrf'], undefined, 'a Command Center read carries no CSRF header');
    assert.equal(r.headers['x-tmpos-session-csrf'], undefined, 'a Command Center read carries no session CSRF header');
    assert.equal(r.hasPostData, false, 'a Command Center read has no body');
  }

  // Every tenant directory read rides the session cookie the same way. Every tenant command also carries
  // the intent header, this session's CSRF token and a JSON body under a UUID v4 Idempotency-Key — a new
  // key each time, since every scripted command answers definitively (a retry would reuse its key).
  for (const r of tenantReads()) {
    assert.ok(r.cookieOk, 'a tenant directory read carries the admin session cookie');
    assert.equal(r.headers.authorization, undefined, 'a tenant directory read carries no Authorization');
    assert.equal(r.headers['x-tmpos-csrf'], undefined, 'a tenant directory read carries no CSRF header');
    assert.equal(r.headers['x-tmpos-session-csrf'], undefined, 'a tenant directory read carries no session CSRF header');
    assert.equal(r.hasPostData, false, 'a tenant directory read has no body');
  }
  for (const r of commands()) {
    assert.ok(r.cookieOk, `${r.path} carries the admin session cookie`);
    assert.equal(r.headers.authorization, undefined, `${r.path} carries no Authorization`);
    assert.equal(r.headers['x-tmpos-csrf'], '1', `${r.path} carries the intent header`);
    assert.ok(r.csrfOk, `${r.path} carries the session's csrfToken as X-TMPOS-Session-CSRF`);
    assert.match(r.headers['idempotency-key'] ?? '', UUID_V4, `${r.path} carries a UUID v4 Idempotency-Key`);
    assert.match(r.headers['content-type'] ?? '', /^application\/json\s*(?:;|$)/i, `${r.path} sends JSON`);
  }
  const keys = commands().map((r) => r.headers['idempotency-key']);
  assert.equal(new Set(keys).size, keys.length, 'each command intent carries its own Idempotency-Key');

  // CSP: Chromium's own reports, once late events have settled. Only the exact reports a scenario
  // provokes on purpose are allowed, each once; anything else is a product finding.
  await page.settle();
  const expected = [...st.cspIssues];
  const unexpected = st.csp.map((v) => `${v.violatedDirective}|${v.contentSecurityPolicyViolationType}|${v.blockedURL ?? ''}`).filter((key) => {
    const i = expected.indexOf(key);
    if (i < 0) return true;
    expected.splice(i, 1);
    return false;
  });
  assert.deepEqual(unexpected.map(redact), [], 'Content-Security-Policy violations reported by Chromium');
  const cspLogs = page.logs.filter((l) => /Content.Security.Policy/i.test(l)).map(redact);
  assert.deepEqual(cspLogs.filter((l) => !(st.cspLog && st.cspLog.test(l))), [], 'Content-Security-Policy console reports');

  // No Google Fonts: nothing requested, and no served admin file references them.
  assert.deepEqual(st.blocked.filter((b) => FONT_HOSTS.some((h) => b.includes(h))), [], 'a Google Fonts request was made');
  assert.deepEqual(st.fontFiles, [], 'a served admin file references Google Fonts');

  if (ccReads().length > 0 || tenantReads().length > 0) await assertNoLeak(page);
}

function writeLog(id, page) {
  const out = [
    ...st.requests.map((r) => `api ${line(r)} [${r.type}] -> ${r.status ?? 'refused'} headers=[${Object.keys(r.headers).sort().join(',')}]${r.hasPostData ? ' +body' : ''}`),
    ...st.served.map((r) => `web ${r.method} ${r.path} [${r.type}] -> ${r.status} ${r.headers['content-type'] ?? ''}`),
    ...st.idp.map((r) => `idp ${r.method} ${r.path} -> ${r.status ?? 'refused'}`),
    ...st.blocked.map((b) => `blocked ${b}`),
    ...st.csp.map((v) => `csp ${v.violatedDirective} ${v.contentSecurityPolicyViolationType} ${v.blockedURL ?? ''}`),
    ...page.logs.map((l) => `page ${l}`),
  ];
  writeFileSync(join(LOGS, `${id}.log`), `${redact(out.join('\n'))}\n`);
}

/** One isolated browser context per scenario; hermetic checks run after every scenario. */
function scenario(id, title, opts, fn) {
  test(title, { timeout: 90_000 }, async (t) => {
    if (!CHROMIUM) { t.skip(SKIP); return; }
    st = scenarioState(opts);
    const s = st;
    const errorsBefore = browser.interceptErrors.length;
    const page = await browser.newPage({ width: DESKTOP[0], height: DESKTOP[1], mobile: DESKTOP[2] });
    page.on('Audits.issueAdded', ({ issue }) => {
      if (issue.code === 'ContentSecurityPolicyIssue') s.csp.push(issue.details.contentSecurityPolicyIssueDetails ?? {});
    });
    await page.send('Audits.enable');
    try {
      await fn(page);
      await afterScenario(page, errorsBefore);
    } finally {
      for (const release of s.releases) release();
      writeLog(id, page);
      await page.close();
    }
  });
}

before(async () => {
  if (!CHROMIUM) return;
  mkdirSync(EVIDENCE, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  outDir = mkdtempSync(join(tmpdir(), 'tmpos-admin-build-'));
  const built = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', VITE_ADMIN_CONSOLE_ORIGINS: ADMIN }, // never inherit process.env
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(built.status, 0, redact(`production build failed (${built.error?.message ?? `exit ${built.status}, signal ${built.signal}`}):\n${`${built.stdout ?? ''}${built.stderr ?? ''}`.slice(-3000)}`));
  for (const f of walk(outDir)) files.set(`/${relative(outDir, f).split(sep).join('/')}`, f);
  assert.ok(files.has('/index.html'), 'the build emitted index.html');
  // The production listener, exactly as shipped: the preloaded build, https on, no runtime app composed.
  const build = loadAdminBuild(outDir);
  ENTRY = new Set([...build.document.toString('utf8').matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]));
  assert.ok(ENTRY.size >= 1, 'index.html references its entry script');
  web = createServer(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https: true }));
  await new Promise((resolve, reject) => { web.once('error', reject); web.listen(0, '127.0.0.1', resolve); });
  browser = await launch({ executable: CHROMIUM });
  await browser.intercept(route);
});

after(async () => {
  // A Chromium helper can still be writing its profile just after exit: a cleanup race, not a test result.
  await browser?.close().catch((e) => console.warn(redact(`browser teardown: ${e.message}`)));
  if (web) {
    web.closeAllConnections();
    await new Promise((r) => web.close(r));
  }
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
scenario('plumbing', 'plumbing: the production listener serves the build under the header policy, and nothing escapes', { session: 401, allowBlocked: ['GET https://example.com/'] }, async (page) => {
  await page.goto(`${ADMIN}/admin`);
  await page.waitFor(`!!document.querySelector('#root > *')`, 10_000, 'the app rendered');
  assert.ok(st.statics.includes(`${ADMIN_HOST}/admin`), 'the document came from the production listener');
  assert.ok(st.statics.some((p) => /^admin\.tmpos\.test\/assets\/index-[^/]+\.js$/.test(p)), 'the entry chunk came from the build');
  await page.screenshot(join(EVIDENCE, 'plumbing-desktop.png'));

  // Headers on the wire, from the policy objects: the document ...
  const doc = st.served.find((r) => r.path === '/admin' && r.type === 'Document');
  assert.equal(doc.status, 200);
  assert.match(doc.headers['content-type'], /^text\/html/);
  for (const [name, value] of Object.entries(adminWebHeaders('document', WEB))) assert.ok(doc.headers[name.toLowerCase()] === value, `the document carries the policy's ${name}`);
  assert.ok(doc.headers['content-security-policy'].includes("frame-ancestors 'none'") && !/unsafe-|\*/.test(doc.headers['content-security-policy']), 'the document CSP has frame-ancestors none and no unsafe or wildcard source');
  assert.equal(doc.headers['x-frame-options'], 'DENY');
  assert.equal(doc.headers['x-content-type-options'], 'nosniff');
  assert.equal(doc.headers['referrer-policy'], 'no-referrer');
  assert.ok(doc.headers['permissions-policy'], 'the document carries a Permissions-Policy');
  assert.match(doc.headers['strict-transport-security'] ?? '', /max-age=\d+/, 'the document carries HSTS');
  // ... and a hashed asset.
  const asset = st.served.find((r) => /^\/assets\/index-[^/]+\.js$/.test(r.path));
  for (const [name, value] of Object.entries(adminWebHeaders('asset', WEB))) assert.ok(asset.headers[name.toLowerCase()] === value, `the asset carries the policy's ${name}`);
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(asset.headers['content-type'], /^text\/javascript/);

  // An unserved host is refused by interception (probed from a page with no CSP; the admin CSP would refuse it first).
  await page.goto(`${TENANT}${PROBE}`);
  const outcome = await page.evaluate(`fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'reached', (e) => 'failed: ' + e.name)`);
  assert.equal(outcome, 'failed: TypeError', 'an unserved host is refused');
  assert.ok(st.blocked.includes('GET https://example.com/'), 'the refused request was recorded');
});

scenario('csp-enforced', 'CSP positive control: on /admin an injected inline script, eval and a cross-origin fetch are refused and reported', {
  session: 401,
  cspIssues: ['script-src-elem|kInlineViolation|', 'script-src|kEvalViolation|', 'connect-src|kURLViolation|https://example.com/'],
  cspLog: /^log\.error: (Executing inline script violates|.*'unsafe-eval'|Connecting to 'https:\/\/example\.com\/' violates|Fetch API cannot load https:\/\/example\.com\/)/,
}, async (page) => {
  await openSignIn(page);
  await page.settle();
  assert.equal(st.csp.length, 0, 'no violation before the probes');
  const inline = await page.evaluate(`(() => { window.__inlineRan = false; const s = document.createElement('script'); s.textContent = 'window.__inlineRan = true'; document.head.append(s); return window.__inlineRan; })()`);
  assert.equal(inline, false, 'an inline script appended at runtime did not execute');
  // DevTools evaluation is exempt from the page's eval policy unless told otherwise, so this one probe opts in to the CSP.
  const { result: evaluated } = await page.send('Runtime.evaluate', {
    expression: `(() => { try { return 'ran: ' + eval('1'); } catch (e) { return e.name; } })()`,
    returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
  });
  assert.equal(evaluated.value, 'EvalError', 'eval throws');
  const fetched = await page.evaluate(`fetch('https://example.com/').then(() => 'reached', (e) => 'refused: ' + e.name)`);
  assert.equal(fetched, 'refused: TypeError', 'a cross-origin fetch is refused');
  assert.ok(!st.blocked.some((b) => b.includes('example.com')), 'the fetch never reached the network layer: the CSP refused it in the renderer');
  await page.waitFor(() => st.csp.length >= 3, 5000, 'three violation reports');
  await page.settle(); // a late fourth report must not slip past the exact count below
  const kinds = st.csp.map((v) => `${v.violatedDirective}|${v.contentSecurityPolicyViolationType}`);
  assert.ok(kinds.some((k) => /^script-src(-elem)?\|kInlineViolation$/.test(k)), `the inline script was reported (${kinds.join(', ')})`);
  assert.ok(kinds.some((k) => /^script-src\|kEvalViolation$/.test(k)), `the eval was reported (${kinds.join(', ')})`);
  assert.ok(st.csp.some((v) => v.violatedDirective === 'connect-src' && v.contentSecurityPolicyViolationType === 'kURLViolation' && (v.blockedURL ?? '').startsWith('https://example.com')), 'the fetch was reported as a connect-src violation');
  assert.equal(st.csp.length, 3, `exactly the three probes were reported (${kinds.join(', ')})`);
});

scenario('csp-framing', 'CSP: a tenant-host page framing the console never renders it inside the frame', {
  cspIssues: [`frame-ancestors|kURLViolation|${ADMIN}/`],
  cspLog: /^log\.error: Framing 'https:\/\/admin\.tmpos\.test\/' violates the following Content Security Policy directive: "frame-ancestors 'none'"/,
}, async (page) => {
  await page.goto(`${TENANT}${FRAMER}`);
  await page.waitFor(() => st.served.some((r) => r.path === '/admin' && r.type === 'Document'), 10_000, 'the framed admin document was requested');
  await page.waitFor(() => st.csp.some((v) => v.violatedDirective === 'frame-ancestors') || page.logs.some((l) => /frame-ancestors/.test(l)), 10_000, 'a frame-ancestors violation was reported');
  await page.settle();
  const doc = st.served.find((r) => r.path === '/admin' && r.type === 'Document');
  assert.equal(doc.status, 200, 'the listener answered the framed document');
  assert.ok(doc.headers['content-security-policy'] === adminWebHeaders('document', WEB)['Content-Security-Policy'] && doc.headers['x-frame-options'] === 'DENY', 'with frame-ancestors none and X-Frame-Options DENY');
  const { frameTree } = await page.send('Page.getFrameTree');
  const frame = frameTree.childFrames?.[0]?.frame;
  assert.ok(frame, 'the iframe exists');
  assert.notEqual(frame.url, `${ADMIN}/admin`, 'the frame did not commit the console document');
  let inside = null;
  try {
    const { executionContextId } = await page.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'probe' });
    const r = await page.send('Runtime.evaluate', { contextId: executionContextId, returnByValue: true, expression: `JSON.stringify({ root: !!document.querySelector('#root'), text: (document.body?.innerText ?? '').slice(0, 300) })` });
    inside = JSON.parse(r.result.value);
  } catch (e) {
    page.logs.push(`frame probe: ${e.message}`); // an error page in another process: its URL and the absent reads below are the proof
  }
  if (inside) {
    assert.equal(inside.root, false, 'no console root inside the frame');
    assert.ok(!/Control Plane|Command Center|Sign in/.test(inside.text), 'no console text inside the frame');
  }
  assert.equal(st.requests.filter((r) => r.path.startsWith('/admin/v1')).length, 0, 'the framed console never ran: no session read');
  assert.ok(!st.statics.some((p) => p.startsWith(`${ADMIN_HOST}/assets/`)), 'no console script or style was loaded for the frame');
  await page.screenshot(join(EVIDENCE, 'csp-framing-desktop.png'));
});

scenario('routing-api-paths', 'routing: a navigation to an API path gets the JSON API answer, never the console; console paths still work', {}, async (page) => {
  for (const path of ['/admin/v1/session', '/admin/v1/unknown', '/ADMIN/V1/x', '/admin%2Fv1/x']) {
    st.allowNav.add(path);
    const mark = st.served.length;
    await page.goto(`${ADMIN}${path}`);
    const got = st.served.slice(mark);
    const hit = got.find((r) => r.path === path && r.type === 'Document');
    assert.ok(hit, `${path}: the navigation was answered`);
    assert.match(hit.headers['content-type'] ?? '', /^application\/json/, `${path}: a JSON answer, never text/html`);
    assert.ok(hit.status === 401 || hit.status === 404, `${path}: a refusal (${hit.status})`);
    assert.ok(hit.headers['content-security-policy'] === API_POLICY.headers['Content-Security-Policy'], `${path}: the API CSP`);
    const seen = await page.evaluate(`({ href: location.href, root: !!document.querySelector('#root'), console: /Control Plane|Command Center|Sign in to/.test(document.body?.innerText ?? '') })`);
    assert.equal(seen.href, `${ADMIN}${path}`, `${path}: the URL is unchanged (no redirect)`);
    assert.equal(seen.root, false, `${path}: no #root`);
    assert.equal(seen.console, false, `${path}: no console text`);
    assert.deepEqual(got.filter((r) => r !== hit).map((r) => r.path), [], `${path}: nothing else was loaded (no console or Firebase chunk)`);
  }
  // The listener's API refusal carries exactly the runtime API header policy.
  const unknown = st.served.find((r) => r.path === '/admin/v1/unknown');
  assert.equal(unknown.status, 404);
  for (const [name, value] of Object.entries(API_POLICY.headers)) assert.ok(unknown.headers[name.toLowerCase()] === value, `the API refusal carries the policy's ${name}`);
  await page.screenshot(join(EVIDENCE, 'routing-api-path-desktop.png'));

  // A missing hashed asset is a bounded 404, never the SPA.
  let mark = st.served.length;
  await page.goto(`${ADMIN}/assets/does-not-exist.js`);
  const miss = st.served.slice(mark).find((r) => r.path === '/assets/does-not-exist.js');
  assert.equal(miss.status, 404);
  assert.match(miss.headers['content-type'] ?? '', /^application\/json/, 'the missing asset is not the document');
  assert.equal(await page.evaluate(`!!document.querySelector('#root')`), false);

  // The console's own paths still work.
  await page.goto(`${ADMIN}/admin/sign-in`);
  await waitVisible(page, el('heading', 'Sign in to the Control Plane'));
  await seedCookie(page);
  mark = st.served.length;
  await page.goto(`${ADMIN}/admin/tenant-management`);
  await waitVisible(page, el('heading', 'Tenant Management'));
  assert.equal(await pathname(page), '/admin/tenant-management');
  assert.match(st.served.slice(mark).find((r) => r.path === '/admin/tenant-management').headers['content-type'], /^text\/html/);
  await openShell(page);
  assert.equal(await pathname(page), '/admin');
});

scenario('routing-misrouted', 'routing: a misrouted host that serves the SPA document for an API path gets "Not found" and no application', { session: 401 }, async (page) => {
  const path = '/admin/v1/misrouted';
  st.misroute = path;
  st.allowNav.add(path);
  await page.goto(`${ADMIN}${path}`);
  await waitVisible(page, el('heading', 'Not found'));
  assert.equal(await isH1(page, 'Not found'), true);
  await page.settle();
  assert.equal(await page.evaluate('location.href'), `${ADMIN}${path}`, 'the URL is kept');
  assert.equal(await page.evaluate('document.title'), 'Not found');
  assert.deepEqual(st.requests.filter((r) => r.type !== 'Document').map(line), [], 'the page sent no /admin/v1 or /api/v1 request');
  const scripts = st.statics.filter((p) => p.endsWith('.js')).map((p) => p.slice(ADMIN_HOST.length));
  assert.ok(scripts.length >= 1, 'the entry chunk ran');
  assert.deepEqual(scripts.filter((p) => !ENTRY.has(p)), [], 'no lazy chunk (console, tenant application or Firebase) was loaded');
  assert.equal(st.idp.length, 0, 'no identity provider contact');
  await shoot(page, 'routing-misrouted');
});

scenario('a-signed-out', 'a. signed out: GET session 401 shows the sign-in screen', {}, async (page) => {
  await openSignIn(page);
  for (const target of [el('textbox', 'Email'), el('textbox', 'Password'), el('button', 'Sign in'), el('button', 'Continue with Google')]) {
    assert.equal(await page.isVisible(target), true, `${target.role} "${target.name}" is visible`);
  }
  assert.equal(await isH1(page, 'Sign in to the Control Plane'), true);
  assert.equal(await isDisabled(page, el('button', 'Sign in')), false, '"Sign in" is enabled');
  assert.equal(await page.evaluate(`document.body.innerText.includes('Signing in at ${ADMIN_HOST}')`), true, 'the sign-in page names its host');
  assert.equal(await page.evaluate(`document.querySelectorAll('[role=alert]').length`), 0, 'no notice on a plain signed-out load');
  await shoot(page, 'a-signed-out', { mobile: true });
  assert.ok(sessionReads().length >= 1, 'the session was read');
  for (const r of sessionReads()) {
    assert.equal(r.status, 401);
    assert.equal(r.headers.authorization, undefined, 'a session read carries no Authorization');
  }
  assert.equal(st.requests.filter((r) => r.method !== 'GET').length, 0, 'no unsafe request on load');
  assert.equal(ccReads().length, 0, 'no Command Center read while signed out');
  assert.equal(st.idp.length, 0, 'opening the console contacts no identity provider');
  assert.ok(!st.statics.some((p) => /firebase/i.test(p)), 'the Firebase client is not loaded before a sign-in is submitted');
});

scenario('b-sign-in-mfa', 'b. sign-in with TOTP MFA end to end, one bodiless login exchange, nothing persisted or rendered', {}, async (page) => {
  await openSignIn(page);
  const releasePassword = hold('/v1/accounts:signInWithPassword');
  await submitPassword(page);
  await page.waitFor(noticeShown('Signing in…'), 10_000, 'status "Signing in…"');
  assert.equal(await isDisabled(page, el('button', 'Sign in')), true, '"Sign in" keeps its name and is disabled while signing in');
  releasePassword();

  await waitVisible(page, el('heading', 'Two-step verification'));
  assert.equal(await isH1(page, 'Two-step verification'), true);
  assert.equal(await page.find(el('radiogroup', 'Verification method')), null, 'no method choice with a single factor');
  await shoot(page, 'b-mfa', { mobile: true });

  const releaseFinalize = hold('/v2/accounts/mfaSignIn:finalize');
  await page.fill(el('textbox', 'Verification code'), TOTP);
  await page.click(el('button', 'Verify'));
  await page.waitFor(noticeShown('Verifying…'), 10_000, 'status "Verifying…"');
  releaseFinalize();

  await waitVisible(page, el('heading', 'Command Center'));
  assert.equal(await pathname(page), '/admin');
  assert.equal(st.totpCode, TOTP, 'the typed code reached the provider');
  assert.deepEqual(st.idp.map((r) => r.path), ['/v1/accounts:signInWithPassword', '/v2/accounts/mfaSignIn:finalize', '/v1/accounts:lookup']);

  const exchanges = logins();
  assert.equal(exchanges.length, 1, 'exactly one POST /admin/v1/session/login');
  const [login] = exchanges;
  assert.ok(login.headers.authorization === `Bearer ${st.finalizeIdToken}`, 'login Authorization is Bearer <the finalize idToken>');
  assert.equal(login.headers['x-tmpos-csrf'], '1');
  assert.equal(login.headers.origin, ADMIN);
  assert.equal(login.hasPostData, false, 'the login POST is bodiless');
  assert.equal(login.headers.cookie, undefined, 'no cookie before the login');
  assert.equal(login.status, 200);
  // The shell loads only once a session read (riding the new cookie, never the bearer) confirms the login.
  const confirm = st.requests.slice(st.requests.indexOf(login) + 1).find((r) => r.path === SESSION);
  assert.ok(confirm && confirm.method === 'GET' && confirm.status === 200 && hasAdminCookie(confirm), 'a session read confirmed the login before the shell loaded');
  // Then the Command Center (the console home) is read once, after that confirmation.
  await page.waitFor(() => ccReads().some((r) => r.status !== null), 5000, 'the Command Center read after activation');
  const [home] = ccReads();
  assert.ok(st.requests.indexOf(home) > st.requests.indexOf(confirm) && home.status === 200, 'the Command Center was read after the confirming session read');
  await waitCcLoaded(page);
  await shoot(page, 'b-command-center', { mobile: true });

  // A later session read (every in-console navigation re-checks) rides the cookie, never a bearer.
  const mark = st.requests.length;
  await page.click(el('link', 'Audit & Security'));
  await waitVisible(page, el('heading', 'Audit & Security'));
  await page.waitFor(() => st.requests.slice(mark).some((r) => r.method === 'GET' && r.path === SESSION), 5000, 'a session re-read after navigation');
  const later = st.requests.slice(st.requests.indexOf(login) + 1);
  for (const r of later) assert.equal(r.headers.authorization, undefined, `Authorization on a later ${r.method} ${r.path}`);
  assert.ok(later.filter((r) => r.method === 'GET').every(hasAdminCookie), 'later session and Command Center reads carry the admin session cookie');
  assert.equal(ccReads().length, 1, 'exactly one Command Center read');

  const seen = JSON.parse(await page.evaluate(SURFACES));
  assert.equal(seen.local.length, 0, 'localStorage is empty');
  assert.equal(seen.session.length, 0, 'sessionStorage is empty');
  assert.ok(!seen.idb.includes('firebaseLocalStorageDb'), 'no persisted Firebase auth database');
  assert.ok(!seen.cookie.includes(COOKIE), 'document.cookie does not expose the session cookie');
  const surfaces = JSON.stringify(seen);
  const logs = page.logs.join('\n');
  for (const [label, secret] of [['the idToken', st.finalizeIdToken], ['the csrfToken', st.loginCsrf], ['the uid', UID], ['the session cookie value', st.cookieValue]]) {
    assert.ok(!surfaces.includes(secret), `${label} appears in the DOM, URL, title, storage or document.cookie`);
    assert.ok(!logs.includes(secret), `${label} appears in console, log or exception output`);
  }
});

scenario('c-logout', 'c. logout sends session CSRF + cookie, no bearer, and shows the signed-out notice', {}, async (page) => {
  await signInWithMfa(page);
  assert.equal(await page.isVisible(el('button', 'Sign out')), false, 'the account panel is closed');
  await page.click(el('button', 'Account menu'));
  await waitVisible(page, el('button', 'Sign out'));
  assert.equal(await page.call(el('button', 'Account menu'), function () { return this.getAttribute('aria-expanded'); }), 'true');
  assert.equal(await page.evaluate(`document.body.innerText.includes('Administrator session')`), true);
  await shoot(page, 'c-account-menu');

  await page.click(el('button', 'Sign out'));
  await waitNotice(page, NOTICE.loggedOut);
  assert.equal(await pathname(page), '/admin/sign-in');
  await shoot(page, 'c-signed-out');

  const outs = st.requests.filter((r) => r.method === 'POST' && r.path === LOGOUT);
  assert.equal(outs.length, 1, 'exactly one POST /admin/v1/session/logout');
  const [out] = outs;
  assert.equal(out.headers['x-tmpos-csrf'], '1');
  assert.ok(out.headers['x-tmpos-session-csrf'] === st.loginCsrf, 'x-tmpos-session-csrf is the csrfToken the login returned');
  assert.ok((out.headers.cookie ?? '').split(/;\s*/).includes(`${COOKIE}=${st.cookieValue}`), 'the session cookie rode the logout');
  assert.equal(out.headers.authorization, undefined, 'no Authorization on logout');
  assert.equal(out.hasPostData, false, 'the logout POST is bodiless');
  assert.equal(out.status, 204);
  const { cookies } = await browser.send('Storage.getCookies', { browserContextId: page.contextId });
  assert.ok(!cookies.some((c) => c.name === COOKIE), 'the clearing Set-Cookie removed the session cookie');
});

scenario('d-denied-provider', 'd. denied by the provider (INVALID_LOGIN_CREDENTIALS): generic notice, no exchange', { provider: 'invalid' }, async (page) => {
  await openSignIn(page);
  await submitPassword(page);
  await waitNotice(page, NOTICE.denied);
  const html = await page.evaluate('document.documentElement.outerHTML');
  for (const s of ['INVALID_LOGIN_CREDENTIALS', 'invalid-credential', 'auth/', 'Firebase']) assert.ok(!html.includes(s), `provider error text rendered: ${s}`);
  assert.equal(logins().length, 0, 'no login exchange after a provider refusal');
  await shoot(page, 'd-denied');
  await assertContrast(page, 'the denied sign-in page');
});

for (const status of [401, 403]) {
  scenario(`d-denied-login-${status}`, `d. denied by the server (login ${status}): the same generic notice`, { provider: 'password', login: status }, async (page) => {
    await openSignIn(page);
    await submitPassword(page);
    await waitNotice(page, NOTICE.denied);
    assert.equal(logins().length, 1, 'exactly one login exchange');
    assert.equal(logins()[0].status, status);
    assert.ok(logins()[0].headers.authorization === `Bearer ${st.idToken}`, 'the exchange carried the provider token');
  });
}

scenario('e-rate-limited', 'e. rate limited: login 429 shows the rate-limit notice', { provider: 'password', login: 429 }, async (page) => {
  await openSignIn(page);
  await submitPassword(page);
  await waitNotice(page, NOTICE.rateLimited);
  assert.equal(logins().length, 1, 'exactly one login exchange');
  await shoot(page, 'e-rate-limited');
});

scenario('f-unavailable', 'f. unavailable: GET 503 disables sign-in; "Try again" re-reads and re-enables it', { session: () => st.sessionStatus ?? 503 }, async (page) => {
  await page.goto(`${ADMIN}/admin`);
  await waitNotice(page, NOTICE.unavailable);
  assert.equal(await pathname(page), '/admin/sign-in');
  assert.equal(await isDisabled(page, el('button', 'Sign in')), true, '"Sign in" is disabled while the service is unavailable');
  await waitVisible(page, el('button', 'Try again'));
  await assertContrast(page, 'the unavailable sign-in page');
  await shoot(page, 'f-unavailable', { mobile: true });

  st.sessionStatus = 401;
  const mark = sessionReads().length;
  await page.click(el('button', 'Try again'));
  await page.waitFor(async () => !(await isDisabled(page, el('button', 'Sign in'))), 10_000, '"Sign in" enabled after the retry');
  assert.equal(await page.evaluate(noticeShown(NOTICE.unavailable)), false, 'the unavailable notice is gone');
  assert.ok(sessionReads().length > mark && sessionReads().at(-1).status === 401, '"Try again" re-read the session');
});

scenario('g-expired', 'g. expired: an in-console navigation re-check answering 401 returns to sign-in with the expiry notice', { session: () => (st.expired ? 401 : 200) }, async (page) => {
  await openShell(page);
  await page.waitFor(() => ccReads().some((r) => r.status !== null), 5000, 'the Command Center read was answered');
  st.expired = true;
  await page.click(el('link', 'Audit & Security'));
  await waitNotice(page, NOTICE.expired);
  assert.equal(await pathname(page), '/admin/sign-in');
  assert.deepEqual(sessionReads().map((r) => r.status), [200, 401]);
  await shoot(page, 'g-expired');
  await assertContrast(page, 'the expired sign-in page');
});

scenario('h-tenant-cookie', 'h. a tenant session cookie never authenticates the console', {}, async (page) => {
  const tenantValue = token43();
  for (const url of [`${ADMIN}/`, `${TENANT}/`]) {
    await page.send('Network.setCookie', { name: TENANT_COOKIE, value: tenantValue, url, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' });
  }
  await openSignIn(page);
  assert.equal(await page.isVisible(el('button', 'Sign in')), true);
  assert.ok(sessionReads().length >= 1, 'the session was read');
  for (const r of sessionReads()) {
    const jar = (r.headers.cookie ?? '').split(/;\s*/);
    assert.ok(jar.includes(`${TENANT_COOKIE}=${tenantValue}`), 'the tenant cookie was present on the session read');
    assert.ok(!jar.some((c) => c.startsWith(`${COOKIE}=`)), 'no admin cookie');
    assert.equal(r.status, 401);
  }
  assert.equal(st.requests.filter((r) => r.path.startsWith('/api/v1')).length, 0, 'zero /api/v1 requests');
});

scenario('i-host-refusal', 'i. host refusal: /admin on the tenant host refuses and makes no administrative request', {}, async (page) => {
  await page.goto(`${TENANT}/admin`);
  await waitVisible(page, el('heading', 'Not available on this address'));
  assert.equal(await isH1(page, 'Not available on this address'), true);
  await shoot(page, 'i-host-refusal', { mobile: true });
  assert.equal(st.requests.filter((r) => r.path.startsWith('/admin/v1')).length, 0, 'zero /admin/v1 requests');
  assert.equal(st.idp.length, 0, 'no identity provider contact');
});

scenario('j-keyboard-a11y', 'j. keyboard and accessibility on the desktop shell', { session: 200 }, async (page) => {
  await openShell(page);
  await page.press('Tab');
  const first = await page.evaluate(FOCUS_STOP);
  assert.equal(first.skip, true, `first Tab focuses "Skip to main content" (got ${first.label ?? 'nothing'})`);
  assert.equal(first.inView, true, 'the focused skip link is visible in the viewport');
  assert.equal(first.indicator, true, 'the skip link shows a focus indicator');
  await page.press('Enter');
  await page.waitFor(`document.getElementById('main-content')?.contains(document.activeElement)`, 5000, 'Enter moves focus into #main-content');

  // Full forward traversal from the top of a fresh load, once the Command Center has loaded.
  await openShell(page);
  await waitCcLoaded(page);
  const navCount = await page.call(el('navigation', 'Control plane'), function () {
    window.__navLinks = [...this.querySelectorAll('a[href]')];
    return window.__navLinks.length;
  });
  assert.equal(navCount, 1 + CONSOLE_MODULES.length, `Command Center + ${CONSOLE_MODULES.length} modules in the "Control plane" nav`);
  const stops = [];
  for (let i = 0; i < 80; i += 1) {
    await page.press('Tab');
    const stop = await page.evaluate(FOCUS_STOP);
    if (stop.left || (i > 0 && stop.skip)) break;
    stops.push(stop);
  }
  const reached = new Set(stops.filter((s) => s.nav >= 0).map((s) => s.nav));
  assert.equal(reached.size, navCount, `Tab reaches every "Control plane" link (${reached.size}/${navCount})`);
  assert.deepEqual(stops.filter((s) => !s.indicator).map((s) => s.label), [], 'every focused control shows a visible focus indicator');

  const count = async (role, name) => (await page.axNodes({ role, name })).length;
  assert.equal(await count('banner'), 1, 'exactly one banner');
  assert.equal(await count('main'), 1, 'exactly one main');
  assert.equal(await count('navigation', 'Control plane'), 1, 'the "Control plane" nav');
  assert.equal(await count('navigation', 'Breadcrumb'), 1, 'the "Breadcrumb" nav');
  await assertContrast(page, 'the desktop shell');
});

scenario('k-responsive', 'k. responsive navigation: sidebar at 1440, drawer at 390 with Escape and focus return', { session: 200 }, async (page) => {
  await openShell(page);
  assert.equal(await page.isVisible(el('navigation', 'Control plane')), true, 'sidebar nav visible at 1440');
  assert.equal(await page.isVisible(el('button', 'Open navigation')), false, '"Open navigation" hidden at 1440');
  await page.setViewport(...MOBILE);
  await page.settle();
  assert.equal(await page.isVisible(el('navigation', 'Control plane')), false, 'sidebar nav hidden at 390');
  assert.equal(await page.isVisible(el('button', 'Open navigation')), true, '"Open navigation" visible at 390');

  await page.click(el('button', 'Open navigation'));
  await waitVisible(page, el('dialog', 'Navigation'));
  await page.waitFor(() => page.call(el('dialog', 'Navigation'), function () { return this.contains(document.activeElement); }), 5000, 'focus inside the drawer');
  await page.screenshot(join(EVIDENCE, 'k-drawer-mobile.png'));

  await page.press('Escape');
  await page.waitFor(async () => (await page.find(el('dialog', 'Navigation'))) === null, 5000, 'Escape closes the drawer');
  await page.waitFor(() => page.call(el('button', 'Open navigation'), function () { return this === document.activeElement; }), 5000, 'focus returns to "Open navigation"');
  assert.equal(await page.call(el('button', 'Open navigation'), function () { return this.getAttribute('aria-expanded'); }), 'false');
});

// ---------------------------------------------------------------------------------------------
// Command Center: every state through the real page, read over the session cookie.
scenario('cc-full', 'Command Center: the full view, contrast, and no horizontal overflow at 1440, 768 and 390', {}, async (page) => {
  await openShell(page);
  await waitCcLoaded(page);
  assert.equal(await isH1(page, 'Command Center'), true);
  const text = await mainText(page);
  for (const s of ['Platform summary', 'Needs attention', 'Governance signals', 'Service health', '4 of 4 sources available',
    '1 critical in Audit & Security', '3 warnings in Provisioning', '2 info in Billing & Subscriptions', 'Authentication', 'Background jobs']) {
    assert.ok(text.includes(s), `shows "${s}"`);
  }
  for (const [label, value] of [['Tenants', '12'], ['Stores', '48'], ['Pending approvals', '3'], ['Critical alerts', '1'], ['Production changes', 'Locked'], ['Approval policy', 'Enforced'], ['Audit trail', 'Not recording']]) {
    assert.equal(await metric(page, label), value, `${label} reads ${value}`);
  }
  for (const chip of ['Unavailable', 'Not configured', 'Out of date']) assert.equal(await chips(page, chip), 0, `no "${chip}" chip on a full view`);
  assert.equal(await page.call(el('link', 'Open Provisioning'), function () { return this.getAttribute('href'); }), '/admin/provisioning');
  assert.equal(await page.call(el('link', 'Open Audit & Security'), function () { return this.getAttribute('href'); }), '/admin/audit-security');
  await assertContrast(page, 'the Command Center');
  for (const viewport of [DESKTOP, TABLET, MOBILE]) {
    await page.setViewport(...viewport);
    await page.settle();
    const o = await page.evaluate(`({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, win: innerWidth })`);
    assert.ok(o.doc <= o.win && o.body <= o.win, `no horizontal overflow at ${viewport[0]}px (${o.doc}/${o.body} > ${o.win})`);
  }
  await page.setViewport(...DESKTOP);
  await page.settle();
  await shoot(page, 'cc-full', { mobile: true });
  assert.equal(ccReads().length, 1, 'exactly one read on load');
});

scenario('cc-partial', 'Command Center: partial view — unavailable and not-configured sections show their state and no figure', { cc: () => ccView({ absent: { attention: 'unavailable', governance: 'not_configured' } }) }, async (page) => {
  await openShell(page);
  await waitCcLoaded(page);
  const text = await mainText(page);
  for (const s of [CC_TEXT.partial, 'The source did not answer.', 'No source is connected.', '2 of 4 sources available']) assert.ok(text.includes(s), `shows "${s}"`);
  assert.equal(await chips(page, 'Unavailable'), 1, 'one "Unavailable" chip');
  assert.equal(await chips(page, 'Not configured'), 1, 'one "Not configured" chip');
  for (const id of ['cc-attention', 'cc-governance']) assert.doesNotMatch(await sectionText(page, id), /\d/, `${id} shows no number`);
  assert.equal(await metric(page, 'Tenants'), '12', 'an available section still shows its figures');
  await assertContrast(page, 'the partial Command Center');
  await shoot(page, 'cc-partial', { mobile: true });
});

scenario('cc-stale', 'Command Center: stale sections say "Out of date" and still show their values', { cc: () => ccView({ stale: ['posture', 'services'] }) }, async (page) => {
  await openShell(page);
  await waitCcLoaded(page);
  assert.equal(await chips(page, 'Out of date'), 2, 'two "Out of date" chips');
  assert.match(await sectionText(page, 'cc-summary'), /Out of date/);
  assert.match(await sectionText(page, 'cc-services'), /Out of date/);
  assert.doesNotMatch(await sectionText(page, 'cc-attention'), /Out of date/);
  assert.equal(await metric(page, 'Tenants'), '12', 'a stale section still shows its values');
  assert.match(await sectionText(page, 'cc-services'), /Background jobs/);
  await shoot(page, 'cc-stale');
});

scenario('cc-empty-attention', 'Command Center: an empty attention list says nothing needs attention', { cc: () => ccView({ items: [] }) }, async (page) => {
  await openShell(page);
  await waitCcLoaded(page);
  const attention = await sectionText(page, 'cc-attention');
  assert.match(attention, /Nothing needs attention right now\./);
  assert.doesNotMatch(attention, /Open /, 'no workspace link without an item');
});

scenario('cc-unavailable', 'Command Center: 503 shows the unavailable panel; "Try again" recovers and focus lands on the heading', { cc: () => st.ccNext ?? 503 }, async (page) => {
  await openShell(page);
  await waitVisible(page, el('heading', 'Command Center unavailable'));
  assert.ok((await mainText(page)).includes(CC_TEXT.unavailable));
  assert.equal(await page.call(el('button', 'Try again'), function () { return this.disabled; }), false, '"Try again" is never natively disabled');
  await assertContrast(page, 'the unavailable Command Center');
  await shoot(page, 'cc-unavailable', { mobile: true });
  st.ccNext = ccView();
  const mark = ccReads().length;
  await page.click(el('button', 'Try again'));
  await waitCcLoaded(page);
  assert.equal(ccReads().length, mark + 1, '"Try again" sent one read');
  await page.waitFor(`document.activeElement?.id === 'page-title'`, 5000, 'focus lands on the page heading');
  assert.equal(await page.find(el('button', 'Try again')), null, 'the panel is gone');
});

scenario('cc-forbidden', 'Command Center: 403 shows one generic panel and no figures', { cc: 403 }, async (page) => {
  await openShell(page);
  await waitVisible(page, el('heading', 'Not available'));
  const text = await mainText(page);
  assert.ok(text.includes(CC_TEXT.forbidden));
  assert.doesNotMatch(text, /403|forbidden|permission|Platform summary/i, 'no reason, status or figures');
  assert.equal(await page.find(el('button', 'Try again')), null, 'no retry offered for a refusal');
});

scenario('cc-rate-limited', 'Command Center: 429 shows the rate-limit notice', { cc: 429 }, async (page) => {
  await openShell(page);
  await waitVisible(page, el('heading', 'Please wait'));
  assert.ok((await mainText(page)).includes(CC_TEXT.rateLimited));
});

scenario('cc-malformed', 'Command Center: a malformed 200 is treated as unavailable, never half-rendered', { cc: 'malformed' }, async (page) => {
  await openShell(page);
  await waitVisible(page, el('heading', 'Command Center unavailable'));
  assert.doesNotMatch(await mainText(page), /Platform summary|yesterday/, 'nothing from the payload rendered');
});

scenario('cc-expired', 'Command Center: a 401 on its read returns to sign-in with the expiry notice', { session: () => (st.expired ? 401 : 200), cc: () => { st.expired = true; return 401; } }, async (page) => {
  await seedCookie(page);
  await page.goto(`${ADMIN}/admin`);
  await waitNotice(page, NOTICE.expired);
  assert.equal(await pathname(page), '/admin/sign-in');
  assert.deepEqual(ccReads().map((r) => r.status), [401]);
  await shoot(page, 'cc-expired');
});

scenario('cc-refresh-race', 'Command Center: Refresh is single-flight, and an abandoned answer released after a remount never replaces newer data', { cc: () => ccView({ tenants: [111, 222, 333][st.ccCount++] ?? 999 }) }, async (page) => {
  const releaseFirst = holdCc();
  await openShell(page);
  await page.waitFor(() => ccReads().length === 1, 5000, 'the first read is in flight');
  const busy = await page.call(el('button', 'Refresh'), function () { return { busy: this.getAttribute('aria-busy'), disabled: this.getAttribute('aria-disabled'), native: this.disabled }; });
  assert.deepEqual(busy, { busy: 'true', disabled: 'true', native: false }, 'Refresh is aria-busy/aria-disabled, never natively disabled');
  await page.click(el('button', 'Refresh'));
  await page.settle();
  assert.equal(ccReads().length, 1, 'a Refresh click while a load runs sends nothing');

  // Leave and come back while the first answer is still held: the first load is abandoned.
  await page.click(el('link', 'Audit & Security'));
  await waitVisible(page, el('heading', 'Audit & Security'));
  await page.click(el('link', 'Command Center'));
  await waitVisible(page, el('heading', 'Command Center'));
  await waitCcLoaded(page);
  assert.equal(ccReads().length, 2);
  assert.equal(await metric(page, 'Tenants'), '222', 'the second answer is shown');
  releaseFirst();
  await page.waitFor(() => ccReads()[0].status !== null, 5000, 'the held first answer was released');
  await page.settle();
  assert.equal(await metric(page, 'Tenants'), '222', 'the released first answer never replaced the second');

  await page.click(el('button', 'Refresh'));
  await page.waitFor(async () => (await metric(page, 'Tenants')) === '333', 5000, 'an idle Refresh loads new data');
  assert.equal(ccReads().length, 3);
});

scenario('cc-keyboard', 'Command Center: Tab to Refresh, Enter refreshes, focus stays on it with a visible ring', {}, async (page) => {
  await openShell(page);
  await waitCcLoaded(page);
  let stop = null;
  for (let i = 0; i < 40; i += 1) {
    await page.press('Tab');
    stop = await page.evaluate(FOCUS_STOP);
    if (stop.left || stop.label === 'Refresh') break;
  }
  assert.equal(stop?.label, 'Refresh', 'Tab reaches Refresh');
  assert.equal(stop.indicator, true, 'Refresh shows a visible focus ring');
  const mark = ccReads().length;
  await page.press('Enter');
  await page.waitFor(() => ccReads().length === mark + 1 && ccReads().at(-1).status !== null, 5000, 'Enter on Refresh sent one read');
  await page.waitFor(() => page.call(el('button', 'Refresh'), function () { return this.getAttribute('aria-busy') === 'false'; }), 5000, 'the refresh finished');
  const after = await page.evaluate(FOCUS_STOP);
  assert.equal(after.label, 'Refresh', 'focus stays on Refresh');
  assert.equal(after.indicator, true, 'the focus ring is still visible');
});

scenario('cc-reduced-motion', 'Command Center: prefers-reduced-motion stops the loading skeleton animation', {}, async (page) => {
  await seedCookie(page);
  let release = holdCc();
  await page.goto(`${ADMIN}/admin`);
  await page.waitFor(`${SKELETON_MOTION}.blocks > 0`, 10_000, 'the loading skeleton');
  const normal = await page.evaluate(SKELETON_MOTION);
  assert.equal(normal.animated, normal.blocks, 'control: without the preference every skeleton block pulses');
  release();
  await waitCcLoaded(page);

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  release = holdCc();
  await page.goto(`${ADMIN}/admin`);
  await page.waitFor(`${SKELETON_MOTION}.blocks > 0`, 10_000, 'the loading skeleton');
  const reduced = await page.evaluate(SKELETON_MOTION);
  assert.equal(reduced.animated, 0, `no skeleton animation with prefers-reduced-motion: reduce (${reduced.animated}/${reduced.blocks})`);
  release();
  await waitCcLoaded(page);
});

scenario('cc-navigation', 'Command Center: the sidebar marks it current; the mobile drawer opens, marks it and returns focus on Escape', {}, async (page) => {
  await openShell(page);
  await waitCcLoaded(page);
  const current = await page.call(el('navigation', 'Control plane'), function () { return [...this.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent.trim()); });
  assert.deepEqual(current, ['Command Center'], 'the sidebar marks Command Center as the current page');
  await page.screenshot(join(EVIDENCE, 'cc-nav-desktop.png'));

  await page.setViewport(...MOBILE);
  await page.settle();
  await page.click(el('button', 'Open navigation'));
  await waitVisible(page, el('dialog', 'Navigation'));
  await page.waitFor(() => page.call(el('dialog', 'Navigation'), function () { return this.contains(document.activeElement); }), 5000, 'focus inside the drawer');
  const inDrawer = await page.call(el('dialog', 'Navigation'), function () { return [...this.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent.trim()); });
  assert.deepEqual(inDrawer, ['Command Center'], 'the drawer marks Command Center as the current page');
  await page.screenshot(join(EVIDENCE, 'cc-nav-drawer-mobile.png'));
  await page.press('Escape');
  await page.waitFor(async () => (await page.find(el('dialog', 'Navigation'))) === null, 5000, 'Escape closes the drawer');
  await page.waitFor(() => page.call(el('button', 'Open navigation'), function () { return this === document.activeElement; }), 5000, 'focus returns to "Open navigation"');
  await page.screenshot(join(EVIDENCE, 'cc-nav-closed-mobile.png'));
});

// ---------------------------------------------------------------------------------------------
// Tenant Management: the directory and its two commands through the real page, over synthetic tenants.
scenario('tm-keyboard', 'Tenant Management: keyboard only — Tab to Details, Enter opens it, a rename submitted with Enter shows the server-confirmed name', {}, async (page) => {
  await openTenants(page);
  assert.equal(tenantReads()[0].query, '?limit=25', 'the first page is read at the default limit, with no cursor');
  const details = await tabTo(page, 'Open details for Unnamed tenant');
  assert.ok(details, 'Tab reaches the Details button of the unnamed tenant');
  assert.equal(details.indicator, true, 'the Details button shows a visible focus ring');
  await page.press('Enter');
  await waitDetailsFocus(page, 'Unnamed tenant');
  await page.press('Tab');
  assert.equal(await page.evaluate('document.activeElement?.id'), 'display-name', 'Tab from the heading reaches the display-name field');
  await page.type('  Lakeside Test Shop  ');
  const saved = 'Display name saved as “Lakeside Test Shop”.';
  const releaseCommand = hold(RENAME);
  await page.press('Enter');
  await page.waitFor(() => commands().length === 1, 5000, 'Enter submitted the rename');
  const reads = tenantReads().length;
  await page.settle();
  assert.equal(await page.evaluate(noticeShown(saved)), false, 'nothing is shown as saved before the answer');
  assert.equal(tenantReads().length, reads, 'no re-read before the answer');
  releaseCommand();
  await waitNotice(page, saved);
  const sent = commands();
  assert.equal(sent.length, 1, 'Enter submitted exactly one command');
  assert.equal(sent[0].path, RENAME);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body, JSON.stringify({ tenantId: UNNAMED.tenantId, displayName: 'Lakeside Test Shop', expectedVersion: UNNAMED.version }), 'the exact JSON body: the trimmed name at the loaded version');
  // The definitive answer re-reads the directory; the list then shows the committed name.
  await page.waitFor(async () => (await rowStatus(page, 'Lakeside Test Shop')) === 'Active', 5000, 'the re-read list shows the new name');
  assert.ok(tenantReads().length > reads, 'the directory was read again after the answer');
  assert.equal(await page.evaluate(`document.getElementById('display-name').value`), 'Lakeside Test Shop', 'the field holds the server-confirmed name');
});

scenario('tm-suspend-dialog', 'Tenant Management: the suspend dialog opens from the keyboard and keeps focus, Escape returns it, and a confirmed reason sends one PATCH; the status changes only after the 200 and the re-read', {}, async (page) => {
  await openTenants(page);
  await page.click(detailsButton('Harbor Lane Repairs'));
  await waitDetailsFocus(page, 'Harbor Lane Repairs');
  assert.ok(await tabTo(page, 'Suspend tenant'), 'Tab reaches "Suspend tenant"');
  await page.press('Enter');
  await page.waitFor(`document.activeElement?.id === 'lifecycle-reason'`, 5000, 'focus lands on the reason field inside the dialog');

  const cycle = [];
  for (const shift of [false, false, false, false, true, true]) {
    await page.press('Tab', { shift });
    cycle.push(await page.evaluate(`document.querySelector('${DIALOG}').contains(document.activeElement) ? (document.activeElement.id || document.activeElement.textContent.trim()) : 'outside'`));
  }
  assert.deepEqual(cycle, ['Cancel', 'Suspend tenant', 'lifecycle-reason', 'Cancel', 'lifecycle-reason', 'Suspend tenant'], 'Tab and Shift+Tab cycle within the dialog');

  await page.press('Escape');
  await page.waitFor(`!document.querySelector('${DIALOG}')`, 5000, 'Escape closes the dialog');
  await page.waitFor(`document.activeElement?.textContent.trim() === 'Suspend tenant'`, 5000, 'focus returns to "Suspend tenant"');
  assert.equal(commands().length, 0, 'closing the dialog sent nothing');

  // Reopen from the keyboard and confirm with a reason; hold the answer, then the re-read after it.
  await page.press('Enter');
  await page.waitFor(`document.activeElement?.id === 'lifecycle-reason'`, 5000, 'the reopened dialog focuses its reason field');
  await page.type('Synthetic check: billing dispute under review');
  const releaseCommand = hold(LIFECYCLE);
  await page.press('Tab');
  await page.press('Tab');
  await page.press('Enter');
  await page.waitFor(() => commands().length === 1, 5000, 'the PATCH was sent');
  await page.waitFor(`document.querySelector('${DIALOG_CONFIRM}')?.textContent.trim() === 'Sending…'`, 5000, 'the confirm shows it is sending');
  assert.equal(await detailsStatus(page), 'Active', 'no status change while the answer is pending');
  const releaseRead = hold(TENANTS);
  const reads = tenantReads().length;
  releaseCommand();
  await waitNotice(page, 'Tenant suspended. Every tenant and store session is refused from its next request.');
  await page.waitFor(() => tenantReads().length === reads + 1, 5000, 'the 200 is followed by a re-read');
  assert.equal(await page.evaluate(`!!document.querySelector('${DIALOG}')`), false, 'the dialog closed');
  assert.equal(await detailsStatus(page), 'Active', 'the status text waits for the re-read');
  assert.equal(await rowStatus(page, 'Harbor Lane Repairs'), 'Active');
  releaseRead();
  await page.waitFor(async () => (await detailsStatus(page)) === 'Suspended', 5000, 'the re-read shows the tenant suspended');
  assert.equal(await rowStatus(page, 'Harbor Lane Repairs'), 'Suspended');
  assert.equal(await page.isVisible(el('button', 'Reactivate tenant')), true, 'the lifecycle action is the one the new status allows');
  const sent = commands();
  assert.equal(sent.length, 1, 'exactly one PATCH');
  assert.equal(sent[0].path, LIFECYCLE);
  assert.equal(sent[0].body, JSON.stringify({ tenantId: HARBOR.tenantId, status: 'suspended', reason: 'Synthetic check: billing dispute under review', expectedVersion: HARBOR.version }), 'the exact JSON body');
});

scenario('tm-focus-visible', 'Tenant Management: status reads as text; "Suspend tenant" and the dialog controls show a visible focus ring; contrast holds', {}, async (page) => {
  await openTenants(page);
  for (const [name, status] of [['Harbor Lane Repairs', 'Active'], ['Unnamed tenant', 'Active'], ['Cedar Point Mobile', 'Suspended']]) {
    assert.equal(await rowStatus(page, name), status, `${name}: status as text in the list`);
  }
  await page.click(detailsButton('Cedar Point Mobile'));
  await waitDetailsFocus(page, 'Cedar Point Mobile');
  assert.equal(await detailsStatus(page), 'Suspended', 'status as text in the details');
  await page.click(detailsButton('Harbor Lane Repairs'));
  await waitDetailsFocus(page, 'Harbor Lane Repairs');
  assert.equal(await detailsStatus(page), 'Active');
  await assertContrast(page, 'Tenant Management with details open');

  const trigger = await tabTo(page, 'Suspend tenant');
  assert.ok(trigger, 'Tab reaches "Suspend tenant"');
  assert.equal(trigger.indicator, true, 'the destructive control shows a visible focus ring');
  assert.equal(trigger.inView, true, 'the focused destructive control is in view');
  await page.press('Enter');
  await page.waitFor(`document.activeElement?.id === 'lifecycle-reason'`, 5000, 'focus inside the dialog');
  const stops = [await page.evaluate(FOCUS_STOP)];
  for (let i = 0; i < 2; i += 1) {
    await page.press('Tab');
    stops.push(await page.evaluate(FOCUS_STOP));
  }
  assert.deepEqual(stops.map((s) => s.label), ['TEXTAREA', 'Cancel', 'Suspend tenant'], 'the reason field, Cancel and the confirm');
  assert.deepEqual(stops.filter((s) => !s.indicator || !s.inView).map((s) => s.label), [], 'every dialog control shows a visible focus ring, in view');
  const { checked, fails } = await page.evaluate(`${KIT}.contrast(document.querySelector('${DIALOG}'))`);
  assert.ok(checked >= 5, `the dialog contrast audit saw its text (${checked} elements)`);
  assert.deepEqual(fails, [], 'WCAG contrast failures in the dialog');
  await page.screenshot(join(EVIDENCE, 'tm-dialog-desktop.png'));
});

scenario('tm-reflow-320', 'Tenant Management at 400% zoom (320 CSS px): no horizontal page overflow; list, details, form and dialog controls stay reachable and visible', {}, async (page) => {
  const reachable = async (targets, where) => {
    for (const t of targets) assert.equal(await page.call(t, REACHABLE), true, `${typeof t === 'string' ? t : `${t.role} "${t.name}"`} is reachable and visible ${where}`);
  };
  await page.setViewport(...ZOOM_400);
  await openTenants(page);
  await assertNoOverflow(page, 'on the list at 320px');
  await reachable([el('button', 'Refresh'), detailsButton('Harbor Lane Repairs'), detailsButton('Cedar Point Mobile'), el('button', 'Next page')], 'on the list at 320px');
  await page.screenshot(join(EVIDENCE, 'tm-list-320.png'));

  await page.click(detailsButton('Harbor Lane Repairs'));
  await waitDetailsFocus(page, 'Harbor Lane Repairs');
  await assertNoOverflow(page, 'with details open at 320px');
  await reachable(['#display-name', el('button', 'Save display name'), el('button', 'Suspend tenant')], 'in the details at 320px');
  await page.screenshot(join(EVIDENCE, 'tm-details-320.png'));

  await page.click(el('button', 'Suspend tenant'));
  await page.waitFor(`document.activeElement?.id === 'lifecycle-reason'`, 5000, 'focus inside the dialog');
  await assertNoOverflow(page, 'with the dialog open at 320px');
  await reachable(['#lifecycle-reason', `${DIALOG} button:not([aria-busy])`, DIALOG_CONFIRM], 'in the dialog at 320px');
  await page.screenshot(join(EVIDENCE, 'tm-dialog-320.png'));
  await page.press('Escape');
  await page.waitFor(`!document.querySelector('${DIALOG}')`, 5000, 'Escape closes the dialog');
});

scenario('tm-view-only', 'Tenant Management: a View-only page (actions false/false) shows no rename form and no lifecycle button, on either page', { actions: { editDisplayName: false, changeStatus: false } }, async (page) => {
  const controls = `(() => {
    const s = document.querySelector('[aria-labelledby=tenant-details-title]');
    return { fields: s.querySelectorAll('form, input, textarea').length, buttons: [...s.querySelectorAll('button')].map((b) => b.textContent.trim()), commandText: /Display name|Lifecycle|Suspend tenant|Reactivate tenant/.test(s.innerText) };
  })()`;
  const none = { fields: 0, buttons: [], commandText: false };
  await openTenants(page);
  for (const [name, status] of [['Harbor Lane Repairs', 'Active'], ['Cedar Point Mobile', 'Suspended']]) {
    await page.click(detailsButton(name));
    await waitDetailsFocus(page, name);
    assert.equal(await detailsStatus(page), status, `${name}: the status still reads as text`);
    assert.deepEqual(await page.evaluate(controls), none, `${name}: no rename form and no lifecycle button`);
  }
  // The next page, read with the first page's cursor, carries the same hint.
  await page.click(el('button', 'Next page'));
  await waitNotice(page, '1 tenant loaded.');
  assert.deepEqual(tenantReads().map((r) => r.query), ['?limit=25', `?limit=25&cursor=${encodeTenantCursor(CEDAR.tenantId)}`], 'the second page is read after the cursor the first page returned');
  await page.click(detailsButton('Northwind Trial Shop'));
  await waitDetailsFocus(page, 'Northwind Trial Shop');
  assert.equal(await detailsStatus(page), 'Trial');
  assert.deepEqual(await page.evaluate(controls), none, 'no rename form and no lifecycle button on the second page');
  assert.equal(commands().length, 0, 'no command was sent');
});

// M5-ADMIN-STEPUP-P1 — Suspend answered 403 step_up_required: a recent-sign-in dialog, the provider's own sign-in
// (password, then TOTP) inside it, the login in its re-authentication mode, a re-read, then a NEW confirmation.
const STEPUP_TITLE = 'Sign in again to suspend Harbor Lane Repairs';
const STEPUP = `${DIALOG}[aria-labelledby=stepup-title]`;
const STEPUP_REASON = 'Synthetic check: chargeback review before step-up';
const SIGNED_IN = 'Sign-in completed. Harbor Lane Repairs has not been changed.';
const RESUME_NOTE = `${SIGNED_IN} Choose “Suspend tenant” to confirm it again with a new reason.`;
const noteText = (page) => page.evaluate(`document.getElementById('tenant-resume')?.textContent.trim() ?? null`);
const stepUpText = (page) => page.evaluate(`document.querySelector(${JSON.stringify(STEPUP)})?.innerText ?? null`);

/** From the Harbor details: Suspend with a reason, answered step_up_required; the recent-sign-in dialog is open. */
async function suspendToStepUp(page) {
  await openTenants(page);
  await page.click(detailsButton('Harbor Lane Repairs'));
  await waitDetailsFocus(page, 'Harbor Lane Repairs');
  assert.ok(await tabTo(page, 'Suspend tenant'), 'Tab reaches "Suspend tenant"');
  await page.press('Enter');
  await page.waitFor(`document.activeElement?.id === 'lifecycle-reason'`, 5000, 'focus lands on the reason field');
  await page.type(STEPUP_REASON);
  await page.press('Tab');
  await page.press('Tab');
  await page.press('Enter');
  await page.waitFor(`document.activeElement?.id === 'stepup-title'`, 5000, 'focus lands on the recent-sign-in heading');
  const [refused] = commands(LIFECYCLE);
  assert.equal(refused.status, 403, 'the first attempt was refused for want of a recent sign-in');
  assert.equal(await page.evaluate(`document.querySelectorAll('${DIALOG}').length`), 1, 'the confirmation dialog closed; only the recent-sign-in dialog is open');
  assert.equal(await page.isVisible(el('dialog', STEPUP_TITLE)), true, 'the dialog names the tenant and the action');
  assert.match(await stepUpText(page), /Nothing has been changed: Harbor Lane Repairs is still active\./, 'it says nothing was changed');
  assert.equal(await detailsStatus(page), 'Active');
  return refused;
}

/** Keyboard only, from the focused recent-sign-in heading: "Sign in again", email, password, then the TOTP code. */
async function reauthenticateByKeyboard(page, { beforeCode } = {}) {
  assert.ok(await tabTo(page, 'Sign in again', 4), 'Tab reaches "Sign in again" inside the dialog');
  await page.press('Enter');
  await page.waitFor(`document.activeElement?.id === 'stepup-title' && !!document.getElementById('reauth-email')`, 5000, 'the sign-in form opens and focus returns to the heading');
  await page.press('Tab');
  assert.equal(await page.evaluate('document.activeElement?.id'), 'reauth-email', 'Tab reaches the email field');
  await page.type(EMAIL);
  await page.press('Tab');
  await page.type(PASSWORD);
  await page.press('Enter');
  await page.waitFor(`!!document.getElementById('reauth-code') && document.activeElement?.id === 'stepup-title'`, 10_000, 'the second factor is asked for');
  await page.press('Tab');
  assert.equal(await page.evaluate('document.activeElement?.id'), 'reauth-code', 'Tab reaches the verification code');
  await page.type(TOTP);
  await beforeCode?.();
  await page.press('Enter');
}

scenario('tm-step-up', 'Tenant Management: step_up_required opens a recent-sign-in dialog; keyboard-only sign-in again (password + TOTP) rotates the session, the tenant is re-read, and only a NEW confirmation with a new reason and key changes it', { recentAuth: true }, async (page) => {
  const refused = await suspendToStepUp(page);
  await page.screenshot(join(EVIDENCE, 'tm-step-up-dialog-desktop.png'));
  // Visible focus on the dialog's controls, and the reason typed for the refused attempt is gone.
  const stops = [];
  for (let i = 0; i < 2; i += 1) {
    await page.press('Tab');
    stops.push(await page.evaluate(FOCUS_STOP));
  }
  assert.deepEqual(stops.map((x) => x.label).sort(), ['Cancel', 'Sign in again'], 'Tab cycles Cancel and "Sign in again" inside the dialog');
  assert.deepEqual(stops.filter((x) => !x.indicator || !x.inView).map((x) => x.label), [], 'each dialog control shows a visible focus ring, in view');
  assert.equal((await page.evaluate(`document.body.innerText`)).includes(STEPUP_REASON), false, 'the refused attempt\'s reason is not kept');
  const priorCookie = st.cookieValue;
  const priorCsrf = st.csrfToken;
  const reads = tenantReads().length;

  // Someone else changes the tenant (not its status) while the administrator signs in: the next intent must carry the re-read version.
  assert.equal(await focusedIn(page, STEPUP), true, 'focus is still inside the dialog');
  let releaseRead = () => {};
  await reauthenticateByKeyboard(page, { beforeCode: () => { st.tenants[0].version += 1; releaseRead = hold(TENANTS); } });
  // Until the re-read answers, no lifecycle control is offered and focus waits on the tenant's heading.
  await page.waitFor(`!document.querySelector('${DIALOG}') && document.activeElement?.id === 'tenant-details-title'`, 10_000, 'the dialog closed; focus on the tenant heading');
  assert.equal(await page.evaluate(`!!document.getElementById('tenant-lifecycle-trigger')`), false, 'no lifecycle control before the re-read answers');
  releaseRead();
  await page.waitFor(async () => (await noteText(page)) === RESUME_NOTE, 10_000, 'the resume note after the re-read');
  // Said once, by the page's live region (emptied, then filled); the note itself is not a second live region.
  await page.waitFor(`document.getElementById('tenant-announcement').textContent.trim() === ${JSON.stringify(RESUME_NOTE)}`, 5000, 'the live region says the sign-in completed');
  assert.equal(await page.evaluate(`document.getElementById('tenant-resume').hasAttribute('role')`), false, 'the resume note carries no live role');
  await page.waitFor(`document.activeElement?.id === 'tenant-lifecycle-trigger'`, 5000, 'focus returns to "Suspend tenant"');

  const [login] = logins();
  assert.equal(logins().length, 1, 'exactly one login');
  assert.equal(login.reauth, true, 'the login was sent in re-authentication mode');
  assert.equal(login.headers['x-tmpos-reauthenticate'], '1');
  assert.equal(login.headers['x-tmpos-csrf'], '1');
  assert.ok(login.headers.authorization === `Bearer ${st.finalizeIdToken}`, 'the bearer is the new provider token');
  assert.equal(login.cookieOk, true, 'it presented the prior session');
  assert.equal(login.hasPostData, false, 'the login is bodiless');
  assert.equal(login.status, 200);
  assert.notEqual(st.cookieValue, priorCookie, 'the session rotated');
  assert.notEqual(st.csrfToken, priorCsrf, 'a new session CSRF token');
  assert.deepEqual(st.revoked, [priorCookie], 'the prior session was revoked');
  assert.equal(st.totpCode, TOTP, 'the typed code reached the provider');
  const after = st.requests.slice(st.requests.indexOf(login) + 1);
  assert.ok(after.some((r) => r.method === 'GET' && r.path === SESSION && r.status === 200 && r.cookieOk), 'a session read on the new cookie confirmed it');
  assert.ok(tenantReads().length > reads, 'the directory was read again');
  assert.equal(commands(LIFECYCLE).length, 1, 'nothing was replayed or queued');
  assert.equal(await detailsStatus(page), 'Active', 'the tenant is unchanged');
  assert.equal(await page.evaluate(noticeShown('Tenant suspended. Every tenant and store session is refused from its next request.')), false, 'the sign-in is not shown as the action');
  await page.screenshot(join(EVIDENCE, 'tm-step-up-resumed-desktop.png'));

  // The action again: a new confirmation with an empty reason, typed anew, under a new key at the re-read version.
  await page.press('Enter');
  await page.waitFor(`document.activeElement?.id === 'lifecycle-reason'`, 5000, 'a new confirmation dialog');
  assert.equal(await page.evaluate(`document.getElementById('lifecycle-reason').value`), '', 'the reason starts empty');
  await page.type('Synthetic check: confirmed after a recent sign-in');
  await page.press('Tab');
  await page.press('Tab');
  await page.press('Enter');
  await waitNotice(page, 'Tenant suspended. Every tenant and store session is refused from its next request.');
  await page.waitFor(async () => (await detailsStatus(page)) === 'Suspended', 5000, 'the re-read shows the tenant suspended');
  const [, fresh] = commands(LIFECYCLE);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body, JSON.stringify({ tenantId: HARBOR.tenantId, status: 'suspended', reason: 'Synthetic check: confirmed after a recent sign-in', expectedVersion: HARBOR.version + 1 }), 'a new intent: the new reason at the re-read version');
  assert.notEqual(fresh.headers['idempotency-key'], refused.headers['idempotency-key'], 'a new Idempotency-Key');
  assert.ok(fresh.cookieOk && fresh.csrfOk, 'sent on the rotated session with its CSRF token');
});

scenario('tm-step-up-other-admin', 'Tenant Management: a different synthetic administrator signing in cannot resume — 401, the prior session kept, nothing re-read or sent', { recentAuth: true }, async (page) => {
  await suspendToStepUp(page);
  const priorCookie = st.cookieValue;
  const reads = tenantReads().length;
  st.uid = OTHER_UID; // the provider now signs in someone else
  await reauthenticateByKeyboard(page);
  const refusedText = 'Sign-in was not accepted for the administrator who started this action. Harbor Lane Repairs was not changed.';
  await waitNotice(page, refusedText);
  await page.waitFor(`document.activeElement?.id === 'stepup-title'`, 5000, 'focus returns to the dialog heading');
  const [login] = logins();
  assert.equal(login.status, 401, 'the server refused the other administrator');
  assert.ok(login.cookieOk && bearerUid(login) === OTHER_UID, 'the other administrator\'s token was presented beside the prior session');
  assert.equal(st.cookieValue, priorCookie, 'the prior session was left as it was');
  assert.deepEqual(st.revoked, [], 'nothing was revoked');
  assert.equal(tenantReads().length, reads, 'nothing was re-read');
  assert.equal(commands(LIFECYCLE).length, 1, 'nothing was sent');
  assert.equal(await page.isVisible(el('button', 'Try again')), true, 'the dialog offers "Try again"');
  await page.screenshot(join(EVIDENCE, 'tm-step-up-other-admin-desktop.png'));
  await page.press('Escape');
  await page.waitFor(`!document.querySelector('${DIALOG}')`, 5000, 'Escape cancels');
  await page.waitFor(`document.activeElement?.id === 'tenant-lifecycle-trigger'`, 5000, 'focus returns to "Suspend tenant"');
  assert.equal(await noteText(page), null, 'no resume note');
  assert.equal(await detailsStatus(page), 'Active');
});

scenario('tm-step-up-cancel', 'Tenant Management: a refused credential and a Cancel in the recent-sign-in dialog leave the tenant unchanged, say so, and return focus', { recentAuth: true, provider: 'invalid' }, async (page) => {
  await suspendToStepUp(page);
  assert.ok(await tabTo(page, 'Sign in again', 4));
  await page.press('Enter');
  await page.waitFor(`!!document.getElementById('reauth-email')`, 5000, 'the sign-in form');
  await page.fill(el('textbox', 'Email'), EMAIL);
  await page.fill(el('textbox', 'Password'), PASSWORD);
  await page.click(el('button', 'Sign in'));
  await waitNotice(page, 'Sign-in failed. Check your details and try again. Harbor Lane Repairs was not changed.');
  assert.equal(logins().length, 0, 'no token, so no login');
  await page.click(el('button', 'Cancel'));
  await page.waitFor(`!document.querySelector('${DIALOG}')`, 5000, 'Cancel closes the dialog');
  await page.waitFor(`document.activeElement?.id === 'tenant-lifecycle-trigger'`, 5000, 'focus returns to "Suspend tenant"');
  await waitNotice(page, 'Harbor Lane Repairs was not changed.');
  assert.equal(commands(LIFECYCLE).length, 1, 'nothing more was sent');
  assert.equal(await detailsStatus(page), 'Active');
  assert.equal(await rowStatus(page, 'Harbor Lane Repairs'), 'Active');
});

scenario('tm-step-up-reflow-320', 'Tenant Management at 400% zoom (320 CSS px): the recent-sign-in dialog and its sign-in form reflow without horizontal page overflow, every control reachable and visible', { recentAuth: true }, async (page) => {
  const reachable = async (targets, where) => {
    for (const t of targets) assert.equal(await page.call(t, REACHABLE), true, `${typeof t === 'string' ? t : `${t.role} "${t.name}"`} is reachable and visible ${where}`);
  };
  await page.setViewport(...ZOOM_400);
  await suspendToStepUp(page);
  await assertNoOverflow(page, 'with the recent-sign-in dialog open at 320px');
  await reachable(['#stepup-title', el('button', 'Sign in again'), el('button', 'Cancel')], 'in the dialog at 320px');
  await page.screenshot(join(EVIDENCE, 'tm-step-up-320.png'));
  await page.click(el('button', 'Sign in again'));
  await page.waitFor(`!!document.getElementById('reauth-email')`, 5000, 'the sign-in form');
  await assertNoOverflow(page, 'with the sign-in form open at 320px');
  await reachable(['#reauth-email', '#reauth-password', el('button', 'Sign in'), el('button', 'Continue with Google'), el('button', 'Cancel')], 'in the sign-in form at 320px');
  await page.screenshot(join(EVIDENCE, 'tm-step-up-form-320.png'));
  await page.press('Escape');
  await page.waitFor(`!document.querySelector('${DIALOG}')`, 5000, 'Escape closes the dialog');
});

test('l. no emitted .js/.css/.html file contains the development-build badge', (t) => {
  if (!CHROMIUM) { t.skip(SKIP); return; }
  const emitted = walk(outDir).filter((f) => ['.js', '.css', '.html'].includes(extname(f)));
  assert.ok(emitted.some((f) => readFileSync(f, 'utf8').includes('Sign in to the Control Plane')), 'the console is part of the scanned bundle');
  assert.deepEqual(emitted.filter((f) => readFileSync(f, 'utf8').includes('Local development build')).map((f) => relative(outDir, f)), []);
});

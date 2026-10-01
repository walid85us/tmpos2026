// M7A-CUSTOMERS-P3-R2 — THE SHOP'S BUILT-IN CUSTOMERS LEVELS, END TO END IN A REAL BROWSER: a PRODUCTION build of the shop
// SPA in Chromium, signed in through a synthetic Firebase identity provider, talking to the REAL tenant entry
// (server/entry/tenantEntry.ts, startTenantEntry) over loopback HTTP, over a disposable PostgreSQL holding every migration.
// M7A-CUSTOMERS-P4 (DA-125) — TWO tenant entries share that database: a scenario routes a page or tab to the second one
// (st.second), so the stale-draft cases cross instances. Every save asserts the tenant and version its draft was read at.
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
// command transaction, migrations 020/021's routines, audit writer and read-back route are production's own code,
// unmodified (each entry's pool is smaller than production's MAX_POOLS, so two fit a disposable cluster's connections).
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
//          succeeds. M7A-CUSTOMERS-P6: after the session ended in the store, the owner presses Reconnect (one login)
//          before the next save — Save no longer signs in on its own. A revoked owner grant ends the owner's session:
//          the held key's save sends no login and no PUT ("Not confirmed yet", Reconnect offered); with the grant back,
//          Reconnect logs in once and a 403 refusal of the held key still says "Not confirmed yet"; and a Reconnect pressed
//          while the grant is revoked logs in once, shows the owner-only Denied state and writes nothing.
//   SRL-04 a stale sign-in is refused (403 step_up_required), the owner re-authenticates in a labelled prompt that takes
//          focus (AM7), and only then saves.
//   SRL-05 a failed identity verifier leaves the panel unavailable (no levels, no save) until it recovers.
//   SRL-06 a manager sees the panel denied, and the server refuses the manager's direct reads and PUTs — the self-grant and
//          its variants (another domain, Manage, an extra field) included — with nothing written, not even an audit record.
//   SRL-07 the local grid is labelled local-only; a grid change — a built-in role's Customers cell (which points to the
//          server panel) or a custom role's — sends nothing to any server and moves no server level; no global Save.
//   SRL-08 two browsers on two tenant entries read one role at the same version: the first narrows it (Saved); the
//          second's older, permissive draft is refused by the version precondition (409 write_conflict, nothing written,
//          no edit audit, the restrictive level and its authority stand) and shown as a conflict (the server's level and
//          the unsaved choice, Discard/Reapply, Save off); Reapply and a new Save (new version, new key) land it; the
//          first browser's "Saved" then says "Changed elsewhere" on its next refresh (AM2). A sales_staff session's
//          create and read answer each committed level.
//   SRL-08T the same with two TABS of one browser (one cookie jar, one sign-in), each tab on its own entry.
//   SRL-09 a user switch in one browser (a second tab signs in as another owner) ends the first user's tenant session
//          BEFORE the next user's login leaves the page (AM4: while that login is held, the old cookie reads 401); signing
//          out (the persisted sign-in cleared, as a sign-out in another tab leaves it) ends the next user's session too.
//   SRL-10 a draft made in tenant A, saved after the SAME owner's session moved to tenant B (grant swapped): since
//          M7A-CUSTOMERS-P6 the save finds the session ended and sends NOTHING — no login, no PUT — and offers Reconnect;
//          the Reconnect's one login (now B's) reads another store, so the draft is cleared and the shop says the store
//          changed. Nothing is written in A or B — no level, version, edit audit, completion or idempotency row.
//   SRL-11 a save PARKED INSIDE THE DATABASE (a side transaction holds A's role row FOR UPDATE; the PUT's backend waits
//          on it) while the owner's session moves to B (another tab of the browser signs in again): B is untouched, A
//          holds whatever the server decided, and the panel — now B's — reports it only as a detached notice, never as
//          B's save.
//   SRL-12 reset to the default, then an older draft: View, then Create restored (the default word, a newer version); a
//          draft made at the first version is refused though the level it saw is back (no ABA); Discard drops it.
//
// M7A-CUSTOMERS-P5 — THE CUSTOMER DIRECTORY PAGE (/customers/directory, src/tenant/ServerCustomerDirectory.tsx), in the
// same harness, driven by its test ids and judged on the wire (st.api) and in the database, each case in tenants of its
// own. One more substitution, stated: st.lose makes the front drop ONE request before it reaches the entry, or ONE answer
// after the entry gave it — the page sees a network failure, exactly what a cut connection leaves it.
//   SCB-01 THE ENTRY WITNESS: an owner opens the directory from the sidebar (empty), adds a customer — exactly one POST
//          from the page, 201, one customer, one create audit, one completion, no role edit; the row survives a reload,
//          a second account's browser shows it, its detail opens by click and by direct URL; no request names a tenant,
//          store, role or actor. Red on the entry SPA: no POST ever leaves the page and no row exists.
//   SCB-02 isolation: another tenant's customer id, a well-formed unknown id and a malformed id (no request at all) show
//          the SAME not-found text; tenant B's list holds B's customers only.
//   SCB-03 paging: 60 rows -> 50, "Load more" -> 60, ids unique, in the server's byte order, no `limit` sent.
//   SCB-04 a sales_staff page open while the owner narrows Customers to View: Add is refused (403), nothing written — no
//          customer, audit, completion or lease — and the list is still shown; narrowed to None, Refresh shows the denied
//          state and no rows.
//   SCB-05 a reply lost after the commit: the unresolved card, never "saved"; "Check again" re-sends the SAME key and the
//          byte-identical body (though the field was edited since), answered 201 as a replay; ONE customer of that name.
//   SCB-06 a first send that never reached the server, then the account's grant moves to tenant B: "Check again" finds
//          the session ended and sends nothing — no login, no POST (M7A-CUSTOMERS-P6); the owner's Reconnect signs in (now
//          B's) and the attempt is detached — no POST leaves under the new session, neither tenant holds the name.
//
// M7A-CUSTOMERS-P5-R1 — the tenant session is REUSED across loads and the customer reads are BOUND to it (same harness).
// One more substitution, stated: SCB-08 swaps the browser's tenant session cookie (CDP Storage.setCookies in the page's
// browser context) while one read is parked at the front, and the front forwards that parked read with the swapped cookie —
// exactly what the jar would have sent had the swap landed a moment earlier. Numbers are appended to scb-witness.jsonl in
// the evidence folder BEFORE anything is asserted, so the entry run records the whole "before" picture.
//   SCB-07 SESSION REUSE (DA-143): inside one 5-minute window an owner opens the directory, reloads it 6 times, reopens it
//          by in-app navigation (away, back by the sidebar), makes one load that shows both server consumers (directory,
//          Permissions server panel, directory again) and opens it in a second TAB of the same browser; every load shows
//          the rows. Counted: POST /api/v1/session/login for this owner, live tmpos_session.session rows for the principal,
//          tmpos_mint.tenant_session rows (live, and the ledger's growth), every 429, and whether each load read GET
//          /api/v1/session before its first customer read. Expected: ONE login, one session row, one mint row, no 429.
//   SCB-08 READ BINDING (DA-138): owner A's page; owner B's valid session made outside the page. A's next list read (a
//          Refresh), then separately A's detail read (one of A's customers, by URL), is parked at the front AFTER the page's
//          session check was answered; the jar's session cookie is replaced with B's; the read is released carrying B's.
//          Recorded per read: the session it carried (A/B), the status, whether any answer delivered to the page or the DOM
//          (sampled at release and after the page settles) held a B id or name, and what the page ends showing. Expected:
//          403 with no customers, no B id ever on page A, and — after a session read, A's login and a confirming read — A's
//          own rows and customer again (a new A session).
//
// M7A-CUSTOMERS-P6 — a session the page confirmed that the server then ends is NEVER re-established on its own (same
// harness). The end is the one SRL-03 makes: the owner's tmpos_session.session rows (and their mint rows) deleted.
//   SCB-09 SESSION END: an owner's page with rows and an unresolved create (its answer lost after the commit); the session
//          is ended in the store. Refresh, a window focus, a tab return (visibilitychange), "Check again", a customer
//          opened in the app and the way back send ZERO logins and no POST; the list and the detail show "Reconnect" and
//          no customer. ONE Reconnect click sends exactly ONE login, the rows return and the attempt is detached (never
//          re-sent: one POST in the whole case). Ended again, a valid session another TAB made is reused on focus with
//          no login from the page. A reload while the cookie names an ended session is a fresh page: one login, the
//          stated residual (the 401 does not say "expired", and the page stores nothing). Not run in this stage's
//          sandbox (no browser gate here): written to SCB-05/07/08's helpers.
//
// RUN (the SPA build runs Tailwind's scanner over the source root: point P3R2_SPA_SOURCE at a clean export, node_modules
// linked, when the working tree holds large untracked directories — the same variable builds the entry commit's SPA for the
// witness; P3R2_SPA_DIST reuses a finished build; P3R2_EVIDENCE names the evidence folder):
//   firebase emulators:exec --only firestore --project demo-tmpos-shop 'tsx --test tests/browser/shopRoleLevels.browser.test.mjs'
//   P3R2_FIRESTORE=stub tsx --test tests/browser/shopRoleLevels.browser.test.mjs          (no emulator: stub, stated)
// DISPOSABLE ONLY: the database target is tests/db/localPostgres.harness.mjs's (a supplied CI service or a cluster made and
// destroyed here). On a shared service this file removes its customers, role levels and their 021 versions (or 021's
// rollback would refuse), sessions and mint rows, restores the
// limiter fingerprint and issuer key row it found, and drops its login. What it leaves is what every suite leaves: its
// synthetically named identities, tenants and grants, their audit records and idempotency records.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      await step(async () => { // 021's version rows first (an entry commit before 021 has no such table)
        const [{ present }] = await owner`select to_regclass('tmpos_role_edit.role_level_version') is not null as present`;
        if (present) await owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
      });
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

/** One tenant's whole role-level footprint: its edit audits, stored levels (020's lock row: 'lock') and 021 versions. */
async function tenantState(tenant) {
  const [r] = await owner`select
    (select count(*) from public.audit_event where action_id = ${EDIT_ACTION} and tenant_id = ${tenant})::int as edits,
    (select coalesce(jsonb_object_agg(role_id, coalesce(level, 'lock')), '{}') from tmpos_role.tenant_role_level where tenant_id = ${tenant}) as levels,
    (select coalesce(jsonb_object_agg(role_id, version), '{}') from tmpos_role_edit.role_level_version where tenant_id = ${tenant}) as versions`;
  return r;
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
let entry2 = null; // the second tenant entry over the same database (P4): pages and tabs in st.second reach it
/** Each entry's pool: two, the owner's client and the cluster's reserved slots fit a disposable cluster's 20 connections. */
const POOLS = Math.min(5, MAX_POOLS);

async function startEntry() {
  entry = await listenEntry();
}

async function listenEntry() {
  const cap = { codes: [], lines: [], proc: new EventEmitter() };
  const construction = {
    databaseClient: () => createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
      ...runtimeClientOptions(TARGET_DSN), ssl: false, max: POOLS, idle_timeout: 0, user: RUNTIME_LOGIN,
    }),
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  const result = await startTenantEntry({
    env: ENV, construction, proc: cap.proc, exit: (code) => { cap.codes.push(code); }, log: { log: (line) => { cap.lines.push(line); } },
  });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  return { port: result.address.port, cap };
}

async function stopEntry() {
  const stopping = entry;
  entry = null;
  await stopped(stopping);
}

async function stopped(listening) {
  if (listening === null) return;
  const { cap } = listening;
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

/**
 * A request from outside the browser (a pre-issued employee session, a manager's direct attempt), as a same-origin client.
 * A request with a session names it by its session CSRF token, as the shop does: the customer reads require it since
 * M7A-CUSTOMERS-P5-R1 (DA-138), and it changes nothing on a route that does not.
 */
async function call(method, path, { session = null, body, key } = {}) {
  const unsafe = method !== 'GET';
  const headers = {
    host: SHOP_HOST,
    ...(session ? { cookie: session.cookie } : {}),
    // A bare cookie (readWith: the unbound roles/levels read) carries no token to send.
    ...(typeof session?.csrf === 'string' ? { [SESSION_CSRF_HEADER]: session.csrf } : {}),
    ...(unsafe ? { origin: SHOP, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(key ? { 'idempotency-key': key } : {}),
  };
  const res = await send(entry.port, method, path, headers, body === undefined ? (unsafe ? '' : undefined) : JSON.stringify(body));
  return { status: res.status, headers: res.headers, text: res.body.toString('utf8') };
}

/**
 * Every tenant login attempt of the run, per account (the server allows 5 per account per 5 minutes): the evidence names
 * the most any account made inside one such window, so a scenario that spends the budget shows before it fails.
 */
const LOGINS = new Map(); // uid -> [performance.now() of each attempt]
function noteLogin(uid) {
  if (uid !== null) LOGINS.set(uid, [...(LOGINS.get(uid) ?? []), performance.now()]);
}
function loginPeak() {
  let peak = { account: null, logins: 0 };
  for (const [uid, times] of LOGINS) {
    for (const start of times) {
      const logins = times.filter((t) => t >= start && t < start + 5 * 60_000).length;
      if (logins > peak.logins) peak = { account: uid, logins };
    }
  }
  return { ...peak, accounts: LOGINS.size, attempts: [...LOGINS.values()].reduce((n, times) => n + times.length, 0) };
}

/** A tenant session established outside the browser with a token this file issued: { cookie, csrf }. */
async function directLogin(who) {
  noteLogin(who.uid);
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

async function newTenant(label) {
  const [{ tenant_id: tenant }] = await owner`insert into tenant (display_name, status) values (${`m7srl-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(tenant);
  return tenant;
}

/** A tenant of its own with its store owner, who can sign in to the shop. */
async function shop(label) {
  const tenant = await newTenant(label);
  const boss = await actor(`${label}-owner`, [grant(tenant, 'store_owner')], { role: 'store_owner' });
  return { tenant, boss };
}

/**
 * The same account's store moves from `from` to `to`: its grant is swapped in one transaction (two tenant grants at once
 * are refused), which ends its sessions (their admission no longer holds); its next login is scoped to `to`.
 */
async function moveOwner(who, from, to) {
  await owner.begin(async (sql) => {
    await sql`delete from user_membership where internal_user_id = ${who.id} and tenant_id = ${from}`;
    await sql`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${who.id}, ${to}, null, 'tenant', 'store_owner', 'active')`;
  });
}

/** A level set outside the browser the way the shop sets it: read the tenant and version, then PUT asserting both. */
async function directSet(session, roleId, level) {
  const read = await call('GET', ROLE_LEVELS, { session });
  assert.equal(read.status, 200, read.text);
  const { tenant, roles } = JSON.parse(read.text);
  const expectedVersion = roles.find((r) => r.roleId === roleId).version;
  return call('PUT', ROLE_LEVELS, { session, body: { roleId, domain: 'customers', level, reason: REASON, expectedTenant: tenant, expectedVersion }, key: randomUUID() });
}

/** What a sales_staff session may do under each committed Customers level: [POST create, GET list] statuses. */
const AUTHORITY = Object.freeze({ none: [403, 403], view: [403, 200], create: [201, 200], edit: [201, 200] });
async function assertAuthority(staffSession, level, label) {
  const post = await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL ${label} ${randomUUID().slice(0, 8)}` }, key: randomUUID() });
  const list = await call('GET', `${CUSTOMERS}?limit=10`, { session: staffSession });
  note(`authority: ${label}`, [post.status, list.status]);
  assert.deepEqual([post.status, list.status], AUTHORITY[level], `${label}: a sales_staff session's create and read under ${level}`);
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
  // via: the tenant entry it was forwarded to (2: the page or tab is in st.second).
  const rec = { method: request.method, path: u.pathname, query: u.search, frameId: ev.frameId, via: s.second.has(ev.frameId) ? 2 : 1, headers, body: postBody(request), status: null, at: performance.now(), doneAt: null, cookie: null };
  s.api.push(rec);
  if (rec.method === 'POST' && rec.path === LOGIN) noteLogin(bearerUid(rec));
  await passGates(s, rec, 'request');
  // st.lose (SCB-05/06): this request never reaches the entry; the page's fetch fails as a cut connection does.
  if (s.lose?.(rec, 'request')) { rec.lost = 'request'; rec.status = 0; rec.doneAt = performance.now(); return null; }
  const out = { ...Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k))), host: SHOP_HOST };
  if (s.tamper) await s.tamper(rec, out);
  let res = null;
  const target = rec.via === 2 ? entry2 : entry;
  if (target !== null) res = await send(target.port, rec.method, `${u.pathname}${u.search}`, out, rec.body === '' && rec.method === 'GET' ? undefined : rec.body).catch(() => null);
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
  // replied: what the entry answered (headers lower-cased, the body as text), whether or not the page receives it.
  rec.replied = { headers: lower(Object.fromEntries(res.pairs)), text: res.body.toString('utf8') };
  await passGates(s, rec, 'response');
  // st.lose: the entry answered (and committed whatever it committed); the answer never reaches the page.
  if (s.lose?.(rec, 'response')) { rec.lost = 'response'; return null; }
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

const apiLine = (r) => `${r.via === 2 ? '[entry2] ' : ''}${r.method} ${r.path}${r.query} -> ${r.status ?? 'held'}${r.error ? ` ${r.error}` : ''}${r.lost ? ` (${r.lost} lost at the front)` : ''}`;
/** An answer's status and error, e.g. "409 write_conflict". */
const answered = (r) => `${r.status}${r.error ? ` ${r.error}` : ''}`;
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
  // "Last known level" is the same level not established by a read since (a failed read-back): `known` says which.
  const m = /(Server|Last known) level:\s*(None|View Only|Create|Edit|Manage|Approve|Full Access)\s*(Custom|Default)/.exec(text);
  return m ? { level: m[2], badge: m[3], known: m[1] === 'Server' } : { text };
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
    // A disabled select is a save still finishing — or a settled conflict, which locks the row until Discard or Reapply.
    const busy = await page.evaluate(`(document.querySelector('[data-testid="server-level-select-${roleId}"]')?.disabled ?? false)
      && document.querySelector('[data-testid="server-level-status-${roleId}"]')?.dataset.status !== 'conflict'`);
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
  notConfirmed: (level) => `Not confirmed yet — press Save again to check. The server has ${LABELS[level]}.`,
  // a held attempt (its key may have committed) refused or unsent: never "Not saved" (R2-2)
  confirmDenied: 'Not confirmed yet — the server refused the check. Only the store owner can change these levels.',
  confirmEnded: 'Not confirmed yet — your server session ended. Reconnect, then press Save again to check.',
  confirmUnreachable: 'Not confirmed yet — the store server could not be reached. Press Save again to check.',
  lostRace: (level) => `Changed elsewhere — the server now has ${LABELS[level]}. Your change is not saved.`,
  changedElsewhere: (level) => `Changed elsewhere — the server now has ${LABELS[level]}.`,
  reapplied: 'Reapplied to the current server level. Not saved yet.',
});
const REFRESH_FAILED = 'Could not refresh from the server; values may be out of date.';
/** The panel's notices after a same-account tenant switch (STORE_CHANGED_NOTICE and PREVIOUS_STORE there). */
const STORE_CHANGED = 'The store server now answers for a different store. Unsent changes were cleared. No change was sent to the newly connected store.';
const PREVIOUS_STORE = Object.freeze({
  acknowledged: 'A change sent before the store connection changed was acknowledged by the server; it could not be read back here.',
  notSaved: 'A change sent before the store connection changed was not saved.',
  unconfirmed: 'A change sent before the store connection changed could not be confirmed.',
});

/** The backends waiting on `pid` (pg_blocking_pids), with what they run. */
const blockedBy = (pid) => owner`select pid, usename, wait_event_type, left(query, 200) as query
  from pg_catalog.pg_stat_activity where ${pid}::int = any(pg_catalog.pg_blocking_pids(pid))`;
/** Poll `fn` until it answers something truthy (that answer), or fail after `timeout` ms. */
async function until(fn, timeout, label) {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out after ${timeout} ms: ${label}`);
    await delay(100);
  }
}
/** { changed: the store-changed notice or null, previous: the previous-store notices }. */
const noticesOf = (page) => page.evaluate(`({
  changed: document.querySelector('[data-testid="server-levels-store-changed"]')?.textContent.trim() ?? null,
  previous: [...document.querySelectorAll('[data-testid="server-levels-previous-store"] p')].map((p) => p.textContent.trim()),
})`);
/** A role's conflict group: "The server now has X. Your unsaved choice: Y." or null. */
const conflictOf = (page, roleId) => page.evaluate(`document.querySelector('[data-testid="server-level-conflict-${roleId}"] p')?.textContent.trim() ?? null`);
const saveEnabled = (page, roleId) => page.evaluate(`document.querySelector('[data-testid="server-level-save-${roleId}"]')?.disabled === false`);
const hasDraft = (page, roleId) => page.evaluate(`!!document.querySelector('[data-testid="server-level-unsaved-${roleId}"]')`);
/** Route a page's (or tab's) API requests to the second tenant entry; answers the page. */
const viaSecond = (page) => { st.second.add(page.frameId); return page; };

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

function scenario(id, title, fn, timeout = 180_000) {
  test(`${id}: ${title}`, { timeout }, async () => {
    st = { id, api: [], idp: [], firestore: [], blocked: [], gates: new Set(), releases: [], tamper: null, lose: null, pages: [], tabs: [], second: new Set(), secrets: new Set(), notes: {} };
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
    const buildStarted = performance.now();
    const built = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: SOURCE,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', VITE_ADMIN_CONSOLE_ORIGINS: ADMIN }, // never inherit process.env
      encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(built.status, 0, redact(`production build failed (${built.error?.message ?? `exit ${built.status}, signal ${built.signal}`}):\n${`${built.stdout ?? ''}${built.stderr ?? ''}`.slice(-3000)}`));
    process.once('exit', () => rmSync(outDir, { recursive: true, force: true }));
    evidence.buildSeconds = Math.round((performance.now() - buildStarted) / 1000);
    console.log(`SPA build: ${evidence.buildSeconds} s`);
  }
  for (const f of walk(outDir)) files.set(`/${relative(outDir, f).split(sep).join('/')}`, f);
  assert.ok(files.has('/index.html'), 'the build holds index.html');
  await setupDatabase();
  if (FIRESTORE_MODE === 'emulator') await loadEmulatorRules();
  await startEntry();
  entry2 = await listenEntry();
  browser = await launch({ executable: CHROMIUM });
  await browser.intercept(route);
}, { timeout: 900_000 });

after(async () => {
  evidence.logins = loginPeak();
  console.log(`tenant logins: most by one account inside 5 minutes = ${evidence.logins.logins} (${evidence.logins.attempts} attempts by ${evidence.logins.accounts} accounts)`);
  try { writeFileSync(join(EVIDENCE, 'shop-role-levels.json'), `${JSON.stringify(evidence, null, 2)}\n`); } catch { /* evidence is best effort */ }
  await browser?.close().catch((e) => console.warn(redact(`browser teardown: ${e.message}`)));
  await stopEntry();
  await stopped(entry2).catch((e) => console.warn(redact(`second entry teardown: ${e.message}`)));
  entry2 = null;
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
  const put = await directSet(direct, 'sales_staff', 'view');
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
  // held — it may have committed — and the server's level read back; AM6: any 403 other than step_up_required is the
  // owner-only refusal)]
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
    ['a wrong Host', async (rec, out) => { if (isPut(rec)) out.host = 'admin.tmpos.test'; }, 404, SAY.notConfirmed('create')],
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
    if (label === 'the session ended in the store') {
      // M7A-CUSTOMERS-P6: the session this page confirmed is gone, and no save signs in on its own — the owner presses
      // Reconnect: exactly one login, and the panel is ready again with the draft kept.
      const reconnect = st.api.length;
      await page.click('[data-testid="server-levels-retry"]');
      await page.waitFor(`!document.querySelector('[data-testid="server-levels-retry"]') && document.querySelector('[data-testid="server-levels-state"]')?.textContent.trim() === 'Ready'`, 30_000, 'the panel reconnected');
      assert.deepEqual(st.api.slice(reconnect).filter((r) => r.path === LOGIN).map(answered), ['200'], 'the Reconnect: exactly one login');
    }
  }
  // The 404 left the key HELD (it may have committed), so the next two saves re-send that key: a refusal of it, or a
  // save that never reaches the server, does not say what it did — "Not confirmed yet", never "Not saved" (R2-2).
  // M7A-CUSTOMERS-P6: revoking the grant ends the owner's session in the store, and Save no longer signs in on its own:
  // the held key is NOT re-sent (no login, no PUT) and the row says "Not confirmed yet", with Reconnect offered.
  {
    const before = await counts();
    await owner`update user_membership set role_id = 'technician' where internal_user_id = ${boss.id}`;
    const from = st.api.length;
    const status = await save(page, 'sales_staff');
    await owner`update user_membership set role_id = 'store_owner' where internal_user_id = ${boss.id}`;
    note('the owner grant revoked', status);
    assert.equal(status, SAY.confirmEnded);
    assert.deepEqual(st.api.slice(from).filter((r) => isPut(r) || r.path === LOGIN).map(apiLine), [], 'the save sent no login and no PUT');
    await assertDelta(before, NOTHING, 'the owner grant revoked');
    // The grant back, Reconnect logs in exactly once; the draft and the held key are kept for the read that follows.
    const reconnect = st.api.length;
    await page.click('[data-testid="server-levels-retry"]');
    await page.waitFor(`!document.querySelector('[data-testid="server-levels-retry"]') && document.querySelector('[data-testid="server-levels-state"]')?.textContent.trim() === 'Ready'`, 30_000, 'the panel reconnected');
    assert.deepEqual(st.api.slice(reconnect).filter((r) => r.path === LOGIN).map(answered), ['200'], 'the Reconnect: exactly one login');
    // A refusal of the held key (here a foreign Origin, 403) does not say what the key did: "Not confirmed yet" (R2-2).
    const refused = st.api.length;
    st.tamper = async (rec, out) => { if (isPut(rec)) out.origin = ADMIN; };
    const again = await save(page, 'sales_staff');
    st.tamper = null;
    note('the held key refused', again);
    assert.equal(again, SAY.confirmDenied);
    assert.deepEqual(st.api.slice(refused).filter(isPut).map((r) => r.status), [403], 'the server refused the held key\'s PUT');
    await assertDelta(before, NOTHING, 'the held key refused');
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
    assert.equal(status, SAY.confirmUnreachable);
    assert.deepEqual(st.api.slice(from).map((r) => r.status), [502], 'the one request made was answered by the front alone');
    await assertDelta(before, NOTHING, 'the tenant server down');
  }
  const before = await counts();
  const status = await save(page, 'sales_staff');
  note('recovered', status);
  assert.ok(saved(status), status);
  await assertDelta(before, EDIT, 'the save after every failure');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'view');
  // M7A-CUSTOMERS-P6: a Reconnect pressed while the grant is revoked logs in once and shows what that account may see —
  // the owner-only Denied state, no save control — and writes nothing.
  {
    await draft(page, 'sales_staff', 'create');
    const revoked = await counts();
    await owner`update user_membership set role_id = 'technician' where internal_user_id = ${boss.id}`;
    try {
      const from = st.api.length;
      const ended = await save(page, 'sales_staff');
      note('revoked, then saved', ended);
      assert.equal(ended, SAY.signedOut);
      assert.deepEqual(st.api.slice(from).filter((r) => isPut(r) || r.path === LOGIN).map(apiLine), [], 'the save sent no login and no PUT');
      const reconnect = st.api.length;
      await page.click('[data-testid="server-levels-retry"]');
      await waitState(page, 'Denied');
      assert.deepEqual(st.api.slice(reconnect).filter((r) => r.path === LOGIN).map(answered), ['200'], 'the Reconnect: exactly one login');
      assert.deepEqual(st.api.slice(reconnect).filter(isPut).map(apiLine), [], 'the Reconnect sent no PUT');
      assert.match(await page.evaluate(`document.querySelector('[data-testid="server-customer-levels"]').textContent`), /only be viewed and changed by the store owner/);
      assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid^="server-level-save-"]').length`), 0, 'no save control for a revoked owner');
      await assertDelta(revoked, NOTHING, 'the Reconnect while revoked');
      assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'nothing stored');
    } finally {
      await owner`update user_membership set role_id = 'store_owner' where internal_user_id = ${boss.id}`;
    }
  }
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
  // Well-formed bodies (the manager's own tenant and version 0 asserted), so the owner rule is what refuses them.
  const put = (roleId, domain, level, extra = {}) => call('PUT', ROLE_LEVELS, {
    session: direct, body: { roleId, domain, level, reason: REASON, expectedTenant: tenant, expectedVersion: 0, ...extra }, key: randomUUID(),
  });
  const narrow = await put('sales_staff', 'customers', 'view');
  const self = await put('manager', 'customers', 'full');
  // The self-grant in other shapes: another domain (where manage_role_permissions would live), Manage, and an extra
  // field naming the grant. Whether the body rule (400) or the owner rule (403) answers first, none may write.
  const variants = {
    'another domain': await put('manager', 'employees', 'full'),
    'Manage for manager': await put('manager', 'customers', 'manage'),
    'an extra field': await put('manager', 'customers', 'full', { permission: 'manage_role_permissions' }),
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
  assert.deepEqual(await rowOf(page, 'sales_staff'), { level: LABELS.create, badge: 'Default', known: true }, 'the server panel still shows the server\'s level');
  const rows = await page.evaluate(`[...document.querySelectorAll('[data-testid^="server-level-row-"]')].map((r) => r.dataset.testid.slice('server-level-row-'.length))`);
  assert.deepEqual(rows, ['store_owner', 'manager', 'technician', 'sales_staff'], 'the server panel lists the built-in roles only, never the custom role');
  const saves = await page.evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /save/i.test(t))`);
  note('save buttons', saves);
  assert.ok(saves.every((t) => t === 'Save to server'), `the only save controls are the per-role server saves: ${saves.join(', ')}`);
});

/**
 * Two editors read one role at the same version (Create, the default: version 0). `one` narrows it to View; `two`'s older,
 * permissive draft (Edit) is then refused by the version precondition — nothing written, no edit audit, View and its
 * authority stand — and shown as a conflict; only an explicit Reapply and a new Save (the new version, a new key) land it.
 * `two` is on the second tenant entry; a sales_staff session's create and read answer every committed level.
 */
async function staleDraftRefused(tenant, one, two, staffSession, where) {
  await waitRow(one, 'sales_staff', 'create', 'Default');
  await waitRow(two, 'sales_staff', 'create', 'Default');
  await assertAuthority(staffSession, 'create', 'the default');
  await draft(one, 'sales_staff', 'view');
  let before = await counts();
  const first = note(`first ${where}`, await save(one, 'sales_staff'));
  assert.ok(saved(first), first);
  await assertDelta(before, EDIT, `the first ${where}'s View`);
  await assertAuthority(staffSession, 'view', `the first ${where}'s View`);

  await draft(two, 'sales_staff', 'edit'); // against what `two` read: Create at version 0
  before = await counts();
  const stale = note(`second ${where}`, await save(two, 'sales_staff'));
  assert.equal(stale, SAY.lostRace('view'), `the stale ${where} is a conflict, never "Saved"`);
  await assertDelta(before, { ...REFUSED, L: 1 }, `the stale ${where}'s save wrote nothing but its lease`);
  assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'View stands: the older draft restored nothing');
  const puts = st.api.filter(isPut);
  assert.deepEqual(puts.map((r) => `entry${r.via} ${answered(r)}`), ['entry1 200', 'entry2 409 write_conflict'], `the stale save was refused on the other entry: ${st.api.map(apiLine).join('; ')}`);
  const staleBody = JSON.parse(puts[1].body);
  assert.deepEqual([staleBody.level, staleBody.expectedTenant, staleBody.expectedVersion], ['edit', tenant, 0], 'it asserted the version it was drafted at');
  await assertAuthority(staffSession, 'view', `View after the stale ${where}`);
  // The conflict: the server's level and the unsaved choice; Save stays off until Discard or Reapply.
  await waitRow(two, 'sales_staff', 'view', 'Custom');
  assert.equal(await conflictOf(two, 'sales_staff'), 'The server now has View Only. Your unsaved choice: Edit.');
  assert.equal(await saveEnabled(two, 'sales_staff'), false, 'no Save while the conflict stands');
  assert.equal(await two.evaluate(`!!document.querySelector('[data-testid="server-level-discard-sales_staff"]')`), true, 'Discard is offered');

  await two.click('[data-testid="server-level-reapply-sales_staff"]');
  await two.waitFor(async () => (await statusOf(two, 'sales_staff')) === SAY.reapplied, 10_000, 'the draft reapplied to the version just read');
  assert.equal(await conflictOf(two, 'sales_staff'), null, 'the conflict is resolved by the choice');
  assert.equal(st.api.filter(isPut).length, 2, 'Reapply sends nothing');
  before = await counts();
  const again = note(`second ${where} after Reapply`, await save(two, 'sales_staff'));
  assert.ok(saved(again), again);
  await assertDelta(before, EDIT, `the deliberate save after Reapply`);
  const last = st.api.filter(isPut).at(-1);
  assert.equal(answered(last), '200');
  assert.equal(JSON.parse(last.body).expectedVersion, 1, 'asserting the version it was reapplied to');
  assert.notEqual(last.headers['idempotency-key'], puts[1].headers['idempotency-key'], 'under a new key');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'edit');
  await assertAuthority(staffSession, 'edit', `the second ${where}'s Edit`);
}

scenario('SRL-08', 'two browsers on two tenant entries read one role at one version: the first narrows it; the second\'s older, permissive draft is refused (409, nothing written, View and its authority stand) and shown as a conflict; Reapply and a new Save land it; the first browser\'s "Saved" then says "Changed elsewhere"', async () => {
  const { tenant, boss } = await shop('s8');
  const staff = await actor('s8-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const one = await ownerPanel(boss);
  const two = await ownerPanel(boss, viaSecond(await openPage()));
  await staleDraftRefused(tenant, one, two, staffSession, 'browser');
  // AM2: the second browser's save — seen by the first browser's next refresh — ends the first one's "Saved".
  await one.evaluate(`dispatchEvent(new Event('focus'))`);
  await one.waitFor(async () => (await statusOf(one, 'sales_staff')) === SAY.changedElsewhere('edit'), 20_000, 'the former "Saved" says the level changed elsewhere');
  await waitRow(one, 'sales_staff', 'edit', 'Custom');
});

scenario('SRL-08T', 'two TABS of one browser (one cookie jar, one sign-in), each on its own tenant entry: the stale tab\'s older draft is refused and shown as a conflict, and only Reapply and a new Save land it', async () => {
  const { tenant, boss } = await shop('s8t');
  const staff = await actor('s8t-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const one = await ownerPanel(boss);
  const two = viaSecond(await sameContextTab(one));
  await two.goto(`${SHOP}/employees`, 30_000); // signed in already: the tabs share the browser's persisted sign-in
  await openPermissions(two);
  await waitState(two, 'Ready');
  await staleDraftRefused(tenant, one, two, staffSession, 'tab');
});

scenario('SRL-10', 'TENANT SWITCH BEFORE THE SAVE — a draft made in tenant A, saved after the same owner\'s session moved to tenant B, writes nothing in A or B (no level, version, edit audit or completion); the shop says the store changed and the change was not saved', async () => {
  const a = await shop('s10a');
  const b = await newTenant('s10b');
  const page = await ownerPanel(a.boss);
  await waitRow(page, 'sales_staff', 'create', 'Default');
  await draft(page, 'sales_staff', 'view');
  const aLogin = st.api.filter(acceptedLogin(a.boss)).at(-1);
  assert.ok(aLogin, 'the page holds a tenant-A session');
  await moveOwner(a.boss, a.tenant, b);
  assert.equal((await readWith(aLogin.cookie)).status, 401, 'the switch ended the tenant-A session');
  const was = { a: await tenantState(a.tenant), b: await tenantState(b) };
  const before = await counts();
  // M7A-CUSTOMERS-P6: the move ended the session this page confirmed, so the save signs nothing in and sends nothing.
  const from = st.api.length;
  const first = await save(page, 'sales_staff');
  note('the save after the switch', first);
  assert.equal(first, SAY.signedOut, 'the save found the session ended');
  assert.deepEqual(st.api.slice(from).filter((r) => isPut(r) || r.path === LOGIN).map(apiLine), [], 'no login and no PUT left the page');
  // Reconnect: one login — now scoped to B — whose read names another store: the draft is cleared, the store-changed notice shown.
  const reconnect = st.api.length;
  await page.click('[data-testid="server-levels-retry"]');
  await page.waitFor(async () => (await noticesOf(page)).changed === STORE_CHANGED, 30_000, 'the store-changed notice');
  await waitState(page, 'Ready');
  await waitRow(page, 'sales_staff', 'create', 'Default');
  await page.waitFor(() => st.api.slice(from).every((r) => r.status !== null), 10_000, 'every request answered');
  const sent = note('requests', st.api.slice(from).map(apiLine));
  assert.deepEqual(st.api.slice(from).filter(isPut).map(answered), [], `no PUT at all, to either store: ${sent.join('; ')}`);
  assert.deepEqual((await noticesOf(page)).previous, [], 'no change was sent, so there is no previous-store notice');
  assert.equal(st.api.slice(reconnect).filter(acceptedLogin(a.boss)).length, 1, 'exactly one login: the Reconnect (scoped to B)');
  assert.deepEqual(st.api.slice(from, reconnect).filter(acceptedLogin(a.boss)), [], 'none before it');
  await assertDelta(before, NOTHING, 'the A draft after the switch: nothing written (T: the Reconnect\'s login)');
  assert.deepEqual({ a: await tenantState(a.tenant), b: await tenantState(b) }, was, 'neither A nor B changed: no level, version or edit audit');
  assert.equal(await statusOf(page, 'sales_staff'), '', 'B\'s row says nothing of A\'s draft');
  assert.equal(await hasDraft(page, 'sales_staff'), false, 'no draft survives the switch');
  await assertNoLeak(page);
});

scenario('SRL-11', 'IN FLIGHT ACROSS A SWITCH — a save parked INSIDE the database (its role row held FOR UPDATE by a side transaction) while the same owner\'s session moves to B: B is untouched, A holds whatever the server decided, and the panel (now B\'s) reports it only as a detached notice, never as B\'s save', async () => {
  const a = await shop('s11a');
  const b = await newTenant('s11b');
  const page = await ownerPanel(a.boss);
  await waitRow(page, 'sales_staff', 'create', 'Default');
  await draft(page, 'sales_staff', 'view');
  // The row the PUT locks (set_v2 step 8), made now so it can be held: 020's NULL lock row — still the catalog default at
  // version 0, so the draft read before it stays current.
  await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (${a.tenant}, 'sales_staff', 'customers', null, now()) on conflict do nothing`;
  const wasA = await tenantState(a.tenant);
  const wasB = await tenantState(b);
  const before = await counts();
  // LOCK ORDERING (why this cannot deadlock). The side transaction holds ONLY A's sales_staff role row and waits on
  // nothing. set_v2 takes the standing hold (016), the session and mint rows and the issuer FOR SHARE and checks the
  // grant BEFORE step 8, then waits on that row. The switch — moveOwner's grant swap (015's standing-serialize triggers)
  // and the other tab's login (its establish takes the standing hold; it may replace the shared cookie's session row) —
  // can wait only on what set_v2 holds, never on the side transaction: a chain (switch → set_v2 → side), no cycle. So the
  // switch is never awaited while parked: it runs alongside, and the park is released once the switch has either
  // finished or is itself waiting on the parked PUT. set_v2 then finishes and commits; its answer is held at the front
  // until the switch has finished, so the page's read-back runs on the B session. Should the database still find a
  // cycle, it aborts one side and a bounded wait below fails the case — it never hangs. The owner pool (3) covers the
  // side transaction, the grant swap and the polling at once.
  let unpark;
  const parkedUntil = new Promise((r) => { unpark = r; });
  st.releases.push(unpark);
  let holds;
  const holding = new Promise((r) => { holds = r; });
  const side = owner.begin(async (tx) => {
    const [{ pid }] = await tx`select pg_catalog.pg_backend_pid() as pid`;
    await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${a.tenant} and role_id = 'sales_staff' and domain = 'customers' for update`;
    holds(pid);
    await Promise.race([parkedUntil, delay(90_000)]); // a bound, never a result
  });
  const sidePid = await Promise.race([holding, side.then(() => { throw new Error('the side transaction ended before it held the row'); })]);
  const answer = gate((r) => isPut(r) && r.frameId === page.frameId, 'response');
  // Every status line the page renders from here on, recorded in the page as it changes (a node's old text included), so
  // a transient "Saved" cannot slip between two polls.
  await page.evaluate(`(() => {
    const lines = window.__srlStatusLines = [];
    const isStatus = (node) => node?.closest?.('[data-testid^="server-level-status-"]') ?? node?.parentElement?.closest('[data-testid^="server-level-status-"]');
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData' && isStatus(r.target) && r.oldValue) lines.push(r.oldValue.trim());
        if (r.type === 'childList' && isStatus(r.target)) for (const gone of r.removedNodes) lines.push((gone.textContent ?? '').trim());
      }
      for (const el of document.querySelectorAll('[data-testid^="server-level-status-"]')) lines.push(el.textContent.trim());
    }).observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true });
  })()`);
  const from = await clickSave(page, 'sales_staff');
  const parked = await until(async () => (await blockedBy(sidePid)).find((r) => r.usename === RUNTIME_LOGIN), 20_000, 'the PUT waiting on the held role row');
  note('parked', { wait: parked.wait_event_type, query: parked.query });
  assert.match(parked.query, /m7a_role_level_set_v2|<insufficient privilege>/, 'the waiting statement is the versioned edit');
  assert.equal(st.api.slice(from).filter(isPut).length, 1, 'one PUT, in the database');
  // The switch while parked: the grant moves, and another tab of this browser signs the same account in again (on the
  // second entry), so the shared cookie jar will hold the B session.
  let switched = false;
  const switching = (async () => {
    await moveOwner(a.boss, a.tenant, b);
    const tab = viaSecond(await sameContextTab(page));
    await tab.goto(`${SHOP}/employees`, 30_000);
    await openPermissions(tab);
    await waitState(tab, 'Ready', 60_000);
  })().finally(() => { switched = true; });
  switching.catch(() => {}); // awaited below; a failure there fails the case
  const waitingOnPark = async () => [...await blockedBy(parked.pid), ...(await blockedBy(sidePid)).filter((r) => r.pid !== parked.pid)];
  const during = await until(async () => (switched ? 'finished while parked' : (await waitingOnPark()).length > 0 ? 'waiting on the parked PUT' : null), 60_000, 'the switch finished or waits on the parked PUT');
  note('the switch while the PUT was parked', during);
  unpark(); // commit the side transaction (it wrote nothing): set_v2 goes on
  await side;
  const put = await Promise.race([answer.reached, delay(30_000).then(() => null)]);
  assert.ok(put, 'the PUT was answered once released; its answer is held at the front');
  await Promise.race([switching, delay(90_000).then(() => { throw new Error('the switch did not finish after the release'); })]);
  const decided = note('the server decided', answered(put));
  answer.release();
  // The page's outcome. A refusal of this first attempt (400/401/403/413/422) reads nothing back: the row's own
  // "Not saved" line. Every other answer is read back on the B session, so it surfaces only as a detached notice: a 200
  // as the acknowledgement, a write_conflict as not saved, anything undecided (a 5xx, a 409 in progress, a body the
  // page cannot name) as unconfirmed.
  const refusal = /^(400|401|403|413|422)\b/.test(decided);
  const notice = decided === '200' ? PREVIOUS_STORE.acknowledged
    : decided === '409 write_conflict' ? PREVIOUS_STORE.notSaved : PREVIOUS_STORE.unconfirmed;
  await page.waitFor(async () => {
    const n = await noticesOf(page);
    return refusal ? /^Not saved/.test((await statusOf(page, 'sales_staff')) ?? '') : n.changed === STORE_CHANGED && n.previous.length > 0;
  }, 30_000, 'the A outcome surfaced');
  await page.waitFor(() => st.api.slice(from).every((r) => r.status !== null), 10_000, 'every request answered');
  note('requests', st.api.map(apiLine));
  const lines = note('status lines seen', [...new Set(await page.evaluate('window.__srlStatusLines'))]);
  assert.ok(!lines.some((t) => /^Saved\b/.test(t)), `the page never said Saved: ${lines.join(' | ')}`);
  if (!refusal) assert.deepEqual((await noticesOf(page)).previous, [notice], `the A answer (${decided}), only as a detached notice`);
  assert.deepEqual(st.api.filter(isPut).map(answered), [decided], 'one PUT: nothing was retried or sent to B');
  assert.deepEqual(await tenantState(b), wasB, 'B is untouched: no level, version or edit audit');
  if (decided === '200') {
    await waitState(page, 'Ready');
    await waitRow(page, 'sales_staff', 'create', 'Default'); // B's level: never A's save
    assert.equal(await statusOf(page, 'sales_staff'), '', 'B\'s row says nothing of A\'s save');
    assert.equal(await hasDraft(page, 'sales_staff'), false);
    await assertDelta(before, { C: 0, A: 0, E: 1, K: 1, L: 1 }, 'the one edit (T: the other tab\'s login)');
    assert.deepEqual(await tenantState(a.tenant), { edits: wasA.edits + 1, levels: { sales_staff: 'view' }, versions: { sales_staff: 1 } }, 'A holds the edit');
  } else {
    await assertDelta(before, { C: 0, A: 0, E: 0, K: 0 }, `refused (${decided}): no edit`);
    assert.deepEqual(await tenantState(a.tenant), wasA, `refused (${decided}): A unchanged`);
  }
});

scenario('SRL-12', 'RESET TO THE DEFAULT, THEN AN OLDER DRAFT — View, then Create restored (the default level at a newer version): a draft made at the first version is refused though the level it saw is back; Discard drops it; authority follows each committed level', async () => {
  const { tenant, boss } = await shop('s12');
  const staff = await actor('s12-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const one = await ownerPanel(boss);
  const two = await ownerPanel(boss, viaSecond(await openPage()));
  await waitRow(two, 'sales_staff', 'create', 'Default');
  await assertAuthority(staffSession, 'create', 'the default');
  await draft(two, 'sales_staff', 'edit'); // against version 0
  for (const level of ['view', 'create']) {
    await draft(one, 'sales_staff', level);
    const status = note(`first browser ${level}`, await save(one, 'sales_staff'));
    assert.ok(saved(status), status);
    await assertAuthority(staffSession, level, `after ${level}`);
  }
  await waitRow(one, 'sales_staff', 'create', 'Custom');
  assert.deepEqual(await tenantState(tenant), { edits: 2, levels: { sales_staff: 'create' }, versions: { sales_staff: 2 } }, 'Create restored at version 2');
  assert.deepEqual(await rowOf(two, 'sales_staff'), { level: LABELS.create, badge: 'Default', known: true }, 'the older browser still shows the level it read');
  const before = await counts();
  const stale = note('older draft', await save(two, 'sales_staff'));
  assert.equal(stale, SAY.lostRace('create'), 'refused, though the level it read is back');
  await assertDelta(before, { ...REFUSED, L: 1 }, 'the older draft wrote nothing but its lease');
  const last = st.api.filter(isPut).at(-1);
  assert.equal(`entry${last.via} ${answered(last)}`, 'entry2 409 write_conflict');
  assert.equal(JSON.parse(last.body).expectedVersion, 0);
  assert.deepEqual(await tenantState(tenant), { edits: 2, levels: { sales_staff: 'create' }, versions: { sales_staff: 2 } }, 'unchanged');
  await assertAuthority(staffSession, 'create', 'after the refused older draft');
  assert.equal(await conflictOf(two, 'sales_staff'), 'The server now has Create. Your unsaved choice: Edit.');
  await two.click('[data-testid="server-level-discard-sales_staff"]');
  await two.waitFor(async () => (await conflictOf(two, 'sales_staff')) === null && !(await hasDraft(two, 'sales_staff')), 10_000, 'Discard dropped the draft');
  assert.equal(await statusOf(two, 'sales_staff'), '');
  await waitRow(two, 'sales_staff', 'create', 'Custom');
  assert.equal(await saveEnabled(two, 'sales_staff'), false, 'nothing left to save');
  assert.equal(st.api.filter(isPut).length, 3, 'Discard sends nothing');
});

scenario('SRL-09', 'a user switch in one browser ends the previous user\'s tenant session before the next user\'s login leaves the page, and signing out ends the next one\'s (AM4)', async () => {
  const a = await shop('s9a');
  const b = await shop('s9b');
  // The two stores' panels differ: A's sales_staff is stored View, B's is the default Create.
  const direct = await directLogin(a.boss);
  const put = await directSet(direct, 'sales_staff', 'view');
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

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P5 — the Customer directory page, by the test ids of the stage design (section 10)
// ---------------------------------------------------------------------------------------------------------------------

const DIRECTORY = '/customers/directory';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** One create: its customer, its audit record, its sealed completion, its one idempotency record, no role edit. */
const CREATED = Object.freeze({ C: 1, A: 1, E: 0, K: 1, L: 1 });
const by = (id) => `[data-testid="${id}"]`;
const q = (id) => `document.querySelector(${JSON.stringify(by(id))})`;
const has = (page, id) => page.evaluate(`!!${q(id)}`);
const textOf = (page, id) => page.evaluate(`${q(id)}?.textContent.trim() ?? null`);
/** A control that is there and enabled. */
const offered = (page, id) => page.evaluate(`${q(id)} !== null && ${q(id)}.disabled !== true`);
const waitData = (page, id, key, value, timeout = 30_000) =>
  page.waitFor(`${q(id)}?.dataset.${key} === ${JSON.stringify(value)}`, timeout, `${id} has data-${key}="${value}"`);
const waitList = (page, phase = 'ready') => waitData(page, 'directory-state', 'phase', phase);
/** The rows the list shows, in the order shown: [{ id, name }]. */
const rowsOf = (page) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(by('directory-row'))})].map((li) => ({ id: li.dataset.id ?? null, name: li.querySelector('a')?.textContent.trim() ?? null }))`);
async function waitRows(page, expected, label) {
  let seen;
  await page.waitFor(async () => { seen = await rowsOf(page); return JSON.stringify(seen) === JSON.stringify(expected); }, 30_000, label)
    .catch((e) => { throw new Error(`${e.message}; rows shown: ${JSON.stringify(seen)?.slice(0, 600)}`); });
}

const isCreate = (r) => r.method === 'POST' && r.path === CUSTOMERS;
const isList = (r) => r.method === 'GET' && r.path === CUSTOMERS;
const isDetail = (r) => r.method === 'GET' && r.path.startsWith(`${CUSTOMERS}/`);
/** The API requests a page (or tab) made that `match`, from record index `from`. */
const sentBy = (page, match, from = 0) => st.api.slice(from).filter((r) => r.frameId === page.frameId && match(r));
const quiet = (page, from) => page.waitFor(() => st.api.slice(from).every((r) => r.status !== null), 20_000, 'every request answered');

/** In-app navigation (no page load, so no new tenant login). */
const go = (page, path) => page.evaluate(`history.pushState({}, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate'))`);
async function openDirectory(page, path = DIRECTORY) {
  await go(page, path);
  await page.waitFor(`!!${q('customer-directory')}`, 30_000, 'the Customer directory page');
}
/** A new browser: signs in and opens the directory in the app — ONE tenant login (the page's first connect). */
async function directoryPage(who) {
  const page = await openPage();
  await signIn(page, who);
  await openDirectory(page);
  await waitList(page);
  return page;
}
/** The sidebar's "Customer Directory" link, clicked; false when the build has no such entry (the entry commit's). */
async function openBySidebar(page) {
  const link = `[...document.querySelectorAll('a[href="${DIRECTORY}"]')].find((a) => a.textContent.trim().endsWith('Customer Directory'))`;
  if (!(await page.waitFor(`!!${link}`, 15_000, 'the Customer Directory sidebar link').catch(() => false))) return false;
  await page.evaluate(`${link}.setAttribute('data-p5', 'directory-link')`);
  await page.click('[data-p5="directory-link"]');
  await page.waitFor(`location.pathname === '${DIRECTORY}' && !!${q('customer-directory')}`, 30_000, 'the Customer directory page');
  return true;
}
/** Type a name and press "Add customer"; answers the API record count at the click. */
async function addCustomer(page, name) {
  await page.fill(by('directory-name'), name);
  await page.waitFor(() => offered(page, 'directory-add'), 15_000, 'Add customer is enabled');
  const from = st.api.length;
  await page.click(by('directory-add'));
  return from;
}

/** One tenant's customers as the database owner reads them, in the server's page order (017: name in byte order, then id). */
async function customersOf(tenant) {
  const rows = await owner`select customer_id as id, name from tmpos_customer.customer where tenant_id = ${tenant} order by name collate "C", customer_id`;
  return Array.from(rows, (r) => ({ id: r.id, name: r.name }));
}
const named = async (tenant, name) => (await customersOf(tenant)).filter((c) => c.name === name);
/** Rows put in a tenant by the database owner (no session, audit or idempotency record): [{ id, name }] as given. */
async function seedCustomers(tenant, names) {
  const rows = names.map((name) => ({ customer_id: randomUUID(), tenant_id: tenant, name }));
  await owner`insert into tmpos_customer.customer ${owner(rows, 'customer_id', 'tenant_id', 'name')}`;
  return rows.map((r) => ({ id: r.customer_id, name: r.name }));
}

/**
 * Customers requests select nothing: the query is empty or one cursor, a POST body is exactly { name }, a GET has no body,
 * no header is named for a tenant, store, role or actor, and none of `values` (tenant ids, the accounts' ids) rides
 * anywhere in the path, query, headers or body.
 */
function assertNoSelector(records, values) {
  assert.ok(records.length > 0, 'customers requests were made');
  for (const r of records) {
    const line = apiLine(r);
    assert.match(r.query, /^(\?cursor=[A-Za-z0-9_-]{23})?$/, `only a cursor may ride the query: ${line}`);
    assert.deepEqual(Object.keys(r.headers).filter((h) => /tenant|store|role|actor/i.test(h)), [], `no selecting header: ${line}`);
    if (r.method === 'POST') assert.deepEqual(Object.keys(JSON.parse(r.body)), ['name'], `the body is exactly { name }: ${line}`);
    else assert.equal(r.body, '', `a read carries no body: ${line}`);
    const wire = `${r.path}${r.query}\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n${r.body}`;
    for (const value of values) assert.ok(!wire.includes(String(value)), `a tenant or account id rides a request: ${line}`);
  }
}

scenario('SCB-01', 'ENTRY WITNESS — an owner opens the Customer directory from the sidebar and adds a customer: ONE POST from the page commits (201; one customer, one create audit, one completion); the row survives a reload, a second account\'s browser shows it, and its detail opens by click and by direct URL; no request names a tenant, store, role or actor', async () => {
  const { tenant, boss } = await shop('c1');
  const manager = await actor('c1-manager', [grant(tenant, 'manager')], { role: 'manager' });
  const name = `M7SCB c1 ${SUFFIX}`;
  const page = await openPage();
  await signIn(page, boss);
  const ui = await openBySidebar(page);
  note('ui', ui ? 'customer directory' : 'no Customer Directory entry (the entry build)');
  const before = await counts();
  let empty = null;
  if (ui) {
    await waitList(page);
    empty = note('before the create', { text: await textOf(page, 'directory-empty'), rows: await rowsOf(page) });
    const from = await addCustomer(page, name);
    await page.waitFor(async () => sentBy(page, isCreate, from).some((r) => r.status !== null) && (await rowsOf(page)).some((r) => r.name === name), 30_000, 'the created row is shown')
      .catch((e) => note('the created row was not shown', e.message));
  } else {
    await delay(2_000); // whatever the page would send, it has sent
  }
  // Everything is observed first, so the entry run records the whole "before" picture, then judged: wire, then database.
  const posts = sentBy(page, isCreate);
  note('POST statuses', posts.map((r) => r.status));
  const stored = note('stored', await named(tenant, name));
  const made = note('create delta', await deltaSince(before));

  assert.deepEqual(posts.map((r) => r.status), [201], `the directory page sent exactly one POST ${CUSTOMERS}, answered 201 (API seen: ${st.api.map(apiLine).join('; ') || 'none'}; customers of that name in the tenant: ${stored.length})`);
  assert.equal(stored.length, 1, 'the tenant holds exactly one customer of that name');
  assert.deepEqual(made, { ...made, ...CREATED }, `one customer, one create audit, one sealed completion, no role edit ${JSON.stringify(made)}`);
  const [{ id }] = stored;
  const [post] = posts;
  assert.equal(post.body, JSON.stringify({ name }), 'the body is the name and nothing else');
  assert.match(post.headers['idempotency-key'] ?? '', UUID_V4_RE, 'under a fresh v4 key');
  assert.deepEqual(JSON.parse(post.replied.text), { customer: { id, name } }, 'the answer names the stored row');
  assert.equal(post.replied.headers.location, `${CUSTOMERS}/${id}`);
  assert.equal(post.replied.headers['idempotent-replayed'], undefined, 'a first answer, not a replay');
  assert.deepEqual(empty.rows, [], 'no row before the create');
  assert.ok(empty.text, 'the empty state said so after a list answer');
  await waitRows(page, [{ id, name }], 'the created row, once, under the id the server gave');
  assert.equal(await page.evaluate(`${q('directory-saved-link')}?.getAttribute('href') ?? null`), `${DIRECTORY}/${id}`, 'the saved notice links to the detail');

  await page.goto(`${SHOP}${DIRECTORY}`, 30_000); // a reload: a new page, a new tenant session, nothing kept but the sign-in
  await waitList(page);
  await waitRows(page, [{ id, name }], 'the row after a reload');

  const second = await directoryPage(manager); // a second browser, a second account of the same store
  await waitRows(second, [{ id, name }], 'the row in a second account\'s browser');
  await second.click(`${by('directory-row')}[data-id="${id}"] a`);
  await waitData(second, 'directory-detail', 'phase', 'ready');
  assert.equal(await second.evaluate('location.pathname'), `${DIRECTORY}/${id}`);
  assert.deepEqual([await textOf(second, 'directory-detail-id'), await textOf(second, 'directory-detail-name')], [id, name], 'the detail by click');
  const reads = sentBy(second, isDetail).map((r) => `${r.path} -> ${r.status}`);
  assert.ok(reads.length >= 1 && reads.every((line) => line === `${CUSTOMERS}/${id} -> 200`), `the detail came from its own read: ${reads.join('; ')}`);
  await second.click(by('directory-back'));
  await waitRows(second, [{ id, name }], 'the list is still there on the way back');

  await page.goto(`${SHOP}${DIRECTORY}/${id}`, 30_000); // the address itself, loaded cold
  await waitData(page, 'directory-detail', 'phase', 'ready');
  assert.deepEqual([await textOf(page, 'directory-detail-id'), await textOf(page, 'directory-detail-name')], [id, name], 'the detail by direct URL');

  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, boss.uid, boss.id, manager.uid, manager.id]);
  assert.equal((await named(tenant, name)).length, 1, 'still one: nothing re-sent the create');
  assert.equal(st.api.filter(isCreate).length, 1, 'one POST in the whole case');
  await assertNoLeak(page);
  await assertNoLeak(second);
});

scenario('SCB-02', 'ISOLATION — tenant B\'s owner opening tenant A\'s customer id, a well-formed unknown id and a malformed id sees the SAME not-found text (the malformed one without any request), and B\'s list holds B\'s customers only', async () => {
  const a = await shop('c2a');
  const b = await shop('c2b');
  const theirs = await seedCustomers(a.tenant, [`M7SCB c2 A one ${SUFFIX}`, `M7SCB c2 A two ${SUFFIX}`]);
  const [own] = await seedCustomers(b.tenant, [`M7SCB c2 B own ${SUFFIX}`]);
  const page = await directoryPage(b.boss);
  await waitRows(page, [own], 'B\'s list is exactly B\'s customer');
  // own (a real transition to ready) first, then the malformed id (no request may leave), then the two the server answers.
  const seen = {};
  for (const [label, id, phase] of [['own', own.id, 'ready'], ['malformed', 'not-a-customer-id', 'not-found'], ['foreign', theirs[0].id, 'not-found'], ['unknown', randomUUID(), 'not-found']]) {
    const from = st.api.length;
    await go(page, `${DIRECTORY}/${id}`);
    if (label === 'malformed') await delay(1_000); // whatever it would send, it has sent
    else await page.waitFor(() => sentBy(page, isDetail, from).some((r) => r.path === `${CUSTOMERS}/${id}` && r.status !== null), 20_000, `the ${label} id was read`);
    await page.settle();
    await waitData(page, 'directory-detail', 'phase', phase);
    seen[label] = {
      text: await textOf(page, phase === 'ready' ? 'directory-detail-name' : 'directory-not-found'),
      requests: sentBy(page, isDetail, from).map((r) => (r.path === `${CUSTOMERS}/${id}` ? `this id -> ${answered(r)}` : apiLine(r))),
      page: await textOf(page, 'customer-directory'),
    };
    note(label, { text: seen[label].text, requests: seen[label].requests });
  }
  assert.equal(seen.own.text, own.name, 'B\'s own customer opens');
  assert.ok(seen.unknown.text, 'a not-found text is shown');
  assert.equal(seen.foreign.text, seen.unknown.text, 'another tenant\'s customer reads exactly as one that does not exist');
  assert.equal(seen.malformed.text, seen.unknown.text, 'and as a malformed address');
  assert.deepEqual(seen.malformed.requests, [], `a malformed id sends no ${CUSTOMERS}/ request`);
  assert.ok(seen.foreign.requests.length >= 1 && seen.foreign.requests.every((line) => line.startsWith('this id -> 404')), `the server answered 404: ${seen.foreign.requests.join('; ')}`);
  assert.deepEqual([...new Set(seen.foreign.requests)], [...new Set(seen.unknown.requests)], 'the same answer on the wire for foreign and unknown');
  await go(page, DIRECTORY);
  await waitRows(page, [own], 'B\'s list, unchanged');
  const everything = [...Object.values(seen).map((s) => s.page), await textOf(page, 'customer-directory'), ...sentBy(page, () => true).map((r) => r.replied?.text ?? '')].join('\n');
  for (const c of theirs) assert.ok(!everything.includes(c.name), `A's customer "${c.name}" never reached B's page or its answers`);
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [a.tenant, b.tenant, b.boss.uid, b.boss.id]);
});

scenario('SCB-03', 'PAGING — 60 customers: the page shows the first 50, "Load more" the other 10, every id once, in the server\'s byte order, and never sends a limit', async () => {
  const { tenant, boss } = await shop('c3');
  // Byte order is not dictionary order (A B Z a b é), and two pairs share a name (the id breaks the tie).
  const names = Array.from({ length: 58 }, (_, i) => `${['b', 'A', 'a', 'B', 'é', 'Z'][i % 6]} M7SCB c3 ${SUFFIX} ${String(i).padStart(2, '0')}`);
  await seedCustomers(tenant, [...names, names[0], names[1]]);
  const expected = await customersOf(tenant);
  assert.equal(expected.length, 60);
  assert.notDeepEqual(expected.map((c) => c.name), expected.map((c) => c.name).sort((x, y) => x.localeCompare(y)), 'the server\'s order is not a dictionary sort: a re-sorting page would show');
  const page = await directoryPage(boss);
  await waitRows(page, expected.slice(0, 50), 'the first page: 50 rows in the server\'s order');
  await page.waitFor(() => offered(page, 'directory-load-more'), 15_000, 'Load more is offered');
  await page.click(by('directory-load-more'));
  await waitRows(page, expected, 'all 60 rows in the server\'s order');
  const shown = await rowsOf(page);
  assert.equal(new Set(shown.map((r) => r.id)).size, 60, 'every id once');
  assert.equal(await offered(page, 'directory-load-more'), false, 'nothing more to load');
  const lists = sentBy(page, isList);
  note('list requests', lists.map(apiLine));
  assert.deepEqual(lists.map((r) => r.status), [200, 200], 'two reads: page one and its continuation');
  assert.equal(lists[0].query, '', 'page one carries no limit and no cursor');
  assert.match(lists[1].query, /^\?cursor=[A-Za-z0-9_-]{23}$/, 'the continuation carries the cursor alone');
  const pages = lists.map((r) => JSON.parse(r.replied.text));
  assert.equal(lists[1].query, `?cursor=${pages[0].nextCursor}`, 'the cursor is the one the server gave, verbatim');
  assert.deepEqual(pages.map((p) => [p.customers.length, p.nextCursor === null]), [[50, false], [10, true]]);
  assert.deepEqual(shown, pages.flatMap((p) => p.customers), 'the rows are the answers, in arrival order');
  assertNoSelector(lists, [tenant, boss.uid, boss.id]);
});

scenario('SCB-04', 'PERMISSION NARROWED WHILE OPEN — a sales_staff page with Add available; the owner narrows Customers to View: Add is refused (403) with nothing written and the list still shown; narrowed to None, Refresh shows the denied state and no rows', async () => {
  const { tenant, boss } = await shop('c4');
  const staff = await actor('c4-staff', [grant(tenant, 'sales_staff')], { role: 'sales_staff' });
  const kept = await seedCustomers(tenant, [`M7SCB c4 kept ${SUFFIX}`]);
  const name = `M7SCB c4 refused ${SUFFIX}`;
  const ownerSession = await directLogin(boss);
  const page = await directoryPage(staff);
  await waitRows(page, kept, 'the staff page lists the store\'s customer');
  assert.equal(await has(page, 'directory-add'), true, 'Add is available to sales_staff (Create, the default)');

  const view = await directSet(ownerSession, 'sales_staff', 'view');
  assert.equal(view.status, 200, view.text);
  const before = await counts();
  const from = await addCustomer(page, name);
  await page.waitFor(() => sentBy(page, isCreate, from).some((r) => r.status !== null), 20_000, 'the create was answered');
  await page.waitFor(() => sentBy(page, isList, from).some((r) => r.status !== null), 20_000, 'the list was read again after the refusal');
  await quiet(page, from);
  await waitList(page);
  const said = note('after the refused create', { status: await textOf(page, 'directory-create-status'), draft: await page.evaluate(`${q('directory-name')}?.value ?? null`) });
  note('requests', st.api.slice(from).map(apiLine));
  assert.deepEqual(sentBy(page, isCreate, from).map(answered).map((s) => s.slice(0, 3)), ['403'], 'one POST, refused');
  // The authorizer refuses before the idempotency record is acquired: no lease row is left (L 0), as under SRL-01's View.
  await assertDelta(before, NOTHING, 'the refused create: no customer, no create audit, no completion, no lease');
  assert.deepEqual(await customersOf(tenant), kept, 'the tenant holds what it held');
  assert.match(said.status ?? '', /refused/i, 'the page says the server refused');
  assert.doesNotMatch(said.status ?? '', /\bsaved\b/i);
  assert.equal(await has(page, 'directory-saved'), false, 'no saved notice');
  assert.equal(await has(page, 'directory-hold'), false, 'a refusal is conclusive: nothing is held');
  assert.equal(said.draft, name, 'the draft is kept');
  assert.deepEqual(sentBy(page, isList, from).map((r) => r.status).slice(-1), [200], 'View still reads');
  await waitRows(page, kept, 'the list is still shown after its reload');

  const none = await directSet(ownerSession, 'sales_staff', 'none');
  assert.equal(none.status, 200, none.text);
  const refresh = st.api.length;
  await page.click(by('directory-refresh'));
  await waitList(page, 'denied');
  assert.deepEqual(sentBy(page, isList, refresh).map((r) => r.status), [403], 'None refuses the read');
  assert.deepEqual(await rowsOf(page), [], 'no rows under the denied state');
  assert.ok(!(await textOf(page, 'customer-directory')).includes(kept[0].name), 'nor the name anywhere on the page');
  assert.equal(await offered(page, 'directory-add'), false, 'and no Add');
  assert.equal(sentBy(page, isCreate).length, 1, 'one POST in the whole case');
});

scenario('SCB-05', 'LOST REPLY AFTER THE COMMIT — the POST commits but its answer never reaches the page: the unresolved card, never "saved"; "Check again" re-sends the SAME key and the byte-identical body, answered 201 as a replay; ONE customer of that name', async () => {
  const { tenant, boss } = await shop('c5');
  const name = `M7SCB c5 ${SUFFIX}`;
  const page = await directoryPage(boss);
  const before = await counts();
  let lost = 0;
  st.lose = (rec, phase) => phase === 'response' && isCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
  const from = await addCustomer(page, name);
  await waitData(page, 'directory-hold', 'state', 'unresolved');
  st.lose = null;
  const [first] = sentBy(page, isCreate, from);
  assert.deepEqual([first.status, first.lost], [201, 'response'], 'the create committed, and its answer was lost');
  await assertDelta(before, CREATED, 'the create whose answer was lost');
  const stored = await named(tenant, name);
  assert.equal(stored.length, 1);
  const card = note('card', await textOf(page, 'directory-hold'));
  assert.ok(card.includes(name), 'the card names what is not confirmed');
  assert.equal(await page.evaluate(`${q('directory-hold')}.dataset.detached`), 'false');
  assert.equal(await has(page, 'directory-saved'), false, 'never "saved" on an answer that did not arrive');
  assert.ok(!(await rowsOf(page)).some((r) => r.name === name), 'nor shown as a row');

  // The field is edited meanwhile: what is re-sent is the held attempt, never the field.
  await page.fill(by('directory-name'), ' edited since');
  const mid = await counts();
  await page.waitFor(() => offered(page, 'directory-check-again'), 15_000, 'Check again is offered');
  const again = st.api.length;
  await page.click(by('directory-check-again'));
  await page.waitFor(`!!${q('directory-saved')}`, 30_000, 'the saved notice');
  await quiet(page, again);
  const posts = sentBy(page, isCreate);
  note('creates', posts.map(apiLine));
  assert.equal(posts.length, 2, 'the first send and one check');
  const second = posts[1];
  assert.equal(second.headers['idempotency-key'], first.headers['idempotency-key'], 'the SAME Idempotency-Key');
  assert.match(first.headers['idempotency-key'] ?? '', UUID_V4_RE);
  assert.equal(second.body, first.body, 'the byte-identical body');
  assert.equal(first.body, JSON.stringify({ name }));
  assert.deepEqual([second.status, second.replied.headers['idempotent-replayed']], [201, 'true'], 'answered as a replay');
  assert.deepEqual(JSON.parse(second.replied.text), { customer: stored[0] }, 'the sealed answer: the row already stored');
  await assertDelta(mid, NOTHING, 'the replay wrote nothing');
  assert.deepEqual(await named(tenant, name), stored, 'exactly ONE customer of that name');
  assert.equal(await page.evaluate(`${q('directory-saved-link')}?.getAttribute('href') ?? null`), `${DIRECTORY}/${stored[0].id}`);
  await waitRows(page, stored, 'the list shows it once');
  assert.equal(await has(page, 'directory-hold'), false, 'the card is gone');
  await assertNoLeak(page);
});

scenario('SCB-06', 'HELD ATTEMPT, MOVED GRANT — a first send that never reached the server is held; the account\'s grant moves to tenant B: "Check again" notices the new connection, the attempt is detached, NO POST leaves under the new session, and neither tenant holds the name', async () => {
  const a = await shop('c6a');
  const b = await newTenant('c6b');
  const inA = await seedCustomers(a.tenant, [`M7SCB c6 A only ${SUFFIX}`]);
  const name = `M7SCB c6 held ${SUFFIX}`;
  const page = await directoryPage(a.boss);
  await waitRows(page, inA, 'the page shows tenant A');
  const before = await counts();
  // The dangerous case: the server never saw this key, so a re-send under ANY session would create afresh.
  st.lose = (rec, phase) => phase === 'request' && isCreate(rec) && rec.frameId === page.frameId;
  const from = await addCustomer(page, name);
  await waitData(page, 'directory-hold', 'state', 'unresolved');
  st.lose = null;
  const sent = sentBy(page, isCreate, from);
  assert.deepEqual(sent.map((r) => r.lost), ['request'], 'one POST left the page and never reached the server');
  await page.waitFor(() => offered(page, 'directory-check-again'), 15_000, 'Check again is offered while the connection is the attempt\'s');
  assert.equal(await page.evaluate(`${q('directory-hold')}.dataset.detached`), 'false');

  const aLogin = st.api.filter(acceptedLogin(a.boss)).at(-1);
  assert.ok(aLogin, 'the page holds a tenant-A session');
  await moveOwner(a.boss, a.tenant, b);
  assert.equal((await readWith(aLogin.cookie)).status, 401, 'the move ended the tenant-A session');
  const moved = st.api.length;
  await page.click(by('directory-check-again')); // the page's next action: it must check the connection before anything is sent
  // M7A-CUSTOMERS-P6: the move ended the session this page confirmed — "Check again" finds it ended and sends nothing:
  // no login and no POST; the card stays unresolved (no other connection exists yet) and the list offers Reconnect.
  await waitList(page, 'signed-out');
  await quiet(page, moved);
  assert.deepEqual(st.api.slice(moved).filter((r) => isLogin(r) || isCreate(r)).map(apiLine), [], 'no login and no POST on "Check again"');
  assert.equal(await page.evaluate(`${q('directory-hold')}.dataset.detached`), 'false', 'not detached before a new connection exists');
  assert.equal(await textOf(page, 'directory-retry'), 'Reconnect');
  const reconnect = st.api.length;
  await page.click(by('directory-retry'));
  await waitData(page, 'directory-hold', 'detached', 'true');
  await waitList(page);
  await waitRows(page, [], 'the list is now tenant B\'s: empty');
  await quiet(page, moved);
  await delay(1_000); // whatever it would still send, it has sent
  note('after the move', st.api.slice(moved).map(apiLine));
  const relogin = st.api.slice(moved).filter(acceptedLogin(a.boss));
  assert.equal(relogin.length, 1, 'the page signed in again once, on the Reconnect: the new session is tenant B\'s');
  assert.ok(st.api.indexOf(relogin[0]) >= reconnect, 'and only after the click');
  assert.deepEqual(st.api.slice(moved).filter(isCreate).map(apiLine), [], 'NO POST left under the new session');
  assert.equal(await offered(page, 'directory-check-again'), false, 'Check again is not offered for a detached attempt');
  assert.match((await textOf(page, 'directory-hold-detached')) ?? '', /earlier connection/, 'the card says why it cannot be checked from here');
  assert.equal(await has(page, 'directory-connection-changed'), true, 'the page says the store connection changed');
  assert.equal(await has(page, 'directory-saved'), false, 'nothing is called saved');
  assert.equal(await has(page, 'directory-empty'), true, 'tenant B\'s empty state, after its own list answer');
  assert.deepEqual(await named(b, name), [], 'tenant B holds no customer of that name');
  assert.deepEqual(await customersOf(b), [], 'nor any other');
  assert.deepEqual(await customersOf(a.tenant), inA, 'tenant A holds what it held');
  await assertDelta(before, NOTHING, 'nothing was written anywhere: no customer, audit, completion or lease');
  await assertNoLeak(page);
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P5-R1 — session reuse (DA-143) and read binding (DA-138)
// ---------------------------------------------------------------------------------------------------------------------

const isSessionRead = (r) => r.method === 'GET' && r.path === '/api/v1/session';
const isLogin = (r) => r.method === 'POST' && r.path === LOGIN;
const isCustomersRead = (r) => r.method === 'GET' && r.path.startsWith(CUSTOMERS);
const cookieValue = (pair) => pair.split('=').slice(1).join('=');
/** Numbers first: one JSON line per case in the evidence folder (labels, counts, statuses, booleans — no secrets). */
function record(id, data) {
  try { appendFileSync(join(EVIDENCE, 'scb-witness.jsonl'), `${JSON.stringify({ id, at: new Date().toISOString(), ...data })}\n`); } catch { /* best effort */ }
  return note('witness', data);
}

/** A principal's live tenant sessions, the mint rows beside them, and every mint row (for the ledger's growth). */
async function sessionRows(who) {
  const [r] = await owner`select
    (select count(*) from tmpos_session.session where audience = 'tenant' and auth_provider_uid = ${who.uid})::int as sessions,
    (select count(*) from tmpos_mint.tenant_session m join tmpos_session.session s using (session_key) where s.auth_provider_uid = ${who.uid})::int as mint_live,
    (select count(*) from tmpos_mint.tenant_session)::int as mint_all`;
  return r;
}

/** The list's settled phase after a load or reopen (never throws: 'timeout' is an observation too). */
function listSettled(page, from, timeout = 30_000) {
  return page.waitFor(async () => {
    const phase = await page.evaluate(`${q('directory-state')}?.dataset.phase ?? null`);
    if (phase === null || phase === 'loading') return null;
    if (phase === 'ready' && !sentBy(page, isList, from).some((r) => r.status !== null)) return null;
    return phase;
  }, timeout, 'the list settled').catch(() => 'timeout');
}

/** What one load (or reopen) of the directory did on the wire and showed. */
async function observeLoad(page, label, from, expected) {
  const phase = await listSettled(page, from);
  await quiet(page, from).catch(() => {});
  const mine = st.api.slice(from).filter((r) => r.frameId === page.frameId);
  const firstRead = mine.findIndex(isCustomersRead);
  const rows = await rowsOf(page);
  return {
    label, phase,
    logins: mine.filter(isLogin).map(answered),
    sessionReads: mine.filter(isSessionRead).map(answered),
    sessionReadBeforeCustomers: firstRead >= 0 && mine.slice(0, firstRead).some((r) => isSessionRead(r) && r.status !== null),
    customerReads: mine.filter(isCustomersRead).map(answered),
    status429: mine.filter((r) => r.status === 429).map((r) => `${r.method} ${r.path}`),
    rowsShown: JSON.stringify(rows) === JSON.stringify(expected),
    rowCount: rows.length,
  };
}

scenario('SCB-07', 'SESSION REUSE (DA-143) — inside one 5-minute window: first open, 6 reloads, an in-app reopen, one load showing both server consumers and a second tab; ONE login, one session row, one mint row, no 429, every load reads the session before any customer read and shows the rows', async () => {
  const { tenant, boss } = await shop('c7');
  await seedCustomers(tenant, [`M7SCB c7 one ${SUFFIX}`, `M7SCB c7 two ${SUFFIX}`, `M7SCB c7 three ${SUFFIX}`]);
  const expected = await customersOf(tenant);
  const dbBefore = await sessionRows(boss);
  const started = performance.now();
  const loads = [];
  const page = await openPage();
  await signIn(page, boss);
  await openDirectory(page);
  loads.push(await observeLoad(page, 'first open (sign-in, then in-app)', 0, expected));
  for (let i = 1; i <= 6; i++) {
    const from = st.api.length;
    await page.goto(`${SHOP}${DIRECTORY}`, 30_000);
    loads.push(await observeLoad(page, `reload ${i}`, from, expected));
  }
  {
    const from = st.api.length;
    await go(page, '/');
    await page.waitFor(`!${q('customer-directory')}`, 10_000, 'left the directory');
    const back = await openBySidebar(page);
    loads.push({ ...(await observeLoad(page, 'in-app reopen (away, back by the sidebar)', from, expected)), sidebar: back });
  }
  {
    const from = st.api.length;
    await page.goto(`${SHOP}${DIRECTORY}`, 30_000);
    const directory = await observeLoad(page, 'both consumers: directory', from, expected);
    await openPermissions(page);
    const panel = await page.waitFor(`(() => { const s = ${q('server-levels-state')}?.dataset.state; return s && s !== 'loading' ? s : null; })()`, 30_000, 'the server panel settled').catch(() => 'timeout');
    const mid = st.api.length;
    const back = await openBySidebar(page);
    const again = await observeLoad(page, 'both consumers: directory again', mid, expected);
    const whole = await observeLoad(page, 'both consumers (one load)', from, expected);
    loads.push({ ...whole, panel, sidebar: back, directoryFirst: directory.rowsShown, directoryAgain: again.rowsShown, rowsShown: directory.rowsShown && again.rowsShown });
  }
  {
    const tab = await sameContextTab(page);
    const from = st.api.length;
    await tab.goto(`${SHOP}${DIRECTORY}`, 30_000);
    await tab.waitFor(`!!${q('customer-directory')}`, 30_000, 'the directory in the second tab').catch(() => {});
    loads.push(await observeLoad(tab, 'second tab of the same browser', from, expected));
  }
  const elapsedSeconds = Math.round((performance.now() - started) / 1000);
  const logins = st.api.filter((r) => isLogin(r) && bearerUid(r) === boss.uid);
  const db = await sessionRows(boss);
  const numbers = record('SCB-07', {
    elapsedSeconds, loads,
    loginsTotal: logins.length, loginStatuses: logins.map(answered),
    firstLoginOnLoad: loads.findIndex((l) => l.logins.length > 0),
    status429: st.api.filter((r) => r.status === 429).map((r) => `${r.method} ${r.path}`),
    first429OnLoad: loads.findIndex((l) => l.status429.length > 0),
    sessionRowsLive: db.sessions, mintRowsLive: db.mint_live, mintRowsAdded: db.mint_all - dbBefore.mint_all,
  });

  assert.ok(elapsedSeconds < 300, `every load inside one 5-minute window: ${elapsedSeconds} s`);
  assert.equal(loads.length, 10, 'first open + 6 reloads + in-app reopen + both-consumer load + second tab');
  assert.deepEqual(numbers.loginStatuses, ['200'], `exactly ONE login for the whole case: ${loads.map((l) => `${l.label}: [${l.logins.join(', ')}]`).join('; ')}`);
  assert.deepEqual(numbers.status429, [], 'no 429 anywhere');
  assert.deepEqual([numbers.sessionRowsLive, numbers.mintRowsLive, numbers.mintRowsAdded], [1, 1, 1], 'one live session row, one mint row beside it, one mint row made');
  for (const l of loads) {
    assert.equal(l.phase, 'ready', `${l.label}: the list is ready`);
    assert.ok(l.rowsShown, `${l.label}: the rows are shown`);
    assert.ok(l.sessionReadBeforeCustomers, `${l.label}: GET /api/v1/session answered before any customer read (${l.sessionReads.join(', ')} / ${l.customerReads.join(', ')})`);
  }
  assert.equal(loads.find((l) => l.panel !== undefined).panel, 'ready', 'the Permissions server panel was ready in the same load');
  await assertNoLeak(page);
}, 360_000);

/** Whether page A's DOM holds any of tenant B's ids or names: { id, name } booleans (nothing else recorded). */
async function domHasB(page, bees) {
  const html = await page.evaluate('document.documentElement.outerHTML');
  return { id: bees.some((c) => html.includes(c.id)), name: bees.some((c) => html.includes(c.name)) };
}

/**
 * Park page A's next read that `match`es AFTER the page's session check was answered, swap the jar's tenant session cookie
 * to B's, release the read carrying B's cookie, and observe. Answers labels, statuses and booleans only.
 */
async function swapRead(page, { match, trigger, cookieName, aValues, bSession, bees }) {
  const from = st.api.length;
  const held = gate((r) => r.frameId === page.frameId && match(r), 'request');
  await trigger();
  const rec = await Promise.race([held.reached, delay(30_000).then(() => null)]);
  if (rec === null) return { reached: false, requests: st.api.slice(from).map(apiLine) };
  const mine = st.api.slice(from).filter((r) => r.frameId === page.frameId);
  const before = mine.slice(0, mine.indexOf(rec));
  const bValue = cookieValue(bSession.cookie);
  const label = (header) => {
    const v = (header ?? '').split(/;\s*/).find((p) => p.startsWith(`${cookieName}=`));
    if (v === undefined) return 'none';
    return aValues().has(cookieValue(v)) ? 'A' : cookieValue(v) === bValue ? 'B' : 'other';
  };
  const sent = label(rec.headers.cookie);
  await browser.send('Storage.setCookies', {
    browserContextId: page.contextId,
    cookies: [{ name: cookieName, value: bValue, url: `${SHOP}/`, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }],
  });
  let forwarded = null;
  st.tamper = async (r, out) => {
    if (r !== rec) return;
    const others = (out.cookie ?? '').split(/;\s*/).filter((p) => p !== '' && !p.startsWith(`${cookieName}=`));
    out.cookie = [...others, `${cookieName}=${bValue}`].join('; ');
    forwarded = label(out.cookie);
  };
  held.release();
  await page.waitFor(() => rec.status !== null, 30_000, 'the swapped read was answered');
  st.tamper = null;
  let swappedBody = null;
  try { swappedBody = JSON.parse(rec.replied?.text ?? ''); } catch { /* not JSON */ }
  const atRelease = await domHasB(page, bees);
  await page.waitFor(() => st.api.slice(from).every((r) => r.status !== null), 30_000, 'every request answered').catch(() => {});
  await delay(3_000); // whatever the page does next (a re-check, a new sign-in, a re-read), it has done
  await quiet(page, from).catch(() => {});
  await page.settle();
  const settled = await domHasB(page, bees);
  const after = st.api.slice(from).filter((r) => r.frameId === page.frameId && st.api.indexOf(r) > st.api.indexOf(rec));
  const delivered = st.api.slice(from).filter((r) => r.frameId === page.frameId && r.lost === undefined && typeof r.replied?.text === 'string');
  return {
    reached: true,
    sessionCheckBefore: before.filter((r) => isSessionRead(r) || isLogin(r)).map((r) => `${r.method} ${r.path} -> ${answered(r)}`),
    sentWith: sent, forwardedWith: forwarded,
    swapped: {
      status: rec.status, error: rec.error ?? null,
      customersKey: swappedBody !== null && (Object.hasOwn(swappedBody, 'customers') || Object.hasOwn(swappedBody, 'customer')),
      bIdsInAnswer: bees.filter((c) => rec.replied.text.includes(c.id)).length,
    },
    deliveredWithB: delivered.filter((r) => bees.some((c) => r.replied.text.includes(c.id))).map((r) => `${r.method} ${r.path === rec.path ? '(the swapped path)' : r.path} -> ${answered(r)}`),
    domAtRelease: atRelease, domSettled: settled,
    afterRelease: after.map((r) => `${r.method} ${r.path.startsWith(`${CUSTOMERS}/`) ? `${CUSTOMERS}/{id}` : r.path} -> ${answered(r)}`),
  };
}

scenario('SCB-08', 'READ BINDING (DA-138) — page A\'s list read and detail read, each parked after the session check and released with tenant B\'s session cookie: 403 with no customers, no B id ever reaches page A\'s answers or DOM, and the page ends on A\'s own rows and customer (a new A session)', async () => {
  const a = await shop('c8a');
  const b = await shop('c8b');
  await seedCustomers(a.tenant, [`M7SCB c8 A one ${SUFFIX}`, `M7SCB c8 A two ${SUFFIX}`, `M7SCB c8 A three ${SUFFIX}`]);
  const bees = await seedCustomers(b.tenant, [`M7SCB c8 B one ${SUFFIX}`, `M7SCB c8 B two ${SUFFIX}`, `M7SCB c8 B three ${SUFFIX}`]);
  const expectA = await customersOf(a.tenant);
  const page = await directoryPage(a.boss);
  await waitRows(page, expectA, 'page A shows tenant A\'s rows');
  const cookieName = st.api.filter(acceptedLogin(a.boss)).at(-1).cookie.split('=')[0];
  const aValues = () => new Set(st.api.filter(acceptedLogin(a.boss)).map((r) => cookieValue(r.cookie)));

  // The list: a Refresh (the page's session check, then the list read — parked).
  const list = await swapRead(page, {
    match: isList, trigger: () => page.click(by('directory-refresh')), cookieName, aValues, bSession: await directLogin(b.boss), bees,
  });
  const listRows = await rowsOf(page);
  list.end = {
    phase: await page.evaluate(`${q('directory-state')}?.dataset.phase ?? null`),
    rowsA: JSON.stringify(listRows) === JSON.stringify(expectA), rowsB: listRows.some((r) => bees.some((c) => c.id === r.id)), rowCount: listRows.length,
  };

  // The detail: a fresh B session, the jar emptied, one of A's customers opened by URL (a load: sign-in, then the reads).
  const target = expectA[0];
  const bSession = await directLogin(b.boss);
  await browser.send('Storage.clearCookies', { browserContextId: page.contextId });
  const detail = await swapRead(page, {
    match: (r) => isDetail(r) && r.path === `${CUSTOMERS}/${target.id}`, trigger: () => page.goto(`${SHOP}${DIRECTORY}/${target.id}`, 30_000), cookieName, aValues, bSession, bees,
  });
  detail.end = {
    phase: await page.evaluate(`${q('directory-detail')}?.dataset.phase ?? null`),
    showsA: (await textOf(page, 'directory-detail-id')) === target.id,
    showsB: (await domHasB(page, bees)).id,
  };
  record('SCB-08', { list, detail });

  for (const [label, r] of [['list', list], ['detail', detail]]) {
    assert.ok(r.reached, `${label}: the read was parked (${(r.requests ?? []).join('; ')})`);
    assert.ok(r.sessionCheckBefore.some((line) => line.endsWith(' -> 200')), `${label}: the page's session check was answered first: ${r.sessionCheckBefore.join('; ')}`);
    assert.deepEqual([r.sentWith, r.forwardedWith], ['A', 'B'], `${label}: sent with A's session, forwarded with B's`);
    assert.equal(r.swapped.status, 403, `${label}: the swapped read is refused`);
    assert.equal(r.swapped.customersKey, false, `${label}: the refusal carries no customers`);
    assert.equal(r.swapped.bIdsInAnswer, 0, `${label}: no B id in the refusal`);
    assert.deepEqual(r.deliveredWithB, [], `${label}: no answer delivered to page A holds a B id`);
    assert.deepEqual([r.domAtRelease, r.domSettled], [{ id: false, name: false }, { id: false, name: false }], `${label}: no B id or name ever in page A's DOM`);
  }
  // The page recovers as A: after the refused read it checks the session, finds B's, signs A in again and confirms it.
  const inOrder = (lines, wanted) => {
    let at = 0;
    for (const w of wanted) {
      at = lines.findIndex((l, i) => i >= at && l.startsWith(`${w} -> `)) + 1;
      if (at === 0) return false;
    }
    return true;
  };
  for (const [label, r] of [['list', list], ['detail', detail]]) {
    assert.ok(inOrder(r.afterRelease, ['GET /api/v1/session', `POST ${LOGIN}`, 'GET /api/v1/session']), `${label}: a session read, A's login, then a session read after the refused read: ${r.afterRelease.join('; ')}`);
  }
  assert.deepEqual([list.end.phase, list.end.rowsA], ['ready', true], `the list ends on A's own rows: ${JSON.stringify(list.end)}`);
  assert.equal(list.end.rowsB, false, 'never B\'s rows on A\'s page');
  assert.deepEqual([detail.end.phase, detail.end.showsA], ['ready', true], `the detail ends on A's own customer: ${JSON.stringify(detail.end)}`);
  assert.equal(detail.end.showsB, false, 'never B\'s customer on A\'s page');
  await assertNoLeak(page);
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P6 — an ended session is never re-established on its own
// ---------------------------------------------------------------------------------------------------------------------

/** The end SRL-03 makes: every tenant session of `who` (and its mint row) removed in the store. */
async function endSessions(who) {
  const keys = (await owner`select session_key from tmpos_session.session where auth_provider_uid = ${who.uid}`).map((r) => r.session_key);
  if (keys.length > 0) await owner`delete from tmpos_mint.tenant_session where session_key = any(${keys}::text[])`;
  await owner`delete from tmpos_session.session where auth_provider_uid = ${who.uid}`;
}

scenario('SCB-09', 'SESSION END (M7A-CUSTOMERS-P6) — the session the page confirmed is ended in the store: Refresh, a focus, a tab return, "Check again" and a customer opened in the app send ZERO logins and no POST, showing Reconnect and no customer; ONE Reconnect click sends exactly ONE login, the rows return and the unresolved create is detached, never re-sent; ended again, another tab\'s valid session is reused with no login; a reload with an ended cookie signs in once (the stated residual)', async () => {
  const { tenant, boss } = await shop('c9');
  await seedCustomers(tenant, [`M7SCB c9 one ${SUFFIX}`, `M7SCB c9 two ${SUFFIX}`]);
  const name = `M7SCB c9 held ${SUFFIX}`;
  const page = await directoryPage(boss);
  // An unresolved create: it commits, and its answer is lost at the front (as SCB-05).
  let lost = 0;
  st.lose = (rec, phase) => phase === 'response' && isCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
  await addCustomer(page, name);
  await waitData(page, 'directory-hold', 'state', 'unresolved');
  st.lose = null;
  const expected = await customersOf(tenant); // the two seeded and the held one
  await waitRows(page, expected.filter((c) => c.name !== name), 'the page shows the rows it read');
  const pageLogins = (from) => sentBy(page, isLogin, from);
  const steps = {};

  // The end, while the page is ready. Everything the page does by itself — or that is not a Reconnect — signs nothing in.
  const ended = st.api.length;
  await endSessions(boss);
  await page.click(by('directory-refresh'));
  await waitList(page, 'signed-out');
  steps.refresh = { logins: pageLogins(ended).map(answered), state: await textOf(page, 'directory-state') };
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
  await page.waitFor(() => offered(page, 'directory-check-again'), 15_000, 'Check again is offered');
  await page.click(by('directory-check-again'));
  await page.waitFor(async () => /Not checked/.test((await textOf(page, 'directory-hold-reason')) ?? ''), 15_000, 'the check found the session ended');
  await go(page, `${DIRECTORY}/${expected[0].id}`);
  await waitData(page, 'directory-detail', 'phase', 'signed-out');
  steps.detail = { name: await has(page, 'directory-detail-name'), retry: await textOf(page, 'directory-detail-retry') };
  await go(page, DIRECTORY);
  await waitList(page, 'signed-out');
  await quiet(page, ended);
  await delay(2_000); // whatever it would still send on its own, it has sent
  steps.ended = {
    logins: pageLogins(ended).map(answered),
    creates: sentBy(page, isCreate, ended).map(answered),
    customerReads: sentBy(page, isCustomersRead, ended).map(answered),
    rows: (await rowsOf(page)).length,
    retry: await textOf(page, 'directory-retry'),
    detached: await page.evaluate(`${q('directory-hold')}?.dataset.detached ?? null`),
  };

  // The Reconnect: exactly one login, and the rows are back; the attempt is detached (a new session), never re-sent.
  const reconnect = st.api.length;
  await page.click(by('directory-retry'));
  await waitList(page);
  await waitData(page, 'directory-hold', 'detached', 'true');
  await quiet(page, reconnect);
  const shown = await rowsOf(page);
  steps.reconnect = {
    logins: pageLogins(reconnect).map(answered),
    rowsBack: JSON.stringify(shown) === JSON.stringify(expected),
    creates: sentBy(page, isCreate).length,
  };

  // Ended again; another TAB of this browser then signs the same owner in: the page's focus reuses that session (no login).
  const again = st.api.length;
  await endSessions(boss);
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await waitList(page, 'signed-out');
  const tab = await sameContextTab(page);
  await tab.goto(`${SHOP}${DIRECTORY}`, 30_000);
  await tab.waitFor(`${q('directory-state')}?.dataset.phase === 'ready'`, 30_000, 'the second tab is ready');
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await waitList(page);
  await waitRows(page, expected, 'the page shows the rows under the other tab\'s session');
  steps.otherTab = { pageLogins: pageLogins(again).map(answered), tabLogins: sentBy(tab, isLogin, again).map(answered) };

  // The stated residual: a reload while the cookie names an ended session is a fresh page — its first 401 signs in.
  await endSessions(boss);
  const reload = st.api.length;
  await page.goto(`${SHOP}${DIRECTORY}`, 30_000);
  await waitList(page);
  await quiet(page, reload);
  steps.reload = { logins: pageLogins(reload).map(answered) };
  record('SCB-09', steps);

  assert.deepEqual(steps.refresh.logins, [], 'Refresh after the end: no login');
  assert.match(steps.refresh.state ?? '', /session ended/i, 'the list says the session ended');
  assert.deepEqual([steps.detail.name, steps.detail.retry], [false, 'Reconnect'], 'the detail shows no customer, and Reconnect');
  assert.deepEqual(steps.ended.logins, [], 'ZERO logins across Refresh, focus, tab return, Check again and the route changes');
  assert.deepEqual(steps.ended.creates, [], 'no POST: the uncertain create is not re-sent');
  assert.deepEqual(steps.ended.customerReads, [], 'no customer read without a session');
  assert.deepEqual([steps.ended.rows, steps.ended.retry, steps.ended.detached], [0, 'Reconnect', 'false'], 'no rows, Reconnect, the attempt still held');
  assert.deepEqual(steps.reconnect.logins, ['200'], 'ONE Reconnect click: exactly one login');
  assert.ok(steps.reconnect.rowsBack, 'the rows return');
  assert.equal(steps.reconnect.creates, 1, 'one POST in the whole case: the attempt is detached, never re-sent');
  assert.deepEqual(steps.otherTab.pageLogins, [], 'another tab\'s valid session is reused: no login from the page');
  assert.deepEqual(steps.otherTab.tabLogins, ['200'], 'the other tab signed in once (its own first load)');
  assert.deepEqual(steps.reload.logins, ['200'], 'a reload with an ended cookie signs in once (the stated residual)');
  assert.deepEqual(await named(tenant, name), expected.filter((c) => c.name === name), 'ONE customer of the held name');
  await assertNoLeak(page);
}, 240_000);

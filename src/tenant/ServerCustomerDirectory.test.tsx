// M7A-CUSTOMERS-P5 — the shop's server-backed Customer directory in jsdom: the REAL tenant session and customers clients
// over one fake tenant server at the network boundary (synthetic tenants, users and names only). The fake is as strict
// as the server where the page could be wrong about it: a distinct CSRF token per session and a 403 for a POST whose
// token is not that session's; the intent header and a v4 Idempotency-Key required; the name judged AFTER the key is
// acquired (a 400 keeps the lease, and the same key then answers 409); 422 for other bytes or another tenant; a sealed
// 201 with Location, replayed with Idempotent-Replayed: true; real 23-character cursors over byte-order pages; sessions
// bound to tenants; since M7A-CUSTOMERS-P6 an optional phone and email on a create (judged by the server's own contact
// rules, any other key refused) and the profile read GET /api/v1/customers/{id}/profile (seeded customers are legacy:
// no contacts, no creation time). Its name rule, contact rules, cursor codec and page order are the server's own
// modules. Since M7A-CUSTOMERS-P7 every customer has a row version (1 when stored), the profile 200 carries it as a
// strong ETag, and PATCH /api/v1/customers/{id} edits one customer as the server does: the key bound to the target and the
// exact bytes, a stale version a sealed 409 write_conflict, a missing or foreign id a 404, a 200 that names no contact.
// Since M7A-CUSTOMERS-P8 the list reads its query with the server's own parser: `q` form-decoded and trimmed (blank: the
// unfiltered list), matched anywhere in the name case-insensitively (full uppercase of both sides) in the list's byte
// order, each cursor kind accepted only with its own search, a search's continuation being the anchor's current position.
// Every assertion about a request is made on what the fake recorded — the wire — never on what the page believes it sent.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Navigate, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { StrictMode } from 'react';

const access = vi.hoisted(() => {
  let value: { uid: string | null; canCreate: boolean; canEdit: boolean } = { uid: 'uid-a', canCreate: true, canEdit: false };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: Partial<{ uid: string | null; canCreate: boolean; canEdit: boolean }>) { value = { ...value, ...next }; for (const l of [...listeners]) l(); },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
});
vi.mock('../firebase', () => ({ auth: { currentUser: null } }));
// The routed page reads the signed-in user and the local create and edit hints from the access context: a switchable stand-in.
vi.mock('../context/AccessContext', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAccess: () => {
      const v = useSyncExternalStore(access.subscribe, access.get);
      return {
        session: v.uid === null ? null : { user: { id: v.uid } },
        hasPermission: (perm: string) => perm === 'customers' && v.canCreate,
        checkPermission: (domain: string, level: string) => domain === 'customers' && (level === 'edit' ? v.canEdit : level === 'create' && v.canCreate),
      };
    },
  };
});

import {
  CHECK_CUTOFF_MS, CONNECTION_CHANGED_TEXT, CustomerDirectoryPage, EMAIL_RULE_TEXT, EMPTY_TEXT, LAST_KNOWN_TEXT, NAME_RULE_TEXT,
  NOT_FOUND_TEXT, NOT_PROVIDED_TEXT, NOT_RECORDED_TEXT, PHONE_RULE_TEXT, SEARCH_RULE_TEXT, savedEarlierText, searchMatchingText, searchNoneText,
  STOP_WARNING_TEXT, createHoldStore, ENDED_TEXT, bindHoldsToSessionEnd,
  unresolvedText, type HoldStore, createEditHoldStore, type EditHoldStore, type EditOutcome, EDIT_CONFLICT_TEXT, EDIT_DENIED_TEXT, EDIT_NO_CHANGES_TEXT,
  EDIT_REVIEWED_TEXT, EDIT_SAVED_TEXT, EDIT_SAVED_UNREFRESHED_TEXT, EDIT_UNKNOWN_TEXT, bindEditHoldsToSessionEnd, editNamedText,
} from './ServerCustomerDirectory';
import { createTenantSessionClient, onSessionEnd, TENANT_SESSION_PATHS, type TenantSessionClient } from './tenantSessionClient';
import { CUSTOMERS_PATH, createCustomersClient, type CustomersClient } from './customersClient';
import { normalizeCustomerName as serverNormalizeCustomerName } from '../../server/runtime/customerCreate';
import {
  CONTACT_REFUSED, encodeCustomerCursor, encodeCustomerSearchCursor, inCustomerPageOrder,
  normalizeCustomerEmail as serverNormalizeCustomerEmail, normalizeCustomerPhone as serverNormalizeCustomerPhone, parseCustomerDirectoryQuery,
} from '../../server/runtime/customerDirectory';
import { sessionSubjectOf } from '../../server/runtime/sessions';

/** The tenant session 200 as the server writes it (M7A-CUSTOMERS-P5-R1): its token and whose session it is. */
const activeBody = (uid: string, csrfToken: string) =>
  ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });

const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i; // server/runtime/idempotency.ts
const CANONICAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

// How the fake server answers the next POST that reaches its store. `commit-*` creates the customer, seals the 201 for
// the key, then answers otherwise; `rollback-503` acquires the key and commits nothing (the lease stays); `lost-before`
// never reaches the server. A number is a refusal decided BEFORE the key is acquired (nothing reserved) — a 429 before
// the session is even read, as in the real chain.
type PostPlan =
  | 'ok' | 'lost-after-commit' | 'lost-before' | 'commit-then-503' | 'commit-then-409' | 'rollback-503'
  | 'commit-other-name' | 'commit-bad-body' | 'commit-200' | number;
type ReadPlan = number | 'html' | 'lost' | 'no-etag' | 'weak-etag' | { readonly limited: string }; // `limited`: a 429 with its own Retry-After
// How the fake answers the next PATCH: as PostPlan's words, applied to an edit.
type PatchPlan = 'ok' | 'lost-after-commit' | 'lost-before' | 'commit-then-503' | 'rollback-503' | number;
interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined; readonly signal: AbortSignal | null }
interface User { uid: string; tenant: string; view: boolean; create: boolean; edit: boolean }
interface Row { id: string; name: string }
interface Contact { phone: string | null; email: string | null; createdAt: string | null }
const LEGACY: Contact = Object.freeze({ phone: null, email: null, createdAt: null }); // a customer from before P6
type Late = Response | 'drop' | undefined;

/** One fake tenant server. `cookie` is the session the browser currently presents; a login replaces it. */
function fakeServer() {
  const users: Record<string, User> = {
    'tok-a': { uid: 'uid-a', tenant: TENANT_A, view: true, create: true, edit: true },
    'tok-b': { uid: 'uid-b', tenant: TENANT_B, view: true, create: true, edit: true },
  };
  const sessions = new Map<string, { user: User; tenant: string; csrf: string }>();
  const rows: Record<string, Row[]> = { [TENANT_A]: [], [TENANT_B]: [] };
  const records = new Map<string, { fingerprint: string; leased: boolean; sealed: Row | null }>();
  const contacts = new Map<string, Contact>(); // by customer id; a row with none is LEGACY
  const versions = new Map<string, number>(); // by customer id; a row with none is at version 1
  const edits = new Map<string, { fingerprint: string; leased: boolean; sealed: { status: number; body: unknown } | null }>();
  let sessionCount = 0;
  let createdCount = 0;
  let idCount = 0xa00; // ids carry a hex letter, so an uppercase spelling is a different string
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers } });
  const refuse = (status: number, error: string, headers: Record<string, string> = {}): Response => reply(status, { error, requestId: 'req-synthetic' }, headers);
  const WORDS: Record<number, string> = {
    400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'request_in_progress', 413: 'content_too_large',
    415: 'unsupported_media_type', 422: 'idempotency_key_reused', 429: 'rate_limited', 500: 'internal_error', 503: 'service_unavailable',
  };
  const byteOrder = (x: Row, y: Row): number =>
    Buffer.compare(Buffer.from(x.name, 'utf8'), Buffer.from(y.name, 'utf8')) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const ordered = (tenant: string): Row[] => [...rows[tenant]].sort(byteOrder);
  const openSession = (user: User): string => {
    sessionCount += 1;
    const id = `session-${sessionCount}`;
    sessions.set(id, { user, tenant: user.tenant, csrf: `${'s'.repeat(40)}${String(sessionCount).padStart(3, '0')}` });
    return id;
  };

  const server = {
    sent: [] as Sent[],
    users,
    rows,
    contacts,
    versions,
    sessions,
    cookie: null as string | null,
    pageSize: 50,
    retryAfter: '1' as string | null, // the Retry-After every 429 carries
    posts: [] as PostPlan[],
    patches: [] as PatchPlan[],
    reads: [] as ReadPlan[], // the next customer reads (list or detail)
    profileReads: [] as ReadPlan[], // the next PROFILE reads, before `reads` (a list read in between takes none of them)
    logins: [] as number[], // the next logins
    checks: [] as number[], // the next session reads
    hold: { reads: 0, posts: 0, checks: 0, patches: 0 }, // answers to hold (checks: session reads): computed on arrival, released by the test
    held: [] as Array<{ url: string; release: (late?: Late) => void }>,
    down: false, // every request fails with no answer
    swapOnRead: null as string | null,
    /** Customers already stored for a tenant. */
    seed(tenant: string, names: readonly string[]): Row[] {
      const made = names.map((name) => ({ id: uuid(++idCount), name }));
      rows[tenant].push(...made);
      return made;
    },
    csrfOfCookie: (): string | null => (server.cookie === null ? null : sessions.get(server.cookie)?.csrf ?? null),
    /** Another tab signed in: the browser's cookie now names a NEW session of `token`'s user (the old one still stands). */
    otherTab(token: string): void { server.cookie = openSession(users[token]); },
    /** The account's grant moved: its sessions end, and its next login is admitted to `tenant`. */
    moveGrant(token: string, tenant: string): void {
      users[token].tenant = tenant;
      for (const [id, s] of sessions) if (s.user === users[token]) sessions.delete(id);
    },
    /** Every unfinished attempt's lease has run out: the same key is reclaimed and planned again. */
    expireLeases(): void { for (const r of [...records.values(), ...edits.values()]) if (r.sealed === null) r.leased = false; },
    /** Another editor's committed change: the customer's name moves on, and so does its version. */
    editElsewhere(id: string, name: string): void {
      for (const list of Object.values(rows)) for (const r of list) if (r.id === id) r.name = name;
      versions.set(id, (versions.get(id) ?? 1) + 1);
    },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : undefined;
      server.sent.push({ method, url, headers, body, signal: init.signal ?? null });
      if (server.down) throw new TypeError('network');
      // Another tab of this browser signs in as `swapOnRead`'s user just before the next customer read arrives: the
      // read leaves with the page's token and arrives with the other session's cookie (M7A-CUSTOMERS-P5-R1).
      if (method === 'GET' && url.startsWith(CUSTOMERS_PATH) && server.swapOnRead !== null) {
        const token = server.swapOnRead;
        server.swapOnRead = null;
        server.otherTab(token);
      }
      const limited = (): Response => refuse(429, WORDS[429], server.retryAfter === null ? {} : { 'retry-after': server.retryAfter });
      const held = async (kind: 'reads' | 'posts' | 'checks' | 'patches', answer: Response | 'lost'): Promise<Response> => {
        if (server.hold[kind] > 0) {
          server.hold[kind] -= 1;
          const late = await new Promise<Late>((release) => { server.held.push({ url, release }); });
          if (late === 'drop') throw new TypeError('network');
          if (late !== undefined) return late;
        }
        if (answer === 'lost') throw new TypeError('network');
        return answer;
      };

      if (url === TENANT_SESSION_PATHS.login && method === 'POST') {
        const plan = server.logins.shift();
        if (plan !== undefined) return plan === 429 ? limited() : refuse(plan, WORDS[plan] ?? 'refused');
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, WORDS[403]);
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return refuse(401, WORDS[401]);
        server.cookie = openSession(user);
        return reply(200, activeBody(user.uid, sessions.get(server.cookie)!.csrf));
      }
      const session = server.cookie === null ? undefined : sessions.get(server.cookie);
      if (url === TENANT_SESSION_PATHS.current && method === 'GET') {
        const plan = server.checks.shift();
        const answer = plan !== undefined ? (plan === 429 ? limited() : refuse(plan, WORDS[plan] ?? 'refused'))
          : session === undefined ? refuse(401, WORDS[401]) : reply(200, activeBody(session.user.uid, session.csrf));
        return server.hold.checks > 0 ? held('checks', answer) : answer;
      }
      if (url === TENANT_SESSION_PATHS.logout && method === 'POST') {
        if (server.cookie !== null) sessions.delete(server.cookie);
        server.cookie = null;
        return reply(204);
      }

      const path = url.split('?')[0];
      if (method === 'GET' && (path === CUSTOMERS_PATH || path.startsWith(`${CUSTOMERS_PATH}/`))) {
        // Decided on arrival, as the server does; a held answer is the state when the request arrived.
        const decide = (): Response | 'lost' => {
          const plan = path.endsWith('/profile') && server.profileReads.length > 0 ? server.profileReads.shift() : server.reads.shift();
          if (plan === 429) return limited(); // before any session is read
          if (typeof plan === 'object') return refuse(429, WORDS[429], { 'retry-after': plan.limited });
          if (session === undefined) return refuse(401, WORDS[401]);
          // M7A-CUSTOMERS-P5-R1: a read names its session; another session's token (or none) is refused, as by the chain.
          if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, WORDS[403]);
          if (!session.user.view) return refuse(403, WORDS[403]);
          if (plan === 'lost') return 'lost';
          if (plan === 'html') return new Response('<!doctype html><title>Shop</title>', { status: 200, headers: { 'content-type': 'text/html' } });
          if (plan !== undefined && typeof plan === 'number') return refuse(plan, WORDS[plan] ?? 'refused');
          if (path !== CUSTOMERS_PATH) {
            if (url.includes('?')) return refuse(400, WORDS[400]);
            const rest = path.slice(CUSTOMERS_PATH.length + 1);
            const profile = rest.endsWith('/profile');
            const id = profile ? rest.slice(0, -'/profile'.length) : rest;
            if (id.includes('/') || id.length === 0) return refuse(404, WORDS[404]); // no route
            if (!CANONICAL_ID_RE.test(id)) return refuse(400, WORDS[400]);
            const found = rows[session.tenant].find((r) => r.id === id); // another tenant's id is simply not here
            if (found === undefined) return refuse(404, WORDS[404]);
            if (!profile) return reply(200, { customer: { id: found.id, name: found.name } });
            const c = contacts.get(found.id) ?? LEGACY;
            const version = versions.get(found.id) ?? 1;
            // The version is the values' own, as one ETag (M7A-CUSTOMERS-P7); `no-etag` / `weak-etag` answer without a usable one.
            const etag: Record<string, string> = plan === 'no-etag' ? {} : { etag: plan === 'weak-etag' ? `W/"${version}"` : `"${version}"` };
            return reply(200, { customer: { id: found.id, name: found.name, phone: c.phone, email: c.email, createdAt: c.createdAt } }, etag);
          }
          const all = ordered(session.tenant);
          if (/[?&]limit=/.test(url)) return refuse(400, WORDS[400]); // the page sends no limit
          const query = parseCustomerDirectoryQuery(url); // the server's own: q, cursor kinds, bounds
          if (query === null) return refuse(400, WORDS[400]);
          const anchor = query.after === null ? null : all.find((r) => r.id === query.after);
          if (anchor === undefined) return refuse(400, WORDS[400]); // foreign or deleted: one answer
          const { search } = query;
          const matching = search === null ? all : all.filter((r) => r.name.toUpperCase().includes(search.toUpperCase()));
          const rest = anchor === null ? matching : matching.filter((r) => byteOrder(r, anchor) > 0);
          const slice = rest.slice(0, server.pageSize);
          const last = slice[slice.length - 1];
          const next = rest.length <= server.pageSize ? null : search === null ? encodeCustomerCursor(last.id) : encodeCustomerSearchCursor(last.id, search);
          return reply(200, { customers: slice.map((r) => ({ id: r.id, name: r.name })), nextCursor: next });
        };
        return held('reads', decide());
      }

      if (method === 'POST' && url === CUSTOMERS_PATH) {
        const decide = (): Response | 'lost' => {
          const plan = server.posts.shift() ?? 'ok';
          if (plan === 'lost-before') return 'lost';
          if (plan === 429) return limited();
          if (!/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(headers.get('content-type') ?? '')) return refuse(415, WORDS[415]);
          if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, WORDS[403]);
          if (session === undefined) return refuse(401, WORDS[401]);
          if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, WORDS[403]); // not this session's token
          if (!session.user.create) return refuse(403, WORDS[403]);
          let parsed: unknown;
          try { parsed = JSON.parse(body ?? ''); } catch { return refuse(400, WORDS[400]); }
          const idempotencyKey = headers.get('idempotency-key') ?? '';
          if (!KEY_RE.test(idempotencyKey)) return refuse(400, WORDS[400]);
          if (typeof plan === 'number') return plan === 200 ? reply(200, { customer: { id: uuid(1), name: 'x' } }) : refuse(plan, WORDS[plan] ?? 'refused');
          // The key's scope is (key, principal); its fingerprint binds the tenant, the actor and the exact bytes.
          const scope = `${idempotencyKey.toLowerCase()}|${session.user.uid}`;
          const fingerprint = `${session.tenant}|${session.user.uid}|${body}`;
          const record = records.get(scope);
          if (record !== undefined && record.fingerprint !== fingerprint) return refuse(422, WORDS[422]);
          if (record !== undefined && record.sealed !== null) {
            return reply(201, { customer: record.sealed }, { location: `${CUSTOMERS_PATH}/${record.sealed.id}`, 'idempotent-replayed': 'true' });
          }
          if (record !== undefined && record.leased) return refuse(409, WORDS[409]);
          const mine = { fingerprint, leased: true, sealed: null as Row | null };
          records.set(scope, mine);
          // Only now is the body judged: a refused field keeps the lease. `name` required; `phone`, `email` optional.
          const shape = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed) : [];
          const known = shape.includes('name') && shape.every((k) => k === 'name' || k === 'phone' || k === 'email');
          const fields = (known ? parsed : {}) as { name?: unknown; phone?: unknown; email?: unknown };
          const name = known ? serverNormalizeCustomerName(fields.name) : null;
          const phone = serverNormalizeCustomerPhone(fields.phone);
          const email = serverNormalizeCustomerEmail(fields.email);
          if (name === null || phone === CONTACT_REFUSED || email === CONTACT_REFUSED) return refuse(400, WORDS[400]);
          if (plan === 'rollback-503') return refuse(503, WORDS[503]);
          const customer = { id: uuid(++idCount), name };
          rows[session.tenant].push(customer);
          contacts.set(customer.id, { phone, email, createdAt: new Date(Date.UTC(2026, 8, 30, 9, 5, 0, ++createdCount)).toISOString() });
          mine.sealed = customer;
          if (plan === 'lost-after-commit') return 'lost';
          if (plan === 'commit-then-503') return refuse(503, WORDS[503]);
          if (plan === 'commit-then-409') return refuse(409, WORDS[409]);
          if (plan === 'commit-other-name') return reply(201, { customer: { id: customer.id, name: 'Someone Else' } }, { location: `${CUSTOMERS_PATH}/${customer.id}` });
          if (plan === 'commit-bad-body') return reply(201, { customer: { ...customer, tenant: session.tenant } }, { location: `${CUSTOMERS_PATH}/${customer.id}` });
          if (plan === 'commit-200') return reply(200, { customer }, { location: `${CUSTOMERS_PATH}/${customer.id}` });
          return reply(201, { customer }, { location: `${CUSTOMERS_PATH}/${customer.id}` });
        };
        return held('posts', decide());
      }

      if (method === 'PATCH' && path.startsWith(`${CUSTOMERS_PATH}/`)) {
        const decide = (): Response | 'lost' => {
          const plan = server.patches.shift() ?? 'ok';
          if (plan === 'lost-before') return 'lost';
          if (plan === 429) return limited();
          if (!/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(headers.get('content-type') ?? '')) return refuse(415, WORDS[415]);
          if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, WORDS[403]);
          if (session === undefined) return refuse(401, WORDS[401]);
          if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, WORDS[403]);
          if (!session.user.edit) return refuse(403, WORDS[403]);
          const id = path.slice(CUSTOMERS_PATH.length + 1);
          if (!CANONICAL_ID_RE.test(id) || url.includes('?')) return refuse(400, WORDS[400]);
          let parsed: unknown;
          try { parsed = JSON.parse(body ?? ''); } catch { return refuse(400, WORDS[400]); }
          const idempotencyKey = headers.get('idempotency-key') ?? '';
          if (!KEY_RE.test(idempotencyKey)) return refuse(400, WORDS[400]);
          if (typeof plan === 'number') return refuse(plan, WORDS[plan] ?? 'refused');
          // The fingerprint binds the target too: the same key and bytes for another customer is another request.
          const scope = `${idempotencyKey.toLowerCase()}|${session.user.uid}`;
          const fingerprint = `PATCH|${session.tenant}|${session.user.uid}|${id}|${body}`;
          const record = edits.get(scope);
          if (record !== undefined && record.fingerprint !== fingerprint) return refuse(422, WORDS[422]);
          if (record !== undefined && record.sealed !== null) return reply(record.sealed.status, record.sealed.body, { 'idempotent-replayed': 'true' });
          if (record !== undefined && record.leased) return refuse(409, WORDS[409]);
          const mine = { fingerprint, leased: true, sealed: null as { status: number; body: unknown } | null };
          edits.set(scope, mine);
          const fields = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
          const keys = Object.keys(fields);
          if (!keys.includes('expectedVersion') || !keys.includes('name') || !keys.every((k) => ['expectedVersion', 'name', 'phone', 'email'].includes(k))) return refuse(400, WORDS[400]);
          const expected = fields.expectedVersion;
          if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1 || expected >= Number.MAX_SAFE_INTEGER) return refuse(400, WORDS[400]);
          const name = serverNormalizeCustomerName(fields.name);
          const contact = (k: 'phone' | 'email', normalize: (raw: unknown) => unknown): { set: boolean; value: unknown } =>
            !keys.includes(k) ? { set: false, value: null } : { set: true, value: fields[k] === null ? null : normalize(fields[k]) };
          const phone = contact('phone', serverNormalizeCustomerPhone);
          const email = contact('email', serverNormalizeCustomerEmail);
          if (name === null || phone.value === CONTACT_REFUSED || email.value === CONTACT_REFUSED) return refuse(400, WORDS[400]);
          if (plan === 'rollback-503') return refuse(503, WORDS[503]);
          const found = rows[session.tenant].find((r) => r.id === id);
          if (found === undefined) return refuse(404, WORDS[404]); // missing or another tenant's: rolled back, unsealed
          const version = versions.get(id) ?? 1;
          if (version !== expected) {
            mine.sealed = { status: 409, body: { error: 'write_conflict', requestId: 'req-synthetic' } };
            return reply(409, mine.sealed.body);
          }
          const was = contacts.get(id) ?? LEGACY;
          const next = { phone: phone.set ? phone.value as string | null : was.phone, email: email.set ? email.value as string | null : was.email, createdAt: was.createdAt };
          const changed = name !== found.name || next.phone !== was.phone || next.email !== was.email;
          if (changed) {
            found.name = name;
            contacts.set(id, next);
            versions.set(id, version + 1);
          }
          mine.sealed = { status: 200, body: { customer: { id, name }, version: changed ? version + 1 : version, changed } };
          if (plan === 'lost-after-commit') return 'lost';
          if (plan === 'commit-then-503') return refuse(503, WORDS[503]);
          return reply(200, mine.sealed.body);
        };
        return held('patches', decide());
      }
      return refuse(404, WORDS[404]);
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

interface MountOptions {
  readonly path?: string;
  readonly keys?: string[];
  readonly holds?: HoldStore;
  readonly editHolds?: EditHoldStore;
  readonly wrapCustomers?: (client: CustomersClient) => CustomersClient;
  readonly wrapSession?: (client: TenantSessionClient) => TenantSessionClient;
  readonly strict?: boolean; // under <StrictMode>: in development every effect runs setup, cleanup, setup
  readonly defaultEditHolds?: boolean; // mount WITHOUT an injected edit hold store: the shop's own, bound to onSessionEnd
  readonly defaultHolds?: boolean; // mount WITHOUT an injected hold store: the page's own module-level one
  readonly now?: () => number;
  readonly tokens?: Record<string, string>;
}
function mount(server: Server, options: MountOptions = {}) {
  const tokens = options.tokens ?? { 'uid-a': 'tok-a', 'uid-b': 'tok-b' };
  const made: string[] = [];
  let n = 0;
  const newKey = (): string => {
    const next = options.keys?.[n] ?? key((n % 9) + 1);
    n += 1;
    made.push(next);
    return next;
  };
  const holds = options.holds ?? createHoldStore();
  const editHolds = options.editHolds ?? createEditHoldStore();
  const session = createTenantSessionClient({ fetch: server.fetch }); // its logout() is a sign-out: every onSessionEnd hears it
  const page = (
    <CustomerDirectoryPage
      session={(options.wrapSession ?? ((c: TenantSessionClient) => c))(session)}
      customers={(options.wrapCustomers ?? ((c: CustomersClient) => c))(createCustomersClient({ fetch: server.fetch }))}
      identity={{ idToken: async (uid) => tokens[uid] ?? null }}
      holds={options.defaultHolds === true ? undefined : holds}
      editHolds={options.defaultEditHolds === true ? undefined : editHolds}
      newKey={newKey}
      now={options.now}
    />
  );
  const router = createMemoryRouter([
    { path: '/customers/directory/:id?', element: page },
    { path: '/customers/:id', element: <Navigate to="/customers" replace /> }, // App.tsx's redirect, below the directory
    { path: '/customers', element: <p data-testid="local-customers">local customers</p> },
    { path: '/elsewhere', element: <p data-testid="elsewhere">elsewhere</p> },
  ], { initialEntries: [options.path ?? '/customers/directory'] });
  const view = render(options.strict === true ? <StrictMode><RouterProvider router={router} /></StrictMode> : <RouterProvider router={router} />);
  const go = (to: string) => act(async () => { await router.navigate(to); });
  return { ...view, router, holds, editHolds, made, go, session };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
const state = () => screen.getByTestId('directory-state');
const phase = (): string | null => state().getAttribute('data-phase');
const ready = () => waitFor(() => expect(phase()).toBe('ready'));
const names = (): string[] => screen.queryAllByTestId('directory-row').map((r) => r.textContent ?? '');
const hold = () => screen.getByTestId('directory-hold');
const addButton = () => screen.getByTestId('directory-add');
const nameInput = () => screen.getByTestId('directory-name') as HTMLInputElement;
const createStatus = () => screen.getByTestId('directory-create-status');
const posts = (s: Server) => s.sent.filter((r) => r.method === 'POST' && r.url === CUSTOMERS_PATH);
const lists = (s: Server) => s.sent.filter((r) => r.method === 'GET' && r.url.split('?')[0] === CUSTOMERS_PATH);
const details = (s: Server) => s.sent.filter((r) => r.method === 'GET' && r.url.startsWith(`${CUSTOMERS_PATH}/`));
const logins = (s: Server) => s.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login);
const click = async (testId: string) => { await userEvent.setup().click(screen.getByTestId(testId)); };
const typeName = async (name: string) => {
  const user = userEvent.setup();
  await user.clear(nameInput());
  if (name !== '') await user.type(nameInput(), name);
};
const addCustomer = async (name: string) => {
  await typeName(name);
  await click('directory-add');
};
const focusWindow = async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
};
const unresolved = () => waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
const page = (): string => screen.getByTestId('customer-directory').textContent ?? '';

/** Nothing on the wire selects or asserts a tenant, store, role or actor: the session is the only source of scope. */
const SELECTOR_RE = /tenant|store|role|actor|uid|user/i;
const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'authorization', 'x-tmpos-csrf', 'x-tmpos-session-csrf', 'idempotency-key']);
function expectNoSelector(server: Server): void {
  expect(server.sent.length).toBeGreaterThan(0);
  for (const r of server.sent) {
    expect(r.url).not.toMatch(SELECTOR_RE);
    for (const [name] of r.headers) expect(ALLOWED_HEADERS.has(name), `header ${name} on ${r.method} ${r.url}`).toBe(true);
    if (r.headers.has('authorization')) expect(r.url).toBe(TENANT_SESSION_PATHS.login);
    if (r.url.startsWith(CUSTOMERS_PATH)) {
      if (r.method === 'GET') {
        expect([...r.headers].map(([name]) => name)).toEqual(['accept', 'x-tmpos-session-csrf']); // the session it names (P5-R1)
        expect(r.headers.get('x-tmpos-session-csrf')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(r.body).toBeUndefined();
        expect(r.url).not.toMatch(/limit=/);
      } else if (r.method === 'PATCH') {
        // `{ expectedVersion, name }`, with a phone and an email when they changed: in that order, nothing else.
        const keys = Object.keys(JSON.parse(r.body ?? 'null') as object);
        expect(keys).toEqual(['expectedVersion', 'name', 'phone', 'email'].filter((k) => keys.includes(k)));
        expect(keys.slice(0, 2)).toEqual(['expectedVersion', 'name']);
      } else {
        // `{ name }`, with a phone and an email when given: in that order, nothing else.
        const keys = Object.keys(JSON.parse(r.body ?? 'null') as object);
        expect(keys).toEqual(['name', 'phone', 'email'].filter((k) => keys.includes(k)));
        expect(keys[0]).toBe('name');
      }
    }
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  access.set({ uid: 'uid-a', canCreate: true, canEdit: false });
});

describe('ServerCustomerDirectory (M7A-CUSTOMERS-P5)', () => {
  it('SCD-00. the fake server is as strict as the real one where the page could be wrong about it', async () => {
    const server = fakeServer();
    const send = (method: string, url: string, headers: Record<string, string> = {}, body?: string) => server.fetch(url, { method, headers, body });
    const login = await send('POST', TENANT_SESSION_PATHS.login, { authorization: 'Bearer tok-a', 'x-tmpos-csrf': '1' });
    const csrfA = ((await login.json()) as { csrfToken: string }).csrfToken;
    expect(csrfA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const post = (k: string, body: string, csrf = csrfA, more: Record<string, string> = {}) =>
      send('POST', CUSTOMERS_PATH, { 'content-type': 'application/json', 'x-tmpos-csrf': '1', 'x-tmpos-session-csrf': csrf, 'idempotency-key': k, ...more }, body);
    const good = JSON.stringify({ name: 'Ada Lovelace' });
    expect((await post(key(1), good, 'x'.repeat(43))).status).toBe(403); // another session's token
    expect((await send('POST', CUSTOMERS_PATH, { 'content-type': 'application/json', 'x-tmpos-session-csrf': csrfA, 'idempotency-key': key(1) }, good)).status).toBe(403); // no intent header
    expect((await post(key(1), good, csrfA, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post('not-a-key', good)).status).toBe(400);
    expect((await post(uuid(7).replace('-4000-', '-1000-'), good)).status).toBe(400); // a v1-shaped key
    expect(server.rows[TENANT_A]).toEqual([]); // nothing so far reserved or created anything
    // A refused name is decided AFTER the key is acquired: the 400 keeps the lease, so the same key is then in progress.
    expect((await post(key(2), JSON.stringify({ name: '   ' }))).status).toBe(400);
    expect((await post(key(2), JSON.stringify({ name: '   ' }))).status).toBe(409);
    expect((await post(key(2), good)).status).toBe(422); // the same key with other bytes
    expect((await post(key(3), JSON.stringify({ name: 'Ada', tenantId: TENANT_B }))).status).toBe(400); // exactly { name }
    // A 201 with Location; the same key and bytes replay it, marked; other bytes are refused.
    const first = await post(key(4), good);
    const made = ((await first.json()) as { customer: Row }).customer;
    expect(first.status).toBe(201);
    expect(first.headers.get('location')).toBe(`${CUSTOMERS_PATH}/${made.id}`);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    const replay = await post(key(4), good);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(((await replay.json()) as { customer: Row }).customer).toEqual(made);
    expect((await post(key(4), JSON.stringify({ name: 'Ada  Lovelace' }))).status).toBe(422);
    expect(server.rows[TENANT_A]).toEqual([made]);
    // Byte-order pages behind real cursors; a cursor naming no customer of this tenant is one 400.
    const seeded = server.seed(TENANT_A, ['Zoe', 'adam', String.fromCodePoint(0xc9, 0x6d, 0x69, 0x6c, 0x65), 'Bob']);
    server.pageSize = 2;
    // A read names its session (M7A-CUSTOMERS-P5-R1): without the token, or with another session's, it is refused.
    const bound = { 'x-tmpos-session-csrf': csrfA };
    expect((await send('GET', CUSTOMERS_PATH)).status).toBe(403);
    expect((await send('GET', CUSTOMERS_PATH, { 'x-tmpos-session-csrf': 'x'.repeat(43) })).status).toBe(403);
    const one = (await (await send('GET', CUSTOMERS_PATH, bound)).json()) as { customers: Row[]; nextCursor: string };
    expect(one.nextCursor).toMatch(/^[A-Za-z0-9_-]{23}$/);
    expect((await send('GET', `${CUSTOMERS_PATH}?cursor=${one.nextCursor}`)).status).toBe(403);
    const two = (await (await send('GET', `${CUSTOMERS_PATH}?cursor=${one.nextCursor}`, bound)).json()) as { customers: Row[]; nextCursor: string };
    const three = (await (await send('GET', `${CUSTOMERS_PATH}?cursor=${two.nextCursor}`, bound)).json()) as { customers: Row[]; nextCursor: string | null };
    const walked = [...one.customers, ...two.customers, ...three.customers];
    expect(walked.map((r) => r.name)).toEqual(['Ada Lovelace', 'Bob', 'Zoe', 'adam', String.fromCodePoint(0xc9, 0x6d, 0x69, 0x6c, 0x65)]);
    expect(inCustomerPageOrder(walked)).toBe(true); // the server's own order predicate
    expect(three.nextCursor).toBeNull();
    const [foreign] = server.seed(TENANT_B, ['Foreign']);
    expect((await send('GET', `${CUSTOMERS_PATH}?cursor=${encodeCustomerCursor(foreign.id)}`, bound)).status).toBe(400);
    expect((await send('GET', `${CUSTOMERS_PATH}?limit=10`, bound)).status).toBe(400);
    expect((await send('GET', `${CUSTOMERS_PATH}/${foreign.id}`, bound)).status).toBe(404); // another tenant's id == a missing one
    expect((await send('GET', `${CUSTOMERS_PATH}/${uuid(0xdead)}`, bound)).status).toBe(404);
    expect((await send('GET', `${CUSTOMERS_PATH}/${seeded[0].id}`)).status).toBe(403); // a detail names its session too
    expect((await send('GET', `${CUSTOMERS_PATH}/${seeded[0].id.toUpperCase()}X`, bound)).status).toBe(400);
    // Sessions are bound to tenants, each with its own token; the same key under another tenant is refused.
    server.moveGrant('tok-a', TENANT_B);
    expect((await send('GET', CUSTOMERS_PATH)).status).toBe(401);
    const again = await send('POST', TENANT_SESSION_PATHS.login, { authorization: 'Bearer tok-a', 'x-tmpos-csrf': '1' });
    const csrfB = ((await again.json()) as { csrfToken: string }).csrfToken;
    expect(csrfB).not.toBe(csrfA);
    expect((await post(key(4), good, csrfA)).status).toBe(403);
    expect((await post(key(4), good, csrfB)).status).toBe(422);
    expect(server.rows[TENANT_B]).toEqual([foreign]);
  });

  it('SCD-01. loading, then the empty directory: one login, one page-one read, nothing that names a store', async () => {
    const server = fakeServer();
    server.hold.reads = 1;
    mount(server);
    expect(screen.getByRole('heading', { level: 1, name: 'Customer directory' })).toBeInTheDocument();
    expect(page()).toContain("Saved on the server for this store: each customer's name, and a phone and an email when they are given.");
    expect(page()).not.toContain('Only the customer');
    expect(page()).toContain("The Customers page's own contact details, loyalty and history are held only in this browser's memory and are not linked");
    expect(phase()).toBe('loading');
    expect(screen.queryByTestId('directory-empty')).toBeNull(); // never before a list answer
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(phase()).toBe('loading');
    expect(addButton()).toBeDisabled();
    expect(screen.getByTestId('directory-add-hint')).toHaveTextContent('Available once the list has loaded from the server.');
    server.held[0].release();
    await ready();
    expect(screen.getByTestId('directory-empty')).toHaveTextContent(EMPTY_TEXT);
    expect(screen.queryByTestId('directory-list')).toBeNull();
    // The session this browser holds is read first (none here: 401), and only then does the page sign in (P5-R1).
    expect(server.sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.login}`, `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`,
    ]);
    expect(addButton()).toBeEnabled();
    expectNoSelector(server);
  });

  it('SCD-02. rows are shown in the order they arrive (the server\'s byte order), each a link named by the customer', async () => {
    const server = fakeServer();
    const accented = String.fromCodePoint(0xc9, 0x6d, 0x69, 0x6c, 0x65); // sorts last in bytes, among the E's in a locale order
    const seeded = server.seed(TENANT_A, ['adam', accented, 'Zoe', 'Bob']);
    server.seed(TENANT_B, ['Foreign']);
    mount(server);
    await ready();
    expect(names()).toEqual(['Bob', 'Zoe', 'adam', accented]);
    expect([...names()].sort((x, y) => x.localeCompare(y))).not.toEqual(names()); // a re-sort would show another order
    expect(screen.getByTestId('directory-list').tagName).toBe('UL');
    const bob = seeded.find((r) => r.name === 'Bob')!;
    const row = screen.getAllByTestId('directory-row')[0];
    expect(row).toHaveAttribute('data-id', bob.id);
    expect(within(row).getByRole('link', { name: 'Bob' })).toHaveAttribute('href', `/customers/directory/${bob.id}`);
    expect(page()).not.toContain('Foreign');
    expect(screen.queryByTestId('directory-empty')).toBeNull();
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
  });

  it('SCD-03. 60 customers: 50, then "Load more" sends the server\'s cursor verbatim and shows 60 with no duplicate', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    expect(names()).toHaveLength(50);
    const cursor = encodeCustomerCursor(screen.getAllByTestId('directory-row')[49].getAttribute('data-id')!);
    // The second page arrives carrying an id already shown (a row that moved): it is appended once.
    server.hold.reads = 1;
    await click('directory-load-more');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(screen.getByTestId('directory-load-more')).toBeDisabled(); // one list read at a time
    expect(screen.getByTestId('directory-refresh')).toBeDisabled();
    const shown = screen.getAllByTestId('directory-row')[3];
    const second = [...server.rows[TENANT_A]].sort((x, y) => (x.name < y.name ? -1 : 1)).slice(50);
    const dup = { id: shown.getAttribute('data-id')!, name: shown.textContent! };
    server.held[0].release(new Response(JSON.stringify({ customers: [dup, ...second], nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(names()).toHaveLength(60));
    expect(lists(server).map((r) => r.url)).toEqual([CUSTOMERS_PATH, `${CUSTOMERS_PATH}?cursor=${cursor}`]);
    const ids = screen.getAllByTestId('directory-row').map((r) => r.getAttribute('data-id'));
    expect(new Set(ids).size).toBe(60);
    expect(names()).toEqual(Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`)); // arrival order kept
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
    expectNoSelector(server);
  });

  it('SCD-04. a cursor the server no longer accepts: ONE reload from page one, with a note, and no loop', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    // The customer the cursor names is deleted: the server answers its one 400 for that cursor.
    const last = screen.getAllByTestId('directory-row')[49].getAttribute('data-id')!;
    server.rows[TENANT_A] = server.rows[TENANT_A].filter((r) => r.id !== last);
    await click('directory-load-more');
    await waitFor(() => expect(screen.getByTestId('directory-list-note')).toHaveTextContent('loaded again from the start'));
    await ready();
    expect(lists(server).map((r) => r.url)).toEqual([CUSTOMERS_PATH, `${CUSTOMERS_PATH}?cursor=${encodeCustomerCursor(last)}`, CUSTOMERS_PATH]);
    expect(names()).toHaveLength(50);
    expect(names()).not.toContain('Customer 49');
    await settle();
    expect(lists(server)).toHaveLength(3); // the reload did not trigger itself again
    // A page one that itself answers 400 is an outage, never another reload.
    server.reads.push(400);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('unavailable'));
    await settle();
    expect(lists(server)).toHaveLength(4);
  });

  it('SCD-05. "Load more" that fails is a failed refresh: the rows stay under the last-known label and "Try again" reads page one (L1)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    for (const plan of [503, 'lost', 'html'] as ReadPlan[]) {
      server.reads.push(plan);
      await click('directory-load-more');
      await waitFor(() => expect(phase()).toBe('unavailable'));
      expect(names()).toHaveLength(50);
      expect(screen.getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
      expect(screen.queryByTestId('directory-list-note')).toBeNull();
      expect(screen.queryByTestId('directory-load-more')).toBeNull();
      expect(addButton()).toBeDisabled();
      await click('directory-retry'); // page one again
      await ready();
      expect(names()).toHaveLength(50);
    }
    await click('directory-load-more');
    await waitFor(() => expect(names()).toHaveLength(60));
    expect(screen.queryByTestId('directory-list-note')).toBeNull();
  });

  it('SCD-06. a 401 on the list, and a sign-in the server refuses: no rows, "Reconnect" runs the load again', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    server.reads.push(401);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(names()).toEqual([]); // nothing of the server's stays on screen
    expect(screen.queryByTestId('directory-last-known')).toBeNull();
    expect(screen.getByTestId('directory-retry')).toHaveTextContent('Reconnect');
    expect(addButton()).toBeDisabled();
    await click('directory-retry');
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    // The session is gone: Refresh finds it ended and signs nothing in (M7A-CUSTOMERS-P6); nothing is read.
    server.sessions.clear();
    server.logins.push(401);
    const before = lists(server).length;
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent('Your server session ended. Reconnect');
    expect(names()).toEqual([]);
    expect(lists(server)).toHaveLength(before);
    expect(logins(server)).toHaveLength(1);
    expect(server.logins).toEqual([401]); // the planned refusal is still unused: no login was sent
    // Reconnect signs in, and the server refuses the sign-in: the same state, and nothing is read.
    await click('directory-retry');
    await waitFor(() => expect(state()).toHaveTextContent('did not accept this sign-in'));
    expect(phase()).toBe('signed-out');
    expect(names()).toEqual([]);
    expect(lists(server)).toHaveLength(before);
    expect(logins(server)).toHaveLength(2);
    await click('directory-retry'); // Reconnect: ensure() signs in again
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(addButton()).toBeEnabled();
    expect(logins(server)).toHaveLength(3);
  });

  it('SCD-07. a 403 on the list is the denied state: rows cleared, no local fallback, no create', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    server.users['tok-a'].view = false; // the owner narrowed this role to None
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(state()).toHaveTextContent('This account may not view');
    expect(state()).toHaveAttribute('role', 'alert');
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-list')).toBeNull();
    expect(screen.queryByTestId('directory-empty')).toBeNull(); // a refusal is not an empty directory
    expect(addButton()).toBeDisabled();
    expect(screen.queryByTestId('directory-retry')).toBeNull();
    server.users['tok-a'].view = true;
    await click('directory-refresh');
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
  });

  it('SCD-08. a 429 on the list: the wait in seconds, last-known rows, and a retry that is disabled until the wait has passed', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    server.reads.push(429);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Too many requests. Wait 1 second, then try again.');
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(screen.getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
    expect(screen.getByTestId('directory-retry')).toHaveTextContent('Try again');
    expect(screen.getByTestId('directory-retry')).toBeDisabled();
    expect(addButton()).toBeDisabled();
    const before = server.sent.length;
    await waitFor(() => expect(screen.getByTestId('directory-retry')).toBeEnabled(), { timeout: 3000 });
    expect(server.sent).toHaveLength(before); // the wait re-enables the button; it sends nothing
    await click('directory-retry');
    await ready();
    expect(screen.queryByTestId('directory-last-known')).toBeNull();
    // Without a Retry-After the wait is a minute.
    server.retryAfter = null;
    server.reads.push(429);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Wait 60 seconds');
  });

  it('SCD-09. a 503, no answer, an HTML 200 and a 404: "Try again"; confirmed rows stay as last known, none confirmed shows none', async () => {
    for (const plan of [503, 'lost', 'html', 404] as ReadPlan[]) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Ada', 'Bob']);
      server.reads.push(plan);
      mount(server);
      await waitFor(() => expect(phase()).toBe('unavailable'));
      expect(state()).toHaveTextContent('The customer directory is unavailable right now.'); // S1: true whether or not the server answered
      expect(state()).not.toHaveTextContent('could not be reached');
      expect(names()).toEqual([]); // nothing confirmed in this generation
      expect(screen.queryByTestId('directory-last-known')).toBeNull();
      expect(screen.queryByTestId('directory-empty')).toBeNull(); // a failure is never an empty directory
      expect(screen.getByTestId('directory-retry')).toHaveTextContent('Try again');
      await click('directory-retry');
      await ready();
      expect(names()).toEqual(['Ada', 'Bob']);
      server.seed(TENANT_A, ['Cy']);
      server.reads.push(plan);
      await click('directory-refresh');
      await waitFor(() => expect(phase()).toBe('unavailable'));
      expect(names()).toEqual(['Ada', 'Bob']);
      expect(screen.getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
      expect(addButton()).toBeDisabled();
      await click('directory-retry');
      await ready();
      expect(names()).toEqual(['Ada', 'Bob', 'Cy']);
      expect(addButton()).toBeEnabled();
      cleanup();
    }
    // The server cannot be reached for the session either.
    const offline = fakeServer();
    offline.down = true;
    mount(offline);
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(lists(offline)).toHaveLength(0);
    offline.down = false;
    await click('directory-retry');
    await ready();
  });

  it('SCD-10. a detail by click shows its OWN answer, takes focus, and "Back" returns to the same list without reading it again', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    server.rows[TENANT_A].find((r) => r.id === ada.id)!.name = 'Ada Byron'; // renamed since the list was read
    await userEvent.setup().click(screen.getByRole('link', { name: 'Ada' }));
    const detail = await screen.findByTestId('directory-detail');
    await waitFor(() => expect(detail).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Byron$/); // never the list row's name
    expect(screen.getByTestId('directory-detail-id')).toHaveTextContent(ada.id);
    expect(screen.getByRole('heading', { level: 2, name: 'Customer' })).toHaveFocus();
    expect(details(server).map((r) => r.url)).toEqual([`${CUSTOMERS_PATH}/${ada.id}/profile`]); // the profile read
    expect(screen.queryByTestId('directory-state')).toBeNull();
    const listReads = lists(server).length;
    await userEvent.setup().click(screen.getByTestId('directory-back'));
    await waitFor(() => expect(screen.queryByTestId('directory-detail')).toBeNull());
    expect(phase()).toBe('ready');
    expect(names()).toEqual(['Ada', 'Bob']); // the list as it was read: it survived the detail
    expect(lists(server)).toHaveLength(listReads);
    expect(screen.getByRole('heading', { level: 2, name: 'Customers on the server' })).toHaveFocus();
    expectNoSelector(server);
  });

  it('SCD-11. a detail by direct address also reads the list, so "Back" shows a real list state', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server, { path: `/customers/directory/${ada.id}` });
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada');
    await waitFor(() => expect(lists(server)).toHaveLength(1)); // started on mount, whatever the route
    expect(logins(server)).toHaveLength(1); // one sign-in serves both reads
    expect(screen.getByTestId('directory-back')).toHaveAttribute('href', '/customers/directory');
    await userEvent.setup().click(screen.getByTestId('directory-back'));
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(lists(server)).toHaveLength(1);
  });

  it('SCD-12. a missing id, another store\'s id and a malformed id show ONE text; a malformed id is never sent', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    const [foreign] = server.seed(TENANT_B, ['Foreign']);
    const seen: string[] = [];
    const view = mount(server, { path: `/customers/directory/${uuid(0xdead)}` });
    for (const id of [uuid(0xdead), foreign.id]) {
      await view.go(`/customers/directory/${id}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found'));
      seen.push(screen.getByTestId('directory-detail').textContent ?? '');
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    }
    expect(details(server).map((r) => r.url)).toEqual([`${CUSTOMERS_PATH}/${uuid(0xdead)}/profile`, `${CUSTOMERS_PATH}/${foreign.id}/profile`]);
    await settle();
    const before = server.sent.length;
    for (const bad of ['new', foreign.id.toUpperCase(), `${foreign.id}x`, 'c1700000000000', '..%2Fsession%2Flogout', 'a%3Fcursor%3Dx']) {
      await view.go(`/customers/directory/${bad}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found'));
      seen.push(screen.getByTestId('directory-detail').textContent ?? '');
    }
    await settle();
    expect(details(server)).toHaveLength(2); // no request was built from a malformed id
    expect(server.sent).toHaveLength(before); // nothing at all was sent for one: not even a session read
    expect(new Set(seen).size).toBe(1); // identical, word for word
    expect(screen.getByTestId('directory-not-found')).toHaveTextContent(NOT_FOUND_TEXT);
    expect(page()).not.toContain('Foreign');
    expect(server.sent.every((r) => !r.url.includes('logout') && !r.url.includes('cursor'))).toBe(true);
  });

  it('SCD-13. a detail 200 that is not exactly this customer\'s profile is never shown', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const adaProfile = { id: ada.id, name: 'Ada', phone: null, email: null, createdAt: null };
    const bodies: unknown[] = [
      { customer: { ...adaProfile, id: bob.id, name: 'Bob' } }, // another customer's answer
      { customer: { id: ada.id, name: 'Ada' } }, // the detail's shape is not a profile
      { customer: { ...adaProfile, loyalty: 3 } },
      { customer: adaProfile, tenant: TENANT_A },
      { customer: { ...adaProfile, phone: ' +1 555 0100' } }, // not a stored value
      { customer: { ...adaProfile, createdAt: '2026-09-30T09:05:00Z' } },
      { customers: [{ id: ada.id, name: 'Ada' }], nextCursor: null },
    ];
    for (const body of bodies) {
      server.hold.reads = 2; // the list read and the detail read
      mount(server, { path: `/customers/directory/${ada.id}` });
      await waitFor(() => expect(server.held).toHaveLength(2));
      for (const h of server.held) {
        h.release(h.url === CUSTOMERS_PATH ? undefined : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      server.held.length = 0;
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'unavailable'));
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
      expect(screen.queryByTestId('directory-detail-id')).toBeNull();
      expect(screen.getByTestId('directory-detail-retry')).toHaveTextContent('Try again');
      cleanup();
    }
  });

  it('SCD-14. a late answer for another id is dropped: only the id the address names is shown', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const view = mount(server);
    await ready();
    server.hold.reads = 1;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(server.held).toHaveLength(1)); // Ada's read is out
    await view.go(`/customers/directory/${bob.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Bob$/);
    expect(details(server)[0].signal?.aborted).toBe(true); // the superseded read was cancelled
    server.held[0].release(); // Ada's answer arrives anyway
    await settle();
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Bob$/);
    expect(screen.getByTestId('directory-detail-id')).toHaveTextContent(bob.id);
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready');
    // Leaving the detail while its read is out: the answer is not applied to the list page either.
    server.hold.reads = 1;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(server.held).toHaveLength(2));
    await view.go('/customers/directory');
    server.held[1].release();
    await settle();
    expect(screen.queryByTestId('directory-detail')).toBeNull();
    expect(names()).toEqual(['Ada', 'Bob']);
  });

  it('SCD-15. a detail answered 401, 403, 429 or 503: its own state; an answer already shown for the same id stays as last known only when the server cannot be asked', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const view = mount(server, { path: `/customers/directory/${ada.id}` });
    const detail = () => screen.getByTestId('directory-detail');
    const reopen = async (id: string) => {
      await view.go('/customers/directory');
      await view.go(`/customers/directory/${id}`);
    };
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(screen.queryByTestId('directory-detail-retry')).toBeNull(); // ready: nothing to retry
    // 503 on a return to the SAME id: Ada's own earlier answer stays, labelled.
    server.reads.push(503);
    await reopen(ada.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'unavailable'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada$/);
    expect(screen.getByTestId('directory-detail-last-known')).toHaveTextContent('Last known');
    expect(screen.getByTestId('directory-detail-retry')).toHaveTextContent('Try again');
    await click('directory-detail-retry');
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    // 429: the same, with the wait; the retry is disabled until it has passed.
    server.reads.push(429);
    await reopen(ada.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'rate-limited'));
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent('Too many requests. Wait 1 second, then try again.');
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada$/);
    expect(screen.getByTestId('directory-detail-last-known')).toBeInTheDocument();
    expect(screen.getByTestId('directory-detail-retry')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('directory-detail-retry')).toBeEnabled(), { timeout: 3000 });
    await click('directory-detail-retry');
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    // ANOTHER id that cannot be read shows nothing: Ada's answer is never Bob's last known.
    server.reads.push(503);
    await view.go(`/customers/directory/${bob.id}`);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'unavailable'));
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(page()).not.toContain('Ada');
    await click('directory-detail-retry');
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Bob$/);
    // 403: the denied state shows nothing, even for the id just shown.
    server.users['tok-a'].view = false;
    await reopen(bob.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'denied'));
    expect(screen.getByTestId('directory-detail-state')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent('This account may not view');
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-retry')).toBeNull();
    server.users['tok-a'].view = true;
    await reopen(bob.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    // 401: the session ended — nothing shown; Reconnect reads again.
    server.reads.push(401);
    await reopen(bob.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(screen.getByTestId('directory-detail-retry')).toHaveTextContent('Reconnect');
    await click('directory-detail-retry');
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Bob$/);
    expect(details(server).every((r) => r.url === `${CUSTOMERS_PATH}/${ada.id}/profile` || r.url === `${CUSTOMERS_PATH}/${bob.id}/profile`)).toBe(true);
  });

  it('SCD-16. a create: ONE POST with the normalized name, this session\'s token and a fresh key; "Saved on the server" only after the 201', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    server.hold.posts = 1;
    await addCustomer('  Ada Lovelace  ');
    await waitFor(() => expect(server.held).toHaveLength(1));
    // Sent, not answered: held as "sending", and nothing says saved.
    expect(hold()).toHaveAttribute('data-state', 'sending');
    expect(screen.queryByTestId('directory-saved')).toBeNull();
    expect(screen.queryByTestId('directory-check-again')).toBeNull(); // the card's buttons exist only once unresolved
    expect(screen.queryByTestId('directory-stop-tracking')).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), body: '{"name":"Ada Lovelace"}', name: 'Ada Lovelace', state: 'sending' });
    server.held[0].release();
    const saved = await screen.findByTestId('directory-saved');
    expect(saved).toHaveTextContent('Saved on the server: "Ada Lovelace".');
    expect(saved).toHaveFocus();
    const made = server.rows[TENANT_A].find((r) => r.name === 'Ada Lovelace')!;
    expect(screen.getByTestId('directory-saved-link')).toHaveAttribute('href', `/customers/directory/${made.id}`);
    const [post] = posts(server);
    expect(posts(server)).toHaveLength(1);
    expect(post.body).toBe('{"name":"Ada Lovelace"}'); // the trimmed name, exactly these bytes
    expect(post.headers.get('idempotency-key')).toBe(key(1));
    expect(post.headers.get('x-tmpos-session-csrf')).toBe(server.csrfOfCookie());
    expect(post.headers.get('x-tmpos-csrf')).toBe('1');
    expect(post.headers.get('content-type')).toBe('application/json');
    await ready();
    expect(names()).toEqual(['Ada Lovelace', 'Bob']); // page one was read again
    expect(nameInput().value).toBe('');
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(view.holds.get('uid-a')).toBeUndefined();
    expect(addButton()).toBeEnabled();
    // The next customer is a new request under a new key; the same name again is a second customer.
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(posts(server)).toHaveLength(2));
    expect(posts(server)[1].headers.get('idempotency-key')).toBe(key(2));
    await waitFor(() => expect(names()).toEqual(['Ada Lovelace', 'Ada Lovelace', 'Bob']));
    expect(server.rows[TENANT_A].filter((r) => r.name === 'Ada Lovelace')).toHaveLength(2);
    // The saved notice's link opens that customer's own answer.
    await userEvent.setup().click(screen.getByTestId('directory-saved-link'));
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Lovelace$/);
    expectNoSelector(server);
  });

  it('SCD-17. a name the server would refuse is refused here: an inline error, NO request and NO key', async () => {
    const server = fakeServer();
    const view = mount(server);
    await ready();
    const before = server.sent.length;
    const refused = ['', '   ', 'x'.repeat(201), `Ada${String.fromCodePoint(0x202e)}`, `Ada${String.fromCodePoint(0x0)}`, `Ada\tLovelace`, String.fromCodePoint(0x2800), String.fromCodePoint(0x200b)];
    for (const raw of refused) {
      fireEvent.change(nameInput(), { target: { value: raw } });
      await click('directory-add');
      const error = await screen.findByTestId('directory-name-error');
      expect(error).toHaveTextContent(NAME_RULE_TEXT);
      expect(error).toHaveAttribute('role', 'alert');
      expect(nameInput()).toHaveAttribute('aria-invalid', 'true');
      expect(nameInput()).toHaveAttribute('aria-describedby', 'directory-name-error');
      expect(nameInput().value).toBe(raw); // the draft is kept
      expect(addButton()).toBeEnabled();
    }
    await settle();
    expect(server.sent).toHaveLength(before); // not even a session read
    expect(view.made).toEqual([]); // no key was taken
    expect(view.holds.get('uid-a')).toBeUndefined();
    // Editing clears the error; a valid name then goes out.
    fireEvent.change(nameInput(), { target: { value: 'x'.repeat(200) } });
    expect(screen.queryByTestId('directory-name-error')).toBeNull();
    expect(nameInput()).toHaveAttribute('aria-invalid', 'false');
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-18. a double click, and Enter with a click, send ONE POST', async () => {
    const server = fakeServer();
    const view = mount(server);
    await ready();
    server.hold.posts = 1;
    await typeName('Ada Lovelace');
    const button = addButton();
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.submit(button.closest('form')!);
    });
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { fireEvent.submit(button.closest('form')!); });
    await settle();
    expect(posts(server)).toHaveLength(1);
    expect(view.made).toHaveLength(1);
    server.held[0].release();
    await screen.findByTestId('directory-saved');
    await settle();
    expect(posts(server)).toHaveLength(1);
    expect(server.rows[TENANT_A]).toHaveLength(1);
  });

  it('SCD-19. a first send the server refuses outright ends the attempt with its own text, keeps the draft, and never says saved', async () => {
    const cases: Array<[number, RegExp]> = [
      [403, /^Refused by the server\./],
      [400, /^The server did not accept these customer details\. Nothing was added\.$/],
      [413, /^The server did not accept these customer details\./],
      [415, /^The server did not accept these customer details\./],
      [404, /does not offer adding customers here/],
      [422, /^The server rejected this request\.$/],
    ];
    for (const [status, text] of cases) {
      const server = fakeServer();
      server.posts.push(status);
      const view = mount(server, { keys: [key(1), key(2)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(createStatus()).toHaveTextContent(text));
      expect(createStatus()).toHaveAttribute('role', 'alert');
      expect(page()).not.toMatch(/Saved on the server:/);
      expect(screen.queryByTestId('directory-hold')).toBeNull(); // conclusive: nothing to check again
      expect(view.holds.get('uid-a')).toBeUndefined();
      expect(nameInput().value).toBe('Ada Lovelace');
      expect(server.rows[TENANT_A]).toEqual([]);
      await ready();
      if (status === 403) expect(lists(server)).toHaveLength(2); // the list was read again at once
      await waitFor(() => expect(addButton()).toBeEnabled()); // the form is not left disabled
      await click('directory-add');
      await screen.findByTestId('directory-saved');
      expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]); // a new request, a new key
      expect(createStatus()).toHaveTextContent('');
      cleanup();
    }
  });

  it('SCD-20. a first send answered 401: not sent through — rows cleared, Reconnect, the draft kept, then a new key', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    server.posts.push(401);
    mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(createStatus()).toHaveTextContent('Not sent through: your server session ended. Reconnect, then add again.');
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(screen.getByTestId('directory-add-hint')).toHaveTextContent('Available once the list has loaded from the server.');
    expect(nameInput().value).toBe('Ada Lovelace');
    await settle();
    expect(posts(server)).toHaveLength(1); // nothing is re-sent on its own
    await click('directory-retry');
    await ready();
    expect(posts(server)).toHaveLength(1); // reconnecting reads; it never sends the create
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]);
  });

  it('SCD-21. a first send answered 429: the wait is shown, Add is disabled until it has passed, and nothing is sent meanwhile', async () => {
    const server = fakeServer();
    server.posts.push(429);
    mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(createStatus()).toHaveTextContent('Not sent through: too many requests. Wait 1 second. Then add again.'));
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(screen.getByTestId('directory-add-hint')).toHaveTextContent('Wait 1 second.');
    expect(nameInput().value).toBe('Ada Lovelace');
    const before = server.sent.length;
    await waitFor(() => expect(addButton()).toBeEnabled(), { timeout: 3000 });
    expect(server.sent).toHaveLength(before); // the timer sends nothing
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]);
  });

  it('SCD-22. an undecided first send is UNRESOLVED — never saved, never "not saved" — and nothing is sent again on its own', async () => {
    const plans: PostPlan[] = ['rollback-503', 'commit-then-503', 'commit-then-409', 'commit-other-name', 'commit-bad-body', 'commit-200', 'lost-after-commit', 'lost-before', 500, 409];
    for (const plan of plans) {
      const server = fakeServer();
      server.posts.push(plan);
      const view = mount(server, { keys: [key(1)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
      expect(hold()).toHaveTextContent('Not confirmed yet: "Ada Lovelace". The server may have saved it.');
      expect(hold()).toHaveAttribute('data-detached', 'false');
      expect(page()).not.toMatch(/not saved/i);
      expect(page()).not.toMatch(/Saved on the server:/);
      expect(screen.queryByTestId('directory-saved')).toBeNull();
      expect(hold()).toHaveTextContent(STOP_WARNING_TEXT);
      expect(screen.getByTestId('directory-check-again')).toBeEnabled();
      expect(screen.getByTestId('directory-stop-tracking')).toBeEnabled();
      // The form: the field stays editable and keeps the draft; Add says why it is unavailable.
      expect(nameInput()).toBeEnabled();
      expect(nameInput().value).toBe('Ada Lovelace');
      expect(addButton()).toBeDisabled();
      expect(screen.getByTestId('directory-add-hint')).toHaveTextContent('An earlier customer is not confirmed yet.');
      expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), body: '{"name":"Ada Lovelace"}', state: 'unresolved' });
      // No timer, focus or refresh sends it again.
      await focusWindow();
      await click('directory-refresh');
      await ready();
      await settle();
      expect(posts(server)).toHaveLength(1);
      expect(hold()).toHaveAttribute('data-state', 'unresolved');
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('SCD-23. the reply is lost after the commit: "Check again" sends the SAME key and bytes, the replay confirms, and ONE customer exists', async () => {
    const server = fakeServer();
    server.posts.push('lost-after-commit');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent('No answer from the server.');
    expect(server.rows[TENANT_A]).toHaveLength(1); // it did commit; the page cannot know
    server.hold.posts = 1;
    const check = screen.getByTestId('directory-check-again');
    await act(async () => { // a double click before the card can re-render
      fireEvent.click(check);
      fireEvent.click(check);
    });
    await waitFor(() => expect(server.held).toHaveLength(1));
    await settle();
    expect(posts(server)).toHaveLength(2); // the first send and ONE check
    expect(hold()).toHaveAttribute('data-state', 'checking');
    expect(screen.queryByTestId('directory-check-again')).toBeNull(); // no second check while one is out
    expect(screen.queryByTestId('directory-stop-tracking')).toBeNull();
    server.held[0].release();
    const saved = await screen.findByTestId('directory-saved');
    expect(saved).toHaveTextContent('Saved on the server: "Ada Lovelace".');
    const [first, second] = posts(server);
    expect(posts(server)).toHaveLength(2);
    expect(second.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'));
    expect(second.headers.get('idempotency-key')).toBe(key(1));
    expect(second.body).toBe(first.body);
    expect(second.headers.get('x-tmpos-session-csrf')).toBe(first.headers.get('x-tmpos-session-csrf'));
    expect(view.made).toEqual([key(1)]); // no new key was taken for the check
    expect(server.rows[TENANT_A]).toHaveLength(1);
    await waitFor(() => expect(names()).toEqual(['Ada Lovelace']));
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(screen.getByTestId('directory-saved-link')).toHaveAttribute('href', `/customers/directory/${server.rows[TENANT_A][0].id}`);
    await waitFor(() => expect(addButton()).toBeEnabled());
    expectNoSelector(server);
  });

  it('SCD-24. unresolved, then the name is edited: "Check again" still sends the ORIGINAL bytes and key', async () => {
    const server = fakeServer();
    server.posts.push('rollback-503');
    mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await typeName('Grace Hopper'); // the field is never what is re-sent
    // Inside the lease the same key is still in progress.
    await click('directory-check-again');
    await waitFor(() => expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent('The server is still working on it.'));
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(page()).not.toMatch(/not saved/i);
    server.expireLeases(); // the lease ran out: the same key is planned again and commits once
    await click('directory-check-again');
    const saved = await screen.findByTestId('directory-saved');
    expect(saved).toHaveTextContent('"Ada Lovelace"');
    expect(posts(server)).toHaveLength(3);
    expect(new Set(posts(server).map((r) => r.body))).toEqual(new Set(['{"name":"Ada Lovelace"}']));
    expect(new Set(posts(server).map((r) => r.headers.get('idempotency-key')))).toEqual(new Set([key(1)]));
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Ada Lovelace']);
    expect(nameInput().value).toBe('Grace Hopper'); // R2: a confirmation clears the draft only when it still is the confirmed name
  });

  it('SCD-25. a check that does not confirm stays unresolved with its reason — a 401, 403, 429, 503, 422 or another name never says "not saved"; after the 401 the ended session has detached it (M7B-INVOICES-P1-R2), so only the others are checked again', async () => {
    const cases: Array<[PostPlan, RegExp]> = [
      [401, /Sign-in needed/],
      [403, /The server refused this check\./],
      [429, /Too many requests\. Wait 1 second\./],
      [503, /The server answered, but not with a result\./],
      ['lost-before', /No answer from the server\./],
      [422, /no longer accepts this as the same request/],
      [400, /did not accept this check/],
      [404, /does not offer this check here/],
      [409, /still working on it/],
      [200, /The server answered, but not with a result\./],
    ];
    for (const [plan, reason] of cases) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Bob']);
      server.posts.push('commit-then-503', plan);
      const view = mount(server, { keys: [key(1), key(2)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      const listsBefore = lists(server).length;
      await click('directory-check-again');
      await waitFor(() => expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent(reason));
      expect(hold()).toHaveAttribute('data-state', 'unresolved');
      // A 401 ends the session as the page knows it: the attempt is detached by that end and no longer named.
      expect(hold()).toHaveTextContent(plan === 401 ? ENDED_TEXT.unresolved : unresolvedText('Ada Lovelace'));
      expect(page()).not.toMatch(/not saved/i);
      expect(page()).not.toMatch(/Saved on the server:/);
      expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'unresolved' }); // still held, whatever the answer
      if (plan === 401) {
        await waitFor(() => expect(phase()).toBe('signed-out')); // the list handling: nothing of the server's stays
        expect(names()).toEqual([]);
        expect(hold()).toHaveAttribute('data-detached', 'true');
        expect(view.holds.get('uid-a')).toMatchObject({ csrf: null, body: '', ended: true });
        await click('directory-retry');
        await ready();
        // Detached for good: no Check again, and nothing is sent again under any session.
        expect(screen.queryByTestId('directory-check-again')).toBeNull();
        expect(posts(server)).toHaveLength(2);
        cleanup();
        continue;
      } else if (plan === 403) {
        await waitFor(() => expect(lists(server).length).toBe(listsBefore + 1)); // view access re-proved at once
      } else if (plan === 429) {
        expect(screen.getByTestId('directory-check-again')).toBeDisabled();
        await waitFor(() => expect(screen.getByTestId('directory-check-again')).toBeEnabled(), { timeout: 3000 });
      }
      await ready();
      // The key still decides it: the sealed 201 of the first send.
      await click('directory-check-again');
      await screen.findByTestId('directory-saved');
      expect(new Set(posts(server).map((r) => `${r.headers.get('idempotency-key')} ${r.body}`)).size).toBe(1);
      expect(server.rows[TENANT_A].filter((r) => r.name === 'Ada Lovelace')).toHaveLength(1);
      cleanup();
    }
  });

  it('SCD-26. unresolved, then the account\'s grant moves: "Check again" sends NOTHING under the new connection and the attempt is detached for good', async () => {
    const server = fakeServer();
    server.seed(TENANT_B, ['Bea']);
    server.posts.push('lost-before'); // it never reached the server: the key is absent, so another tenant would accept it
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    server.moveGrant('tok-a', TENANT_B);
    // The move ended the session: "Check again" finds it ended and sends nothing — no login, no POST (M7A-CUSTOMERS-P6);
    // that end detaches it at once (M7B-INVOICES-P1-R2, DA-200).
    await click('directory-check-again');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(logins(server)).toHaveLength(1);
    expect(posts(server)).toHaveLength(1);
    await click('directory-retry'); // Reconnect: the new session is the other store's
    await waitFor(() => expect(hold()).toHaveAttribute('data-detached', 'true'));
    await ready();
    expect(logins(server)).toHaveLength(2);
    expect(posts(server)).toHaveLength(1); // NO POST under the new session
    expect(server.rows[TENANT_B].map((r) => r.name)).toEqual(['Bea']); // and no row in the other tenant
    expect(server.rows[TENANT_A]).toEqual([]);
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    expect(screen.getByTestId('directory-hold-detached')).toHaveTextContent('It was sent under an earlier connection and cannot be checked from here.');
    expect(screen.getByTestId('directory-hold-detached')).toHaveTextContent('a row with the same name is not proof');
    expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT);
    expect(names()).toEqual(['Bea']); // the rows of the store that answers now
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), csrf: null, state: 'unresolved' }); // its token is dropped
    expect(page()).not.toMatch(/not saved/i);
    expect(addButton()).toBeDisabled(); // still tracked: adding the same name again could make a second customer
    // Going back to a session of the first store does not re-attach it: detached for good.
    server.moveGrant('tok-a', TENANT_A);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('signed-out')); // ended again: Refresh signs nothing in
    expect(logins(server)).toHaveLength(2);
    await click('directory-retry');
    await ready();
    expect(logins(server)).toHaveLength(3);
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    await focusWindow();
    await settle();
    expect(posts(server)).toHaveLength(1);
    // "Stop tracking" is the way on: the next add is a new request under a new key.
    await click('directory-stop-tracking');
    await ready();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]);
    expectNoSelector(server);
  });

  it('SCD-27. a session another tab replaced is noticed on focus: rows cleared and read again, the attempt detached, nothing sent', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.seed(TENANT_B, ['Bea']);
    server.posts.push('commit-then-503');
    mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Cy');
    await unresolved();
    const first = server.csrfOfCookie();
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a'); // the cookie now names a session of another store; the old session still stands
    expect(server.csrfOfCookie()).not.toBe(first);
    const before = posts(server).length;
    await focusWindow();
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
    await ready();
    expect(names()).toEqual(['Bea']);
    expect(page()).not.toContain('Ada');
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    expect(posts(server)).toHaveLength(before);
    expect(server.rows[TENANT_B].map((r) => r.name)).toEqual(['Bea']);
    // A hidden tab does not connect at all.
    const sent = server.sent.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(server.sent).toHaveLength(sent);
  });

  it('SCD-28. the session changes while the list read is out: the old read is cancelled and its late answer shows nothing', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Alan']);
    server.seed(TENANT_B, ['Bea']);
    mount(server);
    await ready();
    server.hold.reads = 1;
    await click('directory-refresh'); // store A's rows, decided on arrival, answer held
    await waitFor(() => expect(server.held).toHaveLength(1));
    const old = lists(server)[lists(server).length - 1];
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a');
    await focusWindow();
    await waitFor(() => expect(names()).toEqual(['Bea']));
    expect(old.signal?.aborted).toBe(true);
    server.held[0].release(); // the old store's page arrives now
    await settle();
    expect(names()).toEqual(['Bea']);
    expect(phase()).toBe('ready');
    expect(page()).not.toContain('Ada');
    expect(screen.getByTestId('directory-refresh')).toBeEnabled(); // no read flag was left set
    expect(addButton()).toBeEnabled();
  });

  it('SCD-29. a newer list read supersedes an older one in the same connection: the late page is not appended', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    server.hold.reads = 1;
    await click('directory-load-more');
    await waitFor(() => expect(server.held).toHaveLength(1));
    const more = lists(server)[1];
    await addCustomer('Ada Lovelace'); // confirmed: page one is read again while "Load more" is still out
    await screen.findByTestId('directory-saved');
    await waitFor(() => expect(names()[0]).toBe('Ada Lovelace'));
    expect(more.signal?.aborted).toBe(true);
    expect(names()).toHaveLength(50);
    server.held[0].release(); // the superseded second page arrives
    await settle();
    expect(names()).toHaveLength(50);
    expect(names()[0]).toBe('Ada Lovelace');
    expect(screen.getByTestId('directory-load-more')).toBeEnabled();
  });

  it('SCD-30. the session changes while a detail read is out: the old answer is never shown under the new connection', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.seed(TENANT_B, ['Bea']);
    const view = mount(server);
    await ready();
    server.hold.reads = 1;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a');
    await focusWindow();
    // The new connection reads the same address: in the other store this id is not available.
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found'));
    server.held[0].release(); // store A's 200 for Ada arrives
    await settle();
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found');
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(page()).not.toContain('Ada');
    expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument();
  });

  it('SCD-31. Add under a connection that has changed sends NOTHING: a note, the draft kept, and a create only after a new click', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.seed(TENANT_B, ['Bea']);
    const view = mount(server, { keys: [key(1)] });
    await ready();
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a'); // unnoticed so far: the page still shows store A
    expect(names()).toEqual(['Ada']);
    await addCustomer('Cy');
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
    await ready();
    await settle();
    expect(posts(server)).toHaveLength(0); // nothing was sent, under either token
    expect(view.made).toEqual([]);
    expect(view.holds.get('uid-a')).toBeUndefined();
    expect(server.rows[TENANT_B].map((r) => r.name)).toEqual(['Bea']);
    expect(names()).toEqual(['Bea']); // the list to check first
    expect(nameInput().value).toBe('Cy');
    expect(addButton()).toBeEnabled();
    // A deliberate second click creates it in the store the page now shows.
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server)).toHaveLength(1);
    expect(posts(server)[0].headers.get('x-tmpos-session-csrf')).toBe(server.csrfOfCookie());
    expect(server.rows[TENANT_B].map((r) => r.name).sort()).toEqual(['Bea', 'Cy']);
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Ada']);
    expect(screen.queryByTestId('directory-connection-changed')).toBeNull();
  });

  it('SCD-32. the connection changes while a create is out: its late 201 is a plain notice with no link, and a late undecided answer stays detached', async () => {
    for (const late of ['201', '503'] as const) {
      const server = fakeServer();
      server.seed(TENANT_B, ['Bea']);
      if (late === '503') server.posts.push('commit-then-503');
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace'); // executed by store A on arrival; the answer is held
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.users['tok-a'].tenant = TENANT_B;
      server.otherTab('tok-a');
      await focusWindow(); // a focus connect never runs while a create is out
      await settle();
      expect(screen.queryByTestId('directory-connection-changed')).toBeNull();
      await click('directory-refresh'); // a read notices the new connection
      await waitFor(() => expect(names()).toEqual(['Bea']));
      expect(hold()).toHaveAttribute('data-state', 'sending');
      expect(hold()).toHaveAttribute('data-detached', 'true');
      server.held[0].release();
      if (late === '201') {
        await waitFor(() => expect(screen.getByTestId('directory-saved-earlier')).toHaveTextContent(savedEarlierText('Ada Lovelace')));
        expect(screen.queryByTestId('directory-saved')).toBeNull();
        expect(screen.queryByTestId('directory-saved-link')).toBeNull(); // no address of another store's customer
        expect(screen.queryByTestId('directory-hold')).toBeNull();
        expect(view.holds.get('uid-a')).toBeUndefined(); // the late answer was reconciled by key, not dropped
      } else {
        await unresolved();
        expect(hold()).toHaveAttribute('data-detached', 'true');
        expect(screen.queryByTestId('directory-check-again')).toBeNull();
        expect(page()).not.toMatch(/not saved/i);
      }
      await settle();
      expect(names()).toEqual(['Bea']); // the late answer moved nothing in the new store's list
      expect(page()).not.toContain('"Ada Lovelace". View');
      expect(posts(server)).toHaveLength(1);
      expect(server.rows[TENANT_B].map((r) => r.name)).toEqual(['Bea']);
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('SCD-33. an attempt older than 23 hours cannot be checked: no button, no request', async () => {
    const server = fakeServer();
    server.posts.push('commit-then-503');
    let t = 1_000;
    mount(server, { keys: [key(1)], now: () => t });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    t += CHECK_CUTOFF_MS - 1;
    await click('directory-refresh');
    await ready();
    expect(screen.getByTestId('directory-check-again')).toBeEnabled(); // one millisecond inside the cutoff
    t += 1;
    // The clock passes the cutoff with the button still on screen: a click sends nothing and the card says why.
    await click('directory-check-again');
    await waitFor(() => expect(screen.queryByTestId('directory-check-again')).toBeNull());
    expect(screen.getByTestId('directory-hold-detached')).toHaveTextContent('It was sent too long ago and cannot be checked from here.');
    expect(hold()).toHaveAttribute('data-detached', 'false'); // too old, not detached
    expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
    await settle();
    expect(posts(server)).toHaveLength(1);
    expect(page()).not.toMatch(/not saved/i);
    expect(screen.getByTestId('directory-stop-tracking')).toBeEnabled();
  });

  it('SCD-34. "Stop tracking" warns first, forgets the attempt, reads page one, and the next add is a new key', async () => {
    const server = fakeServer();
    server.posts.push('commit-then-503');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    const stop = screen.getByTestId('directory-stop-tracking');
    expect(document.getElementById(stop.getAttribute('aria-describedby')!)).toHaveTextContent(STOP_WARNING_TEXT);
    expect(STOP_WARNING_TEXT).toMatch(/does not cancel the request/);
    expect(STOP_WARNING_TEXT).toMatch(/can create a second customer/);
    const before = lists(server).length;
    await click('directory-stop-tracking');
    await waitFor(() => expect(screen.queryByTestId('directory-hold')).toBeNull());
    expect(view.holds.get('uid-a')).toBeUndefined();
    await waitFor(() => expect(lists(server)).toHaveLength(before + 1));
    await waitFor(() => expect(names()).toEqual(['Ada Lovelace'])); // it had committed: the directory shows it
    expect(posts(server)).toHaveLength(1); // stopping sent nothing
    await waitFor(() => expect(addButton()).toBeEnabled());
    await click('directory-add'); // the same name again, deliberately: a second customer under a new key
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]);
    expect(server.rows[TENANT_A]).toHaveLength(2);
  });

  it('SCD-35. an unresolved attempt survives leaving the page and coming back, and can still be checked with its own key and bytes', async () => {
    const server = fakeServer();
    server.posts.push('lost-after-commit');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await view.go('/elsewhere');
    expect(screen.queryByTestId('customer-directory')).toBeNull();
    await settle();
    expect(posts(server)).toHaveLength(1); // nothing is sent because the page went away
    await view.go('/customers/directory');
    await ready();
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(hold()).toHaveAttribute('data-detached', 'false'); // the same session answers: the same token
    expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
    expect(nameInput().value).toBe(''); // only the attempt is kept, not the draft
    expect(addButton()).toBeDisabled();
    await settle();
    expect(posts(server)).toHaveLength(1); // a remount sends nothing either
    await click('directory-check-again');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => `${r.headers.get('idempotency-key')} ${r.body}`)).toEqual([`${key(1)} {"name":"Ada Lovelace"}`, `${key(1)} {"name":"Ada Lovelace"}`]);
    expect(server.rows[TENANT_A]).toHaveLength(1);
  });

  it('SCD-36. an answer that arrives after the page has gone settles the attempt in the store only: nothing is read or sent by the old page', async () => {
    for (const late of ['201', '503'] as const) {
      const server = fakeServer();
      if (late === '503') server.posts.push('commit-then-503');
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere'); // the create is not cancelled by leaving
      expect(posts(server)[0].signal?.aborted ?? false).toBe(false);
      expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'sending' });
      const sent = server.sent.length;
      server.held[0].release();
      await settle();
      expect(server.sent).toHaveLength(sent); // the page that left reads nothing and sends nothing
      if (late === '201') expect(view.holds.get('uid-a')).toBeUndefined(); // confirmed: not dropped
      else expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'unresolved' });
      await view.go('/customers/directory');
      await ready();
      if (late === '201') {
        expect(screen.queryByTestId('directory-hold')).toBeNull();
        expect(names()).toEqual(['Ada Lovelace']);
        expect(addButton()).toBeEnabled();
      } else {
        expect(hold()).toHaveAttribute('data-state', 'unresolved');
        expect(screen.getByTestId('directory-check-again')).toBeEnabled();
      }
      expect(posts(server)).toHaveLength(1);
      cleanup();
    }
  });

  it('SCD-37. one user\'s attempt is never shown to another, and comes back with its own user', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.seed(TENANT_B, ['Bea']);
    server.posts.push('commit-then-503');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Cy');
    await unresolved();
    act(() => access.set({ uid: 'uid-b' }));
    // The first render after the switch already shows nothing of the previous user.
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(names()).toEqual([]);
    expect(nameInput().value).toBe('');
    await waitFor(() => expect(names()).toEqual(['Bea']));
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(page()).not.toContain('Cy');
    expect(addButton()).toBeEnabled(); // user B is not blocked by user A's attempt
    expect(view.holds.get('uid-b')).toBeUndefined();
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'unresolved' });
    act(() => access.set({ uid: 'uid-a' }));
    await waitFor(() => expect(names()).toEqual(['Ada', 'Cy']));
    expect(hold()).toHaveTextContent(unresolvedText('Cy'));
    // Signed in again, user A has another session: the attempt is detached and cannot be re-sent from here.
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-38. nobody signed in: the sign-in-needed state and no request at all', async () => {
    const server = fakeServer();
    access.set({ uid: null });
    mount(server);
    await settle();
    expect(phase()).toBe('signed-out');
    expect(state()).toHaveTextContent('Sign in with your store account');
    expect(screen.queryByTestId('directory-retry')).toBeNull();
    expect(screen.queryByTestId('directory-refresh')).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(server.sent).toHaveLength(0);
    // A signed-in user this browser holds no identity for: the same state, nothing sent, and a way to try again.
    cleanup();
    access.set({ uid: 'uid-a' });
    const none = fakeServer();
    mount(none, { tokens: {} });
    await waitFor(() => expect(phase()).toBe('signed-out'));
    // Only the session read (none held: 401) leaves; no login is sent without the user's own ID token (P5-R1).
    expect(none.sent.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(screen.getByTestId('directory-retry')).toHaveTextContent('Reconnect');
  });

  it('SCD-39. a rate-limited sign-in shows the server\'s delay when it names one, and a minute when it does not', async () => {
    const server = fakeServer();
    server.retryAfter = '2';
    server.logins.push(429);
    mount(server);
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Too many requests. Wait 2 seconds, then try again.');
    expect(screen.getByTestId('directory-retry')).toBeDisabled();
    expect(lists(server)).toHaveLength(0);
    cleanup();
    const silent = fakeServer();
    silent.retryAfter = null;
    silent.logins.push(429);
    mount(silent);
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Wait 60 seconds');
    // The session read before a create is limited: nothing is sent, the draft stays.
    cleanup();
    const busy = fakeServer();
    mount(busy);
    await ready();
    busy.checks.push(429);
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(createStatus()).toHaveTextContent('Not sent. Too many requests. Wait 1 second, then try again.');
    expect(posts(busy)).toHaveLength(0);
    expect(nameInput().value).toBe('Ada Lovelace');
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('directory-retry')).toBeEnabled(), { timeout: 3000 });
    await click('directory-retry');
    await ready();
    await waitFor(() => expect(addButton()).toBeEnabled());
  });

  it('SCD-40. the permission is narrowed while the page is open: the create is refused with no customer, then None is the denied state', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    mount(server, { keys: [key(1), key(2)] });
    await ready();
    server.users['tok-a'].create = false; // narrowed to View on the server; the page's hint still says it may add
    expect(addButton()).toBeEnabled();
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(createStatus()).toHaveTextContent(/^Refused by the server\./));
    expect(page()).not.toMatch(/Saved on the server:/);
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Bob']);
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(nameInput().value).toBe('Ada Lovelace');
    await ready();
    expect(names()).toEqual(['Bob']); // the list is not hidden: viewing is still allowed
    expect(lists(server)).toHaveLength(2);
    // The local hint follows: no form, only a note — the server was the one that decided.
    act(() => access.set({ canCreate: false }));
    expect(screen.queryByTestId('directory-add')).toBeNull();
    expect(screen.queryByTestId('directory-name')).toBeNull();
    expect(screen.getByTestId('directory-create-unavailable')).toHaveTextContent('does not include adding customers');
    server.users['tok-a'].view = false; // narrowed to None
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(names()).toEqual([]);
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-41. the unresolved card is shown even when the local hint no longer offers the form', async () => {
    const server = fakeServer();
    server.posts.push('commit-then-503');
    mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    act(() => access.set({ canCreate: false }));
    expect(screen.queryByTestId('directory-add')).toBeNull();
    expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
    await click('directory-check-again');
    await screen.findByTestId('directory-saved');
    expect(posts(server)).toHaveLength(2);
    expect(server.rows[TENANT_A]).toHaveLength(1);
  });

  it('SCD-42. focus connects read only: no list read and no create, and overlapping focus events share the session client\'s one in-flight read', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    const before = server.sent.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(screen.queryByTestId('directory-connection-changed')).toBeNull(); // the same token: nothing changes
    expect(names()).toEqual(['Ada']);
    // A later focus sends its own read once the first is judged. That takes a Web Crypto digest whose time varies with
    // load, and a focus before then shares the first read, so focus until one is sent rather than guess the turns.
    for (let i = 0; i < 50 && server.sent.length - before < 2; i++) {
      await focusWindow();
      await settle();
    }
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${TENANT_SESSION_PATHS.current}`]);
  });

  it('SCD-45. a page that mounts while a create is still out does not connect on focus until that create has answered', async () => {
    const server = fakeServer();
    server.posts.push('commit-then-503');
    const view = mount(server, { keys: [key(1)] });
    await ready();
    server.hold.posts = 1;
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await view.go('/customers/directory'); // a new page instance; the earlier one's create is still out
    await ready();
    expect(hold()).toHaveAttribute('data-state', 'sending');
    expect(addButton()).toBeDisabled();
    const before = server.sent.length;
    await focusWindow();
    await settle();
    expect(server.sent).toHaveLength(before); // no connect while a create is out
    server.held[0].release();
    await unresolved();
    await focusWindow();
    await settle();
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]); // answered: reads only
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-46. a create that settles after its page has gone is shown by the page that is mounted (or mounts) meanwhile: never silently dropped (R1, T2)', async () => {
    // A 201 that settles while a NEW page instance is mounted: the notice, and page one is read again.
    {
      const server = fakeServer();
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      await view.go('/customers/directory');
      await ready();
      expect(hold()).toHaveAttribute('data-state', 'sending');
      const reads = lists(server).length;
      server.held[0].release();
      const notice = await screen.findByTestId('directory-saved');
      expect(notice).toHaveTextContent('Saved on the server: "Ada Lovelace".');
      expect(screen.getByTestId('directory-saved-link')).toBeInTheDocument();
      await waitFor(() => expect(names()).toEqual(['Ada Lovelace']));
      // The row was already on page one (the fake commits before it holds the answer), so wait for the re-read itself:
      // it follows the page's session check.
      await waitFor(() => expect(lists(server)).toHaveLength(reads + 1)); // page one was read again, once
      expect(screen.queryByTestId('directory-hold')).toBeNull();
      expect(posts(server)).toHaveLength(1);
      cleanup();
    }
    // A conclusive refusal that settles the same way shows its text, naming the customer, and never "saved".
    {
      const server = fakeServer();
      server.posts.push(403);
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      await view.go('/customers/directory');
      await ready();
      server.held[0].release();
      await waitFor(() => expect(createStatus()).toHaveTextContent('"Ada Lovelace" was not added: the server refused that request.'));
      expect(createStatus()).toHaveAttribute('role', 'alert');
      expect(screen.queryByTestId('directory-saved')).toBeNull();
      expect(page()).not.toMatch(/Saved on the server: /i);
      expect(screen.queryByTestId('directory-hold')).toBeNull();
      cleanup();
    }
    // Settled while NO page was mounted: the next page to hold a session token shows it, once.
    {
      const server = fakeServer();
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      server.held[0].release();
      await settle();
      expect(view.holds.get('uid-a')).toBeUndefined();
      await view.go('/customers/directory');
      expect(await screen.findByTestId('directory-saved')).toHaveTextContent('"Ada Lovelace"');
      await ready();
      expect(names()).toEqual(['Ada Lovelace']);
      await view.go('/elsewhere');
      await view.go('/customers/directory');
      await ready();
      expect(screen.queryByTestId('directory-saved')).toBeNull(); // shown once, then forgotten
      cleanup();
    }
    // Sent under another connection than the one the page now holds: the "earlier connection" notice, and a read.
    {
      const server = fakeServer();
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      server.otherTab('tok-a'); // a new session of the same store; the old one still stands
      server.held[0].release();
      await settle();
      await view.go('/customers/directory');
      expect(await screen.findByTestId('directory-saved-earlier')).toHaveTextContent(savedEarlierText('Ada Lovelace'));
      expect(screen.queryByTestId('directory-saved-link')).toBeNull();
      await waitFor(() => expect(names()).toEqual(['Ada Lovelace']));
    }
  });

  it('SCD-47. a confirmation from an earlier connection names the customer, reads page one again, and clears the draft only when it still is that name (R2)', async () => {
    for (const typed of ['Zed', null] as const) {
      const server = fakeServer();
      server.seed(TENANT_B, ['Bea']);
      mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.users['tok-a'].tenant = TENANT_B;
      server.otherTab('tok-a');
      await click('directory-refresh'); // a read notices the new connection
      await waitFor(() => expect(names()).toEqual(['Bea']));
      if (typed !== null) await typeName(typed);
      const reads = lists(server).length;
      server.held[0].release();
      await waitFor(() => expect(screen.getByTestId('directory-saved-earlier')).toHaveTextContent('"Ada Lovelace" was saved on the server under the earlier connection.'));
      await waitFor(() => expect(lists(server)).toHaveLength(reads + 1)); // page one is read again
      expect(nameInput().value).toBe(typed ?? ''); // another name typed meanwhile stays; the confirmed one is cleared
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('SCD-48. a 403 or 401 clears BOTH the list and the detail, whichever read got it (R3, T1)', async () => {
    for (const refusal of [403, 401] as const) {
      const denied = refusal === 403;
      const wanted = denied ? 'denied' : 'signed-out';
      const detailServer = fakeServer();
      const [bea] = detailServer.seed(TENANT_A, ['Bea', 'Cy']);
      const direct = mount(detailServer);
      await ready();
      await direct.go(`/customers/directory/${bea.id}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
      await direct.go('/customers/directory');
      await ready();
      if (denied) detailServer.users['tok-a'].view = false; else detailServer.reads.push(401);
      await direct.go(`/customers/directory/${bea.id}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', wanted));
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
      await click('directory-back');
      expect(phase()).toBe(wanted);
      expect(names()).toEqual([]);
      expect(screen.queryByTestId('directory-list')).toBeNull();
      expect(screen.queryByTestId('directory-load-more')).toBeNull();
      expect(addButton()).toBeDisabled();
      cleanup();
      // A list read answered 403 / 401 while a detail is shown: the detail shows nothing of the customer.
      const both = fakeServer();
      const [dee] = both.seed(TENANT_A, ['Dee']);
      both.posts.push('rollback-503');
      const page2 = mount(both, { keys: [key(1)] });
      await ready();
      await addCustomer('Ed');
      await unresolved();
      await page2.go(`/customers/directory/${dee.id}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
      expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Dee');
      if (denied) both.users['tok-a'].view = false; else both.reads.push(401);
      await click('directory-stop-tracking'); // reads page one again, which is refused
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', wanted));
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
      expect(page()).not.toContain('Dee');
      cleanup();
    }
  });

  it('SCD-49. "Load more" answered 403, 401 or 429 (T3)', async () => {
    const seeded = (): Server => {
      const server = fakeServer();
      server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
      return server;
    };
    const denied = seeded();
    mount(denied);
    await ready();
    denied.users['tok-a'].view = false;
    await click('directory-load-more');
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
    cleanup();
    const out = seeded();
    mount(out);
    await ready();
    out.reads.push(401);
    await click('directory-load-more');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
    await click('directory-retry'); // Reconnect reads page one
    await ready();
    expect(names()).toHaveLength(50);
    expect(lists(out).at(-1)?.url).toBe(CUSTOMERS_PATH);
    cleanup();
    const limitedServer = seeded();
    mount(limitedServer);
    await ready();
    limitedServer.reads.push(429);
    await click('directory-load-more');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(names()).toHaveLength(50); // the rows stay, under the last-known label
    expect(screen.getByTestId('directory-last-known')).toBeInTheDocument();
    expect(screen.getByTestId('directory-retry')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('directory-retry')).toBeEnabled(), { timeout: 3000 });
  });

  it('SCD-50. a focus check that finds the session definitely gone clears the page; one the server cannot answer changes nothing (R4, T4)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    for (const plan of [503, 429]) { // unavailable / rate-limited teach nothing
      server.checks.push(plan);
      await focusWindow();
      await settle();
      expect(phase()).toBe('ready');
      expect(names()).toEqual(['Ada']);
      expect(screen.queryByTestId('directory-connection-changed')).toBeNull();
    }
    // The session has ended: no rows any more, and the focus check signs nothing in (M7A-CUSTOMERS-P6) — the planned
    // refusal stays unused. Its Reconnect is what signs in: refused here, the same state.
    server.sessions.clear();
    server.logins.push(401);
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent('Your server session ended. Reconnect');
    expect(names()).toEqual([]);
    expect(addButton()).toBeDisabled();
    expect(logins(server)).toHaveLength(1);
    expect(server.logins).toEqual([401]);
    await click('directory-retry');
    await waitFor(() => expect(state()).toHaveTextContent('did not accept this sign-in'));
    expect(names()).toEqual([]);
    expect(logins(server)).toHaveLength(2);
    // With no identity to sign in with, the same: ended on focus (no ID token asked), and the Reconnect finds nobody.
    cleanup();
    const tokens: Record<string, string> = { 'uid-a': 'tok-a' };
    const other = fakeServer();
    other.seed(TENANT_A, ['Ada']);
    mount(other, { tokens });
    await ready();
    other.sessions.clear();
    delete tokens['uid-a'];
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent('Your server session ended. Reconnect');
    expect(names()).toEqual([]);
    await click('directory-retry');
    await waitFor(() => expect(state()).toHaveTextContent('Sign in with your store account'));
    expect(names()).toEqual([]);
    expect(logins(other)).toHaveLength(1); // the first load's only
  });

  it('SCD-51. a shorter Retry-After never shortens a running wait, and "Stop tracking" during a wait reads nothing (R6, T5)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.reads.push({ limited: '60' }, { limited: '1' }); // the list and the detail are read together on a direct address
    mount(server, { path: `/customers/directory/${ada.id}` });
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'rate-limited'));
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent('Wait 60 seconds'); // Z5: the wait that runs, not the answer's 1
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(screen.getByTestId('directory-detail-retry')).toBeDisabled(); // the 60-second wait still runs
    cleanup();
    // A check answered 429 starts a wait; stopping tracking meanwhile sends no read.
    const held = fakeServer();
    held.retryAfter = '30';
    held.posts.push('rollback-503', 429);
    mount(held, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await click('directory-check-again');
    await waitFor(() => expect(screen.getByTestId('directory-check-again')).toBeDisabled());
    const before = held.sent.length;
    await click('directory-stop-tracking');
    await settle();
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(held.sent).toHaveLength(before);
  });

  it('SCD-52. no read starts during a rate limit\'s wait: a detail opened then shows the wait and sends nothing (S3)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.retryAfter = '30';
    mount(server);
    await ready();
    server.reads.push(429);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    const before = server.sent.length;
    await userEvent.setup().click(screen.getByRole('link', { name: 'Ada' })); // the rows stay as last known
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'rate-limited'));
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent(/Too many requests\. Wait \d+ seconds?, then try again\./);
    expect(screen.getByTestId('directory-detail-retry')).toBeDisabled();
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    await settle();
    expect(server.sent).toHaveLength(before);
    expect(details(server)).toHaveLength(0);
    expect(ada.name).toBe('Ada');
  });

  it('SCD-53. the page\'s own store is the module-level one: an unresolved attempt survives leaving and coming back with no injected store (T6)', async () => {
    access.set({ uid: 'uid-default-store' });
    const server = fakeServer();
    server.users['tok-c'] = { uid: 'uid-default-store', tenant: TENANT_A, view: true, create: true, edit: true };
    server.posts.push('lost-after-commit');
    const view = mount(server, { defaultHolds: true, tokens: { 'uid-default-store': 'tok-c' }, keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await view.go('/elsewhere');
    await view.go('/customers/directory');
    await ready();
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
    await click('directory-stop-tracking'); // leave the module-level store clean for the other cases
    expect(screen.queryByTestId('directory-hold')).toBeNull();
  });

  it('SCD-54. React holds no session token: the hold snapshot is a token-free view (R5)', async () => {
    const server = fakeServer();
    server.posts.push('lost-after-commit');
    mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    const csrf = server.csrfOfCookie()!;
    expect(csrf).not.toBe('');
    type Fiber = { return: Fiber | null; child: Fiber | null; sibling: Fiber | null; type: unknown; memoizedState: { memoizedState: unknown; queue: { getSnapshot?: unknown } | null; next: unknown } | null };
    const root = screen.getByTestId('customer-directory');
    const fiberKey = Object.keys(root).find((k) => k.startsWith('__reactFiber$'))!;
    let top = (root as unknown as Record<string, Fiber>)[fiberKey];
    while (top.return !== null) top = top.return;
    const snapshots: string[] = [];
    const walk = (fiber: Fiber | null): void => {
      for (let f = fiber; f !== null; f = f.sibling) {
        if (typeof f.type === 'function') {
          for (let h = f.memoizedState; h !== null && h !== undefined; h = h.next as typeof h) {
            if (h.queue !== null && typeof h.queue === 'object' && typeof h.queue.getSnapshot === 'function') snapshots.push(JSON.stringify(h.memoizedState) ?? '');
          }
        }
        walk(f.child);
      }
    };
    walk(top);
    expect(snapshots.some((text) => text.includes(key(1)))).toBe(true); // the walk does see the attempt's snapshot
    for (const text of snapshots) expect(text).not.toContain(csrf);
  });

  it('SCD-55. the empty message and both last-known labels live inside the existing status paragraphs; a row link is a 24 px block target (A1, A2)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    expect(screen.getByRole('link', { name: 'Ada' }).className).toMatch(/\bblock\b/);
    expect(screen.getByRole('link', { name: 'Ada' }).className).toContain('min-h-[24px]');
    server.rows[TENANT_A].length = 0;
    await click('directory-refresh');
    await waitFor(() => expect(within(state()).getByTestId('directory-empty')).toHaveTextContent(EMPTY_TEXT));
    const [ada] = server.seed(TENANT_A, ['Ada']);
    await click('directory-refresh');
    await waitFor(() => expect(names()).toEqual(['Ada']));
    server.reads.push(503);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(within(state()).getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
    expect(screen.getAllByRole('status').filter((el) => el.contains(screen.getByTestId('directory-last-known')))).toHaveLength(1);
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await view.go('/customers/directory');
    server.reads.push(503);
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'unavailable'));
    expect(within(screen.getByTestId('directory-detail-state')).getByTestId('directory-detail-last-known')).toHaveTextContent('Last known');
  });

  it('SCD-56. a page-one read blocked by a rate-limit wait runs once when the wait ends: after a confirmed create and after a first-send refusal (Z1)', async () => {
    for (const planned of ['ok', 403] as const) {
      const server = fakeServer();
      server.retryAfter = '2';
      if (planned === 403) server.posts.push(403);
      mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.reads.push(429);
      await click('directory-refresh'); // a wait starts while the create is out
      await waitFor(() => expect(phase()).toBe('rate-limited'));
      const before = lists(server).length;
      server.held[0].release();
      if (planned === 'ok') {
        await screen.findByTestId('directory-saved'); // the notice does not wait
        expect(names()).toEqual([]);
      } else {
        await waitFor(() => expect(createStatus()).toHaveTextContent('Refused by the server.'));
      }
      await settle();
      expect(lists(server)).toHaveLength(before); // nothing is read during the wait
      await waitFor(() => expect(phase()).toBe('ready'), { timeout: 4000 });
      expect(lists(server)).toHaveLength(before + 1); // ONE read when it ended, with no click
      if (planned === 'ok') expect(names()).toEqual(['Ada Lovelace']);
      expect(posts(server)).toHaveLength(1); // a read, never a create
      cleanup();
    }
  }, 15_000); // two real 2 s waits: above the 5 s default

  it('SCD-57. a refusal supersedes reads already in flight: a late 200 repaints neither the list nor the detail (Z2)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    server.hold.reads = 1;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.sessions.clear();
    server.logins.push(401);
    await focusWindow(); // the session is definitely gone: found ended, with no login (M7A-CUSTOMERS-P6)
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(logins(server)).toHaveLength(1);
    expect(server.logins).toEqual([401]); // unused
    server.held[0].release(); // the read answered 200 before the session ended
    await settle();
    expect(phase()).toBe('signed-out');
    expect(names()).toEqual([]);
    cleanup();
    const both = fakeServer();
    const [dee] = both.seed(TENANT_A, ['Dee']);
    both.posts.push('rollback-503');
    const view = mount(both, { keys: [key(1)] });
    await ready();
    await addCustomer('Ed');
    await unresolved();
    both.hold.reads = 1;
    await view.go(`/customers/directory/${dee.id}`);
    await waitFor(() => expect(both.held).toHaveLength(1)); // the detail read is out
    both.reads.push(403);
    await click('directory-stop-tracking'); // the list read that follows is refused
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'denied'));
    both.held[0].release();
    await settle();
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'denied');
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
  });

  it('SCD-58. a refused list does not stamp its refusal on a customer opened later (Z3)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await view.go('/customers/directory');
    await ready();
    server.users['tok-a'].view = false;
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('denied'));
    server.users['tok-a'].view = true;
    const rendered: string[] = []; // every text a text node held before it was replaced
    const observer = new MutationObserver((records) => { for (const r of records) if (r.oldValue !== null) rendered.push(r.oldValue); });
    observer.observe(document.body, { subtree: true, characterData: true, characterDataOldValue: true });
    server.hold.reads = 1;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(server.held).toHaveLength(1));
    await flush();
    observer.disconnect();
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'loading');
    expect(rendered.join('|')).not.toContain('may not view');
    server.held[0].release();
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
  });

  it('SCD-59. an outcome shown from the store does not steal focus from the name field (Z4)', async () => {
    const server = fakeServer();
    const view = mount(server, { keys: [key(1)] });
    await ready();
    server.hold.posts = 1;
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await view.go('/customers/directory');
    await ready();
    act(() => { nameInput().focus(); });
    expect(document.activeElement).toBe(nameInput());
    server.held[0].release();
    await screen.findByTestId('directory-saved');
    await settle();
    expect(document.activeElement).toBe(nameInput());
  });

  it('SCD-60. a focus during a rate-limit wait sends no session check (Z6)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.retryAfter = '30';
    mount(server);
    await ready();
    server.reads.push(429);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    const before = server.sent.length;
    await focusWindow();
    await settle();
    expect(server.sent).toHaveLength(before);
  });

  it('SCD-61. a first-send refusal that settles while a customer is open is visible there (Z9)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.posts.push(403);
    const view = mount(server, { keys: [key(1)] });
    await ready();
    server.hold.posts = 1;
    await addCustomer('Bob');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    server.held[0].release();
    await waitFor(() => expect(createStatus()).toHaveTextContent('Refused by the server.'));
    expect(createStatus()).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada');
  });

  it('SCD-43. the directory writes nothing into local customer state, browser storage or the console, and holds no store of its own there', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const before = { local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie };
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    server.posts.push('lost-after-commit');
    const view = mount(server);
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await click('directory-check-again');
    await screen.findByTestId('directory-saved');
    await view.go(`/customers/directory/${bob.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await view.go('/customers/directory');
    server.reads.push(503);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(before.local);
    expect(window.sessionStorage.length).toBe(before.session);
    expect(document.cookie).toBe(before.cookie);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    // No name, id, key or token rides an address: the only query the page ever builds is the server's cursor.
    expect(view.router.state.location.search).toBe('');
    for (const r of server.sent) if (r.url.includes('?')) expect(r.url).toMatch(/^\/api\/v1\/customers\?cursor=[A-Za-z0-9_-]{23}$/);
    // The shipped modules reach none of those sinks, and never the local customer state.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['ServerCustomerDirectory.tsx', 'customersClient.ts']) {
      const source = readFileSync(resolve(here, file), 'utf8');
      expect(source).not.toMatch(/StoreLocalState|useStoreLocalState|localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
      expect(source).not.toMatch(/from\s+['"][^'"]*server\//); // nothing of the server's is bundled
    }
  });

  it('SCD-44. App.tsx routes the list and the detail as ONE guarded route, which the /customers/:id redirect does not swallow', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(resolve(here, '../App.tsx'), 'utf8');
    expect(app).toContain(`{ path: '/customers/directory/:id?', element: <AccessGuard feature="customers"><CustomerDirectoryPage /></AccessGuard> }`);
    expect(app.match(/CustomerDirectoryPage \/>/g)).toHaveLength(1);
    // The same two patterns in a router: the directory wins over the older redirect, with and without an id.
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    expect(screen.queryByTestId('local-customers')).toBeNull();
    const pageBefore = screen.getByTestId('customer-directory');
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('customer-directory')).toBe(pageBefore); // one mounted page for both
    await view.go('/customers/something-else');
    expect(screen.getByTestId('local-customers')).toBeInTheDocument(); // the old redirect still stands for every other id
  });

  // M7A-CUSTOMERS-P5-R1 (DA-138) — a read names the session the page checked; another session's cookie reads nothing.
  it('SCD-62. another user signs in in another tab between the session check and the list read: the read is refused, nothing of theirs is shown, and the page reconnects as its own user', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    server.seed(TENANT_B, ['Mallory', 'Trent']);
    mount(server);
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    const before = server.sent.length;
    server.swapOnRead = 'tok-b';
    await click('directory-refresh');
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']); // A's rows, read again under A's new session
    expect(page()).not.toContain('Mallory');
    expect(page()).not.toContain('Trent');
    const after = server.sent.slice(before).map((r) => `${r.method} ${r.url}`);
    expect(after).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, // checked A, then the read arrived with B's cookie: 403
      `GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.login}`, `GET ${TENANT_SESSION_PATHS.current}`, // B's session is not A's: A signs in
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, // a new connection checks, then reads again
    ]);
    expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument();
    expectNoSelector(server);
  });

  it('SCD-63. the same for a customer opened by address: the detail read is refused, and only the page\'s own customer is shown', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const [mallory] = server.seed(TENANT_B, ['Mallory']);
    const view = mount(server);
    await ready();
    server.swapOnRead = 'tok-b';
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail')).toHaveTextContent('Ada');
    expect(page()).not.toContain('Mallory');
    expect(details(server).every((r) => !r.url.includes(mallory.id))).toBe(true);
    expect(details(server).length).toBeGreaterThanOrEqual(2); // the refused read, then the new connection's
  });

  it('SCD-64. a 403 under the session the page holds is a real refusal: ONE session check, then the denied state, and no loop', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    server.users['tok-a'].view = false;
    const before = server.sent.length;
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('denied'));
    await settle();
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1); // the first load's only
  });
  // M7A-CUSTOMERS-P5-R1 — the one session check after a 403: a check that cannot decide never keeps a refused read's data.
  const deniedThenCheck = async (server: Server, check: number): Promise<number> => {
    server.users['tok-a'].view = false;
    server.hold.reads = 1;
    const before = server.sent.length;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.checks.push(check); // the check sent AFTER the 403, not the one before the read
    await act(async () => { server.held[0].release(); });
    return before;
  };

  it('SCD-65. a list read refused 403 whose session check answers 503: the list is cleared, no login, no further read', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    const before = await deniedThenCheck(server, 503);
    await waitFor(() => expect(phase()).toBe('denied'));
    await settle();
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-list')).toBeNull();
    expect(screen.queryByTestId('directory-last-known')).toBeNull();
    expect(page()).not.toContain('Ada');
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1); // the first load's only
  });

  it('SCD-66. the same with a 429 on the check: the list is cleared, the check\'s wait runs and is shown, no login', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    server.retryAfter = '2';
    mount(server);
    await ready();
    const before = await deniedThenCheck(server, 429);
    await waitFor(() => expect(phase()).toBe('denied'));
    await settle();
    expect(names()).toEqual([]);
    expect(page()).not.toContain('Ada');
    expect(screen.getByTestId('directory-refresh')).toBeDisabled(); // the wait runs
    expect(document.getElementById('directory-busy-hint')).toHaveTextContent('Wait 2 seconds.');
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-67. a detail read refused 403 whose session check answers 503: the customer shown before is not shown', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await view.go('/customers/directory');
    await ready();
    server.users['tok-a'].view = false;
    server.hold.reads = 1;
    const before = server.sent.length;
    await view.go(`/customers/directory/${ada.id}`); // the same id: its last answer would be the fallback
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.checks.push(503);
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'denied'));
    await settle();
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(page()).not.toContain('Ada');
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}/${ada.id}/profile`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-68. "Load more" refused 403 under the session the page holds: denied after exactly one session check', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    server.users['tok-a'].view = false;
    const before = server.sent.length;
    await click('directory-load-more');
    await waitFor(() => expect(phase()).toBe('denied'));
    await settle();
    expect(names()).toEqual([]);
    const after = server.sent.slice(before).map((r) => `${r.method} ${r.url}`);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(`GET ${TENANT_SESSION_PATHS.current}`);
    expect(after[1]).toMatch(/^GET \/api\/v1\/customers\?cursor=[A-Za-z0-9_-]{23}$/);
    expect(after[2]).toBe(`GET ${TENANT_SESSION_PATHS.current}`);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-69. a detail read refused 403 under the session the page holds: denied after exactly one session check', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    server.users['tok-a'].view = false;
    const before = server.sent.length;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'denied'));
    await settle();
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}/${ada.id}/profile`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-70. a reopened page with a new session client reuses the session the browser holds: one login overall', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    const starts: number[] = [];
    for (let open = 0; open < 3; open++) {
      starts.push(server.sent.length);
      mount(server); // a new session client each time, over the same browser cookie
      await ready();
      expect(names()).toEqual(['Ada', 'Bob']);
      cleanup();
    }
    for (const at of starts) expect(`${server.sent[at].method} ${server.sent[at].url}`).toBe(`GET ${TENANT_SESSION_PATHS.current}`);
    expect(logins(server)).toHaveLength(1);
    expect(server.sent.slice(starts[1]).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`,
    ]);
  });

  it('SCD-71. a first session read answered 429 or 503 at mount signs nothing in and reads nothing', async () => {
    for (const [check, wanted] of [[429, 'rate-limited'], [503, 'unavailable']] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Ada']);
      server.checks.push(check);
      mount(server);
      await waitFor(() => expect(phase()).toBe(wanted));
      await settle();
      expect(server.sent.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
      expect(logins(server)).toHaveLength(0);
      expect(names()).toEqual([]);
      cleanup();
    }
  });
  it('SCD-72. the session check after a 403 is a read sent AFTER it: a check already in flight with the old token does not answer for it', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    const oldCsrf = server.csrfOfCookie();
    // The Refresh's list read is parked; meanwhile a focus reconnect sends a session read, answered (and parked) with the old token.
    server.hold.reads = 1;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(2));
    const [listRead, inFlight] = server.held;
    expect(inFlight.url).toBe(TENANT_SESSION_PATHS.current);
    // Another tab replaces the cookie with a new session of the same user; the parked list read then arrives refused.
    server.otherTab('tok-a');
    const newCsrf = server.csrfOfCookie();
    expect(newCsrf).not.toBe(oldCsrf);
    const sessionReads = () => server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.current).length;
    const readsBefore = sessionReads();
    await act(async () => { listRead.release(new Response(JSON.stringify({ error: 'forbidden', requestId: 'req-synthetic' }), { status: 403, headers: { 'content-type': 'application/json' } })); });
    await settle();
    expect(sessionReads()).toBe(readsBefore); // the check waits for the read already out; it does not join its answer
    await act(async () => { inFlight.release(); }); // the old token
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument());
    await ready();
    expect(sessionReads()).toBeGreaterThan(readsBefore); // a session read sent after the 403
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(lists(server).at(-1)?.headers.get('x-tmpos-session-csrf')).toBe(newCsrf); // the new session's answer is the one acted on
    expect(logins(server)).toHaveLength(1);
  });

  // M7A-CUSTOMERS-P6 — a session this page confirmed that the server then ends (expiry, revocation, a logout elsewhere) is
  // never re-established on its own: everything the page does by itself finds it ended and signs nothing in; only a
  // Reconnect click logs in, once. `server.sessions.clear()` is the real end (a customer read's 401 alone keeps the session).
  const ENDED = 'Your server session ended. Reconnect to see the customers saved on the server.';
  const tabReturn = async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  it('SCD-73. a confirmed session that ends: Refresh, Load more, a focus, a tab return and Add each find it ended — NO login, nothing of the server\'s shown, Reconnect offered — and only Reconnect logs in, once', async () => {
    for (const trigger of ['refresh', 'more', 'focus', 'visibility', 'add'] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
      mount(server);
      await ready();
      expect(names()).toHaveLength(50);
      expect(logins(server)).toHaveLength(1);
      if (trigger === 'add') await typeName('Ada Lovelace');
      server.sessions.clear(); // expired or revoked in the store; the browser still presents its cookie
      const before = lists(server).length;
      if (trigger === 'refresh') await click('directory-refresh');
      if (trigger === 'more') await click('directory-load-more');
      if (trigger === 'focus') await focusWindow();
      if (trigger === 'visibility') await tabReturn();
      if (trigger === 'add') await click('directory-add');
      await waitFor(() => expect(phase(), trigger).toBe('signed-out'));
      expect(state(), trigger).toHaveTextContent(ENDED);
      expect(names(), trigger).toEqual([]); // rows and cursor cleared
      expect(screen.queryByTestId('directory-load-more'), trigger).toBeNull();
      expect(screen.queryByTestId('directory-last-known'), trigger).toBeNull();
      expect(screen.getByTestId('directory-retry'), trigger).toHaveTextContent('Reconnect');
      expect(addButton(), trigger).toBeDisabled();
      expect(lists(server), trigger).toHaveLength(before); // nothing read without a session
      if (trigger === 'add') {
        expect(createStatus()).toHaveTextContent(`Not sent. ${ENDED}`);
        expect(nameInput()).toHaveValue('Ada Lovelace'); // the draft kept
      }
      // Nothing else that runs on its own signs in either.
      await focusWindow();
      await tabReturn();
      await settle();
      expect(phase(), trigger).toBe('signed-out');
      expect(logins(server), trigger).toHaveLength(1);
      expect(posts(server), trigger).toHaveLength(0);
      // Reconnect: exactly one login, and the rows are back.
      await click('directory-retry');
      await ready();
      expect(logins(server), trigger).toHaveLength(2);
      expect(names(), trigger).toHaveLength(50);
      expect(posts(server), trigger).toHaveLength(0);
      cleanup();
    }
  });

  it('SCD-74. a customer opened after the session ended sends NO login and shows nothing of it, through route changes and a focus; its Reconnect logs in once and shows it', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const view = mount(server);
    await ready();
    server.sessions.clear(); // not yet noticed by the page
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent(ENDED);
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.getByTestId('directory-detail-retry')).toHaveTextContent('Reconnect');
    await view.go('/customers/directory'); // back to the list: cleared by the same refusal
    expect(phase()).toBe('signed-out');
    expect(names()).toEqual([]);
    await view.go(`/customers/directory/${bob.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    await focusWindow();
    await settle();
    expect(logins(server)).toHaveLength(1);
    expect(details(server)).toHaveLength(0);
    await click('directory-detail-retry');
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Bob'));
    expect(logins(server)).toHaveLength(2);
    await view.go('/customers/directory');
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(logins(server)).toHaveLength(2);
  });

  it('SCD-75. an uncertain create, then the session ends: "Check again" and "Stop tracking" send NO login and NO POST; the end that Check again finds detaches the attempt for good (M7B-INVOICES-P1-R2: its token and body go, its name is no longer shown); Reconnect logs in once — never re-sent', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bea']);
    server.posts.push('lost-before');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    server.sessions.clear();
    await click('directory-check-again');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(ENDED);
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(hold()).toHaveTextContent(ENDED_TEXT.unresolved);
    expect(hold()).not.toHaveTextContent('Ada Lovelace');
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), csrf: null, body: '', ended: true, state: 'unresolved' });
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent(`Not checked. ${ENDED}`);
    expect(names()).toEqual([]);
    expect(logins(server)).toHaveLength(1);
    expect(posts(server)).toHaveLength(1);
    await click('directory-retry'); // Reconnect
    await ready();
    expect(logins(server)).toHaveLength(2);
    expect(hold()).toHaveAttribute('data-detached', 'true'); // still detached for good under the new connection
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), csrf: null, state: 'unresolved' });
    expect(posts(server)).toHaveLength(1);
    // It ends again: "Stop tracking" forgets the attempt, and the page-one read it starts signs nothing in.
    server.sessions.clear();
    await click('directory-stop-tracking');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(logins(server)).toHaveLength(2);
    await click('directory-retry');
    await ready();
    expect(names()).toEqual(['Bea']);
    expect(logins(server)).toHaveLength(3);
    expect(posts(server)).toHaveLength(1);
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Bea']);
  });

  it('SCD-76. a read refused 403 whose session check finds the session ended: no login, the ended state, nothing shown', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    server.reads.push(403);
    server.hold.reads = 1;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.sessions.clear(); // the session ends while the refused read is on its way back
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(ENDED);
    expect(names()).toEqual([]);
    await settle();
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-77. after the session ended, a valid session of the same user (another tab signed in) is reused on focus: no login, the rows read under it', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(logins(server)).toHaveLength(1);
    server.otherTab('tok-a');
    await focusWindow();
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
    await ready();
    expect(names()).toEqual(['Ada']);
    expect(logins(server)).toHaveLength(1);
    expect(lists(server).at(-1)?.headers.get('x-tmpos-session-csrf')).toBe(server.csrfOfCookie());
  });

  it('SCD-78. the stated residual: a page opened afresh while the cookie names an ended session signs in once, as a first load (the 401 does not say "expired", and nothing is stored to tell)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    cleanup();
    server.sessions.clear();
    mount(server); // a reload: a new session client that has confirmed nothing yet
    await ready();
    expect(logins(server)).toHaveLength(2);
    expect(names()).toEqual(['Ada']);
  });

  it('SCD-79. an automatic session check that answers `ended` while a Reconnect waits on it never cancels that Reconnect: the list, then a customer, each come back with exactly one more login', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    // A focus check is out when Reconnect is pressed; the check answers `ended` first, then the Reconnect logs in.
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-retry');
    await act(async () => { server.held[0].release(); });
    await ready();
    expect(names()).toEqual(['Ada']);
    expect(logins(server)).toHaveLength(2);
    // The same for a customer opened after the session ended again: a tab return is out when its Reconnect is pressed.
    server.held.length = 0;
    server.sessions.clear();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    server.hold.checks = 1;
    await tabReturn();
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-detail-retry');
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada'));
    await settle();
    expect(logins(server)).toHaveLength(3);
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready');
  });

  it('SCD-80. a saved notice does not outlive the session: once a focus finds it ended, neither "Saved on the server" nor the earlier-connection notice stays', async () => {
    {
      const server = fakeServer();
      server.seed(TENANT_A, ['Bea']);
      mount(server, { keys: [key(1)] });
      await ready();
      await addCustomer('Ada Lovelace'); // a validated 201
      await waitFor(() => expect(screen.getByTestId('directory-saved')).toHaveTextContent('Saved on the server: "Ada Lovelace".'));
      await waitFor(() => expect(names()).toEqual(['Ada Lovelace', 'Bea']));
      server.sessions.clear();
      await focusWindow();
      await waitFor(() => expect(phase()).toBe('signed-out'));
      expect(screen.queryByTestId('directory-saved')).toBeNull();
      expect(screen.queryByTestId('directory-saved-link')).toBeNull();
      expect(names()).toEqual([]);
      expect(logins(server)).toHaveLength(1);
      cleanup();
    }
    {
      const server = fakeServer();
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      server.otherTab('tok-a');
      server.held[0].release();
      await settle();
      await view.go('/customers/directory');
      expect(await screen.findByTestId('directory-saved-earlier')).toHaveTextContent(savedEarlierText('Ada Lovelace'));
      await waitFor(() => expect(names()).toEqual(['Ada Lovelace']));
      server.sessions.clear();
      await focusWindow();
      await waitFor(() => expect(phase()).toBe('signed-out'));
      expect(screen.queryByTestId('directory-saved-earlier')).toBeNull();
      expect(logins(server)).toHaveLength(1);
      cleanup();
    }
    // A settled refusal names the customer too: it does not outlive the session either.
    {
      const server = fakeServer();
      server.posts.push(403);
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      await view.go('/customers/directory');
      await ready();
      server.held[0].release();
      await waitFor(() => expect(createStatus()).toHaveTextContent('"Ada Lovelace" was not added: the server refused that request.'));
      server.sessions.clear();
      await focusWindow();
      await waitFor(() => expect(phase()).toBe('signed-out'));
      expect(createStatus().textContent).toBe('');
      expect(page()).not.toMatch(/Ada Lovelace/);
      expect(logins(server)).toHaveLength(1);
      cleanup();
    }
    // What must stay does: the hold of an uncertain create and its reason outlive the session's end.
    {
      const server = fakeServer();
      server.posts.push('rollback-503');
      mount(server, { keys: [key(1)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      await click('directory-check-again'); // inside the lease: still in progress
      await waitFor(() => expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent('The server is still working on it.'));
      server.sessions.clear();
      await focusWindow();
      await waitFor(() => expect(phase()).toBe('signed-out'));
      expect(hold()).toHaveAttribute('data-state', 'unresolved');
      expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent('The server is still working on it.');
      expect(logins(server)).toHaveLength(1);
    }
  });

  it('SCD-81. a plain read of the OTHER view that finds the session ended never cancels a Reconnect already pressed: the customer comes back with exactly one more login, and nothing is re-sent', async () => {
    const server = fakeServer();
    const [bea] = server.seed(TENANT_A, ['Bea']);
    server.posts.push('lost-before');
    const view = mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await view.go(`/customers/directory/${bea.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Bea'));
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    server.hold.checks = 1;
    await click('directory-stop-tracking'); // a plain page-one read of the list, whose session read is held
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-detail-retry'); // Reconnect, before that read answers
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Bea'));
    await settle();
    expect(logins(server)).toHaveLength(2);
    expect(posts(server)).toHaveLength(1);
    await view.go('/customers/directory');
    await ready();
    expect(names()).toEqual(['Bea']);
    expect(logins(server)).toHaveLength(2);
  });

  it('SCD-82. a focus check that finds the session ended after "Back to directory" (a route change, no read) still clears: the old rows never come back as ready, and nothing logs in', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada'));
    server.sessions.clear();
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/customers/directory'); // leaving the detail moves its read counter and starts no read
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(names()).toEqual([]);
    expect(page()).not.toMatch(/Ada/);
    await settle();
    expect(logins(server)).toHaveLength(1);
  });

  // M7A-CUSTOMERS-P6 — contact records: an optional phone and email on a create, and the customer's profile.
  const phoneInput = () => screen.getByTestId('directory-phone') as HTMLInputElement;
  const emailInput = () => screen.getByTestId('directory-email') as HTMLInputElement;
  const fill = (fields: { name?: string; phone?: string; email?: string }) => {
    if (fields.name !== undefined) fireEvent.change(nameInput(), { target: { value: fields.name } });
    if (fields.phone !== undefined) fireEvent.change(phoneInput(), { target: { value: fields.phone } });
    if (fields.email !== undefined) fireEvent.change(emailInput(), { target: { value: fields.email } });
  };
  const PHONE = '+1 555 0100';
  const EMAIL = 'ada@example.test';
  const FULL_BODY = `{"name":"Ada Lovelace","phone":"${PHONE}","email":"${EMAIL}"}`;
  const openDetail = async (view: ReturnType<typeof mount>, id: string) => {
    await view.go(`/customers/directory/${id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
  };

  it('SCD-83. the fake server takes an optional phone and email by the server\'s own rules, answers the 201 without them, and serves the profile', async () => {
    const server = fakeServer();
    const send = (method: string, url: string, headers: Record<string, string> = {}, body?: string) => server.fetch(url, { method, headers, body });
    const login = await send('POST', TENANT_SESSION_PATHS.login, { authorization: 'Bearer tok-a', 'x-tmpos-csrf': '1' });
    const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    const post = (k: string, body: string) =>
      send('POST', CUSTOMERS_PATH, { 'content-type': 'application/json', 'x-tmpos-csrf': '1', 'x-tmpos-session-csrf': csrf, 'idempotency-key': k }, body);
    const bound = { 'x-tmpos-session-csrf': csrf };
    expect((await post(key(1), JSON.stringify({ name: 'Ada', phone: 'no digits' }))).status).toBe(400);
    expect((await post(key(2), JSON.stringify({ name: 'Ada', email: 'ada example.test' }))).status).toBe(400);
    expect((await post(key(3), JSON.stringify({ name: 'Ada', phone: 7 }))).status).toBe(400);
    expect((await post(key(4), JSON.stringify({ name: 'Ada', loyalty: 1 }))).status).toBe(400);
    expect((await post(key(5), JSON.stringify({ phone: PHONE }))).status).toBe(400);
    expect(server.rows[TENANT_A]).toEqual([]);
    const made = await post(key(6), JSON.stringify({ name: 'Ada Lovelace', phone: ` ${PHONE} `, email: EMAIL }));
    expect(made.status).toBe(201);
    const { customer } = (await made.json()) as { customer: Row };
    expect(Object.keys(customer)).toEqual(['id', 'name']); // the 201 stays { id, name }
    const profile = await (await send('GET', `${CUSTOMERS_PATH}/${customer.id}/profile`, bound)).json();
    expect(profile).toEqual({ customer: { id: customer.id, name: 'Ada Lovelace', phone: PHONE, email: EMAIL, createdAt: '2026-09-30T09:05:00.001Z' } });
    expect(Object.keys((profile as { customer: object }).customer)).toEqual(['id', 'name', 'phone', 'email', 'createdAt']);
    expect(await (await send('GET', `${CUSTOMERS_PATH}/${customer.id}`, bound)).json()).toEqual({ customer: { id: customer.id, name: 'Ada Lovelace' } });
    const [old] = server.seed(TENANT_A, ['Old']);
    expect(await (await send('GET', `${CUSTOMERS_PATH}/${old.id}/profile`, bound)).json()).toEqual({ customer: { id: old.id, name: 'Old', ...LEGACY } });
    const [foreign] = server.seed(TENANT_B, ['Foreign']);
    expect((await send('GET', `${CUSTOMERS_PATH}/${foreign.id}/profile`, bound)).status).toBe(404);
    expect((await send('GET', `${CUSTOMERS_PATH}/${old.id}/profile`)).status).toBe(403); // the profile names its session too
    expect((await send('GET', `${CUSTOMERS_PATH}/${old.id}/other`, bound)).status).toBe(404);
  });

  it('SCD-84. the form: Name required, Phone and Email optional; every invalid field says so, the first takes focus, and NOTHING is sent and no key taken', async () => {
    const server = fakeServer();
    const view = mount(server);
    await ready();
    expect(screen.getByLabelText('Customer name (required)')).toBe(nameInput());
    expect(nameInput()).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Phone (optional)')).toBe(phoneInput());
    expect(screen.getByLabelText('Email (optional)')).toBe(emailInput());
    for (const input of [phoneInput(), emailInput()]) {
      expect(input).not.toHaveAttribute('aria-required');
      expect(input).toHaveAttribute('aria-invalid', 'false');
      expect(input).not.toHaveAttribute('aria-describedby');
    }
    const before = server.sent.length;
    const errorOf = (field: 'name' | 'phone' | 'email') => screen.queryByTestId(`directory-${field}-error`);
    const cases: Array<[{ name: string; phone: string; email: string }, Array<'name' | 'phone' | 'email'>]> = [
      [{ name: 'Ada', phone: 'no digits', email: '' }, ['phone']],
      [{ name: 'Ada', phone: '', email: 'ada example.test' }, ['email']],
      [{ name: 'Ada', phone: '1'.repeat(65), email: 'a@b@c' }, ['phone', 'email']],
      [{ name: '   ', phone: `+1${String.fromCodePoint(0x202e)}555`, email: '@example.test' }, ['name', 'phone', 'email']],
      [{ name: 'Ada', phone: ' ', email: `${'a'.repeat(242)}@example.test` }, ['email']],
      [{ name: '', phone: PHONE, email: EMAIL }, ['name']],
    ];
    const RULES = { name: NAME_RULE_TEXT, phone: PHONE_RULE_TEXT, email: EMAIL_RULE_TEXT } as const;
    const inputOf = { name: nameInput, phone: phoneInput, email: emailInput } as const;
    for (const [fields, invalid] of cases) {
      fill(fields);
      await click('directory-add');
      await waitFor(() => expect(errorOf(invalid[0])).not.toBeNull());
      for (const field of ['name', 'phone', 'email'] as const) {
        const input = inputOf[field]();
        if (invalid.includes(field)) {
          expect(errorOf(field)).toHaveTextContent(RULES[field]);
          expect(errorOf(field)).toHaveAttribute('role', 'alert');
          expect(errorOf(field)).toHaveAttribute('id', `directory-${field}-error`);
          expect(input).toHaveAttribute('aria-invalid', 'true');
          expect(input).toHaveAttribute('aria-describedby', `directory-${field}-error`);
        } else {
          expect(errorOf(field)).toBeNull();
          expect(input).toHaveAttribute('aria-invalid', 'false');
        }
        expect(input.value).toBe(fields[field]); // every draft is kept as typed
      }
      expect(inputOf[invalid[0]]()).toHaveFocus(); // the first invalid field, in form order
    }
    await settle();
    expect(server.sent).toHaveLength(before); // not even a session read
    expect(view.made).toEqual([]);
    expect(view.holds.get('uid-a')).toBeUndefined();
    // Editing a field clears its own error only.
    fill({ name: '', phone: 'x', email: 'y' });
    await click('directory-add');
    await waitFor(() => expect(errorOf('email')).not.toBeNull());
    fill({ phone: PHONE });
    expect(errorOf('phone')).toBeNull();
    expect(phoneInput()).toHaveAttribute('aria-invalid', 'false');
    expect(errorOf('name')).not.toBeNull();
    expect(errorOf('email')).not.toBeNull();
    fill({ name: 'Ada Lovelace', email: EMAIL });
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.body)).toEqual([FULL_BODY]);
    expect(view.made).toHaveLength(1);
  });

  it('SCD-85. the body: contacts trimmed, in the order name, phone, email; a blank contact is left OUT, so a name-only create keeps its exact bytes; a confirmed create clears all three drafts', async () => {
    const server = fakeServer();
    const view = mount(server, { keys: [key(1), key(2), key(3), key(4)] });
    await ready();
    const sends: Array<[{ name: string; phone: string; email: string }, string]> = [
      [{ name: '  Ada Lovelace ', phone: `  ${PHONE}  `, email: ` ${EMAIL}\t` }, FULL_BODY],
      [{ name: 'Ada Lovelace', phone: '   ', email: EMAIL }, `{"name":"Ada Lovelace","email":"${EMAIL}"}`],
      [{ name: 'Ada Lovelace', phone: PHONE, email: '' }, `{"name":"Ada Lovelace","phone":"${PHONE}"}`],
      [{ name: 'Ada Lovelace', phone: ' ', email: '  ' }, '{"name":"Ada Lovelace"}'],
    ];
    for (const [fields, body] of sends) {
      const sent = posts(server).length;
      fill(fields);
      await click('directory-add');
      await waitFor(() => expect(posts(server)).toHaveLength(sent + 1));
      expect(posts(server)[sent].body).toBe(body);
      const saved = await screen.findByTestId('directory-saved');
      expect(saved.textContent).not.toContain(PHONE); // the notice names the customer, never a contact
      expect(saved.textContent).not.toContain(EMAIL);
      await ready();
      expect([nameInput().value, phoneInput().value, emailInput().value]).toEqual(['', '', '']); // cleared together
    }
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2), key(3), key(4)]);
    expect(names()).toEqual(['Ada Lovelace', 'Ada Lovelace', 'Ada Lovelace', 'Ada Lovelace']); // rows carry names only
    expect(screen.getByTestId('directory-list').textContent).not.toMatch(/555|@/);
    // A confirmation while the name draft is another name keeps every draft.
    server.hold.posts = 1;
    fill({ name: 'Grace Hopper', phone: PHONE, email: EMAIL });
    await click('directory-add');
    await waitFor(() => expect(server.held).toHaveLength(1));
    fill({ name: 'Someone Else' });
    server.held[0].release();
    await screen.findByTestId('directory-saved');
    expect([nameInput().value, phoneInput().value, emailInput().value]).toEqual(['Someone Else', PHONE, EMAIL]);
    expectNoSelector(server);
    expect(view.holds.get('uid-a')).toBeUndefined();
  });

  it('SCD-86. an uncertain create holds the exact body WITH its contacts: "Check again" re-sends those bytes after every field was edited; the card never shows a contact', async () => {
    const server = fakeServer();
    server.posts.push('lost-after-commit');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    fill({ name: 'Ada Lovelace', phone: ` ${PHONE}`, email: EMAIL });
    await click('directory-add');
    await unresolved();
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), body: FULL_BODY, name: 'Ada Lovelace', state: 'unresolved' });
    expect(hold().textContent).not.toContain(PHONE);
    expect(hold().textContent).not.toContain(EMAIL);
    fill({ name: 'Ada King', phone: '+1 555 0199', email: 'king@example.test' });
    await click('directory-check-again');
    const saved = await screen.findByTestId('directory-saved');
    expect(saved).toHaveTextContent('Saved on the server: "Ada Lovelace".'); // settled by the name sent
    expect(posts(server).map((r) => [r.headers.get('idempotency-key'), r.body])).toEqual([[key(1), FULL_BODY], [key(1), FULL_BODY]]);
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Ada Lovelace']); // ONE customer, its contacts as first sent
    expect(server.contacts.get(server.rows[TENANT_A][0].id)).toMatchObject({ phone: PHONE, email: EMAIL });
    expect([nameInput().value, phoneInput().value, emailInput().value]).toEqual(['Ada King', '+1 555 0199', 'king@example.test']);
    expect(page()).not.toContain(PHONE);
  });

  it('SCD-87. the profile: phone, email and the creation time as a <time>; a customer from before contacts shows "Not provided" and "Not recorded"', async () => {
    const server = fakeServer();
    const [old] = server.seed(TENANT_A, ['Old Customer']);
    const view = mount(server, { keys: [key(1)] });
    await ready();
    fill({ name: 'Ada Lovelace', phone: PHONE, email: EMAIL });
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    await ready();
    expect(page()).not.toContain(PHONE);
    await click('directory-saved-link');
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    const made = server.rows[TENANT_A].find((r) => r.name === 'Ada Lovelace')!;
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Lovelace$/);
    expect(screen.getByTestId('directory-detail-phone')).toHaveTextContent(new RegExp(`^\\${PHONE}$`));
    expect(screen.getByTestId('directory-detail-email')).toHaveTextContent(/^ada@example\.test$/);
    const time = screen.getByTestId('directory-detail-created').querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('datetime', '2026-09-30T09:05:00.001Z');
    expect(time).toHaveTextContent(/^2026-09-30 09:05 UTC$/);
    expect(screen.getByTestId('directory-detail-id')).toHaveTextContent(made.id);
    expect(details(server).map((r) => r.url)).toEqual([`${CUSTOMERS_PATH}/${made.id}/profile`]);
    await openDetail(view, old.id);
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Old Customer$/);
    expect(screen.getByTestId('directory-detail-phone')).toHaveTextContent(new RegExp(`^${NOT_PROVIDED_TEXT}$`));
    expect(screen.getByTestId('directory-detail-email')).toHaveTextContent(new RegExp(`^${NOT_PROVIDED_TEXT}$`));
    expect(screen.getByTestId('directory-detail-created')).toHaveTextContent(new RegExp(`^${NOT_RECORDED_TEXT}$`));
    expect(screen.getByTestId('directory-detail-created').querySelector('time')).toBeNull(); // no time is invented
    await view.go('/customers/directory');
    await ready();
    expect(screen.getByTestId('directory-list').textContent).not.toMatch(/555|@|Not provided/);
    expectNoSelector(server);
  });

  it('SCD-88. a confirmed create stays confirmed when the following profile read fails', async () => {
    const server = fakeServer();
    mount(server, { keys: [key(1)] });
    await ready();
    fill({ name: 'Ada Lovelace', phone: PHONE, email: EMAIL });
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    await ready(); // page one, read again after the 201
    for (const plan of [503, 'lost', 'html'] as const) {
      server.reads.push(plan);
      await click('directory-saved-link');
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'unavailable'));
      expect(screen.queryByTestId('directory-detail-phone')).toBeNull();
      expect(screen.getByTestId('directory-saved')).toHaveTextContent('Saved on the server: "Ada Lovelace".');
      expect(screen.queryByTestId('directory-hold')).toBeNull();
      expect(createStatus()).toHaveTextContent('');
      expect(page()).not.toMatch(/not saved|Not confirmed/i);
      await click('directory-back');
      await ready();
    }
    expect(posts(server)).toHaveLength(1);
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Ada Lovelace']);
  });

  it('SCD-89. a tenant change clears the profile\'s contacts: never shown under the new connection, not even as last known; the contact drafts stay with the name draft', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.contacts.set(ada.id, { phone: PHONE, email: EMAIL, createdAt: '2026-09-30T09:05:00.000Z' });
    server.seed(TENANT_B, ['Bea']);
    const view = mount(server);
    await ready();
    await openDetail(view, ada.id);
    expect(screen.getByTestId('directory-detail-phone')).toHaveTextContent(PHONE);
    await view.go('/customers/directory');
    await ready();
    fill({ name: 'Cy', phone: '+1 555 0142', email: 'cy@example.test' });
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail-email')).toHaveTextContent(EMAIL));
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a');
    server.hold.reads = 2; // the new connection's list and profile reads
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(2));
    // A new generation: the old store's contact record is gone before the new store has answered anything.
    expect(screen.queryByTestId('directory-detail-phone')).toBeNull();
    expect(screen.queryByTestId('directory-detail-email')).toBeNull();
    expect(screen.queryByTestId('directory-detail-created')).toBeNull();
    expect(page()).not.toContain(PHONE);
    expect(page()).not.toContain(EMAIL);
    // The new connection cannot read the profile (a 503): the old store's record is never its "last known".
    const outage = new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'req-synthetic' }), { status: 503, headers: { 'content-type': 'application/json' } });
    for (const h of server.held) h.release(h.url.endsWith('/profile') ? outage : undefined);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'unavailable'));
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(screen.queryByTestId('directory-detail-phone')).toBeNull();
    expect(page()).not.toContain(PHONE);
    expect(page()).not.toContain(EMAIL);
    await click('directory-detail-retry');
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found')); // not in this store
    expect(page()).not.toContain(PHONE);
    await view.go('/customers/directory');
    await waitFor(() => expect(names()).toEqual(['Bea']));
    expect([nameInput().value, phoneInput().value, emailInput().value]).toEqual(['Cy', '+1 555 0142', 'cy@example.test']);
    expect(posts(server)).toHaveLength(0);
  });

  it('SCD-90. a session that ends clears the profile\'s contacts: nothing of them is shown until a Reconnect reads them again', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.contacts.set(ada.id, { phone: PHONE, email: EMAIL, createdAt: null });
    const view = mount(server);
    await ready();
    await openDetail(view, ada.id);
    expect(screen.getByTestId('directory-detail-phone')).toHaveTextContent(PHONE);
    expect(screen.getByTestId('directory-detail-created')).toHaveTextContent(NOT_RECORDED_TEXT);
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('directory-detail-phone')).toBeNull();
    expect(screen.queryByTestId('directory-detail-email')).toBeNull();
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(page()).not.toContain(PHONE);
    expect(page()).not.toContain(EMAIL);
    expect(logins(server)).toHaveLength(1);
    await click('directory-detail-retry');
    await waitFor(() => expect(screen.getByTestId('directory-detail-phone')).toHaveTextContent(PHONE));
    expect(logins(server)).toHaveLength(2);
  });

  it('SCD-91. a confirmation clears the drafts only when ALL of them still are what was sent: a same-named customer with another phone being typed stays', async () => {
    const server = fakeServer();
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    server.hold.posts = 1;
    fill({ name: 'Ada Lovelace', phone: PHONE, email: EMAIL });
    await click('directory-add');
    await waitFor(() => expect(server.held).toHaveLength(1));
    fill({ phone: ' +1 555 0199 ' }); // the next Ada Lovelace: same name, another phone
    server.held[0].release();
    await screen.findByTestId('directory-saved');
    await ready();
    expect([nameInput().value, phoneInput().value, emailInput().value]).toEqual(['Ada Lovelace', ' +1 555 0199 ', EMAIL]);
    // The same, with an email added to a draft whose contacts were sent blank.
    server.hold.posts = 1;
    fill({ phone: '', email: '' });
    await click('directory-add');
    await waitFor(() => expect(server.held).toHaveLength(2));
    fill({ email: 'ada.second@example.test' });
    server.held[1].release();
    await waitFor(() => expect(posts(server)).toHaveLength(2));
    await waitFor(() => expect(view.holds.get('uid-a')).toBeUndefined());
    await ready();
    expect(posts(server)[1].body).toBe('{"name":"Ada Lovelace"}');
    expect([nameInput().value, phoneInput().value, emailInput().value]).toEqual(['Ada Lovelace', '', 'ada.second@example.test']);
    // What was sent, untouched since (padding aside): every draft is cleared.
    fill({ name: ' Ada Lovelace ', phone: ` ${PHONE}`, email: EMAIL });
    await click('directory-add');
    await waitFor(() => expect(posts(server)).toHaveLength(3));
    await waitFor(() => expect([nameInput().value, phoneInput().value, emailInput().value]).toEqual(['', '', '']));
  });

  it('SCD-92. an attempt that can never be sent again keeps no contact: detached by a connection change, or past the cutoff, its body is emptied; the card is unchanged; a name-only body stays', async () => {
    // Detached by a connection change.
    {
      const server = fakeServer();
      server.posts.push('lost-before');
      const view = mount(server, { keys: [key(1)] });
      await ready();
      fill({ name: 'Ada Lovelace', phone: PHONE, email: EMAIL });
      await click('directory-add');
      await unresolved();
      const before = view.holds.get('uid-a')!;
      expect(before.body).toBe(FULL_BODY);
      const card = hold().textContent;
      server.otherTab('tok-a');
      await focusWindow();
      await waitFor(() => expect(hold()).toHaveAttribute('data-detached', 'true'));
      const after = view.holds.get('uid-a')!;
      expect(after.body).toBe('');
      // The send time is a clock reading whose digits can be "555": it is pinned unchanged on the next line instead.
      expect(JSON.stringify({ ...after, sentAt: 0 })).not.toMatch(/555|@/);
      expect({ ...after, body: before.body, csrf: before.csrf }).toEqual(before); // key, name, state, sent time unchanged
      expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
      expect(card).not.toMatch(/555|@/);
      expect(hold().textContent).not.toMatch(/555|@/);
      expect(posts(server)).toHaveLength(1);
      cleanup();
      vi.restoreAllMocks();
    }
    // Past the check cutoff (not detached).
    {
      const server = fakeServer();
      server.posts.push('commit-then-503');
      let t = 1_000;
      const view = mount(server, { keys: [key(1)], now: () => t });
      await ready();
      fill({ name: 'Ada Lovelace', phone: PHONE, email: EMAIL });
      await click('directory-add');
      await unresolved();
      expect(view.holds.get('uid-a')!.body).toBe(FULL_BODY);
      t += CHECK_CUTOFF_MS;
      await click('directory-check-again');
      await waitFor(() => expect(view.holds.get('uid-a')!.body).toBe(''));
      expect(hold()).toHaveAttribute('data-detached', 'false');
      expect(screen.getByTestId('directory-hold-detached')).toHaveTextContent('It was sent too long ago');
      expect(posts(server)).toHaveLength(1);
      cleanup();
    }
    // A name-only body holds nothing but the name: it stays when detached.
    {
      const holds = createHoldStore();
      expect(holds.put('uid-a', { key: key(1), body: '{"name":"Ada"}', name: 'Ada', csrf: 'c'.repeat(43), sentAt: 1, state: 'unresolved' })).toBe(true);
      holds.change('uid-a', key(1), { csrf: null });
      expect(holds.get('uid-a')).toMatchObject({ body: '{"name":"Ada"}', csrf: null });
    }
  });

  // M7A-CUSTOMERS-P7 — editing a server-backed customer (PATCH /api/v1/customers/{id}).
  const patches = (s: Server) => s.sent.filter((r) => r.method === 'PATCH');
  /** Both edit live regions: the polite status and the assertive alert (their text together). */
  const editStatus = () => screen.getByTestId('directory-edit-notices');
  const editPolite = () => screen.getByTestId('directory-edit-status');
  const editAlert = () => screen.getByTestId('directory-edit-alert');
  const editInput = (field: 'name' | 'phone' | 'email') => screen.getByTestId(`directory-edit-${field}`) as HTMLInputElement;
  const fillEdit = (fields: { name?: string; phone?: string; email?: string }) => {
    for (const field of ['name', 'phone', 'email'] as const) {
      const value = fields[field];
      if (value !== undefined) fireEvent.change(editInput(field), { target: { value } });
    }
  };
  const detailPhase = () => screen.getByTestId('directory-detail').getAttribute('data-phase');
  const CREATED = '2026-09-30T09:05:00.000Z';
  /** A customer with contacts in tenant A, the page mounted with the edit hint, the list loaded, the customer opened. */
  async function editable(server: Server, options: MountOptions = {}) {
    access.set({ canEdit: true });
    const [ada, bea] = server.seed(TENANT_A, ['Ada Lovelace', 'Bea']);
    server.contacts.set(ada.id, { phone: PHONE, email: EMAIL, createdAt: CREATED });
    const view = mount(server, options);
    await ready();
    await openDetail(view, ada.id);
    return { view, ada, bea };
  }
  const openForm = async () => {
    await screen.findByTestId('directory-edit'); // after a save, Edit returns only once the profile is read again
    await click('directory-edit');
    await waitFor(() => expect(editInput('name')).toHaveFocus());
  };
  const editBody = (version: number, fields: Record<string, string | null>) => JSON.stringify({ expectedVersion: version, ...fields });
  const LATE_CONFLICT_TEXT = 'Your changes were not saved: someone else changed this customer first. The latest details are shown: edit again to change them.';

  it('SCD-93. "Edit" is offered only on a profile confirmed now with its version, and only with the edit hint: never without the hint, never on last-known values, never without a usable ETag', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Lovelace']);
    const view = mount(server);
    await ready();
    await openDetail(view, ada.id);
    expect(screen.queryByTestId('directory-edit')).toBeNull(); // no edit hint
    act(() => access.set({ canEdit: true }));
    expect(screen.getByTestId('directory-edit')).toBeInTheDocument();
    // The values and the version come from one answer: without a usable ETag the profile is not a result at all.
    for (const plan of ['no-etag', 'weak-etag'] as const) {
      await view.go('/customers/directory');
      server.reads.push(plan);
      await view.go(`/customers/directory/${ada.id}`);
      await waitFor(() => expect(detailPhase()).toBe('unavailable'));
      expect(screen.queryByTestId('directory-edit')).toBeNull();
      await click('directory-detail-retry');
      await waitFor(() => expect(detailPhase()).toBe('ready'));
      expect(screen.getByTestId('directory-edit')).toBeInTheDocument();
    }
    // Last known (the server cannot be asked now): shown, but never editable.
    await view.go('/customers/directory');
    server.reads.push(503);
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail-last-known')).toBeInTheDocument());
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada Lovelace');
    expect(screen.queryByTestId('directory-edit')).toBeNull();
    // On the list there is no edit at all.
    await view.go('/customers/directory');
    await ready();
    expect(screen.queryByTestId('directory-edit')).toBeNull();
    expect(patches(server)).toHaveLength(0);
  });

  it('SCD-94. the edit form starts from the profile; Name required, Phone and Email optional; every invalid field says so, the first takes focus, and NOTHING is sent and no key taken; a form equal to the profile sends nothing', async () => {
    const server = fakeServer();
    const { view } = await editable(server);
    await openForm();
    expect([editInput('name').value, editInput('phone').value, editInput('email').value]).toEqual(['Ada Lovelace', PHONE, EMAIL]);
    expect(screen.getByLabelText('Customer name (required)', { selector: '#directory-edit-name' })).toBe(editInput('name'));
    expect(screen.getByLabelText('Phone (optional)', { selector: '#directory-edit-phone' })).toBe(editInput('phone'));
    expect(screen.getByLabelText('Email (optional)', { selector: '#directory-edit-email' })).toBe(editInput('email'));
    expect(editInput('name')).toHaveAttribute('aria-required', 'true');
    fillEdit({ name: '   ', phone: 'no digits', email: 'ada@@example.test' });
    await click('directory-edit-save');
    expect(screen.getByTestId('directory-edit-name-error')).toHaveTextContent(NAME_RULE_TEXT);
    expect(screen.getByTestId('directory-edit-phone-error')).toHaveTextContent(PHONE_RULE_TEXT);
    expect(screen.getByTestId('directory-edit-email-error')).toHaveTextContent(EMAIL_RULE_TEXT);
    for (const field of ['name', 'phone', 'email'] as const) {
      expect(editInput(field)).toHaveAttribute('aria-invalid', 'true');
      expect(editInput(field)).toHaveAttribute('aria-describedby', `directory-edit-${field}-error`);
    }
    expect(editInput('name')).toHaveFocus();
    fillEdit({ name: 'Ada' });
    await click('directory-edit-save');
    expect(screen.queryByTestId('directory-edit-name-error')).toBeNull();
    expect(editInput('phone')).toHaveFocus(); // the first field still refused
    fillEdit({ phone: '', email: `${'x'.repeat(260)}@b` });
    await click('directory-edit-save');
    expect(editInput('email')).toHaveFocus();
    // Equal to the profile once normalized (padding only): nothing to send.
    fillEdit({ name: '  Ada Lovelace ', phone: ` ${PHONE} `, email: EMAIL });
    await click('directory-edit-save');
    expect(editStatus()).toHaveTextContent(EDIT_NO_CHANGES_TEXT);
    expect(patches(server)).toHaveLength(0);
    expect(view.made).toHaveLength(0); // no key was taken
    expect(screen.getByTestId('directory-edit-name')).toBeInTheDocument(); // the form stays open
  });

  it('SCD-95. a confirmed edit: ONE PATCH of the exact body under a new key and this session\'s token; "Saved"; the profile read again at the new version; the list read again from page one, the renamed customer coming from that read; id and creation time unchanged; the next edit expects the new version under another key', async () => {
    const server = fakeServer();
    const { view, ada } = await editable(server, { keys: [key(1), key(2)] });
    const before = details(server).length;
    const listReads = lists(server).length;
    await openForm();
    fillEdit({ name: ' Ada King ', phone: '+1 555 0199', email: '' }); // the email cleared
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`));
    expect(patches(server)).toHaveLength(1);
    const sent = patches(server)[0];
    expect(sent.url).toBe(`${CUSTOMERS_PATH}/${ada.id}`);
    expect(sent.body).toBe(editBody(1, { name: 'Ada King', phone: '+1 555 0199', email: null }));
    expect(sent.headers.get('idempotency-key')).toBe(key(1));
    expect(sent.headers.get('x-tmpos-csrf')).toBe('1');
    expect(sent.headers.get('x-tmpos-session-csrf')).toBe(server.csrfOfCookie());
    expect(sent.headers.get('content-type')).toBe('application/json');
    expect(sent.headers.has('if-match')).toBe(false);
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada King$/));
    expect(details(server).length).toBe(before + 1); // the profile, read again after the 200
    expect(screen.getByTestId('directory-detail-phone')).toHaveTextContent(/^\+1 555 0199$/);
    expect(screen.getByTestId('directory-detail-email')).toHaveTextContent(new RegExp(`^${NOT_PROVIDED_TEXT}$`));
    expect(screen.getByTestId('directory-detail-id')).toHaveTextContent(ada.id);
    expect(screen.getByTestId('directory-detail-created').querySelector('time')).toHaveAttribute('datetime', CREATED);
    expect(screen.queryByTestId('directory-edit-name')).toBeNull(); // the form closed
    expect(server.versions.get(ada.id)).toBe(2);
    // The list is read again, ONCE, from page one (only the edited row's name is put to the confirmed one meanwhile).
    await waitFor(() => expect(lists(server)).toHaveLength(listReads + 1));
    expect(lists(server)[listReads].url).toBe(CUSTOMERS_PATH);
    await view.go('/customers/directory');
    expect(names()).toEqual(['Ada King', 'Bea']);
    expect(lists(server)).toHaveLength(listReads + 1); // the way back reads nothing
    await view.go(`/customers/directory/${ada.id}`);
    // A second, deliberate edit: the version just read, and another key.
    await openForm();
    expect([editInput('name').value, editInput('phone').value, editInput('email').value]).toEqual(['Ada King', '+1 555 0199', '']);
    fillEdit({ email: EMAIL });
    await click('directory-edit-save');
    await waitFor(() => expect(patches(server)).toHaveLength(2));
    expect(patches(server)[1].body).toBe(editBody(2, { name: 'Ada King', email: EMAIL }));
    expect(patches(server)[1].headers.get('idempotency-key')).toBe(key(2));
    await waitFor(() => expect(screen.getByTestId('directory-detail-email')).toHaveTextContent(EMAIL));
    await waitFor(() => expect(lists(server)).toHaveLength(listReads + 2)); // the second confirmed edit: page one again
    expect(lists(server)[listReads + 1].url).toBe(CUSTOMERS_PATH);
    expectNoSelector(server);
  });

  it('SCD-96. a confirmed edit stays confirmed when the profile cannot be read again: "Saved, but…", and the values from before the edit are never shown', async () => {
    const server = fakeServer();
    const { ada } = await editable(server);
    for (const [plan, name] of [[503, 'Ada King'], ['lost', 'Ada Byron'], ['no-etag', 'Ada Lovelace']] as const) {
      await openForm();
      fillEdit({ name });
      server.profileReads.push(plan); // the profile read after the 200 (the list's page-one read after it takes no plan)
      await click('directory-edit-save');
      await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_SAVED_UNREFRESHED_TEXT));
      expect(detailPhase()).toBe('unavailable');
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
      expect(screen.queryByTestId('directory-detail-phone')).toBeNull();
      expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
      expect(screen.queryByTestId('directory-edit')).toBeNull();
      expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
      expect(page()).not.toMatch(/not saved|couldn't confirm/i);
      expect(server.rows[TENANT_A].find((r) => r.id === ada.id)!.name).toBe(name);
      await click('directory-detail-retry');
      await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(new RegExp(`^${name}$`)));
    }
    expect(patches(server)).toHaveLength(3);
    // The refresh refused 403 (one session check, the same token): still "Saved, but…", nothing of before shown.
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.profileReads.push(403);
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_SAVED_UNREFRESHED_TEXT));
    expect(detailPhase()).toBe('denied');
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(page()).not.toMatch(/not saved|couldn't confirm/i);
    expect(server.rows[TENANT_A].find((r) => r.id === ada.id)!.name).toBe('Ada King');
    expect(patches(server)).toHaveLength(4);
  });

  it('SCD-97. a conflict keeps the draft and sends nothing on its own; "Review latest" only reads; the deliberate save then expects the reviewed version under a NEW key', async () => {
    const server = fakeServer();
    const { view, ada } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
    server.editElsewhere(ada.id, 'Ada Byron'); // another editor's change lands first: version 2
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_CONFLICT_TEXT));
    expect(editAlert()).toHaveTextContent(EDIT_CONFLICT_TEXT);
    expect([editInput('name').value, editInput('phone').value]).toEqual(['Ada King', '+1 555 0199']); // the draft stays
    expect(screen.getByTestId('directory-edit-save')).toBeDisabled();
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(server.rows[TENANT_A].find((r) => r.id === ada.id)!.name).toBe('Ada Byron'); // nothing of ours applied
    const reads = details(server).length;
    await settle();
    await focusWindow();
    await settle();
    expect(patches(server)).toHaveLength(1); // never re-sent or merged on its own
    await click('directory-edit-review');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_REVIEWED_TEXT));
    expect(details(server).length).toBe(reads + 1);
    expect(patches(server)).toHaveLength(1);
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Byron$/); // the latest, shown
    expect([editInput('name').value, editInput('phone').value]).toEqual(['Ada King', '+1 555 0199']);
    expect(screen.getByTestId('directory-edit-save')).toBeEnabled();
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(patches(server)).toHaveLength(2);
    expect(patches(server)[1].body).toBe(editBody(2, { name: 'Ada King', phone: '+1 555 0199' }));
    expect(patches(server)[1].headers.get('idempotency-key')).toBe(key(2));
    expect(patches(server)[0].headers.get('idempotency-key')).toBe(key(1));
    expect(server.versions.get(ada.id)).toBe(3);
    expect(view.made).toEqual([key(1), key(2)]);
  });

  it('SCD-98. an undecided edit: "We couldn\'t confirm…", never re-sent on its own; a matching profile is no proof; "Check again" re-sends the SAME bytes under the SAME key to the SAME customer and token', async () => {
    const server = fakeServer();
    server.patches.push('lost-after-commit');
    const { view, ada } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King', email: '' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    expect(screen.getByTestId('directory-edit-hold')).toHaveTextContent(EDIT_UNKNOWN_TEXT);
    expect(editAlert()).toHaveTextContent(new RegExp(`^${EDIT_UNKNOWN_TEXT}$`));
    expect(editPolite()).toHaveTextContent('');
    expect(page()).not.toMatch(/not saved/i);
    expect(screen.getByTestId('directory-edit-hold').textContent).not.toMatch(/555|@/);
    expect(view.editHolds.get('uid-a')).toMatchObject({ key: key(1), customerId: ada.id, expectedVersion: 1, body: editBody(1, { name: 'Ada King', email: null }) });
    await settle();
    await focusWindow();
    await settle();
    expect(patches(server)).toHaveLength(1);
    // The profile now matches the edit (it committed), yet that is not proof: the attempt stays undecided.
    await view.go('/customers/directory');
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada King$/));
    expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved');
    expect(screen.queryByTestId('directory-edit')).toBeNull(); // no new edit while one is undecided
    await click('directory-edit-check');
    await waitFor(() => expect(editStatus()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    const [first, again] = patches(server);
    expect(again.url).toBe(first.url);
    expect(again.body).toBe(first.body);
    expect(again.headers.get('idempotency-key')).toBe(key(1));
    expect(again.headers.get('x-tmpos-session-csrf')).toBe(first.headers.get('x-tmpos-session-csrf'));
    expect(view.made).toEqual([key(1)]);
    expect(server.versions.get(ada.id)).toBe(2); // one change, replayed — never applied twice
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-99. a held edit past the check window keeps no bytes and offers no check; "Discard" forgets it and the draft, and says the request is not cancelled', async () => {
    const server = fakeServer();
    server.patches.push('rollback-503');
    let t = 1_000;
    const { view } = await editable(server, { keys: [key(1)], now: () => t });
    await openForm();
    fillEdit({ phone: '+1 555 0199' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    expect(view.editHolds.get('uid-a')!.body).toBe(editBody(1, { name: 'Ada Lovelace', phone: '+1 555 0199' }));
    t += CHECK_CUTOFF_MS - 1; // the last moment inside the window: the same bytes under the same key
    await click('directory-edit-check');
    await waitFor(() => expect(patches(server)).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    expect(patches(server)[1].body).toBe(patches(server)[0].body);
    expect(patches(server)[1].headers.get('idempotency-key')).toBe(key(1));
    t += 1;
    await click('directory-edit-check');
    await waitFor(() => expect(view.editHolds.get('uid-a')!.body).toBe(''));
    expect(screen.getByTestId('directory-edit-hold-too-old')).toHaveTextContent('sent too long ago');
    expect(screen.queryByTestId('directory-edit-check')).toBeNull();
    expect(patches(server)).toHaveLength(2);
    expect(screen.getByTestId('directory-edit-discard')).toHaveAttribute('aria-describedby', 'directory-edit-discard-warning');
    expect(document.getElementById('directory-edit-discard-warning')).toHaveTextContent('does not cancel the request');
    await click('directory-edit-discard');
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    expect(screen.getByTestId('directory-edit')).toBeInTheDocument();
    expect(patches(server)).toHaveLength(2);
  });

  it('SCD-100. Cancel closes the form and sends nothing; a save already out when Cancel is pressed is still decided by its own answer', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-cancel');
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    await settle();
    expect(patches(server)).toHaveLength(0);
    await openForm();
    expect(editInput('name').value).toBe('Ada Lovelace'); // the cancelled draft is gone
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(screen.getByTestId('directory-edit-save')).toBeDisabled();
    await click('directory-edit-cancel');
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(editStatus()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada King$/));
    expect(server.rows[TENANT_A].find((r) => r.id === ada.id)!.name).toBe('Ada King');
    expect(patches(server)).toHaveLength(1);
  });

  it('SCD-101. a tenant switch while a save is out clears the form, the draft, the held edit and every edit notice; the late answer repaints nothing', async () => {
    const server = fakeServer();
    const { view, bea } = await editable(server, { keys: [key(1)] });
    server.seed(TENANT_B, ['Cy']);
    await openForm();
    fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'sending');
    // The account now answers for tenant B (another tab's session): the next read notices the new connection.
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a');
    await view.go(`/customers/directory/${bea.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
    await waitFor(() => expect(detailPhase()).toBe('not-found')); // not a customer of tenant B
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    // The old tenant's answer arrives late: nothing of it is shown, nothing is read or sent for it.
    const sentBefore = server.sent.length;
    await act(async () => { server.held[0].release(); });
    await settle();
    // Only that the earlier change could not be confirmed is said (the new connection dropped it); never "Saved".
    expect(editPolite()).toHaveTextContent('');
    expect(editAlert()).toHaveTextContent(/^The store connection changed before a change could be confirmed\. Check the customer's details\.$/);
    expect(page()).not.toMatch(/Ada King|555 0199|couldn't confirm/);
    expect(server.sent.length).toBe(sentBefore);
    await view.go('/customers/directory');
    await waitFor(() => expect(names()).toEqual(['Cy']));
    expect(patches(server)).toHaveLength(1);
    cleanup();
    // A tenant switch that Save's own session step finds: a new generation, and NOTHING is sent.
    const other = fakeServer();
    const again = await editable(other, { keys: [key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    other.users['tok-a'].tenant = TENANT_B;
    other.otherTab('tok-a');
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument());
    await settle();
    expect(patches(other)).toHaveLength(0);
    expect(again.view.made).toEqual([]);
    expect(again.view.editHolds.get('uid-a')).toBeUndefined();
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
  });

  it('SCD-102. a 403 on the edit is a permission loss: "You can\'t edit this customer.", the form closed, the draft and any held edit cleared, nothing re-sent', async () => {
    const server = fakeServer();
    const { view } = await editable(server, { keys: [key(1), key(2)] });
    server.users['tok-a'].edit = false; // the server-backed level no longer reaches Edit; the local hint still says it does
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(new RegExp(`^${EDIT_DENIED_TEXT}$`)));
    expect(editAlert()).toHaveTextContent(EDIT_DENIED_TEXT);
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    await settle();
    expect(patches(server)).toHaveLength(1);
    expect(page()).not.toMatch(/Ada King/);
    // A held edit whose check is refused 403 is cleared too, without claiming either outcome.
    server.users['tok-a'].edit = true;
    server.patches.push('rollback-503');
    await openForm();
    expect(editInput('name').value).toBe('Ada Lovelace'); // the refused draft is gone
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    server.users['tok-a'].edit = false;
    await click('directory-edit-check');
    await waitFor(() => expect(editStatus()).toHaveTextContent(/^You can't edit this customer\. Whether the earlier change was saved could not be confirmed\.$/));
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    expect(patches(server)).toHaveLength(3);
  });

  it('SCD-103. a session that ends during an edit: Save, the PATCH\'s 401 and Check again sign nothing in; the profile, the form and any held edit are cleared; only Reconnect logs in', async () => {
    const server = fakeServer();
    const { view, ada } = await editable(server, { keys: [key(1), key(2)] });
    // Ended before Save: the session check finds it; nothing is sent.
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.sessions.clear();
    await click('directory-edit-save');
    await waitFor(() => expect(detailPhase()).toBe('signed-out'));
    expect(editStatus()).toHaveTextContent(/^Not sent\./);
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-phone')).toBeNull();
    expect(page()).not.toContain(PHONE);
    await settle();
    expect(patches(server)).toHaveLength(0);
    expect(logins(server)).toHaveLength(1);
    await click('directory-detail-retry'); // Reconnect: the one control that signs in
    await waitFor(() => expect(detailPhase()).toBe('ready'));
    expect(logins(server)).toHaveLength(2);
    // The PATCH itself answered 401.
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.patches.push(401);
    await click('directory-edit-save');
    await waitFor(() => expect(detailPhase()).toBe('signed-out'));
    expect(editStatus()).toHaveTextContent('Not saved: your server session ended.');
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    expect(page()).not.toContain(PHONE);
    expect(logins(server)).toHaveLength(2);
    await click('directory-detail-retry');
    await waitFor(() => expect(detailPhase()).toBe('ready'));
    // An undecided edit, then the session ends: the held edit can never be checked again, so it is dropped and said so.
    server.patches.push('rollback-503');
    await openForm();
    fillEdit({ email: '' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    const loginsBefore = logins(server).length;
    server.sessions.clear();
    await click('directory-edit-check');
    await waitFor(() => expect(detailPhase()).toBe('signed-out'));
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(editStatus()).toHaveTextContent('Your server session ended before a change could be confirmed.');
    await settle();
    expect(logins(server)).toHaveLength(loginsBefore);
    expect(patches(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]); // the check sent nothing
    expect(server.rows[TENANT_A].find((r) => r.id === ada.id)!.name).toBe('Ada Lovelace');
    cleanup();
    // Refresh and "Review latest" under an ended session sign nothing in either.
    const other = fakeServer();
    const again = await editable(other, { keys: [key(3)] });
    await again.view.go('/customers/directory');
    await ready();
    other.sessions.clear();
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(logins(other)).toHaveLength(1);
    await click('directory-retry'); // Reconnect
    await ready();
    expect(logins(other)).toHaveLength(2);
    await openDetail(again.view, again.ada.id);
    await openForm();
    fillEdit({ name: 'Ada King' });
    other.editElsewhere(again.ada.id, 'Ada Byron');
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_CONFLICT_TEXT));
    other.sessions.clear();
    await click('directory-edit-review');
    await waitFor(() => expect(detailPhase()).toBe('signed-out'));
    await settle();
    expect(logins(other)).toHaveLength(2);
    expect(patches(other)).toHaveLength(1);
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
  });

  it('SCD-104. a double click on Save sends ONE PATCH; drafts and held edits never reach browser storage or the console', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const before = { local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie };
    const server = fakeServer();
    server.patches.push('lost-before');
    const { view } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
    const save = screen.getByTestId('directory-edit-save');
    act(() => { fireEvent.click(save); fireEvent.click(save); }); // one task: the button cannot have been disabled yet
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    expect(patches(server)).toHaveLength(1);
    await click('directory-edit-discard');
    await openForm();
    fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
    server.patches.push('lost-after-commit');
    await userEvent.setup().dblClick(screen.getByTestId('directory-edit-save'));
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    expect(view.made).toEqual([key(1), key(2)]);
    // Two clicks in one task, before any re-render can disable the button: still one check.
    const check = screen.getByTestId('directory-edit-check');
    act(() => { fireEvent.click(check); fireEvent.click(check); });
    await waitFor(() => expect(editStatus()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    await settle();
    expect(patches(server)).toHaveLength(3); // each save once, the check once
    expect(view.made).toEqual([key(1), key(2)]);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(before.local);
    expect(window.sessionStorage.length).toBe(before.session);
    expect(document.cookie).toBe(before.cookie);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(view.router.state.location.search).toBe('');
  });

  it('SCD-105. the edit\'s other answers: 400 and 422 keep the draft and change nothing; 409 in progress is undecided; 404 closes the form; 429 waits', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1), key(2), key(3), key(4), key(5)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.patches.push(400);
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent('The server did not accept these customer details. Nothing was changed.'));
    expect(editInput('name').value).toBe('Ada King');
    server.patches.push(422);
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent('The server rejected this request. Nothing was changed.'));
    expect(editInput('name').value).toBe('Ada King');
    server.patches.push(429);
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(/^Not sent through: too many requests\. Wait 1 second\. Then save again\.$/));
    expect(screen.getByTestId('directory-edit-save')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('directory-edit-save')).toBeEnabled(), { timeout: 2_500 });
    server.patches.push(409);
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    expect(editAlert()).toHaveTextContent(new RegExp(`^${EDIT_UNKNOWN_TEXT}$`));
    expect(page()).not.toMatch(/not saved/i);
    await click('directory-edit-discard');
    // Gone from this store meanwhile: one bounded answer, the form closed, the detail read again.
    server.rows[TENANT_A] = server.rows[TENANT_A].filter((r) => r.id !== ada.id);
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent('This customer is no longer available in this store. Nothing was changed.'));
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    await waitFor(() => expect(detailPhase()).toBe('not-found'));
    expect(patches(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2), key(3), key(4), key(5)]);
  });

  // Review fixes (M7A-CUSTOMERS-P7).
  it('SCD-106. Cancel while Save is still checking the session sends NOTHING: no PATCH, no key, no held edit — also when the form is reopened meanwhile', async () => {
    const server = fakeServer();
    const { view, ada } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.checks = 1; // Save's session step is out
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-edit-cancel');
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(patches(server)).toHaveLength(0);
    expect(view.made).toEqual([]);
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    // Cancelled, then reopened, before the session step answers: the old Save still sends nothing.
    await openForm();
    fillEdit({ name: 'Ada Byron' });
    server.hold.checks = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(2));
    await click('directory-edit-cancel');
    await openForm();
    await act(async () => { server.held[1].release(); });
    await settle();
    expect(patches(server)).toHaveLength(0);
    expect(view.made).toEqual([]);
    expect(editInput('name').value).toBe('Ada Lovelace');
    expect(server.rows[TENANT_A].find((r) => r.id === ada.id)!.name).toBe('Ada Lovelace');
  });

  it('SCD-107. "Review latest" takes every field the user did not touch from the reviewed profile: the next save sends only the touched ones and never reverts another editor\'s change', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King', email: 'ada.k@example.test' }); // the phone is not touched
    // Another editor changes the phone (and only the phone) first: version 2.
    server.contacts.set(ada.id, { phone: '+1 555 0199', email: EMAIL, createdAt: CREATED });
    server.versions.set(ada.id, 2);
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_CONFLICT_TEXT));
    await click('directory-edit-review');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_REVIEWED_TEXT));
    expect([editInput('name').value, editInput('phone').value, editInput('email').value]).toEqual(['Ada King', '+1 555 0199', 'ada.k@example.test']);
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(patches(server)[1].body).toBe(editBody(2, { name: 'Ada King', email: 'ada.k@example.test' })); // no phone
    expect(server.contacts.get(ada.id)).toMatchObject({ phone: '+1 555 0199', email: 'ada.k@example.test' });
    expect(server.versions.get(ada.id)).toBe(3);
  });

  it('SCD-108. focus is never lost: Cancel and Discard return it to Edit, a conflict moves it to "Review latest", a confirmed save to the status', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1), key(2), key(3)] });
    await openForm();
    await click('directory-edit-cancel');
    await waitFor(() => expect(screen.getByTestId('directory-edit')).toHaveFocus());
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.editElsewhere(ada.id, 'Ada Byron');
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-review')).toHaveFocus());
    await click('directory-edit-review');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_REVIEWED_TEXT));
    await waitFor(() => expect(editPolite()).toHaveFocus()); // the Review button is gone: the status takes focus
    await click('directory-edit-save');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    await waitFor(() => expect(editPolite()).toHaveFocus());
    server.patches.push('rollback-503');
    await openForm();
    fillEdit({ name: 'Ada Lovelace' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    // Check again: the card keeps focus while it checks and after an undecided answer.
    await click('directory-edit-check');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveFocus());
    await click('directory-edit-discard');
    await waitFor(() => expect(screen.getByTestId('directory-edit')).toHaveFocus());
    // A check that confirms: the card goes, the status takes focus.
    server.patches.push('lost-after-commit');
    await openForm();
    fillEdit({ name: 'Ada Byron' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    await click('directory-edit-cancel');
    await click('directory-edit-check');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    await waitFor(() => expect(editPolite()).toHaveFocus());
    // A 403 closes the form: the alert takes focus.
    await waitFor(() => expect(screen.getByTestId('directory-edit')).toBeInTheDocument());
    server.users['tok-a'].edit = false;
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(editAlert()).toHaveTextContent(EDIT_DENIED_TEXT));
    await waitFor(() => expect(editAlert()).toHaveFocus());
    // A 404 closes the form: the alert takes focus.
    server.users['tok-a'].edit = true;
    await openForm();
    fillEdit({ name: 'Ada Queen' });
    server.rows[TENANT_A] = server.rows[TENANT_A].filter((r) => r.id !== ada.id);
    await click('directory-edit-save');
    await waitFor(() => expect(editAlert()).toHaveTextContent('no longer available'));
    await waitFor(() => expect(editAlert()).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('SCD-109. a user change or a sign-out drops the previous user\'s held edit (its bytes and token) and its draft', async () => {
    for (const next of ['uid-b', null] as const) {
      const server = fakeServer();
      server.patches.push('rollback-503');
      const { view } = await editable(server, { keys: [key(1)] });
      await openForm();
      fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
      await click('directory-edit-save');
      await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
      expect(view.editHolds.get('uid-a')).toBeDefined();
      act(() => access.set({ uid: next }));
      await settle();
      expect(view.editHolds.get('uid-a')).toBeUndefined();
      expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
      expect(screen.queryByTestId('directory-edit-name')).toBeNull();
      expect(page()).not.toMatch(/Ada King|555 0199/);
      expect(patches(server)).toHaveLength(1);
      cleanup();
      vi.restoreAllMocks();
      access.set({ uid: 'uid-a', canEdit: false });
    }
  });

  it('SCD-110. a held edit dropped because the connection changed says so: the earlier change could not be confirmed, check the customer\'s details', async () => {
    const server = fakeServer();
    server.patches.push('rollback-503');
    const { view } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    server.otherTab('tok-a'); // another session of the same user: a new token
    await focusWindow();
    await waitFor(() => expect(view.editHolds.get('uid-a')).toBeUndefined());
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(editAlert()).toHaveTextContent("The store connection changed before a change could be confirmed. Check the customer's details.");
    expect(patches(server)).toHaveLength(1);
  });

  it('SCD-111. a session that ends while a save is out drops the attempt in every state: its late 200 repaints nothing', async () => {
    const server = fakeServer();
    const { view, bea } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(view.editHolds.get('uid-a')?.state).toBe('sending');
    server.sessions.clear();
    await view.go(`/customers/directory/${bea.id}`); // the next read finds the session ended
    await waitFor(() => expect(detailPhase()).toBe('signed-out'));
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    expect(editAlert()).toHaveTextContent('Your server session ended before a change could be confirmed.');
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(editPolite()).toHaveTextContent('');
    expect(page()).not.toMatch(/Ada King/);
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-112. two persistent live regions: the status is always polite and the alert always assertive — no element changes its role', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1), key(2)] });
    const polite = editPolite();
    const alert = editAlert();
    expect([polite.getAttribute('role'), alert.getAttribute('role')]).toEqual(['status', 'alert']);
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.editElsewhere(ada.id, 'Ada Byron');
    await click('directory-edit-save');
    await waitFor(() => expect(alert).toHaveTextContent(EDIT_CONFLICT_TEXT));
    expect(polite).toHaveTextContent('');
    await click('directory-edit-review');
    await click('directory-edit-save');
    await waitFor(() => expect(polite).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(alert).toHaveTextContent('');
    expect([editPolite(), editAlert()]).toEqual([polite, alert]); // the same elements throughout
    expect([polite.getAttribute('role'), alert.getAttribute('role')]).toEqual(['status', 'alert']);
    // Outcome announcements: an undecided edit is announced through the fixed alert; the card itself holds no live region.
    // (Per-field validation errors keep role="alert", as the create form's do; this case is about outcome announcements.)
    server.patches.push('rollback-503');
    await openForm();
    fillEdit({ name: 'Ada Queen' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    expect(alert).toHaveTextContent(EDIT_UNKNOWN_TEXT);
    const card = screen.getByTestId('directory-edit-hold');
    expect(card.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
    expect([editPolite(), editAlert()]).toEqual([polite, alert]);
  });

  // Review fixes, round 2 (M7A-CUSTOMERS-P7).
  it('SCD-113. "Check again" that finds another token: nothing is sent, and the page still says the earlier change could not be confirmed', async () => {
    const server = fakeServer();
    server.patches.push('rollback-503');
    const { view } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    server.otherTab('tok-a');
    await click('directory-edit-check');
    await waitFor(() => expect(view.editHolds.get('uid-a')).toBeUndefined());
    await settle();
    expect(editAlert()).toHaveTextContent("The store connection changed before a change could be confirmed. Check the customer's details.");
    expect(patches(server)).toHaveLength(1);
  });

  it('SCD-114. a sign-out drops the held edit (its bytes and token) even while the directory is not mounted; the same user keeps it across navigation; a page that mounts for another user drops every other user\'s edit', async () => {
    for (const next of ['sign-out', 'uid-b'] as const) {
      const store = createEditHoldStore();
      const unbind = bindEditHoldsToSessionEnd(store);
      try {
        const server = fakeServer();
        server.patches.push('rollback-503');
        const { view } = await editable(server, { keys: [key(1)], editHolds: store });
        await openForm();
        fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
        await click('directory-edit-save');
        await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
        await view.go('/elsewhere'); // the guard's redirect: the directory unmounts
        await view.go('/customers/directory'); // the same user: kept for the next visit
        await ready();
        expect(screen.getByTestId('directory-edit-hold')).toBeInTheDocument();
        await view.go('/elsewhere');
        if (next === 'sign-out') await act(async () => { await view.session.logout(); });
        else act(() => access.set({ uid: 'uid-b' }));
        await view.go('/customers/directory');
        await ready();
        expect(store.get('uid-a')).toBeUndefined();
        expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
        expect(page()).not.toMatch(/Ada King|555 0199/);
        expect(patches(server)).toHaveLength(1);
      } finally {
        unbind();
      }
      cleanup();
      vi.restoreAllMocks();
      access.set({ uid: 'uid-a', canEdit: false });
    }
  });

  it('SCD-115. a field typed and then restored is untouched: "Review latest" shows the other editor\'s value there, and the body sends the REVIEWED name', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada X' });
    fillEdit({ name: ' Ada Lovelace' }); // restored (as normalized)
    fillEdit({ phone: '+1 555 0199' });
    server.editElsewhere(ada.id, 'Ada Byron');
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_CONFLICT_TEXT));
    await click('directory-edit-review');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_REVIEWED_TEXT));
    expect([editInput('name').value, editInput('phone').value]).toEqual(['Ada Byron', '+1 555 0199']);
    await click('directory-edit-save');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(patches(server)[1].body).toBe(editBody(2, { name: 'Ada Byron', phone: '+1 555 0199' }));
    expect(server.rows[TENANT_A].find((r) => r.id === ada.id)!.name).toBe('Ada Byron');
  });

  it('SCD-116. an edit answer that settles after the page has gone is shown by the next page of the same user: saved, or a conflict', async () => {
    const server = fakeServer();
    const store = createEditHoldStore();
    const { view, ada } = await editable(server, { keys: [key(1), key(2)], editHolds: store });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(store.get('uid-a')).toBeUndefined();
    await view.go('/customers/directory');
    await ready();
    expect(editPolite()).toHaveTextContent(editNamedText('saved', 'Ada King'));
    // A conflict that settles while away: the customer's own page says so.
    await openDetail(view, ada.id);
    await openForm();
    fillEdit({ name: 'Ada Queen' });
    server.editElsewhere(ada.id, 'Ada Byron');
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(2));
    await view.go('/elsewhere');
    await act(async () => { server.held[1].release(); });
    await settle();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(detailPhase()).toBe('ready'));
    expect(editAlert()).toHaveTextContent(LATE_CONFLICT_TEXT); // no draft and no Review button here
    expect(page()).not.toMatch(new RegExp(`^${EDIT_SAVED_TEXT}$`));
  });

  it('SCD-117. Cancel during Save\'s session step still handles what that step found: a new token starts a new generation, an ended session clears; nothing is sent', async () => {
    const server = fakeServer();
    const { view } = await editable(server, { keys: [key(1)] });
    // A new token.
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.otherTab('tok-a');
    server.hold.checks = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-edit-cancel');
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument());
    await waitFor(() => expect(detailPhase()).toBe('ready'));
    // An ended session.
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.sessions.clear();
    server.hold.checks = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(2));
    await click('directory-edit-cancel');
    await act(async () => { server.held[1].release(); });
    await waitFor(() => expect(detailPhase()).toBe('signed-out'));
    expect(page()).not.toContain(PHONE);
    await settle();
    expect(patches(server)).toHaveLength(0);
    expect(view.made).toEqual([]);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-118. a PATCH refused 403 because another session\'s cookie answered: ONE session check finds the new connection — "Not saved", never "You can\'t edit", and nothing more sent', async () => {
    const server = fakeServer();
    const { view } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.checks = 1; // Save's session step answers with this page's token…
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('tok-a'); // …but the PATCH arrives with another session's cookie
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(editAlert()).toHaveTextContent('Not saved: the store connection changed. Nothing was changed.'));
    expect(page()).not.toContain(EDIT_DENIED_TEXT);
    expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument();
    await settle();
    expect(patches(server)).toHaveLength(1);
    expect(patches(server)[0].headers.get('x-tmpos-session-csrf')).not.toBe(server.csrfOfCookie());
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-119. an edit notice that arrives while another customer or the list is shown names the customer it belongs to', async () => {
    const server = fakeServer();
    const { view, ada, bea } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await openDetail(view, bea.id);
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(editPolite()).toHaveTextContent(editNamedText('saved', 'Ada King')));
    expect(editPolite()).not.toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`));
    // A conflict that lands while the list is shown.
    await openDetail(view, ada.id);
    await openForm();
    fillEdit({ name: 'Ada Queen' });
    server.editElsewhere(ada.id, 'Ada Byron');
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(2));
    await view.go('/customers/directory');
    await act(async () => { server.held[1].release(); });
    await waitFor(() => expect(editAlert()).toHaveTextContent(editNamedText('conflict', 'Ada Queen')));
    expect(page()).not.toContain(EDIT_CONFLICT_TEXT);
  });

  it('SCD-120. the check window is tested again after the session step: past it, nothing is sent, the bytes are emptied, and the card says so', async () => {
    const server = fakeServer();
    server.patches.push('rollback-503');
    let t = 1_000;
    const { view } = await editable(server, { keys: [key(1)], now: () => t });
    await openForm();
    fillEdit({ phone: '+1 555 0199' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    t += CHECK_CUTOFF_MS - 1;
    server.hold.checks = 1;
    await click('directory-edit-check');
    await waitFor(() => expect(server.held).toHaveLength(1));
    t += 2; // the window closes while the session step is out
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold-too-old')).toBeInTheDocument());
    expect(view.editHolds.get('uid-a')).toMatchObject({ body: '', state: 'unresolved' });
    expect(screen.getByTestId('directory-edit-hold-reason')).toHaveTextContent('Not checked: it was sent too long ago.');
    expect(patches(server)).toHaveLength(1);
  });

  it('SCD-121. a send that throws is an attempt with no answer: the held edit returns to unresolved, and Check again and Discard still work', async () => {
    const server = fakeServer();
    let failing = true;
    const wrapCustomers = (c: CustomersClient): CustomersClient => ({
      ...c,
      update: (...args: Parameters<CustomersClient['update']>) => (failing ? Promise.reject(new TypeError('boom')) : c.update(...args)),
    });
    const { view } = await editable(server, { keys: [key(1)], wrapCustomers });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    await click('directory-edit-check');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold-reason')).toHaveTextContent('No answer from the server.'));
    expect(view.editHolds.get('uid-a')?.state).toBe('unresolved');
    failing = false;
    await click('directory-edit-check');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(patches(server)).toHaveLength(1); // the two throwing sends never reached the wire
    expect(patches(server)[0].headers.get('idempotency-key')).toBe(key(1));
  });

  it('SCD-122. a save confirmed while the list is shown drops the cached profile: the customer is never shown with its pre-edit values', async () => {
    const server = fakeServer();
    const { view, ada } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/customers/directory');
    const at = lists(server).length;
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(lists(server)).toHaveLength(at + 1)); // the list's reload after the 200 ...
    await waitFor(() => expect(phase()).toBe('ready')); // ... answered, before the next read is planned
    expect(names()).toEqual(['Ada King', 'Bea']);
    server.reads.push(503);
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(detailPhase()).toBe('unavailable'));
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(page()).not.toContain('Ada Lovelace');
  });

  it('SCD-123. a confirmed save whose refresh finds the session ended keeps the truth: saved, then the session ended — no sign-in', async () => {
    const server = fakeServer();
    await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.sessions.clear(); // the PATCH committed on arrival; the session ends before the refresh
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(detailPhase()).toBe('signed-out'));
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes were saved, but your server session then ended. Reconnect to see the latest details.'));
    expect(page()).not.toMatch(/not saved/i);
    await settle();
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-124. while an edit is held the form is read-only, so a confirming "Check again" never discards typed changes', async () => {
    const server = fakeServer();
    server.patches.push('lost-after-commit');
    await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    for (const field of ['name', 'phone', 'email'] as const) expect(editInput(field)).toHaveAttribute('readonly');
    await userEvent.setup().type(editInput('phone'), '9');
    expect(editInput('phone').value).toBe(PHONE); // nothing typed into a held form
    await click('directory-edit-check');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(patches(server)).toHaveLength(2);
  });

  it('SCD-125. a conflict that lands after Cancel reloads the profile and says so: Edit then starts from the current version, and a save lands', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.editElsewhere(ada.id, 'Ada Byron');
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-edit-cancel');
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes were not saved: someone else changed this customer first. The latest details are shown: edit again to change them.'));
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Byron$/));
    expect(screen.queryByTestId('directory-edit-review')).toBeNull();
    await openForm();
    expect(editInput('name').value).toBe('Ada Byron');
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(patches(server)[1].body).toBe(editBody(2, { name: 'Ada King' }));
  });

  it('SCD-126. an ended session while a PATCH hangs frees the edit controls: after Reconnect, a new edit can be saved, and the old request\'s end changes nothing', async () => {
    const server = fakeServer();
    const { view, ada, bea } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.patches.push(503);
    server.hold.patches = 1; // this PATCH hangs
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.sessions.clear();
    await view.go(`/customers/directory/${bea.id}`); // the next read finds the session ended
    await waitFor(() => expect(detailPhase()).toBe('signed-out'));
    await click('directory-detail-retry'); // Reconnect
    await waitFor(() => expect(detailPhase()).toBe('ready'));
    await openDetail(view, ada.id);
    await openForm();
    fillEdit({ name: 'Ada Queen' });
    expect(screen.getByTestId('directory-edit-save')).toBeEnabled();
    expect(editInput('name')).not.toHaveAttribute('readonly');
    await click('directory-edit-save');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    await openForm();
    await act(async () => { server.held[0].release(); }); // the old request ends now
    await settle();
    expect(editInput('name')).not.toHaveAttribute('readonly'); // its end changed nothing here
    expect(screen.getByTestId('directory-edit-save')).toBeEnabled();
    expect(editPolite()).toHaveTextContent('');
    expect(patches(server)).toHaveLength(2);
  });

  it('SCD-127. "Review latest" that finds the customer gone closes the form and clears the draft', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.editElsewhere(ada.id, 'Ada Byron');
    await click('directory-edit-save');
    await waitFor(() => expect(editStatus()).toHaveTextContent(EDIT_CONFLICT_TEXT));
    server.rows[TENANT_A] = server.rows[TENANT_A].filter((r) => r.id !== ada.id);
    await click('directory-edit-review');
    await waitFor(() => expect(detailPhase()).toBe('not-found'));
    await waitFor(() => expect(editAlert()).toHaveTextContent('This customer is no longer available in this store. Nothing was changed.'));
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    expect(page()).not.toContain('Ada King');
    await waitFor(() => expect(editAlert()).toHaveFocus());
  });

  // Review fixes, round 3 (M7A-CUSTOMERS-P7).
  /** A save refused 403 whose one session check is still out (held). */
  async function pendingRecheck(server: Server, options: MountOptions = {}) {
    const mounted = await editable(server, options);
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.users['tok-a'].edit = false;
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.hold.checks = 1;
    await act(async () => { server.held[0].release(); }); // the 403 lands; its session check is held
    await waitFor(() => expect(server.held).toHaveLength(2));
    return mounted;
  }

  it('SCD-128. an outcome an older page records for this user is shown by the page that is already open: the card goes, "Saved" is said, and the profile is read again', async () => {
    const server = fakeServer();
    const { view, ada } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await openDetail(view, ada.id); // a new page, showing the attempt that is still out
    expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'sending');
    const reads = details(server).length;
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada King$/));
    expect(details(server).length).toBe(reads + 1);
  });

  it('SCD-129. a recorded outcome is bound to the connection it was sent under: after a switch to another tenant nothing of it is shown', async () => {
    const server = fakeServer();
    const base = createEditHoldStore();
    const taken: EditOutcome[] = []; // what a page took from the store: proof the outcome was kept, then refused
    const store: EditHoldStore = { ...base, takeOutcome: (who) => { const o = base.takeOutcome(who); if (o !== undefined) taken.push(o); return o; } };
    const { view, ada } = await editable(server, { keys: [key(1)], editHolds: store });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await act(async () => { server.held[0].release(); });
    await settle();
    const sentWith = patches(server)[0].headers.get('x-tmpos-session-csrf');
    server.users['tok-a'].tenant = TENANT_B; // the same user, now in tenant B (a new session)
    server.otherTab('tok-a');
    await view.go('/customers/directory');
    await ready();
    await settle();
    expect(editStatus()).toHaveTextContent('');
    expect(page()).not.toMatch(/Ada King|Ada Lovelace/);
    // The control: the outcome WAS kept (saved, this customer, the old token) and reached this page — which refused it.
    expect(taken).toEqual([{ kind: 'saved', customerId: ada.id, name: 'Ada King', csrf: sentWith }]);
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(detailPhase()).toBe('not-found'));
    expect(editStatus()).toHaveTextContent('');
  });

  it('SCD-130. every edit notice is bound to its customer: on another page a refusal, an undecided edit and a held edit\'s 403 are named — the held one keeps its uncertainty', async () => {
    const server = fakeServer();
    const { view, ada, bea } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.patches.push(400);
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await openDetail(view, bea.id);
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes to "Ada King" were not saved.'));
    expect(page()).not.toContain('The server did not accept these customer details');
    // Undecided, landing while the list is shown.
    await openDetail(view, ada.id);
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.patches.push('rollback-503');
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(2));
    await view.go('/customers/directory');
    await act(async () => { server.held[1].release(); });
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes to "Ada King" could not be confirmed.'));
    // The held edit's check refused 403 on another customer's page: still "could not be confirmed".
    await openDetail(view, bea.id);
    server.users['tok-a'].edit = false;
    await click('directory-edit-check');
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes to "Ada King" could not be confirmed: you can\'t edit that customer.'));
    expect(page()).not.toMatch(/were not saved: you can't edit/);
  });

  it('SCD-131. a 403 whose session check is still out when the user cancels: its continuation does nothing — no refusal text, the form stays closed', async () => {
    const server = fakeServer();
    await pendingRecheck(server, { keys: [key(1)] });
    await click('directory-edit-cancel');
    await act(async () => { server.held[1].release(); });
    await settle();
    expect(page()).not.toContain(EDIT_DENIED_TEXT);
    expect(screen.queryByTestId('directory-edit-name')).toBeNull();
    expect(screen.getByTestId('directory-edit')).toBeInTheDocument();
    expect(patches(server)).toHaveLength(1);
  });

  it('SCD-132. a 403 whose session check is overtaken by a new connection: its continuation does nothing (never "You can\'t edit", never a second notice of its own)', async () => {
    const server = fakeServer();
    const { view, bea } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.users['tok-a'].edit = false;
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('tok-a');
    server.hold.checks = 1;
    await view.go(`/customers/directory/${bea.id}`); // a read's session step, held: it will find the new connection
    await waitFor(() => expect(server.held).toHaveLength(2));
    await act(async () => { server.held[0].release(); }); // the 403 (decided under the old cookie); its check waits on that step
    await act(async () => { server.held[1].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument());
    await settle();
    expect(page()).not.toContain(EDIT_DENIED_TEXT);
    expect(page()).not.toContain('Not saved: the store connection changed.');
    expect(patches(server)).toHaveLength(1);
  });

  it('SCD-133. a 403 whose session check is still out when the page goes: the check finishes and the next page of the same user and token says it was not saved', async () => {
    const server = fakeServer();
    const { view } = await pendingRecheck(server, { keys: [key(1)] });
    await view.go('/elsewhere');
    await act(async () => { server.held[1].release(); });
    await settle();
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    await view.go('/customers/directory');
    await ready();
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes to "Ada King" were not saved.'));
  });

  it('SCD-134. a 403 whose session check is still out when the user changes: nothing of it reaches the next user, nor the first user\'s next session', async () => {
    const server = fakeServer();
    const { view } = await pendingRecheck(server, { keys: [key(1)] });
    act(() => access.set({ uid: 'uid-b' }));
    await act(async () => { server.held[1].release(); });
    await waitFor(() => expect(detailPhase()).not.toBe('loading'));
    await settle();
    expect(page()).not.toMatch(/Ada King|can't edit/);
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    act(() => access.set({ uid: 'uid-a' })); // back, with a new sign-in: another session
    await waitFor(() => expect(detailPhase()).not.toBe('loading'));
    await settle();
    expect(page()).not.toMatch(/Ada King|can't edit|were not saved/);
  });

  it('SCD-135. a conflict recorded while no page was there: the late-conflict wording (no Review), and the profile shown is read again', async () => {
    const server = fakeServer();
    const { view, ada } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.editElsewhere(ada.id, 'Ada Byron');
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await openDetail(view, ada.id);
    const reads = details(server).length;
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(editAlert()).toHaveTextContent(LATE_CONFLICT_TEXT));
    expect(page()).not.toContain(EDIT_CONFLICT_TEXT);
    expect(screen.queryByTestId('directory-edit-review')).toBeNull();
    await waitFor(() => expect(details(server).length).toBe(reads + 1));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Byron$/);
  });

  it('SCD-136. focus is never lost on a refused save (400, 422, 429), a failed review, or a refresh that finds the session ended', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1), key(2), key(3), key(4), key(5)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    for (const plan of [400, 422, 429] as const) {
      server.patches.push(plan);
      await click('directory-edit-save');
      await waitFor(() => expect(editAlert()).not.toHaveTextContent(/^$/));
      await waitFor(() => expect(editAlert()).toHaveFocus());
      await waitFor(() => expect(screen.getByTestId('directory-edit-save')).toBeEnabled(), { timeout: 2_500 });
    }
    server.editElsewhere(ada.id, 'Ada Byron');
    await click('directory-edit-save');
    await waitFor(() => expect(editAlert()).toHaveTextContent(EDIT_CONFLICT_TEXT));
    server.reads.push(503);
    await click('directory-edit-review');
    await waitFor(() => expect(editAlert()).toHaveTextContent('The latest details could not be loaded. Try again.'));
    await waitFor(() => expect(editAlert()).toHaveFocus());
    await click('directory-edit-review');
    await waitFor(() => expect(editPolite()).toHaveTextContent(EDIT_REVIEWED_TEXT));
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.sessions.clear();
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes were saved, but your server session then ended.'));
    await waitFor(() => expect(editAlert()).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('SCD-137. a confirmed save whose refresh finds a new connection keeps the truth: saved, then the connection changed', async () => {
    const server = fakeServer();
    await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('tok-a');
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument());
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes were saved, but the store connection then changed.'));
    expect(page()).not.toMatch(/not saved/i);
  });

  it('SCD-138. a held form says why it is read-only; a repeated identical notice is cleared and set again, so it is announced again', async () => {
    const server = fakeServer();
    await editable(server, { keys: [key(1), key(2), key(3)] });
    await openForm();
    // The same notice twice in a row ("No changes to save." puts no other notice in between): cleared, then set again.
    await click('directory-edit-save');
    await waitFor(() => expect(editPolite()).toHaveTextContent(EDIT_NO_CHANGES_TEXT));
    const seen: string[] = [];
    const observer = new MutationObserver(() => { seen.push(editPolite().textContent ?? ''); });
    observer.observe(editPolite(), { childList: true, characterData: true, subtree: true });
    await click('directory-edit-save');
    await waitFor(() => expect(seen.at(-1)).toBe(EDIT_NO_CHANGES_TEXT));
    observer.disconnect();
    expect(seen).toEqual(['', EDIT_NO_CHANGES_TEXT]); // cleared before it was set again
    // A later notice wins over a pending reset: the repeat is pending when Cancel clears the notice in the same task.
    const save = screen.getByTestId('directory-edit-save');
    act(() => { fireEvent.click(save); fireEvent.click(screen.getByTestId('directory-edit-cancel')); });
    await settle();
    expect(editPolite()).toHaveTextContent(/^$/);
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.patches.push('rollback-503');
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    for (const field of ['name', 'phone', 'email'] as const) {
      const ids = (editInput(field).getAttribute('aria-describedby') ?? '').split(' ');
      expect(ids).toContain('directory-edit-hold-text');
    }
    expect(document.getElementById('directory-edit-hold-text')).toHaveTextContent(EDIT_UNKNOWN_TEXT);
  });

  it('SCD-139. REGRESSION GUARD (it passes on the entry source too, there through the Firebase sign-in binding and a new session\'s token) — the shop\'s own edit hold store keeps the same user\'s held edit across navigation, and drops it on a sign-out heard while no page is mounted', async () => {
    access.set({ uid: 'uid-default-edit' });
    const server = fakeServer();
    server.users['tok-e'] = { uid: 'uid-default-edit', tenant: TENANT_A, view: true, create: true, edit: true };
    server.patches.push('rollback-503');
    const { view } = await editable(server, { keys: [key(1)], defaultEditHolds: true, tokens: { 'uid-default-edit': 'tok-e' } });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    await view.go('/elsewhere');
    await view.go('/customers/directory');
    await ready();
    expect(screen.getByTestId('directory-edit-hold')).toBeInTheDocument();
    await view.go('/elsewhere');
    await act(async () => { await view.session.logout(); });
    await view.go('/customers/directory');
    await ready();
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(page()).not.toMatch(/Ada King/);
    expect(patches(server)).toHaveLength(1);
  });

  // Review fixes, round 4 (M7A-CUSTOMERS-P7).
  it('SCD-140. a first-send 403 for a form closed by navigation (not by Cancel) is still said, by name, on the page that is open', async () => {
    const server = fakeServer();
    const { view, bea } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.users['tok-a'].edit = false;
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await openDetail(view, bea.id); // the route closes the form
    await act(async () => { server.held[0].release(); }); // the 403; its session check answers the same token
    await waitFor(() => expect(editAlert()).toHaveTextContent(editNamedText('denied', 'Ada King')));
    expect(view.editHolds.get('uid-a')).toBeUndefined();
  });

  it('SCD-141. a "Check again" whose page has gone and whose session step finds a new token records that the change could not be confirmed', async () => {
    const server = fakeServer();
    server.patches.push('rollback-503');
    const { view, ada } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    const sentWith = patches(server)[0].headers.get('x-tmpos-session-csrf');
    server.otherTab('tok-a');
    server.hold.checks = 1; // the check's session step, answered with the new token
    await click('directory-edit-check');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(view.editHolds.get('uid-a')).toBeUndefined();
    expect(view.editHolds.takeOutcome('uid-a')).toEqual({ kind: 'unconfirmed', customerId: ada.id, name: 'Ada King', csrf: sentWith });
    expect(patches(server)).toHaveLength(1);
  });

  it('SCD-142. an undecided answer for an older page\'s attempt is announced in the alert region of the page that is open (named on another page)', async () => {
    const server = fakeServer();
    const { view, ada } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.patches.push('rollback-503');
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await openDetail(view, ada.id);
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    await waitFor(() => expect(editAlert()).toHaveTextContent(new RegExp(`^${EDIT_UNKNOWN_TEXT}$`)));
    // On the list, the same is said by name.
    await click('directory-edit-discard');
    await openForm();
    fillEdit({ name: 'Ada Queen' });
    server.patches.push('rollback-503');
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(2));
    await view.go('/elsewhere');
    await view.go('/customers/directory');
    await ready();
    await act(async () => { server.held[1].release(); });
    await waitFor(() => expect(editAlert()).toHaveTextContent(editNamedText('undecided', 'Ada Queen')));
  });

  it('SCD-143. "saved, then the session ended" names the customer on another page; "saved, then the connection changed" stays unnamed — after a tenant switch no old customer name is shown', async () => {
    // The session ends while the refresh after the save is out, and another customer is shown by then: named.
    {
      const server = fakeServer();
      const { view, bea } = await editable(server, { keys: [key(1)] });
      await openForm();
      fillEdit({ name: 'Ada King' });
      server.hold.patches = 1;
      await click('directory-edit-save');
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.sessions.clear();
      server.hold.checks = 1; // the refresh's session step: it will find the session ended
      await act(async () => { server.held[0].release(); });
      await waitFor(() => expect(server.held).toHaveLength(2));
      await view.go(`/customers/directory/${bea.id}`);
      await act(async () => { server.held[1].release(); });
      await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes to "Ada King" were saved, but your server session then ended. Reconnect to see the latest details.'));
      expect(logins(server)).toHaveLength(1);
      cleanup();
    }
    // A switch to another tenant found by the refresh, with another customer shown by then: unnamed, no old name.
    {
      const server = fakeServer();
      const { view, bea } = await editable(server, { keys: [key(1)] });
      await openForm();
      fillEdit({ name: 'Ada King' });
      server.hold.patches = 1;
      await click('directory-edit-save');
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.users['tok-a'].tenant = TENANT_B;
      server.otherTab('tok-a');
      server.hold.checks = 1; // the refresh's session step: it will find the new connection
      await act(async () => { server.held[0].release(); });
      await waitFor(() => expect(server.held).toHaveLength(2));
      await view.go(`/customers/directory/${bea.id}`);
      await act(async () => { server.held[1].release(); });
      await waitFor(() => expect(editAlert()).toHaveTextContent(/^Your changes were saved, but the store connection then changed\.$/));
      expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT);
      await waitFor(() => expect(detailPhase()).toBe('not-found'));
      expect(page()).not.toMatch(/Ada King|Ada Lovelace/);
    }
  });

  // Review fixes, round 5 (M7A-CUSTOMERS-P7).
  it('SCD-144. the route is taken in the layout phase together with the edit clear, so a settlement after the commit is never erased by a later route clear', () => {
    // The window between a commit and its passive effects is not deterministic in jsdom: the ordering is asserted.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'ServerCustomerDirectory.tsx'), 'utf8');
    expect(source.match(/routeRef\.current = routeId;/g)).toHaveLength(1);
    const layout = /useLayoutEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[routeId\]\);/.exec(source);
    expect(layout).not.toBeNull();
    const body = layout![1];
    expect(body).toContain('routeRef.current = routeId;');
    expect(body.indexOf('routeRef.current = routeId;')).toBeLessThan(body.indexOf('closeEdit();'));
    expect(body).toContain('putEditStatus(null);');
    // The passive route effect no longer clears edit notices.
    const passive = /useEffect\(\(\) => \{\n {4}const from = lastRoute\.current;([\s\S]*?)\n {2}\}, \[routeId, uid\]\);/.exec(source);
    expect(passive).not.toBeNull();
    expect(passive![1]).not.toMatch(/closeEdit\(\)|putEditStatus\(/);
  });

  it('SCD-145. a Check again whose page has gone before its session step answers a refusal leaves no timer behind', async () => {
    const server = fakeServer();
    server.patches.push('rollback-503');
    const { view } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    server.checks.push(429); // the check's session step: rate limited (a wait the page would time)
    server.hold.checks = 1;
    await click('directory-edit-check');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(timers.mock.calls.filter(([, ms]) => typeof ms === 'number' && ms >= 1000)).toEqual([]);
    expect(view.editHolds.get('uid-a')?.state).toBe('unresolved'); // still held, for the next page
  });

  it('SCD-146. Cancel after a conflict reads the profile again: Edit then starts from the current version, and nothing is sent with the stale one', async () => {
    const server = fakeServer();
    const { ada } = await editable(server, { keys: [key(1), key(2)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.editElsewhere(ada.id, 'Ada Byron');
    await click('directory-edit-save');
    await waitFor(() => expect(editAlert()).toHaveTextContent(EDIT_CONFLICT_TEXT));
    const reads = details(server).length;
    await click('directory-edit-cancel');
    await waitFor(() => expect(details(server).length).toBe(reads + 1));
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Byron$/));
    await openForm();
    expect(editInput('name').value).toBe('Ada Byron');
    fillEdit({ name: 'Ada Queen' });
    await click('directory-edit-save');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(patches(server).map((r) => (JSON.parse(r.body ?? '{}') as { expectedVersion: number }).expectedVersion)).toEqual([1, 2]);
  });

  // M7A-CUSTOMERS-P8 — searching the server-backed list by name (GET /api/v1/customers?q=…).
  const searchInput = () => screen.getByTestId('directory-search-input') as HTMLInputElement;
  /** Put `text` in the search box (no request), then apply it by the Search button or by Enter. */
  const searchFor = async (text: string, how: 'button' | 'enter' = 'button') => {
    fireEvent.change(searchInput(), { target: { value: text } });
    if (how === 'button') await click('directory-search-submit');
    else await userEvent.setup().type(searchInput(), '{Enter}');
  };
  const listUrls = (s: Server, from = 0) => lists(s).slice(from).map((r) => r.url);
  const summary = () => screen.queryByTestId('directory-search-summary');
  const none = () => screen.queryByTestId('directory-search-none');
  const ADAS = ['Ada Lovelace', 'Adam', 'Grace', 'Bea', 'Hadassah', 'ADA KING'];

  it('SCD-147. the fake\'s search is the server\'s: q form-decoded and trimmed, matched anywhere in the name whatever its case, in byte order; each cursor kind only with its own search', async () => {
    const server = fakeServer();
    const send = (url: string, headers: Record<string, string> = {}) => server.fetch(url, { method: 'GET', headers });
    const login = await server.fetch(TENANT_SESSION_PATHS.login, { method: 'POST', headers: { authorization: 'Bearer tok-a', 'x-tmpos-csrf': '1' } });
    const bound = { 'x-tmpos-session-csrf': ((await login.json()) as { csrfToken: string }).csrfToken };
    const seeded = server.seed(TENANT_A, ADAS);
    server.seed(TENANT_B, ['Ada Foreign']);
    server.pageSize = 2;
    const read = async (query: string) => {
      const res = await send(`${CUSTOMERS_PATH}?${query}`, bound);
      return { status: res.status, body: res.status === 200 ? (await res.json()) as { customers: Row[]; nextCursor: string | null } : null };
    };
    const one = await read('q=ada');
    expect(one.body!.customers.map((r) => r.name)).toEqual(['ADA KING', 'Ada Lovelace']);
    expect(one.body!.nextCursor).toMatch(/^[A-Za-z0-9_-]{44}$/);
    const two = await read(`q=ada&cursor=${one.body!.nextCursor}`);
    expect(two.body!.customers.map((r) => r.name)).toEqual(['Adam', 'Hadassah']); // nothing of tenant B
    expect(two.body!.nextCursor).toBeNull();
    expect((await read('q=+ada+')).body!.customers.map((r) => r.name)).toEqual(['ADA KING', 'Ada Lovelace']); // '+' is a space, trimmed
    expect((await read('q=zed')).body).toEqual({ customers: [], nextCursor: null });
    expect((await read('q=%20%20')).body!.nextCursor).toMatch(/^[A-Za-z0-9_-]{23}$/); // blank: the unfiltered list
    // A cursor is accepted only with its own search: another text's, the other kind, or none of them is one 400.
    const unfiltered = (await read('q=')).body!.nextCursor!;
    for (const query of [`q=ad&cursor=${one.body!.nextCursor}`, `cursor=${one.body!.nextCursor}`, `q=ada&cursor=${unfiltered}`, 'q=%ZZ', 'q=a%00b',
      `q=${'x'.repeat(201)}`, 'q=a&q=b', 'q=ada&limit=10', '', 'q', 'q=ada&']) {
      expect((await read(query)).status, query).toBe(400);
    }
    // The continuation is the anchor's CURRENT position, whether or not the anchor still matches.
    const anchor = seeded.find((r) => r.name === 'Ada Lovelace')!;
    server.editElsewhere(anchor.id, 'Ab');
    expect((await read(`q=ada&cursor=${encodeCustomerSearchCursor(anchor.id, 'ada')}`)).body).toEqual({
      customers: seeded.filter((r) => r.name === 'Adam' || r.name === 'Hadassah').map((r) => ({ id: r.id, name: r.name })), nextCursor: null,
    });
  });

  it('SCD-148. typing sends nothing; Search (the button, or Enter) applies the draft: ONE read of q, only the matches, said in the polite status; later typing never relabels them', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    mount(server);
    await ready();
    const form = screen.getByRole('search');
    expect(within(form).getByLabelText('Search customers by name')).toBe(searchInput());
    const before = lists(server).length;
    await userEvent.setup().type(searchInput(), 'ada');
    await settle();
    expect(lists(server)).toHaveLength(before); // no request per keystroke
    expect(summary()).toBeNull();
    await click('directory-search-submit');
    await waitFor(() => expect(names()).toEqual(['ADA KING', 'Ada Lovelace', 'Adam', 'Hadassah']));
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada`]);
    expect(summary()).toHaveTextContent(searchMatchingText('ada'));
    expect(state()).toHaveAttribute('role', 'status');
    expect(state()).toContainElement(summary());
    // The draft is not the applied search: what is typed now changes nothing shown and sends nothing.
    await userEvent.setup().type(searchInput(), ' king');
    await settle();
    expect(summary()).toHaveTextContent(/^Customers matching “ada”$/);
    expect(names()).toHaveLength(4);
    expect(lists(server)).toHaveLength(before + 1);
    // Enter applies it.
    await searchFor('  GRACE ', 'enter');
    await waitFor(() => expect(names()).toEqual(['Grace']));
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada`, `${CUSTOMERS_PATH}?q=GRACE`]);
    expect(summary()).toHaveTextContent(searchMatchingText('GRACE'));
    expect(searchInput().value).toBe('  GRACE '); // the box keeps what was typed
    expectNoSelector(server);
  });

  it('SCD-149. a draft the server would refuse is said inline and takes focus, and NOTHING is sent; a blank one is the unfiltered list; 200 characters are sent', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    mount(server);
    await ready();
    const before = lists(server).length;
    const astral = String.fromCodePoint(0x1f600);
    for (const bad of [`Ada${String.fromCodePoint(0x202e)}`, `A${String.fromCodePoint(0x7)}da`, 'x'.repeat(201), astral.repeat(201), `A${String.fromCodePoint(0x2028)}da`]) {
      await searchFor(bad);
      await waitFor(() => expect(screen.getByTestId('directory-search-error')).toHaveTextContent(SEARCH_RULE_TEXT));
      expect(screen.getByTestId('directory-search-error')).toHaveAttribute('role', 'alert');
      expect(searchInput()).toHaveAttribute('aria-invalid', 'true');
      expect(searchInput()).toHaveAttribute('aria-describedby', 'directory-search-error');
      expect(searchInput()).toHaveFocus();
      expect(lists(server)).toHaveLength(before);
      expect(names()).toHaveLength(6); // the list shown is untouched
    }
    fireEvent.change(searchInput(), { target: { value: 'Ad' } }); // editing the draft takes the message away
    expect(screen.queryByTestId('directory-search-error')).toBeNull();
    expect(searchInput()).toHaveAttribute('aria-invalid', 'false');
    await searchFor(astral.repeat(200));
    await waitFor(() => expect(none()).toHaveTextContent(searchNoneText(astral.repeat(200))));
    await searchFor('   ');
    await ready();
    expect(names()).toHaveLength(6);
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=${encodeURIComponent(astral.repeat(200))}`, CUSTOMERS_PATH]);
    expect(summary()).toBeNull();
  });

  it('SCD-150. Clear empties the draft and the applied search and reads the unfiltered page one; focus stays in the search box; Clear is off with nothing to clear', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    mount(server);
    await ready();
    expect(screen.getByTestId('directory-search-clear')).toBeDisabled();
    fireEvent.change(searchInput(), { target: { value: 'grace' } });
    expect(screen.getByTestId('directory-search-clear')).toBeEnabled(); // a draft alone can be cleared
    await click('directory-search-submit');
    await waitFor(() => expect(names()).toEqual(['Grace']));
    const before = lists(server).length;
    await click('directory-search-clear');
    await waitFor(() => expect(names()).toHaveLength(6));
    expect(searchInput().value).toBe('');
    expect(searchInput()).toHaveFocus();
    expect(summary()).toBeNull();
    expect(listUrls(server, before)).toEqual([CUSTOMERS_PATH]);
    expect(screen.getByTestId('directory-search-clear')).toBeDisabled();
  });

  it('SCD-151. "No customers match" only after a successful search page with no rows; a failed search is the list\'s own state, never "no matches"; an empty store keeps its own text', async () => {
    const server = fakeServer();
    mount(server);
    await ready();
    expect(screen.getByTestId('directory-empty')).toHaveTextContent(EMPTY_TEXT);
    await searchFor('zed');
    await waitFor(() => expect(none()).toHaveTextContent(/^No customers match “zed”\.$/));
    expect(state()).toContainElement(none());
    expect(state()).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('directory-empty')).toBeNull();
    server.seed(TENANT_A, ADAS);
    for (const plan of [503, 'lost', 'html'] as ReadPlan[]) {
      server.reads.push(plan);
      await searchFor('ada');
      await waitFor(() => expect(phase()).toBe('unavailable'));
      expect(state()).toHaveTextContent('The customer directory is unavailable right now.');
      expect(none()).toBeNull();
      expect(summary()).toBeNull();
      expect(screen.queryByTestId('directory-empty')).toBeNull();
      expect(names()).toEqual([]); // the previous search's rows went when this one was applied
      await click('directory-retry'); // Try again: the same search
      await waitFor(() => expect(names()).toHaveLength(4));
      expect(lists(server).at(-1)!.url).toBe(`${CUSTOMERS_PATH}?q=ada`);
    }
  });

  it('SCD-152. Load more under a search sends its text and its own cursor; Refresh and a refused cursor\'s one reload stay under the APPLIED search, never the draft', async () => {
    const server = fakeServer();
    const adas = server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Ada ${String(i).padStart(2, '0')}`));
    server.seed(TENANT_A, Array.from({ length: 10 }, (_, i) => `Bea ${i}`));
    mount(server);
    await ready();
    await searchFor('ada');
    await waitFor(() => expect(names()).toHaveLength(50));
    expect(names().every((n) => n.startsWith('Ada '))).toBe(true);
    const before = lists(server).length;
    fireEvent.change(searchInput(), { target: { value: 'bea' } }); // a draft, not applied
    await click('directory-load-more');
    await waitFor(() => expect(names()).toHaveLength(60));
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada&cursor=${encodeCustomerSearchCursor(adas[49].id, 'ada')}`]);
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
    expect(new Set(screen.getAllByTestId('directory-row').map((r) => r.getAttribute('data-id'))).size).toBe(60);
    await click('directory-refresh');
    await waitFor(() => expect(lists(server)).toHaveLength(before + 2));
    await ready();
    expect(listUrls(server, before + 1)).toEqual([`${CUSTOMERS_PATH}?q=ada`]);
    expect(names()).toHaveLength(50);
    // The customer the continuation names is deleted: ONE reload from page one, still under the search.
    server.rows[TENANT_A] = server.rows[TENANT_A].filter((r) => r.id !== adas[49].id);
    await click('directory-load-more');
    await waitFor(() => expect(screen.getByTestId('directory-list-note')).toHaveTextContent('loaded again from the start'));
    await ready();
    expect(listUrls(server, before + 2)).toEqual([`${CUSTOMERS_PATH}?q=ada&cursor=${encodeCustomerSearchCursor(adas[49].id, 'ada')}`, `${CUSTOMERS_PATH}?q=ada`]);
    expect(summary()).toHaveTextContent(searchMatchingText('ada'));
    expect(names().every((n) => n.startsWith('Ada '))).toBe(true);
    expectNoSelector(server);
  });

  it('SCD-153. an older search\'s answer never replaces a newer one, in either arrival order', async () => {
    for (const order of ['newer-first', 'older-first'] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, ADAS);
      mount(server);
      await ready();
      server.hold.reads = 2;
      await searchFor('ada');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await searchFor('grace');
      await waitFor(() => expect(server.held).toHaveLength(2));
      const [older, newer] = server.held;
      if (order === 'newer-first') {
        await act(async () => { newer.release(); });
        await waitFor(() => expect(names()).toEqual(['Grace']));
        await act(async () => { older.release(); });
      } else {
        await act(async () => { older.release(); });
        await settle();
        expect(names(), order).toEqual([]); // nothing of the older search, ever
        expect(phase(), order).toBe('loading');
        await act(async () => { newer.release(); });
      }
      await settle();
      await waitFor(() => expect(names(), order).toEqual(['Grace']));
      expect(summary(), order).toHaveTextContent(searchMatchingText('grace'));
      expect(older.url).toBe(`${CUSTOMERS_PATH}?q=ada`);
      cleanup();
    }
  });

  it('SCD-154. a session that ended: Search finds it ended with NO login and clears the rows, the cursor, the draft and the applied search; only Reconnect logs in, and reads the unfiltered list', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    mount(server);
    await ready();
    await searchFor('ada');
    await waitFor(() => expect(names()).toHaveLength(4));
    fireEvent.change(searchInput(), { target: { value: 'grace' } });
    server.sessions.clear();
    const before = lists(server).length;
    await click('directory-search-submit');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(names()).toEqual([]);
    expect(summary()).toBeNull();
    expect(searchInput().value).toBe('');
    expect(lists(server)).toHaveLength(before);
    expect(logins(server)).toHaveLength(1);
    expect(screen.getByTestId('directory-search-submit')).toBeDisabled();
    expect(screen.getByTestId('directory-search-clear')).toBeDisabled();
    expect(screen.getByTestId('directory-search-hint')).toHaveTextContent('Reconnect to search.');
    await userEvent.setup().type(searchInput(), 'ada{Enter}'); // Enter cannot apply it either
    await focusWindow();
    await settle();
    expect(lists(server)).toHaveLength(before);
    expect(logins(server)).toHaveLength(1);
    await click('directory-retry');
    await ready();
    expect(logins(server)).toHaveLength(2);
    expect(listUrls(server, before)).toEqual([CUSTOMERS_PATH]);
    expect(names()).toHaveLength(6);
  });

  it('SCD-155. a search never resends or alters a held create: the same key, the same bytes and the same window; Check again then confirms it, and the filtered list never shows it unless the server says it matches', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    server.posts.push('commit-then-503');
    const view = mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Zed Unmatched');
    await unresolved();
    const held = view.holds.get('uid-a')!;
    await searchFor('ada');
    await waitFor(() => expect(names()).toHaveLength(4));
    await click('directory-refresh');
    await ready();
    await click('directory-search-clear');
    await waitFor(() => expect(names()).toHaveLength(7));
    await searchFor('ada', 'enter');
    await waitFor(() => expect(names()).toHaveLength(4));
    expect(posts(server)).toHaveLength(1);
    expect(view.holds.get('uid-a')).toEqual(held); // its key, bytes, token, send time and state, untouched
    const before = lists(server).length;
    await click('directory-check-again');
    await waitFor(() => expect(screen.getByTestId('directory-saved')).toHaveTextContent('Saved on the server: "Zed Unmatched".'));
    expect(posts(server).map((r) => [r.headers.get('idempotency-key'), r.body])).toEqual([[key(1), held.body], [key(1), held.body]]);
    await waitFor(() => expect(lists(server)).toHaveLength(before + 1));
    await ready();
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada`]); // page one again, under the search
    expect(names()).not.toContain('Zed Unmatched');
    expect(names()).toHaveLength(4);
  });

  it('SCD-156. a confirmed create reloads page one under the applied search: a matching customer is shown because the server answers it, another is never inserted', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    mount(server);
    await ready();
    await searchFor('ada');
    await waitFor(() => expect(names()).toHaveLength(4));
    let before = lists(server).length;
    await addCustomer('Adaline');
    await waitFor(() => expect(screen.getByTestId('directory-saved')).toHaveTextContent('Saved on the server: "Adaline".'));
    await waitFor(() => expect(names()).toContain('Adaline'));
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada`]);
    before = lists(server).length;
    await addCustomer('Quentin');
    await waitFor(() => expect(screen.getByTestId('directory-saved')).toHaveTextContent('Saved on the server: "Quentin".'));
    await waitFor(() => expect(lists(server)).toHaveLength(before + 1));
    await ready();
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada`]);
    expect(names()).not.toContain('Quentin');
    expect(summary()).toHaveTextContent(searchMatchingText('ada'));
  });

  it('SCD-157. a confirmed edit reloads a FILTERED list from page one: a customer renamed out of the search leaves it; a held edit is never resent by a search', async () => {
    access.set({ canEdit: true });
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ADAS);
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await searchFor('ada');
    await waitFor(() => expect(names()).toHaveLength(4));
    await userEvent.setup().click(within(screen.getAllByTestId('directory-row')[1]).getByRole('link', { name: 'Ada Lovelace' }));
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await openForm();
    fillEdit({ name: 'Lady Byron' });
    server.patches.push('commit-then-503'); // undecided: held
    await click('directory-edit-save');
    await waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
    const held = view.editHolds.get('uid-a')!;
    await click('directory-back');
    await waitFor(() => expect(names()).toHaveLength(4));
    await searchFor('lady');
    await waitFor(() => expect(names()).toEqual(['Lady Byron'])); // the server's answer: the edit had committed
    await click('directory-search-clear');
    await waitFor(() => expect(names()).toHaveLength(6));
    expect(patches(server)).toHaveLength(1);
    expect(view.editHolds.get('uid-a')).toEqual(held);
    await searchFor('ada');
    await waitFor(() => expect(names()).toHaveLength(3));
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    const before = lists(server).length;
    await click('directory-edit-check'); // the same key and bytes: the sealed 200
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    expect(patches(server).map((r) => [r.headers.get('idempotency-key'), r.body])).toEqual([[key(1), held.body], [key(1), held.body]]);
    await waitFor(() => expect(lists(server)).toHaveLength(before + 1));
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada`]);
    // An edit that renames a match out of the search, confirmed at once: the list is the server's answer again.
    const [adam] = server.rows[TENANT_A].filter((r) => r.name === 'Adam');
    await view.go(`/customers/directory/${adam.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await openForm();
    fillEdit({ name: 'Bram' });
    const at = lists(server).length;
    await click('directory-edit-save');
    await waitFor(() => expect(editPolite()).toHaveTextContent(new RegExp(`^${EDIT_SAVED_TEXT}$`)));
    await waitFor(() => expect(lists(server)).toHaveLength(at + 1));
    expect(listUrls(server, at)).toEqual([`${CUSTOMERS_PATH}?q=ada`]);
    await click('directory-back');
    await waitFor(() => expect(names()).toEqual(['ADA KING', 'Hadassah']));
    expect(summary()).toHaveTextContent(searchMatchingText('ada'));
  });

  it('SCD-158. a match opens its profile; the way back keeps the search, its rows and the draft; the search text never reaches the address, history or browser storage', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    const stored = vi.spyOn(Storage.prototype, 'setItem');
    const view = mount(server);
    await ready();
    await searchFor('hadas');
    await waitFor(() => expect(names()).toEqual(['Hadassah']));
    fireEvent.change(searchInput(), { target: { value: 'hadas and more' } });
    const reads = lists(server).length;
    await userEvent.setup().click(screen.getByRole('link', { name: 'Hadassah' }));
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Hadassah$/));
    expect(view.router.state.location.search).toBe('');
    expect(view.router.state.location.pathname).toMatch(/^\/customers\/directory\/[0-9a-f-]{36}$/);
    await click('directory-back');
    await waitFor(() => expect(names()).toEqual(['Hadassah']));
    expect(summary()).toHaveTextContent(searchMatchingText('hadas'));
    expect(searchInput().value).toBe('hadas and more');
    expect(lists(server)).toHaveLength(reads); // nothing read again for the way back
    expect(JSON.stringify(view.router.state.location)).not.toMatch(/hadas/i);
    expect(window.location.href).not.toMatch(/hadas/i);
    expect(stored.mock.calls.map((call) => call.join(' '))).not.toContainEqual(expect.stringMatching(/hadas/i));
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i++) expect(storage.getItem(storage.key(i)!) ?? '').not.toMatch(/hadas/i);
    }
  });

  it('SCD-159. a search still out when the store connection changes, or when the page goes, never populates: the new store starts unfiltered; a refused search clears the applied search with the rows', async () => {
    {
      const server = fakeServer();
      server.seed(TENANT_A, ['Ada A']);
      server.seed(TENANT_B, ['Ada B', 'Bob B']);
      mount(server);
      await ready();
      server.hold.reads = 1;
      await searchFor('ada');
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.users['tok-a'].tenant = TENANT_B;
      server.otherTab('tok-a');
      await focusWindow();
      await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
      await ready();
      await act(async () => { server.held[0].release(); });
      await settle();
      expect(names()).toEqual(['Ada B', 'Bob B']);
      expect(summary()).toBeNull();
      expect(searchInput().value).toBe(''); // the draft typed for the other store goes with it
      expect(page()).not.toContain('Ada A');
      cleanup();
    }
    {
      const server = fakeServer();
      server.seed(TENANT_A, ADAS);
      const view = mount(server);
      await ready();
      server.hold.reads = 1;
      await searchFor('ada');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      await act(async () => { server.held[0].release(); });
      await settle();
      await view.go('/customers/directory'); // a fresh page: nothing of the old one's search
      await ready();
      expect(names()).toHaveLength(6);
      expect(summary()).toBeNull();
      expect(searchInput().value).toBe('');
      cleanup();
    }
    {
      const server = fakeServer();
      server.seed(TENANT_A, ADAS);
      mount(server);
      await ready();
      await searchFor('ada');
      await waitFor(() => expect(names()).toHaveLength(4));
      server.users['tok-a'].view = false;
      await searchFor('grace');
      await waitFor(() => expect(phase()).toBe('denied'));
      expect(names()).toEqual([]);
      expect(summary()).toBeNull();
      expect(none()).toBeNull();
      expect(searchInput().value).toBe('grace'); // a refusal keeps the draft; only an ended session takes it
      server.users['tok-a'].view = true;
      const before = lists(server).length;
      await click('directory-refresh');
      await ready();
      expect(listUrls(server, before)).toEqual([CUSTOMERS_PATH]); // the applied search went with the rows
      expect(logins(server)).toHaveLength(1);
    }
  });

  it('SCD-160. while a rate limit\'s wait runs, Search, Enter and Clear send nothing; a refused search is never "no matches"; after the wait, Try again reads under the search', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    mount(server);
    await ready();
    server.reads.push(429);
    await searchFor('ada');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Too many requests. Wait 1 second, then try again.');
    expect(none()).toBeNull();
    expect(screen.getByTestId('directory-search-submit')).toBeDisabled();
    expect(screen.getByTestId('directory-search-clear')).toBeDisabled();
    expect(screen.getByTestId('directory-search-hint')).toHaveTextContent('Wait 1 second.');
    const before = lists(server).length;
    await userEvent.setup().type(searchInput(), '{Enter}');
    await settle();
    expect(lists(server)).toHaveLength(before);
    await waitFor(() => expect(screen.getByTestId('directory-search-submit')).toBeEnabled(), { timeout: 2_500 });
    await click('directory-retry');
    await waitFor(() => expect(names()).toHaveLength(4));
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada`]);
  });

  it('SCD-161. the search form works from the keyboard alone: Tab to Search and press it, the result said in the polite status', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    mount(server);
    await ready();
    const user = userEvent.setup();
    searchInput().focus();
    await user.keyboard('grace');
    await user.tab();
    expect(screen.getByTestId('directory-search-submit')).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(names()).toEqual(['Grace']));
    expect(state()).toHaveTextContent(searchMatchingText('grace'));
    await user.tab(); // Clear
    expect(screen.getByTestId('directory-search-clear')).toHaveFocus();
    await user.keyboard(' ');
    await waitFor(() => expect(names()).toHaveLength(6));
    expect(searchInput()).toHaveFocus();
  });

  it('SCD-162. the search GET itself answers 401 (the session ended while it was out): signed out, the rows, the cursor, the draft and the applied search gone, no summary, and no login', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ADAS);
    server.pageSize = 2; // a cursor is shown before the search
    mount(server);
    await ready();
    expect(screen.getByTestId('directory-load-more')).toBeInTheDocument();
    const before = lists(server).length;
    const signIns = logins(server).length;
    server.reads.push(401);
    await searchFor('ada');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=ada`]); // the search itself was sent, and answered 401
    expect(state()).toHaveTextContent('Your server session ended. Reconnect');
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
    expect(searchInput().value).toBe('');
    expect(summary()).toBeNull();
    expect(none()).toBeNull();
    await settle();
    expect(logins(server)).toHaveLength(signIns);
    expect(lists(server)).toHaveLength(before + 1);
  });

  // Review fixes (M7A-CUSTOMERS-P8): the list read after a confirmed edit.
  it('SCD-163. a confirmed edit whose list reload fails keeps the rows under the last-known label with the CONFIRMED name, never the one from before the edit', async () => {
    const server = fakeServer();
    const { view } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/customers/directory');
    expect(names()).toEqual(['Ada Lovelace', 'Bea']);
    const before = lists(server).length;
    server.reads.push(503); // the list's page-one read after the 200 (no profile is read on the list)
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(lists(server)).toHaveLength(before + 1);
    expect(screen.getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
    expect(names()).toEqual(['Ada King', 'Bea']);
    expect(page()).not.toContain('Ada Lovelace');
    expect(editPolite()).toHaveTextContent(editNamedText('saved', 'Ada King'));
    expect(page()).not.toMatch(/not saved/i);
  });

  it('SCD-164. a save confirmed while the list is shown, whose list reload finds the session ended: saved, then the session ended, by name; no sign-in and no rows', async () => {
    const server = fakeServer();
    const { view } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/customers/directory');
    server.sessions.clear(); // the PATCH committed on arrival; the session ends before the list reload
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(phase()).toBe('signed-out'));
    await waitFor(() => expect(editAlert()).toHaveTextContent('Your changes to "Ada King" were saved, but your server session then ended. Reconnect to see the latest details.'));
    expect(names()).toEqual([]);
    expect(page()).not.toMatch(/not saved/i);
    await settle();
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-165. a save confirmed while the list is shown, whose list reload finds another tenant\'s connection: saved, then the connection changed, unnamed; no old customer name shown', async () => {
    const server = fakeServer();
    const { view } = await editable(server, { keys: [key(1)] });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/customers/directory');
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a'); // the list reload's session step finds this new token
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
    await waitFor(() => expect(editAlert()).toHaveTextContent(/^Your changes were saved, but the store connection then changed\.$/));
    await ready();
    expect(names()).toEqual([]);
    expect(page()).not.toMatch(/Ada King|Ada Lovelace/);
    expect(logins(server)).toHaveLength(1);
  });
  // M7B-INVOICES-P1-R2 (DA-200) — a session end reaches the held create: the hold store's own contract, the shop's
  // module-level store with no page mounted (and a logout that never reached the server), the mounted page and the late
  // answers it then meets, answers asked for before a sign-out began, an old read after a new sign-in, the page
  // listener's lifetime and where focus goes. A sign-out is the session client's logout(): every `onSessionEnd` hears it
  // at its start. The access mock keeps the UID, as AccessContext.tsx keeps a page mounted on a direct switch until the
  // next user's profile has loaded.
  const signOut = async (view: ReturnType<typeof mount>) => { await act(async () => { await view.session.logout(); }); };

  it('SCD-166. the hold store\'s contract: bound to onSessionEnd, a sign-out takes every user\'s token and whole body (a name-only one too) and every outcome\'s token, once; key, name, state and send time stay, so a late answer still settles by key; unbound, it hears nothing', async () => {
    const holds = createHoldStore();
    const T = 'c'.repeat(43);
    holds.put('uid-a', { key: key(1), body: FULL_BODY, name: 'Ada Lovelace', csrf: T, sentAt: 7, state: 'sending' });
    holds.put('uid-b', { key: key(2), body: '{"name":"Bea"}', name: 'Bea', csrf: T, sentAt: 8, state: 'unresolved' });
    holds.put('uid-c', { key: key(3), body: '{"name":"Cy"}', name: 'Cy', csrf: T, sentAt: 9, state: 'sending' });
    holds.finish('uid-c', key(3), { kind: 'saved', customer: { id: uuid(0xc1), name: 'Cy' }, csrf: T, plain: true });
    holds.put('uid-d', { key: key(4), body: '{"name":"Dee"}', name: 'Dee', csrf: T, sentAt: 10, state: 'sending' });
    holds.finish('uid-d', key(4), { kind: 'refused', name: 'Dee' });
    const told = vi.fn();
    holds.subscribe(told);
    const client = createTenantSessionClient({ fetch: fakeServer().fetch });
    const unbind = bindHoldsToSessionEnd(holds);
    try {
      await client.logout();
      expect(told).toHaveBeenCalledTimes(1);
      expect(holds.get('uid-a')).toEqual({ key: key(1), body: '', name: 'Ada Lovelace', csrf: null, sentAt: 7, state: 'sending', ended: true });
      expect(holds.get('uid-b')).toEqual({ key: key(2), body: '', name: 'Bea', csrf: null, sentAt: 8, state: 'unresolved', ended: true });
      await client.logout(); // nothing is left to take: nobody is told again
      expect(told).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([holds.get('uid-a'), holds.get('uid-b')])).not.toMatch(/c{43}|555|@/);
      expect(holds.takeOutcome('uid-c')).toEqual({ kind: 'saved', customer: { id: uuid(0xc1), name: 'Cy' }, csrf: null, plain: true, ended: true });
      expect(holds.takeOutcome('uid-d')).toEqual({ kind: 'refused', name: 'Dee', ended: true });
      // The late answer still settles its attempt by key (a stale key settles nothing); no token or body comes back.
      expect(holds.change('uid-b', key(9), { state: 'checking' })).toBe(false);
      expect(holds.change('uid-b', key(2), { state: 'unresolved' })).toBe(true);
      expect(holds.get('uid-b')).toMatchObject({ csrf: null, body: '', ended: true });
      expect(holds.finish('uid-a', key(1), { kind: 'saved', customer: { id: uuid(0xc2), name: 'Ada Lovelace' }, csrf: null, plain: false, ended: true })).toBe(true);
      expect(holds.get('uid-a')).toBeUndefined();
    } finally {
      unbind();
    }
    holds.put('uid-e', { key: key(5), body: '{"name":"Eve"}', name: 'Eve', csrf: T, sentAt: 11, state: 'unresolved' });
    await client.logout();
    expect(holds.get('uid-e')).toMatchObject({ csrf: T, body: '{"name":"Eve"}' }); // unbound: it heard nothing
    expect(holds.get('uid-e')?.ended).toBeUndefined();
  });

  it('SCD-167. the shop\'s own hold store hears a sign-out with no directory page mounted: after a logout that never reached the server, the same user gets the SAME session back, yet the attempt left behind is detached for good — no Check again, no name or contact, nothing re-sent', async () => {
    access.set({ uid: 'uid-default-ended' });
    const server = fakeServer();
    server.users['tok-d'] = { uid: 'uid-default-ended', tenant: TENANT_A, view: true, create: true, edit: true };
    server.posts.push('lost-before');
    const view = mount(server, { defaultHolds: true, tokens: { 'uid-default-ended': 'tok-d' }, keys: [key(1), key(2)] });
    await ready();
    fill({ name: 'Ada Lovelace', phone: PHONE, email: EMAIL });
    await click('directory-add');
    await unresolved();
    expect(screen.getByTestId('directory-check-again')).toBeEnabled();
    await view.go('/elsewhere'); // no directory page is mounted from here on
    // A logout that never reaches the server (a best-effort logout can fail): the session it began with still stands.
    const cookie = server.cookie!;
    const kept = server.sessions.get(cookie)!;
    await signOut(view);
    server.sessions.set(cookie, kept);
    server.cookie = cookie;
    await view.go('/customers/directory');
    await ready();
    expect(logins(server)).toHaveLength(1); // the session (and its token) the attempt was sent under, found again
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(hold()).toHaveTextContent(ENDED_TEXT.unresolved);
    expect(page()).not.toMatch(/Ada Lovelace|555|@/);
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    await focusWindow();
    await settle();
    expect(posts(server)).toHaveLength(1);
    await click('directory-stop-tracking'); // leave the module-level store clean for the other cases
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-168. a sign-out while the page is mounted and a create is out: the ended state at once — the form\'s name, phone and email and every notice go, the card names nothing, the store keeps no token or body; the late answer (201, refusal or undecided) settles by key only — no notice, no read, no login, no send; after Reconnect it is said without its name, and nothing reaches storage, a log or the address', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    for (const late of ['201', '403', '503'] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Bea']);
      if (late === '403') server.posts.push(403);
      if (late === '503') server.posts.push('commit-then-503');
      // An injected store that is NOT bound to onSessionEnd: what happens here is the mounted page's own doing.
      const holds = createHoldStore();
      {
        const view = mount(server, { holds, keys: [key(1), key(2)] });
        await ready();
        server.hold.posts = 1;
        fill({ name: 'Ada Lovelace', phone: PHONE, email: EMAIL });
        await click('directory-add');
        await waitFor(() => expect(server.held).toHaveLength(1));
        await signOut(view);
        expect(phase()).toBe('signed-out');
        expect(state()).toHaveTextContent(ENDED);
        expect([nameInput().value, phoneInput().value, emailInput().value]).toEqual(['', '', '']);
        expect(createStatus().textContent).toBe('');
        expect(hold()).toHaveAttribute('data-detached', 'true');
        expect(hold()).toHaveTextContent(ENDED_TEXT.sending);
        expect(page()).not.toMatch(/Ada Lovelace|555|@/);
        expect(holds.get('uid-a')).toMatchObject({ key: key(1), csrf: null, body: '', ended: true, state: 'sending' });
        const sent = server.sent.length;
        await act(async () => { server.held[0].release(); });
        await settle();
        expect(server.sent).toHaveLength(sent); // no read-back, no login, no send
        expect(phase()).toBe('signed-out');
        expect(screen.queryByTestId('directory-saved')).toBeNull();
        expect(screen.queryByTestId('directory-saved-earlier')).toBeNull();
        expect(createStatus().textContent).toBe('');
        expect(page()).not.toMatch(/Ada Lovelace|555|@/);
        if (late === '503') expect(holds.get('uid-a')).toMatchObject({ key: key(1), csrf: null, body: '', ended: true, state: 'unresolved' });
        else expect(holds.get('uid-a')).toBeUndefined(); // settled by key into a token-less outcome
        // Reconnect: a new session, the page's first token. The news is said without a name; nothing is sent again, and the
        // news reads nothing: the Reconnect's own page-one read is the only list read.
        const listsBefore = lists(server).length;
        await click('directory-retry');
        await ready();
        await settle();
        expect(lists(server)).toHaveLength(listsBefore + 1);
        if (late === '201') expect(screen.getByTestId('directory-saved-earlier')).toHaveTextContent(ENDED_TEXT.saved);
        if (late === '403') expect(createStatus()).toHaveTextContent(ENDED_TEXT.refused);
        if (late === '503') {
          expect(hold()).toHaveTextContent(ENDED_TEXT.unresolved);
          expect(screen.queryByTestId('directory-check-again')).toBeNull();
        }
        expect(screen.queryByTestId('directory-saved-link')).toBeNull();
        expect(page()).not.toMatch(/"Ada Lovelace"|555|@/); // a row may list the customer the server stored; no notice names it
        await settle();
        expect(posts(server)).toHaveLength(1);
        expect(view.router.state.location.search).toBe('');
        expect(view.router.state.location.pathname).toBe('/customers/directory');
        cleanup();
      }
    }
    expect(setItem).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
  });

  it('SCD-169. a session check that answered just before a sign-out began answers for nothing: Add sends no POST and takes no key, Check again re-sends nothing, Refresh reads nothing — only the logout goes out', async () => {
    for (const step of ['add', 'check', 'refresh'] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Bea']);
      if (step === 'check') server.posts.push('lost-before');
      let trip = false;
      let mark = -1;
      // The sign-out begins after the session check has answered, before the caller's continuation runs.
      const wrapSession = (c: TenantSessionClient): TenantSessionClient => ({
        ...c, ensure: async (...args) => { const s = await c.ensure(...args); if (trip) { trip = false; mark = server.sent.length; void c.logout(); } return s; },
      });
      const view = mount(server, { keys: [key(1), key(2)], wrapSession });
      await ready();
      if (step === 'check') {
        await addCustomer('Ada Lovelace');
        await unresolved();
      } else {
        await typeName('Ada Lovelace');
      }
      trip = true;
      await click(step === 'add' ? 'directory-add' : step === 'check' ? 'directory-check-again' : 'directory-refresh');
      await settle();
      expect(trip).toBe(false);
      expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
      expect(posts(server)).toHaveLength(step === 'check' ? 1 : 0);
      expect(view.made).toHaveLength(step === 'check' ? 1 : 0);
      expect(phase()).toBe('signed-out');
      cleanup();
    }
  });

  it('SCD-170. a read asked for before a sign-out answers nothing after the next sign-in: the new session\'s rows stay, never the old answer', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bea']);
    const view = mount(server);
    await ready();
    server.hold.reads = 1;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1)); // computed under the old session: Bea only
    await signOut(view);
    expect(phase()).toBe('signed-out');
    server.seed(TENANT_A, ['Cy']);
    await click('directory-retry'); // a new session, the page's first token
    await waitFor(() => expect(names()).toEqual(['Bea', 'Cy']));
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(names()).toEqual(['Bea', 'Cy']);
    expect(phase()).toBe('ready');
  });

  it('SCD-171. the page\'s sign-out listener lives exactly as long as the page: under StrictMode\'s setup, cleanup, setup a sign-out is still heard; once the page has gone it is not (an unbound store keeps its attempt), while the store\'s own binding is the one that outlives it', async () => {
    {
      const server = fakeServer();
      server.posts.push('lost-before');
      const view = mount(server, { keys: [key(1)], strict: true });
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      await signOut(view);
      expect(phase()).toBe('signed-out');
      expect(hold()).toHaveAttribute('data-detached', 'true');
      expect(view.holds.get('uid-a')).toMatchObject({ csrf: null, body: '', ended: true });
      cleanup();
    }
    {
      const server = fakeServer();
      server.posts.push('lost-before');
      const view = mount(server, { keys: [key(1)] }); // its store is NOT bound to onSessionEnd: only the page could detach it
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      const csrf = view.holds.get('uid-a')!.csrf;
      expect(csrf).not.toBeNull();
      await view.go('/elsewhere');
      await signOut(view);
      expect(view.holds.get('uid-a')).toMatchObject({ csrf, body: '{"name":"Ada Lovelace"}' });
      expect(view.holds.get('uid-a')?.ended).toBeUndefined();
    }
  });

  it('SCD-172. focus: a sign-out that takes away a focused Check again sends focus to the list heading, never <body>; focus the user left in the form stays there', async () => {
    for (const where of ['check', 'name'] as const) {
      const server = fakeServer();
      server.posts.push('lost-before');
      const view = mount(server, { keys: [key(1)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      const target = where === 'check' ? screen.getByTestId('directory-check-again') : nameInput();
      act(() => target.focus());
      expect(target).toHaveFocus();
      await signOut(view);
      await settle();
      if (where === 'check') {
        expect(screen.queryByTestId('directory-check-again')).toBeNull();
        expect(screen.getByRole('heading', { name: 'Customers on the server' })).toHaveFocus();
      } else {
        expect(target).toHaveFocus();
      }
      cleanup();
    }
  });

  it('SCD-173. the answer of an attempt a sign-out detached, arriving only after Reconnect (a new generation): bookkeeping only — ZERO requests of any kind follow it (no list or detail read, no session check, no send); a 201 is said without its name or link, a refusal (429 included) without its name and with no wait, an undecided answer (503) stays an unnamed detached card with no hold note', async () => {
    for (const late of ['201', '403', '429', '503'] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Bea']);
      if (late === '403' || late === '429') server.posts.push(late === '403' ? 403 : 429);
      if (late === '503') server.posts.push('commit-then-503');
      server.retryAfter = '60';
      const view = mount(server, { keys: [key(1), key(2)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await signOut(view);
      await click('directory-retry'); // Reconnect: a new session, the page's first token
      await ready();
      expect(hold()).toHaveTextContent(ENDED_TEXT.sending);
      await settle();
      const mark = server.sent.length;
      await act(async () => { server.held[0].release(); });
      await settle();
      expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([]); // nothing at all follows the old answer
      if (late === '503') {
        expect(hold()).toHaveTextContent(ENDED_TEXT.unresolved);
        expect(hold()).toHaveAttribute('data-detached', 'true');
        expect(screen.queryByTestId('directory-hold-reason')).toBeNull();
        expect(screen.queryByTestId('directory-check-again')).toBeNull();
      } else {
        expect(screen.queryByTestId('directory-hold')).toBeNull();
      }
      if (late === '201') expect(screen.getByTestId('directory-saved-earlier')).toHaveTextContent(ENDED_TEXT.saved);
      if (late === '403' || late === '429') expect(createStatus()).toHaveTextContent(ENDED_TEXT.refused);
      expect(screen.queryByTestId('directory-saved-link')).toBeNull();
      expect(page()).not.toMatch(/"Ada Lovelace"/);
      if (late !== '503') expect(addButton()).toBeEnabled(); // no wait was started for the session shown now
      expect(posts(server)).toHaveLength(1);
      cleanup();
    }
  });

  it('SCD-174. Check again keeps only the key across its session check: the attempt as the store holds it AFTER the check decides — past the 23-hour window by then, nothing is sent; inside it, the same key and the same bytes, once', async () => {
    for (const when of ['too-old', 'in-time'] as const) {
      const server = fakeServer();
      server.posts.push('lost-before');
      let t = 1_000;
      const view = mount(server, { keys: [key(1)], now: () => t });
      await ready();
      fill({ name: 'Ada Lovelace', phone: PHONE, email: EMAIL });
      await click('directory-add');
      await unresolved();
      server.hold.checks = 1; // Check again's session check is held at the front
      await click('directory-check-again');
      await waitFor(() => expect(server.held).toHaveLength(1));
      if (when === 'too-old') t += CHECK_CUTOFF_MS; // the window closes while the check is out
      await act(async () => { server.held[0].release(); });
      await settle();
      if (when === 'too-old') {
        expect(posts(server)).toHaveLength(1);
        expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'unresolved' });
      } else {
        expect(posts(server).map((r) => [r.headers.get('idempotency-key'), r.body])).toEqual([[key(1), FULL_BODY], [key(1), FULL_BODY]]);
      }
      cleanup();
    }
  });

  it('SCD-175. focus the user moves elsewhere while a sign-out takes a focused Check again away stays where the user put it: the heading takes only focus that fell to the page', async () => {
    const server = fakeServer();
    server.posts.push('lost-before');
    const view = mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    act(() => screen.getByTestId('directory-check-again').focus());
    // The sign-out and the user's move to the name field land before the page commits the ended state.
    await act(async () => { void view.session.logout(); nameInput().focus(); });
    await settle();
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    expect(nameInput()).toHaveFocus();
  });

  it('SCD-176. a result for an attempt a sign-out detached that settles after its page has gone, while the same user\'s NEXT page (a new session) is mounted: that page shows only the unnamed notice — zero requests follow it (no read, no session check, no send), the draft being typed is untouched', async () => {
    for (const late of ['201', '403'] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Bea']);
      if (late === '403') server.posts.push(403);
      const view = mount(server, { keys: [key(1), key(2)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await signOut(view);
      await view.go('/elsewhere'); // that page goes
      await view.go('/customers/directory'); // the same user's next page: a new session, a new generation
      await ready();
      await typeName('Zed');
      await settle();
      const mark = server.sent.length;
      await act(async () => { server.held[0].release(); }); // the old page's continuation settles it in the store
      await settle();
      expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([]);
      if (late === '201') expect(screen.getByTestId('directory-saved-earlier')).toHaveTextContent(ENDED_TEXT.saved);
      else expect(createStatus()).toHaveTextContent(ENDED_TEXT.refused);
      expect(page()).not.toMatch(/"Ada Lovelace"/);
      expect(nameInput().value).toBe('Zed');
      expect(posts(server)).toHaveLength(1);
      cleanup();
    }
  });

  // M7B-INVOICES-P2 — a session end reaches the held EDIT as it reaches the held create (DA-200's remaining residual):
  // the edit hold store's own contract, the shop's module-level store with no page mounted (and a logout that never
  // reached the server, so the SAME session is found again), the mounted page (whose listener runs after the store's),
  // the late answers it then meets, a Check again whose session check settles on either side of a sign-out, and an
  // outcome recorded under the session that ended. Each case that uses the shop's own store has its own UID: that store
  // is shared by every case in this file.
  const ENDED_HELD_TEXT = "Your server session ended before a change could be confirmed. After you reconnect, check the customer's details.";
  /** A user of tenant A whose page uses the shop's own edit hold store (bound to onSessionEnd), and that user's login token. */
  const shopUser = (server: Server, uid: string): Record<string, string> => {
    server.users[`tok-${uid}`] = { uid, tenant: TENANT_A, view: true, create: true, edit: true };
    access.set({ uid });
    return { [uid]: `tok-${uid}` };
  };
  /** Count each time the edit alert region's text BECOMES `text` (an announcement); `stop()` disconnects and answers it. */
  const countAlerts = (text: string) => {
    const node = editAlert();
    let last = node.textContent;
    let count = 0;
    const observer = new MutationObserver(() => {
      const now = node.textContent;
      if (now !== last && now === text) count += 1;
      last = now;
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    return { stop: (): number => { observer.disconnect(); return count; } };
  };
  const heldEditState = () => waitFor(() => expect(screen.getByTestId('directory-edit-hold')).toHaveAttribute('data-state', 'unresolved'));
  /** A logout that never reaches the server: the session it began with still stands, so the next check finds it again. */
  const signOutUnsent = async (server: Server, view: ReturnType<typeof mount>) => {
    const cookie = server.cookie!;
    const kept = server.sessions.get(cookie)!;
    await signOut(view);
    server.sessions.set(cookie, kept);
    server.cookie = cookie;
  };

  it('SCD-177. the edit hold store\'s contract: bound to onSessionEnd, a sign-out DROPS every user\'s held edit and every recorded outcome (key, target, body, version, name and token), once, keeping only a per-user mark that is taken once; a listener heard after it finds the store already cleared; a late answer then settles nothing by key; a page for one user leaves the other users\' marks to them; unbound, it hears nothing', async () => {
    const store = createEditHoldStore();
    const T = 'c'.repeat(43);
    const edit = (n: number, name: string, state: 'sending' | 'unresolved') => ({
      key: key(n), customerId: uuid(0xe0 + n), body: editBody(3, { name, phone: PHONE }), expectedVersion: 3, name, csrf: T, sentAt: n, state,
    });
    store.put('uid-a', edit(1, 'Ada King', 'sending'));
    store.put('uid-b', edit(2, 'Bea Queen', 'unresolved'));
    store.put('uid-c', edit(3, 'Cy Duke', 'sending'));
    store.finish('uid-c', key(3), { kind: 'saved', customerId: uuid(0xe3), name: 'Cy Duke', csrf: T });
    const told = vi.fn();
    store.subscribe(told);
    const client = createTenantSessionClient({ fetch: fakeServer().fetch });
    const unbind = bindEditHoldsToSessionEnd(store);
    // Registered after the store's binding, as a mounted page's listener is: it runs second (insertion order).
    const seen: unknown[] = [];
    const unhear = onSessionEnd(() => { seen.push(store.get('uid-a'), store.get('uid-b')); });
    try {
      await client.logout();
      expect(seen).toEqual([undefined, undefined]); // already dropped when the later listener ran
      expect(told).toHaveBeenCalledTimes(1);
      for (const uid of ['uid-a', 'uid-b', 'uid-c']) expect(store.get(uid)).toBeUndefined();
      expect(store.takeOutcome('uid-c')).toBeUndefined();
      // A late answer finds nothing to settle: every by-key step is refused, and nothing is recorded.
      expect(store.change('uid-a', key(1), { state: 'unresolved' })).toBe(false);
      expect(store.finish('uid-a', key(1), { kind: 'saved', customerId: uuid(0xe1), name: 'Ada King', csrf: T })).toBe(false);
      expect(store.announce('uid-b', key(2), { kind: 'undecided', customerId: uuid(0xe2), name: 'Bea Queen', csrf: T })).toBe(false);
      expect(store.remove('uid-b', key(2))).toBe(false);
      expect([store.takeOutcome('uid-a'), store.takeOutcome('uid-b')]).toEqual([undefined, undefined]);
      await client.logout(); // nothing is left to drop: nobody is told again
      expect(told).toHaveBeenCalledTimes(1);
      expect(store.takeEnded('uid-a')).toBe(true);
      expect(store.takeEnded('uid-a')).toBe(false); // taken once
      store.keepOnly('uid-b'); // a page that mounts for uid-b: uid-c's mark stays for uid-c's own next page
      expect(store.takeEnded('uid-b')).toBe(true);
      expect(store.takeEnded('uid-c')).toBe(true);
      expect(store.takeEnded('uid-d')).toBe(false); // nothing was held for uid-d
    } finally {
      unhear();
      unbind();
    }
    store.put('uid-e', edit(5, 'Eve', 'unresolved'));
    await client.logout();
    expect(store.get('uid-e')).toEqual(edit(5, 'Eve', 'unresolved')); // unbound: it heard nothing
    expect(store.takeEnded('uid-e')).toBe(false);
  });

  it('SCD-178. the shop\'s own edit hold store hears a sign-out with no directory page mounted: after a logout that never reached the server the same user gets the SAME session back, yet the held edit (with contacts) is gone — no card, no Check again, no name or contact, one unnamed notice; focus and Refresh send no PATCH and sign nothing in', async () => {
    const server = fakeServer();
    const tokens = shopUser(server, 'uid-default-edit-away');
    server.patches.push('rollback-503');
    const { view, ada } = await editable(server, { keys: [key(1), key(2)], defaultEditHolds: true, tokens });
    await openForm();
    fillEdit({ name: 'Ada King', phone: '+1 555 0199', email: 'king@example.test' });
    await click('directory-edit-save');
    await heldEditState();
    expect(screen.getByTestId('directory-edit-check')).toBeEnabled();
    await view.go('/elsewhere'); // no directory page is mounted from here on
    await signOutUnsent(server, view);
    await view.go('/customers/directory');
    await ready();
    expect(logins(server)).toHaveLength(1); // the session (and its token) the edit was sent under, found again
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(screen.queryByTestId('directory-edit-check')).toBeNull();
    await waitFor(() => expect(editAlert().textContent).toBe(ENDED_HELD_TEXT));
    expect(page()).not.toMatch(/Ada King|555 0199|king@/);
    await focusWindow();
    await settle();
    await click('directory-refresh');
    await ready();
    await settle();
    await openDetail(view, ada.id);
    expect(screen.getByTestId('directory-edit')).toBeInTheDocument(); // nothing is held: Edit is offered again
    expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
    expect(patches(server)).toHaveLength(1);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-179. REGRESSION GUARD (it passes on the entry source too: the mounted page dropped its user\'s held edit) — a sign-out while the page is mounted clears the edit at once: an open form with typed contacts goes with its draft and the profile (no notice: nothing was held); a held edit goes from the card, the form and the store, and the page says it once, unnamed (one announcement, counted), that the change could not be confirmed — also when the shop\'s own store has dropped it first; nothing is read, sent or signed in until the Reconnect click, no PATCH follows it, and a form opened then starts from the profile, never the typed values', async () => {
    for (const variant of ['form', 'held-shop', 'held-injected'] as const) {
      const server = fakeServer();
      const tokens = variant === 'held-shop' ? shopUser(server, 'uid-default-edit-mounted') : undefined;
      server.patches.push('rollback-503');
      const { view } = await editable(server, { keys: [key(1)], defaultEditHolds: variant === 'held-shop', tokens });
      const uid = access.get().uid!;
      await openForm();
      fillEdit({ name: 'Ada King', phone: '+1 555 0199', email: 'king@example.test' });
      if (variant !== 'form') {
        await click('directory-edit-save');
        await heldEditState();
      }
      const mark = server.sent.length;
      const alerts = countAlerts(ENDED_HELD_TEXT);
      await signOut(view);
      expect(detailPhase()).toBe('signed-out');
      expect(screen.queryByTestId('directory-edit-name')).toBeNull();
      expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
      expect(page()).not.toMatch(/Ada King|555 0199|king@|555 0100|ada@example/); // typed and profile contacts alike
      expect(editStatus().textContent).toBe(variant === 'form' ? '' : ENDED_HELD_TEXT);
      if (variant === 'held-injected') expect(view.editHolds.get(uid)).toBeUndefined();
      await settle();
      expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
      await click('directory-detail-retry'); // Reconnect: the one control that signs in
      await waitFor(() => expect(detailPhase()).toBe('ready'));
      await settle();
      expect(screen.queryByTestId('directory-edit-name')).toBeNull();
      expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
      expect(editStatus().textContent).toBe(variant === 'form' ? '' : ENDED_HELD_TEXT); // never named
      expect(alerts.stop()).toBe(variant === 'form' ? 0 : 1); // announced once: not again at the Reconnect
      await openForm(); // the typed draft went with the ended form: the form starts from the profile read now
      expect([editInput('name').value, editInput('phone').value, editInput('email').value]).toEqual(['Ada Lovelace', PHONE, EMAIL]);
      expect(patches(server)).toHaveLength(variant === 'form' ? 0 : 1);
      cleanup();
      vi.restoreAllMocks();
      access.set({ uid: 'uid-a', canEdit: false });
    }
  });

  it('SCD-180. REGRESSION GUARD (it passes on the entry source too: the mounted page dropped the attempt, so its answer is key-guarded) — the late answer of an edit a sign-out dropped while its PATCH was out (a 200 that committed, a 409 conflict, a 503 after commit, no answer) revives nothing: no "Saved", conflict or refusal — unknown stays unknown, only the unnamed notice — no form, card, token or body, no read-back, send or sign-in; after Reconnect nothing of it is said or sent', async () => {
    for (const late of ['200', '409', '503', 'network'] as const) {
      for (const store of ['shop', 'injected'] as const) {
        const server = fakeServer();
        const tokens = store === 'shop' ? shopUser(server, `uid-default-edit-late-${late}`) : undefined;
        if (late === '503') server.patches.push('commit-then-503');
        const delivered: string[] = []; // what the customers client made of the late answer: proof it reached the page
        const wrapCustomers = (c: CustomersClient): CustomersClient => ({
          ...c,
          update: async (...args) => {
            try {
              const r = await c.update(...args);
              delivered.push(r.kind === 'unknown' ? `unknown:${r.responded}` : r.kind);
              return r;
            } catch (error) {
              delivered.push('threw');
              throw error;
            }
          },
        });
        const { view, ada } = await editable(server, { keys: [key(1)], defaultEditHolds: store === 'shop', tokens, wrapCustomers });
        const uid = access.get().uid!;
        await openForm();
        fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
        if (late === '409') server.editElsewhere(ada.id, 'Ada Byron');
        server.hold.patches = 1;
        await click('directory-edit-save');
        await waitFor(() => expect(server.held).toHaveLength(1));
        await signOut(view);
        expect(editStatus().textContent).toBe(ENDED_HELD_TEXT);
        const mark = server.sent.length;
        await act(async () => { server.held[0].release(late === 'network' ? 'drop' : undefined); });
        await settle();
        const label = `late ${late}, ${store} store`;
        // Delivered first: the held answer drained and reached the page as the client reads it (a 200 that committed).
        expect(delivered, label).toEqual([{ 200: 'saved', 409: 'conflict', 503: 'unknown:true', network: 'unknown:false' }[late]]);
        if (late === '200') expect(server.rows[TENANT_A].find((r) => r.id === ada.id)!.name, label).toBe('Ada King');
        expect(server.sent.slice(mark), label).toEqual([]); // no read-back, no session check, no send
        expect(editStatus().textContent, label).toBe(ENDED_HELD_TEXT);
        expect(screen.queryByTestId('directory-edit-name')).toBeNull();
        expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
        expect(page()).not.toMatch(/Ada King|555 0199/);
        if (store === 'injected') expect([view.editHolds.get(uid), view.editHolds.takeOutcome(uid)]).toEqual([undefined, undefined]);
        await click('directory-detail-retry');
        await waitFor(() => expect(detailPhase()).toBe('ready'));
        await settle();
        expect(editStatus().textContent).toBe(ENDED_HELD_TEXT);
        expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
        expect(patches(server)).toHaveLength(1);
        cleanup();
        vi.restoreAllMocks();
        access.set({ uid: 'uid-a', canEdit: false });
      }
    }
  });

  // SCD-181: one case per variant, so each is judged on its own (also on the entry source).
  for (const where of ['mounted', 'gone'] as const) {
    for (const store of ['shop', 'unbound'] as const) {
      for (const order of ['before', 'after'] as const) {
        it(`SCD-181 (${where}, ${store} store, answered ${order} the sign-out). ${where === 'gone' && order === 'before' ? '' : 'REGRESSION GUARD (it passes on the entry source too) — '}a Check again whose session check answers just before a sign-out begins, or just after, sends nothing — on its page or after that page has gone, with the shop's store or with a store that hears no sign-out: only the logout goes out, and the shop's store keeps nothing of the edit to check later`, async () => {
          const server = fakeServer();
          const tokens = store === 'shop' ? shopUser(server, `uid-default-edit-check-${where}-${order}`) : undefined;
          server.patches.push('rollback-503');
          let trip = false;
          let mark = -1;
          // `before`: the sign-out begins after the session check has answered, before Check again's continuation runs.
          const wrapSession = (c: TenantSessionClient): TenantSessionClient => ({
            ...c, ensure: async (...args) => { const s = await c.ensure(...args); if (trip) { trip = false; mark = server.sent.length; void c.logout(); } return s; },
          });
          const { view } = await editable(server, { keys: [key(1), key(2)], defaultEditHolds: store === 'shop', tokens, wrapSession });
          await openForm();
          fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
          await click('directory-edit-save');
          await heldEditState();
          server.hold.checks = 1; // Check again's session check is held at the front
          await click('directory-edit-check');
          await waitFor(() => expect(server.held).toHaveLength(1));
          if (where === 'gone') await view.go('/elsewhere');
          if (order === 'before') {
            trip = true;
            await act(async () => { server.held[0].release(); });
          } else {
            mark = server.sent.length;
            await signOut(view);
            await act(async () => { server.held[0].release(); });
          }
          await settle();
          if (order === 'before') expect(trip).toBe(false); // the sign-out did begin between the answer and its use
          expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
          expect(patches(server)).toHaveLength(1);
          if (store === 'shop') {
            if (where === 'gone') await view.go('/customers/directory');
            await settle();
            expect(screen.queryByTestId('directory-edit-hold')).toBeNull();
            expect(screen.queryByTestId('directory-edit-check')).toBeNull();
            expect(patches(server)).toHaveLength(1);
          }
        });
      }
    }
  }

  // SCD-182: one case per variant.
  for (const when of ['settled-before', 'settled-after'] as const) {
    it(`SCD-182 (${when}). an edit outcome recorded under a session that a sign-out then ended is dropped with it: when a logout that never reached the server leaves that SAME session to be found again, the customer's page says only the unnamed notice — no "Saved", no name, no list or profile read-back; an answer that settles after the sign-out records nothing at all`, async () => {
      const server = fakeServer();
      const tokens = shopUser(server, `uid-default-edit-reused-${when}`);
      const { view, ada } = await editable(server, { keys: [key(1)], defaultEditHolds: true, tokens });
      await openForm();
      fillEdit({ name: 'Ada King' });
      server.hold.patches = 1;
      await click('directory-edit-save');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere'); // the page that sent it goes: its answer settles in the store only
      if (when === 'settled-before') {
        await act(async () => { server.held[0].release(); });
        await settle();
      }
      await signOutUnsent(server, view);
      if (when === 'settled-after') {
        await act(async () => { server.held[0].release(); });
        await settle();
      }
      const [listsBefore, detailsBefore] = [lists(server).length, details(server).length];
      await view.go(`/customers/directory/${ada.id}`);
      await waitFor(() => expect(detailPhase()).toBe('ready'));
      await settle();
      expect(logins(server)).toHaveLength(1); // the same session, found again
      expect(editStatus().textContent).toBe(ENDED_HELD_TEXT);
      expect(lists(server)).toHaveLength(listsBefore + 1); // the page's own first reads, nothing more
      expect(details(server)).toHaveLength(detailsBefore + 1);
      expect(screen.getByTestId('directory-edit')).toBeInTheDocument();
      expect(patches(server)).toHaveLength(1);
    });
  }

  it('SCD-183. the unnamed notice of an edit a sign-out dropped stays through a later ended answer: a Reconnect whose session step finds no sign-in (the identity gone, as after a real sign-out) keeps it, and reads, sends and signs in nothing', async () => {
    const server = fakeServer();
    const tokens: Record<string, string> = { 'uid-a': 'tok-a' };
    server.patches.push('rollback-503');
    const { view } = await editable(server, { keys: [key(1)], tokens });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await heldEditState();
    delete tokens['uid-a'];
    await signOut(view);
    expect(editStatus().textContent).toBe(ENDED_HELD_TEXT);
    const mark = server.sent.length;
    await click('directory-detail-retry');
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveTextContent('Sign in with your store account'));
    await settle();
    expect(detailPhase()).toBe('signed-out');
    expect(editStatus().textContent).toBe(ENDED_HELD_TEXT);
    expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]); // the check only: no login
    expect(patches(server)).toHaveLength(1);
  });

  it('SCD-184. an ended session a read finds also drops an edit outcome an older page recorded under it: the page says only the unnamed notice; after Reconnect (a new session) nothing of it is named, read back or sent', async () => {
    const server = fakeServer();
    const store = createEditHoldStore();
    const { view } = await editable(server, { keys: [key(1)], editHolds: store });
    await openForm();
    fillEdit({ name: 'Ada King' });
    server.hold.patches = 1;
    await click('directory-edit-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere'); // the page that sent it goes: its answer is recorded for the next page of this user
    await act(async () => { server.held[0].release(); });
    await settle();
    server.sessions.clear(); // the session ends on the server: the next page's first check finds it ended
    await view.go('/customers/directory');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    await settle();
    expect(editStatus().textContent).toBe(ENDED_HELD_TEXT);
    expect(store.takeOutcome('uid-a')).toBeUndefined();
    const listsBefore = lists(server).length;
    await click('directory-retry'); // Reconnect
    await ready();
    await settle();
    expect(lists(server)).toHaveLength(listsBefore + 1); // the Reconnect's own read only
    expect(editStatus().textContent).toBe(ENDED_HELD_TEXT);
    expect(patches(server)).toHaveLength(1);
  });
  it('SCD-185. an ended mark is its own user\'s: A\'s held edit dropped by a sign-out while no page is mounted, then B\'s page (another user) mounts and says nothing of it, then A\'s next page says the unnamed notice — once: the page after that says nothing', async () => {
    const server = fakeServer();
    const [a, b] = ['uid-default-edit-aba-a', 'uid-default-edit-aba-b'];
    server.users[`tok-${b}`] = { uid: b, tenant: TENANT_B, view: true, create: true, edit: true };
    const tokens = { ...shopUser(server, a), [b]: `tok-${b}` };
    server.patches.push('rollback-503');
    const { view } = await editable(server, { keys: [key(1)], defaultEditHolds: true, tokens });
    await openForm();
    fillEdit({ name: 'Ada King' });
    await click('directory-edit-save');
    await heldEditState();
    await view.go('/elsewhere');
    await signOut(view);
    act(() => access.set({ uid: b })); // another user signs in: their page drops every other user's edit (keepOnly)
    await view.go('/customers/directory');
    await ready();
    await settle();
    expect(editStatus().textContent).toBe('');
    await view.go('/elsewhere');
    act(() => access.set({ uid: a }));
    await view.go('/customers/directory');
    await ready();
    await waitFor(() => expect(editAlert().textContent).toBe(ENDED_HELD_TEXT));
    await view.go('/elsewhere');
    await view.go('/customers/directory');
    await ready();
    await settle();
    expect(editStatus().textContent).toBe(''); // the mark was taken by the page that said it
    expect(patches(server)).toHaveLength(1);
  });

  // SCD-186: Save's analogue of SCD-181, one case per variant.
  for (const store of ['shop', 'injected'] as const) {
    for (const order of ['before', 'after'] as const) {
      it(`SCD-186 (${store} store, answered ${order} the sign-out). REGRESSION GUARD (it passes on the entry source too: the page's generation and the session client's epoch already stop it) — a Save whose session check answers just before a sign-out begins, or just after, sends nothing: no PATCH and no key, no read-back, no replacement login — only the logout goes out`, async () => {
        const server = fakeServer();
        const tokens = store === 'shop' ? shopUser(server, `uid-default-edit-save-${order}`) : undefined;
        let trip = false;
        let mark = -1;
        const wrapSession = (c: TenantSessionClient): TenantSessionClient => ({
          ...c, ensure: async (...args) => { const s = await c.ensure(...args); if (trip) { trip = false; mark = server.sent.length; void c.logout(); } return s; },
        });
        const { view } = await editable(server, { keys: [key(1)], defaultEditHolds: store === 'shop', tokens, wrapSession });
        const uid = access.get().uid!;
        await openForm();
        fillEdit({ name: 'Ada King', phone: '+1 555 0199' });
        const loginsBefore = logins(server).length;
        server.hold.checks = 1; // Save's session check is held at the front
        await click('directory-edit-save');
        await waitFor(() => expect(server.held).toHaveLength(1));
        if (order === 'before') {
          trip = true;
          await act(async () => { server.held[0].release(); });
        } else {
          mark = server.sent.length;
          await signOut(view);
          await act(async () => { server.held[0].release(); });
        }
        await settle();
        if (order === 'before') expect(trip).toBe(false); // the sign-out did begin between the answer and its use
        expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
        expect(patches(server)).toHaveLength(0);
        expect(view.made).toHaveLength(0); // no key was taken
        expect(logins(server)).toHaveLength(loginsBefore);
        expect(detailPhase()).toBe('signed-out');
        expect(page()).not.toMatch(/Ada King|555 0199/);
        if (store === 'injected') expect(view.editHolds.get(uid)).toBeUndefined();
      });
    }
  }
});

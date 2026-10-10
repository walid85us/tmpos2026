// M7B-INVOICES-P1 — the Invoices page's "Server drafts" section in jsdom: the REAL section over the REAL tenant session,
// invoice drafts and customers clients, each wired to one fake tenant server at the network boundary (sessions, store
// discovery, the store's drafts with an idempotency ledger keyed like the server's, customer reads; synthetic tenants,
// stores, users, customers and drafts only — ids built at run time). Ordering is controlled with the fake's hold/release
// and its per-request scripts (no sleeps; the one rate-limit wait that is timed, SID-36's, runs on a fake clock); clocks
// and keys are injected. Every assertion about a request is made on what
// the fake recorded — the wire — and every assertion about an attempt on the hold store the section was given.
// Closing round (DA-198, DA-199): a sign-out heard through the session client's `onSessionEnd` — the hold store bound
// to it, the shop's own store in the page, a save whose session answered just before it, the picker's pair
// (SID-43..45), a list, name or reopen read out when it begins (SID-49), a Check again or a 403's fresh check whose
// session answered just before it (SID-51, SID-52), a rate limit's wait (SID-53) — and where focus goes outside the
// dialogs when a control it was on goes away or is disabled (SID-46..48: each named site, not every possible render),
// and where it stays when the user left it on <body> (SID-50). M7B-INVOICES-P1-R2 (AC-07): the new-draft dialog's
// hand-over against a new generation adopted before its answer and a session end the section found before its answer
// (SID-55, SID-56), plus a sign-out during its session check (SID-54, a regression guard: it passes on the entry commit
// too), each with the dialog's own check held by a session wrapper aimed at the first check asked while that dialog is
// up; and StrictMode's double setup (SID-57). M7B-INVOICES-P1-R2 (DA-201): New server draft follows the server's
// eligibility read (the fake answers it from the same per-role `allow` table as its saves): the offer for exactly the
// store and session asked (SID-58), a role the server does not allow (SID-59), unavailable, 401, 403 and 429 answers
// (SID-60..62), answers outrun by a store change, a newer check, a sign-out, a user switch or a new generation, released
// in both orders (SID-63..65), a save's 403 and 429 (SID-66, SID-67), Save and Check again unchanged (SID-68) and the
// check's owner and lifetime (SID-69); SID-48 and SID-50 take New away through the server (Try again, a new generation)
// instead of the local role hint the section no longer has. M7B-INVOICES-P1-R3 (SDB-05, AC-15): the edit-eligibility read
// against a sign-out in both orders, by the fake's record of what the page INITIATED — the sign-out begun before the read is
// initiated, its session read held across it or answered just before it (SID-112), and the read initiated before the
// sign-out with its answer released after it (SID-113).
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { StrictMode, type ReactNode } from 'react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DRAFTS_TEXT, DRAFT_RULE_TEXT, EDIT_ELIGIBILITY_TEXT, EDIT_REFUSED_TEXT, EDIT_TEXT, ELIGIBILITY_TEXT, HOLD_TEXT, NOT_SENT_TEXT, REFUSED_TEXT, ServerInvoiceDrafts,
  bindDraftHoldsToSessionEnd, createDraftHoldStore, customerFallbackText, storeLabel, type DraftHoldStore, type HeldDraft, type ServerInvoiceDraftsProps,
} from './ServerInvoiceDrafts';
import { STORES_PATH, createInvoiceDraftsClient, draftPathOf, draftsPathOf, editEligibilityPathOf, eligibilityPathOf, type StoreEntry } from './invoiceDraftsClient';
import { CUSTOMERS_PATH, createCustomersClient } from './customersClient';
import { TENANT_SESSION_PATHS, createTenantSessionClient, onSessionEnd, sessionEndsSoFar, type TenantSessionClient } from './tenantSessionClient';
import { ServerCustomerField, hasSessionPair, isContextOf, pickerWaitText, sessionContextOf } from './ServerCustomerPicker';
import { parseCustomerDirectoryQuery } from '../../server/runtime/customerDirectory';
import { sessionSubjectOf } from '../../server/runtime/sessions';

const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const STORE_1 = uuid(0x51);
const STORE_2 = uuid(0x52);
const STORE_RO = uuid(0x53);
const at = (second: number, micros = 0): string => `2026-10-04T12:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.${String(micros).padStart(6, '0')}Z`;
const activeBody = (uid: string, csrfToken: string) =>
  ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });
// The server's continuation (server/runtime/invoiceDrafts.ts encodeInvoiceDraftCursor): the tag byte 0x01 and the anchor's
// 16 id bytes, unpadded base64url. The client accepts no other tag.
const cursorOf = (id: string): string => Buffer.concat([Buffer.from([0x01]), Buffer.from(id.replace(/-/g, ''), 'hex')]).toString('base64url');
const idOfCursor = (cursor: string): string | null => {
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.length !== 17 || bytes[0] !== 0x01) return null;
  const hex = bytes.subarray(1).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined; readonly signal: AbortSignal | null | undefined }
/** `role`: the role the server holds for the user — the fake's `allow` table decides a draft save and its eligibility by it. */
interface User { uid: string; tenant: string; view: boolean; role: string }
interface Line { position: number; description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }
interface Draft { id: string; storeId: string; customerId: string; createdAt: string; subtotalCents: number; lines: Line[]; version: number }
type Kind = 'stores' | 'list' | 'get' | 'names' | 'create' | 'customers' | 'current' | 'elig' | 'update' | 'editElig';
type CreateScript = 'lose' | 'lose-before' | 503 | 429 | 'hold' | 'key-reused';
/** M7B-INVOICES-P2: what the next PATCHes do — lose the answer after deciding (committed), lose the request, or answer this status (in the chain's envelope) instead. */
type UpdateScript = 'lose' | 'lose-before' | number;

/** One fake tenant server. `cookie` is the session the browser presents. */
function fakeServer() {
  const users: Record<string, User> = { 'tok-a': { uid: 'uid-a', tenant: TENANT_A, view: true, role: 'owner' }, 'tok-b': { uid: 'uid-b', tenant: TENANT_B, view: true, role: 'owner' } };
  const sessions = new Map<string, { user: User; csrf: string }>();
  let sessionCount = 0;
  let draftCount = 0xd00;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers } });
  // A refusal as the server sends it: `{ error, requestId }` with the word the server pairs with the status (app.ts refuse,
  // sessions.ts, invoiceDrafts.ts) — the drafts client decides a read's refusal only in that exact envelope. A 429 carries
  // `retryAfter` (seconds, as text) when one is set.
  const WORDS: Record<number, string> = {
    400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited', 500: 'internal_error', 503: 'service_unavailable',
  };
  const refuse = (status: number, error = WORDS[status] ?? `e${status}`): Response =>
    reply(status, { error, requestId: 'req-synthetic' }, status === 429 && server.retryAfter !== null ? { 'retry-after': server.retryAfter } : {});
  const order = (x: Draft, y: Draft): number => (x.createdAt === y.createdAt ? (x.id < y.id ? 1 : -1) : x.createdAt < y.createdAt ? 1 : -1);
  const summaryOf = (d: Draft) => ({ id: d.id, customerId: d.customerId, status: 'draft', currency: 'USD', lineCount: d.lines.length, subtotalCents: d.subtotalCents, createdAt: d.createdAt });
  const detailOf = (d: Draft) => ({ draft: { id: d.id, storeId: d.storeId, customerId: d.customerId, status: 'draft', currency: 'USD', version: d.version, createdAt: d.createdAt, subtotalCents: d.subtotalCents, lines: d.lines } });

  const server = {
    sent: [] as Sent[],
    users,
    cookie: null as string | null,
    stores: { 'uid-a': [] as StoreEntry[], 'uid-b': [] as StoreEntry[] } as Record<string, StoreEntry[]>,
    drafts: [] as Draft[],
    customers: new Map<string, { tenant: string; name: string }>(),
    keys: new Map<string, { fingerprint: string; response: { status: number; body: unknown; location?: string } }>(),
    creates: [] as CreateScript[], // what the next creates do, in order (then normally)
    detailStatus: [] as number[], // what the next draft GETs answer instead (500, 404…), in order
    listStatus: [] as number[], // what the next list GETs answer instead (401…), in order
    retryAfter: null as string | null, // the Retry-After a 429 carries
    // M7B-INVOICES-P1-R2: the server's per-role decision of a draft save — the same table answers its eligibility read
    // (one requirement for both, as invoiceDrafts.ts). A role absent here, like a role only the browser knows, is denied.
    allow: { owner: true, manager: true, technician: false, sales: true } as Record<string, boolean>,
    eligStatus: [] as Array<number | Response>, // what the next eligibility GETs answer instead (a status, or a whole answer), in order
    // M7B-INVOICES-P2: the server's per-role decision of a draft edit (Invoices Edit) — the same table answers its edit
    // eligibility. `sales` saves drafts (Invoices Create) but may not edit them.
    editAllow: { owner: true, manager: true } as Record<string, boolean>,
    editEligStatus: [] as Array<number | Response>, // what the next edit-eligibility GETs answer instead, in order
    updates: [] as UpdateScript[], // what the next PATCHes do (then normally)
    currentStatus: [] as number[], // what the next session reads (GET /api/v1/session) answer instead (503, 429…), in order
    nameStatus: new Map<string, number>(), // a customer read answered with this status
    nameInFlight: 0,
    nameMaxInFlight: 0,
    second: 100,
    hold: { stores: 0, list: 0, get: 0, names: 0, create: 0, customers: 0, current: 0, elig: 0, update: 0, editElig: 0 } as Record<Kind, number>,
    held: [] as Array<{ kind: Kind; url: string; release: (late?: Response) => void }>,
    seedCustomer(tenant: string, name: string): string {
      const id = uuid(0xc00 + server.customers.size + 1);
      server.customers.set(id, { tenant, name });
      return id;
    },
    seedDraft(storeId: string, customerId: string, createdAt: string, cents = 1250, lines = 1): Draft {
      const each = Array.from({ length: lines }, (_, i) => ({ position: i + 1, description: `Item ${i + 1}`, quantity: 1, unitPriceCents: cents, lineTotalCents: cents }));
      const draft: Draft = { id: uuid(++draftCount), storeId, customerId, createdAt, subtotalCents: cents * lines, lines: each, version: 1 };
      server.drafts.push(draft);
      return draft;
    },
    /** An edit committed on the server (by this browser's PATCH, or by another session): the next version. */
    editDraft(draft: Draft, customerId: string, lines: Array<Omit<Line, 'position' | 'lineTotalCents'>>): void {
      draft.customerId = customerId;
      draft.lines = lines.map((l, i) => ({ position: i + 1, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.quantity * l.unitPriceCents }));
      draft.subtotalCents = draft.lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
      draft.version += 1;
    },
    /** The PATCHes sent (M7B-INVOICES-P2). */
    patches(): Sent[] { return server.sent.filter((r) => r.method === 'PATCH'); },
    /** The edit-eligibility reads sent. */
    editEligReads(): Sent[] { return server.sent.filter((r) => r.url.endsWith('/edit-eligibility')); },
    /** The draft GETs (reopen, read-back, a conflict's read) of `id`. */
    detailReads(storeId: string, id: string): Sent[] { return server.sent.filter((r) => r.method === 'GET' && r.url === draftPathOf(storeId, id)); },
    mayEdit(user: User, storeId: string): boolean {
      const grant = server.stores[user.uid]?.find((s) => s.id === storeId);
      return grant !== undefined && !grant.readOnly && server.editAllow[user.role] === true;
    },
    expire(): void { sessions.clear(); },
    /** Another tab signs `uid` in: a new session (and token) replaces the cookie this browser presents. */
    otherTab(uid: string): void {
      const user = Object.values(users).find((u) => u.uid === uid)!;
      sessionCount += 1;
      server.cookie = `session-${sessionCount}`;
      sessions.set(server.cookie, { user, csrf: `${'t'.repeat(40)}${String(sessionCount).padStart(3, '0')}` });
    },
    posts(): Sent[] { return server.sent.filter((r) => r.method === 'POST' && r.url.startsWith(STORES_PATH)); },
    /** The eligibility reads sent (of `store`, when named). */
    eligReads(store?: string): Sent[] { return server.sent.filter((r) => r.url.endsWith('/invoice-drafts/eligibility') && (store === undefined || r.url === eligibilityPathOf(store))); },
    /** A save at `storeId` would be authorized for `user` now: a usable, writable grant and a role the table allows. */
    mayCreate(user: User, storeId: string): boolean {
      const grant = server.stores[user.uid]?.find((s) => s.id === storeId);
      return grant !== undefined && !grant.readOnly && server.allow[user.role] === true;
    },
    async maybeHold(kind: Kind, url: string, answer: Response | (() => Response)): Promise<Response> {
      if (server.hold[kind] > 0) {
        server.hold[kind] -= 1;
        const late = await new Promise<Response | undefined>((release) => { server.held.push({ kind, url, release }); });
        if (late !== undefined) return late;
      }
      return typeof answer === 'function' ? answer() : answer;
    },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : undefined;
      server.sent.push({ method, url, headers, body, signal: init.signal });
      if (url === TENANT_SESSION_PATHS.login && method === 'POST') {
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403);
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return refuse(401);
        sessionCount += 1;
        server.cookie = `session-${sessionCount}`;
        sessions.set(server.cookie, { user, csrf: `${'s'.repeat(40)}${String(sessionCount).padStart(3, '0')}` });
        return reply(200, activeBody(user.uid, sessions.get(server.cookie)!.csrf));
      }
      const session = server.cookie === null ? undefined : sessions.get(server.cookie);
      if (url === TENANT_SESSION_PATHS.current && method === 'GET') { // every `ensure` reads it first (tenantSessionClient.ts)
        const scripted = server.currentStatus.shift(); // M7B-INVOICES-P2: a session read that answers this status instead
        if (scripted !== undefined) return refuse(scripted);
        return server.maybeHold('current', url, () => (session === undefined ? refuse(401) : reply(200, activeBody(session.user.uid, session.csrf))));
      }
      const gate = (): Response | null => {
        if (session === undefined) return refuse(401);
        if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, 'forbidden');
        return null;
      };
      const path = url.split('?')[0];
      if (method === 'GET' && path === STORES_PATH) {
        const decided = gate() ?? reply(200, { stores: server.stores[session!.user.uid] ?? [] });
        return server.maybeHold('stores', url, decided);
      }
      if (method === 'GET' && path === CUSTOMERS_PATH) { // the picker's list read
        const decided = gate() ?? (() => {
          const query = parseCustomerDirectoryQuery(url);
          if (query === null) return refuse(400);
          const rows = [...server.customers.entries()].filter(([, c]) => c.tenant === session!.user.tenant).map(([id, c]) => ({ id, name: c.name }));
          return reply(200, { customers: rows.slice(0, 50), nextCursor: null });
        })();
        return server.maybeHold('customers', url, decided);
      }
      const customer = /^\/api\/v1\/customers\/([0-9a-f-]{36})$/.exec(url);
      if (method === 'GET' && customer !== null) {
        const refused = gate();
        server.nameInFlight += 1;
        server.nameMaxInFlight = Math.max(server.nameMaxInFlight, server.nameInFlight);
        try {
          return await server.maybeHold('names', url, () => {
            if (refused !== null) return refused;
            const status = server.nameStatus.get(customer[1]);
            if (status !== undefined) return refuse(status);
            const c = server.customers.get(customer[1]);
            return c === undefined || c.tenant !== session!.user.tenant ? refuse(404, 'not_found') : reply(200, { customer: { id: customer[1], name: c.name } });
          });
        } finally { server.nameInFlight -= 1; }
      }
      const eligibility = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoice-drafts\/eligibility$/.exec(url); // no query: the server refuses one
      if (method === 'GET' && eligibility !== null) {
        const decided = gate() ?? (() => {
          const scripted = server.eligStatus.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          return server.mayCreate(session!.user, eligibility[1]) ? reply(200, { eligibility: 'allowed' }) : refuse(403, 'forbidden');
        })();
        return server.maybeHold('elig', url, decided);
      }
      const editEligibility = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoice-drafts\/([0-9a-f-]{36})\/edit-eligibility$/.exec(url); // reads no draft
      if (method === 'GET' && editEligibility !== null) {
        const decided = gate() ?? (() => {
          const scripted = server.editEligStatus.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          return server.mayEdit(session!.user, editEligibility[1]) ? reply(200, { eligibility: 'allowed' }) : refuse(403, 'forbidden');
        })();
        return server.maybeHold('editElig', url, decided);
      }
      const storePath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoice-drafts(?:\/([0-9a-f-]{36}))?$/.exec(path);
      if (storePath !== null) {
        const [, storeId, draftId] = storePath;
        const refused = gate();
        const grant = refused === null ? server.stores[session!.user.uid]?.find((s) => s.id === storeId) : undefined;
        if (method === 'GET' && draftId === undefined) {
          return server.maybeHold('list', url, () => {
            if (refused !== null) return refused;
            if (grant === undefined) return refuse(403, 'forbidden');
            const scripted = server.listStatus.shift();
            if (scripted !== undefined) return refuse(scripted);
            const params = new URLSearchParams(url.split('?')[1] ?? '');
            const limit = Number(params.get('limit') ?? '20');
            const all = server.drafts.filter((d) => d.storeId === storeId).sort(order);
            const cursor = params.get('cursor');
            const anchorId = cursor === null ? null : idOfCursor(cursor);
            const anchor = anchorId === null ? null : all.findIndex((d) => d.id === anchorId);
            if (cursor !== null && (anchor === null || anchor < 0)) return refuse(400, 'invalid_request');
            const rest = anchor === null ? all : all.slice(anchor + 1);
            const page = rest.slice(0, limit);
            return reply(200, { drafts: page.map(summaryOf), nextCursor: rest.length > limit ? cursorOf(page[page.length - 1].id) : null });
          });
        }
        if (method === 'GET' && draftId !== undefined) {
          return server.maybeHold('get', url, () => {
            if (refused !== null) return refused;
            if (grant === undefined) return refuse(403, 'forbidden');
            const scripted = server.detailStatus.shift();
            if (scripted !== undefined) return refuse(scripted);
            const draft = server.drafts.find((d) => d.id === draftId && d.storeId === storeId);
            return draft === undefined ? refuse(404, 'not_found') : reply(200, detailOf(draft));
          });
        }
        if (method === 'POST' && draftId === undefined) {
          const script = server.creates.shift();
          if (script === 'lose-before') throw new TypeError('network');
          if (script === 503) return refuse(503, 'service_unavailable');
          if (script === 429) return refuse(429, 'rate_limited');
          const decide = (): Response => {
            if (refused !== null) return refused;
            if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
            if (grant === undefined || grant.readOnly || server.allow[session!.user.role] !== true) return refuse(403, 'forbidden');
            const key = headers.get('idempotency-key') ?? '';
            const fingerprint = `${storeId}\n${body}`;
            const known = server.keys.get(key);
            if (script === 'key-reused' || (known !== undefined && known.fingerprint !== fingerprint)) return refuse(422, 'idempotency_key_reused');
            if (known !== undefined) {
              const r = known.response;
              return reply(r.status, r.body, { 'idempotent-replayed': 'true', ...(r.location !== undefined ? { location: r.location } : {}) });
            }
            const parsed = JSON.parse(body ?? '{}') as { expectedTenant: string; customerId: string; lines: Array<{ description: string; quantity: number; unitPriceCents: number }> };
            if (parsed.expectedTenant !== grant.tenantId) return refuse(409, 'write_conflict'); // unsealed
            const c = server.customers.get(parsed.customerId);
            if (c === undefined || c.tenant !== grant.tenantId) {
              server.keys.set(key, { fingerprint, response: { status: 422, body: { error: 'customer_not_found' } } }); // sealed
              return reply(422, { error: 'customer_not_found' });
            }
            const lines = parsed.lines.map((l, i) => ({ position: i + 1, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.quantity * l.unitPriceCents }));
            const draft: Draft = { id: uuid(++draftCount), storeId, customerId: parsed.customerId, createdAt: at(server.second++, 123456), subtotalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0), lines, version: 1 };
            server.drafts.push(draft);
            const response = { status: 201, body: { draft: { id: draft.id, status: 'draft', currency: 'USD', lineCount: lines.length, subtotalCents: draft.subtotalCents } }, location: draftPathOf(storeId, draft.id) };
            server.keys.set(key, { fingerprint, response });
            return reply(201, response.body, { location: response.location });
          };
          const decided = decide();
          if (script === 'lose') throw new TypeError('network'); // committed, but the answer is lost
          if (script === 'hold') { server.hold.create += 1; }
          return server.maybeHold('create', url, decided);
        }
        // M7B-INVOICES-P2: the edit, keyed like the server's (the store, the DRAFT and the exact bytes): a sealed 200 or 409
        // replays under its key; the tenant precondition and a missing draft or customer are unsealed (nothing recorded).
        if (method === 'PATCH' && draftId !== undefined) {
          const script = server.updates.shift();
          if (script === 'lose-before') throw new TypeError('network');
          if (typeof script === 'number') return refuse(script);
          const decide = (): Response => {
            if (refused !== null) return refused;
            if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
            if (grant === undefined || !server.mayEdit(session!.user, storeId)) return refuse(403, 'forbidden');
            const key = headers.get('idempotency-key') ?? '';
            const fingerprint = `${storeId}\n${draftId}\n${body}`;
            const known = server.keys.get(key);
            if (known !== undefined && known.fingerprint !== fingerprint) return refuse(422, 'idempotency_key_reused');
            if (known !== undefined) return reply(known.response.status, known.response.body, { 'idempotent-replayed': 'true' });
            const parsed = JSON.parse(body ?? '{}') as { expectedTenant: string; expectedVersion: number; customerId: string; lines: Array<{ description: string; quantity: number; unitPriceCents: number }> };
            if (parsed.expectedTenant !== grant.tenantId) return refuse(409, 'write_conflict'); // unsealed
            const draft = server.drafts.find((d) => d.id === draftId && d.storeId === storeId);
            const c = server.customers.get(parsed.customerId);
            if (draft === undefined || c === undefined || c.tenant !== grant.tenantId) return refuse(404, 'not_found'); // one answer for both
            const seal = (status: number, sealed: unknown): Response => { server.keys.set(key, { fingerprint, response: { status, body: sealed } }); return reply(status, sealed); };
            if (draft.version !== parsed.expectedVersion) return seal(409, { error: 'write_conflict' }); // a stale no-op too
            const lines = parsed.lines.map((l, i) => ({ position: i + 1, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.quantity * l.unitPriceCents }));
            const same = draft.customerId === parsed.customerId && JSON.stringify(draft.lines) === JSON.stringify(lines);
            if (!same) server.editDraft(draft, parsed.customerId, parsed.lines);
            return seal(200, { draftId, version: draft.version, changed: !same });
          };
          const decided = decide();
          if (script === 'lose') throw new TypeError('network'); // committed, but the answer is lost
          return server.maybeHold('update', url, decided);
        }
      }
      return refuse(404, 'not_found');
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

const store = (id: string, name: string | null, readOnly = false, tenantId = TENANT_A): StoreEntry => ({ id, tenantId, name, readOnly });
/** A server with uid-a's three stores (one read-only), in the server's order (name, unnamed last), and two customers of tenant A. */
function seeded() {
  const server = fakeServer();
  server.stores['uid-a'] = [store(STORE_RO, 'Kiosk', true), store(STORE_1, 'Main Street'), store(STORE_2, null)];
  const ada = server.seedCustomer(TENANT_A, 'Ada Customer');
  const bea = server.seedCustomer(TENANT_A, 'Bea Customer');
  return { server, ada, bea };
}

interface Rig { holds: DraftHoldStore; keys: string[]; clock: { mono: number; wall: number }; props: (over?: Partial<ServerInvoiceDraftsProps>) => ServerInvoiceDraftsProps }
function rig(server: Server, holds: DraftHoldStore = createDraftHoldStore()): Rig {
  const keys: string[] = [];
  const clock = { mono: 1_000, wall: Date.UTC(2026, 9, 4, 12) };
  const session = createTenantSessionClient({ fetch: server.fetch });
  const drafts = createInvoiceDraftsClient({ fetch: server.fetch });
  const customers = createCustomersClient({ fetch: server.fetch });
  const identity = { idToken: async (uid: string) => (uid === 'uid-a' ? 'tok-a' : uid === 'uid-b' ? 'tok-b' : null) };
  return {
    holds, keys, clock,
    props: (over = {}) => ({
      uid: 'uid-a', canViewCustomers: true, handoff: null, onHandoffTaken: () => {}, session, drafts, customers, identity, holds,
      now: () => clock.mono, wallNow: () => clock.wall,
      newKey: () => { const k = ['5e1f0000', '1d2f', '4a6b', '9c8d', String(keys.length + 1).padStart(12, '0')].join('-'); keys.push(k); return k; },
      ...over,
    }),
  };
}

const realSetTimeout = globalThis.setTimeout; // the fake clock's test still drains promises on a real macrotask
const flush = () => act(async () => { await new Promise((r) => realSetTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
/** A fake clock for a rate limit's wait (its timer; the section's own clocks are the rig's), driven only by `advance` — never waitFor (as ServerCustomerPicker.test.tsx). */
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** waitFor for the fake clock's test: re-check after each real macrotask (bounded), never on a faked timer. */
const until = async (check: () => void) => {
  for (let i = 0; ; i++) {
    try { check(); return; } catch (error) { if (i >= 200) throw error; await flush(); }
  }
};
const user = () => userEvent.setup();
const click = async (testId: string) => { await user().click(screen.getByTestId(testId)); };
const storeSelect = () => screen.getByTestId('drafts-store') as HTMLSelectElement;
const rows = () => screen.queryAllByTestId('drafts-row');
const hold = () => screen.queryByTestId('drafts-hold');
const listReady = () => waitFor(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'ready'));
const storesReady = () => waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'ready'));
/** The chosen store's eligibility check has answered (a read-only store asks none: there is no note). */
const eligPhase = () => screen.queryByTestId('drafts-elig')?.getAttribute('data-phase') ?? 'none';
const eligSettled = () => waitFor(() => expect(eligPhase()).not.toBe('checking'));
async function showAndChoose(id: string) {
  if (screen.queryByTestId('drafts-show') !== null) await click('drafts-show');
  await storesReady();
  fireEvent.change(storeSelect(), { target: { value: id } });
  await listReady();
  await eligSettled();
}
/** Open "New server draft", choose `customer` with the picker, fill `lines`. */
async function fillDraft(customer: string, lines: Array<[string, string, string]>) {
  await click('drafts-new');
  await click('picker-open');
  await waitFor(() => expect(screen.getByTestId('picker-state')).toHaveAttribute('data-phase', 'ready'));
  const row = screen.getAllByTestId('picker-row').find((r) => r.getAttribute('data-id') === customer)!;
  await user().click(within(row).getByTestId('picker-select'));
  await waitFor(() => expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', customer));
  for (let i = 1; i < lines.length; i++) await click('draft-new-add-line');
  for (const [i, [description, quantity, price]] of lines.entries()) {
    fireEvent.change(screen.getAllByTestId('draft-new-description')[i], { target: { value: description } });
    fireEvent.change(screen.getAllByTestId('draft-new-quantity')[i], { target: { value: quantity } });
    fireEvent.change(screen.getAllByTestId('draft-new-price')[i], { target: { value: price } });
  }
}
/** Save one line under a lost first send (it never reached the server), then close the dialog: the attempt is held unresolved in the section. */
async function heldInSection(server: Server, customer: string) {
  await fillDraft(customer, [['Fan', '1', '9.99']]);
  server.creates.push('lose-before');
  await click('draft-new-save');
  await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
  await click('draft-new-cancel');
}
const HOUR = 60 * 60_000;
const bodyOf = (tenant: string, customerId: string, lines: Array<[string, number, number]>) =>
  JSON.stringify({ expectedTenant: tenant, customerId, currency: 'USD', lines: lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity, unitPriceCents })) });
/**
 * Focus on <body> after any DOM change from here (a removed or disabled control's), until `stop`. Its callbacks run once
 * React's commit (layout effects included) is over: a recovery made before paint is what it sees, as a user would.
 */
const watchBody = () => {
  const fell: string[] = [];
  const observer = new MutationObserver(() => { if (document.activeElement === null || document.activeElement === document.body) fell.push('body'); });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  return { fell, stop: () => observer.disconnect() };
};
/** A refusal in the server's envelope, for a held read's late answer. */
const refusal = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error, requestId: 'req-synthetic' }), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
/** A programmatic focus target shows the file's focus-visible ring, never `focus:outline-none` (jsdom has no styles: the classes are what can be checked). */
const ringed = (node: HTMLElement): void => {
  expect(node).toHaveClass('focus-visible:outline-2', 'focus-visible:outline-offset-2', 'focus-visible:outline-sky-700');
  expect(node).not.toHaveClass('focus:outline-none');
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Server drafts — store choice, list and reopen (M7B-INVOICES-P1)', () => {
  it('SID-01. nothing is read before "Show server drafts"; then the stores are listed by name or ID ending, none preselected, read-only marked', async () => {
    const { server } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await settle();
    expect(server.sent).toEqual([]);
    expect(screen.getByTestId('drafts-section')).toHaveTextContent('Server drafts');
    await click('drafts-show');
    await storesReady();
    const options = [...storeSelect().options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['', 'Choose a store…'], [STORE_RO, 'Kiosk (read-only)'], [STORE_1, 'Main Street'], [STORE_2, `Store, ID ending ${STORE_2.slice(-8)}`],
    ]);
    expect(storeSelect().value).toBe(''); // never preselected
    expect(screen.getByTestId('drafts-choose')).toHaveTextContent(DRAFTS_TEXT.chooseStore);
    expect(server.sent.filter((s) => s.url.includes('/invoice-drafts'))).toEqual([]);
    expect(storeLabel({ id: STORE_2, name: '   ' })).toBe(`Store, ID ending ${STORE_2.slice(-8)}`);
  });

  it('SID-02. even a single store is an explicit choice', async () => {
    const server = fakeServer();
    server.stores['uid-a'] = [store(STORE_1, 'Only Store')];
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await click('drafts-show');
    await storesReady();
    expect(storeSelect().value).toBe('');
    expect(screen.queryByTestId('drafts-list-state')).toBeNull();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
  });

  it('SID-03. a store\'s drafts newest first: created time, customer name, lines and Draft subtotal formatted from cents; no amount owed, number or status wording', async () => {
    const { server, ada, bea } = seeded();
    server.seedDraft(STORE_1, ada, at(10), 1999, 2);
    server.seedDraft(STORE_1, bea, at(20, 5), 123456);
    server.seedDraft(STORE_2, ada, at(30)); // another store's: never shown here
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await waitFor(() => expect(screen.getAllByTestId('drafts-row-customer').map((n) => n.textContent)).toEqual(['Bea Customer', 'Ada Customer']));
    expect(screen.getAllByTestId('drafts-row-created').map((n) => n.textContent)).toEqual(['2026-10-04 12:00 UTC', '2026-10-04 12:00 UTC']);
    expect(screen.getAllByTestId('drafts-row-lines').map((n) => n.textContent)).toEqual(['1 line', '2 lines']);
    expect(screen.getAllByTestId('drafts-row-subtotal').map((n) => n.textContent)).toEqual(['Draft subtotal $1,234.56', 'Draft subtotal $39.98']);
    expect(screen.getByTestId('drafts-section').textContent).not.toMatch(/amount due|balance|invoice number|issued|paid|payment|tax|discount/i);
  });

  it('SID-04. Load more over equal timestamps: every draft exactly once in (time, id) order, and the request names only the anchor, never a time', async () => {
    const { server, ada } = seeded();
    const made = Array.from({ length: 25 }, () => server.seedDraft(STORE_1, ada, at(40, 777777)));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    expect(rows()).toHaveLength(20);
    await click('drafts-load-more');
    await waitFor(() => expect(rows()).toHaveLength(25));
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual(made.map((d) => d.id).sort().reverse());
    expect(screen.queryByTestId('drafts-load-more')).toBeNull();
    const lists = server.sent.filter((s) => s.method === 'GET' && s.url.startsWith(`${draftsPathOf(STORE_1)}?`));
    expect(lists.map((s) => s.url.split('?')[1].replace(/cursor=[A-Za-z0-9_-]{23}/, 'cursor=…'))).toEqual(['limit=20', 'limit=20&cursor=…']);
    expect(lists.every((s) => !/2026|T12|%3A/.test(s.url))).toBe(true);
  });

  it('SID-05. a read-only store lists and opens its drafts but offers no new one', async () => {
    const { server, ada } = seeded();
    const draft = server.seedDraft(STORE_RO, ada, at(5), 300, 2);
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_RO);
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId('drafts-read-only')).toHaveTextContent(DRAFTS_TEXT.readOnly);
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    await click('drafts-open'); // opened read-only, as at a writable store
    const view = await screen.findByTestId('draft-view');
    await waitFor(() => expect(within(view).getAllByTestId('draft-view-line')).toHaveLength(2));
    expect(within(view).getByTestId('draft-view-subtotal')).toHaveTextContent('Draft subtotal $6.00');
    expect(within(view).getByTestId('draft-view-store')).toHaveTextContent('Kiosk');
    expect(within(view).queryAllByRole('textbox')).toEqual([]);
    expect(server.sent.filter((s) => s.url === draftPathOf(STORE_RO, draft.id))).toHaveLength(1);
  });

  it('SID-06. a store change drops the earlier store\'s late answer; only the chosen store\'s rows are shown', async () => {
    const { server, ada } = seeded();
    const one = server.seedDraft(STORE_1, ada, at(5));
    const two = server.seedDraft(STORE_2, ada, at(6));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await click('drafts-show');
    await storesReady();
    server.hold.list = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await listReady();
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual([two.id]);
    expect(rows().map((r) => r.getAttribute('data-id'))).not.toContain(one.id);
  });

  it('SID-07. names: one read per distinct customer, at most three at a time, a missing one falls back; Customers View absent → no name read at all', async () => {
    const { server } = seeded();
    const ids = Array.from({ length: 6 }, (_, i) => server.seedCustomer(TENANT_A, `Person ${i}`));
    const gone = uuid(0xcff);
    for (let i = 0; i < 12; i++) server.seedDraft(STORE_1, i === 11 ? gone : ids[i % 6], at(50 + i));
    server.hold.names = 6;
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await waitFor(() => expect(server.held).toHaveLength(3));
    expect(server.nameInFlight).toBe(3);
    while (server.held.length > 0) { await act(async () => { server.held.shift()!.release(); }); await settle(); }
    await waitFor(() => expect(screen.getAllByTestId('drafts-row-customer')[0]).toHaveTextContent(customerFallbackText(gone)));
    const reads = server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`));
    expect(reads).toHaveLength(7); // six customers and the missing one, once each
    expect(new Set(reads.map((s) => s.url)).size).toBe(7);
    expect(server.nameMaxInFlight).toBeLessThanOrEqual(3);
    expect(screen.getAllByTestId('drafts-row-customer')[1]).toHaveTextContent('Person 4');
    cleanup();
    const quiet = seeded();
    quiet.server.seedDraft(STORE_1, quiet.ada, at(5));
    render(<ServerInvoiceDrafts {...rig(quiet.server).props({ canViewCustomers: false })} />);
    await showAndChoose(STORE_1);
    expect(screen.getByTestId('drafts-row-customer')).toHaveTextContent(customerFallbackText(quiet.ada));
    expect(quiet.server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`))).toEqual([]);
  });

  it('SID-08. a 403 or a 429 on a name stops the name reads — no read starts after it, only the three already out end — and never fails the list', async () => {
    for (const status of [403, 429]) {
      const { server } = seeded();
      const ids = Array.from({ length: 7 }, (_, i) => server.seedCustomer(TENANT_A, `Person ${i}`));
      for (const [i, id] of ids.entries()) { server.seedDraft(STORE_1, id, at(60 + i)); server.nameStatus.set(id, status); }
      server.hold.names = 3; // the three reads the section starts at once wait here
      render(<ServerInvoiceDrafts {...rig(server).props()} />);
      await showAndChoose(STORE_1);
      await waitFor(() => expect(server.held).toHaveLength(3));
      const reads = () => server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`));
      expect(reads()).toHaveLength(3);
      await act(async () => { server.held.shift()!.release(); }); // the first answer: the refusal
      await settle();
      expect(reads()).toHaveLength(3); // nothing started after it, though four names are still unread
      while (server.held.length > 0) { await act(async () => { server.held.shift()!.release(); }); await settle(); }
      await settle();
      expect(reads()).toHaveLength(3);
      expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'ready');
      expect(screen.getAllByTestId('drafts-row-customer').map((n) => n.textContent)).toEqual([...ids].reverse().map(customerFallbackText));
      cleanup();
    }
  });

  it('SID-09. reopen is read-only: the header, the ordered lines and the Draft subtotal; Escape closes it and focus returns to Open', async () => {
    const { server, ada } = seeded();
    const draft = server.seedDraft(STORE_1, ada, at(5), 250, 3);
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    const open = screen.getByTestId('drafts-open');
    await user().click(open);
    const view = await screen.findByTestId('draft-view');
    expect(view).toHaveAttribute('role', 'dialog');
    expect(view).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(within(view).getAllByTestId('draft-view-line')).toHaveLength(3));
    expect(within(view).getAllByTestId('draft-view-line').map((r) => r.textContent)).toEqual(['1Item 11$2.50$2.50', '2Item 21$2.50$2.50', '3Item 31$2.50$2.50']);
    expect(within(view).getByTestId('draft-view-subtotal')).toHaveTextContent('Draft subtotal $7.50');
    await waitFor(() => expect(within(view).getByTestId('draft-view-customer')).toHaveTextContent('Ada Customer'));
    expect(within(view).getByTestId('draft-view-store')).toHaveTextContent('Main Street');
    expect(within(view).queryAllByRole('textbox')).toEqual([]);
    // M7B-INVOICES-P2: the view stays read-only; editing is the separate editor behind Edit, offered on the server's answer.
    await waitFor(() => expect(within(view).getByTestId('draft-view-edit-state')).toHaveAttribute('data-phase', 'allowed'));
    expect(within(view).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close', 'Edit draft']);
    expect(view.textContent).not.toMatch(/amount due|balance|invoice number|issued|payment|tax|discount/i);
    expect(server.sent.filter((s) => s.url === draftPathOf(STORE_1, draft.id))).toHaveLength(1);
    await user().keyboard('{Escape}');
    await settle();
    expect(screen.queryByTestId('draft-view')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-open'));
  });

  it('SID-10. a draft that is gone says so; an unreadable name in the dialog falls back', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    server.nameStatus.set(ada, 403);
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.detailStatus.push(404);
    await click('drafts-open');
    await waitFor(() => expect(screen.getByTestId('draft-view-state')).toHaveTextContent(DRAFTS_TEXT.draftNotFound));
    await click('draft-view-close');
    await click('drafts-open');
    await waitFor(() => expect(screen.getByTestId('draft-view-customer')).toHaveTextContent(customerFallbackText(ada)));
  });
});

describe('Server drafts — a new draft (M7B-INVOICES-P1)', () => {
  it('SID-11. every invalid field is said (role=alert, aria-invalid, aria-describedby), the first takes focus, and nothing is sent and no key minted', async () => {
    const { server } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await click('drafts-new');
    const dialog = screen.getByTestId('draft-new');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.change(screen.getByTestId('draft-new-quantity'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('draft-new-price'), { target: { value: '1.999' } });
    await click('draft-new-save');
    await settle();
    expect(screen.getByTestId('draft-new-customer-error')).toHaveTextContent(DRAFT_RULE_TEXT.customer);
    expect(screen.getByTestId('draft-new-customer-error')).toHaveAttribute('role', 'alert');
    for (const [id, text] of [['draft-new-description', DRAFT_RULE_TEXT.description], ['draft-new-quantity', DRAFT_RULE_TEXT.quantity], ['draft-new-price', DRAFT_RULE_TEXT.unitPrice]] as const) {
      const field = screen.getByTestId(id);
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAccessibleDescription(text);
    }
    expect(document.activeElement).toBe(screen.getByTestId('picker-open')); // the first invalid: the customer
    // The customer control itself is marked invalid and described by its error (not only the fieldset around it).
    expect(screen.getByTestId('picker-open')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('picker-open')).toHaveAccessibleDescription(DRAFT_RULE_TEXT.customer);
    expect(r.keys).toEqual([]);
    expect(server.posts()).toEqual([]);
  });

  it('SID-12. prices are exact cents: the live Draft subtotal of 3 × 0.10 is $0.30; a line or a sum over 2^53-1 cents is refused before a key exists', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Bolt', '3', '0.1'], ['Nut', '1', '0.2']]);
    expect(screen.getByTestId('draft-new-subtotal')).toHaveTextContent('Draft subtotal $0.50');
    // Only the amount is a live region (atomic): a change announces the new amount, never the label again.
    const amount = within(screen.getByTestId('draft-new-subtotal')).getByTestId('draft-new-subtotal-amount');
    expect(amount).toHaveTextContent(/^\$0\.50$/);
    expect(amount).toHaveAttribute('aria-live', 'polite');
    expect(amount).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByTestId('draft-new-subtotal')).not.toHaveAttribute('aria-live');
    fireEvent.change(screen.getAllByTestId('draft-new-price')[1], { target: { value: '90071992547409.91' } });
    expect(screen.getByTestId('draft-new-subtotal')).toHaveTextContent('Draft subtotal —');
    await click('draft-new-save');
    await settle();
    expect(screen.getByTestId('draft-new-subtotal-error')).toHaveTextContent(DRAFT_RULE_TEXT.subtotal);
    fireEvent.change(screen.getAllByTestId('draft-new-price')[1], { target: { value: '45035996273704.96' } });
    fireEvent.change(screen.getAllByTestId('draft-new-quantity')[1], { target: { value: '2' } });
    await click('draft-new-save');
    await settle();
    expect(screen.getAllByTestId('draft-new-price')[1]).toHaveAccessibleDescription(DRAFT_RULE_TEXT.total);
    expect(document.activeElement).toBe(screen.getAllByTestId('draft-new-price')[1]);
    expect(r.keys).toEqual([]);
    expect(server.posts()).toEqual([]);
  });

  it('SID-13. Save draft sends exactly one POST with the exact bytes; a double click sends no second; 201 closes the dialog, reads it back once and lists it', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['  Screen repair ', '1', '20'], ['Cable', '2', '2.75']]);
    expect(screen.getByTestId('draft-new-subtotal')).toHaveTextContent('Draft subtotal $25.50');
    await user().dblClick(screen.getByTestId('draft-new-save'));
    await waitFor(() => expect(screen.queryByTestId('draft-new')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    const posts = server.posts();
    expect(posts).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    expect(posts[0].url).toBe(draftsPathOf(STORE_1));
    expect(posts[0].body).toBe(bodyOf(TENANT_A, ada, [['Screen repair', 1, 2000], ['Cable', 2, 275]]));
    expect(posts[0].headers.get('idempotency-key')).toBe(r.keys[0]);
    const made = server.drafts[server.drafts.length - 1];
    expect(server.sent.filter((s) => s.url === draftPathOf(STORE_1, made.id))).toHaveLength(1); // the one read-back
    await waitFor(() => expect(rows().map((n) => n.getAttribute('data-id'))).toEqual([made.id]));
    expect(r.holds.get('uid-a')).toBeUndefined();
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-new'));
  });

  it('SID-31. the list read after a save never disables New: focus goes back to New while that read is still out, and stays there', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.hold.list = 1; // the refresh the read-back starts waits here
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list']));
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'loading');
    expect(screen.getByTestId('drafts-new')).toBeEnabled();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-new'));
    await act(async () => { server.held.shift()!.release(); });
    await waitFor(() => expect(rows()).toHaveLength(1));
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-new'));
    expect(server.posts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-32. one dialog at a time: an attempt settling while the reopen dialog is up opens no new draft beside it, nor does a press reaching New; the hand-over then waits for New', async () => {
    const { server, ada, bea } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose'); // committed; its answer is lost
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    // A hand-over waits while the attempt is live.
    view.rerender(<ServerInvoiceDrafts {...r.props({ handoff: { id: bea, name: 'Bea Customer' } })} />);
    await waitFor(() => expect(screen.getByTestId('drafts-handoff')).toHaveTextContent('Bea Customer'));
    server.creates.push('hold');
    await click('drafts-check-again');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    await click('drafts-open');
    await waitFor(() => expect(screen.getByTestId('draft-view-subtotal')).toBeInTheDocument());
    await act(async () => { server.held.shift()!.release(); }); // the replayed 201: created, nothing live any more
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    fireEvent.click(screen.getByTestId('drafts-new')); // a press that reaches New (jsdom does not implement inert)
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('data-testid'))).toEqual(['draft-view']);
    await click('draft-view-close');
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull(); // nothing opens on its own
    expect(screen.getByTestId('drafts-handoff')).toHaveTextContent('Bea Customer');
    await click('drafts-new');
    await waitFor(() => expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bea));
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('data-testid'))).toEqual(['draft-new']);
    expect(server.posts()).toHaveLength(2);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-14. created, but the read-back fails: said so, and NO second POST', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.detailStatus.push(500);
    await click('draft-new-save');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.savedUnread));
    expect(server.posts()).toHaveLength(1);
    await settle();
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-15. a lost reply is held; only Check again re-sends — the same key and bytes to the same store — and the replayed 201 is created', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    expect(hold()).toHaveTextContent(HOLD_TEXT.unresolved);
    expect(screen.getByTestId('drafts-hold-note')).toHaveTextContent('No answer from the server.');
    expect(r.holds.get('uid-a')?.state).toBe('unresolved');
    await click('drafts-check-again');
    await waitFor(() => expect(screen.queryByTestId('draft-new')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    const posts = server.posts();
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toBe(posts[0].body);
    expect(posts[1].url).toBe(posts[0].url);
    expect(posts[1].headers.get('idempotency-key')).toBe(posts[0].headers.get('idempotency-key'));
    expect(r.keys).toHaveLength(1);
    expect(server.drafts.filter((d) => d.storeId === STORE_1)).toHaveLength(1); // one draft, not two
  });

  it('SID-16. repeated unknown and a 503 on Check again stay unresolved with the same key; each press is exactly one POST', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before', 'lose-before', 503);
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    for (const note of ['No answer from the server.', 'The server answered, but not with a result.']) {
      const before = server.posts().length;
      await click('drafts-check-again');
      await waitFor(() => expect(server.posts()).toHaveLength(before + 1));
      await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
      expect(screen.getByTestId('drafts-hold-note')).toHaveTextContent(note);
    }
    expect(new Set(server.posts().map((p) => p.headers.get('idempotency-key'))).size).toBe(1);
    expect(new Set(server.posts().map((p) => p.body)).size).toBe(1);
    expect(server.drafts).toHaveLength(0);
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.drafts).toHaveLength(1);
  });

  it('SID-17. refusals end the attempt with their own text and keep the form: customer_not_found (the customer cleared), write_conflict, key reused, denied', async () => {
    const main = (s: Server, change: Partial<StoreEntry>): void => {
      const i = s.stores['uid-a'].findIndex((x) => x.id === STORE_1);
      s.stores['uid-a'][i] = { ...s.stores['uid-a'][i], ...change };
    };
    const cases: Array<[string, (s: Server, ada: string) => void, string]> = [
      ['customer-not-found', (s, ada) => { s.customers.delete(ada); }, REFUSED_TEXT['customer-not-found']],
      ['conflict', (s) => { main(s, { tenantId: TENANT_B }); }, REFUSED_TEXT.conflict],
      ['key-reused', (s) => { s.creates.push('key-reused'); }, REFUSED_TEXT['key-reused']],
      ['denied', (s) => { main(s, { readOnly: true }); }, REFUSED_TEXT.denied],
    ];
    for (const [name, arrange, text] of cases) {
      const { server, ada } = seeded();
      const r = rig(server);
      render(<ServerInvoiceDrafts {...r.props()} />);
      await showAndChoose(STORE_1);
      await fillDraft(ada, [['Fan', '1', '9.99']]);
      arrange(server, ada);
      await click('draft-new-save');
      await waitFor(() => expect(screen.getByTestId('draft-new-status')).toHaveTextContent(text));
      expect(screen.getByTestId('draft-new-status')).toHaveAttribute('role', 'alert');
      expect(screen.getByTestId('draft-new-description')).toHaveValue('Fan'); // the form stays
      expect(r.holds.get('uid-a')).toBeUndefined();
      expect(hold()).toBeNull();
      if (name === 'customer-not-found') expect(screen.queryByTestId('picker-value')).toBeNull();
      else expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada);
      expect(server.posts()).toHaveLength(1);
      expect(server.drafts).toHaveLength(0);
      cleanup();
    }
  });

  it('SID-18. no timer, focus, tab return or Reconnect re-sends; Reconnect after a confirmed end is explicit and detaches the attempt (a new token)', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel'); // Cancel only hides the dialog
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    r.clock.mono += 60 * 60_000;
    r.clock.wall += 60 * 60_000;
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    await new Promise((res) => setTimeout(res, 50));
    await settle();
    expect(server.posts()).toHaveLength(1);
    const logins = server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.login).length;
    server.expire();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins); // no sign-in on its own
    await click('drafts-retry'); // Reconnect
    await storesReady();
    expect(server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins + 1);
    expect(hold()).toHaveAttribute('data-state', 'detached');
    expect(hold()).toHaveTextContent(HOLD_TEXT.detached);
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ csrf: null, body: '' }));
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-19. another tab\'s session (a token change) detaches the attempt, clears the store view and drops a read in flight; nothing is sent', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    server.hold.list = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(storeSelect().value).toBe('');
    expect(rows()).toEqual([]);
    expect(hold()).toHaveAttribute('data-state', 'detached');
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-20. choosing another store never detaches or re-targets the attempt: Check again goes to its own store', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await listReady();
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.posts().map((p) => p.url)).toEqual([draftsPathOf(STORE_1), draftsPathOf(STORE_1)]);
    expect(server.drafts.map((d) => d.storeId)).toEqual([STORE_1]);
  });

  it('SID-21. a user change detaches the previous user\'s attempt (body cleared); it is never shown to the next user, nor checkable again', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-b' })} />);
    await settle();
    expect(hold()).toBeNull();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ csrf: null, body: '', state: 'unresolved' }));
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-a' })} />);
    await settle();
    expect(hold()).toHaveAttribute('data-state', 'detached');
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    await click('drafts-stop');
    expect(r.holds.get('uid-a')).toBeUndefined();
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-22. a late 201 after the section has gone still lands as created; the next section reads it back under the same session', async () => {
    const { server, ada } = seeded();
    const holds = createDraftHoldStore();
    const r = rig(server, holds);
    const first = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('hold');
    await click('draft-new-save');
    await waitFor(() => expect(server.held.filter((h) => h.kind === 'create')).toHaveLength(1));
    expect(holds.get('uid-a')?.state).toBe('sending');
    first.unmount(); // the page is left while the POST is out
    await act(async () => { server.held.find((h) => h.kind === 'create')!.release(); });
    await settle();
    expect(holds.get('uid-a')?.state).toBe('created');
    render(<ServerInvoiceDrafts {...r.props()} />);
    expect(hold()).toHaveAttribute('data-state', 'created');
    await click('drafts-show');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(holds.get('uid-a')).toBeUndefined();
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-23. past the cutoff — the larger of monotonic and wall-clock elapsed, 23 hours — Check again sends nothing and the card says so', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    r.clock.mono += 60_000; // the monotonic clock barely moved (a suspended tab)…
    r.clock.wall += 23 * 60 * 60_000; // …the wall clock says 23 hours
    await click('drafts-check-again');
    await settle();
    expect(hold()).toHaveTextContent(HOLD_TEXT.tooOld);
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    expect(r.holds.get('uid-a')?.body).toBe('');
    expect(server.posts()).toHaveLength(1);
    cleanup();

    // The cutoff is judged AGAIN right before the POST: pressed in time, but the session confirmation it waits for is
    // held while both clocks pass 23 hours (a slow server, a suspended device) — the body goes and nothing is sent.
    for (const which of ['both', 'mono'] as const) {
      const late = seeded();
      const q = rig(late.server);
      render(<ServerInvoiceDrafts {...q.props()} />);
      await showAndChoose(STORE_1);
      await heldInSection(late.server, late.ada);
      q.clock.mono += 22 * HOUR; // under the cutoff when pressed
      q.clock.wall += 22 * HOUR;
      late.server.hold.current = 1; // Check again's session read waits here
      await click('drafts-check-again');
      await waitFor(() => expect(late.server.held.map((h) => h.kind)).toEqual(['current']));
      expect(hold()).toHaveAttribute('data-state', 'checking');
      q.clock.mono += 2 * HOUR; // past it while held: both clocks, or the monotonic one alone
      if (which === 'both') q.clock.wall += 2 * HOUR;
      await act(async () => { late.server.held.shift()!.release(); });
      await settle();
      expect(late.server.posts()).toHaveLength(1);
      expect(hold()).toHaveAttribute('data-state', 'unresolved');
      expect(hold()).toHaveTextContent(HOLD_TEXT.tooOld);
      expect(screen.queryByTestId('drafts-check-again')).toBeNull();
      expect(q.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'unresolved', body: '' }));
      cleanup();
    }
  });

  it('SID-33. the cutoff is the LARGER of monotonic and wall-clock elapsed: 23 hours on the monotonic clock alone sends nothing; just under 23 hours on both, Check again sends one POST with the same key and bytes', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    r.clock.mono += 23 * HOUR; // the monotonic clock says 23 hours…
    r.clock.wall += 60_000; // …the wall clock was set back (or stepped) and says a minute
    await click('drafts-check-again');
    await settle();
    expect(hold()).toHaveTextContent(HOLD_TEXT.tooOld);
    expect(r.holds.get('uid-a')?.body).toBe('');
    expect(server.posts()).toHaveLength(1);
    cleanup();

    const under = seeded();
    const q = rig(under.server);
    render(<ServerInvoiceDrafts {...q.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(under.server, under.ada);
    q.clock.mono += 23 * HOUR - 60_000; // 22 h 59 min on both clocks: still in time
    q.clock.wall += 23 * HOUR - 60_000;
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    const posts = under.server.posts();
    expect(posts).toHaveLength(2);
    expect(posts[1].headers.get('idempotency-key')).toBe(posts[0].headers.get('idempotency-key'));
    expect(posts[1].body).toBe(posts[0].body);
    expect(q.keys).toHaveLength(1);
    expect(under.server.drafts).toHaveLength(1);
  });

  it('SID-34. Check again meets the session first: an ended session sends nothing ("Not checked", the views cleared, Reconnect offered); another session\'s token detaches the attempt and sends nothing', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    server.expire(); // no focus event: Check again is the first to meet the end
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.getByTestId('drafts-hold-note')).toHaveTextContent(`Not checked. ${DRAFTS_TEXT.ended}`);
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(rows()).toEqual([]);
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    expect(server.posts()).toHaveLength(1);
    cleanup();

    const other = seeded();
    const q = rig(other.server);
    render(<ServerInvoiceDrafts {...q.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(other.server, other.ada);
    other.server.otherTab('uid-a'); // no focus event either: Check again is the first to see the new token
    await click('drafts-check-again');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'detached'));
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    expect(q.holds.get('uid-a')).toEqual(expect.objectContaining({ csrf: null, body: '' }));
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    expect(other.server.posts()).toHaveLength(1);
  });

  it('SID-35. a read that meets the session end gives its busy state back: Reconnect is enabled after Load more finds the session ended, and after a list read answered 401', async () => {
    const { server, ada } = seeded();
    for (let i = 0; i < 25; i++) server.seedDraft(STORE_1, ada, at(100 + i));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.expire();
    await click('drafts-load-more'); // its session confirmation finds the session ended
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    await settle();
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    expect(screen.getByTestId('drafts-retry')).toBeEnabled();
    await click('drafts-retry');
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    server.listStatus.push(401); // the session check passes; the list read itself answers 401
    await click('drafts-load-more');
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    await settle();
    expect(screen.getByTestId('drafts-retry')).toBeEnabled();
    await click('drafts-retry');
    await storesReady();
    expect(server.posts()).toEqual([]);
  });

  it('SID-36. a store chosen during a rate limit\'s wait says so (never a blank list) and offers Try again once the wait has passed', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const two = server.seedDraft(STORE_2, ada, at(6));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    // The wait's timer runs on the fake clock from here, so only `advance` ends it: a stalled CPU cannot end it before
    // the assertions below (a real one-second timer could), and no user-event or waitFor runs while it is installed.
    fakeClock();
    server.retryAfter = '1';
    server.detailStatus.push(429); // a reopen read is rate limited: a one-second wait starts
    fireEvent.click(screen.getByTestId('drafts-open'));
    await until(() => expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'rate-limited'));
    fireEvent.click(screen.getByTestId('draft-view-close'));
    const reads = server.sent.length;
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await settle();
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited');
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent('Too many requests. Wait 1 second, then try again.');
    expect(screen.getByTestId('drafts-list-retry')).toBeDisabled();
    await advance(999);
    expect(screen.getByTestId('drafts-list-retry')).toBeDisabled(); // still 1 ms before the wait has passed
    expect(server.sent).toHaveLength(reads); // nothing read during the wait
    await advance(1);
    expect(screen.getByTestId('drafts-list-retry')).toBeEnabled();
    expect(server.sent).toHaveLength(reads); // nor at its end: only the press reads
    vi.useRealTimers();
    await click('drafts-list-retry');
    await listReady();
    expect(rows().map((n) => n.getAttribute('data-id'))).toEqual([two.id]);
  });

  it('SID-24. a new draft is never sent under another session than the dialog\'s: the dialog\'s customer and store are re-confirmed and nothing is sent', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.otherTab('uid-a');
    await click('draft-new-save');
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull(); // the new generation closed it: its store was the old session's
    expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument();
    expect(r.keys).toEqual([]);
    expect(server.posts()).toEqual([]);
  });

  it('SID-25. the dialogs: inert page behind, Escape closes only the top one (the picker over the new draft), Tab wraps inside, focus comes back', async () => {
    const { server } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    const opener = screen.getByTestId('drafts-new');
    await user().click(opener);
    const dialog = screen.getByTestId('draft-new');
    const appRoot = [...document.body.children].find((n) => n.contains(screen.getByTestId('drafts-section')))!;
    expect(appRoot).toHaveAttribute('inert');
    expect(document.activeElement).toBe(screen.getByTestId('draft-new-description'));
    await click('picker-open');
    await waitFor(() => expect(screen.getByTestId('picker-state')).toHaveAttribute('data-phase', 'ready'));
    await user().keyboard('{Escape}');
    expect(screen.queryByTestId('picker-dialog')).toBeNull();
    expect(screen.getByTestId('draft-new')).toBe(dialog); // still open
    const stops = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    stops[stops.length - 1].focus();
    await user().tab();
    expect(document.activeElement).toBe(stops[0]);
    await user().tab({ shift: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
    await user().keyboard('{Escape}');
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(appRoot).not.toHaveAttribute('inert');
    expect(document.activeElement).toBe(opener);
  });

  it('SID-39. focus never falls out of the new draft dialog: a line\'s Remove hands it to the neighbouring line; Save draft and Check again, disabled or removed by their own press, recover it inside without scrolling; Save says why an earlier attempt blocks it; Escape still closes', async () => {
    const { server, ada } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    // Focus never falls out of the open dialog when the user's own press removes or disables the control it is on, and
    // Escape keeps working. A line's Remove (its whole line goes) hands focus to the neighbouring line, where the user is:
    // the next line's Remove, then — one line left, its Remove disabled — that line's description.
    await fillDraft(ada, [['Fan', '1', '9.99'], ['Nut', '1', '1'], ['Bolt', '1', '2']]);
    const dialog = screen.getByTestId('draft-new');
    const inside = (): void => {
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect((document.activeElement as HTMLButtonElement).disabled ?? false).toBe(false);
    };
    await user().click(screen.getAllByTestId('draft-new-remove-line')[1]);
    await settle();
    expect(screen.getAllByTestId('draft-new-description').map((n) => (n as HTMLInputElement).value)).toEqual(['Fan', 'Bolt']);
    expect(document.activeElement).toBe(screen.getAllByTestId('draft-new-remove-line')[1]); // Bolt's, now "Remove line 2"
    inside();
    await user().keyboard('{Enter}'); // the same key again, on the Remove it landed on
    await settle();
    expect(screen.getAllByTestId('draft-new-line')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByTestId('draft-new-description'));
    expect(screen.getByTestId('draft-new-description')).toHaveValue('Fan');
    inside();
    // The recovery itself never scrolls: the dialog body scrolls, and the card and Save sit below the lines.
    const realFocus = HTMLElement.prototype.focus;
    const focused: Array<{ readonly node: HTMLElement; readonly options: FocusOptions | undefined }> = [];
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      focused.push({ node: this, options });
      realFocus.call(this, options);
    });
    const recovered = (): Array<FocusOptions | undefined> => focused.filter((f) => f.node === screen.getByTestId('draft-new-description')).map((f) => f.options);
    // Save draft, disabled while it saves (no reason is given for that: it is this press):
    server.creates.push('hold');
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    await settle();
    expect(screen.getByTestId('draft-new-save')).toBeDisabled();
    expect(screen.getByTestId('draft-new-save')).not.toHaveAttribute('aria-describedby');
    inside();
    expect(recovered()).toEqual([{ preventScroll: true }]);
    const unknown = new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'r' }), { status: 503, headers: { 'content-type': 'application/json' } });
    await act(async () => { server.held.shift()!.release(unknown); }); // committed, outcome unknown: held in the dialog
    await waitFor(() => expect(within(dialog).getByTestId('drafts-hold')).toHaveAttribute('data-state', 'unresolved'));
    // Disabled by the held attempt: Save says why.
    expect(screen.getByTestId('draft-new-save')).toBeDisabled();
    expect(screen.getByTestId('draft-new-save')).toHaveAccessibleDescription(HOLD_TEXT.saveBlocked);
    // Check again (its whole action row goes while the check runs), gated at the server:
    server.creates.push('hold');
    await user().click(within(dialog).getByTestId('drafts-check-again'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    await settle();
    expect(within(dialog).queryByTestId('drafts-check-again')).toBeNull();
    inside();
    expect(recovered()).toEqual([{ preventScroll: true }, { preventScroll: true }]);
    await user().keyboard('{Escape}'); // still reaches the dialog
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    await act(async () => { server.held.shift()!.release(); }); // the replay: created
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.posts()).toHaveLength(2);
  });

  it('SID-26. a hand-over (id and name only) opens the section; the dialog confirms its own session and makes its own reference for the chosen store', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const taken = vi.fn();
    const view = render(<ServerInvoiceDrafts {...r.props({ onHandoffTaken: taken })} />);
    view.rerender(<ServerInvoiceDrafts {...r.props({ onHandoffTaken: taken, handoff: { id: ada, name: 'Ada Customer' } })} />);
    await storesReady();
    expect(taken).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('drafts-handoff')).toHaveTextContent('Ada Customer');
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(screen.getByTestId('draft-new')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada));
    fireEvent.change(screen.getByTestId('draft-new-description'), { target: { value: 'Fan' } });
    fireEvent.change(screen.getByTestId('draft-new-price'), { target: { value: '5' } });
    await click('draft-new-save');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.posts()[0].body).toBe(bodyOf(TENANT_A, ada, [['Fan', 1, 500]]));
  });

  it('SID-28. names: the three-read bound holds across pages (Load more while names are out), and Customers View lost hides the names at once', async () => {
    const { server } = seeded();
    const ids = Array.from({ length: 8 }, (_, i) => server.seedCustomer(TENANT_A, `Person ${i}`));
    for (let i = 0; i < 25; i++) server.seedDraft(STORE_1, ids[i < 20 ? i % 4 : 4 + (i % 4)], at(200 - i));
    server.hold.names = 8;
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await waitFor(() => expect(server.held).toHaveLength(3));
    await click('drafts-load-more');
    await waitFor(() => expect(rows()).toHaveLength(25));
    await settle();
    expect(server.held).toHaveLength(3); // the second page's names wait in the same queue
    while (server.held.length > 0) { await act(async () => { server.held.shift()!.release(); }); await settle(); }
    expect(server.nameMaxInFlight).toBe(3);
    expect(server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`))).toHaveLength(8);
    await waitFor(() => expect(screen.getAllByTestId('drafts-row-customer')[0]).toHaveTextContent('Person 0'));
    view.rerender(<ServerInvoiceDrafts {...r.props({ canViewCustomers: false })} />);
    expect(screen.getAllByTestId('drafts-row-customer')[0]).toHaveTextContent(customerFallbackText(ids[0]));
    expect(screen.getByTestId('drafts-section').textContent).not.toMatch(/Person \d/);
  });

  it('SID-29. a line\'s error stays with its line when another is removed; a subtotal-only error takes focus; after an unconfirmed save focus goes to the heading, not the disabled opener', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['First', '1', '1'], ['', '1', '1']]);
    await click('draft-new-save');
    await settle();
    expect(screen.getAllByTestId('draft-new-description')[1]).toHaveAttribute('aria-invalid', 'true');
    await user().click(screen.getAllByTestId('draft-new-remove-line')[0]);
    expect(screen.getAllByTestId('draft-new-description')).toHaveLength(1);
    expect(screen.getByTestId('draft-new-description')).toHaveValue('');
    expect(screen.getByTestId('draft-new-description')).toHaveAttribute('aria-invalid', 'true'); // its own error, kept
    fireEvent.change(screen.getByTestId('draft-new-description'), { target: { value: 'Big' } });
    fireEvent.change(screen.getByTestId('draft-new-price'), { target: { value: '90071992547409.91' } });
    await click('draft-new-add-line');
    const descriptions = screen.getAllByTestId('draft-new-description');
    fireEvent.change(descriptions[1], { target: { value: 'More' } });
    fireEvent.change(screen.getAllByTestId('draft-new-price')[1], { target: { value: '0.01' } });
    await click('draft-new-save');
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('draft-new-subtotal-error'));
    ringed(screen.getByTestId('draft-new-subtotal-error'));
    // The size error, the third such target, cannot be reached from the form (a valid draft's body stays near 55 KB, under
    // the 64 KiB bound: invoiceDraftsClient.ts DRAFT_BODY_MAX_BYTES), so its ring is checked in the source (as SID-27 reads it).
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'ServerInvoiceDrafts.tsx'), 'utf8');
    // M7B-INVOICES-P2: the lines, the subtotal and both its errors are LinesEditor's, shared with the editor (`prefix`).
    expect(source).toMatch(/data-testid=\{`\$\{prefix\}-size-error`\}[^\n]*className=\{`[^`\n]*\$\{focusRing\}`\}/);
    expect(source).not.toMatch(/-size-error`\}[^\n]*focus:outline-none/);
    fireEvent.change(screen.getAllByTestId('draft-new-price')[0], { target: { value: '1' } });
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    await settle();
    expect(screen.getByTestId('drafts-new')).toBeDisabled();
    expect(screen.getByTestId('drafts-new')).toHaveAccessibleDescription(NOT_SENT_TEXT.pending); // why it is disabled
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Server drafts' }));
    ringed(screen.getByRole('heading', { name: 'Server drafts' }));
    expect(r.keys).toHaveLength(1);
  });

  it('SID-30. a hand-over waiting for a store is dropped by a session change: it is never used under another session', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    view.rerender(<ServerInvoiceDrafts {...r.props({ handoff: { id: ada, name: 'Ada Customer' } })} />);
    await storesReady();
    expect(screen.getByTestId('drafts-handoff')).toBeInTheDocument();
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    await storesReady();
    expect(screen.queryByTestId('drafts-handoff')).toBeNull();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull(); // "Choose a store." was answered by the choice
    expect(screen.queryByTestId('draft-new')).toBeNull(); // nothing opens on its own
    await click('drafts-new');
    expect(screen.queryByTestId('picker-value')).toBeNull(); // no customer carried over
    // The alert's other end: the session ends while it is up. The end is what the section says now, and the Reconnect's
    // token is a FIRST token (not a "connection changed"), so the alert stays gone after it too.
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    server.expire();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    await click('drafts-retry'); // Reconnect
    await storesReady();
    await settle();
    expect(storeSelect()).toHaveValue('');
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    expect(server.posts()).toEqual([]);
  });

  it('SID-37. the attempt\'s card outside the dialog: Check again, Stop tracking and Dismiss hand focus to the section heading; it never falls to <body>', async () => {
    const { server, ada } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    const heading = screen.getByRole('heading', { name: 'Server drafts' });
    // Every DOM change is checked: focus on <body> at any of them (a removed control's) is recorded.
    const fell: string[] = [];
    const watch = new MutationObserver(() => { if (document.activeElement === null || document.activeElement === document.body) fell.push(hold()?.getAttribute('data-state') ?? 'gone'); });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      await heldInSection(server, ada);
      await settle();
      expect(document.activeElement).toBe(heading); // the dialog's own return (SID-29)
      fell.length = 0; // from here only the card's presses move focus
      // Check again: its whole row goes while the check runs (held at the server), and comes back when it stays unknown.
      server.creates.push('hold');
      await user().click(screen.getByTestId('drafts-check-again'));
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
      await settle();
      expect(hold()).toHaveAttribute('data-state', 'checking');
      expect(screen.queryByTestId('drafts-check-again')).toBeNull();
      expect(document.activeElement).toBe(heading);
      const unknown = new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'r' }), { status: 503, headers: { 'content-type': 'application/json' } });
      await act(async () => { server.held.shift()!.release(unknown); });
      await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
      expect(screen.getByTestId('drafts-check-again')).toBeEnabled();
      expect(document.activeElement).toBe(heading);
      // Stop tracking: the card goes.
      await user().click(screen.getByTestId('drafts-stop'));
      await settle();
      expect(hold()).toBeNull();
      expect(document.activeElement).toBe(heading);
      expect(fell).toEqual([]);
      // Dismiss: a check refused (the key reused) ends the attempt with its own card; Dismiss takes the card away.
      await heldInSection(server, ada);
      await settle();
      fell.length = 0;
      server.creates.push('key-reused');
      await user().click(screen.getByTestId('drafts-check-again'));
      await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'refused'));
      expect(document.activeElement).toBe(heading);
      await user().click(screen.getByTestId('drafts-hold-dismiss'));
      await settle();
      expect(hold()).toBeNull();
      expect(document.activeElement).toBe(heading);
      expect(fell).toEqual([]);
    } finally {
      watch.disconnect();
    }
    expect(server.posts()).toHaveLength(4); // two saves and one check each: nothing re-sent on its own
  });

  it('SID-38. "The store connection changed … Choose a store." is said only while true: not after a stores reload that failed, and once a retried reload has the stores', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.otherTab('uid-a');
    server.hold.stores = 1; // the new generation's stores read is held, then answered 503
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['stores']));
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'loading');
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull(); // nothing to choose from yet
    const outage = new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'r' }), { status: 503, headers: { 'content-type': 'application/json' } });
    await act(async () => { server.held.shift()!.release(outage); });
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'unavailable'));
    await settle();
    expect(screen.queryByTestId('drafts-store')).toBeNull();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull(); // no store list: "Choose a store." would be false
    await click('drafts-retry');
    await storesReady();
    expect(screen.getByTestId('drafts-connection-changed')).toHaveTextContent(DRAFTS_TEXT.connection); // true now
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    expect(server.posts()).toEqual([]);
  });

  it('SID-40. a sign-out or a user change takes the session token from a SETTLED attempt too: a created one (then "saved under an earlier connection", never read back) and a refused one', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    // Created, its read-back held at the server: the created attempt sits in the store with the token it was sent with.
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.hold.get = 1;
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['get']));
    const created = r.holds.get('uid-a')!;
    expect(created).toEqual(expect.objectContaining({ state: 'created', body: '', storeId: STORE_1 }));
    expect(created.csrf).not.toBeNull();
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: null })} />); // sign-out
    await settle();
    expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'created', csrf: null, body: '', storeId: STORE_1, draftId: created.draftId }));
    await act(async () => { server.held.shift()!.release(); }); // the read-back answers a section that is gone: dropped
    await settle();
    // The same user again: the attempt is no session's now, so it is not read back — it says "saved earlier" and goes.
    view.rerender(<ServerInvoiceDrafts {...r.props()} />);
    await click('drafts-show');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.savedEarlier));
    expect(r.holds.get('uid-a')).toBeUndefined();
    expect(server.sent.filter((s) => s.method === 'GET' && s.url === draftPathOf(STORE_1, created.draftId!))).toHaveLength(1); // the dropped one only
    // Refused: a check refused (the key reused) leaves a refused attempt on the card until Dismiss; a user change scrubs it.
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    await heldInSection(server, ada);
    server.creates.push('key-reused');
    await click('drafts-check-again');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'refused'));
    expect(r.holds.get('uid-a')?.csrf).not.toBeNull();
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-b' })} />); // a user change
    await settle();
    expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'refused', refusal: 'key-reused', csrf: null, body: '' }));
    expect(server.posts()).toHaveLength(3); // the two saves and the second one's check: nothing re-sent on its own
  });

  it('SID-41. Customers View lost while a list read is out: its late answer queues no customer read (the hint is read as it is when the answer lands)', async () => {
    const { server, ada, bea } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    server.seedDraft(STORE_1, bea, at(6));
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await click('drafts-show');
    await storesReady();
    server.hold.list = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list']));
    view.rerender(<ServerInvoiceDrafts {...r.props({ canViewCustomers: false })} />);
    await act(async () => { server.held.shift()!.release(); });
    await listReady();
    await settle();
    expect(screen.getAllByTestId('drafts-row-customer').map((n) => n.textContent)).toEqual([customerFallbackText(bea), customerFallbackText(ada)]);
    expect(server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`))).toEqual([]);
  });

  it('SID-42. a rate limit\'s wait: Check again says why it is disabled while the wait lasts and not after; a store chosen 1.5 s into a 5 s wait says the whole seconds left', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    await settle();
    expect(screen.getByTestId('drafts-check-again')).toBeEnabled();
    expect(screen.getByTestId('drafts-check-again')).not.toHaveAttribute('aria-describedby');
    // The wait's timer runs on the fake clock from here (as SID-36): only `advance` ends it.
    fakeClock();
    server.retryAfter = '5';
    server.detailStatus.push(429); // a reopen read is rate limited: a five-second wait starts at the rig's monotonic 1000
    fireEvent.click(screen.getByTestId('drafts-open'));
    await until(() => expect(screen.getByTestId('draft-view-state')).toHaveTextContent('Too many requests. Wait 5 seconds, then try again.'));
    fireEvent.click(screen.getByTestId('draft-view-close'));
    await settle();
    expect(screen.getByTestId('drafts-check-again')).toBeDisabled();
    expect(screen.getByTestId('drafts-check-again')).toHaveAccessibleDescription(HOLD_TEXT.waiting);
    r.clock.mono += 1_500; // 3.5 s of the wait left: said as 4 whole seconds, never as the Retry-After again
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await settle();
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited');
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent('Too many requests. Wait 4 seconds, then try again.');
    await advance(5_000);
    expect(screen.getByTestId('drafts-check-again')).toBeEnabled();
    expect(screen.getByTestId('drafts-check-again')).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('drafts-check-wait')).toBeNull();
    vi.useRealTimers();
    expect(server.posts()).toHaveLength(1); // nothing sent by the wait or its end
  });

  it('SID-43. a sign-out (the session client\'s logout) scrubs at its very start, before it sends or awaits anything: every user\'s attempt loses its token — an unresolved one its body too — and the picker\'s pair is forgotten; a listener that throws stops none of it (its error is rethrown as it was, in a queued microtask)', async () => {
    const server = fakeServer();
    const holds = createDraftHoldStore();
    const failure = new Error('another holder failed');
    const offs = [onSessionEnd(() => { throw failure; }), bindDraftHoldsToSessionEnd(holds)];
    const session = createTenantSessionClient({ fetch: server.fetch });
    try {
      const token = 's'.repeat(43);
      const customerId = uuid(0xc01);
      const attempt = (key: string, state: HeldDraft['state'], extra: Partial<HeldDraft> = {}): HeldDraft => ({
        key, body: state === 'unresolved' ? bodyOf(TENANT_A, customerId, [['Fan', 1, 999]]) : '', storeId: STORE_1, tenantId: TENANT_A, customerId,
        storeLabel: 'Main Street', lineCount: 1, subtotalCents: 999, csrf: token, sentAt: 1, sentWall: 1, state, note: '', draftId: null, refusal: null, ...extra,
      });
      holds.put('uid-a', attempt('key-a', 'unresolved'));
      holds.put('uid-b', attempt('key-b', 'created', { draftId: uuid(0xd01) }));
      holds.put('uid-c', attempt('key-c', 'refused', { refusal: 'denied' }));
      const context = sessionContextOf('uid-a', token, sessionEndsSoFar());
      let sentWhenHeard = -1;
      offs.push(onSessionEnd(() => { sentWhenHeard = server.sent.length; }));
      // queueMicrotask is captured around the synchronous logout() call only, and restored in `finally`, so the failing
      // listener's rethrown error is caught here instead of failing the run as an uncaught error.
      const queued: Array<() => void> = [];
      const realQueue = globalThis.queueMicrotask;
      Object.assign(globalThis, { queueMicrotask: (task: () => void) => { queued.push(task); } });
      let out: Promise<void>;
      try { out = session.logout(); } finally { Object.assign(globalThis, { queueMicrotask: realQueue }); }
      expect(queued).toHaveLength(1);
      let rethrown: unknown;
      try { queued[0](); } catch (error) { rethrown = error; }
      expect(rethrown).toBe(failure); // the listener's own error object, surfaced; logout and the other listeners still ran
      // All of it is done by the time logout() returns, with nothing of the logout sent yet.
      expect(sentWhenHeard).toBe(0);
      expect(holds.get('uid-a')).toEqual(expect.objectContaining({ key: 'key-a', state: 'unresolved', csrf: null, body: '' }));
      expect(holds.get('uid-b')).toEqual(expect.objectContaining({ key: 'key-b', state: 'created', csrf: null, draftId: uuid(0xd01) }));
      expect(holds.get('uid-c')).toEqual(expect.objectContaining({ key: 'key-c', state: 'refused', csrf: null, refusal: 'denied' }));
      expect([hasSessionPair(), isContextOf(context, 'uid-a', token)]).toEqual([false, false]); // forgotten, and looked at without making it again
      await out;
      expect(server.sent.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]); // no session here: nothing to end
    } finally {
      for (const off of offs) off();
      session.reset(); // leaves no pair behind for the next case
    }
  });

  it('SID-44. in the page, with the shop\'s own hold store: a sign-out while an unconfirmed save is held detaches it at once — the card says so, Check again is gone, and nothing is ever sent again (not on a focus either); Stop tracking clears it', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const r = rig(server);
    const props = r.props({ holds: undefined }); // the module's store, as the shop runs it
    render(<ServerInvoiceDrafts {...props} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(r.holds.get('uid-a')).toBeUndefined(); // held in the shop's store, not the rig's
    await act(async () => { await props.session!.logout(); });
    expect(hold()).toHaveAttribute('data-state', 'detached');
    expect(hold()).toHaveTextContent(HOLD_TEXT.detached);
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(server.posts()).toHaveLength(1);
    await click('drafts-stop');
    expect(hold()).toBeNull();
  });

  it('SID-45. a save whose session answered just before a sign-out began is not sent: the sign-out closes the dialog and ends the section\'s generation, and the save takes nothing from that earlier answer — no key, no POST, nothing held, the picker\'s pair not made again (looked at without making it), nothing but the logout sent; a later Reconnect is a first connection, not a "changed" one', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const real = r.props().session!;
    let trip = false;
    let mark = -1;
    // The sign-out begins after the session confirmation has answered, before the save's continuation runs.
    const session: TenantSessionClient = { ...real, ensure: async (...args) => { const s = await real.ensure(...args); if (trip) { trip = false; mark = server.sent.length; void real.logout(); } return s; } };
    render(<ServerInvoiceDrafts {...r.props({ session })} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    expect(hasSessionPair()).toBe(true); // the picker made the customer's context
    trip = true;
    await click('draft-new-save');
    await waitFor(() => expect(screen.queryByTestId('draft-new')).toBeNull());
    await settle();
    expect(trip).toBe(false);
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(screen.getByTestId('drafts-stores-state')).toHaveTextContent(DRAFTS_TEXT.ended);
    expect(server.posts()).toEqual([]);
    expect(r.keys).toEqual([]);
    expect(r.holds.get('uid-a')).toBeUndefined();
    expect(hasSessionPair()).toBe(false);
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    // The ended token was taken back nowhere: Reconnect's token (a new session: the server ended A's, which this fake's
    // logout answer does not do on its own) is the section's first, so nothing says the connection "changed".
    server.expire();
    await click('drafts-retry');
    await storesReady();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    expect(storeSelect().value).toBe('');
  });

  it('SID-46. outside the dialogs, a press that takes its own control away hands focus to the section heading — Show server drafts, the stores\' Try again and Reconnect, the list\'s Try again — and so does a session end that takes the store choice it was on; never <body>', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    const heading = screen.getByRole('heading', { name: 'Server drafts' });
    act(() => { screen.getByTestId('drafts-show').focus(); });
    const watch = watchBody();
    try {
      server.hold.stores = 1;
      await user().click(screen.getByTestId('drafts-show'));
      expect(screen.queryByTestId('drafts-show')).toBeNull();
      expect(document.activeElement).toBe(heading);
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['stores']));
      await act(async () => { server.held.shift()!.release(refusal(503, 'service_unavailable')); });
      await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'unavailable'));
      await user().click(screen.getByTestId('drafts-retry')); // Try again: it goes as the stores read starts
      expect(document.activeElement).toBe(heading);
      await storesReady();
      server.expire();
      act(() => { storeSelect().focus(); });
      fireEvent.change(storeSelect(), { target: { value: STORE_1 } }); // its list read finds the session ended
      await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
      expect(screen.queryByTestId('drafts-store')).toBeNull();
      expect(document.activeElement).toBe(heading);
      await waitFor(() => expect(screen.getByTestId('drafts-retry')).toBeEnabled());
      await user().click(screen.getByTestId('drafts-retry')); // Reconnect
      expect(document.activeElement).toBe(heading);
      await storesReady();
      server.listStatus.push(500);
      fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
      await waitFor(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'unavailable'));
      await user().click(screen.getByTestId('drafts-list-retry'));
      expect(document.activeElement).toBe(heading);
      await listReady();
      expect(rows()).toHaveLength(1);
      expect(watch.fell).toEqual([]);
    } finally {
      watch.stop();
    }
    expect(server.posts()).toEqual([]);
  });

  it('SID-47. "Load more" keeps focus through its read (aria-disabled, never disabled; a press meanwhile reads nothing) and while more pages remain; the last page hands focus to the first row it added, and a failed continuation to the heading', async () => {
    const { server, ada } = seeded();
    for (let i = 0; i < 45; i++) server.seedDraft(STORE_1, ada, at(100 + i));
    for (let i = 0; i < 25; i++) server.seedDraft(STORE_2, ada, at(300 + i));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    const heading = screen.getByRole('heading', { name: 'Server drafts' });
    const more = () => screen.getByTestId('drafts-load-more');
    const reads = (store: string) => server.sent.filter((r) => r.method === 'GET' && r.url.startsWith(`${draftsPathOf(store)}?`)).length;
    act(() => { more().focus(); });
    const watch = watchBody();
    try {
      server.hold.list = 1;
      await user().click(more());
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list']));
      expect(more()).toHaveAttribute('aria-disabled', 'true');
      expect(more()).toBeEnabled();
      expect(document.activeElement).toBe(more());
      await user().click(more()); // during its read: nothing
      expect(reads(STORE_1)).toBe(2);
      await act(async () => { server.held.shift()!.release(); });
      await waitFor(() => expect(rows()).toHaveLength(40));
      expect(more()).toHaveAttribute('aria-disabled', 'false');
      expect(document.activeElement).toBe(more()); // more pages remain: it stays, and keeps focus
      await user().click(more());
      await waitFor(() => expect(rows()).toHaveLength(45));
      expect(screen.queryByTestId('drafts-load-more')).toBeNull();
      expect(document.activeElement).toBe(within(rows()[40]).getByTestId('drafts-open')); // the first row the last page added
      expect(reads(STORE_1)).toBe(3);
      fireEvent.change(storeSelect(), { target: { value: STORE_2 } }); // the focused Open goes with its store's rows
      await waitFor(() => expect(rows()).toHaveLength(20));
      expect(document.activeElement).toBe(heading);
      server.listStatus.push(503);
      await user().click(more());
      await waitFor(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'unavailable'));
      expect(screen.queryByTestId('drafts-load-more')).toBeNull();
      expect(document.activeElement).toBe(heading);
      expect(watch.fell).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('SID-48. a render that takes away or disables the focused control hands focus to the heading — a new generation (another tab\'s session, detaching a held save in the same moment) under a focused Open, the eligibility\'s Try again taken away by its own press (M7B-INVOICES-P1-R2), a store change taking a focused New away while the new store is asked (a rate limit\'s wait then holding its New back); focus on the store choice is kept while its rows change, and the server\'s answer adding New takes no focus', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const other = server.seedDraft(STORE_2, ada, at(6));
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    const heading = screen.getByRole('heading', { name: 'Server drafts' });
    act(() => { storeSelect().focus(); });
    const watch = watchBody();
    try {
      fireEvent.change(storeSelect(), { target: { value: STORE_2 } }); // its rows are replaced: the choice keeps focus
      await waitFor(() => expect(rows().map((row) => row.getAttribute('data-id'))).toEqual([other.id]));
      expect(document.activeElement).toBe(storeSelect());
      expect(watch.fell).toEqual([]);
      await heldInSection(server, ada); // an unconfirmed save, held: the next generation detaches it
      await settle();
      watch.fell.length = 0; // the dialog's own close and focus return (SID-29) are not this case's
      act(() => { within(rows()[0]).getByTestId('drafts-open').focus(); });
      server.otherTab('uid-a');
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
      expect(hold()).toHaveAttribute('data-state', 'detached');
      expect(rows()).toEqual([]);
      expect(document.activeElement).toBe(heading);
      await user().click(screen.getByTestId('drafts-stop')); // the detached attempt goes: New is not held back by it
      expect(document.activeElement).toBe(heading);
      server.eligStatus.push(503); // the server cannot answer the eligibility: Try again, never New
      fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
      await listReady();
      await waitFor(() => expect(eligPhase()).toBe('unavailable'));
      act(() => { screen.getByTestId('drafts-elig-retry').focus(); });
      server.hold.elig = 1;
      await user().click(screen.getByTestId('drafts-elig-retry')); // its own press takes it away while the check runs
      expect(screen.queryByTestId('drafts-elig-retry')).toBeNull();
      expect(document.activeElement).toBe(heading);
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
      await act(async () => { server.held.shift()!.release(); });
      await waitFor(() => expect(screen.getByTestId('drafts-new')).toBeEnabled());
      expect(document.activeElement).toBe(heading); // the answer adds New: it takes no focus
      act(() => { screen.getByTestId('drafts-new').focus(); });
      expect(document.activeElement).toBe(screen.getByTestId('drafts-new'));
      server.retryAfter = '5';
      server.listStatus.push(429);
      fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
      expect(screen.queryByTestId('drafts-new')).toBeNull(); // STORE_1's answer goes with STORE_1
      expect(document.activeElement).toBe(heading);
      await waitFor(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited'));
      await waitFor(() => expect(screen.getByTestId('drafts-new')).toBeDisabled()); // STORE_2's own answer, held back by the wait
      expect(document.activeElement).toBe(heading);
      expect(watch.fell).toEqual([]);
    } finally {
      watch.stop();
    }
    expect(server.posts()).toHaveLength(1); // the held save's one POST: nothing re-sent
  });

  it.each(['list', 'names', 'reopen'] as const)('SID-49. a sign-out while a %s read is out ends the section at once: the late answer, released after it, shows nothing and starts nothing — no row, name or draft, no further read (the queued name read included), nothing sent but the logout; the section says the session ended and signs nobody in', async (kind) => {
    const { server } = seeded();
    server.seedCustomer(TENANT_A, 'Cy Customer');
    server.seedCustomer(TENANT_A, 'Di Customer');
    const people = [...server.customers.entries()].map(([id, c]) => ({ id, name: c.name }));
    people.forEach((c, i) => server.seedDraft(STORE_1, c.id, at(10 + i))); // four customers: three name reads out, one queued
    const r = rig(server);
    const props = r.props();
    render(<ServerInvoiceDrafts {...props} />);
    await click('drafts-show');
    await storesReady();
    if (kind === 'list') server.hold.list = 1;
    if (kind === 'names') server.hold.names = 3;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    if (kind === 'reopen') {
      await listReady();
      await waitFor(() => expect(screen.getAllByTestId('drafts-row-customer').map((n) => n.textContent).sort()).toEqual(people.map((c) => c.name).sort()));
      server.hold.get = 1;
      await user().click(within(rows()[0]).getByTestId('drafts-open'));
    }
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual({ list: ['list'], names: ['names', 'names', 'names'], reopen: ['get'] }[kind]));
    const mark = server.sent.length;
    await act(async () => { void props.session!.logout(); });
    for (const late of server.held.splice(0)) await act(async () => { late.release(); });
    await settle();
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(rows()).toEqual([]);
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(screen.getByTestId('drafts-stores-state')).toHaveTextContent(DRAFTS_TEXT.ended);
    for (const c of people) expect(document.body).not.toHaveTextContent(c.name);
    if (kind === 'reopen') {
      expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'signed-out');
      expect(screen.queryAllByTestId('draft-view-line')).toEqual([]);
    }
    expect(screen.getByTestId('drafts-retry')).toBeEnabled(); // Reconnect: the user's own press, nothing reads on its own
    expect(server.posts()).toEqual([]);
  });

  it('SID-50. focus the user left on <body> with a press on plain text stays theirs: a later render that takes away the control they left (a new generation from another tab\'s session removing New, M7B-INVOICES-P1-R2) moves no focus; the tracking resumes at the next focus in the section', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    const heading = screen.getByRole('heading', { name: 'Server drafts' });
    act(() => { screen.getByTestId('drafts-new').focus(); });
    await user().click(screen.getByText(DRAFTS_TEXT.intro)); // no control there: focus goes to <body>, with no focus event
    expect(document.activeElement).toBe(document.body);
    server.otherTab('uid-a'); // the section's next check finds another token: a new generation, without a press
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    expect(document.activeElement).toBe(document.body); // left where the user put it, not pulled to the heading
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    await eligSettled();
    act(() => { screen.getByTestId('drafts-new').focus(); });
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.queryByTestId('drafts-new')).toBeNull());
    expect(document.activeElement).toBe(heading); // focused again, then taken away: the recovery stands
    expect(server.posts()).toEqual([]);
  });

  it('SID-51. a Check again whose session answered just before a sign-out began sends nothing — even from a hold store the sign-out does not scrub, which keeps the token and body: no POST and nothing but the logout sent; the attempt stays unresolved and says why', async () => {
    const { server, ada } = seeded();
    const r = rig(server); // its hold store is NOT bound to the sign-out: only the check's own comparison stands in the way
    const real = r.props().session!;
    let trip = false;
    let mark = -1;
    const session: TenantSessionClient = { ...real, ensure: async (...args) => { const s = await real.ensure(...args); if (trip) { trip = false; mark = server.sent.length; void real.logout(); } return s; } };
    render(<ServerInvoiceDrafts {...r.props({ session })} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    expect(server.posts()).toHaveLength(1);
    trip = true;
    await click('drafts-check-again');
    await waitFor(() => expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'unresolved', note: `Not checked. ${DRAFTS_TEXT.ended}` })));
    await settle();
    expect(trip).toBe(false);
    expect(r.holds.get('uid-a')?.csrf).not.toBeNull(); // still held by this unbound store: the comparison alone kept it from leaving
    expect(server.posts()).toHaveLength(1); // the lost first send only
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
  });

  it('SID-52. a list read refused 403 whose one fresh check answered just before a sign-out began takes nothing from that answer: the section stays ended, and the user\'s Reconnect is a FIRST connection — no "connection changed"', async () => {
    const { server } = seeded();
    const r = rig(server);
    const real = r.props().session!;
    let trip = true;
    const session: TenantSessionClient = {
      ...real,
      ensure: async (uid, idToken, options) => { const s = await real.ensure(uid, idToken, options); if (trip && options?.fresh === true) { trip = false; void real.logout(); } return s; },
    };
    render(<ServerInvoiceDrafts {...r.props({ session })} />);
    await click('drafts-show');
    await storesReady();
    server.listStatus.push(403);
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(trip).toBe(false));
    await settle();
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    server.expire(); // the server ended that session (this fake's logout answer does not): Reconnect gets a new token
    await click('drafts-retry'); // Reconnect
    await storesReady();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    expect(server.posts()).toEqual([]);
  });

  it('SID-53. a sign-out during a rate limit\'s wait ends that wait with the session that was asked to wait: after Reconnect a store is read at once and New is not held back by it', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    const props = r.props();
    render(<ServerInvoiceDrafts {...props} />);
    await showAndChoose(STORE_1);
    server.retryAfter = '60';
    server.listStatus.push(429);
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await waitFor(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited'));
    expect(screen.getByTestId('drafts-new')).toBeDisabled(); // the 60-second wait
    await act(async () => { void props.session!.logout(); });
    server.expire(); // the server ended that session (this fake's logout answer does not): Reconnect signs in again
    await click('drafts-retry'); // Reconnect
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId('drafts-new')).toBeEnabled();
    expect(server.posts()).toEqual([]);
  });

  it('SID-27. nothing reaches browser storage or a log, and the sources reach neither', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const { server, ada } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    expect(setItem).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain('s'.repeat(40)); // no session token in the DOM
    for (const file of ['ServerInvoiceDrafts.tsx', 'invoiceDraftsClient.ts']) {
      const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|history\.|location\.(href|search|hash)/);
    }
  });

  /**
   * A session wrapper aimed at the new-draft dialog's hand-over check: the first `ensure` asked while that dialog is up.
   * Its answer (the real one) is handed to `hook` before the dialog sees it; every other check passes through, and
   * `onOther` sees each of their answers.
   */
  function aimedAtTheDialog(real: TenantSessionClient, hook: (s: Awaited<ReturnType<TenantSessionClient['ensure']>>) => Promise<void> | void, onOther: () => void = () => {}) {
    // `answer`: the dialog's check as the dialog holds it — a `.then` added to it later runs after the dialog's own.
    const aim = { armed: true, calls: 0, answer: null as ReturnType<TenantSessionClient['ensure']> | null };
    const session: TenantSessionClient = {
      ...real,
      ensure: (...args) => {
        const theDialogs = aim.armed && screen.queryByTestId('draft-new') !== null;
        if (theDialogs) aim.armed = false;
        else onOther();
        aim.calls += 1;
        const answer = (async () => {
          const s = await real.ensure(...args);
          if (theDialogs) await hook(s);
          return s;
        })();
        if (theDialogs) aim.answer = answer;
        return answer;
      },
    };
    /** Resolves once the dialog's own continuation of its check has run (the explicit barrier the cases wait on). */
    const dialogDone = (): Promise<void> => aim.answer!.then(() => undefined);
    return { session, aim, dialogDone };
  }
  /** A hand-over of `customer`, then the store choice that opens the new-draft dialog (its check is asked at once). */
  async function handOver(r: Rig, session: TenantSessionClient, customer: string, extra?: ReactNode) {
    const view = render(<>{extra}<ServerInvoiceDrafts {...r.props({ session })} /></>);
    view.rerender(<>{extra}<ServerInvoiceDrafts {...r.props({ session, handoff: { id: customer, name: 'Ada Customer' } })} /></>);
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(screen.getByTestId('draft-new')).toBeInTheDocument());
    return view;
  }

  it('SID-54. AC-07 regression guard (it passes on the entry commit too: the section\'s own sign-out listener closes the dialog first): a sign-out that begins while the hand-over\'s session check is out (its answer, the old token, arriving after): no customer, no context, no notice, no login, no POST — nothing but the logout; the hand-over is gone, and Reconnect is a first connection that opens nothing', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const real = r.props().session!;
    let mark = -1;
    const { session, aim } = aimedAtTheDialog(real, () => { mark = server.sent.length; void real.logout(); });
    await handOver(r, session, ada);
    await waitFor(() => expect(aim.armed).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('draft-new')).toBeNull());
    await settle();
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(hasSessionPair()).toBe(false);
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(screen.getByTestId('drafts-stores-state')).toHaveTextContent(DRAFTS_TEXT.ended);
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(server.posts()).toEqual([]);
    expect(r.keys).toEqual([]);
    server.expire(); // the fake's logout answer does not end the session on its own
    await click('drafts-retry');
    await storesReady();
    await settle();
    expect(screen.queryByTestId('drafts-handoff')).toBeNull();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    expect(server.posts()).toEqual([]);
  });

  it('SID-55. AC-07, the inverse order: the section adopts a new session (a new generation) before the hand-over\'s old answer arrives — that answer makes no customer and no context for the old token, even while another draft field keeps the module\'s pair alive, and nothing is sent', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const r = rig(server);
    const real = r.props().session!;
    const gate = { release: null as (() => void) | null, others: -1 };
    let released!: () => void;
    const releasedThen = new Promise<void>((resolve) => { released = resolve; });
    // The dialog's answer waits; once another tab has signed in, the section's 1st check (the focus check, answering the
    // new token) passes, and its 2nd (the store read that `begin` starts for the new generation) releases that answer —
    // by then the section has adopted the new token, and inside act nothing has been committed yet.
    const { session, dialogDone } = aimedAtTheDialog(
      real,
      async () => { await new Promise<void>((resolve) => { gate.release = resolve; }); },
      () => {
        if (gate.others < 0) return;
        gate.others += 1;
        if (gate.others === 2 && gate.release !== null) { const go = gate.release; gate.release = null; go(); released(); }
      },
    );
    const props = r.props();
    const other = <ServerCustomerField uid="uid-a" value={null} canView onChange={() => {}} session={props.session} customers={props.customers} identity={props.identity} />;
    await handOver(r, session, ada, other);
    await waitFor(() => expect(gate.release).not.toBeNull());
    expect(hasSessionPair()).toBe(false); // the dialog has made no context yet
    server.otherTab('uid-a'); // another tab signs the same user in: a new session and token
    gate.others = 0;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await releasedThen; // the new generation's store read has started: the old answer is released
      await dialogDone(); // and the dialog's continuation has run — still inside act, before any commit
    });
    expect(gate.release).toBeNull(); // released
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull(); // the new generation closed it
    expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument();
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(hasSessionPair()).toBe(false); // no (UID, token) pair was made for the old token
    expect(server.posts()).toEqual([]);
    expect(r.keys).toEqual([]);
  });

  it('SID-56. AC-07: the section finds the session ended (a focus check) while the hand-over\'s check is out; the dialog stays up, and the old answer arriving after it shows no customer and no notice, makes no context, and sends nothing — no login, no POST', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const r = rig(server);
    const real = r.props().session!;
    const gate = { release: null as (() => void) | null };
    const { session, dialogDone } = aimedAtTheDialog(real, async () => { await new Promise<void>((resolve) => { gate.release = resolve; }); });
    await handOver(r, session, ada);
    await waitFor(() => expect(gate.release).not.toBeNull());
    server.expire();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.getByTestId('draft-new')).toBeInTheDocument();
    const mark = server.sent.length;
    await act(async () => { gate.release!(); await dialogDone(); }); // the dialog's continuation has run, and React committed
    expect(within(screen.getByTestId('draft-new')).queryByTestId('picker-value')).toBeNull();
    expect(screen.queryByTestId('draft-new-status')).toBeNull();
    expect(hasSessionPair()).toBe(false);
    expect(server.sent.slice(mark)).toEqual([]);
    expect(server.posts()).toEqual([]);
    expect(r.keys).toEqual([]);
  });

  it('SID-57. under StrictMode (setup, cleanup, setup in development) a hand-over still binds its customer in the dialog and one Save sends one POST', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const view = render(<StrictMode><ServerInvoiceDrafts {...r.props()} /></StrictMode>);
    view.rerender(<StrictMode><ServerInvoiceDrafts {...r.props({ handoff: { id: ada, name: 'Ada Customer' } })} /></StrictMode>);
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada));
    fireEvent.change(screen.getByTestId('draft-new-description'), { target: { value: 'Fan' } });
    fireEvent.change(screen.getByTestId('draft-new-price'), { target: { value: '5' } });
    await click('draft-new-save');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.posts().map((p) => p.body)).toEqual([bodyOf(TENANT_A, ada, [['Fan', 1, 500]])]);
  });
});

// M7B-INVOICES-P1-R2 (DA-201): "New server draft" is the server's decision — the eligibility read the fake answers from the
// same per-role table as its saves — bound to the user, generation, token, store and request that asked.
describe('Server drafts — the server decides New (M7B-INVOICES-P1-R2, DA-201)', () => {
  const json200 = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const allowedAnswer = (): Response => json200({ eligibility: 'allowed' });
  const tokenOf = (n: number, letter = 's'): string => `${letter.repeat(40)}${String(n).padStart(3, '0')}`;
  /** Release the `i`th held request (in hold order), with `late` instead of its own answer when given. */
  const release = async (server: Server, i = 0, late?: Response) => { const [held] = server.held.splice(i, 1); await act(async () => { held.release(late); }); };

  it('SID-58. AC-08: New follows the server\'s positive answer for exactly the chosen store and session — nothing (said as checking) until it answers; one eligibility GET per writable choice, carrying that session\'s token and nothing else; none for a read-only store; a hand-over\'s dialog opens only on the answer', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await click('drafts-show');
    await storesReady();
    server.hold.elig = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    const note = screen.getByTestId('drafts-elig');
    expect(note).toHaveAttribute('data-phase', 'checking');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveTextContent(ELIGIBILITY_TEXT.checking);
    const [asked] = server.eligReads();
    expect([asked.method, asked.url, asked.body]).toEqual(['GET', eligibilityPathOf(STORE_1), undefined]);
    expect(asked.headers.get('x-tmpos-session-csrf')).toBe(tokenOf(1));
    expect(asked.headers.get('idempotency-key')).toBeNull();
    expect(asked.headers.get('x-tmpos-csrf')).toBeNull();
    await release(server);
    await waitFor(() => expect(screen.getByTestId('drafts-new')).toBeEnabled());
    expect(screen.getByTestId('drafts-elig')).toHaveAttribute('data-phase', 'allowed');
    expect(screen.getByTestId('drafts-elig')).toHaveTextContent('');
    fireEvent.change(storeSelect(), { target: { value: STORE_RO } });
    await listReady();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    expect(screen.queryByTestId('drafts-elig')).toBeNull();
    expect(screen.getByTestId('drafts-read-only')).toHaveTextContent(DRAFTS_TEXT.readOnly);
    // A hand-over while a writable store is asked: its dialog waits for the server's answer for that store.
    server.hold.elig = 1;
    view.rerender(<ServerInvoiceDrafts {...r.props({ handoff: { id: ada, name: 'Ada Customer' } })} />);
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(screen.getByTestId('drafts-handoff')).toBeInTheDocument();
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-new')).toBeInTheDocument());
    expect(screen.getByTestId('draft-new-store')).toHaveTextContent(storeLabel({ id: STORE_2, name: null }));
    expect(server.eligReads().map((x) => x.url)).toEqual([eligibilityPathOf(STORE_1), eligibilityPathOf(STORE_2)]);
    expect(server.posts()).toEqual([]);
  });

  it('SID-59. AC-09: a role the server does not allow — a browser-only custom role standing on a local Invoices Full — never gets New: the eligibility 403 gets ONE fresh session check, the same token makes it a refusal that stands (an alert, no Try again, nothing asked again), a hand-over is not opened; the store\'s drafts still list', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    server.users['tok-a'].role = 'custom-invoices-full'; // the server's table has no such role: no save is authorized for it
    const r = rig(server);
    const real = r.props().session!;
    let fresh = 0;
    const session: TenantSessionClient = { ...real, ensure: (uid, idToken, options) => { if (options?.fresh === true) fresh += 1; return real.ensure(uid, idToken, options); } };
    render(<ServerInvoiceDrafts {...r.props({ session, handoff: { id: ada, name: 'Ada Customer' } })} />);
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(eligPhase()).toBe('denied'));
    const note = screen.getByTestId('drafts-elig');
    // The live region keeps its role (status) and goes quiet; the refusal is an alert of its own, mounted with it (F3).
    expect(note).toHaveAttribute('role', 'status');
    expect(note.textContent).toBe('');
    expect(screen.getByTestId('drafts-elig-alert')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('drafts-elig-alert')).toHaveTextContent(ELIGIBILITY_TEXT.denied);
    await settle();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    expect(screen.queryByTestId('drafts-elig-retry')).toBeNull();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(screen.getByTestId('drafts-handoff')).toBeInTheDocument();
    expect(fresh).toBe(1);
    expect(server.eligReads()).toHaveLength(1);
    await listReady();
    expect(rows()).toHaveLength(1); // View is not Create: the list is the server's own answer
    expect(server.posts()).toEqual([]);
    expect(r.keys).toEqual([]);
  });

  it('SID-60. AC-12: an outage, a malformed answer, an answer in another envelope or a timeout is "unavailable" — said without a word about permission, with a read-only Try again and never New (no local fallback, no earlier answer); each Try again is one GET of the eligibility (after the session check) and the server\'s allowance then offers New', async () => {
    expect(ELIGIBILITY_TEXT.unavailable).not.toMatch(/may not|not allowed|permission|denied|refus/i);
    const { server } = seeded();
    const html = (status: number): Response => new Response('<html>no</html>', { status, headers: { 'content-type': 'text/html' } });
    const bad: Array<number | Response> = [
      500, 503, 404, 400, json200({ eligibility: 'allowed', role: 'owner' }), json200({ eligibility: 'yes' }), json200({}), html(200), html(403), html(401),
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }),
    ];
    server.eligStatus.push(...bad);
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    for (let i = 0; i < bad.length; i++) {
      await waitFor(() => expect(eligPhase()).toBe('unavailable'));
      const note = screen.getByTestId('drafts-elig');
      expect(note).toHaveAttribute('role', 'status');
      expect(note).toHaveTextContent(ELIGIBILITY_TEXT.unavailable);
      expect(screen.queryByTestId('drafts-new')).toBeNull();
      expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'ready'); // never a sign-out
      const mark = server.sent.length;
      await user().click(screen.getByTestId('drafts-elig-retry'));
      await waitFor(() => expect(eligPhase()).not.toBe('checking'));
      expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${eligibilityPathOf(STORE_1)}`]);
    }
    await waitFor(() => expect(screen.getByTestId('drafts-new')).toBeEnabled());
    expect(server.eligReads()).toHaveLength(bad.length + 1);
    cleanup();
    // No answer within the client's deadline: unavailable; the answer released after it changes nothing.
    const slow = seeded().server;
    slow.hold.elig = 1;
    const r = rig(slow);
    // As a browser's fetch: the client's abort at its deadline rejects the request, held at the fake or not.
    const fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      void slow.fetch(input, init).then(resolve, reject);
    })) as typeof globalThis.fetch;
    render(<ServerInvoiceDrafts {...r.props({ drafts: createInvoiceDraftsClient({ fetch, timeoutMs: 40 }) })} />);
    await click('drafts-show');
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(eligPhase()).toBe('unavailable'));
    expect(slow.eligReads()[0].signal?.aborted).toBe(true);
    await release(slow);
    await settle();
    expect(eligPhase()).toBe('unavailable');
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    expect(slow.posts()).toEqual([]);
  });

  it('SID-61. AC-12: a 401 from the eligibility ends the session as any read\'s does (no sign-in on its own, Reconnect); a 403 whose one fresh check finds ANOTHER token starts a new generation instead of a refusal — the store is chosen again and asks again under the new token', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await click('drafts-show');
    await storesReady();
    server.eligStatus.push(401);
    const logins = () => server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login).length;
    const before = logins();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.getByTestId('drafts-stores-state')).toHaveTextContent(DRAFTS_TEXT.ended);
    await settle();
    expect(logins()).toBe(before);
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    server.expire();
    await click('drafts-retry'); // Reconnect: a first connection
    await storesReady();
    expect(logins()).toBe(before + 1);
    // Another tab's session replaces this one while the eligibility is out: it is refused 403 (the token no longer the
    // session's), the one fresh check finds the new token, and a new generation starts.
    server.hold.elig = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    server.otherTab('uid-a');
    await release(server, 0, refusal(403, 'forbidden'));
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    expect(storeSelect().value).toBe('');
    expect(screen.queryByTestId('drafts-elig')).toBeNull();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(screen.getByTestId('drafts-new')).toBeEnabled());
    expect(server.eligReads().at(-1)!.headers.get('x-tmpos-session-csrf')).toBe(tokenOf(3, 't'));
    expect(server.posts()).toEqual([]);
  });

  it('SID-62. AC-12: a 429 from the eligibility starts the section\'s wait with its Retry-After — said, New absent and Try again disabled through it, nothing read on its own (a store chosen meanwhile asks nothing); once it has passed Try again is enabled and its press is one read', async () => {
    const { server } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await click('drafts-show');
    await storesReady();
    fakeClock();
    server.retryAfter = '2';
    server.eligStatus.push(429);
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await until(() => expect(eligPhase()).toBe('rate-limited'));
    await until(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('drafts-elig')).toHaveTextContent(pickerWaitText(2)); // only the eligibility was limited: it says the wait
    expect(screen.getByTestId('drafts-list-state')).not.toHaveTextContent(/Too many requests/);
    expect(screen.getByTestId('drafts-elig-retry')).toBeDisabled();
    expect(screen.getByTestId('drafts-elig-retry')).toHaveAccessibleDescription(ELIGIBILITY_TEXT.waiting);
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    const reads = server.sent.length;
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await settle();
    expect(eligPhase()).toBe('rate-limited');
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited');
    // The wait is said once: the list's note says it, so the eligibility's is quiet (F4).
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent(/Too many requests\. Wait \d+ seconds?, then try again\./);
    expect(screen.getByTestId('drafts-elig').textContent).toBe('');
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await settle();
    expect(server.sent).toHaveLength(reads); // nothing read during the wait
    fireEvent.click(screen.getByTestId('drafts-elig-retry')); // disabled: nothing
    await advance(2_000);
    await settle();
    expect(server.sent).toHaveLength(reads); // nor at its end
    expect(screen.getByTestId('drafts-elig-retry')).toBeEnabled();
    expect(screen.getByTestId('drafts-elig-retry')).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    fireEvent.click(screen.getByTestId('drafts-elig-retry'));
    await until(() => expect(screen.getByTestId('drafts-new')).toBeEnabled());
    expect(server.sent.slice(reads).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${eligibilityPathOf(STORE_1)}`]);
    expect(server.posts()).toEqual([]);
  });

  it.each(['the older answer first', 'the newer answer first'] as const)('SID-63. AC-13: answers for a store left behind or for an older check of the same store change nothing — %s: a store switch, then a newer check of the first store; the old checks are aborted, only the newest answers', async (order) => {
    const { server } = seeded();
    server.eligStatus.push(allowedAnswer(), allowedAnswer(), 403); // STORE_1 (old), STORE_2 (left behind), STORE_1 (newest): denied
    server.hold.elig = 3;
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await click('drafts-show');
    await storesReady();
    for (const id of [STORE_1, STORE_2, STORE_1]) {
      const n = server.held.length;
      fireEvent.change(storeSelect(), { target: { value: id } });
      await waitFor(() => expect(server.held).toHaveLength(n + 1));
    }
    const [first, second] = server.eligReads();
    expect([first.signal?.aborted, second.signal?.aborted]).toEqual([true, true]);
    expect(eligPhase()).toBe('checking');
    for (const i of order === 'the older answer first' ? [0, 0, 0] : [2, 1, 0]) {
      await release(server, i);
      await settle();
      expect(screen.queryByTestId('drafts-new')).toBeNull();
    }
    await waitFor(() => expect(eligPhase()).toBe('denied'));
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    expect(server.posts()).toEqual([]);
  });

  it('SID-64. AC-13: a sign-out makes any eligibility answer of before it count for nothing — an answer released after the sign-out began, and a check whose session answered just before it (no eligibility read is sent at all); after Reconnect the store asks again', async () => {
    const { server } = seeded();
    const r = rig(server);
    const real = r.props().session!;
    let trip = false;
    let mark = -1;
    const session: TenantSessionClient = { ...real, ensure: async (...args) => { const s = await real.ensure(...args); if (trip) { trip = false; mark = server.sent.length; void real.logout(); } return s; } };
    render(<ServerInvoiceDrafts {...r.props({ session })} />);
    await click('drafts-show');
    await storesReady();
    server.hold.elig = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    const out = server.sent.length;
    await act(async () => { void real.logout(); });
    await release(server); // the server's allowance, decided before the sign-out
    await settle();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(server.sent.slice(out).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    server.expire();
    await click('drafts-retry'); // Reconnect
    await storesReady();
    trip = true; // the next session check answers ok, and a sign-out begins before its caller continues
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await waitFor(() => expect(trip).toBe(false));
    await settle();
    expect(server.eligReads(STORE_2)).toEqual([]);
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    server.expire();
    await click('drafts-retry');
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await waitFor(() => expect(screen.getByTestId('drafts-new')).toBeEnabled());
    expect(server.posts()).toEqual([]);
  });

  it('SID-65. AC-13: an eligibility answer cannot cross a user switch (the section is the user\'s: its check is aborted with it) or a new generation (another tab\'s session noticed on focus): released after either, it offers nothing; the store chosen again asks again under the new token', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server } = seeded();
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await click('drafts-show');
    await storesReady();
    server.hold.elig = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-b' })} />);
    expect(server.eligReads()[0].signal?.aborted).toBe(true);
    const out = server.sent.length;
    await release(server);
    await settle();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    expect(screen.queryByTestId('drafts-store')).toBeNull(); // uid-b's section has read nothing yet
    expect(server.sent.slice(out)).toEqual([]);
    view.rerender(<ServerInvoiceDrafts {...r.props()} />);
    await click('drafts-show');
    await storesReady();
    server.hold.elig = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    await release(server);
    await settle();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(screen.getByTestId('drafts-new')).toBeEnabled());
    const reads = server.eligReads(STORE_1);
    expect(reads.at(-1)!.headers.get('x-tmpos-session-csrf')).not.toBe(reads.at(-2)!.headers.get('x-tmpos-session-csrf'));
    expect(server.posts()).toEqual([]);
  });

  it('SID-66. a save refused 403 stays the dialog\'s refusal (form kept) AND takes New away at that store under that session — nothing is asked again on its own; on Cancel focus goes to the heading (New is gone); another store asks its own', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.allow.owner = false; // the owner lowers the role's level meanwhile: the save is no longer authorized
    const asked = server.eligReads().length;
    await click('draft-new-save');
    await waitFor(() => expect(screen.getByTestId('draft-new-status')).toHaveTextContent(REFUSED_TEXT.denied));
    expect(screen.getByTestId('draft-new-description')).toHaveValue('Fan');
    expect(eligPhase()).toBe('denied');
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    await click('draft-new-cancel');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Server drafts' })));
    await settle();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    expect(screen.getByTestId('drafts-elig-alert')).toHaveTextContent(ELIGIBILITY_TEXT.denied);
    expect(server.eligReads()).toHaveLength(asked); // no read on its own
    expect(server.posts()).toHaveLength(1);
    expect(server.drafts).toHaveLength(0);
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await waitFor(() => expect(eligPhase()).toBe('denied')); // its own answer, from the server's table now
    expect(server.eligReads(STORE_2)).toHaveLength(1);
  });

  it('SID-67. a save refused 429 stays the dialog\'s refusal and starts the section\'s wait with its Retry-After: Save draft (described why) and New are held back through it, nothing is sent on its own, and both come back once it has passed', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    fakeClock();
    server.retryAfter = '3';
    server.creates.push(429);
    fireEvent.click(screen.getByTestId('draft-new-save'));
    await until(() => expect(screen.getByTestId('draft-new-status')).toHaveTextContent(REFUSED_TEXT['rate-limited']));
    expect(screen.getByTestId('draft-new-save')).toBeDisabled();
    expect(screen.getByTestId('draft-new-save')).toHaveAccessibleDescription(HOLD_TEXT.saveWaiting);
    const sent = server.sent.length;
    fireEvent.click(screen.getByTestId('draft-new-cancel'));
    await settle();
    expect(screen.getByTestId('drafts-new')).toBeDisabled();
    await advance(3_000);
    await settle();
    expect(screen.getByTestId('drafts-new')).toBeEnabled();
    expect(server.sent).toHaveLength(sent);
    expect(server.posts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    fireEvent.click(screen.getByTestId('drafts-new'));
    await settle();
    expect(screen.getByTestId('draft-new-save')).toBeEnabled();
  });

  it('SID-68. AC-14 (a regression guard: it passes on the entry sources too): under the server\'s allowance a save and its Check again stay one POST per press — the same key and the same bytes — and neither asks the eligibility again', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    const asked = server.eligReads().length;
    await heldInSection(server, ada);
    expect(server.posts()).toHaveLength(1);
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    const posts = server.posts();
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.headers.get('idempotency-key'))).size).toBe(1);
    expect(posts[1].body).toBe(posts[0].body);
    expect(posts[0].body).toBe(bodyOf(TENANT_A, ada, [['Fan', 1, 999]]));
    expect(server.eligReads()).toHaveLength(asked);
    expect(server.drafts).toHaveLength(1);
  });

  it('SID-70. a Check again the server refuses 403 takes New away at that store as a save\'s 403 does — the attempt stays as the check rule leaves it (unresolved, "The server refused this check."), nothing asks the eligibility again on its own, and New stays away after Stop tracking', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada); // the first send's outcome is unknown: held unresolved
    server.allow.owner = false; // the owner lowers the role's level meanwhile
    const asked = server.eligReads().length;
    await click('drafts-check-again');
    await waitFor(() => expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'unresolved', note: 'The server refused this check.' })));
    await settle();
    expect(eligPhase()).toBe('denied');
    expect(screen.getByTestId('drafts-elig-alert')).toHaveTextContent(ELIGIBILITY_TEXT.denied);
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    await click('drafts-stop');
    await settle();
    expect(hold()).toBeNull();
    expect(screen.queryByTestId('drafts-new')).toBeNull(); // no earlier allowance comes back
    expect(server.eligReads()).toHaveLength(asked); // nothing asked on its own
    expect(server.posts()).toHaveLength(2);
  });

  it('SID-71. a Check again the server rate-limits (429) starts the section\'s wait with its Retry-After — Check again and New held back through all of it (still at 3.9 of 4 seconds), the attempt unresolved with its note, nothing sent on its own; once it has passed Check again comes back and New no longer names the wait (it stays disabled while the attempt is held)', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    fakeClock();
    server.retryAfter = '4';
    server.creates.push(429);
    fireEvent.click(screen.getByTestId('drafts-check-again'));
    await until(() => expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'unresolved', note: 'Too many requests. Wait 4 seconds.' })));
    await settle();
    expect(screen.getByTestId('drafts-check-again')).toBeDisabled();
    expect(screen.getByTestId('drafts-new')).toBeDisabled();
    expect(screen.getByTestId('drafts-new')).toHaveAccessibleDescription(`${NOT_SENT_TEXT.pending} ${ELIGIBILITY_TEXT.waiting}`); // F5: the wait named
    const sent = server.sent.length;
    await advance(3_900);
    await settle();
    expect(screen.getByTestId('drafts-check-again')).toBeDisabled(); // the whole Retry-After, not less
    expect(screen.getByTestId('drafts-new')).toBeDisabled();
    expect(screen.getByTestId('drafts-new').getAttribute('aria-describedby')).toContain('drafts-wait-hint');
    await advance(100);
    await settle();
    expect(server.sent).toHaveLength(sent);
    expect(screen.getByTestId('drafts-check-again')).toBeEnabled();
    expect(screen.getByTestId('drafts-new')).toHaveAccessibleDescription(NOT_SENT_TEXT.pending); // the wait no longer named
    expect(screen.getByTestId('drafts-new')).toBeDisabled(); // the attempt is still held (unresolved)
    expect(server.posts()).toHaveLength(2);
    expect(r.keys).toHaveLength(1); // the same key both times
  });

  it('SID-72. a hand-over arriving during a rate limit\'s wait does not open the new-draft dialog on its own; it opens once the wait has passed (the allowance still current)', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    fakeClock();
    server.retryAfter = '2';
    server.detailStatus.push(429); // a reopen read is rate limited: a two-second wait starts, STORE_1's allowance stands
    fireEvent.click(screen.getByTestId('drafts-open'));
    await until(() => expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'rate-limited'));
    fireEvent.click(screen.getByTestId('draft-view-close'));
    await settle();
    view.rerender(<ServerInvoiceDrafts {...r.props({ handoff: { id: ada, name: 'Ada Customer' } })} />);
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(screen.getByTestId('drafts-handoff')).toBeInTheDocument();
    expect(eligPhase()).toBe('allowed');
    await advance(2_000);
    await until(() => expect(screen.getByTestId('draft-new')).toBeInTheDocument());
    expect(server.posts()).toEqual([]);
  });

  it('SID-73. a save\'s 429 that arrives after a sign-out and a Reconnect (a new session) starts no wait: a wait ends with the session that was asked to wait, so the new session\'s New and reads are not held back by the old answer', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const props = r.props();
    render(<ServerInvoiceDrafts {...props} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('hold');
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    await act(async () => { void props.session!.logout(); });
    server.expire(); // the fake's logout answer does not end the session on its own
    await click('drafts-retry'); // Reconnect: a new session and token
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    await eligSettled();
    const late = new Response(JSON.stringify({ error: 'rate_limited', requestId: 'req-synthetic' }), { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' } });
    await act(async () => { server.held.shift()!.release(late); });
    await waitFor(() => expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'refused', refusal: 'rate-limited' })));
    await settle();
    expect(document.getElementById('drafts-wait-hint')).toBeNull(); // no wait
    expect(screen.getByTestId('drafts-new')).toBeEnabled();
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await listReady(); // read at once: not held back by the old session's 429
    expect(server.posts()).toHaveLength(1);
  });

  const late429 = (): Response => new Response(JSON.stringify({ error: 'rate_limited', requestId: 'req-synthetic' }), { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' } });

  it('SID-75. a save\'s late 429 after a sign-out whose Reconnect got the SAME token back (the server kept that session) starts no wait: the token matches, but a sign-out began since the request was sent', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const props = r.props();
    render(<ServerInvoiceDrafts {...props} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('hold');
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    const sentWith = server.sent.find((x) => x.method === 'POST' && x.url === draftsPathOf(STORE_1))!.headers.get('x-tmpos-session-csrf');
    await act(async () => { void props.session!.logout(); }); // the fake's logout leaves that session valid on the server
    await click('drafts-retry'); // Reconnect: the same session, the same token
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    await eligSettled();
    expect(server.eligReads().at(-1)!.headers.get('x-tmpos-session-csrf')).toBe(sentWith); // the token is unchanged
    await act(async () => { server.held.shift()!.release(late429()); });
    await waitFor(() => expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'refused', refusal: 'rate-limited' })));
    await settle();
    expect(document.getElementById('drafts-wait-hint')).toBeNull();
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await listReady();
  });

  it('SID-76. a save\'s late 429 after another tab\'s session was adopted (a new token, no sign-out) starts no wait: no sign-out began, but the token is no longer the section\'s', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('hold');
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    const ends = sessionEndsSoFar();
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    expect(sessionEndsSoFar()).toBe(ends); // no sign-out began
    await act(async () => { server.held.shift()!.release(late429()); });
    await waitFor(() => expect(r.holds.get('uid-a')?.state).toBe('refused'));
    await settle();
    expect(document.getElementById('drafts-wait-hint')).toBeNull();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
  });

  it('SID-74. the wait is said once only when both notes describe the SAME wait: after the list\'s 2-second wait has passed, an eligibility Try again limited for 30 seconds says its own wait, although the list\'s note still says the old one', async () => {
    const { server } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await click('drafts-show');
    await storesReady();
    fakeClock();
    server.retryAfter = '2';
    server.listStatus.push(429);
    server.eligStatus.push(503);
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await until(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited'));
    await until(() => expect(eligPhase()).toBe('unavailable'));
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent(pickerWaitText(2));
    await advance(2_000);
    await settle();
    server.retryAfter = '30';
    server.eligStatus.push(429);
    fireEvent.click(screen.getByTestId('drafts-elig-retry'));
    await until(() => expect(eligPhase()).toBe('rate-limited'));
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent(pickerWaitText(2)); // the list's old note, unchanged
    expect(screen.getByTestId('drafts-elig')).toHaveTextContent(pickerWaitText(30)); // the current wait, said
    expect(screen.getByTestId('drafts-elig-retry')).toBeDisabled();
  });

  it('SID-69. AC-15: the eligibility check has one owner — the section: a check out when the section unmounts is aborted and its answer changes nothing; under StrictMode\'s double setup a choice still sends ONE check and New works', async () => {
    const { server } = seeded();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await click('drafts-show');
    await storesReady();
    server.hold.elig = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    view.unmount();
    expect(server.eligReads()[0].signal?.aborted).toBe(true);
    const out = server.sent.length;
    await release(server);
    await settle();
    expect(server.sent.slice(out)).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    render(<StrictMode><ServerInvoiceDrafts {...r.props()} /></StrictMode>);
    await showAndChoose(STORE_2);
    expect(server.eligReads(STORE_2)).toHaveLength(1);
    expect(screen.getByTestId('drafts-new')).toBeEnabled();
  });
});

// M7B-INVOICES-P2 — the editor of a saved server draft (AC-16, AC-17 in jsdom). The fake server answers the edit eligibility
// from its per-role `editAllow` table and the PATCH like the server: fingerprinted over the store, the DRAFT and the exact
// bytes; a version other than the draft's is the sealed 409 write_conflict (a stale no-op too); the same customer and lines
// are the sealed 200 changed:false; a missing draft or customer is the chain's 404 (one answer); every sealed answer replays
// under its key. Cases labelled "jsdom-only callback ordering" release a held answer after the change they race; they show
// what the section does with a late answer, not what a browser schedules.
describe('Server drafts — editing a saved draft (M7B-INVOICES-P2)', () => {
  const release = async (server: Server, i = 0, late?: Response) => { const [held] = server.held.splice(i, 1); await act(async () => { held.release(late); }); };
  const editPhase = () => screen.queryByTestId('draft-view-edit-state')?.getAttribute('data-phase') ?? 'none';
  const fields = (name: 'description' | 'quantity' | 'price') => screen.getAllByTestId(`draft-edit-${name}`) as HTMLInputElement[];
  const working = () => fields('description').map((d, i) => [d.value, fields('quantity')[i].value, fields('price')[i].value]);
  const editBody = (tenant: string, version: number, customerId: string, lines: Array<[string, number, number]>) =>
    JSON.stringify({ expectedTenant: tenant, expectedVersion: version, customerId, lines: lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity, unitPriceCents })) });
  const savedNote = () => screen.queryByTestId('draft-view-saved');
  /** Open the listed draft at `index`, wait for its read and for the server's answer about Edit (and, with `named`, the customer's name). */
  async function openDraft(index = 0, named = true) {
    await user().click(within(rows()[index]).getByTestId('drafts-open'));
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toBeInTheDocument());
    await waitFor(() => expect(editPhase()).not.toBe('checking'));
    if (named) await waitFor(() => expect(screen.getByTestId('draft-view-customer')).not.toHaveTextContent('ID ending'));
  }
  async function openEditor(index = 0, named = true) {
    await openDraft(index, named);
    await click('draft-view-edit');
    await waitFor(() => expect(screen.getByTestId('draft-edit')).toBeInTheDocument());
  }
  /** A draft of uid-a's at Main Street: Item 1 and Item 2, one each at $2.50, for Ada; version 1. */
  async function ready(over: Partial<ServerInvoiceDraftsProps> = {}) {
    const { server, ada, bea } = seeded();
    const draft = server.seedDraft(STORE_1, ada, at(5), 250, 2);
    const r = rig(server);
    const props = r.props(over);
    const view = render(<ServerInvoiceDrafts {...props} />);
    await showAndChoose(STORE_1);
    return { server, ada, bea, draft, r, props, view };
  }
  async function pickCustomer(id: string) {
    await click('picker-change');
    await waitFor(() => expect(screen.getByTestId('picker-state')).toHaveAttribute('data-phase', 'ready'));
    const row = screen.getAllByTestId('picker-row').find((x) => x.getAttribute('data-id') === id)!;
    await user().click(within(row).getByTestId('picker-select'));
    await waitFor(() => expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', id));
  }

  it('SID-77. AC-16: Edit is offered ONLY on the server\'s own answer for exactly this draft, store and session — nothing (said as checking) until it answers; one edit-eligibility GET per open, carrying that session\'s token and nothing else; none at a read-only store; no PATCH', async () => {
    const { server, draft } = await ready();
    const ro = server.seedDraft(STORE_RO, draft.customerId, at(6));
    server.hold.editElig = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['editElig']));
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toHaveTextContent('1'));
    expect(editPhase()).toBe('checking');
    expect(screen.getByTestId('draft-view-edit-state')).toHaveTextContent(EDIT_ELIGIBILITY_TEXT.checking);
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    const asked = server.editEligReads();
    expect(asked.map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${editEligibilityPathOf(STORE_1, draft.id)}`]);
    expect(asked[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}/);
    expect([asked[0].headers.get('x-tmpos-csrf'), asked[0].headers.get('idempotency-key'), asked[0].body]).toEqual([null, null, undefined]);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-view-edit')).toBeEnabled());
    expect(screen.getByTestId('draft-view-edit-state')).toHaveTextContent('');
    await click('draft-view-close');
    await openDraft();
    expect(server.editEligReads()).toHaveLength(2); // each open asks again: never a last answer
    await click('draft-view-close');
    fireEvent.change(storeSelect(), { target: { value: STORE_RO } });
    await listReady();
    await openDraft(0);
    expect(screen.getByTestId('draft-view-version')).toHaveTextContent('1');
    expect(screen.queryByTestId('draft-view-edit-state')).toBeNull(); // a read-only store: nothing asked, nothing offered
    expect(server.editEligReads().filter((x) => x.url.includes(ro.id))).toEqual([]);
    expect(server.patches()).toEqual([]);
  });

  it('SID-78. AC-16: a role the server refuses (Invoices Create: it may save drafts, not edit them) gets no Edit — the 403 gets ONE fresh session check and stands; an outage is "unavailable" with a Try again (one GET per press) that offers Edit on the server\'s allowance; a 429 waits; nothing is ever sent as a PATCH', async () => {
    const { server } = await ready();
    server.users['tok-a'].role = 'sales';
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } }); // asked again under the Create-only role
    await listReady();
    await eligSettled();
    expect(eligPhase()).toBe('allowed'); // the creation eligibility allows this role at this store
    expect(server.eligReads(STORE_1).at(-1)!.headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}/);
    const before = server.sent.length;
    await openDraft();
    expect(editPhase()).toBe('denied');
    expect(screen.getByTestId('draft-view-edit-state')).toHaveTextContent(EDIT_ELIGIBILITY_TEXT.denied);
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    expect(screen.queryByTestId('draft-view-edit-retry')).toBeNull();
    const after = server.sent.slice(before).map((x) => x.url);
    expect(after.filter((u) => u === TENANT_SESSION_PATHS.current)).toHaveLength(3); // the reopen's, the eligibility's and its ONE fresh check
    expect(after.filter((u) => u.endsWith('/edit-eligibility'))).toHaveLength(1);
    await click('draft-view-close');
    server.users['tok-a'].role = 'owner';
    server.editEligStatus.push(503);
    await openDraft();
    expect(editPhase()).toBe('unavailable');
    expect(screen.getByTestId('draft-view-edit-state')).toHaveTextContent(EDIT_ELIGIBILITY_TEXT.unavailable);
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    const asked = server.editEligReads().length;
    await click('draft-view-edit-retry');
    await waitFor(() => expect(screen.getByTestId('draft-view-edit')).toBeEnabled());
    expect(server.editEligReads()).toHaveLength(asked + 1);
    await click('draft-view-close');
    server.retryAfter = '30';
    server.editEligStatus.push(429);
    await openDraft();
    expect(editPhase()).toBe('rate-limited');
    expect(screen.getByTestId('draft-view-edit-state')).toHaveTextContent(pickerWaitText(30));
    expect(screen.getByTestId('draft-view-edit-retry')).toBeDisabled();
    await click('draft-view-close');
    expect(server.patches()).toEqual([]);
  });

  it('SID-79. AC-17 (jsdom-only callback ordering): an edit-eligibility answer counts only for the draft, store and session that asked — released after the dialog moved to another draft, after a sign-out, or after a new generation, it offers nothing', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, props, draft } = await ready();
    const other = server.seedDraft(STORE_1, draft.customerId, at(9), 100, 1);
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    expect(rows().map((x) => x.getAttribute('data-id'))).toEqual([other.id, draft.id]);
    server.hold.editElig = 2;
    await user().click(within(rows()[1]).getByTestId('drafts-open')); // `draft`: its answer held
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['editElig']));
    await click('draft-view-close');
    await user().click(within(rows()[0]).getByTestId('drafts-open')); // `other`: its answer held too
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['editElig', 'editElig']));
    await release(server, 0); // the first draft's allowance arrives while the dialog shows the second
    await settle();
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    expect(editPhase()).toBe('checking');
    await release(server, 0, refusal(503, 'service_unavailable'));
    await waitFor(() => expect(editPhase()).toBe('unavailable'));
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    await click('draft-view-close');
    // A sign-out while the answer is out: the allowance, released after it began, offers nothing.
    server.hold.editElig = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['editElig']));
    await act(async () => { void props.session!.logout(); });
    await release(server);
    await settle();
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'signed-out');
    await click('draft-view-close');
    server.expire();
    await click('drafts-retry'); // Reconnect
    await showAndChoose(STORE_1);
    // A new generation (another tab's session, noticed on focus) while the answer is out: the dialog goes with it.
    server.hold.editElig = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['editElig']));
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    await release(server);
    await settle();
    expect(screen.queryByTestId('draft-view')).toBeNull();
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    expect(server.patches()).toEqual([]);
  });

  it('SID-80. AC-16: the editor is seeded from the detail just read (customer, ordered lines, version); lines are edited, added, removed and moved (focus stays with the moved line); ONE Save is ONE PATCH of the exact bytes under one key — duplicate presses send nothing, nothing says "Saved" before the 200 — then ONE read-back shows the new version and the list is read again', async () => {
    const { server, bea, draft, r } = await ready();
    await openEditor();
    const dialog = screen.getByTestId('draft-edit');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(screen.getByTestId('draft-edit-version')).toHaveTextContent('1');
    expect(screen.getByTestId('picker-value-name')).toHaveTextContent('Ada Customer');
    expect(working()).toEqual([['Item 1', '1', '2.50'], ['Item 2', '1', '2.50']]);
    expect(document.activeElement).toBe(fields('description')[0]);
    expect(screen.queryByTestId('draft-view')).toBeNull(); // one dialog at a time: the editor replaced the view
    fireEvent.change(fields('description')[0], { target: { value: 'Screen repair' } });
    fireEvent.change(fields('quantity')[0], { target: { value: '2' } });
    fireEvent.change(fields('price')[0], { target: { value: '20' } });
    await click('draft-edit-add-line');
    fireEvent.change(fields('description')[2], { target: { value: 'Cable' } });
    fireEvent.change(fields('quantity')[2], { target: { value: '3' } });
    fireEvent.change(fields('price')[2], { target: { value: '0.75' } });
    await user().click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(working()).toEqual([['Screen repair', '2', '20'], ['Cable', '3', '0.75']]);
    await user().click(screen.getByRole('button', { name: 'Move line 2 up' }));
    expect(working()).toEqual([['Cable', '3', '0.75'], ['Screen repair', '2', '20']]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move line 1 down' })); // the moved line's control: its Move up is now disabled
    expect(screen.getByRole('button', { name: 'Move line 1 up' })).toBeDisabled();
    expect(screen.getByTestId('draft-edit-moved')).toHaveTextContent('Line 2 moved to line 1.');
    expect(screen.getByLabelText('Line 2 quantity')).toBe(fields('quantity')[1]); // every field names its line
    expect(screen.getByLabelText('Line 2 unit price ($)')).toBe(fields('price')[1]);
    await pickCustomer(bea);
    expect(screen.getByTestId('draft-edit-subtotal-amount')).toHaveTextContent('$42.25');
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    expect(screen.getByTestId('draft-edit-save')).toBeDisabled();
    expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'sending');
    // The working copy is locked while its request is out: the screen keeps what was sent; closing now only stops tracking.
    for (const control of [fields('description')[0], fields('price')[1], screen.getByTestId('draft-edit-add-line'), screen.getByTestId('picker-change'), screen.getByRole('button', { name: 'Move line 1 down' })]) {
      expect(control).toBeDisabled();
    }
    expect(screen.getByTestId('draft-edit-cancel-hint')).toHaveTextContent(EDIT_TEXT.closeWarning);
    fireEvent.click(screen.getByTestId('draft-edit-save'));
    await settle();
    expect(document.body).not.toHaveTextContent(/Saved on the server/);
    const patches = server.patches();
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe(draftPathOf(STORE_1, draft.id));
    expect(patches[0].body).toBe(editBody(TENANT_A, 1, bea, [['Cable', 3, 75], ['Screen repair', 2, 2000]]));
    expect(patches[0].headers.get('idempotency-key')).toBe(r.keys[0]);
    expect(patches[0].headers.get('x-tmpos-csrf')).toBe('1');
    expect(patches[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}/);
    expect(r.keys).toHaveLength(1);
    const mark = server.sent.length;
    await release(server);
    await waitFor(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(2)));
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toHaveTextContent('2'));
    expect(screen.getAllByTestId('draft-view-line').map((x) => x.textContent)).toEqual(['1Cable3$0.75$2.25', '2Screen repair2$20.00$40.00']);
    await waitFor(() => expect(screen.getByTestId('draft-view-customer')).toHaveTextContent('Bea Customer'));
    await waitFor(() => expect(screen.getByTestId('draft-view-edit')).toBeEnabled()); // asked again for the new view
    expect(server.detailReads(STORE_1, draft.id).filter((x) => server.sent.indexOf(x) >= mark)).toHaveLength(1); // ONE read-back
    await waitFor(() => expect(within(rows()[0]).getByTestId('drafts-row-subtotal')).toHaveTextContent('$42.25'));
    expect(server.patches()).toHaveLength(1);
    expect([draft.version, draft.customerId, draft.subtotalCents]).toEqual([2, bea, 4225]);
  });

  it('SID-81. AC-16: a Save that changes nothing is the server\'s changed:false — "No changes were needed", the version unchanged, and the one read-back', async () => {
    const { server, draft } = await ready();
    await openEditor();
    await click('draft-edit-save');
    await waitFor(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.unchanged(1)));
    expect(savedNote()).not.toHaveTextContent(/Saved on the server/);
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toHaveTextContent('1'));
    expect(server.patches().map((x) => x.body)).toEqual([editBody(TENANT_A, 1, draft.customerId, [['Item 1', 1, 250], ['Item 2', 1, 250]])]);
    expect(draft.version).toBe(1);
  });

  it('SID-82. AC-16: a confirmed save whose read-back fails stays confirmed and says the current draft could not be read — nothing is sent again, and nothing reads on its own', async () => {
    const { server, draft } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[1], { target: { value: 'Fan' } });
    server.detailStatus.push(503); // the next draft read: the read-back
    await click('draft-edit-save');
    await waitFor(() => expect(savedNote()).toHaveTextContent(`${EDIT_TEXT.saved(2)} ${EDIT_TEXT.unread}`));
    expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'unavailable');
    const sent = server.sent.length;
    await settle();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(server.sent.slice(sent).filter((x) => x.method !== 'GET' || x.url !== TENANT_SESSION_PATHS.current)).toEqual([]);
    expect(server.patches()).toHaveLength(1);
    expect(draft.version).toBe(2);
  });

  it('SID-83. AC-17: a PATCH whose answer is lost after the server committed is UNRESOLVED — nothing is sent on a focus, a tab return or a reload of the section; only Check again re-sends, the SAME key and the SAME bytes to the same draft; its replayed answer confirms that attempt, and the read-back says honestly that the draft has changed again since', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada, draft, r, props, view } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Screen repair' } });
    server.updates.push('lose');
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    expect(screen.getByTestId('draft-edit-attempt')).toHaveTextContent(EDIT_TEXT.unresolved);
    expect(screen.getByTestId('draft-edit-attempt-note')).toHaveTextContent('No answer from the server.');
    expect(screen.getByTestId('draft-edit-save')).toBeDisabled();
    expect(screen.getByTestId('draft-edit-save')).toHaveAccessibleDescription(EDIT_TEXT.saveHeld);
    expect(draft.version).toBe(2); // committed on the server
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(server.patches()).toHaveLength(1);
    server.editDraft(draft, ada, [{ description: 'Elsewhere', quantity: 1, unitPriceCents: 100 }]); // another session edits it again: version 3
    await click('draft-edit-check-again');
    await waitFor(() => expect(savedNote()).toHaveTextContent(`${EDIT_TEXT.saved(2)} ${EDIT_TEXT.later(3)}`));
    const [first, again] = server.patches();
    expect([again.url, again.body, again.headers.get('idempotency-key')]).toEqual([first.url, first.body, first.headers.get('idempotency-key')]);
    expect(again.headers.get('x-tmpos-session-csrf')).toBe(first.headers.get('x-tmpos-session-csrf')); // the attempt's own session token
    expect(r.keys).toHaveLength(1);
    expect(screen.getByTestId('draft-view-version')).toHaveTextContent('3');
    // A reload of the section (unmount, mount) while another attempt is unresolved restores nothing and sends nothing.
    await click('draft-view-close');
    await openEditor();
    server.updates.push('lose');
    fireEvent.change(fields('description')[0], { target: { value: 'Other' } });
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    view.unmount();
    render(<ServerInvoiceDrafts {...props} />);
    await settle();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(server.patches()).toHaveLength(3);
  });

  it('SID-84. AC-17: a 503, a lost request and a Check again\'s 429 leave the attempt unresolved under the same key — the 429 holds Check again and Save back for its Retry-After (said why), sending nothing on its own; each Check again is ONE PATCH of the same bytes; past the 23-hour cutoff (the larger of monotonic and wall-clock elapsed) nothing is sent and the card says to look again', async () => {
    const { server, draft, r } = await ready();
    await openEditor();
    fireEvent.change(fields('quantity')[0], { target: { value: '4' } });
    server.updates.push(503, 'lose-before', 429);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt-note')).toHaveTextContent('The server answered, but not with a result.'));
    expect(draft.version).toBe(1);
    await click('draft-edit-check-again');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt-note')).toHaveTextContent('No answer from the server.'));
    fakeClock();
    server.retryAfter = '3';
    fireEvent.click(screen.getByTestId('draft-edit-check-again'));
    await until(() => expect(screen.getByTestId('draft-edit-attempt-note')).toHaveTextContent('Too many requests. Wait 3 seconds.'));
    expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved');
    expect(screen.getByTestId('draft-edit-check-again')).toBeDisabled();
    expect(screen.getByTestId('draft-edit-check-again')).toHaveAccessibleDescription(HOLD_TEXT.waiting);
    expect(screen.getByTestId('draft-edit-save')).toBeDisabled();
    const sent = server.sent.length;
    await advance(3_000);
    await settle();
    expect(screen.getByTestId('draft-edit-check-again')).toBeEnabled();
    expect(server.sent).toHaveLength(sent);
    vi.useRealTimers();
    expect(server.patches()).toHaveLength(3);
    expect(new Set(server.patches().map((x) => `${x.headers.get('idempotency-key')} ${x.headers.get('x-tmpos-session-csrf')} ${x.body}`)).size).toBe(1); // same key, token and bytes
    r.clock.wall += 23 * HOUR; // the wall clock alone passes the cutoff
    await click('draft-edit-check-again');
    await settle();
    expect(screen.getByTestId('draft-edit-attempt')).toHaveTextContent(EDIT_TEXT.tooOld);
    expect(screen.queryByTestId('draft-edit-check-again')).toBeNull();
    expect(server.patches()).toHaveLength(3);
    expect(r.keys).toHaveLength(1);
    expect(draft.version).toBe(1);
    // The monotonic arm alone: another attempt (the editor closed and opened again, the wall clock as it is now), then
    // ONLY the monotonic clock passes 23 hours.
    await click('draft-edit-cancel');
    await openEditor();
    fireEvent.change(fields('quantity')[0], { target: { value: '5' } });
    server.updates.push(503);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    expect(screen.getByTestId('draft-edit-check-again')).toBeEnabled();
    r.clock.mono += 23 * HOUR;
    await click('draft-edit-check-again');
    await settle();
    expect(screen.getByTestId('draft-edit-attempt')).toHaveTextContent(EDIT_TEXT.tooOld);
    expect(server.patches()).toHaveLength(4);
    expect(r.keys).toHaveLength(2);
  });

  it('SID-85. AC-16: a conflict (another session saved first) is never overwritten: the sealed 409 keeps the working copy, reads the server\'s draft afresh ONCE and shows both as text; Save waits for a decision; Reapply sends the same working copy under a NEW key at the version that read found', async () => {
    const { server, ada, draft, r } = await ready();
    await openEditor();
    server.editDraft(draft, ada, [{ description: 'Their line', quantity: 2, unitPriceCents: 500 }]); // version 2, elsewhere
    fireEvent.change(fields('description')[0], { target: { value: 'My line' } });
    const mark = server.sent.length;
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-conflict')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_TEXT.conflict);
    expect(screen.getByTestId('draft-edit-status')).toHaveAttribute('role', 'alert');
    expect(server.detailReads(STORE_1, draft.id).filter((x) => server.sent.indexOf(x) >= mark)).toHaveLength(1);
    const theirs = screen.getByTestId('draft-edit-server');
    expect(theirs).toHaveTextContent('On the server now (version 2)');
    expect(theirs).toHaveTextContent('Customer: Ada Customer');
    expect(theirs).toHaveTextContent('1. Their line — 2 × $5.00 = $10.00');
    expect(theirs).toHaveTextContent('Draft subtotal $10.00');
    const mine = screen.getByTestId('draft-edit-mine');
    expect(mine).toHaveTextContent('1. My line — 1 × $2.50 = $2.50');
    expect(mine).toHaveTextContent('2. Item 2 — 1 × $2.50 = $2.50');
    expect(working()).toEqual([['My line', '1', '2.50'], ['Item 2', '1', '2.50']]); // kept
    expect(screen.getByTestId('draft-edit-save')).toBeDisabled();
    expect(screen.getByTestId('draft-edit-save')).toHaveAccessibleDescription(EDIT_TEXT.saveConflict);
    await settle();
    expect(server.patches()).toHaveLength(1); // nothing on its own
    expect(draft.lines.map((l) => l.description)).toEqual(['Their line']);
    await click('draft-edit-reapply');
    await waitFor(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(3)));
    const [first, reapplied] = server.patches();
    expect(reapplied.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'));
    expect(r.keys).toHaveLength(2);
    expect(reapplied.body).toBe(editBody(TENANT_A, 2, ada, [['My line', 1, 250], ['Item 2', 1, 250]]));
    expect(first.body).toBe(editBody(TENANT_A, 1, ada, [['My line', 1, 250], ['Item 2', 1, 250]]));
    expect(draft.lines.map((l) => l.description)).toEqual(['My line', 'Item 2']);
  });

  it('SID-86. AC-16: "Discard my changes" is local only — no request; the editor then holds the server\'s current draft (its version, customer and lines) and a Save of it is the server\'s "no changes" at that version', async () => {
    const { server, bea, draft } = await ready();
    await openEditor();
    server.editDraft(draft, bea, [{ description: 'Their line', quantity: 1, unitPriceCents: 100 }]);
    fireEvent.change(fields('description')[0], { target: { value: 'My line' } });
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-conflict')).toHaveAttribute('data-phase', 'ready'));
    const sent = server.sent.length;
    await click('draft-edit-discard');
    expect(server.sent.slice(sent)).toEqual([]);
    expect(screen.queryByTestId('draft-edit-conflict')).toBeNull();
    expect(working()).toEqual([['Their line', '1', '1.00']]);
    expect(screen.getByTestId('draft-edit-version')).toHaveTextContent('2');
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bea);
    expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_TEXT.discarded(2));
    expect(screen.getByTestId('draft-edit-status')).toHaveAttribute('role', 'status');
    await click('draft-edit-save');
    await waitFor(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.unchanged(2)));
    expect(server.patches().at(-1)!.body).toBe(editBody(TENANT_A, 2, bea, [['Their line', 1, 100]]));
    expect(draft.version).toBe(2);
  });

  it('SID-87. AC-16: a draft gone from the server and a customer gone from the server get the SAME answer — "this draft, or its customer, is no longer available" — with the working copy kept and no conflict review', async () => {
    const { server, bea, draft } = await ready();
    await openEditor();
    await pickCustomer(bea);
    server.customers.delete(bea);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_TEXT.gone));
    const forCustomer = screen.getByTestId('draft-edit-status').textContent;
    expect(screen.queryByTestId('draft-edit-conflict')).toBeNull();
    expect(screen.queryByTestId('draft-edit-attempt')).toBeNull();
    expect(working()).toEqual([['Item 1', '1', '2.50'], ['Item 2', '1', '2.50']]);
    await click('draft-edit-cancel');
    await openEditor();
    server.drafts.splice(server.drafts.indexOf(draft), 1);
    fireEvent.change(fields('description')[0], { target: { value: 'Changed' } });
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_TEXT.gone));
    expect(screen.getByTestId('draft-edit-status').textContent).toBe(forCustomer);
    expect(server.patches()).toHaveLength(2);
  });

  it('SID-88. AC-17: a PATCH refused 403 gets ONE fresh session check, then says the account may not edit (nothing re-sent); a 429 holds Save back for its Retry-After (said why) and sends nothing on its own; a 401 ends the session — the editor and its working copy go, and only Reconnect signs in', async () => {
    const { server } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Secret line' } });
    server.editAllow.owner = false; // the owner lowered the level meanwhile
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_REFUSED_TEXT.denied));
    const patch = server.sent.indexOf(server.patches()[0]);
    expect(server.sent.slice(patch + 1).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    server.editAllow.owner = true;
    fakeClock();
    server.retryAfter = '3';
    server.updates.push(429);
    fireEvent.click(screen.getByTestId('draft-edit-save'));
    await until(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_REFUSED_TEXT['rate-limited']));
    expect(screen.getByTestId('draft-edit-save')).toBeDisabled();
    expect(screen.getByTestId('draft-edit-save')).toHaveAccessibleDescription(EDIT_TEXT.saveWaiting);
    const sent = server.sent.length;
    await advance(3_000);
    await settle();
    expect(screen.getByTestId('draft-edit-save')).toBeEnabled();
    expect(server.sent).toHaveLength(sent);
    vi.useRealTimers();
    server.updates.push(401);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.queryByTestId('draft-edit')).toBeNull());
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(document.body).not.toHaveTextContent('Secret line');
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    expect(server.patches()).toHaveLength(3);
  });

  it.each(['the sign-out first, then the PATCH\'s answer', 'the PATCH\'s answer first, then the sign-out during its read-back'] as const)('SID-89. AC-17 (jsdom-only callback ordering): a sign-out while an edit is out — %s: the editor, its working copy and customer go at once; the late answer (the server DID commit) shows nothing — no "Saved", no draft, no read-back after the sign-out; only Reconnect reads again, and nothing of the old editor comes back', async (order) => {
    const { server, props, bea, draft } = await ready();
    await openEditor();
    await pickCustomer(bea);
    fireEvent.change(fields('description')[0], { target: { value: 'Secret line' } });
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    if (order === 'the PATCH\'s answer first, then the sign-out during its read-back') {
      server.hold.get = 1;
      await release(server);
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['get']));
      expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(2));
    }
    const mark = server.sent.length;
    let during: HTMLElement | null | undefined;
    // Sampled inside the sign-out call itself, before anything else runs: the editor is already gone (committed by its
    // own listener, not on a later render).
    await act(async () => { void props.session!.logout(); during = screen.queryByTestId('draft-edit'); });
    expect(during).toBeNull();
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(document.body).not.toHaveTextContent('Secret line');
    expect(document.body).not.toHaveTextContent('Bea Customer');
    await release(server);
    await settle();
    expect(draft.version).toBe(2); // the server committed it under the old attempt
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(savedNote()).toBeNull();
    expect(screen.queryAllByTestId('draft-view-line')).toEqual([]);
    expect(document.body).not.toHaveTextContent('Secret line');
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    if (screen.queryByTestId('draft-view') !== null) await click('draft-view-close');
    server.expire();
    await click('drafts-retry'); // Reconnect
    await showAndChoose(STORE_1);
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(screen.queryByTestId('draft-view')).toBeNull();
    expect(server.patches()).toHaveLength(1);
  });

  it('SID-90. AC-17 (jsdom-only callback ordering): a Save whose session check answered just before a sign-out began sends nothing — no key, no PATCH; the editor is gone', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5), 250, 2);
    const r = rig(server);
    const real = r.props().session!;
    let trip = false;
    let mark = -1;
    const session: TenantSessionClient = { ...real, ensure: async (...args) => { const s = await real.ensure(...args); if (trip) { trip = false; mark = server.sent.length; void real.logout(); } return s; } };
    render(<ServerInvoiceDrafts {...r.props({ session })} />);
    await showAndChoose(STORE_1);
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Changed' } });
    trip = true;
    await click('draft-edit-save');
    await waitFor(() => expect(trip).toBe(false));
    await settle();
    expect(server.patches()).toEqual([]);
    expect(r.keys).toEqual([]);
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(screen.queryByTestId('draft-edit')).toBeNull();
  });

  it('SID-91. AC-17 (jsdom-only callback ordering): another user, or another session of the same user, never receives an old editor\'s result — a PATCH answered after a user switch or after a new generation (another tab\'s session, noticed on focus) shows nothing and reads nothing', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, r, view, draft } = await ready();
    server.stores['uid-b'] = [store(STORE_2, 'B Store', false, TENANT_B)];
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Secret line' } });
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-b' })} />);
    const out = server.sent.length;
    await release(server);
    await settle();
    expect(server.sent.slice(out)).toEqual([]);
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(screen.queryByTestId('draft-view')).toBeNull();
    expect(document.body).not.toHaveTextContent('Secret line');
    expect(draft.version).toBe(2);
    view.rerender(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Other line' } });
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    const later = server.sent.length;
    await release(server);
    await settle();
    expect(server.sent.slice(later)).toEqual([]);
    expect(savedNote()).toBeNull();
    expect(screen.queryByTestId('draft-view')).toBeNull();
    expect(document.body).not.toHaveTextContent('Other line');
  });

  it('SID-92. AC-16: dialog focus — Edit puts focus on the first line; Remove and the moves keep it with the lines; a Save disabled by its own press keeps focus inside (not <body>); Cancel and Escape drop the local changes only (nothing sent, the server\'s draft unchanged) and return focus to the draft\'s Open', async () => {
    const { server, draft } = await ready();
    await openEditor();
    expect(document.activeElement).toBe(fields('description')[0]);
    fireEvent.change(fields('description')[0], { target: { value: 'Local only' } });
    const sent = server.sent.length;
    await click('draft-edit-cancel');
    await settle();
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(document.activeElement).toBe(within(rows()[0]).getByTestId('drafts-open'));
    expect(server.sent.slice(sent)).toEqual([]);
    expect(draft.lines[0].description).toBe('Item 1');
    await openEditor();
    expect(working()[0]).toEqual(['Item 1', '1', '2.50']); // the local change went with the editor
    await click('draft-edit-add-line');
    fireEvent.change(fields('description')[2], { target: { value: 'Cable' } });
    fireEvent.change(fields('price')[2], { target: { value: '1' } });
    await user().click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(working().map((line) => line[0])).toEqual(['Item 1', 'Cable']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove line 2' })); // the next line's, now line 2
    await user().click(screen.getByRole('button', { name: 'Move line 2 up' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move line 1 down' }));
    await user().click(screen.getByRole('button', { name: 'Move line 1 down' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move line 2 up' }));
    fireEvent.change(fields('description')[0], { target: { value: 'Changed' } });
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    await settle();
    expect(screen.getByTestId('draft-edit-save')).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByTestId('draft-edit').contains(document.activeElement)).toBe(true);
    await release(server);
    await waitFor(() => expect(savedNote()).toBeInTheDocument());
    await settle();
    expect(screen.getByTestId('draft-view').contains(document.activeElement)).toBe(true); // the view that replaced it holds focus
    await click('draft-view-close');
    await settle();
    await openEditor();
    await user().keyboard('{Escape}');
    await settle();
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(document.activeElement).toBe(within(rows()[0]).getByTestId('drafts-open'));
    expect(server.patches()).toHaveLength(1);
  });

  it('SID-93. AC-16: Invoices Edit without the local Customers View hint still edits the lines, keeping the draft\'s own customer — shown by its ID ending, sent as it is; no customer is read', async () => {
    const { server, ada, draft } = await ready({ canViewCustomers: false });
    await openEditor(0, false);
    expect(screen.getByTestId('picker-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('draft-edit-customer-kept')).toHaveTextContent(EDIT_TEXT.kept(customerFallbackText(ada)));
    fireEvent.change(fields('price')[1], { target: { value: '3' } });
    await click('draft-edit-save');
    await waitFor(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(2)));
    expect(server.patches()[0].body).toBe(editBody(TENANT_A, 1, ada, [['Item 1', 1, 250], ['Item 2', 1, 300]]));
    expect(server.sent.filter((x) => x.url.startsWith(CUSTOMERS_PATH))).toEqual([]);
    expect(draft.customerId).toBe(ada);
  });

  it('SID-94. AC-17 (jsdom-only callback ordering): an editor closed while its PATCH is out holds nothing back — the next editor\'s Save sends at once under its own key; the closed one\'s late answer changes nothing (no "Saved" for it, no read-back)', async () => {
    const { server, draft, r } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'First editor' } });
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    expect(screen.getByTestId('draft-edit-cancel-hint')).toHaveTextContent(EDIT_TEXT.closeWarning);
    await click('draft-edit-cancel'); // stops tracking it: the server decided it already (version 2)
    await openEditor();
    expect(screen.getByTestId('draft-edit-version')).toHaveTextContent('2');
    fireEvent.change(fields('description')[0], { target: { value: 'Second editor' } });
    await click('draft-edit-save');
    await waitFor(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(3)));
    await waitFor(() => expect(screen.getByTestId('draft-view-edit')).toBeEnabled()); // its read-back and the next Edit answer done
    await listReady(); // and the list read again after the change
    await settle();
    const patches = server.patches();
    expect(patches).toHaveLength(2);
    expect(patches[1].headers.get('idempotency-key')).not.toBe(patches[0].headers.get('idempotency-key'));
    expect(r.keys).toHaveLength(2);
    const sent = server.sent.length;
    await release(server); // the first editor's 200 (version 2), late
    await settle();
    expect(server.sent.slice(sent)).toEqual([]);
    expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(3));
    expect(screen.getByTestId('draft-view-version')).toHaveTextContent('3');
    expect(draft.lines[0].description).toBe('Second editor');
  });

  it('SID-95. AC-16: a conflict\'s fresh read refused 403 gets the reads\' ONE fresh session check, then says so with a Try again (nothing re-sent); Try again reads the draft again and the review proceeds', async () => {
    const { server, ada, draft } = await ready();
    await openEditor();
    server.editDraft(draft, ada, [{ description: 'Their line', quantity: 1, unitPriceCents: 100 }]);
    fireEvent.change(fields('description')[0], { target: { value: 'My line' } });
    server.detailStatus.push(403);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-conflict')).toHaveAttribute('data-phase', 'failed'));
    expect(screen.getByTestId('draft-edit-conflict-state')).toHaveTextContent(DRAFTS_TEXT.draftDenied);
    const read = server.detailReads(STORE_1, draft.id).at(-1)!;
    expect(server.sent.slice(server.sent.indexOf(read) + 1).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(screen.queryByTestId('draft-edit-reapply')).toBeNull();
    await click('draft-edit-read-again');
    await waitFor(() => expect(screen.getByTestId('draft-edit-conflict')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('draft-edit-server')).toHaveTextContent('Their line');
    expect(server.patches()).toHaveLength(1);
  });
  it('SID-96. AC-17: a PATCH refused 403 is a refusal of access ONLY when its one fresh session check confirms the same session — a check that cannot answer says so (never "may not edit"), and a check refused 429 starts the wait (Save held back, said why); a Check again\'s 403 leaves the attempt unresolved with that check\'s own note', async () => {
    const { server } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Changed' } });
    // A first send refused 403 whose fresh check cannot answer (503): refused, but no word about access.
    server.editAllow.owner = false;
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    server.currentStatus.push(503); // the fresh check after the 403
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_TEXT.refusedUnchecked));
    expect(screen.getByTestId('draft-edit-status')).not.toHaveTextContent(EDIT_REFUSED_TEXT.denied);
    expect(screen.queryByTestId('draft-edit-attempt')).toBeNull(); // the chain refused it before anything ran
    // A Check again's 403: unresolved — the same session confirmed ("The server refused this check."), then a check that cannot answer.
    server.editAllow.owner = true;
    server.updates.push(503);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    server.editAllow.owner = false;
    await click('draft-edit-check-again');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt-note')).toHaveTextContent('The server refused this check.'));
    expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved');
    server.hold.update = 1;
    await click('draft-edit-check-again');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    server.currentStatus.push(503);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt-note')).toHaveTextContent(EDIT_TEXT.checkUnchecked));
    expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved');
    expect(screen.getByTestId('draft-edit-check-again')).toBeEnabled();
    // A first send refused 403 whose fresh check is rate-limited: the wait starts, Save is held back through it.
    await click('draft-edit-cancel');
    server.editAllow.owner = true;
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Changed again' } });
    server.editAllow.owner = false;
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    server.retryAfter = '30';
    server.currentStatus.push(429);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_REFUSED_TEXT['rate-limited']));
    expect(screen.getByTestId('draft-edit-save')).toBeDisabled();
    expect(screen.getByTestId('draft-edit-save')).toHaveAccessibleDescription(EDIT_TEXT.saveWaiting);
    expect(server.patches()).toHaveLength(5);
  });

  it('SID-97. AC-16: a read refused 403 gets the reads\' one fresh session check — a save\'s read-back keeps its confirmed result and says denied only for the same session; the view-only reopen and the conflict\'s read, whose check cannot answer, say "unavailable", never a refusal', async () => {
    const { server, ada, draft } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Read back refused' } });
    server.detailStatus.push(403); // the read-back
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'denied'));
    expect(savedNote()).toHaveTextContent(`${EDIT_TEXT.saved(2)} ${EDIT_TEXT.unread}`); // the confirmed save stands
    const readBack = server.detailReads(STORE_1, draft.id).at(-1)!;
    expect(server.sent.slice(server.sent.indexOf(readBack) + 1).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.patches()).toHaveLength(1);
    await click('draft-view-close');
    // The view-only reopen shares that read: its 403 whose check cannot answer is unavailable now (was: denied at once).
    server.hold.get = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['get']));
    server.detailStatus.push(403);
    server.currentStatus.push(503);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'unavailable'));
    expect(screen.getByTestId('draft-view-state')).toHaveTextContent(DRAFTS_TEXT.unavailable);
    await click('draft-view-close');
    // The conflict's read refused 403, its check unable to answer: unavailable, with Try again.
    await openEditor();
    server.editDraft(draft, ada, [{ description: 'Their line', quantity: 1, unitPriceCents: 100 }]);
    fireEvent.change(fields('description')[0], { target: { value: 'My line' } });
    server.hold.get = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['get']));
    server.detailStatus.push(403);
    server.currentStatus.push(503);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-edit-conflict')).toHaveAttribute('data-phase', 'failed'));
    expect(screen.getByTestId('draft-edit-conflict-state')).toHaveTextContent(DRAFTS_TEXT.unavailable);
    expect(screen.getByTestId('draft-edit-read-again')).toBeEnabled();
  });

  it('SID-98. AC-17 (jsdom-only callback ordering): a rate limit\'s wait that begins while Save\'s session check is out sends nothing — no key, no PATCH — and says so', async () => {
    const { server, r } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Changed' } });
    // A list read behind the dialog (the store chosen again; jsdom does not enforce inert), its answer held.
    server.hold.list = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list']));
    server.hold.current = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list', 'current']));
    await release(server, 0, refusal(429, 'rate_limited')); // the list's 429 starts the wait while Save's session check is out
    await waitFor(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited'));
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(/^Not sent\. Too many requests\./));
    expect(server.patches()).toEqual([]);
    expect(r.keys).toEqual([]);
    expect(screen.queryByTestId('draft-edit-attempt')).toBeNull();
  });

  it('SID-99. AC-17 (jsdom-only callback ordering): a rate limit\'s wait that begins while Check again\'s session check is out sends nothing — the attempt stays unresolved with the wait said', async () => {
    const { server, r } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Changed' } });
    server.updates.push(503);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    server.hold.list = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list']));
    server.hold.current = 1;
    await click('draft-edit-check-again');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list', 'current']));
    await release(server, 0, refusal(429, 'rate_limited'));
    await waitFor(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited'));
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt-note')).toHaveTextContent(/^Not checked\. Too many requests\./));
    expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved');
    expect(screen.getByTestId('draft-edit-check-again')).toBeDisabled();
    expect(server.patches()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-100. AC-16: a draft at the largest version the server records (2^53-1) cannot be saved again — Save is disabled and says why (visible and as its description); nothing is sent', async () => {
    const { server, draft } = await ready();
    draft.version = Number.MAX_SAFE_INTEGER;
    await openEditor();
    expect(screen.getByTestId('draft-edit-version')).toHaveTextContent(String(Number.MAX_SAFE_INTEGER));
    fireEvent.change(fields('description')[0], { target: { value: 'Changed' } });
    expect(screen.getByTestId('draft-edit-save')).toBeDisabled();
    expect(screen.getByTestId('draft-edit-save')).toHaveAccessibleDescription(EDIT_TEXT.saveLast);
    expect(screen.getByTestId('draft-edit-save-last')).toHaveTextContent(EDIT_TEXT.saveLast);
    fireEvent.click(screen.getByTestId('draft-edit-save'));
    await settle();
    expect(server.patches()).toEqual([]);
  });

  it('SID-101. AC-17: Check again uses the attempt\'s OWN session token — a store change keeps its own store, draft and token; after a token rotation (another tab\'s session, found by the check itself) or a session renewal (the session ended, then Reconnect) it sends nothing and the editor is gone', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, draft } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Store change' } });
    server.updates.push(503);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } }); // behind the dialog (jsdom does not enforce inert)
    await listReady();
    await click('draft-edit-check-again');
    await waitFor(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(2)));
    const [first, again] = server.patches();
    expect([again.url, again.headers.get('idempotency-key'), again.headers.get('x-tmpos-session-csrf'), again.body])
      .toEqual([draftPathOf(STORE_1, draft.id), first.headers.get('idempotency-key'), first.headers.get('x-tmpos-session-csrf'), first.body]);
    await click('draft-view-close');
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    // A token rotation: another tab's session is what Check again's own session check finds.
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Rotation' } });
    server.updates.push(503);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    server.otherTab('uid-a');
    await click('draft-edit-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(server.patches()).toHaveLength(3);
    // A session renewal: the session is over when Check again asks, and the user's Reconnect makes a new one.
    await showAndChoose(STORE_1);
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Renewal' } });
    server.updates.push(503);
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    server.expire();
    await click('draft-edit-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    await click('drafts-retry'); // Reconnect: a new session
    await showAndChoose(STORE_1);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(screen.queryByTestId('draft-edit')).toBeNull();
    expect(screen.queryByTestId('draft-edit-attempt')).toBeNull();
    expect(server.patches()).toHaveLength(4); // the three first sends and the one Check again before the store change's answer
  });

  it('SID-102. AC-16: while a save is out, Tab and Shift+Tab stay inside the editor — the locked working copy (a disabled fieldset) holds no stop, so the wrap lands on an enabled control', async () => {
    const { server } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Changed' } });
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    await settle();
    const dialog = screen.getByTestId('draft-edit');
    const cancel = screen.getByTestId('draft-edit-cancel');
    const enabled = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea')].filter((el) => !el.matches(':disabled'));
    expect(enabled).toEqual([cancel]); // Save, the fields, Add line, the moves and Change are all off
    act(() => { cancel.focus(); });
    const tab = createEvent.keyDown(cancel, { key: 'Tab' });
    fireEvent(cancel, tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    const back = createEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    fireEvent(cancel, back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    await release(server);
    await waitFor(() => expect(savedNote()).toBeInTheDocument());
  });

  it('SID-103. AC-16: adding the 50th line (which disables Add line under the press) puts focus on that new line\'s description, never back on line 1', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5), 100, 49);
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await openEditor();
    expect(fields('description')).toHaveLength(49);
    const add = screen.getByTestId('draft-edit-add-line');
    await user().click(add);
    expect(fields('description')).toHaveLength(50);
    expect(add).toBeDisabled();
    expect(document.activeElement).toBe(fields('description')[49]);
    expect(document.activeElement).toHaveAccessibleName('Line 50 description');
  });

  it('SID-104. AC-16: during a rate limit\'s wait the conflict\'s Try again and Reapply are disabled and say why; they come back once it has passed', async () => {
    const { server, ada, draft } = await ready();
    await openEditor();
    server.editDraft(draft, ada, [{ description: 'Their line', quantity: 1, unitPriceCents: 100 }]);
    fireEvent.change(fields('description')[0], { target: { value: 'My line' } });
    server.detailStatus.push(503); // the conflict's read fails: Try again
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-conflict')).toHaveAttribute('data-phase', 'failed'));
    fakeClock();
    server.retryAfter = '5';
    server.listStatus.push(429);
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } }); // a list read behind the dialog starts the wait
    await until(() => expect(screen.getByTestId('draft-edit-read-again')).toBeDisabled());
    expect(screen.getByTestId('draft-edit-read-again')).toHaveAccessibleDescription(EDIT_TEXT.readWaiting);
    await advance(5_000);
    await settle();
    expect(screen.getByTestId('draft-edit-read-again')).toBeEnabled();
    fireEvent.click(screen.getByTestId('draft-edit-read-again'));
    await until(() => expect(screen.getByTestId('draft-edit-conflict')).toHaveAttribute('data-phase', 'ready'));
    server.listStatus.push(429);
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await until(() => expect(screen.getByTestId('draft-edit-reapply')).toBeDisabled());
    expect(screen.getByTestId('draft-edit-reapply')).toHaveAccessibleDescription(EDIT_TEXT.reapplyWaiting);
    await advance(5_000);
    await settle();
    expect(screen.getByTestId('draft-edit-reapply')).toBeEnabled();
    expect(server.patches()).toHaveLength(1);
  });

  it('SID-105. AC-17: a Check again answered by the sealed 409 write_conflict goes to the conflict review (working copy kept, the server\'s draft read); one answered 404 gives the one "no longer available" text and ends the attempt', async () => {
    const { server, ada, draft } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Mine' } });
    server.updates.push('lose-before'); // never reached the server
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    server.editDraft(draft, ada, [{ description: 'Theirs', quantity: 1, unitPriceCents: 100 }]); // version 2, elsewhere
    await click('draft-edit-check-again');
    await waitFor(() => expect(screen.getByTestId('draft-edit-conflict')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_TEXT.conflict);
    expect(screen.queryByTestId('draft-edit-attempt')).toBeNull();
    expect(working()[0][0]).toBe('Mine');
    expect(screen.getByTestId('draft-edit-server')).toHaveTextContent('Theirs');
    const [first, check] = server.patches();
    expect(check.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'));
    await click('draft-edit-discard');
    fireEvent.change(fields('description')[0], { target: { value: 'Again' } });
    server.updates.push('lose-before');
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    server.drafts.splice(server.drafts.indexOf(draft), 1);
    await click('draft-edit-check-again');
    await waitFor(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_TEXT.gone));
    expect(screen.queryByTestId('draft-edit-attempt')).toBeNull();
    expect(server.patches()).toHaveLength(4);
  });

  it('SID-106. AC-17: closing the editor while its attempt is unresolved says first that it only stops tracking (the server may have saved it) and sends nothing; opened again, the editor holds the server\'s draft and a fresh attempt that never presents itself as recovery', async () => {
    const { server, r } = await ready();
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Lost answer' } });
    server.updates.push('lose'); // committed, its answer lost
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-attempt')).toHaveAttribute('data-state', 'unresolved'));
    expect(screen.getByTestId('draft-edit-cancel-hint')).toHaveTextContent(EDIT_TEXT.closeWarning);
    expect(screen.getByTestId('draft-edit-cancel')).toHaveAccessibleDescription(EDIT_TEXT.closeWarning);
    const sent = server.sent.length;
    await click('draft-edit-cancel');
    await settle();
    expect(server.sent.slice(sent)).toEqual([]);
    await openEditor();
    expect(screen.getByTestId('draft-edit-version')).toHaveTextContent('2'); // the lost edit committed
    expect(working()[0][0]).toBe('Lost answer');
    expect(screen.queryByTestId('draft-edit-attempt')).toBeNull();
    expect(screen.queryByTestId('draft-edit-check-again')).toBeNull();
    expect(document.body).not.toHaveTextContent(/Not confirmed yet/);
    expect(screen.getByTestId('draft-edit-cancel-hint')).toHaveTextContent(EDIT_TEXT.cancelHint);
    fireEvent.change(fields('description')[0], { target: { value: 'Fresh' } });
    await click('draft-edit-save');
    await waitFor(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(3)));
    const [lost, fresh] = server.patches();
    expect(fresh.headers.get('idempotency-key')).not.toBe(lost.headers.get('idempotency-key'));
    expect(JSON.parse(fresh.body!).expectedVersion).toBe(2);
    expect(r.keys).toHaveLength(2);
  });

  it('SID-107. AC-17: an edit eligibility answered 401 ends the session as any read\'s does — the stores say so, the view holds no draft and offers no Edit, and only Reconnect signs in', async () => {
    const { server } = await ready();
    server.editEligStatus.push(401);
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.getByTestId('drafts-stores-state')).toHaveTextContent(DRAFTS_TEXT.ended);
    expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    expect(screen.queryAllByTestId('draft-view-line')).toEqual([]);
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    expect(server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login)).toHaveLength(1); // only the first sign-in
  });

  /** Save refused 403 (Invoices Edit withdrawn), its one fresh session check held, then the editor closed by Cancel. */
  async function refusedThenClosed(server: Server, rotate = false) {
    await openEditor();
    fireEvent.change(fields('description')[0], { target: { value: 'Closed while checked' } });
    server.editAllow.owner = false;
    server.hold.update = 1;
    await click('draft-edit-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['update']));
    if (rotate) server.otherTab('uid-a'); // the fresh check will find another tab's session (a new token)
    server.hold.current = 1;
    await release(server); // the PATCH's 403: its fresh check goes out and waits here
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
    await click('draft-edit-cancel');
    await waitFor(() => expect(screen.queryByTestId('draft-edit')).toBeNull());
    server.editAllow.owner = true;
  }

  it('SID-108. AC-17 (jsdom-only callback ordering): a PATCH 403\'s fresh session check answered 401 after the editor closed still ends the session — the stores say so, only Reconnect signs in, and nothing more is sent', async () => {
    const { server } = await ready();
    await refusedThenClosed(server);
    const sent = server.sent.length;
    await release(server, 0, refusal(401, 'unauthenticated'));
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.getByTestId('drafts-stores-state')).toHaveTextContent(DRAFTS_TEXT.ended);
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    expect(rows()).toEqual([]);
    await settle();
    expect(server.sent.slice(sent)).toEqual([]);
    expect(server.patches()).toHaveLength(1);
  });

  it('SID-109. AC-17 (jsdom-only callback ordering): a PATCH 403\'s fresh session check answered 429 after the editor closed still starts the wait — reopened, the draft offers no Edit and says why (no edit eligibility asked, no PATCH) until Retry-After has passed; then Edit and Save work', async () => {
    const { server } = await ready();
    await refusedThenClosed(server);
    fakeClock();
    await release(server, 0, new Response(JSON.stringify({ error: 'rate_limited', requestId: 'req-synthetic' }), {
      status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' },
    }));
    await settle();
    fireEvent.click(within(rows()[0]).getByTestId('drafts-open'));
    await until(() => expect(editPhase()).toBe('rate-limited'));
    expect(screen.getByTestId('draft-view-edit-state')).toHaveTextContent(/^Too many requests\./);
    expect(screen.queryByTestId('draft-view-edit')).toBeNull();
    expect(server.editEligReads()).toHaveLength(1); // the first open's: none asked during the wait
    fireEvent.click(screen.getByTestId('draft-view-close'));
    await advance(30_000);
    await settle();
    fireEvent.click(within(rows()[0]).getByTestId('drafts-open'));
    await until(() => expect(editPhase()).toBe('allowed'));
    fireEvent.click(screen.getByTestId('draft-view-edit'));
    await until(() => expect(screen.getByTestId('draft-edit-save')).toBeEnabled());
    fireEvent.change(fields('description')[0], { target: { value: 'After the wait' } });
    fireEvent.click(screen.getByTestId('draft-edit-save'));
    await until(() => expect(savedNote()).toHaveTextContent(EDIT_TEXT.saved(2)));
    expect(server.patches()).toHaveLength(2); // the refused one and this one
  });

  it('SID-110. AC-17 (jsdom-only callback ordering, regression guard): a PATCH 403\'s fresh session check that finds ANOTHER token after the editor closed is a new generation as before — no session end, no wait; the stores are read again under the new token', async () => {
    const { server } = await ready();
    await refusedThenClosed(server, true);
    const [refused] = server.patches();
    const sent = server.sent.length;
    await release(server);
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    await storesReady();
    const reread = server.sent.slice(sent).filter((x) => x.method === 'GET' && x.url === STORES_PATH);
    expect(reread).toHaveLength(1);
    expect(reread[0].headers.get('x-tmpos-session-csrf')).not.toBe(refused.headers.get('x-tmpos-session-csrf'));
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady(); // no wait holds the list back
    await eligSettled();
    expect(eligPhase()).toBe('allowed');
    expect(screen.queryByTestId('drafts-retry')).toBeNull();
    expect(server.patches()).toHaveLength(1);
  });

  it('SID-111. AC-16: two moves in a row that say the same words still change the live region, so the second is announced too', async () => {
    await ready();
    await openEditor();
    await click('draft-edit-add-line');
    fireEvent.change(fields('description')[2], { target: { value: 'Item 3' } });
    const said = () => screen.getByTestId('draft-edit-moved').textContent ?? '';
    await user().click(screen.getByRole('button', { name: 'Move line 3 up' }));
    const first = said();
    expect(first).toBe('Line 3 moved to line 2.');
    expect(working().map(([d]) => d)).toEqual(['Item 1', 'Item 3', 'Item 2']);
    await user().click(screen.getByRole('button', { name: 'Move line 3 up' })); // now Item 2, from line 3 to line 2
    const second = said();
    expect(working().map(([d]) => d)).toEqual(['Item 1', 'Item 2', 'Item 3']);
    expect(second).not.toBe(first);
    expect(second.replace(/\u00a0/g, ' ').trim()).toBe(first); // the same words
    await user().click(screen.getByRole('button', { name: 'Move line 3 up' }));
    expect(said()).not.toBe(second);
    expect(said().trim()).toBe(first);
  });

  // M7B-INVOICES-P1-R3 (SDB-05, AC-15): the two orderings of an edit-eligibility read and a sign-out, told apart by the
  // fake's record of what the page INITIATED (server.sent, pushed at the fetch call: its index is the initiation order).
  /** What the page initiated from `from` on, as method and path (the fake's ids are synthetic). */
  const sentFrom = (server: Server, from: number) => server.sent.slice(from).map((x) => `${x.method} ${x.url}`);
  /** Nothing of the old user's draft or eligibility is shown: no Edit, editor, line, customer or line text; the view and stores say signed out. */
  const signedOutView = () => ({
    edit: screen.queryByTestId('draft-view-edit') !== null, editor: screen.queryByTestId('draft-edit') !== null,
    editState: screen.queryByTestId('draft-view-edit-state') !== null, lines: screen.queryAllByTestId('draft-view-line').length, rows: rows().length,
    view: screen.getByTestId('draft-view-state').getAttribute('data-phase'), stores: screen.getByTestId('drafts-stores-state').getAttribute('data-phase'),
    reconnect: screen.getByTestId('drafts-retry').textContent, shown: ['Item 1', 'Ada Customer'].filter((t) => document.body.textContent?.includes(t)),
  });
  const SIGNED_OUT_VIEW = { edit: false, editor: false, editState: false, lines: 0, rows: 0, view: 'signed-out', stores: 'signed-out', reconnect: 'Reconnect', shown: [] };

  it.each(['the session read held across the sign-out, then answered', 'the session read answered just before the sign-out began'] as const)('SID-112. AC-15 (sign-out BEFORE initiation; jsdom-only callback ordering): a sign-out that begins before the edit-eligibility read is initiated — %s — leaves the old context initiating nothing but the logout: no edit-eligibility GET, retry, session read, sign-in, PATCH or POST; the view is signed out with no lines, Edit or editor; a focus then sends nothing', async (order) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5), 250, 2);
    const r = rig(server);
    const real = r.props().session!;
    let trip = false;
    let mark = -1;
    // Armed only for the edit-eligibility read's connect: its session answers ok, and the sign-out begins before it continues.
    const session: TenantSessionClient = { ...real, ensure: async (...args) => { const s = await real.ensure(...args); if (trip) { trip = false; mark = server.sent.length; void real.logout(); } return s; } };
    render(<ServerInvoiceDrafts {...r.props({ session })} />);
    await showAndChoose(STORE_1);
    server.hold.get = 1; // the reopen's detail read: the edit-eligibility read is asked only once it has answered
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['get']));
    const logins = server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login).length;
    let connect: Sent | null = null;
    if (order === 'the session read held across the sign-out, then answered') {
      server.hold.current = 1; // the NEXT session read: the edit-eligibility read's own connect
      await release(server);
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
      expect(editPhase()).toBe('checking'); // that read is out, its GET not yet initiated
      connect = server.sent.at(-1)!;
      expect(`${connect.method} ${connect.url}`).toBe(`GET ${TENANT_SESSION_PATHS.current}`);
      mark = server.sent.length;
      await act(async () => { void real.logout(); });
      expect(connect.signal?.aborted).toBe(true); // the session client cancelled it at the sign-out
      await release(server); // A's session, answered after the sign-out began
    } else {
      trip = true;
      await release(server);
      await waitFor(() => expect(trip).toBe(false));
    }
    await settle();
    expect(mark).toBeGreaterThan(0);
    expect(sentFrom(server, mark)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]); // the sign-out boundary, and nothing after it
    expect(server.editEligReads()).toEqual([]);
    expect(signedOutView()).toEqual(SIGNED_OUT_VIEW);
    const sent = server.sent.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(sentFrom(server, sent)).toEqual([]); // no automatic reconnection
    expect(server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins);
    expect(server.patches()).toEqual([]);
    expect(server.posts()).toEqual([]);
  });

  it.each([['an allowance (200)', null], ['a refusal (403)', 403]] as const)('SID-113. AC-15 (initiation BEFORE sign-out; jsdom-only callback ordering): an edit-eligibility read initiated before a sign-out and answered after it began — %s — counts for nothing: the page cancelled it at the sign-out, and its late answer initiates nothing (no fresh session check, retry, sign-in, PATCH or POST), restores no eligibility, Edit, editor or line, and revives no session; a focus then sends nothing', async (_answer, status) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, props, draft } = await ready();
    server.hold.editElig = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['editElig']));
    const logins = server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login).length;
    const asked = server.sent.findIndex((x) => x.url === editEligibilityPathOf(STORE_1, draft.id));
    const mark = server.sent.length;
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(asked).toBeLessThan(mark); // initiated BEFORE the sign-out
    await act(async () => { void props.session!.logout(); });
    expect(sentFrom(server, mark)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]); // the sign-out boundary
    expect(server.sent[asked].signal?.aborted).toBe(true); // the page cancelled the read at the sign-out
    await release(server, 0, status === null ? undefined : refusal(status, 'forbidden')); // delivered anyway (the fake ignores the abort)
    await settle();
    expect(sentFrom(server, mark)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(server.editEligReads()).toHaveLength(1);
    expect(signedOutView()).toEqual(SIGNED_OUT_VIEW);
    const sent = server.sent.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(sentFrom(server, sent)).toEqual([]); // no automatic reconnection: no token was taken back
    expect(server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins);
    expect(server.patches()).toEqual([]);
    expect(server.posts()).toEqual([]);
  });
});

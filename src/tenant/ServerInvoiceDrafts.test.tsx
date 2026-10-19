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
// sign-out with its answer released after it (SID-113). M7B-INVOICES-DISCARD-P1 (SID-114..): the discard — the fake
// answers its eligibility from a per-role `discardAllow` table (Invoices Manage or above: owner and manager) and its POST
// under its own idempotency ledger use (the store, the draft and the exact bytes; a discarded draft leaves the list and
// the draft read, as migration 033's reads); each title names the DSC id(s) of doc 11 §7 it covers.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { StrictMode, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DISCARD_ELIGIBILITY_TEXT, DISCARD_REFUSED_TEXT, DISCARD_TEXT, DRAFTS_TEXT, DRAFT_RULE_TEXT, EDIT_ELIGIBILITY_TEXT, EDIT_REFUSED_TEXT, EDIT_TEXT, ELIGIBILITY_TEXT, HOLD_TEXT,
  ISSUE_ELIGIBILITY_TEXT, ISSUE_REFUSED_TEXT, ISSUE_TEXT, NOT_SENT_TEXT, REFUSED_TEXT, ServerInvoiceDrafts,
  bindDraftHoldsToSessionEnd, createDraftHoldStore, createIssueHoldStore, customerFallbackText, storeLabel, type DraftHoldStore, type HeldDraft, type IssueHoldStore, type ServerInvoiceDraftsProps,
} from './ServerInvoiceDrafts';
import { createInvoiceIssuingClient, issueEligibilityPathOf, issuePathOf, issuePreviewPathOf, issuedInvoicePathOf, issuedInvoicesPathOf } from './invoiceIssuingClient';
import {
  STORES_PATH, createInvoiceDraftsClient, discardEligibilityPathOf, discardPathOf, draftPathOf, draftsPathOf, editEligibilityPathOf, eligibilityPathOf, type StoreEntry,
} from './invoiceDraftsClient';
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
/** `status`: 'discarded' once the server discarded it (M7B-INVOICES-DISCARD-P1), 'issued' once it issued it (M7B-INVOICES-ISSUE-P2): it then leaves the list and the draft read. */
interface Draft { id: string; storeId: string; customerId: string; createdAt: string; subtotalCents: number; lines: Line[]; version: number; status?: 'discarded' | 'issued' }
type Kind = 'stores' | 'list' | 'get' | 'names' | 'create' | 'customers' | 'current' | 'elig' | 'update' | 'editElig' | 'discard' | 'discardElig'
  | 'issueElig' | 'preview' | 'issue' | 'find' | 'issued';
/** M7B-INVOICES-ISSUE-P2: a store's issuing settings as the server holds them (version ≥ 1). */
type TaxSetting = { mode: 'exclusive_rate'; rateMilliPercent: number } | { mode: 'none' };
interface Settings { version: number; legalName: string; storeName: string; postalAddress: string; taxRegistrationId: string | null; tax: TaxSetting }
/** One issued invoice as the server recorded it (snapshot version 1). */
interface Invoice {
  id: string; storeId: string; number: number; sourceDraftId: string; sourceVersion: number; customerId: string; customerName: string; customerVersion: number;
  settingsVersion: number; seller: Omit<Settings, 'version' | 'tax'>; lines: Line[]; amounts: Record<string, unknown>; issuedAt: string;
  /** M7B-INVOICES-VOID-P1: present once voided (elsewhere: the shop offers no void) — the rows' status "voided" and the detail's `void` member. */
  void?: { voidedAt: string; reasonCode: string };
}
type CreateScript = 'lose' | 'lose-before' | 503 | 429 | 'hold' | 'key-reused';
/** M7B-INVOICES-P2: what the next PATCHes do — lose the answer after deciding (committed), lose the request, or answer this status (in the chain's envelope) instead. */
type UpdateScript = 'lose' | 'lose-before' | number;
/** M7B-INVOICES-DISCARD-P1: what the next discard POSTs do, as the PATCHes' — or a whole answer, before anything is decided. */
type DiscardScript = UpdateScript | Response;

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
    400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 422: 'idempotency_key_reused', 429: 'rate_limited', 500: 'internal_error', 503: 'service_unavailable',
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
    customers: new Map<string, { tenant: string; name: string; version?: number }>(),
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
    // M7B-INVOICES-DISCARD-P1: the server's per-role decision of a discard (Invoices Manage or above: the owner, and a
    // manager at its default Full) — the same table answers its discard eligibility.
    discardAllow: { owner: true, manager: true } as Record<string, boolean>,
    discardEligStatus: [] as Array<number | Response>, // what the next discard-eligibility GETs answer instead, in order
    discards: [] as DiscardScript[], // what the next discard POSTs do (then normally)
    currentStatus: [] as number[], // what the next session reads (GET /api/v1/session) answer instead (503, 429…), in order
    nameStatus: new Map<string, number>(), // a customer read answered with this status
    nameInFlight: 0,
    nameMaxInFlight: 0,
    second: 100,
    // M7B-INVOICES-ISSUE-P2: the server's per-role decision of an issue (Invoices Approve with Customers View: the owner,
    // and a manager at its default Full) — the same table answers its eligibility and its preview; the issued reads
    // (Invoices View with Customers View) by `viewIssuedAllow`. Settings, counters and invoices per store.
    issueAllow: { owner: true, manager: true } as Record<string, boolean>,
    viewIssuedAllow: { owner: true, manager: true } as Record<string, boolean>,
    issueEligStatus: [] as Array<number | Response>, // what the next issue-eligibility GETs answer instead, in order
    previewStatus: [] as Array<number | Response>, // what the next issue-preview GETs answer instead, in order
    issues: [] as DiscardScript[], // what the next issue POSTs do (then normally)
    findStatus: [] as Array<number | Response>, // what the next sourceDraft lookups answer instead
    issuedStatus: [] as Array<number | Response>, // what the next issued-invoice GETs answer instead
    settings: new Map<string, Settings>(),
    counters: new Map<string, number>(),
    invoices: [] as Invoice[],
    hold: { stores: 0, list: 0, get: 0, names: 0, create: 0, customers: 0, current: 0, elig: 0, update: 0, editElig: 0, discard: 0, discardElig: 0, issueElig: 0, preview: 0, issue: 0, find: 0, issued: 0 } as Record<Kind, number>,
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
    /** The discard POSTs sent (M7B-INVOICES-DISCARD-P1). */
    discardPosts(): Sent[] { return server.sent.filter((r) => r.method === 'POST' && r.url.endsWith('/discard')); },
    /** The discard-eligibility reads sent. */
    discardEligReads(): Sent[] { return server.sent.filter((r) => r.url.endsWith('/discard-eligibility')); },
    /** M7B-INVOICES-ISSUE-P2: the issue POSTs, the issue-eligibility and preview reads, the issued reads (lookups and details) sent. */
    issuePosts(): Sent[] { return server.sent.filter((r) => r.method === 'POST' && r.url.endsWith('/issue')); },
    issueEligReads(): Sent[] { return server.sent.filter((r) => r.url.endsWith('/issue-eligibility')); },
    previewReads(): Sent[] { return server.sent.filter((r) => r.url.endsWith('/issue-preview')); },
    issuedReads(): Sent[] { return server.sent.filter((r) => r.method === 'GET' && /^\/api\/v1\/stores\/[0-9a-f-]{36}\/invoices(?:[/?]|$)/.test(r.url)); },
    mayIssue(user: User, storeId: string): boolean {
      const grant = server.stores[user.uid]?.find((s) => s.id === storeId);
      return grant !== undefined && !grant.readOnly && server.issueAllow[user.role] === true;
    },
    mayViewIssued(user: User, storeId: string): boolean {
      return server.stores[user.uid]?.some((s) => s.id === storeId) === true && server.viewIssuedAllow[user.role] === true;
    },
    configure(storeId: string, over: Partial<Settings> = {}): Settings {
      const was = server.settings.get(storeId);
      const next: Settings = {
        version: (was?.version ?? 0) + 1, legalName: 'Example Repairs LLC', storeName: 'Main Street Shop', postalAddress: '1 Main St\nSpringfield',
        taxRegistrationId: 'TX-1', tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 }, ...over,
      };
      server.settings.set(storeId, next);
      if (!server.counters.has(storeId)) server.counters.set(storeId, 0);
      return next;
    },
    /** The amounts the server derives (doc 12 §10.8): tax (S × R + 50,000) / 100,000 in BigInt, or none. */
    amountsOf(subtotal: number, tax: TaxSetting): { amounts: Record<string, unknown>; total: bigint } {
      if (tax.mode === 'none') return { amounts: { currency: 'USD', subtotalCents: subtotal, tax: { mode: 'none', description: 'No tax calculated' }, totalCents: subtotal }, total: BigInt(subtotal) };
      const amount = (BigInt(subtotal) * BigInt(tax.rateMilliPercent) + 50_000n) / 100_000n;
      const total = BigInt(subtotal) + amount;
      return { amounts: { currency: 'USD', subtotalCents: subtotal, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: tax.rateMilliPercent, amountCents: Number(amount) }, totalCents: Number(total) }, total };
    },
    summaryOfInvoice(i: Invoice) {
      return { id: i.id, number: i.number, sourceDraftId: i.sourceDraftId, customerId: i.customerId, customerName: i.customerName, currency: 'USD', totalCents: i.amounts.totalCents, issuedAt: i.issuedAt, status: i.void === undefined ? 'issued' : 'voided', snapshotVersion: 1 };
    },
    mayDiscard(user: User, storeId: string): boolean {
      const grant = server.stores[user.uid]?.find((s) => s.id === storeId);
      return grant !== undefined && !grant.readOnly && server.discardAllow[user.role] === true;
    },
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
      const discardEligibility = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoice-drafts\/([0-9a-f-]{36})\/discard-eligibility$/.exec(url); // reads no draft
      if (method === 'GET' && discardEligibility !== null) {
        const decided = gate() ?? (() => {
          const scripted = server.discardEligStatus.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          return server.mayDiscard(session!.user, discardEligibility[1]) ? reply(200, { eligibility: 'allowed' }) : refuse(403, 'forbidden');
        })();
        return server.maybeHold('discardElig', url, decided);
      }
      // M7B-INVOICES-DISCARD-P1: the discard, keyed like the server's (the store, the DRAFT and the exact bytes): a sealed
      // 200 or 409 replays under its key; the tenant precondition and a missing (or other store's) draft are unsealed.
      const discardPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoice-drafts\/([0-9a-f-]{36})\/discard$/.exec(path);
      if (method === 'POST' && discardPath !== null) {
        const [, storeId, draftId] = discardPath;
        const script = server.discards.shift();
        if (script === 'lose-before') throw new TypeError('network');
        if (typeof script === 'number') return refuse(script);
        if (script instanceof Response) return script;
        const refused = gate();
        const decide = (): Response => {
          if (refused !== null) return refused;
          if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
          const grant = server.stores[session!.user.uid]?.find((s) => s.id === storeId);
          if (grant === undefined || !server.mayDiscard(session!.user, storeId)) return refuse(403, 'forbidden');
          const key = headers.get('idempotency-key') ?? '';
          const fingerprint = `discard\n${storeId}\n${draftId}\n${body}`;
          const known = server.keys.get(key);
          if (known !== undefined && known.fingerprint !== fingerprint) return refuse(422, 'idempotency_key_reused');
          if (known !== undefined) return reply(known.response.status, known.response.body, { 'idempotent-replayed': 'true' });
          const parsed = JSON.parse(body ?? '{}') as { expectedTenant: string; expectedVersion: number };
          if (parsed.expectedTenant !== grant.tenantId) return refuse(409, 'write_conflict'); // unsealed
          const draft = server.drafts.find((d) => d.id === draftId && d.storeId === storeId);
          if (draft === undefined) return refuse(404, 'not_found');
          const seal = (status: number, sealed: unknown): Response => { server.keys.set(key, { fingerprint, response: { status, body: sealed } }); return reply(status, sealed); };
          if (draft.status !== undefined) return seal(409, { error: 'invalid_state' }); // before the version (D-DIS-3)
          if (draft.version !== parsed.expectedVersion) return seal(409, { error: 'write_conflict' });
          draft.status = 'discarded';
          draft.version += 1;
          return seal(200, { draftId, version: draft.version, status: 'discarded' });
        };
        const decided = decide();
        if (script === 'lose') throw new TypeError('network'); // committed, but the answer is lost
        return server.maybeHold('discard', url, decided);
      }
      // M7B-INVOICES-ISSUE-P2: the issue routes (invoiceIssuing.ts as built): the eligibility reads no draft; the preview is
      // an unsealed read (404 for a missing or no longer open draft, its three 409s in the database's order); the POST is
      // keyed like the server's (the store, the DRAFT and the exact bytes) — a 201 (with its Location) and the sealed 409s
      // replay under their key, the tenant precondition and a missing draft are unsealed.
      const issueRoute = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoice-drafts\/([0-9a-f-]{36})\/(issue-eligibility|issue-preview|issue)$/.exec(path);
      if (issueRoute !== null) {
        const [, storeId, draftId, what] = issueRoute;
        if (what === 'issue-eligibility' && method === 'GET') {
          const decided = gate() ?? (() => {
            const scripted = server.issueEligStatus.shift();
            if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
            return server.mayIssue(session!.user, storeId) ? reply(200, { eligibility: 'allowed' }) : refuse(403, 'forbidden');
          })();
          return server.maybeHold('issueElig', url, decided);
        }
        if (what === 'issue-preview' && method === 'GET') {
          const decided = gate() ?? (() => {
            const scripted = server.previewStatus.shift();
            if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
            if (!server.mayIssue(session!.user, storeId)) return refuse(403, 'forbidden');
            const grant = server.stores[session!.user.uid]!.find((x) => x.id === storeId)!;
            const draft = server.drafts.find((d) => d.id === draftId && d.storeId === storeId && d.status === undefined);
            if (draft === undefined) return refuse(404, 'not_found');
            if (draft.version >= Number.MAX_SAFE_INTEGER) return refuse(409, 'invalid_state');
            const settings = server.settings.get(storeId);
            if (settings === undefined) return refuse(409, 'issuing_not_configured');
            const { amounts, total } = server.amountsOf(draft.subtotalCents, settings.tax);
            if (total > BigInt(Number.MAX_SAFE_INTEGER)) return refuse(409, 'amount_out_of_range');
            const c = server.customers.get(draft.customerId)!;
            const { version: sv, ...seller } = settings;
            return reply(200, { preview: {
              draft: { id: draft.id, version: draft.version, lines: draft.lines, subtotalCents: draft.subtotalCents },
              customer: { id: draft.customerId, name: c.name, version: c.version ?? 1 },
              issuingSettings: { version: sv, ...seller },
              amounts,
              expected: { expectedTenant: grant.tenantId, expectedVersion: draft.version, expectedSettingsVersion: sv, expectedCustomerVersion: c.version ?? 1 },
            } });
          })();
          return server.maybeHold('preview', url, decided);
        }
        if (what === 'issue' && method === 'POST') {
          const script = server.issues.shift();
          if (script === 'lose-before') throw new TypeError('network');
          if (typeof script === 'number') return refuse(script);
          if (script instanceof Response) return script;
          const refused = gate();
          const decide = (): Response => {
            if (refused !== null) return refused;
            if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
            if (!server.mayIssue(session!.user, storeId)) return refuse(403, 'forbidden');
            const grant = server.stores[session!.user.uid]!.find((x) => x.id === storeId)!;
            const key = headers.get('idempotency-key') ?? '';
            const fingerprint = `issue\n${storeId}\n${draftId}\n${body}`;
            const known = server.keys.get(key);
            if (known !== undefined && known.fingerprint !== fingerprint) return refuse(422, 'idempotency_key_reused');
            if (known !== undefined) {
              const r = known.response;
              return reply(r.status, r.body, { 'idempotent-replayed': 'true', ...(r.location !== undefined ? { location: r.location } : {}) });
            }
            const parsed = JSON.parse(body ?? '{}') as { expectedTenant: string; expectedVersion: number; expectedSettingsVersion: number; expectedCustomerVersion: number };
            if (parsed.expectedTenant !== grant.tenantId) return refuse(409, 'write_conflict'); // unsealed
            const draft = server.drafts.find((d) => d.id === draftId && d.storeId === storeId);
            if (draft === undefined) return refuse(404, 'not_found');
            const seal = (status: number, sealed: unknown, location?: string): Response => {
              server.keys.set(key, { fingerprint, response: { status, body: sealed, location } });
              return reply(status, sealed, location === undefined ? {} : { location });
            };
            if (draft.status !== undefined) return seal(409, { error: 'invalid_state' });
            const settings = server.settings.get(storeId);
            if (settings === undefined) return seal(409, { error: 'issuing_not_configured' });
            const c = server.customers.get(draft.customerId)!;
            if (draft.version !== parsed.expectedVersion || settings.version !== parsed.expectedSettingsVersion || (c.version ?? 1) !== parsed.expectedCustomerVersion) {
              return seal(409, { error: 'write_conflict' });
            }
            const { amounts, total } = server.amountsOf(draft.subtotalCents, settings.tax);
            if (total > BigInt(Number.MAX_SAFE_INTEGER)) return seal(409, { error: 'amount_out_of_range' });
            const number = (server.counters.get(storeId) ?? 0) + 1;
            server.counters.set(storeId, number);
            const { version: sv, tax: _tax, ...seller } = settings;
            const invoice: Invoice = {
              id: uuid(0xe00 + server.invoices.length + 1), storeId, number, sourceDraftId: draft.id, sourceVersion: draft.version, customerId: draft.customerId,
              customerName: c.name, customerVersion: c.version ?? 1, settingsVersion: sv, seller, lines: draft.lines, amounts, issuedAt: at(server.second++, 654321),
            };
            server.invoices.push(invoice);
            draft.status = 'issued';
            draft.version += 1;
            return seal(201, { invoice: { id: invoice.id, sourceDraftId: draft.id, status: 'issued' }, draft: { id: draft.id, version: draft.version, status: 'issued' } }, issuedInvoicePathOf(storeId, invoice.id));
          };
          const decided = decide();
          if (script === 'lose') throw new TypeError('network'); // committed, but the answer is lost
          return server.maybeHold('issue', url, decided);
        }
      }
      const issuedRoute = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices(?:\/([0-9a-f-]{36}))?$/.exec(path);
      if (issuedRoute !== null && method === 'GET') {
        const [, storeId, invoiceId] = issuedRoute;
        const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : null;
        const kind: Kind = invoiceId === undefined ? 'find' : 'issued';
        const decided = gate() ?? (() => {
          const scripted = (invoiceId === undefined ? server.findStatus : server.issuedStatus).shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          if (!server.mayViewIssued(session!.user, storeId)) return refuse(403, 'forbidden');
          if (invoiceId !== undefined) {
            if (query !== null) return refuse(400, 'invalid_request');
            const i = server.invoices.find((x) => x.id === invoiceId && x.storeId === storeId);
            if (i === undefined) return refuse(404, 'not_found');
            return reply(200, { invoice: {
              id: i.id, number: i.number, status: i.void === undefined ? 'issued' : 'voided', snapshotVersion: 1, issuedAt: i.issuedAt, sourceDraft: { id: i.sourceDraftId, version: i.sourceVersion },
              seller: i.seller, issuingSettingsVersion: i.settingsVersion, customer: { id: i.customerId, name: i.customerName, version: i.customerVersion }, lines: i.lines, amounts: i.amounts,
              ...(i.void === undefined ? {} : { void: i.void }),
            } });
          }
          const one = /^sourceDraft=([0-9a-f-]{36})$/.exec(query ?? ''); // the lookup mode alone: this fake knows no other
          if (one === null) return refuse(400, 'invalid_request');
          const found = server.invoices.filter((x) => x.storeId === storeId && x.sourceDraftId === one[1]);
          return reply(200, { invoices: found.map((x) => server.summaryOfInvoice(x)), nextCursor: null });
        })();
        return server.maybeHold(kind, url, decided);
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
            const anchor = anchorId === null ? null : all.findIndex((d) => d.id === anchorId); // the anchor's lookup is status-blind
            if (cursor !== null && (anchor === null || anchor < 0)) return refuse(400, 'invalid_request');
            const rest = (anchor === null ? all : all.slice(anchor + 1)).filter((d) => d.status === undefined); // open drafts only
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
            const draft = server.drafts.find((d) => d.id === draftId && d.storeId === storeId && d.status === undefined); // a discarded or issued one: as a missing one
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
            if (draft.status !== undefined) return seal(409, { error: 'invalid_state' }); // M7B-INVOICES-DISCARD-P1: a stale editor
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

interface Rig { holds: DraftHoldStore; issueHolds: IssueHoldStore; keys: string[]; clock: { mono: number; wall: number }; props: (over?: Partial<ServerInvoiceDraftsProps>) => ServerInvoiceDraftsProps }
function rig(server: Server, holds: DraftHoldStore = createDraftHoldStore(), issueHolds: IssueHoldStore = createIssueHoldStore()): Rig {
  const keys: string[] = [];
  const clock = { mono: 1_000, wall: Date.UTC(2026, 9, 4, 12) };
  const session = createTenantSessionClient({ fetch: server.fetch });
  const drafts = createInvoiceDraftsClient({ fetch: server.fetch });
  const customers = createCustomersClient({ fetch: server.fetch });
  const issuing = createInvoiceIssuingClient({ fetch: server.fetch });
  const identity = { idToken: async (uid: string) => (uid === 'uid-a' ? 'tok-a' : uid === 'uid-b' ? 'tok-b' : null) };
  return {
    holds, issueHolds, keys, clock,
    props: (over = {}) => ({
      uid: 'uid-a', canViewCustomers: true, handoff: null, onHandoffTaken: () => {}, session, drafts, customers, identity, holds, issuing, issueHolds,
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
    // M7B-INVOICES-DISCARD-P1: and Discard draft… on the discard's own answer (the owner may discard); it only opens a confirmation.
    await waitFor(() => expect(within(view).getByTestId('draft-discard-open')).toBeInTheDocument());
    // M7B-INVOICES-ISSUE-P2: and Issue invoice… on the issue's own answer (the owner may issue); it only opens a review — the
    // view itself still names no number, issued state, payment, tax or discount.
    await waitFor(() => expect(within(view).getByTestId('draft-issue-open')).toBeInTheDocument());
    expect(within(view).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close', 'Edit draft', 'Discard draft…', 'Issue invoice…']);
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
    // The reopen's, the eligibility's and its ONE fresh check — and (M7B-INVOICES-DISCARD-P1) the discard eligibility's own
    // ONE fresh check after its 403 (its session read is the edit eligibility's, asked at the same moment) — and
    // (M7B-INVOICES-ISSUE-P2) the issue eligibility's own ONE fresh check after its 403 (Create may not issue).
    expect(after.filter((u) => u === TENANT_SESSION_PATHS.current)).toHaveLength(5);
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

describe('Server drafts — discarding a saved draft (M7B-INVOICES-DISCARD-P1)', () => {
  const release = async (server: Server, i = 0, late?: Response) => { const [held] = server.held.splice(i, 1); await act(async () => { held.release(late); }); };
  const discardBody = (tenant: string, version: number) => `{"expectedTenant":"${tenant}","expectedVersion":${version}}`;
  const confirm = () => screen.queryByTestId('draft-discard-confirm');
  const view = () => screen.queryByTestId('draft-view');
  const notice = () => screen.queryByTestId('drafts-notice');
  const attemptState = () => screen.queryByTestId('draft-discard-attempt')?.getAttribute('data-state') ?? 'none';
  const heading = () => screen.getByRole('heading', { name: 'Server drafts' });
  /** Page one's list reads of Main Street sent from `mark` on. */
  const pageOneReads = (server: Server, mark: number) => server.sent.slice(mark).filter((x) => x.method === 'GET' && x.url.startsWith(`${draftsPathOf(STORE_1)}?`));
  /** Open the listed draft at `index`; wait for its read, the server's answers about Edit and Discard, and the customer's name. */
  async function openDraft(server: Server, index = 0) {
    const asked = server.discardEligReads().length;
    await user().click(within(rows()[index]).getByTestId('drafts-open'));
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('draft-view-edit-state')).not.toHaveAttribute('data-phase', 'checking'));
    await waitFor(() => expect(server.discardEligReads()).toHaveLength(asked + 1));
    await settle();
    await waitFor(() => expect(screen.getByTestId('draft-view-customer')).not.toHaveTextContent('ID ending'));
  }
  /** Open the draft, then its discard confirmation (first focus on Keep draft). */
  async function openConfirm(server: Server, index = 0) {
    await openDraft(server, index);
    await click('draft-discard-open');
    await waitFor(() => expect(confirm()).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('draft-discard-keep')));
  }
  /** uid-a's draft at Main Street: Item 1 and Item 2, one each at $2.50, for Ada; at version 3. */
  async function ready(over: Partial<ServerInvoiceDraftsProps> = {}) {
    const { server, ada, bea } = seeded();
    const draft = server.seedDraft(STORE_1, ada, at(5), 250, 2);
    draft.version = 3;
    const r = rig(server);
    const props = r.props(over);
    const page = render(<ServerInvoiceDrafts {...props} />);
    await showAndChoose(STORE_1);
    return { server, ada, bea, draft, r, props, page };
  }

  it('SID-114. DSC-19: Discard draft… is offered ONLY on the server\'s own discard eligibility for exactly this draft, store and session — absent and unsaid while it is asked (the edit\'s line is the one announced answer); one discard-eligibility GET per open, carrying that session\'s token and nothing else; none at a read-only store; never in the editor or beside a new draft; nothing is POSTed', async () => {
    const { server, draft } = await ready();
    const ro = server.seedDraft(STORE_RO, draft.customerId, at(6));
    server.hold.discardElig = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discardElig']));
    await waitFor(() => expect(screen.getByTestId('draft-view-edit')).toBeEnabled());
    const dialog = screen.getByTestId('draft-view');
    expect(screen.queryByTestId('draft-discard-open')).toBeNull();
    expect(screen.queryByTestId('draft-discard-elig-again')).toBeNull();
    expect(within(dialog).queryAllByRole('status').map((x) => x.textContent)).toEqual(['']); // the edit's live region only (empty once allowed)
    expect(within(dialog).queryAllByRole('alert')).toEqual([]);
    expect(dialog.textContent).not.toMatch(/discard/i);
    const asked = server.discardEligReads();
    expect(asked.map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${discardEligibilityPathOf(STORE_1, draft.id)}`]);
    expect(asked[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}/);
    expect([asked[0].headers.get('x-tmpos-csrf'), asked[0].headers.get('idempotency-key'), asked[0].body]).toEqual([null, null, undefined]);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-discard-open')).toBeEnabled());
    expect(screen.getByTestId('draft-discard-open')).toHaveTextContent('Discard draft…');
    await click('draft-view-close');
    await openDraft(server);
    expect(server.discardEligReads()).toHaveLength(2); // each open asks again: never a last answer
    // The editor offers none (its "Discard my changes" is local), nor does a new draft.
    await click('draft-view-edit');
    await waitFor(() => expect(screen.getByTestId('draft-edit')).toBeInTheDocument());
    expect(screen.queryByTestId('draft-discard-open')).toBeNull();
    expect(within(screen.getByTestId('draft-edit')).queryByRole('button', { name: /Discard draft/ })).toBeNull();
    await click('draft-edit-cancel');
    await settle();
    await click('drafts-new');
    expect(within(screen.getByTestId('draft-new')).queryByRole('button', { name: /Discard/ })).toBeNull();
    await click('draft-new-cancel');
    await settle();
    fireEvent.change(storeSelect(), { target: { value: STORE_RO } });
    await listReady();
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toHaveTextContent('1'));
    await settle();
    expect(screen.queryByTestId('draft-discard-open')).toBeNull(); // a read-only store: nothing asked, nothing offered
    expect(server.discardEligReads().filter((x) => x.url.includes(ro.id))).toEqual([]);
    expect(server.discardPosts()).toEqual([]);
  });

  it.each([
    ['View (it may list and open drafts only)', 'viewer', false],
    ['Create (it may save drafts, not edit or discard them)', 'sales', false],
    ['Edit (it may edit drafts, not discard them)', 'technician', true],
  ] as const)('SID-115. DSC-19: a role below Manage — Invoices %s — gets no Discard draft…: the discard eligibility\'s 403 gets ONE fresh session check and stands, and nothing is shown or said for it; the edit\'s line stays the dialog\'s one announced answer (one denial announcement, never two)', async (_level, role, edits) => {
    const { server } = await ready();
    server.users['tok-a'].role = role;
    server.editAllow[role] = edits;
    const before = server.sent.length;
    await openDraft(server);
    const dialog = screen.getByTestId('draft-view');
    expect(screen.queryByTestId('draft-discard-open')).toBeNull();
    expect(screen.queryByTestId('draft-discard-elig-again')).toBeNull();
    const said = [...within(dialog).queryAllByRole('status'), ...within(dialog).queryAllByRole('alert')].map((x) => x.textContent).filter((t) => t !== '');
    expect(said).toEqual(edits ? [] : [EDIT_ELIGIBILITY_TEXT.denied]);
    expect(dialog.textContent).not.toMatch(/discard/i);
    if (edits) expect(screen.getByTestId('draft-view-edit')).toBeEnabled();
    const after = server.sent.slice(before).map((x) => x.url);
    expect(after.filter((u) => u.endsWith('/discard-eligibility'))).toHaveLength(1);
    // The reopen's session read, the eligibilities' shared one, and ONE fresh check per 403 — since M7B-INVOICES-ISSUE-P2 the
    // issue eligibility's too (no role below Approve may issue).
    expect(after.filter((u) => u === TENANT_SESSION_PATHS.current)).toHaveLength(edits ? 4 : 5);
    expect(server.discardPosts()).toEqual([]);
  });

  it('SID-116. DSC-19: a discard eligibility that cannot be answered (an outage) offers no Discard draft… but one Try again, described (not live) by why; Try again asks once per press and offers Discard draft… on the server\'s allowance; a 429 holds Try again back for its wait, said in its description; nothing is ever POSTed', async () => {
    const { server } = await ready();
    server.discardEligStatus.push(503);
    await openDraft(server);
    const again = screen.getByTestId('draft-discard-elig-again');
    expect(screen.queryByTestId('draft-discard-open')).toBeNull();
    expect(again).toBeEnabled();
    expect(again).toHaveAccessibleDescription(DISCARD_ELIGIBILITY_TEXT.unavailable);
    const why = screen.getByTestId('draft-discard-elig-why');
    expect([why.getAttribute('role'), why.getAttribute('aria-live')]).toEqual([null, null]);
    expect(screen.getByTestId('draft-view-edit')).toBeEnabled(); // the edit's answer is its own
    const asked = server.discardEligReads().length;
    await click('draft-discard-elig-again');
    await waitFor(() => expect(screen.getByTestId('draft-discard-open')).toBeEnabled());
    expect(server.discardEligReads()).toHaveLength(asked + 1);
    expect(screen.queryByTestId('draft-discard-elig-again')).toBeNull();
    await click('draft-view-close');
    server.retryAfter = '30';
    server.discardEligStatus.push(429);
    await openDraft(server);
    expect(screen.getByTestId('draft-discard-elig-again')).toBeDisabled();
    expect(screen.getByTestId('draft-discard-elig-again')).toHaveAccessibleDescription(`${pickerWaitText(30)} ${DISCARD_ELIGIBILITY_TEXT.waiting}`);
    expect(screen.queryByTestId('draft-discard-open')).toBeNull();
    const sent = server.sent.length;
    await settle();
    expect(server.sent).toHaveLength(sent);
    expect(server.discardPosts()).toEqual([]);
  });

  it('SID-117. DSC-21: the confirmation is an alertdialog named "Discard this draft?" and described by ONE element — what a discard does and the draft it names from the reopen read (customer, store, created time, lines, subtotal, version and its ID; no contact detail, no reason field) — first focus on Keep draft, the reopen dialog inert beneath, Tab kept inside; Keep draft and Escape close it, send nothing and return focus to Discard draft… in the unchanged reopen dialog', async () => {
    const { server, draft } = await ready();
    await openConfirm(server);
    const dialog = confirm()!;
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(DISCARD_TEXT.title);
    const identity = `Ada Customer · Main Street · created 2026-10-04 12:00 UTC · 2 lines · Draft subtotal $5.00 · version 3 · draft ID ${draft.id}`;
    expect(screen.getByTestId('draft-discard-identity').textContent).toBe(identity);
    expect(dialog).toHaveAccessibleDescription(`${DISCARD_TEXT.explain} ${identity}`);
    expect(dialog.getAttribute('aria-describedby')!.split(' ')).toHaveLength(1);
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect(within(description).queryAllByRole('button')).toEqual([]);
    expect(within(dialog).queryAllByRole('textbox')).toEqual([]);
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep draft', 'Discard draft']);
    expect(screen.getByTestId('draft-view').closest('[inert]')).not.toBeNull(); // the reopen dialog is inert beneath it
    expect(dialog.closest('[inert]')).toBeNull();
    await user().tab();
    expect(document.activeElement).toBe(screen.getByTestId('draft-discard-send'));
    await user().tab();
    expect(document.activeElement).toBe(screen.getByTestId('draft-discard-keep')); // wraps inside
    const sent = server.sent.length;
    await user().keyboard('{Escape}');
    await settle();
    expect(confirm()).toBeNull();
    expect(view()).toBeInTheDocument();
    expect(screen.getByTestId('draft-view').closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('draft-discard-open'));
    await click('draft-discard-open');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('draft-discard-keep')));
    await click('draft-discard-keep');
    await settle();
    expect(confirm()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('draft-discard-open'));
    expect(server.sent.slice(sent)).toEqual([]);
    expect(screen.getByTestId('draft-view-version')).toHaveTextContent('3');
    expect(draft.status).toBeUndefined();
  });

  it('SID-118. DSC-01, DSC-15, DSC-21: ONE press is ONE POST of the exact bytes under ONE fresh key (the store\'s tenant, the version read); Discard draft is gone from that press on and Keep draft reads Close, described as only stopping the tracking; "Discarding…" is said and nothing says discarded before the 200 — then both dialogs close, "Draft discarded." is said outside them, focus is on the heading, and page one is read again without that draft, the notice kept and nothing "unavailable"', async () => {
    const { server, draft, r } = await ready();
    await openConfirm(server);
    server.hold.discard = 1;
    const send = screen.getByTestId('draft-discard-send');
    await user().click(send);
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    expect(send.isConnected).toBe(false); // no second key from this dialog
    expect(screen.queryByTestId('draft-discard-send')).toBeNull();
    expect(attemptState()).toBe('sending');
    expect(within(screen.getByTestId('draft-discard-attempt')).getByRole('status')).toHaveTextContent(DISCARD_TEXT.sending);
    const keep = screen.getByTestId('draft-discard-keep');
    expect(keep).toHaveTextContent('Close');
    expect(keep).toHaveAccessibleDescription(DISCARD_TEXT.closeWarning);
    expect(document.activeElement).toBe(keep); // the focus the press took away, recovered inside the dialog
    expect(document.body).not.toHaveTextContent(DISCARD_TEXT.discarded);
    expect(notice()).toBeNull();
    const posts = server.discardPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(discardPathOf(STORE_1, draft.id));
    expect(posts[0].body).toBe(discardBody(TENANT_A, 3));
    expect(posts[0].headers.get('idempotency-key')).toBe(r.keys[0]);
    expect(posts[0].headers.get('x-tmpos-csrf')).toBe('1');
    expect(posts[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}/);
    expect(posts[0].headers.get('content-type')).toBe('application/json');
    expect(r.keys).toHaveLength(1);
    const mark = server.sent.length;
    // The section's live regions before the answer: the notice's is already there (empty), so its text is announced.
    const regions = within(screen.getByTestId('drafts-section')).queryAllByRole('status', { hidden: true });
    // Focus goes to the heading at once, in the render that closes both dialogs: never to <body>, never back to the
    // discarded draft's Open on the way.
    const fell = watchBody();
    const focused: EventTarget[] = [];
    const record = (e: FocusEvent): void => { if (e.target !== null) focused.push(e.target); };
    document.addEventListener('focusin', record);
    await release(server);
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
    expect(notice()).toHaveAttribute('role', 'status');
    expect(regions).toContain(notice()); // written into the standing region, never inserted with its text
    expect([confirm(), view()]).toEqual([null, null]);
    expect(document.activeElement).toBe(heading());
    await listReady();
    await settle();
    fell.stop();
    document.removeEventListener('focusin', record);
    expect(fell.fell).toEqual([]);
    expect(focused).toEqual([heading()]);
    expect(rows().map((x) => x.getAttribute('data-id'))).not.toContain(draft.id);
    expect(pageOneReads(server, mark)).toHaveLength(1);
    expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded); // the re-read keeps it
    expect(document.activeElement).toBe(heading());
    expect(document.body).not.toHaveTextContent(/unavailable/i);
    expect(server.discardPosts()).toHaveLength(1);
    expect([draft.status, draft.version]).toEqual(['discarded', 4]);
  });

  it('SID-119. DSC-01, DSC-13: a 200 this client cannot name (another version) is no discard: the attempt stays unresolved in the confirmation — nothing says discarded — and only Check again settles it: the SAME key and IDENTICAL bytes, whose sealed replay is the validated 200', async () => {
    const { server, draft, r } = await ready();
    await openConfirm(server);
    server.hold.discard = 1;
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    await release(server, 0, new Response(JSON.stringify({ draftId: draft.id, version: 9, status: 'discarded' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(screen.getByTestId('draft-discard-attempt')).toHaveTextContent(DISCARD_TEXT.unresolved);
    expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent('The server answered, but not with a result.');
    expect(notice()).toBeNull();
    expect(document.body).not.toHaveTextContent(DISCARD_TEXT.discarded);
    await click('draft-discard-check');
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
    const [first, again] = server.discardPosts();
    expect([again.url, again.body, again.headers.get('idempotency-key'), again.headers.get('x-tmpos-session-csrf')])
      .toEqual([first.url, first.body, first.headers.get('idempotency-key'), first.headers.get('x-tmpos-session-csrf')]);
    expect(r.keys).toHaveLength(1);
    expect([confirm(), view()]).toEqual([null, null]);
  });

  it('SID-120. DSC-06, DSC-21: a stale version (another session edited it) is never rebased: the sealed 409 closes the confirmation, the reopen dialog reads the draft ONCE and says why in an alert of its own, and focus goes to Discard draft… (offered again for the new version); only a new press sends again — a new confirmation, a NEW key, the version that read found', async () => {
    const { server, ada, draft, r } = await ready();
    await openConfirm(server);
    server.editDraft(draft, ada, [{ description: 'Elsewhere', quantity: 1, unitPriceCents: 100 }]); // version 4, elsewhere
    const mark = server.sent.length;
    await click('draft-discard-send');
    await waitFor(() => expect(screen.getByTestId('draft-view-discard-refused')).toHaveTextContent(DISCARD_REFUSED_TEXT.conflict));
    expect(screen.getByTestId('draft-view-discard-refused')).toHaveAttribute('role', 'alert');
    expect(confirm()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('draft-discard-open')));
    expect(screen.getByTestId('draft-view-version')).toHaveTextContent('4');
    expect(screen.getAllByTestId('draft-view-line').map((x) => x.textContent)).toEqual(['1Elsewhere1$1.00$1.00']);
    expect(server.detailReads(STORE_1, draft.id).filter((x) => server.sent.indexOf(x) >= mark)).toHaveLength(1);
    await settle();
    expect(server.discardPosts()).toHaveLength(1); // nothing on its own
    expect(notice()).toBeNull();
    await click('draft-discard-open');
    await waitFor(() => expect(confirm()).toBeInTheDocument());
    expect(screen.getByTestId('draft-discard-identity')).toHaveTextContent('version 4');
    await click('draft-discard-send');
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
    const [stale, fresh] = server.discardPosts();
    expect(fresh.headers.get('idempotency-key')).not.toBe(stale.headers.get('idempotency-key'));
    expect([stale.body, fresh.body]).toEqual([discardBody(TENANT_A, 3), discardBody(TENANT_A, 4)]);
    expect(r.keys).toHaveLength(2);
  });

  it.each([
    ['already discarded elsewhere (the sealed 409 invalid_state)', 'not-open'],
    ['no longer at this store (the chain\'s 404)', 'not-found'],
  ] as const)('SID-121. DSC-10, DSC-15, DSC-21: a draft %s: both dialogs close, page one is read again (the draft is not in it), the notice says why — never "Draft discarded.", never "unavailable" — and focus is on the heading', async (_why, kind) => {
    const { server, draft } = await ready();
    await openConfirm(server);
    if (kind === 'not-open') { draft.status = 'discarded'; draft.version += 1; } else server.drafts.splice(server.drafts.indexOf(draft), 1);
    const mark = server.sent.length;
    const fell = watchBody();
    await click('draft-discard-send');
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_REFUSED_TEXT[kind]));
    expect([confirm(), view()]).toEqual([null, null]);
    expect(document.activeElement).toBe(heading());
    fell.stop();
    expect(fell.fell).toEqual([]); // focus went straight to the heading
    await listReady();
    await settle();
    expect(rows().map((x) => x.getAttribute('data-id'))).not.toContain(draft.id);
    expect(pageOneReads(server, mark)).toHaveLength(1);
    expect(document.body).not.toHaveTextContent(DISCARD_TEXT.discarded);
    expect(document.body).not.toHaveTextContent(/unavailable/i);
    expect(server.discardPosts()).toHaveLength(1);
  });

  it.each([
    ['the store is no longer in the tenant the draft was for (the chain\'s 409 write_conflict)', 'tenant-changed'],
    ['the key was used for another request (422)', 'key-reused'],
    ['the server does not accept the request (400)', 'invalid'],
  ] as const)('SID-122. DSC-14, DSC-21: a first send refused because %s ends the attempt with its own alert in the confirmation — Discard draft stays gone (no second key), Close no longer warns — and Close then closes the reopen dialog too and reads page one again, nothing else sent: Discard draft… comes back only with a fresh read of the draft and a fresh eligibility, and a new press is a NEW key', async (_why, kind) => {
    const { server, draft, r } = await ready();
    await openConfirm(server);
    if (kind === 'tenant-changed') server.stores['uid-a'] = server.stores['uid-a'].map((x) => (x.id === STORE_1 ? { ...x, tenantId: TENANT_B } : x));
    else server.discards.push(kind === 'key-reused' ? 422 : 400);
    await click('draft-discard-send');
    await waitFor(() => expect(screen.getByTestId('draft-discard-status')).toHaveTextContent(DISCARD_REFUSED_TEXT[kind]));
    expect(screen.getByTestId('draft-discard-status')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('draft-discard-attempt')).toBeNull();
    expect(screen.queryByTestId('draft-discard-send')).toBeNull();
    expect(screen.queryByTestId('draft-discard-check')).toBeNull();
    expect(screen.getByTestId('draft-discard-keep')).toHaveTextContent('Close');
    expect(screen.getByTestId('draft-discard-keep')).not.toHaveAttribute('aria-describedby');
    const mark = server.sent.length;
    await click('draft-discard-keep');
    await listReady();
    await settle();
    expect([confirm(), view()]).toEqual([null, null]); // never back to a reopen dialog still offering the old eligibility and version
    expect(pageOneReads(server, mark)).toHaveLength(1);
    expect(server.sent.slice(mark).filter((x) => x.method !== 'GET')).toEqual([]);
    expect(rows().map((x) => x.getAttribute('data-id'))).toContain(draft.id);
    expect(document.activeElement).toBe(within(rows()[0]).getByTestId('drafts-open')); // back where the draft was opened
    expect(server.discardPosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    expect(draft.status).toBeUndefined();
    const reads = server.detailReads(STORE_1, draft.id).length;
    const asked = server.discardEligReads().length;
    await openConfirm(server);
    expect(server.detailReads(STORE_1, draft.id)).toHaveLength(reads + 1);
    expect(server.discardEligReads()).toHaveLength(asked + 1);
    expect(screen.getByTestId('draft-discard-keep')).toHaveTextContent('Keep draft');
    await click('draft-discard-send');
    await waitFor(() => expect(server.discardPosts()).toHaveLength(2));
    await settle();
    const [refused, fresh] = server.discardPosts();
    expect(fresh.headers.get('idempotency-key')).not.toBe(refused.headers.get('idempotency-key'));
    expect(r.keys).toHaveLength(2);
  });

  it('SID-123. DSC-19, DSC-21: a POST refused 403 (the owner lowered the level meanwhile) gets ONE fresh session check, then the confirmation closes, Discard draft… goes and the reopen dialog says why in an alert of its own, with focus on its Close — nothing re-sent', async () => {
    const { server, draft } = await ready();
    await openConfirm(server);
    server.discardAllow.owner = false;
    await click('draft-discard-send');
    await waitFor(() => expect(screen.getByTestId('draft-view-discard-refused')).toHaveTextContent(DISCARD_REFUSED_TEXT.denied));
    expect(screen.getByTestId('draft-view-discard-refused')).toHaveAttribute('role', 'alert');
    expect(confirm()).toBeNull();
    expect(screen.queryByTestId('draft-discard-open')).toBeNull();
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('draft-view-close'));
    const post = server.sent.indexOf(server.discardPosts()[0]);
    expect(server.sent.slice(post + 1).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(screen.getByTestId('draft-view-edit')).toBeEnabled(); // the edit's answer is its own
    expect(draft.status).toBeUndefined();
  });

  it('SID-124. DSC-14, DSC-21: a first send answered 429 ends the attempt with its own alert and starts the section\'s wait; Close then closes both dialogs, and page one — not read during the wait — keeps its rows marked last known, with the wait and a Try again held back through it; nothing is sent when it passes. One answered 401 ends the session as any request\'s does: both dialogs go, the stores say so, and nobody is signed in again (only Reconnect would)', async () => {
    const { server, draft, r } = await ready();
    await openConfirm(server);
    fakeClock();
    server.retryAfter = '3';
    server.discards.push(429);
    fireEvent.click(screen.getByTestId('draft-discard-send'));
    await until(() => expect(screen.getByTestId('draft-discard-status')).toHaveTextContent(DISCARD_REFUSED_TEXT['rate-limited']));
    expect(screen.queryByTestId('draft-discard-send')).toBeNull();
    const sent = server.sent.length;
    fireEvent.click(screen.getByTestId('draft-discard-keep'));
    await until(() => expect([confirm(), view()]).toEqual([null, null]));
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited');
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent(pickerWaitText(3));
    expect(screen.getByTestId('drafts-last-known')).toBeInTheDocument();
    expect(rows().map((x) => x.getAttribute('data-id'))).toContain(draft.id);
    expect(screen.getByTestId('drafts-list-retry')).toBeDisabled();
    await advance(3_000);
    await settle();
    expect(server.sent).toHaveLength(sent);
    expect(screen.getByTestId('drafts-list-retry')).toBeEnabled();
    vi.useRealTimers();
    await click('drafts-list-retry');
    await listReady();
    await openConfirm(server);
    server.discards.push(401);
    await click('draft-discard-send');
    await waitFor(() => expect(confirm()).toBeNull());
    expect(view()).toBeNull();
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    await settle();
    expect(server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login)).toHaveLength(1); // only the first sign-in
    expect(server.discardPosts()).toHaveLength(2);
    expect(r.keys).toHaveLength(2);
  });

  it('SID-125. DSC-13: a POST whose answer is lost after the server discarded the draft stays UNRESOLVED in the confirmation — nothing is sent or asked on a focus, a tab return or a re-render (no POST, no discard eligibility); only Check again re-sends, the SAME key and IDENTICAL bytes to the same draft under the attempt\'s own token, and its sealed replay is "Draft discarded."', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, draft, r, props, page } = await ready();
    await openConfirm(server);
    server.discards.push('lose');
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(screen.getByTestId('draft-discard-attempt')).toHaveTextContent(DISCARD_TEXT.unresolved);
    expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent('No answer from the server.');
    expect(screen.getByTestId('draft-discard-keep')).toHaveAccessibleDescription(DISCARD_TEXT.closeWarning);
    expect(draft.status).toBe('discarded'); // committed on the server
    expect(notice()).toBeNull();
    const eligAsked = server.discardEligReads().length;
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    page.rerender(<ServerInvoiceDrafts {...props} />);
    await settle();
    expect(server.discardPosts()).toHaveLength(1);
    expect(server.discardEligReads()).toHaveLength(eligAsked); // never asked again on its own
    expect(attemptState()).toBe('unresolved');
    await click('draft-discard-check');
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
    const [first, again] = server.discardPosts();
    expect(again.body).toBe(first.body); // identical bytes
    expect(again.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key')); // the same key
    expect([again.url, again.headers.get('x-tmpos-session-csrf')]).toEqual([first.url, first.headers.get('x-tmpos-session-csrf')]);
    expect(first.body).toBe(discardBody(TENANT_A, 3));
    expect(r.keys).toHaveLength(1);
    expect([confirm(), view()]).toEqual([null, null]);
    expect(draft.version).toBe(4);
  });

  it('SID-126. DSC-13: a first send answered request_in_progress stays unresolved, and so does a Check again answered request_in_progress (Check again still offered); a Check again answered 503, or refused 403 (after its ONE fresh check), stays unresolved; a Check again\'s 429 holds Check again back for its Retry-After (said why) and sends nothing on its own; every POST is the same key, token and bytes, and the last settles it', async () => {
    const { server, r } = await ready();
    await openConfirm(server);
    server.discards.push(refusal(409, 'request_in_progress'), refusal(409, 'request_in_progress'), 503);
    await click('draft-discard-send');
    await waitFor(() => expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent('The server is still working on it. Check again in a moment.'));
    await click('draft-discard-check');
    await waitFor(() => expect(server.discardPosts()).toHaveLength(2));
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent('The server is still working on it. Check again in a moment.');
    expect(screen.getByTestId('draft-discard-check')).toBeEnabled();
    expect(screen.queryByTestId('draft-discard-status')).toBeNull(); // in progress decides nothing
    await click('draft-discard-check');
    await waitFor(() => expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent('The server answered, but not with a result.'));
    server.discardAllow.owner = false;
    await click('draft-discard-check');
    await waitFor(() => expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent('The server refused this check.'));
    const fourth = server.sent.indexOf(server.discardPosts()[3]);
    expect(server.sent.slice(fourth + 1).map((x) => x.url)).toEqual([TENANT_SESSION_PATHS.current]); // its ONE fresh check
    expect(attemptState()).toBe('unresolved');
    expect(confirm()).toBeInTheDocument();
    server.discardAllow.owner = true;
    fakeClock();
    server.retryAfter = '3';
    server.discards.push(429);
    fireEvent.click(screen.getByTestId('draft-discard-check'));
    await until(() => expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent('Too many requests. Wait 3 seconds.'));
    expect(screen.getByTestId('draft-discard-check')).toBeDisabled();
    expect(screen.getByTestId('draft-discard-check')).toHaveAccessibleDescription(HOLD_TEXT.waiting);
    const sent = server.sent.length;
    await advance(3_000);
    await settle();
    expect(screen.getByTestId('draft-discard-check')).toBeEnabled();
    expect(server.sent).toHaveLength(sent);
    vi.useRealTimers();
    await click('draft-discard-check');
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
    expect(server.discardPosts()).toHaveLength(6);
    expect(new Set(server.discardPosts().map((x) => `${x.headers.get('idempotency-key')} ${x.headers.get('x-tmpos-session-csrf')} ${x.body}`)).size).toBe(1);
    expect(r.keys).toHaveLength(1);
  });

  it.each(['the wall clock', 'the monotonic clock', 'the session check (judged again right before the POST)'] as const)('SID-127. DSC-13: past the 23-hour cutoff on %s, Check again sends nothing and says the attempt is too old (no Check again any more); closing it then closes both dialogs', async (arm) => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5), 250, 2);
    const r = rig(server);
    const real = r.props().session!;
    let bump = false;
    const session: TenantSessionClient = { ...real, ensure: async (...args) => { const s = await real.ensure(...args); if (bump) { bump = false; r.clock.wall += 23 * HOUR; } return s; } };
    render(<ServerInvoiceDrafts {...r.props({ session })} />);
    await showAndChoose(STORE_1);
    await openConfirm(server);
    server.discards.push(503);
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    if (arm === 'the wall clock') r.clock.wall += 23 * HOUR;
    else if (arm === 'the monotonic clock') r.clock.mono += 23 * HOUR;
    else { r.clock.wall += 23 * HOUR - 1; bump = true; } // just under: the press passes, the session check takes it over
    await click('draft-discard-check');
    await settle();
    expect(screen.getByTestId('draft-discard-attempt')).toHaveTextContent(DISCARD_TEXT.tooOld);
    expect(screen.queryByTestId('draft-discard-check')).toBeNull();
    expect(server.discardPosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    await click('draft-discard-keep');
    await settle();
    expect([confirm(), view()]).toEqual([null, null]);
  });

  it('SID-128. DSC-13, DSC-14: a Check again whose session check finds ANOTHER token (another tab\'s session) sends nothing: the new generation drops the attempt and both dialogs at once', async () => {
    const { server, r } = await ready();
    await openConfirm(server);
    server.discards.push(503);
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.otherTab('uid-a');
    await click('draft-discard-check');
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    expect([confirm(), view()]).toEqual([null, null]);
    await settle();
    expect(server.discardPosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it.each(['Close', 'Escape'] as const)('SID-129. DSC-14, DSC-21: closing a confirmation whose attempt is unresolved (%s) closes the reopen dialog too and reads page one again — saying neither "cancelled" nor "discarded"; reopening the draft never revives the attempt: a fresh eligibility, the version a fresh read found, a NEW key', async (how) => {
    const { server, ada, draft, r } = await ready();
    await openConfirm(server);
    server.discards.push('lose-before'); // it never reached the server
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    const mark = server.sent.length;
    if (how === 'Close') await click('draft-discard-keep');
    else await user().keyboard('{Escape}');
    await settle();
    expect([confirm(), view()]).toEqual([null, null]);
    await listReady();
    await settle();
    expect(pageOneReads(server, mark)).toHaveLength(1);
    expect(server.sent.slice(mark).filter((x) => x.method !== 'GET')).toEqual([]);
    expect(document.body.textContent).not.toMatch(/cancel|discarded/i);
    expect(notice()).toBeNull();
    expect(rows().map((x) => x.getAttribute('data-id'))).toContain(draft.id); // it was not discarded
    expect(document.activeElement).toBe(within(rows()[0]).getByTestId('drafts-open')); // back where the draft was opened
    server.editDraft(draft, ada, [{ description: 'Elsewhere', quantity: 1, unitPriceCents: 100 }]); // version 4
    const asked = server.discardEligReads().length;
    await openConfirm(server);
    expect(server.discardEligReads()).toHaveLength(asked + 1);
    expect(screen.queryByTestId('draft-discard-attempt')).toBeNull();
    expect(screen.getByTestId('draft-discard-keep')).toHaveTextContent('Keep draft');
    expect(screen.getByTestId('draft-discard-identity')).toHaveTextContent('version 4');
    await click('draft-discard-send');
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
    const [lost, fresh] = server.discardPosts();
    expect(fresh.headers.get('idempotency-key')).not.toBe(lost.headers.get('idempotency-key'));
    expect(fresh.body).toBe(discardBody(TENANT_A, 4));
    expect(r.keys).toHaveLength(2);
  });

  it('SID-130. DSC-14: a sign-out while a discard is out drops the attempt and BOTH dialogs at once (the sign-out\'s own render); the late 200 — the server DID discard it — changes nothing: no notice, no read; after Reconnect the list is read again and the draft is not in it', async () => {
    const { server, props, draft } = await ready();
    await openConfirm(server);
    server.hold.discard = 1;
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    const mark = server.sent.length;
    let during: unknown = 'not sampled';
    // Sampled inside the sign-out call itself, before anything else runs.
    await act(async () => { void props.session!.logout(); during = [confirm(), view()]; });
    expect(during).toEqual([null, null]);
    await release(server);
    await settle();
    expect(draft.status).toBe('discarded');
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(notice()).toBeNull();
    expect([confirm(), view()]).toEqual([null, null]);
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    server.expire();
    await click('drafts-retry'); // Reconnect
    await showAndChoose(STORE_1);
    expect(rows().map((x) => x.getAttribute('data-id'))).not.toContain(draft.id);
    expect([confirm(), view(), notice()]).toEqual([null, null, null]);
    expect(server.discardPosts()).toHaveLength(1);
  });

  it.each([
    'a new generation (another tab\'s session, noticed on focus)',
    'a session end (found by the focus check)',
    'a store change',
    'a user change',
  ] as const)('SID-131. DSC-14: %s while a discard is out drops the attempt and both dialogs at once; the late 200 changes nothing — no notice, no read, nothing of the attempt', async (change) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, draft, r, page } = await ready();
    server.stores['uid-b'] = [store(STORE_2, 'B Store', false, TENANT_B)];
    await openConfirm(server);
    server.hold.discard = 1;
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    if (change === 'a new generation (another tab\'s session, noticed on focus)') {
      server.otherTab('uid-a');
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    } else if (change === 'a session end (found by the focus check)') {
      server.expire();
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    } else if (change === 'a store change') {
      fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
      expect([confirm(), view()]).toEqual([null, null]); // at once
      await listReady();
    } else {
      page.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-b' })} />);
    }
    expect([confirm(), view()]).toEqual([null, null]);
    await settle();
    const out = server.sent.length;
    await release(server);
    await settle();
    expect(draft.status).toBe('discarded');
    expect(server.sent.slice(out)).toEqual([]);
    expect(notice()).toBeNull();
    expect(document.body).not.toHaveTextContent(DISCARD_TEXT.discarded);
    expect([confirm(), view(), screen.queryByTestId('draft-discard-attempt')]).toEqual([null, null, null]);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-132. DSC-20: a discard writes no browser storage (local or session) and logs nothing — its key, body and token stay in memory, never in the DOM — through an unresolved attempt, its Check again and the confirmed discard', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const { server, r } = await ready();
    await openConfirm(server);
    server.discards.push(503);
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(document.body.innerHTML).not.toContain('s'.repeat(40)); // no session token in the DOM
    expect(document.body.innerHTML).not.toContain(r.keys[0]); // nor the key
    expect(document.body.innerHTML).not.toContain('expectedVersion');
    await click('draft-discard-check');
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
    expect(setItem).not.toHaveBeenCalled();
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(r.keys[0]);
  });

  it('SID-133. edge (the version bound, as SID-100): a draft at the largest version the server records (2^53-1) cannot be discarded — no discard can name it: the press says so in an alert, and no key is minted and nothing is sent', async () => {
    const { server, draft, r } = await ready();
    draft.version = Number.MAX_SAFE_INTEGER;
    await openConfirm(server);
    expect(screen.getByTestId('draft-discard-identity')).toHaveTextContent(`version ${Number.MAX_SAFE_INTEGER}`);
    const sent = server.sent.length;
    await click('draft-discard-send');
    await waitFor(() => expect(screen.getByTestId('draft-discard-status')).toHaveTextContent(DISCARD_TEXT.last));
    expect(screen.getByTestId('draft-discard-status')).toHaveAttribute('role', 'alert');
    expect(server.sent.slice(sent)).toEqual([]);
    expect(r.keys).toEqual([]);
    expect(screen.queryByTestId('draft-discard-attempt')).toBeNull();
  });

  it('SID-134. DSC-14: closing the confirmation while its POST is still out (the server has decided it, its answer not yet back) stops tracking it: both dialogs close and page one is read again at once — the draft is not in it, and nothing says it was discarded; the late 200 then changes nothing (no notice, no read)', async () => {
    const { server, draft, r } = await ready();
    await openConfirm(server);
    server.hold.discard = 1;
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    expect(screen.getByTestId('draft-discard-keep')).toHaveAccessibleDescription(DISCARD_TEXT.closeWarning);
    const mark = server.sent.length;
    await click('draft-discard-keep');
    await listReady();
    await settle();
    expect([confirm(), view()]).toEqual([null, null]);
    expect(pageOneReads(server, mark)).toHaveLength(1);
    expect(rows().map((x) => x.getAttribute('data-id'))).not.toContain(draft.id); // the server's list, not a claim of this attempt
    expect(notice()).toBeNull();
    const out = server.sent.length;
    await release(server);
    await settle();
    expect(draft.status).toBe('discarded');
    expect(server.sent.slice(out)).toEqual([]);
    expect(notice()).toBeNull();
    expect(document.body.textContent).not.toMatch(/cancel|discarded/i);
    expect([confirm(), view()]).toEqual([null, null]);
    expect(server.discardPosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-135. DSC-06, DSC-21: a second stale version in a row is announced again: a new confirmation takes the earlier refusal\'s line away (inert beneath it), and the next sealed 409 mounts the reopen dialog\'s alert afresh', async () => {
    const { server, ada, draft, r } = await ready();
    await openConfirm(server);
    server.editDraft(draft, ada, [{ description: 'Elsewhere', quantity: 1, unitPriceCents: 100 }]); // version 4, elsewhere
    await click('draft-discard-send');
    await waitFor(() => expect(screen.getByTestId('draft-view-discard-refused')).toHaveTextContent(DISCARD_REFUSED_TEXT.conflict));
    const first = screen.getByTestId('draft-view-discard-refused');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('draft-discard-open')));
    await click('draft-discard-open');
    await waitFor(() => expect(confirm()).toBeInTheDocument());
    expect(screen.queryByTestId('draft-view-discard-refused')).toBeNull(); // the earlier refusal's line went with the new confirmation
    server.editDraft(draft, ada, [{ description: 'Again', quantity: 2, unitPriceCents: 100 }]); // version 5, elsewhere again
    await click('draft-discard-send');
    await waitFor(() => expect(screen.getByTestId('draft-view-discard-refused')).toHaveTextContent(DISCARD_REFUSED_TEXT.conflict));
    const second = screen.getByTestId('draft-view-discard-refused');
    expect(second).toHaveAttribute('role', 'alert');
    expect(second).not.toBe(first); // mounted afresh, so announced again
    expect(confirm()).toBeNull();
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toHaveTextContent('5'));
    expect(server.discardPosts().map((x) => x.body)).toEqual([discardBody(TENANT_A, 3), discardBody(TENANT_A, 4)]);
    expect(r.keys).toHaveLength(2);
    expect(draft.status).toBeUndefined();
  });

  it('SID-136. DSC-14: closing an unresolved confirmation during a rate limit\'s wait (its Check again answered 429) closes both dialogs; page one, not read during the wait, keeps its rows marked last known with the wait and a Try again held back through it — nothing is sent, then or when the wait has passed', async () => {
    const { server, draft, r } = await ready();
    await openConfirm(server);
    server.discards.push(503);
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    fakeClock();
    server.retryAfter = '3';
    server.discards.push(429);
    fireEvent.click(screen.getByTestId('draft-discard-check'));
    await until(() => expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent('Too many requests. Wait 3 seconds.'));
    expect(screen.getByTestId('draft-discard-check')).toBeDisabled();
    const sent = server.sent.length;
    fireEvent.click(screen.getByTestId('draft-discard-keep'));
    await until(() => expect([confirm(), view()]).toEqual([null, null]));
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited');
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent(pickerWaitText(3));
    expect(screen.getByTestId('drafts-last-known')).toBeInTheDocument();
    expect(rows().map((x) => x.getAttribute('data-id'))).toContain(draft.id);
    expect(screen.getByTestId('drafts-list-retry')).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/cancel|discarded/i);
    await advance(3_000);
    await settle();
    expect(screen.getByTestId('drafts-list-retry')).toBeEnabled();
    expect(server.sent).toHaveLength(sent);
    expect(server.discardPosts()).toHaveLength(2);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-137. DSC-21: during a rate limit\'s wait begun elsewhere (the edit\'s eligibility answered 429), a confirmation\'s Discard draft is held back and says why beside it — visibly, and as its description; nothing is sent', async () => {
    const { server, r } = await ready();
    server.retryAfter = '30';
    server.editEligStatus.push(429);
    await openDraft(server);
    expect(screen.getByTestId('draft-view-edit-state')).toHaveAttribute('data-phase', 'rate-limited');
    await click('draft-discard-open');
    await waitFor(() => expect(confirm()).toBeInTheDocument());
    const send = screen.getByTestId('draft-discard-send');
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(DISCARD_TEXT.sendWaiting);
    const why = within(confirm()!).getByText(DISCARD_TEXT.sendWaiting);
    expect(why.id).toBe('draft-discard-send-wait');
    expect(why).not.toHaveClass('sr-only'); // shown beside it, not only to a screen reader
    fireEvent.click(send);
    await settle();
    expect(server.discardPosts()).toEqual([]);
    expect(r.keys).toEqual([]);
  });

  it('SID-138. DSC-21: after a stale version, focus the user moved to Edit draft while the reopen dialog settled stays there — the discard eligibility answering last takes focus only from an unmoved Close', async () => {
    const { server, ada, draft } = await ready();
    await openConfirm(server);
    server.editDraft(draft, ada, [{ description: 'Elsewhere', quantity: 1, unitPriceCents: 100 }]); // version 4, elsewhere
    server.hold.discardElig = 1; // the re-read's discard eligibility answers last
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discardElig']));
    await waitFor(() => expect(screen.getByTestId('draft-view-edit')).toBeEnabled());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('draft-view-close')));
    const edit = screen.getByTestId('draft-view-edit');
    act(() => edit.focus());
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-discard-open')).toBeInTheDocument());
    await settle();
    expect(document.activeElement).toBe(edit);
  });

  it('SID-139. DSC-19: when neither the edit\'s nor the discard\'s eligibility could be asked, their two Try again buttons have distinct accessible names, each starting with its visible words; the discard\'s keeps its description', async () => {
    const { server } = await ready();
    server.editEligStatus.push(503);
    server.discardEligStatus.push(503);
    await openDraft(server);
    const dialog = screen.getByTestId('draft-view');
    const edit = within(dialog).getByRole('button', { name: 'Try again: can this draft be edited' });
    const discard = within(dialog).getByRole('button', { name: 'Try again: can this draft be discarded' });
    expect(edit).toBe(screen.getByTestId('draft-view-edit-retry'));
    expect(discard).toBe(screen.getByTestId('draft-discard-elig-again'));
    for (const button of [edit, discard]) expect(button).toHaveTextContent('Try again');
    expect(discard).toHaveAccessibleDescription(DISCARD_ELIGIBILITY_TEXT.unavailable);
    expect(within(dialog).queryAllByRole('button', { name: 'Try again' })).toEqual([]);
  });

  it.each([
    ['the chain\'s 409 write_conflict (another tenant now)', () => refusal(409, 'write_conflict'), 'tenant-changed', ''],
    ['the chain\'s 422 (the key used for another request)', () => refusal(422, 'idempotency_key_reused'), 'key-reused', ''],
    ['400 (a request the server does not accept)', () => refusal(400, 'invalid_request'), null, 'The server did not accept this check.'],
    ['the chain\'s 409 request_in_progress', () => refusal(409, 'request_in_progress'), null, 'The server is still working on it. Check again in a moment.'],
  ] as const)('SID-140. DSC-13: a Check again answered with %s: only an answer that decides the request ends the attempt, with its own alert — never "Draft discarded." — and any other leaves it unresolved with its reason and Check again offered; every POST is the same key and bytes', async (_what, answer, decided, note) => {
    const { server, r } = await ready();
    await openConfirm(server);
    server.discards.push(503, answer());
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('draft-discard-check');
    await waitFor(() => expect(server.discardPosts()).toHaveLength(2));
    await waitFor(() => expect(attemptState()).not.toBe('checking'));
    await settle();
    if (decided !== null) {
      expect(screen.getByTestId('draft-discard-status')).toHaveTextContent(DISCARD_REFUSED_TEXT[decided]);
      expect(screen.getByTestId('draft-discard-status')).toHaveAttribute('role', 'alert');
      expect([screen.queryByTestId('draft-discard-attempt'), screen.queryByTestId('draft-discard-check')]).toEqual([null, null]);
    } else {
      expect(attemptState()).toBe('unresolved');
      expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent(note);
      expect(screen.getByTestId('draft-discard-check')).toBeEnabled();
      expect(screen.queryByTestId('draft-discard-status')).toBeNull();
    }
    expect(document.body).not.toHaveTextContent(DISCARD_TEXT.discarded);
    expect(notice()).toBeNull();
    expect(new Set(server.discardPosts().map((x) => `${x.headers.get('idempotency-key')} ${x.body}`)).size).toBe(1);
    expect(r.keys).toHaveLength(1);
  });

  it.each([
    ['changed on the server (the sealed 409 write_conflict)', 'conflict'],
    ['discarded elsewhere (the sealed 409 invalid_state)', 'not-open'],
  ] as const)('SID-141. DSC-06, DSC-10, DSC-13: a Check again the server decides as a draft %s is never "Draft discarded.": a stale version reads the draft again and says so in the reopen dialog; a draft no longer open closes both dialogs and says so', async (_what, kind) => {
    const { server, ada, draft, r } = await ready();
    await openConfirm(server);
    server.discards.push(503);
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    if (kind === 'conflict') server.editDraft(draft, ada, [{ description: 'Elsewhere', quantity: 1, unitPriceCents: 100 }]);
    else { draft.status = 'discarded'; draft.version += 1; }
    await click('draft-discard-check');
    if (kind === 'conflict') {
      await waitFor(() => expect(screen.getByTestId('draft-view-discard-refused')).toHaveTextContent(DISCARD_REFUSED_TEXT.conflict));
      expect(confirm()).toBeNull();
      await waitFor(() => expect(screen.getByTestId('draft-view-version')).toHaveTextContent('4'));
    } else {
      await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_REFUSED_TEXT['not-open']));
      expect([confirm(), view()]).toEqual([null, null]);
    }
    await settle();
    expect(document.body).not.toHaveTextContent(DISCARD_TEXT.discarded);
    const [first, again] = server.discardPosts();
    expect([again.body, again.headers.get('idempotency-key')]).toEqual([first.body, first.headers.get('idempotency-key')]);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-142. DSC-13, DSC-21: a POST refused 403 is a refusal of access ONLY when its one fresh session check confirms the same session — a first send whose check cannot answer says so (never "may not discard"), a Check again\'s 403 whose check cannot answer stays unresolved with that check\'s own note, and a first send whose check is rate-limited starts the wait and says so', async () => {
    const { server, r } = await ready();
    // A first send refused 403 whose fresh check cannot answer (503).
    await openConfirm(server);
    server.discardAllow.owner = false;
    server.hold.discard = 1;
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    server.currentStatus.push(503); // the fresh check after the 403
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-discard-status')).toHaveTextContent(DISCARD_TEXT.refusedUnchecked));
    expect(screen.getByTestId('draft-discard-status')).toHaveAttribute('role', 'alert');
    expect(document.body).not.toHaveTextContent(DISCARD_REFUSED_TEXT.denied);
    expect(screen.queryByTestId('draft-discard-attempt')).toBeNull();
    await click('draft-discard-keep');
    await listReady();
    // A Check again's 403 whose fresh check cannot answer: unresolved, with that check's own note.
    server.discardAllow.owner = true;
    await openConfirm(server);
    server.discards.push(503);
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.discardAllow.owner = false;
    server.hold.discard = 1;
    await click('draft-discard-check');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    server.currentStatus.push(503);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent(EDIT_TEXT.checkUnchecked));
    expect(attemptState()).toBe('unresolved');
    expect(screen.getByTestId('draft-discard-check')).toBeEnabled();
    await click('draft-discard-keep');
    await listReady();
    // A first send refused 403 whose fresh check is rate-limited: the wait starts, and the alert says to wait.
    server.discardAllow.owner = true;
    await openConfirm(server);
    server.discardAllow.owner = false;
    server.hold.discard = 1;
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    server.retryAfter = '30';
    server.currentStatus.push(429);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-discard-status')).toHaveTextContent(DISCARD_REFUSED_TEXT['rate-limited']));
    expect(document.body).not.toHaveTextContent(DISCARD_REFUSED_TEXT.denied);
    await settle();
    expect(server.discardPosts()).toHaveLength(4);
    expect(r.keys).toHaveLength(3);
  });

  it('SID-143. DSC-13: while a Check again is out its attempt says "Checking the discard with the server…" in its status and offers no Check again; a Check again whose own session check is refused 429 sends nothing and says "Not checked." — the attempt stays unresolved', async () => {
    const { server, r } = await ready();
    await openConfirm(server);
    server.discards.push(503);
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.hold.discard = 1;
    await click('draft-discard-check');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    expect(attemptState()).toBe('checking');
    expect(within(screen.getByTestId('draft-discard-attempt')).getByRole('status')).toHaveTextContent(DISCARD_TEXT.checking);
    expect(screen.queryByTestId('draft-discard-check')).toBeNull();
    await release(server, 0, refusal(503, 'service_unavailable'));
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.hold.current = 1;
    await click('draft-discard-check');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
    await release(server, 0, refusal(429, 'rate_limited'));
    await waitFor(() => expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent(/^Not checked\./));
    expect(attemptState()).toBe('unresolved');
    expect(server.discardPosts()).toHaveLength(2);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-144. DSC-13: a Check again that finds a rate limit\'s wait begun while its session check was out (the edit\'s eligibility answered 429 meanwhile) sends nothing and says "Not checked." with the wait; Check again is held back through it', async () => {
    const { server, r } = await ready();
    server.hold.editElig = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['editElig']));
    await waitFor(() => expect(screen.getByTestId('draft-discard-open')).toBeEnabled());
    await click('draft-discard-open');
    await waitFor(() => expect(confirm()).toBeInTheDocument());
    server.discards.push(503);
    await click('draft-discard-send');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.hold.current = 1;
    await click('draft-discard-check');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['editElig', 'current']));
    await release(server, 0, refusal(429, 'rate_limited'));
    await waitFor(() => expect(screen.getByTestId('draft-view-edit-state')).toHaveAttribute('data-phase', 'rate-limited'));
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-discard-attempt-note')).toHaveTextContent(/^Not checked\. Too many requests\./));
    expect(attemptState()).toBe('unresolved');
    expect(screen.getByTestId('draft-discard-check')).toBeDisabled();
    expect(server.discardPosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-145. DSC-14: a late answer to an EARLIER confirmation\'s POST — closed while it was out — changes nothing in a NEW confirmation whose own POST is out: an answer settles only its own key, and the new attempt is settled by its own answer', async () => {
    const { server, ada, draft, r } = await ready();
    await openConfirm(server);
    server.editDraft(draft, ada, [{ description: 'Elsewhere', quantity: 1, unitPriceCents: 100 }]); // version 4: the first POST does not discard it
    server.hold.discard = 1;
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    await click('draft-discard-keep');
    await listReady();
    await settle();
    expect([confirm(), view()]).toEqual([null, null]);
    expect(rows().map((x) => x.getAttribute('data-id'))).toContain(draft.id);
    await openConfirm(server);
    expect(screen.getByTestId('draft-discard-identity')).toHaveTextContent('version 4');
    server.hold.discard = 1;
    await click('draft-discard-send');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard', 'discard']));
    const sent = server.sent.length;
    // The first POST's answer arrives now: a 200 that is valid for IT (version 3, plus one) — never for this attempt.
    await release(server, 0, new Response(JSON.stringify({ draftId: draft.id, version: 4, status: 'discarded' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await settle();
    expect(confirm()).toBeInTheDocument();
    expect(attemptState()).toBe('sending');
    expect(notice()).toBeNull();
    expect(screen.queryByTestId('draft-view-discard-refused')).toBeNull();
    expect(server.sent.slice(sent)).toEqual([]);
    await release(server);
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
    const [earlier, fresh] = server.discardPosts();
    expect(fresh.headers.get('idempotency-key')).not.toBe(earlier.headers.get('idempotency-key'));
    expect([earlier.body, fresh.body]).toEqual([discardBody(TENANT_A, 3), discardBody(TENANT_A, 4)]);
    expect(r.keys).toHaveLength(2);
    expect([draft.status, draft.version]).toEqual(['discarded', 5]);
  });

  it('SID-146. DSC-21: two activations of Discard draft delivered before React commits the first (one task) are still ONE POST under ONE key: the press is held in a ref, not only in a render', async () => {
    const { server, r } = await ready();
    await openConfirm(server);
    server.hold.discard = 1;
    const send = screen.getByTestId('draft-discard-send');
    await act(async () => { send.click(); send.click(); }); // both before React commits: the button not yet disabled
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['discard']));
    await settle();
    expect(server.discardPosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    await release(server);
    await waitFor(() => expect(notice()).toHaveTextContent(DISCARD_TEXT.discarded));
  });

  it('SID-147. DSC-07 (the shop\'s side of the reverse order): an editor opened before another session discarded the draft cannot save it — the sealed 409 invalid_state says "Not saved: this draft can no longer be edited." in an alert, never Saved and never unresolved; nothing is sent again or read back', async () => {
    const { server, draft } = await ready();
    await openDraft(server);
    await click('draft-view-edit');
    await waitFor(() => expect(screen.getByTestId('draft-edit')).toBeInTheDocument());
    draft.status = 'discarded'; // another session discarded it
    draft.version += 1;
    fireEvent.change(screen.getAllByTestId('draft-edit-description')[0], { target: { value: 'Late line' } });
    const mark = server.sent.length;
    await click('draft-edit-save');
    await waitFor(() => expect(screen.getByTestId('draft-edit-status')).toHaveTextContent(EDIT_REFUSED_TEXT['not-editable']));
    expect(screen.getByTestId('draft-edit-status')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('draft-edit-attempt')).toBeNull();
    await settle();
    expect(server.patches()).toHaveLength(1);
    expect(screen.queryByTestId('draft-view-saved')).toBeNull();
    expect(server.detailReads(STORE_1, draft.id).filter((x) => server.sent.indexOf(x) >= mark)).toEqual([]);
  });
});

describe('Server drafts — issuing a saved draft (M7B-INVOICES-ISSUE-P2)', () => {
  const release = async (server: Server, i = 0, late?: Response) => { const [held] = server.held.splice(i, 1); await act(async () => { held.release(late); }); };
  const confirm = () => screen.queryByTestId('draft-issue-confirm');
  const view = () => screen.queryByTestId('draft-view');
  const card = () => screen.getByTestId('drafts-issue-hold');
  const cardState = () => card().getAttribute('data-state');
  const cardText = () => screen.getByTestId('drafts-issue-hold-status').textContent;
  const attemptState = () => screen.queryByTestId('draft-issue-attempt')?.getAttribute('data-state') ?? 'none';
  const previewPhase = () => screen.queryByTestId('draft-issue-preview-state')?.getAttribute('data-phase') ?? 'none';
  const heading = () => screen.getByRole('heading', { name: 'Server drafts' });
  const issueBody = (tenant: string, version: number, settings: number, customer: number) =>
    `{"expectedTenant":"${tenant}","expectedVersion":${version},"expectedSettingsVersion":${settings},"expectedCustomerVersion":${customer}}`;
  /** A whole answer as the server writes it: a sealed refusal is exactly { error }, the chain's { error, requestId }. */
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
  /** Open the listed draft at `index`; wait for its read, the three eligibilities' answers and the customer's name. */
  async function openDraft(server: Server, index = 0) {
    const asked = server.issueEligReads().length;
    await user().click(within(rows()[index]).getByTestId('drafts-open'));
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('draft-view-edit-state')).not.toHaveAttribute('data-phase', 'checking'));
    await waitFor(() => expect(server.issueEligReads()).toHaveLength(asked + 1));
    await settle();
    await waitFor(() => expect(screen.getByTestId('draft-view-customer')).not.toHaveTextContent('ID ending'));
  }
  /** Open the draft, then its issue confirmation; wait until the preview has answered (first focus on Keep draft — or on the preview's refusal, which takes it: review C7). */
  async function openIssue(server: Server, index = 0) {
    await openDraft(server, index);
    await click('draft-issue-open');
    await waitFor(() => expect(confirm()).toBeInTheDocument());
    await waitFor(() => expect([screen.getByTestId('draft-issue-keep'), screen.queryByTestId('draft-issue-preview-refused')]).toContain(document.activeElement));
    await waitFor(() => expect(['opening', 'loading']).not.toContain(previewPhase()));
  }
  /** uid-a's draft at Main Street: Item 1 and Item 2, one each at $2.50, for Ada, at version 3; the store's settings at 8.875 %. */
  async function ready(over: Partial<ServerInvoiceDraftsProps> = {}, settings: Partial<Settings> | null = {}, more: (server: Server, ada: string) => void = () => {}) {
    const { server, ada, bea } = seeded();
    const draft = server.seedDraft(STORE_1, ada, at(5), 250, 2);
    draft.version = 3;
    if (settings !== null) server.configure(STORE_1, settings);
    more(server, ada);
    const r = rig(server);
    const props = r.props(over);
    const page = render(<ServerInvoiceDrafts {...props} />);
    await showAndChoose(STORE_1);
    return { server, ada, bea, draft, r, props, page };
  }
  /** Press Issue invoice (as a user does). */
  async function pressIssue() { await user().click(screen.getByTestId('draft-issue-send')); }
  /** Another session issued `d` at its store (its invoice recorded, the draft closed): what this page's review does not know. */
  function issueElsewhere(server: Server, d: Draft): void {
    const settings = server.settings.get(d.storeId)!;
    const number = (server.counters.get(d.storeId) ?? 0) + 1;
    server.counters.set(d.storeId, number);
    const c = server.customers.get(d.customerId)!;
    const { version: sv, tax: _tax, ...seller } = settings;
    server.invoices.push({
      id: uuid(0xe00 + server.invoices.length + 1), storeId: d.storeId, number, sourceDraftId: d.id, sourceVersion: d.version, customerId: d.customerId, customerName: c.name,
      customerVersion: c.version ?? 1, settingsVersion: sv, seller, lines: d.lines, amounts: server.amountsOf(d.subtotalCents, settings.tax).amounts, issuedAt: at(server.second++, 654321),
    });
    d.status = 'issued';
    d.version += 1;
  }

  it('SID-148. AC-03 AC-04: Issue invoice… is offered ONLY on the server\'s own issue eligibility for exactly this draft, store and session — absent and unsaid while it is asked (its row already holds its height) and when it is refused; one issue-eligibility GET per open, carrying that session\'s token and nothing else; an outage offers one Try again named "Try again: can this draft be issued" (one GET per press); none at a read-only store; nothing is previewed or POSTed', async () => {
    const { server, draft } = await ready();
    const ro = server.seedDraft(STORE_RO, draft.customerId, at(6));
    server.hold.issueElig = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issueElig']));
    await waitFor(() => expect(screen.getByTestId('draft-discard-open')).toBeInTheDocument());
    const dialog = screen.getByTestId('draft-view');
    expect(screen.queryByTestId('draft-issue-open')).toBeNull();
    // Its row is there, below the discard's, holding one control's height from the asking on: its answer moves nothing above it.
    const row = within(dialog).getByTestId('draft-issue-row');
    expect(row).toHaveClass('min-h-[2.125rem]');
    expect(row.textContent).toBe('');
    expect(within(dialog).getByTestId('draft-discard-row').nextElementSibling).toBe(row);
    expect(dialog.textContent).not.toMatch(/issue/i);
    expect(within(dialog).queryAllByRole('status').map((x) => x.textContent)).toEqual(['']); // still the edit's live region only
    const asked = server.issueEligReads();
    expect(asked.map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${issueEligibilityPathOf(STORE_1, draft.id)}`]);
    expect(asked[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}/);
    expect([asked[0].headers.get('x-tmpos-csrf'), asked[0].headers.get('idempotency-key'), asked[0].body]).toEqual([null, null, undefined]);
    await release(server);
    await waitFor(() => expect(screen.getByTestId('draft-issue-open')).toBeEnabled());
    expect(row).toContainElement(screen.getByTestId('draft-issue-open'));
    expect(screen.getByTestId('draft-issue-open')).toHaveTextContent(ISSUE_TEXT.open);
    await click('draft-view-close');
    // Refused (a role below Approve): nothing shown or said for it, after ONE fresh session check.
    server.issueAllow.owner = false;
    const mark = server.sent.length;
    await openDraft(server);
    expect(screen.queryByTestId('draft-issue-open')).toBeNull();
    expect(screen.queryByTestId('draft-issue-elig-again')).toBeNull();
    expect(screen.getByTestId('draft-view').textContent).not.toMatch(/issue/i);
    const after = server.sent.slice(mark);
    const refusedAt = after.findIndex((x) => x.url.endsWith('/issue-eligibility'));
    expect(after.slice(refusedAt + 1).filter((x) => x.url === TENANT_SESSION_PATHS.current).length).toBeGreaterThanOrEqual(1);
    expect(after.filter((x) => x.url.endsWith('/issue-eligibility'))).toHaveLength(1); // never asked again on its own
    await click('draft-view-close');
    // An outage: one Try again, described by why, one GET per press; the server's allowance then offers Issue invoice….
    server.issueAllow.owner = true;
    server.issueEligStatus.push(503);
    await openDraft(server);
    const again = screen.getByTestId('draft-issue-elig-again');
    expect(again).toHaveAccessibleName('Try again: can this draft be issued');
    expect(again).toHaveAccessibleDescription(ISSUE_ELIGIBILITY_TEXT.unavailable);
    const before = server.issueEligReads().length;
    await click('draft-issue-elig-again');
    await waitFor(() => expect(screen.getByTestId('draft-issue-open')).toBeEnabled());
    expect(server.issueEligReads()).toHaveLength(before + 1);
    await click('draft-view-close');
    // A read-only store asks nothing and offers nothing.
    fireEvent.change(storeSelect(), { target: { value: STORE_RO } });
    await listReady();
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(screen.getByTestId('draft-view-version')).toHaveTextContent('1'));
    await settle();
    expect(screen.queryByTestId('draft-issue-open')).toBeNull();
    expect(server.issueEligReads().filter((x) => x.url.includes(ro.id))).toEqual([]);
    expect([server.previewReads(), server.issuePosts()]).toEqual([[], []]);
  });

  it('SID-149. AC-04 ISS-23: the confirmation is an alertdialog named "Issue this invoice?", described by ONE consequence sentence (the Total the preview answered; that an issued invoice can later be voided, keeping its number and contents — VOID-P2, was "Void is not available."; no payment), first focus on Keep draft; opening it is ONE preview GET and no POST, and it shows only what that preview answered — the seller, the store name and address, the tax registration ID, the customer as the server holds it now (renamed since the reopen), the lines and version the server holds now (edited since), Subtotal, "Tax (8.875%)" and the Total — never a number or a time; Keep draft and Escape close it with nothing sent and give focus back to Issue invoice…; Tab stays inside', async () => {
    const { server, ada, draft } = await ready();
    await openDraft(server);
    // Since the reopen read: the customer renamed and the draft edited elsewhere — the review must be the server's now.
    server.customers.get(ada)!.name = 'Ada Renamed';
    server.customers.get(ada)!.version = 2;
    server.editDraft(draft, ada, [{ description: 'Screen repair', quantity: 1, unitPriceCents: 1999 }]); // version 4
    const mark = server.sent.length;
    await click('draft-issue-open');
    await waitFor(() => expect(previewPhase()).toBe('ready'));
    const dialog = confirm()!;
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(ISSUE_TEXT.title);
    expect(dialog.getAttribute('aria-describedby')!.split(' ')).toHaveLength(1);
    expect(dialog).toHaveAccessibleDescription(ISSUE_TEXT.consequence('$21.76'));
    // VOID-P2 supersession (was /Void is not available\. It does not record a payment\.$/): voiding exists now, so the
    // sentence says an issued invoice can later be voided (number and contents kept) — and still records no payment.
    expect(ISSUE_TEXT.consequence('$21.76')).toBe("This issues the store's next invoice number for $21.76; it closes the draft and cannot be changed or undone in the product. An issued invoice can later be voided, which keeps its number and contents. It does not record a payment.");
    expect(ISSUE_TEXT.consequence('$21.76')).not.toMatch(/Void is not available/);
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-keep'));
    expect(screen.getByTestId('draft-issue-keep')).toHaveTextContent('Keep draft');
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${issuePreviewPathOf(STORE_1, draft.id)}`]);
    expect(within(dialog).getByTestId('draft-issue-preview-seller-legal')).toHaveTextContent('Example Repairs LLC');
    expect(within(dialog).getByTestId('draft-issue-preview-seller-store')).toHaveTextContent('Main Street Shop');
    expect(within(dialog).getByTestId('draft-issue-preview-seller-address').textContent).toBe('1 Main St\nSpringfield');
    expect(within(dialog).getByTestId('draft-issue-preview-seller-tax-id')).toHaveTextContent('Tax registration ID TX-1');
    expect(within(dialog).getByTestId('draft-issue-preview-customer').querySelector('bdi')).toHaveTextContent('Ada Renamed');
    expect(within(dialog).getAllByTestId('draft-issue-preview-line').map((tr) => [...(tr as HTMLTableRowElement).cells].map((td) => td.textContent))).toEqual([['1', 'Screen repair', '1', '$19.99', '$19.99']]);
    expect(within(dialog).getByTestId('draft-issue-preview-subtotal')).toHaveTextContent('Subtotal $19.99');
    expect(within(dialog).getByTestId('draft-issue-preview-tax')).toHaveTextContent('Tax (8.875%) $1.77');
    expect(within(dialog).getByTestId('draft-issue-preview-total')).toHaveTextContent('Total $21.76');
    expect(within(dialog).getByRole('region', { name: 'Invoice lines' })).toHaveAttribute('tabindex', '0');
    expect(dialog.textContent).not.toMatch(/Invoice \d|UTC|paid|due|balance|deposit|receivable/i);
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep draft', 'Issue invoice']);
    expect(screen.getByTestId('draft-view').closest('[inert]')).not.toBeNull();
    await user().tab();
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-preview-lines-scroll'));
    await user().tab();
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-send'));
    await user().tab();
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-keep')); // wraps inside
    const sent = server.sent.length;
    await user().keyboard('{Escape}');
    await settle();
    expect(confirm()).toBeNull();
    expect(view()).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-open'));
    await click('draft-issue-open');
    await waitFor(() => expect(previewPhase()).toBe('ready'));
    await click('draft-issue-keep');
    await settle();
    expect(confirm()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-open'));
    expect(server.sent.slice(sent).filter((x) => x.method !== 'GET')).toEqual([]);
    expect(server.issuePosts()).toEqual([]);
    expect(server.previewReads()).toHaveLength(2); // one per open
  });

  it.each([
    ['"No tax calculated" (mode none)', { tax: { mode: 'none' } } as Partial<Settings>, 'No tax calculated', 'Total $5.00', '$5.00'],
    ['an explicit 0 % (still an exclusive rate)', { tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } } as Partial<Settings>, 'Tax (0%) $0.00', 'Total $5.00', '$5.00'],
    ['8.875 %', {} as Partial<Settings>, 'Tax (8.875%) $0.44', 'Total $5.44', '$5.44'],
  ] as const)('SID-150. AC-04: the review keeps the store\'s tax mode as the preview answered it — %s — never collapsing an explicit 0 % into "No tax calculated"', async (_label, settings, tax, total, said) => {
    const { server } = await ready({}, settings);
    await openIssue(server);
    expect(screen.getByTestId('draft-issue-preview-tax').textContent).toBe(tax);
    expect(screen.getByTestId('draft-issue-preview-total')).toHaveTextContent(total);
    expect(confirm()).toHaveAccessibleDescription(ISSUE_TEXT.consequence(said));
    expect(server.issuePosts()).toEqual([]);
  });

  it('SID-151. AC-05 ISS-23: ONE press is ONE POST of exactly the preview\'s `expected` (serialized once) under ONE fresh key, with the session and intent headers; from that press Issue invoice is gone and Keep draft reads "Close", described as not cancelling; nothing says issued before the 201 — then both dialogs close at once, the row goes, focus is on the heading (never <body>), and the card says "Issued. Loading the invoice…", reads the invoice ONCE (a GET) and says "Issued as invoice 1 at Main Street." with View invoice and Dismiss; page one is read again; View invoice shows the issued document (one GET) and its Close gives focus back to View invoice', async () => {
    const { server, draft, r } = await ready();
    await openIssue(server);
    server.hold.issue = 1;
    server.hold.issued = 1;
    const send = screen.getByTestId('draft-issue-send');
    const mark = server.sent.length;
    await user().click(send);
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    expect(send.isConnected).toBe(false);
    expect(attemptState()).toBe('sending');
    expect(screen.getByTestId('draft-issue-attempt-state')).toHaveTextContent(ISSUE_TEXT.sending);
    const keep = screen.getByTestId('draft-issue-keep');
    expect(keep).toHaveTextContent('Close');
    expect(keep).toHaveAccessibleDescription(ISSUE_TEXT.closeWarning);
    expect(document.activeElement).toBe(keep); // the focus the press took away, recovered inside the dialog
    expect(document.body).not.toHaveTextContent(/Issued/);
    const posts = server.issuePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(issuePathOf(STORE_1, draft.id));
    expect(posts[0].body).toBe(issueBody(TENANT_A, 3, 1, 1));
    expect(posts[0].headers.get('idempotency-key')).toBe(r.keys[0]);
    expect(posts[0].headers.get('x-tmpos-csrf')).toBe('1');
    expect(posts[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}/);
    expect(posts[0].headers.get('content-type')).toBe('application/json');
    expect(r.keys).toHaveLength(1);
    expect(r.issueHolds.get('uid-a')).toMatchObject({ key: r.keys[0], body: posts[0].body, storeId: STORE_1, draftId: draft.id, state: 'sending' });
    expect(Object.keys(r.issueHolds.get('uid-a')!).sort()).toEqual(['body', 'csrf', 'draftId', 'invoiceId', 'key', 'note', 'number', 'refusal', 'sentAt', 'sentWall', 'state', 'storeId', 'storeLabel', 'voided']); // M7B-INVOICES-VOID-P1: + voided (what the last read showed), still nothing of the invoice
    const status = screen.getByTestId('drafts-issue-hold-status');
    const fell = watchBody();
    await release(server); // the 201
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issuedLoading));
    expect([confirm(), view()]).toEqual([null, null]);
    expect(document.activeElement).toBe(heading());
    expect(rows().map((x) => x.getAttribute('data-id'))).not.toContain(draft.id);
    expect(screen.getByTestId('drafts-issue-hold-status')).toBe(status); // written into the standing region
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issued']));
    await release(server);
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    await listReady();
    await settle();
    fell.stop();
    expect(fell.fell).toEqual([]);
    expect(cardState()).toBe('issued');
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['View invoice', 'Dismiss']);
    const after = server.sent.slice(mark);
    expect(after.filter((x) => x.method === 'POST')).toHaveLength(1);
    expect(after.filter((x) => x.url === issuedInvoicePathOf(STORE_1, server.invoices[0].id))).toHaveLength(1);
    expect(after.filter((x) => x.method === 'GET' && x.url.startsWith(`${draftsPathOf(STORE_1)}?`))).toHaveLength(1); // page one again
    expect([draft.status, draft.version, server.invoices[0].number]).toEqual(['issued', 4, 1]);
    // View invoice: the exported issued dialog, its one GET under this section's session.
    const reads = server.issuedReads().length;
    await click('drafts-issue-view');
    await waitFor(() => expect(screen.getByTestId('issued-view-title')).toHaveTextContent('Invoice 1'));
    expect(screen.getByTestId('issued-view-total')).toHaveTextContent('Total $5.44');
    expect(server.issuedReads()).toHaveLength(reads + 1);
    await click('issued-view-close');
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-issue-view'));
    await click('drafts-issue-dismiss');
    expect(cardState()).toBe('none');
    expect(server.issuePosts()).toHaveLength(1);
  });

  it('SID-152. AC-05 ISS-23: two activations of Issue invoice delivered before React commits the first (one task) are ONE POST under ONE key: the press is held in a ref', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    server.hold.issue = 1;
    const send = screen.getByTestId('draft-issue-send');
    await act(async () => { send.click(); send.click(); });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    await settle();
    expect(server.issuePosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    await release(server);
    await waitFor(() => expect(cardState()).toBe('issued'));
    expect(server.issuePosts()).toHaveLength(1);
  });

  it('SID-153. AC-05: a confirmed 201 whose invoice read fails says "Issued. The invoice details did not load." — never "not issued" — and "Load details again" sends ONE GET and never a POST; then the number is shown', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    server.issuedStatus.push(503);
    await pressIssue();
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issuedUnread));
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Load details again', 'Dismiss']);
    expect(server.issuePosts()).toHaveLength(1);
    const reads = server.issuedReads().length;
    await click('drafts-issue-load');
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    expect(server.issuedReads()).toHaveLength(reads + 1);
    expect(server.issuePosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it.each([
    ['issuing_not_configured', 'not-configured'], ['amount_out_of_range', 'out-of-range'],
  ] as const)('SID-154. AC-07 ISS-23: a sealed 409 %s is said in an alert that takes focus, ends the attempt (no Check again, no Review again) and offers no change of amount; nothing is sent again', async (word, kind) => {
    const { server } = await ready();
    await openIssue(server);
    server.issues.push(answer(409, { error: word }));
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT[kind]));
    expect(screen.getByTestId('draft-issue-refused')).toHaveAttribute('role', 'alert');
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-refused'));
    expect(screen.queryByTestId('draft-issue-check')).toBeNull();
    expect(screen.queryByTestId('draft-issue-review-again')).toBeNull();
    expect(screen.queryByTestId('draft-issue-send')).toBeNull();
    expect(ISSUE_REFUSED_TEXT[kind]).not.toMatch(/rolled back|cancelled/i);
    await settle();
    expect(server.issuePosts()).toHaveLength(1);
  });

  it('SID-155. AC-07 ISS-23: a stale review (the settings changed after the preview) is the sealed 409 write_conflict — an alert with focus and "Review again"; the old body is never sent again under its key; Review again reads ONE new preview, says it is the updated invoice, and only a new press sends — a NEW key and the new versions', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    server.configure(STORE_1, { tax: { mode: 'none' } }); // version 2, elsewhere
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT.conflict));
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-refused'));
    const previews = server.previewReads().length;
    await click('draft-issue-review-again');
    await waitFor(() => expect(screen.getByTestId('draft-issue-preview-state')).toHaveTextContent(ISSUE_TEXT.updated));
    expect(server.previewReads()).toHaveLength(previews + 1);
    expect(screen.getByTestId('draft-issue-preview-tax').textContent).toBe('No tax calculated');
    expect(screen.queryByTestId('draft-issue-refused')).toBeNull();
    expect(server.issuePosts()).toHaveLength(1); // nothing on its own
    await pressIssue();
    await waitFor(() => expect(cardState()).toBe('issued'));
    const [first, second] = server.issuePosts();
    expect([first.body, second.body]).toEqual([issueBody(TENANT_A, 3, 1, 1), issueBody(TENANT_A, 3, 2, 1)]);
    expect(second.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'));
    expect(r.keys).toHaveLength(2);
  });

  it('SID-156. AC-07: a draft no longer open (discarded elsewhere) is the sealed 409 invalid_state — "may have been issued or discarded elsewhere", page one read again, and "Find issued invoice" reads ONE sourceDraft lookup at the attempt\'s store: none found is said as not found yet, never as not issued; a draft issued elsewhere is found and settles the attempt as issued with its number', async () => {
    let other: Draft | null = null;
    const { server, draft } = await ready({}, {}, (s, ada) => { other = s.seedDraft(STORE_1, ada, at(7), 300, 1); });
    await openIssue(server, 1); // the earlier draft (version 3)
    draft.status = 'discarded';
    draft.version += 1;
    const mark = server.sent.length;
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT['not-open']));
    await listReady();
    expect(server.sent.slice(mark).filter((x) => x.method === 'GET' && x.url.startsWith(`${draftsPathOf(STORE_1)}?`))).toHaveLength(1);
    await click('draft-issue-find');
    await waitFor(() => expect(screen.getByTestId('draft-issue-attempt-note')).toHaveTextContent(ISSUE_TEXT.findNone));
    const finds = server.issuedReads();
    expect(finds.map((x) => x.url)).toEqual([`${issuedInvoicesPathOf(STORE_1)}?sourceDraft=${draft.id}`]);
    expect(finds[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}/);
    expect(ISSUE_TEXT.findNone).toMatch(/does not mean it was not issued/);
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    // Another draft, issued by another session after this review: invalid_state, then Find finds it.
    await openIssue(server, 0);
    expect(screen.getByTestId('draft-issue-preview-subtotal')).toHaveTextContent('Subtotal $3.00');
    issueElsewhere(server, other!);
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT['not-open']));
    await click('draft-issue-find');
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    expect([confirm(), view()]).toEqual([null, null]);
    expect(document.activeElement).toBe(heading());
    expect(server.issuePosts()).toHaveLength(2);
  });
  it.each([
    ['tenant-changed', () => answer(409, { error: 'write_conflict', requestId: 'req-synthetic' })],
    ['not-found', () => answer(404, { error: 'not_found', requestId: 'req-synthetic' })],
    ['invalid', () => answer(400, { error: 'invalid_request', requestId: 'req-synthetic' })],
    ['key-reused', () => answer(422, { error: 'idempotency_key_reused', requestId: 'req-synthetic' })],
  ] as const)('SID-157. AC-07: a first send refused %s (the chain\'s own envelope) ends the attempt with its own alert (focus on it, no Check again); closed, the card outside says the same with Dismiss, and nothing is ever sent again', async (kind, refusal) => {
    const { server } = await ready();
    await openIssue(server);
    server.issues.push(refusal());
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT[kind]));
    expect(document.activeElement).toBe(screen.getByTestId('draft-issue-refused'));
    expect(attemptState()).toBe('refused');
    expect(screen.queryByTestId('draft-issue-check')).toBeNull();
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    expect(view()).toBeNull(); // a key was minted in it: the reopen dialog closes too
    expect(cardState()).toBe('refused');
    expect(screen.getByTestId('drafts-issue-hold-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT[kind]);
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(server.issuePosts()).toHaveLength(1);
    await click('drafts-issue-dismiss');
    expect(cardState()).toBe('none');
    expect(document.activeElement).toBe(heading()); // never <body>
  });

  it('SID-158. AC-03 AC-07: a first send refused 403 gets ONE fresh session check, then "this account may not issue invoices" in an alert, and Issue invoice… goes from the reopen dialog (nothing is asked again on its own); a 403 whose fresh check cannot answer says so — never "may not issue" — and nothing more is sent', async () => {
    const { server } = await ready();
    await openIssue(server);
    server.issues.push(403);
    const mark = server.sent.length;
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT.denied));
    const after = server.sent.slice(mark).map((x) => `${x.method} ${x.url}`);
    const refusedAt = after.findIndex((x) => x.startsWith('POST'));
    expect(after.slice(refusedAt + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]); // ONE fresh check, no login
    expect(screen.queryByTestId('draft-issue-open')).toBeNull(); // taken away from the reopen dialog beneath
    expect(server.issueEligReads()).toHaveLength(1);
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    await openIssue(server);
    // The send's own session check answers; the POST is held and answered 403, and its fresh check is the outage.
    server.hold.issue = 1;
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    server.currentStatus.push(503);
    await release(server, 0, refusal(403, 'forbidden'));
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT.unchecked));
    expect(ISSUE_REFUSED_TEXT.unchecked).not.toMatch(/may not issue/);
    await settle();
    expect(server.issuePosts()).toHaveLength(2);
  });

  it('SID-159. AC-08: a first send answered 401 ends the session as any read\'s does — both dialogs go, nothing is held (the key acquired nothing), the stores say so and only Reconnect signs in; nothing is sent again', async () => {
    const { server } = await ready();
    await openIssue(server);
    server.issues.push(401);
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect([confirm(), view()]).toEqual([null, null]);
    expect(cardState()).toBe('none');
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    const logins = server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login).length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins);
    expect(server.issuePosts()).toHaveLength(1);
  });

  it('SID-160. AC-07: a first send answered 429 (refused before its key was acquired) holds nothing and starts the section\'s wait with its Retry-After — Issue invoice is back, held back and described why through all of it, a press then sends nothing; once it has passed, a NEW press is ONE POST under a NEW key', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    server.retryAfter = '5';
    server.issues.push(429);
    fakeClock();
    fireEvent.click(screen.getByTestId('draft-issue-send'));
    await until(() => expect(screen.getByTestId('draft-issue-status')).toHaveTextContent(ISSUE_TEXT.rateLimited));
    expect(r.issueHolds.get('uid-a')).toBeUndefined();
    const send = screen.getByTestId('draft-issue-send');
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveAccessibleDescription(ISSUE_TEXT.sendWaiting);
    expect(screen.getByTestId('drafts-new')).toBeDisabled(); // the wait is the section's: New server draft waits too
    fireEvent.click(send);
    await advance(4_900);
    await settle();
    expect(server.issuePosts()).toHaveLength(1);
    await advance(200);
    await settle();
    expect(screen.getByTestId('draft-issue-send')).toHaveAttribute('aria-disabled', 'false');
    expect(server.issuePosts()).toHaveLength(1); // nothing on its own when the wait ends
    vi.useRealTimers();
    await pressIssue();
    await waitFor(() => expect(cardState()).toBe('issued'));
    const [first, second] = server.issuePosts();
    expect(second.body).toBe(first.body);
    expect(second.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'));
    expect(r.keys).toHaveLength(2);
  });

  it('SID-161. AC-06 ISS-19: a POST whose answer is lost after the server issued it stays UNRESOLVED — "Not confirmed yet", Check again and Find issued invoice, Close described as not cancelling; a focus, a tab return and an hour of timers send nothing; Escape is Close then (the attempt kept outside, the row read again); only Check again re-sends — the SAME key, the IDENTICAL bytes, the same session token — and its replayed 201 is issued: ONE invoice', async () => {
    const { server, draft, r } = await ready();
    await openIssue(server);
    server.issues.push('lose');
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(screen.getByTestId('draft-issue-attempt-state')).toHaveTextContent(ISSUE_TEXT.unresolved);
    expect(screen.getByTestId('draft-issue-attempt-note')).toHaveTextContent('No answer from the server.');
    expect(screen.getByTestId('draft-issue-keep')).toHaveAccessibleDescription(ISSUE_TEXT.closeWarning);
    expect([screen.getByTestId('draft-issue-check'), screen.getByTestId('draft-issue-find')].map((b) => b.textContent)).toEqual(['Check again', 'Find issued invoice']);
    expect(server.invoices).toHaveLength(1); // the server did issue it
    fakeClock();
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await advance(HOUR);
    vi.useRealTimers();
    await settle();
    expect(server.issuePosts()).toHaveLength(1);
    await user().keyboard('{Escape}');
    await waitFor(() => expect(confirm()).toBeNull());
    expect(view()).toBeNull();
    await listReady();
    expect(rows().map((x) => x.getAttribute('data-id'))).not.toContain(draft.id);
    expect(cardState()).toBe('unresolved');
    expect(cardText()).toBe(ISSUE_TEXT.unresolved);
    expect(document.activeElement).not.toBe(document.body);
    await click('drafts-issue-check');
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    const [first, again] = server.issuePosts();
    expect([again.url, again.body, again.headers.get('idempotency-key'), again.headers.get('x-tmpos-session-csrf')])
      .toEqual([first.url, first.body, first.headers.get('idempotency-key'), first.headers.get('x-tmpos-session-csrf')]);
    expect(r.keys).toHaveLength(1);
    expect(server.invoices).toHaveLength(1);
    expect(server.counters.get(STORE_1)).toBe(1);
  });

  it('SID-162. AC-07: a first send answered request_in_progress, and Check again answered request_in_progress and then 503, stay unresolved — each press ONE POST of the same key and bytes, nothing between them — until a Check again is issued', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    const inProgress = () => answer(409, { error: 'request_in_progress', requestId: 'req-synthetic' });
    server.issues.push(inProgress(), inProgress(), 503);
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-attempt-note')).toHaveTextContent('The server is still working on it.'));
    await click('draft-issue-check');
    await waitFor(() => expect(server.issuePosts()).toHaveLength(2));
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(screen.getByTestId('draft-issue-attempt-note')).toHaveTextContent('The server is still working on it.');
    await click('draft-issue-check');
    await waitFor(() => expect(server.issuePosts()).toHaveLength(3));
    await waitFor(() => expect(screen.getByTestId('draft-issue-attempt-note')).toHaveTextContent('The server answered, but not with a result.'));
    await click('draft-issue-check');
    await waitFor(() => expect(cardState()).toBe('issued'));
    expect(new Set(server.issuePosts().map((x) => `${x.headers.get('idempotency-key')} ${x.body}`)).size).toBe(1);
    expect(server.issuePosts()).toHaveLength(4);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-163. AC-06: the 23-hour window counts from the FIRST send and a Check again never extends it — a check at 22 hours stays unresolved, and one more hour on the wall clock alone is past it: nothing is sent, the card says it is too old and keeps Find issued invoice; a cutoff passed while a Check again\'s own session check is out is judged again right before the POST and sends nothing', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    server.issues.push(503, 503);
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    r.clock.wall += 22 * HOUR;
    await click('drafts-issue-check');
    await waitFor(() => expect(server.issuePosts()).toHaveLength(2));
    await waitFor(() => expect(cardState()).toBe('unresolved'));
    expect(cardText()).toBe(ISSUE_TEXT.unresolved);
    r.clock.wall += HOUR; // 23 hours since the FIRST send, 1 since the check
    await click('drafts-issue-check');
    await settle();
    expect(cardText()).toBe(ISSUE_TEXT.tooOld);
    expect(screen.queryByTestId('drafts-issue-check')).toBeNull();
    expect(screen.getByTestId('drafts-issue-find')).toBeInTheDocument();
    expect(server.issuePosts()).toHaveLength(2);
    expect(r.issueHolds.get('uid-a')?.body).toBe(''); // the body goes: it may never be sent again
    // The monotonic arm, judged again after the session check: a new attempt, its Check again's session read held across the cutoff.
    await click('drafts-issue-stop');
    await listReady();
    await openIssue(server);
    server.issues.push(503);
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.mono += 23 * HOUR - 1_000;
    server.hold.current = 1;
    await click('draft-issue-check');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
    r.clock.mono += 2_000;
    await release(server);
    await settle();
    expect(screen.getByTestId('draft-issue-attempt-state')).toHaveTextContent(ISSUE_TEXT.tooOld);
    expect(server.issuePosts()).toHaveLength(3);
  });

  it('SID-164. AC-06 AC-09 ISS-19: Find issued invoice is ONE sourceDraft lookup (no limit, no cursor) at the ATTEMPT\'s store — even with another store chosen — under the token the attempt was sent with: none found keeps it unresolved and says so (never "not issued"); refused 403 after ONE fresh check it says the issued invoices cannot be viewed here; after another tab\'s session (a new token) it reads nothing and the attempt is detached', async () => {
    const { server, draft } = await ready();
    await openIssue(server);
    server.issues.push('lose-before'); // it never reached the server
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await listReady();
    expect(cardState()).toBe('unresolved'); // a store choice neither detaches nor re-targets it
    await click('drafts-issue-find');
    await waitFor(() => expect(screen.getByTestId('drafts-issue-hold-note')).toHaveTextContent(ISSUE_TEXT.findNone));
    expect(server.issuedReads().map((x) => x.url)).toEqual([`${issuedInvoicesPathOf(STORE_1)}?sourceDraft=${draft.id}`]);
    expect(cardText()).toBe(ISSUE_TEXT.unresolved);
    expect(document.activeElement).not.toBe(document.body);
    server.viewIssuedAllow.owner = false;
    const mark = server.sent.length;
    await click('drafts-issue-find');
    await waitFor(() => expect(screen.getByTestId('drafts-issue-hold-note')).toHaveTextContent(ISSUE_TEXT.findDenied));
    const after = server.sent.slice(mark).map((x) => x.url);
    expect(after.slice(after.findIndex((u) => u.includes('?sourceDraft=')) + 1)).toEqual([TENANT_SESSION_PATHS.current]);
    server.viewIssuedAllow.owner = true;
    server.otherTab('uid-a');
    const reads = server.issuedReads().length;
    await click('drafts-issue-find');
    await waitFor(() => expect(cardState()).toBe('detached'));
    expect(cardText()).toBe(ISSUE_TEXT.detached);
    expect(server.issuedReads()).toHaveLength(reads);
    expect(screen.queryByTestId('drafts-issue-check')).toBeNull();
    expect(server.issuePosts()).toHaveLength(1);
  });

  it('SID-165. AC-08 ISS-19: a sign-out, another tab\'s session (a new token, seen on a focus) and a user change each DETACH an unresolved attempt — the card says it could not be confirmed, offers no Check again or Find, and nothing is sent again, after Reconnect either', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    for (const end of ['sign-out', 'other tab', 'user change'] as const) {
      const { server, r, props, page } = await ready();
      await openIssue(server);
      server.issues.push('lose');
      await pressIssue();
      await waitFor(() => expect(attemptState()).toBe('unresolved'));
      await click('draft-issue-keep');
      await waitFor(() => expect(cardState()).toBe('unresolved'));
      if (end === 'sign-out') await act(async () => { await props.session!.logout(); });
      if (end === 'other tab') { server.otherTab('uid-a'); await act(async () => { window.dispatchEvent(new Event('focus')); }); }
      if (end === 'user change') page.rerender(<ServerInvoiceDrafts {...props} uid="uid-b" />);
      await settle();
      expect(r.issueHolds.get('uid-a')).toMatchObject({ csrf: null, body: '' });
      if (end !== 'user change') {
        await waitFor(() => expect(cardState()).toBe('detached'));
        expect(cardText()).toBe(ISSUE_TEXT.detached);
        expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
      } else {
        expect(cardState()).toBe('none'); // another user's section shows nothing of it
      }
      if (end === 'sign-out') { await click('drafts-retry'); await storesReady(); }
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await settle();
      expect(server.issuePosts()).toHaveLength(1);
      cleanup();
    }
  });

  it('SID-166. AC-06 ISS-19: the unresolved attempt survives closing the confirmation, reopening a draft, another store and leaving the page (the section unmounted and mounted again with the same hold store): the card is back with Check again, which sends the SAME key and bytes under the same session — no login, no new key', async () => {
    const { server, r, props, page } = await ready();
    await openIssue(server);
    server.issues.push('lose');
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('draft-issue-keep');
    await waitFor(() => expect(cardState()).toBe('unresolved'));
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await listReady();
    expect(cardState()).toBe('unresolved');
    page.unmount();
    render(<ServerInvoiceDrafts {...props} />);
    expect(cardState()).toBe('unresolved');
    expect(cardText()).toBe(ISSUE_TEXT.unresolved);
    const logins = server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login).length;
    await click('drafts-issue-check');
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    const [first, again] = server.issuePosts();
    expect([again.body, again.headers.get('idempotency-key'), again.headers.get('x-tmpos-session-csrf')]).toEqual([first.body, first.headers.get('idempotency-key'), first.headers.get('x-tmpos-session-csrf')]);
    expect(server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins);
    expect(r.keys).toHaveLength(1);
    expect(server.invoices).toHaveLength(1);
  });

  it('SID-167. AC-11 ISS-24: issuing writes no browser storage (local or session), logs nothing and leaves the address as it was; its key, body and token stay in memory — never in the DOM — through an unresolved attempt, Check again and the issued card; the sources reach neither', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const href = window.location.href;
    const { server, r } = await ready();
    await openIssue(server);
    server.issues.push(503);
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    for (const secret of ['s'.repeat(40), r.keys[0], 'expectedSettingsVersion']) expect(document.body.innerHTML).not.toContain(secret);
    await click('draft-issue-check');
    await waitFor(() => expect(cardState()).toBe('issued'));
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    for (const secret of ['s'.repeat(40), r.keys[0], 'expectedSettingsVersion']) expect(document.body.innerHTML).not.toContain(secret);
    expect(setItem).not.toHaveBeenCalled();
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    for (const file of ['ServerInvoiceDrafts.tsx', 'ServerIssuedInvoices.tsx', 'invoiceIssuingClient.ts']) {
      const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|history\.|location\.(href|search|hash)/);
    }
  });

  it('SID-168. AC-04 AC-07: the preview\'s own answers — a draft no longer open (404), at the last version (409 invalid_state), a store without settings (409 issuing_not_configured), a total too large (409 amount_out_of_range) — are said in an alert with no Issue invoice; refused 403 it gets ONE fresh check and takes Issue invoice… away; an outage is a Try again (one GET per press) that reads the preview again; nothing is POSTed', async () => {
    const cases: Array<[Response | number, string]> = [
      [404, ISSUE_TEXT.previewNotFound],
      [answer(409, { error: 'invalid_state', requestId: 'r-1' }), ISSUE_TEXT.previewLast],
      [answer(409, { error: 'issuing_not_configured', requestId: 'r-1' }), ISSUE_TEXT.previewNotConfigured],
      [answer(409, { error: 'amount_out_of_range', requestId: 'r-1' }), ISSUE_TEXT.previewOutOfRange],
    ];
    const { server } = await ready();
    for (const [scripted, said] of cases) {
      server.previewStatus.push(scripted);
      await openIssue(server);
      expect(screen.getByTestId('draft-issue-preview-refused')).toHaveTextContent(said);
      expect(screen.getByTestId('draft-issue-preview-refused')).toHaveAttribute('role', 'alert');
      expect(screen.queryByTestId('draft-issue-send')).toBeNull();
      expect(screen.queryByTestId('draft-issue-preview')).toBeNull();
      await click('draft-issue-keep');
      await waitFor(() => expect(confirm()).toBeNull());
      expect(view()).toBeInTheDocument(); // nothing was sent: only the confirmation closes
      await click('draft-view-close');
    }
    server.previewStatus.push(403);
    await openIssue(server);
    expect(screen.getByTestId('draft-issue-preview-refused')).toHaveTextContent(ISSUE_TEXT.previewDenied);
    expect(screen.queryByTestId('draft-issue-open')).toBeNull();
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    expect(screen.queryByTestId('draft-issue-open')).toBeNull(); // the refusal stands for this open
    await click('draft-view-close');
    server.previewStatus.push(503);
    await openIssue(server);
    expect(screen.getByTestId('draft-issue-preview-state')).toHaveTextContent(ISSUE_TEXT.previewUnavailable);
    const retry = screen.getByTestId('draft-issue-preview-retry');
    expect(retry).toHaveAccessibleName('Try again: load the invoice to review');
    const previews = server.previewReads().length;
    await click('draft-issue-preview-retry');
    await waitFor(() => expect(previewPhase()).toBe('ready'));
    expect(server.previewReads()).toHaveLength(previews + 1);
    expect(screen.getByTestId('draft-issue-send')).toBeInTheDocument();
    expect(server.issuePosts()).toEqual([]);
  });

  it('SID-169. AC-08 AC-10: late answers move nothing — a preview answered after its confirmation closed shows nothing; an issue eligibility answered after its reopen dialog closed offers nothing; an issue POST answered after Close settles BY KEY in the card (issued, its number read) and closes nothing else', async () => {
    const { server } = await ready();
    await openDraft(server);
    server.hold.preview = 1;
    await click('draft-issue-open');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['preview']));
    expect(screen.getByTestId('draft-issue-preview-state')).toHaveTextContent(ISSUE_TEXT.previewLoading);
    expect(screen.queryByTestId('draft-issue-send')).toBeNull();
    await click('draft-issue-keep');
    await release(server);
    await settle();
    expect(confirm()).toBeNull();
    expect(view()).toBeInTheDocument();
    await click('draft-view-close');
    server.hold.issueElig = 1;
    await user().click(within(rows()[0]).getByTestId('drafts-open'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issueElig']));
    await click('draft-view-close');
    await release(server);
    await settle();
    expect(screen.queryByTestId('draft-issue-open')).toBeNull();
    await openIssue(server);
    server.hold.issue = 1;
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    await click('draft-issue-keep'); // Close: tracking goes on outside
    await waitFor(() => expect(cardState()).toBe('sending'));
    expect(cardText()).toBe(ISSUE_TEXT.sending);
    await release(server);
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    expect(server.issuePosts()).toHaveLength(1);
  });

  it('SID-170. AC-10 (a regression guard: the preview is read from the section\'s effect, which StrictMode does not repeat on a change): under StrictMode (setup, cleanup, setup in development) one open is ONE preview GET and one press ONE POST under one key', async () => {
    const { server, ada } = seeded();
    const draft = server.seedDraft(STORE_1, ada, at(5), 250, 2);
    server.configure(STORE_1);
    const r = rig(server);
    render(<StrictMode><ServerInvoiceDrafts {...r.props()} /></StrictMode>);
    await showAndChoose(STORE_1);
    await user().click(within(rows()[0]).getByTestId('drafts-open')); // (no customer name under StrictMode's remount: not waited for)
    await waitFor(() => expect(screen.getByTestId('draft-issue-open')).toBeInTheDocument());
    await click('draft-issue-open');
    await waitFor(() => expect(previewPhase()).toBe('ready'));
    expect(server.previewReads()).toHaveLength(1);
    await pressIssue();
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    expect(server.issuePosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    expect(server.issuedReads()).toHaveLength(1);
    expect(draft.status).toBe('issued');
  });

  it('SID-171. AC-06: one live issue attempt per user — while one is unresolved, another draft\'s Issue invoice is held back and described why, and a press says "Not sent: an earlier issue is not confirmed yet…" with no key and no POST', async () => {
    let second: Draft | null = null;
    const { server, r } = await ready({}, {}, (s, ada) => { second = s.seedDraft(STORE_1, ada, at(9), 700, 1); });
    await openIssue(server, 1); // the earlier draft
    server.issues.push('lose-before');
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    await listReady();
    await openIssue(server, 0); // the other draft
    expect(screen.getByTestId('draft-issue-preview-subtotal')).toHaveTextContent('Subtotal $7.00');
    const send = screen.getByTestId('draft-issue-send');
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveAccessibleDescription(ISSUE_TEXT.pending);
    await user().click(send);
    await waitFor(() => expect(screen.getByTestId('draft-issue-status')).toHaveTextContent(ISSUE_TEXT.pending));
    expect(server.issuePosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    expect(second!.status).toBeUndefined();
  });

  it('SID-172. AC-07 AC-08: a Check again refused 403 gets ONE fresh check and stays unresolved — "Access lost: … that refusal stands"; one answered 429 stays unresolved with the wait, Check again held back and described why, nothing sent when it ends; one answered 401 ends the session and detaches the attempt', async () => {
    const { server } = await ready();
    await openIssue(server);
    server.issues.push(503, 403, 429, 401);
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('draft-issue-check');
    await waitFor(() => expect(screen.getByTestId('draft-issue-attempt-note')).toHaveTextContent(ISSUE_TEXT.checkDenied));
    expect(attemptState()).toBe('unresolved');
    server.retryAfter = '3';
    fakeClock();
    fireEvent.click(screen.getByTestId('draft-issue-check'));
    await until(() => expect(screen.getByTestId('draft-issue-attempt-note')).toHaveTextContent('Too many requests. Wait 3 seconds.'));
    expect(screen.getByTestId('draft-issue-check')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('draft-issue-check')).toHaveAccessibleDescription(ISSUE_TEXT.waiting);
    fireEvent.click(screen.getByTestId('draft-issue-check'));
    await advance(3_000);
    await settle();
    expect(server.issuePosts()).toHaveLength(3);
    expect(screen.getByTestId('draft-issue-check')).toHaveAttribute('aria-disabled', 'false');
    vi.useRealTimers();
    await click('draft-issue-check');
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(confirm()).toBeNull();
    expect(cardState()).toBe('detached');
    expect(server.issuePosts()).toHaveLength(4);
  });

  it('SID-173. AC-02 AC-08: no issue POST and no preview from mounting, a focus, a tab return, timers, reopening the draft, a refusal\'s fresh check, a session end or Reconnect — only the presses send', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, props } = await ready();
    expect([server.previewReads(), server.issuePosts()]).toEqual([[], []]);
    await openDraft(server);
    fakeClock();
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await advance(10 * 60_000);
    vi.useRealTimers();
    await settle();
    expect(server.previewReads()).toEqual([]);
    await click('draft-view-close');
    server.previewStatus.push(403);
    await openIssue(server);
    await click('draft-issue-keep');
    await click('draft-view-close');
    await act(async () => { await props.session!.logout(); });
    await click('drafts-retry');
    await storesReady();
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(server.previewReads()).toHaveLength(1);
    expect(server.issuePosts()).toEqual([]);
    expect(server.sent.filter((x) => x.method !== 'GET' && !x.url.startsWith('/api/v1/session'))).toEqual([]);
  });
  it('SID-174. AC-08 (jsdom-only callback ordering): a preview read closed and opened again is the old open\'s no more — its late 429 starts no wait and its late answer shows nothing; only the new open\'s answer is shown, and Issue invoice is for it', async () => {
    const { server } = await ready();
    await openDraft(server);
    server.hold.preview = 2;
    await click('draft-issue-open');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['preview']));
    await click('draft-issue-keep');
    await click('draft-issue-open');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['preview', 'preview']));
    server.retryAfter = '30';
    await release(server, 0, refusal(429, 'rate_limited')); // the closed open's late answer
    await settle();
    expect(previewPhase()).toBe('loading');
    expect(screen.getByTestId('drafts-new')).toBeEnabled(); // no wait from it
    await release(server); // the new open's
    await waitFor(() => expect(previewPhase()).toBe('ready'));
    expect(screen.getByTestId('draft-issue-send')).toHaveAttribute('aria-disabled', 'false');
    expect(server.previewReads()).toHaveLength(2);
    expect(server.issuePosts()).toEqual([]);
  });

  it('SID-175. AC-07: a 201 this client cannot name — a Location that is not exactly the invoice\'s path at the store asked — is no issue: the attempt stays unresolved (nothing says issued, no number is read) and only Check again settles it, the SAME key and bytes', async () => {
    const { server, draft, r } = await ready();
    await openIssue(server);
    const id = uuid(0xe99);
    server.issues.push(answer(201, { invoice: { id, sourceDraftId: draft.id, status: 'issued' }, draft: { id: draft.id, version: 4, status: 'issued' } }, { location: `/api/v1/stores/${STORE_2}/invoices/${id}` }));
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(screen.getByTestId('draft-issue-attempt-note')).toHaveTextContent('The server answered, but not with a result.');
    expect(document.body).not.toHaveTextContent(/Issued/);
    expect(server.issuedReads()).toEqual([]);
    await click('draft-issue-check');
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    const [first, again] = server.issuePosts();
    expect([again.body, again.headers.get('idempotency-key')]).toEqual([first.body, first.headers.get('idempotency-key')]);
    expect(r.keys).toHaveLength(1);
  });
  it.each([
    ['a 201 (the server issued it)', 'issued'],
    ['a 403 (refused, nothing issued)', 'denied'],
    ['a sealed 409 write_conflict (a stale review)', 'conflict'],
  ] as const)('SID-176. AC-08 (jsdom-only callback ordering): a first send whose answer — %s — is still out when a sign-out DETACHES its attempt: the card is the earlier session\'s note ("could not be confirmed") with Dismiss, and Dismiss clears it WHILE the request is out; the late answer then recreates and changes nothing — never issued, refused or "unchecked" — and nothing is read, checked or sent for it; after Reconnect nothing is re-sent, or a new issue goes under a NEW key (review D3: Dismiss before the answer)', async (_what, late) => {
    const { server, props, r } = await ready();
    await openIssue(server);
    if (late === 'denied') server.issueAllow.owner = false; // the server refuses this one (nothing issued)
    if (late === 'conflict') server.configure(STORE_1, { tax: { mode: 'none' } }); // settings version 2, elsewhere: the review is stale
    server.hold.issue = 1; // its answer held
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    server.issueAllow.owner = true;
    await act(async () => { await props.session!.logout(); });
    await waitFor(() => expect(cardState()).toBe('detached'));
    expect(cardText()).toBe(ISSUE_TEXT.detached);
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
    expect(server.held.map((h) => h.kind)).toEqual(['issue']); // the request is still out
    await click('drafts-issue-dismiss');
    expect(cardState()).toBe('none');
    expect(r.issueHolds.get('uid-a')).toBeUndefined();
    expect(document.activeElement).toBe(heading());
    const mark = server.sent.length;
    await release(server); // the late answer, after Dismiss
    await settle();
    expect(r.issueHolds.get('uid-a')).toBeUndefined(); // nothing recreated
    expect(cardState()).toBe('none');
    expect(screen.queryByTestId('drafts-issue-hold-refused')).toBeNull();
    expect(server.sent.slice(mark)).toEqual([]); // no invoice read, no fresh check, no login, for a session that ended
    await click('drafts-retry');
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    if (late === 'issued') {
      expect(rows()).toEqual([]); // the server issued it: nothing to issue again, and nothing is re-sent
      expect([server.issuePosts().length, server.invoices.length, r.keys.length]).toEqual([1, 1, 1]);
      return;
    }
    await openIssue(server);
    await pressIssue();
    await waitFor(() => expect(cardState()).toBe('issued'));
    expect(server.issuePosts()).toHaveLength(2);
    expect(r.keys).toHaveLength(2);
    expect(new Set(server.issuePosts().map((x) => x.headers.get('idempotency-key'))).size).toBe(2);
  });
  it('SID-177. AC-06 (review C2): the 23-hour window closes on its own with nothing pressed — at the cutoff (the later of the monotonic and wall clocks since the FIRST send) a timer takes the held body away and the card says it is too old, Find issued invoice kept and Check again gone, and nothing is sent; a page shown again past the cutoff (the wall clock jumped, no timer due yet) is judged the same, sending only its plain session check', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, r } = await ready({}, {}, (s, ada) => { s.seedDraft(STORE_1, ada, at(7), 300, 1); });
    await openIssue(server, 1);
    server.hold.issue = 1;
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    r.clock.wall += 23 * HOUR - 1_000; // the wall arm alone, one second short of the cutoff, while the first send is out
    fakeClock();
    await release(server, 0, refusal(503, 'service_unavailable')); // no result: unresolved
    await until(() => expect(attemptState()).toBe('unresolved'));
    fireEvent.click(screen.getByTestId('draft-issue-keep'));
    await until(() => expect(cardState()).toBe('unresolved'));
    await until(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'ready')); // Close's page one again
    await settle();
    expect(screen.getByTestId('drafts-issue-check')).toBeInTheDocument();
    expect(r.issueHolds.get('uid-a')?.body).not.toBe('');
    const mark = server.sent.length;
    r.clock.wall += 1_000;
    await advance(1_000);
    await until(() => expect(cardText()).toBe(ISSUE_TEXT.tooOld));
    expect(r.issueHolds.get('uid-a')?.body).toBe(''); // the bytes can never be sent again
    expect(screen.queryByTestId('drafts-issue-check')).toBeNull();
    expect(screen.getByTestId('drafts-issue-find')).toBeInTheDocument();
    expect(server.sent.slice(mark)).toEqual([]); // the cutoff's timer sends nothing, not even a session read
    vi.useRealTimers();
    // A second attempt, and the wall clock jumps past its cutoff with no timer due: a tab return judges it.
    await click('drafts-issue-stop');
    await listReady();
    await openIssue(server, 0);
    server.issues.push('lose-before');
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('draft-issue-keep');
    await waitFor(() => expect(cardState()).toBe('unresolved'));
    r.clock.wall += 23 * HOUR;
    const shown = server.sent.length;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.tooOld));
    expect(r.issueHolds.get('uid-a')?.body).toBe('');
    expect(screen.queryByTestId('drafts-issue-check')).toBeNull();
    await settle();
    expect(server.sent.slice(shown).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.issuePosts()).toHaveLength(2);
  });
  it('SID-178. AC-07 ISS-23 (review C3): a Review again whose replacement preview fails to load is still a review of the UPDATED invoice — its Try again shows the replacement with "This is the updated invoice…", nothing is sent on its own, and only a new press sends, under a NEW key and the new versions', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    server.configure(STORE_1, { tax: { mode: 'none' } }); // version 2, elsewhere
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT.conflict));
    server.previewStatus.push(503);
    await click('draft-issue-review-again');
    await waitFor(() => expect(previewPhase()).toBe('unavailable'));
    expect(screen.queryByTestId('draft-issue-send')).toBeNull();
    await click('draft-issue-preview-retry');
    await waitFor(() => expect(previewPhase()).toBe('ready'));
    expect(screen.getByTestId('draft-issue-preview-state')).toHaveTextContent(ISSUE_TEXT.updated);
    expect(screen.getByTestId('draft-issue-preview-tax').textContent).toBe('No tax calculated');
    expect(server.issuePosts()).toHaveLength(1); // nothing on its own
    await pressIssue();
    await waitFor(() => expect(cardState()).toBe('issued'));
    const [first, second] = server.issuePosts();
    expect([first.body, second.body]).toEqual([issueBody(TENANT_A, 3, 1, 1), issueBody(TENANT_A, 3, 2, 1)]);
    expect(second.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'));
    expect(r.keys).toHaveLength(2);
  });
  it('SID-179. AC-10 (review C4): the issued dialog opened by a press that leaves no control focused (a pointer press in a browser that does not focus buttons) gives focus back, on Close, to the card\'s View invoice — its surviving trigger — never the heading', async () => {
    const { server } = await ready();
    await openIssue(server);
    await pressIssue();
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, 'Main Street')));
    await listReady();
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByTestId('drafts-issue-view')); // no focus moves with it
    await waitFor(() => expect(screen.getByTestId('issued-view-title')).toHaveTextContent('Invoice 1'));
    await click('issued-view-close');
    await settle();
    expect(screen.queryByTestId('issued-view')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-issue-view'));
  });
  it('SID-180. AC-05 (review C5): an issued attempt\'s card read still out when a NEW attempt replaces it (another draft issued meanwhile) never holds the new card back — the new card reads ITS invoice (one GET) and says its number with View invoice and Dismiss; the old read\'s late answer changes nothing', async () => {
    const { server } = await ready({}, {}, (s, ada) => { s.seedDraft(STORE_1, ada, at(7), 300, 1); });
    await openIssue(server, 1);
    server.hold.issued = 1; // the first invoice's read, held
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issued']));
    expect(cardText()).toBe(ISSUE_TEXT.issuedLoading);
    await listReady();
    await openIssue(server, 0); // the other draft, while the first invoice's read is still out
    await pressIssue();
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(2, 'Main Street')));
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['View invoice', 'Dismiss']);
    expect(server.issuedReads().map((x) => x.url)).toEqual([issuedInvoicePathOf(STORE_1, server.invoices[0].id), issuedInvoicePathOf(STORE_1, server.invoices[1].id)]);
    await release(server); // the first invoice's late answer
    await settle();
    expect(cardText()).toBe(ISSUE_TEXT.issued(2, 'Main Street'));
    expect(server.issuePosts()).toHaveLength(2);
  });
  it('SID-181. AC-03 AC-05 (review C6): a confirmed 201 whose invoice read is refused 403 — its ONE fresh session check confirming the same session — says the issued invoices cannot be viewed here, never "did not load": the refusal stands (no Load details again, Dismiss only), and nothing more is read or sent', async () => {
    const { server } = await ready();
    await openIssue(server);
    server.viewIssuedAllow.owner = false; // access narrowed between the 201 and its read
    server.hold.issued = 1; // its answer held until page one's re-read (and that read's session check) is done
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issued']));
    await listReady();
    await settle();
    expect(cardText()).toBe(ISSUE_TEXT.issuedLoading);
    const mark = server.sent.length;
    await release(server); // the 403
    await waitFor(() => expect(cardText()).not.toBe(ISSUE_TEXT.issuedLoading));
    await settle();
    expect(screen.queryByTestId('drafts-issue-load')).toBeNull();
    expect(cardText()).not.toBe(ISSUE_TEXT.issuedUnread);
    expect(cardText()).toBe(ISSUE_TEXT.issuedDenied);
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
    const reads = server.issuedReads();
    expect(reads.map((x) => x.url)).toEqual([issuedInvoicePathOf(STORE_1, server.invoices[0].id)]);
    // Its ONE fresh check (review D4), isolated from page one's re-read: after the refusal, exactly one session read and nothing else.
    expect(server.sent.slice(mark).map((x) => `${x.method} ${x.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    const after = server.sent.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(server.sent.slice(after).filter((x) => x.url !== TENANT_SESSION_PATHS.current)).toEqual([]); // never read again on its own
    expect(server.issuePosts()).toHaveLength(1);
  });
  it('SID-182. AC-10 (review C7): a preview the server refuses — a store without issuing settings, and a draft no longer open — is said in an alert that takes focus (the message itself, focusable by script only, with the focus ring), as a refused attempt is; Tab then stays inside the confirmation', async () => {
    const { server } = await ready();
    for (const [scripted, said] of [
      [answer(409, { error: 'issuing_not_configured', requestId: 'r-1' }), ISSUE_TEXT.previewNotConfigured],
      [404, ISSUE_TEXT.previewNotFound],
    ] as Array<[Response | number, string]>) {
      await openDraft(server);
      server.previewStatus.push(scripted);
      await click('draft-issue-open');
      await waitFor(() => expect(screen.getByTestId('draft-issue-preview-refused')).toHaveTextContent(said));
      const message = screen.getByTestId('draft-issue-preview-refused');
      await waitFor(() => expect(document.activeElement).toBe(message));
      expect(message).toHaveAttribute('role', 'alert');
      expect(message).toHaveAttribute('tabindex', '-1');
      ringed(message);
      await user().tab();
      expect(document.activeElement).toBe(screen.getByTestId('draft-issue-keep'));
      await click('draft-issue-keep');
      await waitFor(() => expect(confirm()).toBeNull());
      await click('draft-view-close');
    }
    expect(server.issuePosts()).toEqual([]);
  });
  it('SID-183. AC-10 ISS-23 (review C9): the issued card names its store in an isolated run (<bdi>) inside its status sentence — a right-to-left store name with digits at its edge reorders nothing around it — and the sentence still reads "Issued as invoice 1 at {store}."', async () => {
    const rtl = '24 متجر';
    // In the server's order (code points): '2' sorts before 'Kiosk'.
    const { server } = await ready({}, {}, (s) => { s.stores['uid-a'] = [store(STORE_1, rtl), store(STORE_RO, 'Kiosk', true), store(STORE_2, null)]; });
    await openIssue(server);
    await pressIssue();
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issued(1, rtl)));
    const status = screen.getByTestId('drafts-issue-hold-status');
    const isolated = [...status.querySelectorAll('bdi')];
    expect(isolated.map((x) => x.textContent)).toEqual([rtl]);
    expect(status.textContent).toBe(`Issued as invoice 1 at ${rtl}.`);
  });
  it('SID-184. AC-10 (review C10): while a press\'s own session check is out (before any key or POST), Issue invoice is held back and DESCRIBED why — "Checking your session before sending…" — and a second press sends nothing; then ONE POST', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    server.hold.current = 1; // the press's session check, held
    const send = screen.getByTestId('draft-issue-send');
    await user().click(send);
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
    await waitFor(() => expect(send).toHaveAttribute('aria-disabled', 'true'));
    expect(send.getAttribute('aria-describedby')).not.toBeNull();
    expect(send).toHaveAccessibleDescription(ISSUE_TEXT.sendChecking);
    expect(ISSUE_TEXT.sendChecking).toBe('Checking your session before sending…');
    await user().click(send);
    expect([server.issuePosts().length, r.keys.length]).toEqual([0, 0]);
    await release(server);
    await waitFor(() => expect(cardState()).toBe('issued'));
    expect(server.issuePosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });
  it('SID-185. AC-06 AC-08 (review C13): an earlier attempt DETACHED while unconfirmed (a sign-out) still holds back a new issue — the safe choice — and what is said is true: Issue invoice is described, and its press says, that the earlier issue could not be confirmed and must be dismissed first (the card offers only Dismiss), never "check it again or stop tracking it"; once dismissed, a press is ONE POST under a NEW key', async () => {
    const { server, props, r } = await ready({}, {}, (s, ada) => { s.seedDraft(STORE_1, ada, at(9), 700, 1); });
    await openIssue(server, 1); // the earlier draft
    server.issues.push('lose-before');
    await pressIssue();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    await act(async () => { await props.session!.logout(); });
    await waitFor(() => expect(cardState()).toBe('detached'));
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
    await click('drafts-retry');
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    await eligSettled();
    await openIssue(server, 0); // the other draft
    const send = screen.getByTestId('draft-issue-send');
    expect(send).toHaveAttribute('aria-disabled', 'true');
    const described = document.getElementById(send.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(described).not.toMatch(/check it again|stop tracking/i);
    expect(described).toBe(ISSUE_TEXT.pendingDetached);
    expect(ISSUE_TEXT.pendingDetached).toMatch(/dismiss it first/);
    await user().click(send);
    await waitFor(() => expect(screen.getByTestId('draft-issue-status')).toHaveTextContent(ISSUE_TEXT.pendingDetached));
    expect([server.issuePosts().length, r.keys.length]).toEqual([1, 1]);
    await click('draft-issue-keep');
    await waitFor(() => expect(confirm()).toBeNull());
    await click('draft-view-close');
    await click('drafts-issue-dismiss');
    expect(cardState()).toBe('none');
    await openIssue(server, 0);
    expect(screen.getByTestId('draft-issue-send')).toHaveAttribute('aria-disabled', 'false');
    await pressIssue();
    await waitFor(() => expect(cardState()).toBe('issued'));
    expect([server.issuePosts().length, r.keys.length]).toEqual([2, 2]);
  });
  it('SID-186. AC-08 (review C14): a first send refused 403 whose ONE fresh session check finds another tab\'s session (a new token: the attempt DETACHED meanwhile) ends on the earlier connection\'s note — "could not be confirmed", with Dismiss — never "Not issued … your session could not be checked right now. Close this…", and nothing is signed in or sent again', async () => {
    const { server, r } = await ready();
    await openIssue(server);
    server.issueAllow.owner = false; // the server refuses this one (nothing issued)
    server.hold.issue = 1; // its answer held
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    server.issueAllow.owner = true;
    server.otherTab('uid-a'); // what the 403's fresh check will find
    const logins = server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login).length;
    await release(server); // the 403
    await waitFor(() => expect(cardState()).toBe('detached'));
    await settle();
    expect(r.issueHolds.get('uid-a')).toMatchObject({ state: 'sending', refusal: null, csrf: null, body: '' });
    expect(screen.queryByTestId('drafts-issue-hold-refused')).toBeNull();
    expect(cardText()).toBe(ISSUE_TEXT.detached);
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
    expect(server.sent.filter((x) => x.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins);
    expect(server.issuePosts()).toHaveLength(1);
    await click('drafts-issue-dismiss');
    expect(cardState()).toBe('none');
  });
  it.each([
    ['a user change, then its 201 (the server issued it)', 'issued'],
    ['a user change, then its 403 (refused, nothing issued)', 'denied'],
    ['a user change, then its sealed 409 write_conflict', 'conflict'],
    ['a token change (another tab\'s session, seen on a focus), then its 201', 'token'],
  ] as const)('SID-187. AC-08 (review D1, jsdom-only commit ordering): a first send whose answer lands after %s changes nothing — also when it lands in the very commit that ended the earlier user\'s section, before that commit\'s passive effects run (a browser yields between them after a slow commit): the attempt stays the earlier connection\'s note with Dismiss, never issued, refused or "unchecked", and nothing is sent again', async (_what, late) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const draft = server.seedDraft(STORE_1, ada, at(5), 250, 2);
    draft.version = 3;
    server.configure(STORE_1, {});
    const r = rig(server);
    const props = r.props();
    const ctl: { setUid: (uid: string) => void; release: (() => void) | null; answered: boolean; answeredFirst: boolean | null } = { setUid: () => {}, release: null, answered: false, answeredFirst: null };
    const issuing = props.issuing!;
    // The issue's answer, noted when it reaches the section (the section's continuation runs right after it).
    const watched = { ...issuing, issue: async (...args: Parameters<typeof issuing.issue>) => { const answer = await issuing.issue(...args); ctl.answered = true; return answer; } };
    /** Another user's commit that outlasts the scheduler's frame, releasing the held answer in its layout phase. */
    function SlowCommit({ uid }: { readonly uid: string }) {
      if (uid !== 'uid-a') { const end = performance.now() + 20; while (performance.now() < end) { /* a slow render: React yields before the passive effects */ } }
      useLayoutEffect(() => { if (uid !== 'uid-a') { const release = ctl.release; ctl.release = null; release?.(); } }, [uid]);
      useEffect(() => { if (uid !== 'uid-a' && ctl.answeredFirst === null) ctl.answeredFirst = ctl.answered; }, [uid]);
      return null;
    }
    function Page() {
      const [uid, setUid] = useState('uid-a');
      ctl.setUid = setUid;
      return <><ServerInvoiceDrafts {...props} issuing={watched} uid={uid} /><SlowCommit uid={uid} /></>;
    }
    render(<Page />);
    await showAndChoose(STORE_1);
    await openIssue(server);
    if (late === 'denied') server.issueAllow.owner = false; // the server refuses this one (nothing issued)
    if (late === 'conflict') server.configure(STORE_1, { tax: { mode: 'none' } }); // settings version 2, elsewhere: the review is stale
    server.hold.issue = 1; // its answer held
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    server.issueAllow.owner = true;
    const [held] = server.held.splice(0, 1);
    if (late === 'token') {
      server.otherTab('uid-a');
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(r.issueHolds.get('uid-a')?.csrf).toBeNull());
      await act(async () => { held.release(); });
      await settle();
    } else {
      // The user change is committed by React's own scheduler (outside act(), as in a browser), and the held answer is
      // released inside that commit: it reaches the earlier user's section before the commit's passive effects.
      const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const was = env.IS_REACT_ACT_ENVIRONMENT;
      env.IS_REACT_ACT_ENVIRONMENT = false;
      ctl.release = () => held.release();
      try {
        ctl.setUid('uid-b');
        for (let i = 0; i < 100 && ctl.answeredFirst === null; i++) await new Promise((x) => realSetTimeout(x, 0));
      } finally {
        env.IS_REACT_ACT_ENVIRONMENT = was;
      }
      expect([ctl.release, ctl.answeredFirst]).toEqual([null, true]); // the precondition: released in that commit, answered before its passive effects
      await settle();
    }
    expect(r.issueHolds.get('uid-a')).toMatchObject({ state: 'sending', invoiceId: null, number: null, refusal: null, csrf: null, body: '' });
    if (late !== 'token') await act(async () => { ctl.setUid('uid-a'); }); // uid-a's section again (the same hold store)
    await settle();
    expect(cardState()).toBe('detached');
    expect(cardText()).toBe(ISSUE_TEXT.detached);
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
    expect([server.issuePosts().length, server.issuedReads().length, r.keys.length]).toEqual([1, 0, 1]);
  });
  it('SID-188. AC-03 AC-05 (review D2): a confirmed refusal of the issued invoice\'s read belongs to the ATTEMPT — after the section is left and mounted again (in-app navigation, the same hold store) the card still says the issued invoices cannot be viewed here, offers only Dismiss (no Load details again) and reads nothing on its own; Dismiss clears it', async () => {
    const { server, props, page } = await ready();
    await openIssue(server);
    server.viewIssuedAllow.owner = false; // access narrowed between the 201 and its read
    await pressIssue();
    await waitFor(() => expect(cardText()).toBe(ISSUE_TEXT.issuedDenied));
    await listReady();
    await settle();
    page.unmount();
    const mark = server.sent.length;
    render(<ServerInvoiceDrafts {...props} />);
    await settle();
    expect(cardState()).toBe('issued');
    expect(cardText()).toBe(ISSUE_TEXT.issuedDenied);
    expect(screen.queryByTestId('drafts-issue-load')).toBeNull();
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(server.sent.slice(mark).filter((x) => x.url !== TENANT_SESSION_PATHS.current)).toEqual([]); // never read again on its own
    await click('drafts-issue-dismiss');
    expect(cardState()).toBe('none');
    expect([server.issuedReads().length, server.issuePosts().length]).toEqual([1, 1]);
  });
  it('SID-189. AC-08 (review D6): a first send refused 403 while its section is not mounted (the page left meanwhile: no fresh check) settles refused, unchecked — and the card, mounted again, tells the user to DISMISS it, the one control it offers, never "Close this"', async () => {
    const { server, props, r, page } = await ready();
    await openIssue(server);
    server.issueAllow.owner = false; // the server refuses this one (nothing issued)
    server.hold.issue = 1;
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    server.issueAllow.owner = true;
    page.unmount();
    await release(server); // the 403, with no section to check it under
    await settle();
    expect(r.issueHolds.get('uid-a')).toMatchObject({ state: 'refused', refusal: 'unchecked', body: '' });
    render(<ServerInvoiceDrafts {...props} />);
    expect(cardState()).toBe('refused');
    const said = screen.getByTestId('drafts-issue-hold-refused').textContent;
    expect(said).not.toMatch(/Close this/);
    expect(said).toBe(ISSUE_TEXT.uncheckedCard);
    expect(ISSUE_TEXT.uncheckedCard).toBe('Not issued: the server refused this request, and your session could not be checked right now. Dismiss this, then open the draft again in a moment.');
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
    await click('drafts-issue-dismiss');
    expect(cardState()).toBe('none');
    expect(server.issuePosts()).toHaveLength(1);
  });

  // M7B-INVOICES-VOID-P1 — a later void does not undo the issue: an invoice found or read as voided still proves the issue
  // committed. The card says it was issued as invoice N and has since been voided — the invoice's state now, not this
  // attempt's outcome — offers no new issue, and only GETs are sent for it.
  const VOIDED_TEXT = 'Issued as invoice 1 at Main Street; it has since been voided.';
  const VOID_MEMBER = Object.freeze({ voidedAt: '2027-01-01T00:00:00.000001Z', reasonCode: 'duplicate' });

  it('SID-190. AC-07: "Find issued invoice" finding the draft\'s invoice voided since says "Issued as invoice 1 at Main Street; it has since been voided." — never "not issued", no new issue offered — and View invoice shows it Voided with its reason; the find and the view are GETs only (no POST after the refused one)', async () => {
    let other: Draft | null = null;
    const { server } = await ready({}, {}, (s, ada) => { other = s.seedDraft(STORE_1, ada, at(7), 300, 1); });
    await openIssue(server, 0);
    issueElsewhere(server, other!);
    server.invoices[0].void = { ...VOID_MEMBER }; // and voided there too
    await pressIssue();
    await waitFor(() => expect(screen.getByTestId('draft-issue-refused')).toHaveTextContent(ISSUE_REFUSED_TEXT['not-open']));
    const mark = server.sent.length;
    await click('draft-issue-find');
    await waitFor(() => expect(cardText()).toBe(VOIDED_TEXT));
    expect(ISSUE_TEXT.issued(1, 'Main Street', true)).toBe(VOIDED_TEXT);
    expect(cardState()).toBe('issued');
    expect(cardText()).not.toMatch(/not issued|nothing/i);
    expect([confirm(), view()]).toEqual([null, null]);
    expect(rows().map((x) => x.getAttribute('data-id'))).not.toContain(other!.id);
    expect(screen.queryByTestId('draft-issue-send')).toBeNull();
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['View invoice', 'Dismiss']);
    await click('drafts-issue-view');
    await waitFor(() => expect(screen.getByTestId('issued-view-title')).toHaveTextContent('Invoice 1'));
    expect(screen.getByTestId('issued-view-status')).toHaveTextContent(/^Voided$/);
    expect(screen.getByTestId('issued-view-voided-at')).toHaveTextContent('2027-01-01 00:00:00 UTC');
    expect(screen.getByTestId('issued-view-void-reason')).toHaveTextContent(/^Duplicate of another invoice$/);
    expect(screen.getByTestId('issued-view-total')).toHaveTextContent('Total $3.27');
    const after = server.sent.slice(mark);
    expect(after.filter((x) => x.method !== 'GET')).toEqual([]);
    expect(after.filter((x) => /\/invoices(\?|\/)/.test(x.url)).map((x) => x.url)).toEqual([
      `${issuedInvoicesPathOf(STORE_1)}?sourceDraft=${other!.id}`, issuedInvoicePathOf(STORE_1, server.invoices[0].id),
    ]);
    expect(server.issuePosts()).toHaveLength(1);
  });

  it('SID-191. AC-05: a 201 whose invoice is voided before the card\'s ONE read of it says "Issued as invoice 1 at Main Street; it has since been voided." with View invoice and Dismiss — the 201 still settles it issued; nothing is sent again', async () => {
    const { server } = await ready();
    await openIssue(server);
    server.hold.issue = 1;
    await pressIssue();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['issue']));
    server.invoices[0].void = { ...VOID_MEMBER }; // committed, then voided elsewhere before the shop reads it
    await release(server); // the 201
    await waitFor(() => expect(cardText()).toBe(VOIDED_TEXT));
    expect(cardState()).toBe('issued');
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['View invoice', 'Dismiss']);
    await listReady();
    await settle();
    expect(server.issuePosts()).toHaveLength(1);
    expect(server.issuedReads().map((x) => x.url)).toEqual([issuedInvoicePathOf(STORE_1, server.invoices[0].id)]);
  });
});

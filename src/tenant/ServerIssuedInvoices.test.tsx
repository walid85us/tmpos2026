// M7B-INVOICES-ISSUE-P2 — the Invoices page's "Issued invoices" section in jsdom: the store choice and the owner's issuing
// settings (commit A, SII-01..44), the issued list and one issued invoice (commit B, SII-45..60 and its review fixes
// SII-61..68, over the fake's issued store: pages newest number first with the server's cursor, the detail, a refused role). The REAL section over the REAL tenant session, drafts (its store list) and issuing clients, each wired
// to one fake tenant server at the network boundary: sessions (a reauthentication login renews a stale sign-in), store
// discovery and one store's issuing settings with an idempotency ledger keyed like the server's (key, store, exact bytes;
// a sealed 409 write_conflict and the 200 replay under their key; the tenant precondition, a read-only store's 404 and a
// stale sign-in's 403 step_up_required record nothing), the owner rule (a manager is refused 403). Synthetic tenants,
// stores and users only, ids built at run time. Ordering is controlled with the fake's hold/release and its per-request
// scripts (no sleeps; the one timed wait runs on a fake clock); the monotonic and wall clocks and the keys are injected.
// Every assertion about a request is made on what the fake recorded — the wire.
import { readFileSync } from 'node:fs';
import { StrictMode } from 'react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ISSUED_TEXT, IssuedInvoiceDialog, LIST_TEXT, SETTINGS_RULE_TEXT, SETTINGS_TEXT, ServerIssuedInvoices, VIEW_TEXT, VOID_REFUSED_TEXT, VOID_TEXT, type IssuedVoidCapability, type IssuedReadAnswer, type ServerIssuedInvoicesProps, type VoidPress, type VoidSendOutcome } from './ServerIssuedInvoices';
import { INVOICE_VOID_REASONS, VOID_REASON_CODES, createInvoiceIssuingClient, issuingSettingsPathOf, type InvoiceVoidReasonCode, type IssuedInvoice, type IssuedSummary, type VoidResult } from './invoiceIssuingClient';
import { STORES_PATH, createInvoiceDraftsClient, type StoreEntry } from './invoiceDraftsClient';
import { TENANT_SESSION_PATHS, createTenantSessionClient, sessionEndsSoFar } from './tenantSessionClient';
import { VOID_NOTE_TEXT, createVoidHoldStore, isLiveVoid, settleVoid, voidExpired, voidHolds, type HeldVoid, type VoidHoldStore, type VoidRefusal } from './invoiceVoidHold';
import type { ShopIdentity } from './ServerCustomerLevels';
import { pickerWaitText } from './ServerCustomerPicker';
import { sessionSubjectOf } from '../../server/runtime/sessions';

const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const STORE_1 = uuid(0x51);
const STORE_2 = uuid(0x52);
const STORE_RO = uuid(0x53);
const HOUR = 60 * 60_000;
const activeBody = (uid: string, csrfToken: string) => ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });

/** One request as it reached the fake: `signal` is the fetch's own, so a test sees whether the page cancelled it. */
interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined; readonly signal: AbortSignal | null }
interface User { uid: string; tenant: string; role: 'owner' | 'manager' }
type View = { storeId: string; version: number; configured: true; legalName: string; storeName: string; postalAddress: string; taxRegistrationId: string | null; tax: { mode: 'none' } | { mode: 'exclusive_rate'; rateMilliPercent: number } };
type Kind = 'stores' | 'settings' | 'put' | 'current' | 'list' | 'detail' | 'elig' | 'void';
type TaxWire = { mode: 'none' } | { mode: 'exclusive_rate'; rateMilliPercent: number };
type LineWire = { position: number; description: string; quantity: number; unitPriceCents: number; lineTotalCents: number };
/** One issued invoice as the fake stores it (commit B): what the list summarizes and the detail answers. */
interface Issued {
  id: string; number: number; sourceDraftId: string; customerId: string; customerName: string; issuedAt: string;
  seller: { legalName: string; storeName: string; postalAddress: string; taxRegistrationId: string | null }; lines: LineWire[]; tax: TaxWire;
  /** M7B-INVOICES-VOID-P1: present once voided (the detail's `void` member, the rows' status "voided"); absent, the 034 answer byte for byte. */
  void?: { voidedAt: string; reasonCode: string };
}
/** What the next PUTs do: lose the answer after deciding (committed), lose the request, answer a status in the chain's envelope, or a whole answer. */
type PutScript = 'lose' | 'lose-before' | number | Response;

function fakeServer() {
  const users: Record<string, User> = {
    'tok-a': { uid: 'uid-a', tenant: TENANT_A, role: 'owner' }, 'tok-m': { uid: 'uid-m', tenant: TENANT_A, role: 'manager' }, 'tok-b': { uid: 'uid-b', tenant: TENANT_B, role: 'owner' },
  };
  const sessions = new Map<string, { user: User; csrf: string; fresh: boolean }>();
  let sessionCount = 0;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers } });
  const WORDS: Record<number, string> = { 400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited', 503: 'service_unavailable' };
  const refuse = (status: number, error = WORDS[status] ?? `e${status}`): Response =>
    reply(status, { error, requestId: 'req-synthetic' }, status === 429 && server.retryAfter !== null ? { 'retry-after': server.retryAfter } : {});
  const login = (user: User, fresh: boolean): Response => {
    sessionCount += 1;
    server.cookie = `session-${sessionCount}`;
    sessions.set(server.cookie, { user, csrf: `${'s'.repeat(40)}${String(sessionCount).padStart(3, '0')}`, fresh });
    return reply(200, activeBody(user.uid, sessions.get(server.cookie)!.csrf));
  };
  const server = {
    sent: [] as Sent[],
    cookie: null as string | null,
    stores: { 'uid-a': [] as StoreEntry[], 'uid-m': [] as StoreEntry[], 'uid-b': [] as StoreEntry[] } as Record<string, StoreEntry[]>,
    settings: new Map<string, View>(),
    keys: new Map<string, { fingerprint: string; status: number; body: unknown }>(),
    puts: [] as PutScript[],
    getStatus: [] as Array<number | Response>, // what the next settings GETs answer instead
    issued: new Map<string, Issued[]>(), // store -> its issued invoices (served newest number first)
    issuedDenied: new Set<string>(), // users whose role lacks the issued reads (Invoices View AND Customers View)
    listStatus: [] as Array<number | Response>, // what the next list GETs answer instead
    detailStatus: [] as Array<number | Response>, // what the next detail GETs answer instead
    currentStatus: [] as number[],
    loginStatus: [] as number[], // what the next logins answer instead (in the chain's envelope): nothing is signed in
    retryAfter: null as string | null,
    staleLogins: false, // a plain login's sign-in is older than the recent-auth window (a reauthentication's never is)
    hold: { stores: 0, settings: 0, put: 0, current: 0, list: 0, detail: 0, elig: 0, void: 0 } as Record<Kind, number>,
    // M7B-INVOICES-VOID-P2: the void command and its action-only eligibility, as P1's server answers them.
    voids: [] as PutScript[], // what the next void POSTs do (as `puts`)
    eligStatus: [] as Array<number | Response>, // what the next void-eligibility GETs answer instead
    voidDenied: new Set<string>(), // users whose stored levels lack void_issued_invoices (Invoices Approve with Customers View)
    voidAt: '2026-10-17T08:30:05.000001Z', // the database clock's void time
    /** Void bodies whose keys were not exactly expectedTenant, reasonCode in that order (a throw here would read as transport loss). */
    voidBodyViolations: [] as string[],
    /** Whether `user` may void at `storeId` now: the stored levels (an owner's by default) and a writable store. */
    mayVoid(user: User, storeId: string): boolean {
      const entry = server.stores[user.uid]?.find((s) => s.id === storeId);
      return entry !== undefined && !entry.readOnly && user.role === 'owner' && !server.voidDenied.has(user.uid);
    },
    /** The void POSTs that reached the fake, as sent. */
    voidPosts(): Sent[] { return server.sent.filter((r) => r.method === 'POST' && /\/invoices\/[^/]+\/void$/.test(r.url)); },
    /** The void-eligibility reads that reached the fake (paths). */
    eligReads(): string[] { return server.sent.filter((r) => r.method === 'GET' && r.url.endsWith('/void-eligibility')).map((r) => r.url); },
    held: [] as Array<{ kind: Kind; url: string; release: (late?: Response) => void }>,
    puts_(): Sent[] { return server.sent.filter((r) => r.method === 'PUT'); },
    reads(storeId?: string): Sent[] { return server.sent.filter((r) => r.method === 'GET' && r.url.startsWith('/api/v1/issuing-settings/') && (storeId === undefined || r.url === issuingSettingsPathOf(storeId))); },
    logins(): Sent[] { return server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login); },
    /** The issued-list reads (path and query), of one store when given. */
    lists(storeId?: string): string[] {
      return server.sent.filter((r) => r.method === 'GET' && /^\/api\/v1\/stores\/[^/]+\/invoices(\?|$)/.test(r.url) && (storeId === undefined || r.url.startsWith(`${STORES_PATH}/${storeId}/invoices?`))).map((r) => r.url);
    },
    /** The issued-invoice reads (detail paths) that reached the fake, as sent. */
    detailRequests(): Sent[] { return server.sent.filter((r) => r.method === 'GET' && /^\/api\/v1\/stores\/[^/]+\/invoices\/[^/?]+$/.test(r.url)); },
    details(): string[] { return server.detailRequests().map((r) => r.url); },
    /** Every request that is not a session, store-list or settings read: what commit B must never send on its own. */
    writes(): string[] { return server.sent.filter((r) => r.method !== 'GET').filter((r) => !r.url.startsWith('/api/v1/session')).map((r) => `${r.method} ${r.url}`); },
    /** Another writer saved a new version (another tab, the owner elsewhere). */
    bump(storeId: string, over: Partial<View> = {}): View {
      const was = server.settings.get(storeId);
      const next: View = { storeId, version: (was?.version ?? 0) + 1, configured: true, legalName: 'Other Seller LLC', storeName: 'Other Name', postalAddress: '9 Elsewhere', taxRegistrationId: null, tax: { mode: 'none' }, ...was, ...over };
      next.version = (was?.version ?? 0) + 1;
      server.settings.set(storeId, next);
      return next;
    },
    expire(): void { sessions.clear(); },
    otherTab(uid: string): void { login(Object.values(users).find((u) => u.uid === uid)!, true); },
    async maybeHold(kind: Kind, url: string, answer: () => Response): Promise<Response> {
      if (server.hold[kind] > 0) {
        server.hold[kind] -= 1;
        const late = await new Promise<Response | undefined>((release) => { server.held.push({ kind, url, release }); });
        if (late !== undefined) return late;
      }
      return answer();
    },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : undefined;
      server.sent.push({ method, url, headers, body, signal: init.signal ?? null });
      if (url === TENANT_SESSION_PATHS.login && method === 'POST') {
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403);
        const scripted = server.loginStatus.shift();
        if (scripted !== undefined) return refuse(scripted);
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return refuse(401);
        return login(user, headers.get('x-tmpos-reauthenticate') === '1' || !server.staleLogins);
      }
      const session = server.cookie === null ? undefined : sessions.get(server.cookie);
      if (url === TENANT_SESSION_PATHS.current && method === 'GET') {
        const scripted = server.currentStatus.shift();
        if (scripted !== undefined) return refuse(scripted);
        return server.maybeHold('current', url, () => (session === undefined ? refuse(401) : reply(200, activeBody(session.user.uid, session.csrf))));
      }
      if (url === TENANT_SESSION_PATHS.logout) { if (server.cookie !== null) sessions.delete(server.cookie); return new Response(null, { status: 204 }); }
      const gate = (): Response | null => {
        if (session === undefined) return refuse(401);
        if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, 'forbidden');
        return null;
      };
      if (method === 'GET' && url === STORES_PATH) return server.maybeHold('stores', url, () => gate() ?? reply(200, { stores: server.stores[session!.user.uid] ?? [] }));
      const listPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\?(.*)$/.exec(url);
      const detailPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\/([0-9a-f-]{36})$/.exec(url);
      if (method === 'GET' && (listPath !== null || detailPath !== null)) {
        const kind: Kind = listPath !== null ? 'list' : 'detail';
        return server.maybeHold(kind, url, () => {
          const refused = gate();
          if (refused !== null) return refused;
          const scripted = (kind === 'list' ? server.listStatus : server.detailStatus).shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          const storeId = (listPath ?? detailPath)![1];
          if (server.issuedDenied.has(session!.user.uid) || !server.stores[session!.user.uid]?.some((s) => s.id === storeId)) return refuse(403, 'forbidden');
          const all = [...(server.issued.get(storeId) ?? [])].sort((a, b) => b.number - a.number);
          if (detailPath !== null) {
            const found = all.find((i) => i.id === detailPath[2]);
            return found === undefined ? refuse(404, 'not_found') : reply(200, detailOf(found));
          }
          const query = new URLSearchParams(listPath![2]);
          const limit = Number(query.get('limit') ?? '20');
          const cursor = query.get('cursor');
          const start = cursor === null ? 0 : all.findIndex((i) => cursorOf(i.id) === cursor) + 1;
          if (start === 0 && cursor !== null) return refuse(400, 'invalid_request'); // an anchor this store does not hold
          const page = all.slice(start, start + limit);
          return reply(200, { invoices: page.map(summaryOf), nextCursor: start + limit < all.length ? cursorOf(page[page.length - 1].id) : null });
        });
      }
      const eligPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\/([0-9a-f-]{36})\/void-eligibility$/.exec(url);
      if (method === 'GET' && eligPath !== null) {
        return server.maybeHold('elig', url, () => {
          const refused = gate();
          if (refused !== null) return refused;
          const scripted = server.eligStatus.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          return server.mayVoid(session!.user, eligPath[1]) ? reply(200, { eligibility: 'allowed' }) : refuse(403, 'forbidden');
        });
      }
      const voidPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\/([0-9a-f-]{36})\/void$/.exec(url);
      if (method === 'POST' && voidPath !== null) {
        const script = server.voids.shift();
        if (script === 'lose-before') throw new TypeError('network');
        if (typeof script === 'number') return refuse(script);
        if (script instanceof Response) return script;
        // P1's order (doc 13 §12.4): the session, CSRF and the route's authority, then the recent sign-in — all BEFORE the
        // key — then the key (422 for other bytes, a replay of a sealed answer), the tenant precondition, the target, and
        // the sealed outcome: one void record, or the sealed already-void.
        const decide = (): Response => {
          const refused = gate();
          if (refused !== null) return refused;
          if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
          const [, storeId, invoiceId] = voidPath;
          if (!server.mayVoid(session!.user, storeId)) return refuse(403, 'forbidden');
          if (!session!.fresh) return refuse(403, 'step_up_required'); // before any key: nothing acquired
          const key = headers.get('idempotency-key') ?? '';
          const fingerprint = `${session!.user.uid}\nvoid\n${storeId}\n${invoiceId}\n${body}`;
          const known = server.keys.get(key);
          if (known !== undefined && known.fingerprint !== fingerprint) return refuse(422, 'idempotency_key_reused');
          if (known !== undefined) return reply(known.status, known.body, { 'idempotent-replayed': 'true' });
          const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
          if (Object.keys(parsed).join(',') !== 'expectedTenant,reasonCode') server.voidBodyViolations.push(body ?? '');
          const entry = server.stores[session!.user.uid]?.find((s) => s.id === storeId);
          if (entry === undefined || parsed.expectedTenant !== entry.tenantId) return refuse(409, 'write_conflict');
          const found = server.issued.get(storeId)?.find((i) => i.id === invoiceId);
          if (found === undefined) return refuse(404, 'not_found');
          const seal = (status: number, sealed: unknown): Response => { server.keys.set(key, { fingerprint, status, body: sealed }); return reply(status, sealed); };
          if (found.void !== undefined) return seal(409, { error: 'invalid_state' });
          found.void = { voidedAt: server.voidAt, reasonCode: parsed.reasonCode as string };
          return seal(200, { invoice: { id: invoiceId, status: 'voided' } });
        };
        if (script === 'lose') { decide(); throw new TypeError('network'); } // committed, but the answer is lost
        // Held, the request reaches the server only when released: a substituted late answer (a 401, a step-up) decided
        // nothing there, and a plain release decides it then.
        return server.maybeHold('void', url, decide);
      }
      const settingsPath = /^\/api\/v1\/issuing-settings\/([0-9a-f-]{36})$/.exec(url);
      if (settingsPath === null) return refuse(404);
      const storeId = settingsPath[1];
      const grant = (u: User) => server.stores[u.uid]?.find((s) => s.id === storeId);
      if (method === 'GET') {
        return server.maybeHold('settings', url, () => {
          const refused = gate();
          if (refused !== null) return refused;
          const scripted = server.getStatus.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          if (session!.user.role !== 'owner') return refuse(403, 'forbidden'); // the owner rule
          if (grant(session!.user) === undefined) return refuse(404, 'not_found');
          return reply(200, { issuingSettings: server.settings.get(storeId) ?? { storeId, version: 0, configured: false } });
        });
      }
      if (method !== 'PUT') return refuse(404);
      const script = server.puts.shift();
      if (script === 'lose-before') throw new TypeError('network');
      if (typeof script === 'number') return refuse(script);
      if (script instanceof Response) return script;
      const decide = (): Response => {
        const refused = gate();
        if (refused !== null) return refused;
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
        if (session!.user.role !== 'owner') return refuse(403, 'forbidden');
        if (!session!.fresh) return refuse(403, 'step_up_required'); // before any key: nothing acquired
        const key = headers.get('idempotency-key') ?? '';
        const fingerprint = `${session!.user.uid}\n${storeId}\n${body}`;
        const known = server.keys.get(key);
        if (known !== undefined && known.fingerprint !== fingerprint) return refuse(422, 'idempotency_key_reused');
        if (known !== undefined) return reply(known.status, known.body, { 'idempotent-replayed': 'true' });
        const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
        expect(Object.keys(parsed)).toEqual(['expectedTenant', 'expectedVersion', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax']);
        const store = grant(session!.user);
        if (store === undefined || parsed.expectedTenant !== store.tenantId) return parsed.expectedTenant !== session!.user.tenant ? refuse(409, 'write_conflict') : refuse(404, 'not_found');
        if (store.readOnly) return refuse(404, 'not_found');
        const seal = (status: number, sealed: unknown): Response => { server.keys.set(key, { fingerprint, status, body: sealed }); return reply(status, sealed); };
        if ((server.settings.get(storeId)?.version ?? 0) !== parsed.expectedVersion) return seal(409, { error: 'write_conflict' });
        const view = { storeId, version: (parsed.expectedVersion as number) + 1, configured: true as const, legalName: parsed.legalName as string, storeName: parsed.storeName as string,
          postalAddress: parsed.postalAddress as string, taxRegistrationId: parsed.taxRegistrationId as string | null, tax: parsed.tax as View['tax'] };
        server.settings.set(storeId, view);
        return seal(200, { issuingSettings: view });
      };
      const decided = decide();
      if (script === 'lose') throw new TypeError('network'); // committed, but the answer is lost
      return server.maybeHold('put', url, () => decided);
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

/** The server's continuation for a page ending at `id` (invoiceIssuing.ts encodeIssuedInvoiceCursor). */
const cursorOf = (id: string): string => Buffer.concat([Buffer.from([0x04]), Buffer.from(id.replace(/-/g, ''), 'hex')]).toString('base64url');
/** The amounts a subtotal derives under a tax setting (doc 12 §10.8, BigInt), as the wire shows them. */
function amountsFor(subtotal: number, tax: TaxWire) {
  if (tax.mode === 'none') return { currency: 'USD', subtotalCents: subtotal, tax: { mode: 'none', description: 'No tax calculated' }, totalCents: subtotal };
  const amount = Number((BigInt(subtotal) * BigInt(tax.rateMilliPercent) + 50_000n) / 100_000n);
  return { currency: 'USD', subtotalCents: subtotal, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: tax.rateMilliPercent, amountCents: amount }, totalCents: subtotal + amount };
}
const subtotalOf = (i: Issued): number => i.lines.reduce((n, l) => n + l.lineTotalCents, 0);
const summaryOf = (i: Issued) => ({
  id: i.id, number: i.number, sourceDraftId: i.sourceDraftId, customerId: i.customerId, customerName: i.customerName, currency: 'USD',
  totalCents: amountsFor(subtotalOf(i), i.tax).totalCents, issuedAt: i.issuedAt, status: i.void === undefined ? 'issued' : 'voided', snapshotVersion: 1,
});
const detailOf = (i: Issued) => ({
  invoice: {
    id: i.id, number: i.number, status: i.void === undefined ? 'issued' : 'voided', snapshotVersion: 1, issuedAt: i.issuedAt, sourceDraft: { id: i.sourceDraftId, version: 1 },
    seller: i.seller, issuingSettingsVersion: 1, customer: { id: i.customerId, name: i.customerName, version: 1 }, lines: i.lines, amounts: amountsFor(subtotalOf(i), i.tax),
    ...(i.void === undefined ? {} : { void: i.void }),
  },
});
const line = (position: number, description: string, quantity: number, unitPriceCents: number): LineWire => ({ position, description, quantity, unitPriceCents, lineTotalCents: quantity * unitPriceCents });
const SELLER = Object.freeze({ legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: 'TX-1' as string | null });
/** Issued invoice `n` (number `n`) of a store: its own ids and second, one line of 1999 cents at 8.875 % unless `over` says otherwise. */
const invoice = (n: number, over: Partial<Issued> = {}): Issued => ({
  id: uuid(0x1a00 + n), number: n, sourceDraftId: uuid(0xd400 + n), customerId: uuid(0xc5), customerName: 'Ada Customer',
  issuedAt: `2026-10-16T21:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.123456Z`,
  seller: { ...SELLER }, lines: [line(1, 'Screen repair', 1, 1999)], tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 }, ...over,
});
/** `count` invoices numbered 1..count at `storeId`. */
const issueAt = (server: Server, storeId: string, count: number, over: (n: number) => Partial<Issued> = () => ({})): Issued[] => {
  const made = Array.from({ length: count }, (_, i) => invoice(i + 1, over(i + 1)));
  server.issued.set(storeId, made);
  return made;
};

const store = (id: string, name: string | null, readOnly = false, tenantId = TENANT_A): StoreEntry => ({ id, tenantId, name, readOnly });
function seeded() {
  const server = fakeServer();
  server.stores['uid-a'] = [store(STORE_RO, 'Kiosk', true), store(STORE_1, 'Main Street'), store(STORE_2, null)];
  server.stores['uid-m'] = [store(STORE_1, 'Main Street')];
  server.stores['uid-b'] = [store(uuid(0x61), 'B Store', false, TENANT_B)];
  return server;
}

interface Rig { keys: string[]; clock: { mono: number; wall: number }; reauth: Array<string | null>; holds: VoidHoldStore; props: (over?: Partial<ServerIssuedInvoicesProps>) => ServerIssuedInvoicesProps }
function rig(server: Server): Rig {
  const keys: string[] = [];
  const reauth: Array<string | null> = [];
  const clock = { mono: 1_000, wall: Date.UTC(2026, 9, 16, 12) };
  const session = createTenantSessionClient({ fetch: server.fetch });
  const issuing = createInvoiceIssuingClient({ fetch: server.fetch });
  const drafts = createInvoiceDraftsClient({ fetch: server.fetch });
  const tokens: Record<string, string> = { 'uid-a': 'tok-a', 'uid-m': 'tok-m', 'uid-b': 'tok-b' };
  // Each rig its own void hold on the rig's clocks (never the shop's singleton): a new store and a remount is a page load.
  const holds = createVoidHoldStore({ now: () => clock.mono, wallNow: () => clock.wall });
  const identity: ShopIdentity = {
    idToken: async (uid) => tokens[uid] ?? null,
    reauthMethod: () => 'password',
    reauthenticate: async (uid, password) => { reauth.push(password); return password === 'correct horse' ? tokens[uid] ?? null : null; },
  };
  return {
    keys, clock, reauth, holds,
    props: (over = {}) => ({
      uid: 'uid-a', session, issuing, drafts, identity, now: () => clock.mono, wallNow: () => clock.wall, voidHolds: holds,
      newKey: () => { const k = ['5e1f0000', '1d2f', '4a6b', '9c8d', String(keys.length + 1).padStart(12, '0')].join('-'); keys.push(k); return k; },
      ...over,
    }),
  };
}

const realSetTimeout = globalThis.setTimeout;
const flush = () => act(async () => { await new Promise((r) => realSetTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const until = async (check: () => void) => {
  for (let i = 0; ; i++) {
    try { check(); return; } catch (error) { if (i >= 200) throw error; await flush(); }
  }
};
const user = () => userEvent.setup();
const click = async (testId: string) => { await user().click(screen.getByTestId(testId)); };
const tid = (testId: string) => screen.getByTestId(testId);
const storesReady = () => waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready'));
const panelPhase = () => screen.queryByTestId('issued-settings-state')?.getAttribute('data-phase') ?? 'none';
const panelReady = () => waitFor(() => expect(panelPhase()).toBe('ready'));
const status = () => tid('issued-settings-status');
const attemptState = () => screen.queryByTestId('issued-settings-attempt')?.getAttribute('data-state') ?? 'none';
async function showAndChoose(id: string) {
  if (screen.queryByTestId('issued-show') !== null) await click('issued-show');
  await storesReady();
  fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: id } });
}
async function openSettings(id = STORE_1) {
  await showAndChoose(id);
  await click('issued-settings-open');
  await waitFor(() => expect(panelPhase()).not.toBe('loading'));
}
const type = (testId: string, value: string) => fireEvent.change(tid(testId), { target: { value } });
/** Fill every field of the form (an exclusive rate unless `mode` says none). */
function fill(over: { legal?: string; store?: string; address?: string; taxId?: string; mode?: 'rate' | 'none'; rate?: string } = {}) {
  type('issued-settings-legal-name', over.legal ?? 'Example Repairs LLC');
  type('issued-settings-store-name', over.store ?? 'Main Street');
  type('issued-settings-postal-address', over.address ?? '1 Main St\nSpringfield');
  type('issued-settings-tax-id', over.taxId ?? '');
  fireEvent.click(tid(over.mode === 'none' ? 'issued-settings-tax-none' : 'issued-settings-tax-rate'));
  if (over.mode !== 'none') type('issued-settings-rate', over.rate ?? '8.875');
}
const BODY = (version: number, tax: string, taxId: string | null = null) =>
  `{"expectedTenant":"${TENANT_A}","expectedVersion":${version},"legalName":"Example Repairs LLC","storeName":"Main Street","postalAddress":"1 Main St\\nSpringfield","taxRegistrationId":${taxId === null ? 'null' : `"${taxId}"`},"tax":${tax}}`;
const RATE_8875 = '{"mode":"exclusive_rate","rateMilliPercent":8875}';
const focusEvents = async () => { await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }); await settle(); };
/** A refusal in the chain's envelope, for a held request's late answer or a scripted one. */
const chain = (status: number, error: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error, requestId: 'req-synthetic' }), { status, headers: { 'content-type': 'application/json', ...headers } });
/** The texts a control's aria-describedby names, joined. */
const describedBy = (testId: string): string =>
  (tid(testId).getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
/** What the fake recorded from index `from` on, as "METHOD url". */
const sentFrom = (server: Server, from: number): string[] => server.sent.slice(from).map((s) => `${s.method} ${s.url}`);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Issued invoices — the section and the store choice (M7B-INVOICES-ISSUE-P2)', () => {
  it('SII-01. nothing is read before "Show issued invoices" — not on mount, a focus or a tab return; then the stores are listed by name or ID ending, none preselected, read-only marked, and choosing one reads no settings', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await focusEvents();
    expect(server.sent).toEqual([]);
    expect(tid('issued-section')).toHaveTextContent('Issued invoices');
    await click('issued-show');
    await storesReady();
    const select = tid('issued-store') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a store…', 'Kiosk (read-only)', 'Main Street', `Store, ID ending ${STORE_2.slice(-8)}`]);
    fireEvent.change(select, { target: { value: STORE_1 } });
    await settle();
    expect(server.reads()).toHaveLength(0);
    expect(tid('issued-settings-open')).toHaveAttribute('aria-expanded', 'false');
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-02. a user without a uid sees nothing; the section is one per UID — another user\'s section starts over and shows nothing of the first', async () => {
    const server = seeded();
    const r = rig(server);
    const view = render(<ServerIssuedInvoices {...r.props({ uid: null })} />);
    expect(screen.queryByTestId('issued-section')).toBeNull();
    view.rerender(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    view.rerender(<ServerIssuedInvoices {...r.props({ uid: 'uid-b' })} />);
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(screen.getByTestId('issued-show')).toBeInTheDocument();
    expect(server.puts_()).toHaveLength(0);
  });
});

describe('Issued invoices — the owner\'s issuing settings (M7B-INVOICES-ISSUE-P2, AC-02/AC-03)', () => {
  it('SII-03. an unconfigured store (version 0) shows empty fields with NO tax mode chosen and the rate disabled — nothing filled in from this browser; one GET on open, no PUT', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    expect(server.reads(STORE_1)).toHaveLength(1);
    expect(server.reads(STORE_1)[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}\d{3}$/);
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.unconfigured);
    for (const id of ['legal-name', 'store-name', 'postal-address', 'tax-id', 'rate']) expect(tid(`issued-settings-${id}`)).toHaveValue('');
    expect(tid('issued-settings-tax-rate')).not.toBeChecked();
    expect(tid('issued-settings-tax-none')).not.toBeChecked();
    expect(tid('issued-settings-rate')).toBeDisabled();
    expect(tid('issued-settings-no-tax-note')).toHaveTextContent(SETTINGS_TEXT.noTax);
    expect(SETTINGS_TEXT.noTax).toMatch(/owner's own choice: the product does not check whether tax applies/);
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-04. Save sends ONE PUT of the exact bytes (the store\'s tenant, the version read, 8.875 as 8875) under one new key; "Saved" only after a fresh read finds that version with those values', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.hold.settings = 1; // the read-back
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(server.puts_()).toHaveLength(1);
    const put = server.puts_()[0];
    expect(put.body).toBe(BODY(0, RATE_8875));
    expect(put.headers.get('idempotency-key')).toBe(r.keys[0]);
    expect(put.headers.get('x-tmpos-csrf')).toBe('1');
    expect(status()).toHaveTextContent(SETTINGS_TEXT.readingBack(1));
    expect(status()).not.toHaveTextContent(/^Saved:/);
    server.held.shift()!.release();
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(status()).toHaveAttribute('data-tone', 'saved');
    expect(server.reads(STORE_1)).toHaveLength(2); // the open, then the read-back
    expect(tid('issued-settings-rate')).toHaveValue('8.875');
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.version(1));
    expect(r.keys).toHaveLength(1);
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-05. "No tax calculated" sends exactly {"mode":"none"} (the rate field ignored), and an explicit 0 stays a real rate — read back as "0" under Exclusive rate, never as none', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill({ mode: 'none' });
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()[0].body).toBe(BODY(0, '{"mode":"none"}'));
    expect(tid('issued-settings-tax-none')).toBeChecked();
    fireEvent.click(tid('issued-settings-tax-rate'));
    type('issued-settings-rate', '0');
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(2)));
    expect(server.puts_()[1].body).toBe(BODY(1, '{"mode":"exclusive_rate","rateMilliPercent":0}'));
    expect(tid('issued-settings-tax-rate')).toBeChecked();
    expect(tid('issued-settings-rate')).toHaveValue('0');
    expect(server.settings.get(STORE_1)?.tax).toEqual({ mode: 'exclusive_rate', rateMilliPercent: 0 });
  });

  it('SII-06. an invalid form sends NOTHING (no session check, no key): each field says its own rule, marked invalid and described by it, and the first invalid field takes focus', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    const before = server.sent.length;
    type('issued-settings-legal-name', '   ');
    type('issued-settings-store-name', 'x'.repeat(121));
    type('issued-settings-postal-address', 'Line one\n\nLine three');
    type('issued-settings-tax-id', 'x'.repeat(65));
    await click('issued-settings-save');
    await settle();
    expect(server.sent.length).toBe(before);
    expect(r.keys).toEqual([]);
    for (const [id, rule] of [['legal-name', SETTINGS_RULE_TEXT.legalName], ['store-name', SETTINGS_RULE_TEXT.storeName], ['postal-address', SETTINGS_RULE_TEXT.postalAddress], ['tax-id', SETTINGS_RULE_TEXT.taxRegistrationId]] as const) {
      expect(tid(`issued-settings-${id}`)).toHaveAttribute('aria-invalid', 'true');
      expect(tid(`issued-settings-${id}-error`)).toHaveTextContent(rule);
      expect(tid(`issued-settings-${id}`).getAttribute('aria-describedby')).toContain(`issued-settings-${id}-error`);
    }
    expect(tid('issued-settings-tax-mode-error')).toHaveTextContent(SETTINGS_RULE_TEXT.taxMode); // no default tax mode
    expect(document.activeElement).toBe(tid('issued-settings-legal-name'));
    fill({ rate: '8.8755' });
    await click('issued-settings-save');
    await settle();
    expect(tid('issued-settings-rate-error')).toHaveTextContent(SETTINGS_RULE_TEXT.rate);
    expect(server.sent.length).toBe(before);
    type('issued-settings-legal-name', 'Fixed');
    expect(screen.queryByTestId('issued-settings-legal-name-error')).toBeNull(); // editing a field clears its own error
  });

  it('SII-07. a configured store fills the form from the server only (the rate as its exact digits), and a manager is refused: ONE fresh session check, then the owner-only text — no form, no loop, nothing written', async () => {
    const server = seeded();
    server.settings.set(STORE_1, { storeId: STORE_1, version: 4, configured: true, legalName: 'Seller', storeName: 'Shop', postalAddress: 'A\nB', taxRegistrationId: 'TX', tax: { mode: 'exclusive_rate', rateMilliPercent: 500 } });
    const r = rig(server);
    const view = render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    expect(tid('issued-settings-legal-name')).toHaveValue('Seller');
    expect(tid('issued-settings-postal-address')).toHaveValue('A\nB');
    expect(tid('issued-settings-rate')).toHaveValue('0.5');
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.version(4));
    view.unmount();
    const manager = rig(server);
    render(<ServerIssuedInvoices {...manager.props({ uid: 'uid-m' })} />);
    const reads = server.reads().length;
    const mark = server.sent.length;
    await openSettings();
    await waitFor(() => expect(panelPhase()).toBe('denied'));
    const refusedAt = server.sent.findIndex((s, i) => i >= mark && s.method === 'GET' && s.url === issuingSettingsPathOf(STORE_1));
    expect(tid('issued-settings-state')).toHaveTextContent(SETTINGS_TEXT.denied);
    expect(tid('issued-settings-state')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('issued-settings-legal-name')).toBeNull();
    expect(server.reads().length - reads).toBe(1); // one read, never asked again on its own
    // after the 403: exactly ONE fresh session check (a read, not a login), and nothing else
    expect(server.sent.slice(refusedAt + 1).map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    await focusEvents();
    expect(server.reads().length - reads).toBe(1);
    expect(server.puts_()).toHaveLength(0);
    expect(manager.keys).toEqual([]);
  });

  it('SII-08. a read-only store\'s settings can be read but offer no Save: the fields are disabled and say why', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings(STORE_RO);
    await panelReady();
    expect(tid('issued-settings-read-only')).toHaveTextContent(SETTINGS_TEXT.readOnly);
    expect(screen.queryByTestId('issued-settings-save')).toBeNull();
    expect(tid('issued-settings-legal-name')).toBeDisabled();
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-09. a version conflict (sealed 409) keeps the edits and offers "Load current version": an explicit read that keeps them, shows what the server holds and moves the base; the next Save is a NEW key at that version', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.bump(STORE_1, { legalName: 'Elsewhere LLC' }); // another writer, after this form loaded version 0
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.conflict));
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC'); // the edits are kept
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.conflictBlocked);
    await click('issued-settings-save'); // blocked: nothing sent
    expect(server.puts_()).toHaveLength(1);
    const reads = server.reads().length;
    await click('issued-settings-load-current');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.loadedCurrent(1)));
    expect(server.reads().length - reads).toBe(1);
    expect(tid('issued-settings-server-now')).toHaveTextContent('Elsewhere LLC');
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC');
    expect(server.puts_()).toHaveLength(1); // a read, never a save
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(2)));
    expect(server.puts_()[1].body).toBe(BODY(1, RATE_8875));
    expect(server.puts_()[1].headers.get('idempotency-key')).toBe(r.keys[1]);
    expect(r.keys[1]).not.toBe(r.keys[0]);
  });

  it('SII-10. a confirmed PUT whose read-back fails says so and is NEVER sent again; one that finds a newer version says that; Refresh only reads', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.getStatus.push(503);
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.unread(1)));
    expect(status()).not.toHaveTextContent(/^Saved:/);
    await settle();
    expect(server.puts_()).toHaveLength(1);
    await click('issued-settings-refresh');
    await panelReady();
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.version(1));
    expect(server.puts_()).toHaveLength(1);
    // A save whose read-back finds a newer version (another writer right after it).
    type('issued-settings-store-name', 'Main Street');
    server.hold.settings = 1;
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.bump(STORE_1, { storeName: 'Later Name' });
    server.held.shift()!.release();
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.newer(2, 3)));
    expect(tid('issued-settings-store-name')).toHaveValue('Later Name');
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-11. a stale sign-in (403 step_up_required, no key acquired) shows the sign-in group; an explicit sign-in renews the session, re-reads the settings and says "press Save" — nothing is saved until Save is pressed again', async () => {
    const server = seeded();
    server.staleLogins = true;
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    expect(status()).toHaveTextContent(SETTINGS_TEXT.stepUp);
    expect(document.activeElement).toBe(tid('issued-settings-reauth-password'));
    expect(server.keys.size).toBe(0); // nothing recorded
    type('issued-settings-reauth-password', 'wrong');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.reauthFailed));
    expect(server.logins().filter((l) => l.headers.get('x-tmpos-reauthenticate') === '1')).toHaveLength(0);
    const reads = server.reads().length;
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    expect(server.logins().filter((l) => l.headers.get('x-tmpos-reauthenticate') === '1')).toHaveLength(1);
    expect(server.reads().length - reads).toBe(1); // the settings read again under the renewed session
    expect(screen.queryByTestId('issued-settings-reauth-group')).toBeNull();
    expect(document.activeElement).toBe(tid('issued-settings-save'));
    await focusEvents();
    await settle();
    expect(server.puts_()).toHaveLength(1); // never saved on its own after the sign-in
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC');
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()).toHaveLength(2);
    expect(server.puts_()[1].body).toBe(server.puts_()[0].body);
    expect(server.puts_()[1].headers.get('idempotency-key')).not.toBe(server.puts_()[0].headers.get('idempotency-key'));
    expect(r.reauth).toEqual(['wrong', 'correct horse']);
  });

  it('SII-12. a version that moved while the owner signed in again is a conflict after the sign-in — the save waits for "Load current version"', async () => {
    const server = seeded();
    server.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.bump(STORE_1);
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.conflict));
    expect(tid('issued-settings-load-current')).toBeInTheDocument();
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(server.puts_()).toHaveLength(1);
  });
});

describe('Issued invoices — an unconfirmed settings write (M7B-INVOICES-ISSUE-P2, AC-02, AC-08)', () => {
  it('SII-13. a lost answer leaves the write UNRESOLVED with the form locked (editing cannot change the held body); "Check again" sends the byte-identical body under the SAME key and token, and its replay is then read back', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose'); // committed, the answer lost
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(tid('issued-settings-attempt')).toHaveTextContent(SETTINGS_TEXT.unresolved);
    expect(tid('issued-settings-legal-name')).toBeDisabled();
    fireEvent.change(tid('issued-settings-legal-name'), { target: { value: 'Changed While Held' } });
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.saveBlocked);
    await click('issued-settings-save');
    expect(server.puts_()).toHaveLength(1);
    await click('issued-settings-check-again');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    const [first, second] = server.puts_();
    expect(second.body).toBe(first.body);
    expect(second.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'));
    expect(second.headers.get('x-tmpos-session-csrf')).toBe(first.headers.get('x-tmpos-session-csrf'));
    expect(r.keys).toHaveLength(1);
    expect(server.settings.get(STORE_1)?.version).toBe(1); // saved once
    expect(screen.queryByTestId('issued-settings-attempt')).toBeNull();
  });

  it('SII-14. request_in_progress and a 503 stay unresolved; past 23 hours from the FIRST send — the larger of monotonic and wall-clock elapsed, judged at the press and again just before sending — Check again sends nothing', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push(503);
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.puts.push(new Response(JSON.stringify({ error: 'request_in_progress', requestId: 'r' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent('still working on it'));
    expect(attemptState()).toBe('unresolved');
    r.clock.wall += 23 * HOUR; // the wall clock alone crosses it
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    expect(server.puts_()).toHaveLength(2);
    expect(screen.queryByTestId('issued-settings-check-again')).toBeNull(); // the body is gone: nothing can be re-sent
    // Judged again just before sending: the cutoff passed during the press's session check.
    cleanup();
    const late = seeded();
    const r2 = rig(late);
    render(<ServerIssuedInvoices {...r2.props()} />);
    await openSettings();
    fill();
    late.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r2.clock.mono += 23 * HOUR - 1;
    late.hold.current = 1;
    await click('issued-settings-check-again');
    await waitFor(() => expect(late.held).toHaveLength(1));
    r2.clock.mono += 1;
    late.held.shift()!.release();
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    expect(late.puts_()).toHaveLength(1);
  });

  it('SII-15. "Stop tracking" sends nothing, reads the settings afresh (the server\'s truth replaces the form), and the next Save is a NEW key at the version read', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose'); // it did commit
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    const reads = server.reads().length;
    await click('issued-settings-stop');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.stopped));
    await panelReady();
    expect(server.reads().length - reads).toBe(1);
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.version(1)); // what the lost answer would have said
    expect(server.puts_()).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Issuing settings' }));
    type('issued-settings-store-name', 'Renamed');
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(2)));
    expect(server.puts_()[1].headers.get('idempotency-key')).toBe(r.keys[1]);
    expect(JSON.parse(server.puts_()[1].body ?? '{}').expectedVersion).toBe(1);
  });

  it('SII-16. a store change closes the panel and drops an unresolved write (its key, body and token): only a note that it could not be confirmed stays; reopening reads afresh and revives nothing', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(tid('issued-detached')).toHaveTextContent(SETTINGS_TEXT.detached);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    expect(screen.queryByTestId('issued-settings-attempt')).toBeNull();
    expect(tid('issued-settings-legal-name')).toHaveValue(''); // the server's (version 0), not the held body
    await focusEvents();
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-17. a sign-out (onSessionEnd) while a write is unresolved clears the panel at once; focus and a tab return never sign in; only Reconnect does, and nothing is re-sent', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await act(async () => { await r.props().session!.logout(); });
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(tid('issued-detached')).toBeInTheDocument();
    const logins = server.logins().length;
    await focusEvents();
    expect(server.logins()).toHaveLength(logins);
    await click('issued-retry'); // Reconnect
    await storesReady();
    expect(server.logins()).toHaveLength(logins + 1);
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-18. a session ended on the server (401) ends the section; a later focus asks no login; another tab\'s token is a new generation that drops the panel and says the connection changed', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.otherTab('uid-a'); // a new token for the same user
    await focusEvents();
    await waitFor(() => expect(screen.queryByTestId('issued-settings')).toBeNull());
    await storesReady();
    expect(tid('issued-connection-changed')).toHaveTextContent(ISSUED_TEXT.connection);
    expect((tid('issued-store') as HTMLSelectElement).value).toBe('');
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    const logins = server.logins().length;
    server.expire();
    await click('issued-settings-refresh');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    await focusEvents();
    expect(server.logins()).toHaveLength(logins); // a confirmed end: no sign-in on its own
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-19. late answers change nothing: a settings read outrun by a store change, a PUT whose store was changed before it answered (no "Saved", no read-back), a read-back after a sign-out', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    server.hold.settings = 1;
    await click('issued-settings-open');
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    fill();
    server.hold.put = 1;
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    const reads = server.reads().length;
    server.held.shift()!.release();
    await settle();
    expect(server.reads()).toHaveLength(reads); // no read-back for a dropped attempt
    expect(screen.queryByText(/^Saved:/)).toBeNull();
    // A read-back out when a sign-out begins: its late answer is dropped.
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    type('issued-settings-store-name', 'Again');
    server.hold.settings = 1;
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { await r.props().session!.logout(); });
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(screen.queryByText(/^Saved:/)).toBeNull();
    expect(tid('issued-notice')).toHaveTextContent(SETTINGS_TEXT.savedEnded(2)); // confirmed, not read back: still said
  });

  it('SII-20. a 429 starts one wait: Save and Check again are held back with their reason, and the timer only gives them back — it sends nothing', async () => {
    const server = seeded();
    server.retryAfter = '30';
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    fakeClock();
    server.puts.push(429);
    fireEvent.click(tid('issued-settings-check-again'));
    await until(() => { expect(attemptState()).toBe('unresolved'); expect(tid('issued-settings-check-again')).toHaveAttribute('aria-disabled', 'true'); }); // a 429 never erases an uncertain attempt
    expect(tid('issued-settings-attempt-note')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-settings-check-again')).toHaveAccessibleDescription(SETTINGS_TEXT.checkWaiting);
    fireEvent.click(tid('issued-settings-check-again'));
    await flush();
    const sent = server.puts_().length;
    await advance(31_000);
    await until(() => expect(tid('issued-settings-check-again')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.puts_()).toHaveLength(sent); // the countdown re-enables; it never submits
    expect(sent).toBe(2);
  });

  it('SII-21. no PUT ever leaves on its own: mount, focus, a tab return, timers, closing and reopening the panel, a denial\'s fresh check, Reconnect and a renewed sign-in all send none', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    server.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await focusEvents();
    await openSettings();
    fill();
    await click('issued-settings-open'); // closed
    await click('issued-settings-open'); // reopened: the server's values again (nothing typed survives)
    await panelReady();
    expect(tid('issued-settings-legal-name')).toHaveValue('');
    fill();
    await click('issued-settings-save'); // the one PUT: refused for a stale sign-in
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    await focusEvents();
    await new Promise((res) => setTimeout(res, 30));
    await settle();
    server.expire();
    await click('issued-settings-refresh');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    await click('issued-retry');
    await storesReady();
    await settle();
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-22. under StrictMode (setup, cleanup, setup) one Save is one PUT; two presses before React commits the first are still ONE PUT under ONE key', async () => {
    const server = seeded();
    const r = rig(server);
    render(<StrictMode><ServerIssuedInvoices {...r.props()} /></StrictMode>);
    await openSettings();
    fill();
    server.hold.put = 1;
    const save = tid('issued-settings-save');
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.held.shift()!.release();
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it('SII-23. every other first answer is said for what it is and decides the attempt (nothing held): tenant changed, not found, key reused, refused (one fresh check), the session ended', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    const cases: Array<[Response, string]> = [
      [new Response(JSON.stringify({ error: 'write_conflict', requestId: 'r' }), { status: 409, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.tenantChanged],
      [new Response(JSON.stringify({ error: 'not_found', requestId: 'r' }), { status: 404, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.notFoundWrite],
      [new Response(JSON.stringify({ error: 'idempotency_key_reused', requestId: 'r' }), { status: 422, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.keyReused],
      [new Response(JSON.stringify({ error: 'invalid_request', requestId: 'r' }), { status: 400, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.invalid],
      [new Response(JSON.stringify({ error: 'forbidden', requestId: 'r' }), { status: 403, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.deniedWrite],
    ];
    fill();
    const logins = server.logins().length;
    for (const [answer, text] of cases) {
      const puts = server.puts_().length;
      server.puts.push(answer);
      await click('issued-settings-save');
      await waitFor(() => expect(status()).toHaveTextContent(text));
      expect(screen.queryByTestId('issued-settings-attempt')).toBeNull();
      await settle();
      expect(server.puts_()).toHaveLength(puts + 1); // one PUT per press, never a second on its own
    }
    // The refusal's one fresh check: after the refused PUT (the last one), exactly ONE session read — no login, no loop.
    expect(sentFrom(server, server.sent.indexOf(server.puts_()[cases.length - 1]) + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.logins()).toHaveLength(logins);
    expect(server.settings.get(STORE_1)).toBeUndefined();
    server.puts.push(new Response(JSON.stringify({ error: 'unauthenticated', requestId: 'r' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-settings')).toBeNull();
  });

  it('SII-24. a Check again refused 403 keeps the attempt unresolved with the refusal standing; a sign-out during the check drops it and its late answer changes nothing', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.puts.push(403);
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent('refusal stands'));
    expect(attemptState()).toBe('unresolved');
    server.hold.put = 1;
    await click('issued-settings-check-again');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { await r.props().session!.logout(); });
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(screen.queryByText(/^Saved:/)).toBeNull();
    expect(server.puts_()).toHaveLength(3);
  });

  it('SII-25. AC-11: nothing reaches browser storage, the address or a log; no token, key or body in the DOM; the new sources use none of them', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const server = seeded();
    const r = rig(server);
    const href = window.location.href;
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(setItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(document.body.innerHTML).not.toContain('s'.repeat(40));
    expect(document.body.innerHTML).not.toContain(r.keys[0]);
    expect(document.body.innerHTML).not.toContain('expectedVersion');
    for (const file of ['ServerIssuedInvoices.tsx', 'invoiceIssuingClient.ts', 'invoiceVoidHold.ts']) { // M7B-INVOICES-VOID-P2: the held void attempt too
      const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|history\.|location\.(href|search|hash)|from '[^']*server\//);
    }
  });
});

describe('Issued invoices — review fixes: the Save window, the sign-in and late answers (M7B-INVOICES-ISSUE-P2, AC-02, AC-08, AC-10)', () => {
  it('SII-26. Save locks the form and Refresh from the press — through its session check, before any key — so a Refresh cannot strand the panel loading, and an edit typed meanwhile never sits beside a held body it is not in', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.hold.current = 1; // the Save's session check
    server.puts.push('lose'); // committed, the answer lost: the held body stays on screen
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(server.puts_()).toHaveLength(0); // nothing sent yet
    expect(tid('issued-settings-refresh')).toBeDisabled();
    expect(tid('issued-settings-legal-name')).toBeDisabled();
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.busy);
    fireEvent.change(tid('issued-settings-legal-name'), { target: { value: 'Typed During Save' } });
    fireEvent.click(tid('issued-settings-refresh'));
    const reads = server.reads().length;
    server.held.shift()!.release();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await settle();
    expect(panelPhase()).toBe('ready');
    expect(server.reads()).toHaveLength(reads); // no Refresh read
    expect(server.puts_()).toHaveLength(1);
    expect(server.puts_()[0].body).toBe(BODY(0, RATE_8875));
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC'); // what the held body says
  });

  it('SII-27. a closed panel\'s request never holds up the next panel: Save on a store chosen after a change sends at once while the first PUT is still out, and that late answer changes nothing', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.hold.put = 1;
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    expect(tid('issued-detached')).toHaveTextContent(SETTINGS_TEXT.detached); // the first one: not confirmed here
    await click('issued-settings-open');
    await panelReady();
    fill({ store: 'Second Store' });
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_().map((p) => p.url)).toEqual([issuingSettingsPathOf(STORE_1), issuingSettingsPathOf(STORE_2)]);
    server.held.shift()!.release();
    await settle();
    expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1));
    expect(tid('issued-settings-store-name')).toHaveValue('Second Store');
  });

  it('SII-28. a 429 on the one fresh check after a refused read starts the section\'s wait even when the panel closed meanwhile: the next panel reads nothing until it has passed', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.hold.settings = 1;
    await click('issued-settings-open');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.hold.current = 1; // the one fresh check after the refusal
    server.held.shift()!.release(chain(403, 'forbidden'));
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } }); // the panel goes before the check answers
    server.held.shift()!.release(chain(429, 'rate_limited', { 'retry-after': '30' }));
    await settle();
    const reads = server.reads().length;
    await click('issued-settings-open');
    await settle();
    expect(panelPhase()).toBe('rate-limited');
    expect(tid('issued-settings-state')).toHaveTextContent('Wait 30 seconds');
    expect(server.reads()).toHaveLength(reads);
  });

  it('SII-29. after an explicit sign-in Save waits until the settings are read under the renewed session: a re-read that fails keeps it waiting with its reason, and only "Check the settings again" — a read — lets it go', async () => {
    const server = seeded();
    server.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.getStatus.push(503); // the re-read after the sign-in
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.loadFailed));
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.rereadBlocked);
    await click('issued-settings-save');
    await settle();
    expect(server.puts_()).toHaveLength(1);
    const reads = server.reads().length;
    await click('issued-settings-reread');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    expect(server.reads().length - reads).toBe(1);
    expect(server.puts_()).toHaveLength(1); // a read, never a save
    expect(screen.queryByTestId('issued-settings-reread')).toBeNull();
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-30. Enter in the sign-in\'s password field confirms the sign-in — it never submits the settings form around it (no PUT, no key)', async () => {
    const server = seeded();
    server.staleLogins = true;
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    const keys = r.keys.length;
    await user().type(tid('issued-settings-reauth-password'), 'correct horse{Enter}');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    expect(r.reauth).toEqual(['correct horse']);
    expect(server.puts_()).toHaveLength(1);
    expect(r.keys).toHaveLength(keys);
  });

  it('SII-31. a control the panel removes while it has focus hands focus to the panel\'s title, not the section heading: Check again whose replay is saved, and Check again judged too old', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    const title = screen.getByRole('heading', { name: 'Issuing settings' });
    await click('issued-settings-check-again');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(document.activeElement).toBe(title);
    type('issued-settings-store-name', 'Again');
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.wall += 23 * HOUR;
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    expect(document.activeElement).toBe(title);
  });

  it('SII-32. every locked or invalid control says why: the rate while no exclusive rate is chosen, every field of a read-only store or under a save not yet confirmed; the tax mode\'s error rides its radios, not the group', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings(STORE_RO);
    await panelReady();
    for (const id of ['legal-name', 'store-name', 'postal-address', 'tax-id', 'tax-rate', 'tax-none']) expect(describedBy(`issued-settings-${id}`)).toContain(SETTINGS_TEXT.readOnly);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    expect(tid('issued-settings-rate')).toBeDisabled();
    expect(describedBy('issued-settings-rate')).toContain(SETTINGS_TEXT.rateOff);
    expect(describedBy('issued-settings-legal-name')).not.toContain(SETTINGS_TEXT.readOnly);
    await click('issued-settings-save'); // nothing filled in: every error, sent nowhere
    await settle();
    expect(tid('issued-settings-tax')).not.toHaveAttribute('aria-invalid');
    for (const id of ['tax-rate', 'tax-none']) {
      expect(tid(`issued-settings-${id}`)).toHaveAttribute('aria-invalid', 'true');
      expect(describedBy(`issued-settings-${id}`)).toContain(SETTINGS_RULE_TEXT.taxMode);
    }
    fill();
    expect(describedBy('issued-settings-rate')).not.toContain(SETTINGS_TEXT.rateOff);
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    for (const id of ['legal-name', 'postal-address', 'rate', 'tax-rate']) expect(describedBy(`issued-settings-${id}`)).toContain(SETTINGS_TEXT.locked);
  });

  it('SII-33. the sign-in keeps focus while it is out (its control says it is busy — never disabled), Refresh and Save wait for it, a failed one gives focus back to the password field; the control is amber-700 (contrast)', async () => {
    const server = seeded();
    server.staleLogins = true;
    const r = rig(server);
    let release: (token: string | null) => void = () => {};
    const identity: ShopIdentity = { ...r.props().identity!, reauthenticate: () => new Promise<string | null>((res) => { release = res; }) };
    render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    expect(tid('issued-settings-reauth-confirm').className).toContain('bg-amber-700');
    type('issued-settings-reauth-password', 'wrong');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(tid('issued-settings-reauth-confirm')).toHaveAttribute('aria-disabled', 'true'));
    expect(document.activeElement).toBe(tid('issued-settings-reauth-confirm'));
    expect(tid('issued-settings-reauth-confirm')).toHaveAccessibleDescription(SETTINGS_TEXT.confirmingSignIn);
    expect(tid('issued-settings-refresh')).toBeDisabled();
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    await act(async () => { release(null); });
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.reauthFailed));
    expect(document.activeElement).toBe(tid('issued-settings-reauth-password'));
    expect(tid('issued-settings-refresh')).not.toBeDisabled();
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-34. "Saved" needs the read-back to find THAT version with THOSE values: the same version with other values, a lower version and an unconfigured answer each say they do not match — never "Saved", never another PUT', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    const view = (over: Record<string, unknown>): Response => new Response(JSON.stringify({ issuingSettings: {
      storeId: STORE_1, version: 1, configured: true, legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: null,
      tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 }, ...over,
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const cases: Array<[Response, number]> = [
      [view({ legalName: 'Someone Else LLC' }), 1], // the same version, other values
      [view({ version: 1 }), 2], // a lower version than the one saved
      [new Response(JSON.stringify({ issuingSettings: { storeId: STORE_1, version: 0, configured: false } }), { status: 200, headers: { 'content-type': 'application/json' } }), 3],
    ];
    for (const [answer, version] of cases) {
      server.getStatus.push(answer);
      await click('issued-settings-save');
      await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.mismatch(version)));
      await settle();
      expect(status()).not.toHaveTextContent(/^Saved:/);
      expect(server.puts_()).toHaveLength(version);
    }
  });

  it('SII-35. "Issuing settings" cannot close the panel while a write is unresolved: the attempt, its key and body stay (the toggle says why), and Check again then sends the identical request', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.puts.push('lose');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('issued-settings-open');
    await settle();
    expect(tid('issued-settings-attempt')).toBeInTheDocument();
    expect(tid('issued-settings-open')).toHaveAttribute('aria-expanded', 'true');
    expect(tid('issued-settings-open')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-open')).toHaveAccessibleDescription(SETTINGS_TEXT.saveBlocked);
    expect(server.puts_()).toHaveLength(1);
    await click('issued-settings-check-again');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    const [first, second] = server.puts_();
    expect(second.body).toBe(first.body);
    expect(second.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'));
  });

  it('SII-36. Check again never extends the 23-hour window: with sends 12 hours apart it still ends 23 hours after the FIRST send', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.mono += 12 * HOUR;
    r.clock.wall += 12 * HOUR;
    server.puts.push(503);
    await click('issued-settings-check-again');
    await waitFor(() => expect(server.puts_()).toHaveLength(2));
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.mono += 11 * HOUR; // 23 hours from the first send, 11 from the last
    r.clock.wall += 11 * HOUR;
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-37. a live, unresolved write is never re-sent on its own: a window focus, a tab return and timers past 30 seconds and past 23 hours send no PUT', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    const current = server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.current).length;
    await focusEvents();
    expect(server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.current).length).toBeGreaterThan(current); // the session is checked, and live
    fakeClock();
    await advance(31_000);
    r.clock.mono += 23 * HOUR;
    r.clock.wall += 23 * HOUR;
    await advance(23 * HOUR);
    await focusEvents();
    expect(server.puts_()).toHaveLength(1);
    expect(attemptState()).toBe('unresolved');
  });

  it('SII-38. the panel\'s own read failures say what they are: a 404 that the settings are not available (no form, no retry), a 503 offers Try again — which only reads — and a 429 holds Try again until its wait has passed, reading nothing on its own', async () => {
    const server = seeded();
    server.retryAfter = '30';
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.getStatus.push(404);
    await click('issued-settings-open');
    await waitFor(() => expect(panelPhase()).toBe('not-found'));
    expect(tid('issued-settings-state')).toHaveTextContent(SETTINGS_TEXT.notFound);
    expect(tid('issued-settings-state')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('issued-settings-retry')).toBeNull();
    expect(screen.queryByTestId('issued-settings-legal-name')).toBeNull();
    await click('issued-settings-open'); // closed
    server.getStatus.push(503);
    await click('issued-settings-open');
    await waitFor(() => expect(panelPhase()).toBe('unavailable'));
    expect(tid('issued-settings-state')).toHaveTextContent(SETTINGS_TEXT.unavailable);
    const before = server.sent.length;
    await click('issued-settings-retry');
    await panelReady();
    expect(sentFrom(server, before)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${issuingSettingsPathOf(STORE_1)}`]);
    await click('issued-settings-open'); // closed
    fakeClock();
    server.getStatus.push(429);
    fireEvent.click(tid('issued-settings-open'));
    await until(() => expect(panelPhase()).toBe('rate-limited'));
    expect(tid('issued-settings-state')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-settings-retry')).toBeDisabled();
    const reads = server.reads().length;
    await advance(31_000);
    await until(() => expect(tid('issued-settings-retry')).not.toBeDisabled());
    await flush();
    expect(server.reads()).toHaveLength(reads);
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-39. the write side\'s waits and failures: a first Save answered 429 holds Save until the wait has passed (the timer sends nothing); "Load current version" that fails keeps the edits and sends nothing; a sign-in the store server did not confirm says so and keeps the sign-in group', async () => {
    const server = seeded();
    server.retryAfter = '30';
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    fakeClock();
    server.puts.push(429);
    fireEvent.click(tid('issued-settings-save'));
    await until(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.rateLimited(pickerWaitText(30))));
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.saveWaiting);
    fireEvent.click(tid('issued-settings-save'));
    await flush();
    expect(server.puts_()).toHaveLength(1);
    await advance(31_000);
    await until(() => expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.puts_()).toHaveLength(1); // the countdown gives Save back; it never saves
    vi.useRealTimers();
    server.bump(STORE_1, { legalName: 'Elsewhere LLC' });
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.conflict));
    server.getStatus.push(503);
    await click('issued-settings-load-current');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.loadFailed));
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC');
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true'); // still the conflict
    expect(server.puts_()).toHaveLength(2);
    cleanup();
    const stale = seeded();
    stale.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(stale).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    stale.loginStatus.push(503); // the renewal login: no answer that renews anything
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.reauthUnconfirmed));
    expect(tid('issued-settings-reauth-group')).toBeInTheDocument();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready');
    expect(stale.puts_()).toHaveLength(1);
  });

  it('SII-40. a sign-in that completes after the store changed, or after another tab\'s session took over, applies nothing and sends nothing: no renewal login, no settings read, no PUT', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    server.staleLogins = true;
    const r = rig(server);
    let release: () => void = () => {};
    const identity: ShopIdentity = { ...r.props().identity!, reauthenticate: (_uid, password) => new Promise<string | null>((res) => { release = () => res(password === 'correct horse' ? 'tok-a' : null); }) };
    render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } }); // 1. the store changes while it is out
    await settle();
    const mark = server.sent.length;
    await act(async () => { release(); });
    await settle();
    expect(sentFrom(server, mark)).toEqual([]);
    expect(screen.queryByText(SETTINGS_TEXT.renewed)).toBeNull();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    server.otherTab('uid-a'); // 2. another tab's session takes over while it is out
    await focusEvents();
    await storesReady();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    const mark2 = server.sent.length;
    await act(async () => { release(); });
    await settle();
    expect(sentFrom(server, mark2)).toEqual([]);
    expect(server.logins().filter((l) => l.headers.get('x-tmpos-reauthenticate') === '1')).toHaveLength(0);
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-41. while the sign-in is asked for, and while it is out, Save is held with its reason: no second PUT can leave beside the sign-in', async () => {
    const server = seeded();
    server.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.signInFirst);
    await click('issued-settings-save');
    await settle();
    expect(server.puts_()).toHaveLength(1);
    server.hold.current = 1; // the renewal's confirming session read
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('issued-settings-save');
    await settle();
    expect(server.puts_()).toHaveLength(1);
    server.held.shift()!.release();
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-42. a sign-in the store server refused ends the session at once (the settings cleared, only Reconnect signs in); one it rate-limited starts the section\'s wait, and the sign-in is held back until it passes', async () => {
    const server = seeded();
    server.staleLogins = true;
    server.retryAfter = '30';
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.loginStatus.push(429);
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.rateLimited(pickerWaitText(30))));
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.saveWaiting);
    // During the wait the sign-in is held back with its reason: a press (or Enter) sends no login.
    const logins = server.logins().length;
    type('issued-settings-reauth-password', 'correct horse');
    expect(tid('issued-settings-reauth-confirm')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-reauth-hint')).toHaveTextContent(SETTINGS_TEXT.signInWaiting);
    await click('issued-settings-reauth-confirm');
    fireEvent.keyDown(tid('issued-settings-reauth-password'), { key: 'Enter' });
    await settle();
    expect(server.logins()).toHaveLength(logins);
    cleanup();
    // A second section past the wait: the store server refuses the sign-in outright.
    server.retryAfter = null;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.loginStatus.push(401);
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(tid('issued-stores-state')).toHaveTextContent(ISSUED_TEXT.refused);
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(server.puts_()).toHaveLength(2); // one refused Save per section (step_up_required): no sign-in ever re-sent one
  });

  it('SII-43. a read-back refused 403 gets the reads\' one fresh check before anything is said: the same session says "saved, not read back"; another tab\'s token is a new generation — the panel goes and the save is still reported', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.getStatus.push(403);
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.unread(1)));
    await settle();
    expect(sentFrom(server, server.sent.indexOf(server.puts_()[0]) + 1)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${issuingSettingsPathOf(STORE_1)}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    type('issued-settings-store-name', 'Again');
    server.hold.settings = 1; // the read-back
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    server.held.shift()!.release(chain(403, 'forbidden'));
    await waitFor(() => expect(screen.queryByTestId('issued-settings')).toBeNull());
    expect(tid('issued-notice')).toHaveTextContent(SETTINGS_TEXT.savedEnded(2));
    await storesReady();
    expect(tid('issued-connection-changed')).toHaveTextContent(ISSUED_TEXT.connection);
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-44. an unresolved write that aged out (its body gone) still leaves the "could not be confirmed" note when a store change closes its panel', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.wall += 23 * HOUR;
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(tid('issued-detached')).toHaveTextContent(SETTINGS_TEXT.detached);
    expect(server.puts_()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Commit B: the issued list and one issued invoice (M7B-INVOICES-ISSUE-P2, AC-09, AC-10, AC-11, AC-08).

const listPhase = () => screen.queryByTestId('issued-list-state')?.getAttribute('data-phase') ?? 'none';
const listReady = () => waitFor(() => expect(listPhase()).toBe('ready'));
const rows = () => screen.queryAllByTestId('issued-row').map((li) => li.getAttribute('data-id'));
const customersShown = () => screen.queryAllByTestId('issued-row-customer').map((b) => b.textContent);
const openButton = (n: number) => screen.getByRole('button', { name: `Open invoice ${n}` });
const viewPhase = () => (screen.queryByTestId('issued-view-total') !== null ? 'ready' : screen.queryByTestId('issued-view-state')?.getAttribute('data-phase') ?? 'none');
const viewReady = (n: number) => waitFor(() => { expect(viewPhase()).toBe('ready'); expect(tid('issued-view-title')).toHaveTextContent(`Invoice ${n}`); });
const heading = () => screen.getByRole('heading', { name: 'Issued invoices' });
const listPath = (storeId: string, cursor?: string) => `${STORES_PATH}/${storeId}/invoices?limit=20${cursor === undefined ? '' : `&cursor=${cursor}`}`;
/** Words the issued surfaces never use: no payment state, and none of the actions this stage does not offer. */
const FORBIDDEN = /\b(paid|unpaid|due|balance|payment|deposit|receivable|void|print|send|receipt)\b/i;
/**
 * M7B-INVOICES-VOID-P2 supersession of FORBIDDEN (design §4 "Word scans", R19): voiding now exists, so the ONLY void
 * wording a surface may carry is the exact void control and texts the shop defines (VOID_TEXT, VOID_REFUSED_TEXT, the
 * confirmation's "Void invoice" and its numbered title, the card's heading). Those exact strings — and nothing else — are
 * taken out before FORBIDDEN scans, so every other word, and any other "void", still fails it. FORBIDDEN is unchanged.
 */
// Review B1 F7: ONLY the strings FORBIDDEN would catch (a standalone "void") are taken out; every other text stays scanned.
const VOID_SAID: readonly string[] = [
  ...Object.values(VOID_TEXT as Readonly<Record<string, unknown>>).filter((t): t is string => typeof t === 'string'), ...Object.values(VOID_REFUSED_TEXT), 'Void invoice',
].filter((t) => /\bvoid\b/i.test(t)).sort((a, b) => b.length - a.length);
const unvoided = (text: string | null): string =>
  VOID_SAID.reduce((t, said) => t.split(said).join(''), text ?? '').replace(/Void invoice \d+\?|Void of invoice \d+/g, '');
const MAX = Number.MAX_SAFE_INTEGER;
const MAX_TEXT = '$90,071,992,547,409.91';
const cells = () => screen.getAllByTestId('issued-view-line').map((tr) => [...(tr as HTMLTableRowElement).cells].map((td) => td.textContent));
/** The renewal of SII-11: a stale sign-in's Save, then the explicit sign-in (the section's renew) — its status says "press Save". */
async function renewBySignIn() {
  fill();
  await click('issued-settings-save');
  await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
  type('issued-settings-reauth-password', 'correct horse');
  await click('issued-settings-reauth-confirm');
  await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
}

describe('Issued invoices — the issued list (M7B-INVOICES-ISSUE-P2, AC-09)', () => {
  it('SII-45. choosing a store is what reads its issued list — ONE first page (limit 20), nothing before; each row says "Invoice {number}", the customer as recorded (isolated), the exact Total, the UTC issue time and "Issued", newest number first; no payment wording, no other control, no customer lookup and nothing written', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    issueAt(server, STORE_1, 3, (n) => ({ customerName: n === 2 ? 'שלום Customer' : `Customer ${n}` }));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await click('issued-show');
    await storesReady();
    await focusEvents();
    expect(server.lists()).toEqual([]);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await listReady();
    expect(server.lists()).toEqual([listPath(STORE_1)]);
    expect(screen.getAllByTestId('issued-row-number').map((p) => p.textContent)).toEqual(['Invoice 3', 'Invoice 2', 'Invoice 1']);
    const second = screen.getAllByTestId('issued-row')[1];
    const customer = within(second).getByTestId('issued-row-customer');
    expect(customer.tagName).toBe('BDI');
    expect(customer).toHaveTextContent('שלום Customer');
    expect(within(second).getByTestId('issued-row-total')).toHaveTextContent('Total $21.76'); // 1999 + 177 (8.875 %, rounded half up)
    const time = within(second).getByTestId('issued-row-issued');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', invoice(2).issuedAt);
    expect(time).toHaveTextContent('2026-10-16 21:00:02 UTC');
    expect(within(second).getByTestId('issued-row-status')).toHaveTextContent('Issued');
    expect(openButton(2)).toHaveAccessibleDescription(/שלום Customer · Total \$21\.76 · 2026-10-16 21:00:02 UTC · Issued/);
    expect(within(tid('issued-list')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open', 'Open', 'Open']);
    expect(tid('issued-section').textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByTestId('issued-load-more')).toBeNull();
    expect(server.sent.filter((r) => r.url.startsWith('/api/v1/customers'))).toEqual([]);
    expect(server.writes()).toEqual([]);
  });

  it('SII-46. "Load more" sends the cursor the server gave for THIS store and nothing else: 45 invoices come as 20, 20 and 5 in order, no row twice; it keeps focus while its read is out (aria-disabled, a press meanwhile sends nothing; a settings read out holds nothing of the list) and the last page hands focus to the first row it brought', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 45);
    const sorted = [...made].sort((a, b) => b.number - a.number);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(rows()).toHaveLength(20);
    // A settings read out is not the list's: Load more is not held, and nothing says the list is loading.
    server.hold.settings = 1;
    await click('issued-settings-open');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(tid('issued-load-more')).toHaveAttribute('aria-disabled', 'false');
    expect(tid('issued-load-more')).not.toHaveAttribute('aria-describedby');
    server.held.shift()!.release();
    await panelReady();
    const more = tid('issued-load-more');
    act(() => more.focus());
    server.hold.list = 1;
    fireEvent.click(more);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(more).toHaveAttribute('aria-disabled', 'true');
    expect(more).toHaveAccessibleDescription(LIST_TEXT.loading); // why it waits, said
    expect(document.activeElement).toBe(more);
    fireEvent.click(more); // nothing while its read is out
    await flush();
    expect(server.lists()).toHaveLength(2);
    server.held.shift()!.release();
    await waitFor(() => expect(rows()).toHaveLength(40));
    expect(document.activeElement).toBe(tid('issued-load-more'));
    expect(tid('issued-load-more')).not.toHaveAttribute('aria-describedby');
    fireEvent.click(tid('issued-load-more'));
    await waitFor(() => expect(rows()).toHaveLength(45));
    expect(screen.queryByTestId('issued-load-more')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById(`issued-open-${made[4].id}`))); // number 5: the last page's first row
    expect(rows()).toEqual(sorted.map((i) => i.id));
    expect(server.lists()).toEqual([listPath(STORE_1), listPath(STORE_1, cursorOf(sorted[19].id)), listPath(STORE_1, cursorOf(sorted[39].id))]);
  });

  it('SII-47. pages belong to their store and generation: a Load more page held across a store change never joins the new store\'s rows, a first page outrun by a store change shows nothing, the other store never gets this store\'s cursor, and coming back reads page one afresh', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 25);
    const sorted = [...made].sort((a, b) => b.number - a.number);
    server.issued.set(STORE_2, [1, 2].map((n) => invoice(n, { id: uuid(0x2a00 + n), customerName: `Second store ${n}` })));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    server.hold.list = 1;
    fireEvent.click(tid('issued-load-more'));
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await listReady();
    expect(customersShown()).toEqual(['Second store 2', 'Second store 1']);
    server.held.shift()!.release(); // store 1's page 2
    await settle();
    expect(customersShown()).toEqual(['Second store 2', 'Second store 1']);
    expect(screen.queryByTestId('issued-load-more')).toBeNull();
    server.hold.list = 1;
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(listPhase()).toBe('loading');
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await listReady();
    server.held.shift()!.release(); // store 1's outrun first page
    await settle();
    expect(customersShown()).toEqual(['Second store 2', 'Second store 1']);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await listReady();
    expect(rows()).toEqual(sorted.slice(0, 20).map((i) => i.id));
    expect(server.lists(STORE_2)).toEqual([listPath(STORE_2), listPath(STORE_2)]);
    expect(server.lists(STORE_1)).toEqual([listPath(STORE_1), listPath(STORE_1, cursorOf(sorted[19].id)), listPath(STORE_1), listPath(STORE_1)]);
  });

  it('SII-48. the list says what it has: no invoice yet; an outage with Try again (which reads page one, once per press); a failed Load more keeps the rows as last known; a 429 holds Try again with its reason until the wait has passed, and the timer reads nothing', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_2, 25);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(tid('issued-empty')).toHaveTextContent(LIST_TEXT.empty);
    expect(screen.queryByTestId('issued-list-retry')).toBeNull();
    server.listStatus.push(503);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await waitFor(() => expect(listPhase()).toBe('unavailable'));
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.unavailable);
    expect(screen.queryByTestId('issued-row')).toBeNull();
    await click('issued-list-retry');
    await listReady();
    expect(server.lists(STORE_2)).toEqual([listPath(STORE_2), listPath(STORE_2)]);
    server.listStatus.push(503);
    await click('issued-load-more');
    await waitFor(() => expect(listPhase()).toBe('unavailable'));
    expect(rows()).toHaveLength(20);
    expect(tid('issued-last-known')).toHaveTextContent(LIST_TEXT.lastKnown);
    fakeClock();
    server.listStatus.push(429);
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(listPhase()).toBe('rate-limited'));
    expect(tid('issued-list-state')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-list-retry')).toHaveAccessibleDescription(LIST_TEXT.waiting);
    const sent = server.lists().length;
    fireEvent.click(tid('issued-list-retry')); // held back: nothing is read
    await flush();
    await advance(31_000);
    await until(() => expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.lists()).toHaveLength(sent); // the countdown gives Try again back; it never reads
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(listPhase()).toBe('ready'));
    expect(server.lists()).toHaveLength(sent + 1);
  });

  it('SII-49. a role the server refuses the issued reads (no Customers View) gets ONE fresh session check, then "You cannot view issued invoices at this store." — no rows, no loop, no login; Try again is one read again', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 3);
    server.issuedDenied.add('uid-a');
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await waitFor(() => expect(listPhase()).toBe('denied'));
    const refused = server.sent.findIndex((r) => r.url.startsWith(`${STORES_PATH}/${STORE_1}/invoices?`));
    expect(sentFrom(server, refused + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.denied);
    expect(tid('issued-list-state')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('issued-row')).toBeNull();
    const logins = server.logins().length;
    await settle();
    expect(server.lists()).toHaveLength(1);
    await click('issued-list-retry');
    await waitFor(() => expect(server.lists()).toHaveLength(2));
    await waitFor(() => expect(listPhase()).toBe('denied'));
    await settle();
    const again = server.sent.map((r) => r.url).lastIndexOf(listPath(STORE_1));
    expect(sentFrom(server, again + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.logins()).toHaveLength(logins);
    expect(server.lists()).toHaveLength(2);
  });

  it('SII-50. a continuation the server no longer takes (400 on Load more) reloads ONCE from page one and says the list changed', async () => {
    const server = seeded();
    const sorted = issueAt(server, STORE_1, 25).sort((a, b) => b.number - a.number);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    server.listStatus.push(400);
    await click('issued-load-more');
    await waitFor(() => expect(tid('issued-list-note')).toHaveTextContent(LIST_TEXT.reloaded));
    await listReady();
    await settle();
    expect(server.lists()).toEqual([listPath(STORE_1), listPath(STORE_1, cursorOf(sorted[19].id)), listPath(STORE_1)]);
    expect(rows()).toEqual(sorted.slice(0, 20).map((i) => i.id));
  });
});

describe('Issued invoices — one issued invoice (M7B-INVOICES-ISSUE-P2, AC-09, AC-10)', () => {
  it('SII-51. Open reads the invoice ONCE and shows its version-1 snapshot as recorded: "Invoice 7", Close focused, Issued, the UTC time, the seller (each value isolated, the address on its own lines, the tax ID), the customer, the lines in order, Subtotal, "Tax (8.875%)" with its amount, Total and the snapshot note', async () => {
    const server = seeded();
    const seller = { legalName: 'Example Repairs LLC', storeName: 'Main Street Shop', postalAddress: '1 Main St\nSpringfield\nMA 01101', taxRegistrationId: 'TX-1' };
    const lines = [line(1, 'Screen repair', 1, 1999), line(2, 'Battery', 2, 4550), line(3, 'Labour', 3, 2500)];
    const made = issueAt(server, STORE_1, 7, (n) => (n === 7 ? { lines, seller, customerName: 'Ada Customer' } : {}));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(7));
    await viewReady(7);
    const dialog = screen.getByRole('dialog', { name: 'Invoice 7' });
    expect(document.activeElement).toBe(tid('issued-view-close'));
    expect(server.details()).toEqual([`${STORES_PATH}/${STORE_1}/invoices/${made[6].id}`]);
    expect(tid('issued-view-status')).toHaveTextContent('Issued');
    expect(tid('issued-view-issued-at').tagName).toBe('TIME');
    expect(tid('issued-view-issued-at')).toHaveAttribute('datetime', made[6].issuedAt);
    expect(tid('issued-view-issued-at')).toHaveTextContent('2026-10-16 21:00:07 UTC');
    expect(tid('issued-view-seller-legal')).toHaveTextContent('Example Repairs LLC');
    expect(tid('issued-view-seller-store')).toHaveTextContent('Main Street Shop');
    expect(tid('issued-view-seller-address').textContent).toBe('1 Main St\nSpringfield\nMA 01101');
    expect(tid('issued-view-seller-address')).toHaveClass('whitespace-pre-line');
    expect(tid('issued-view-seller-tax-id')).toHaveTextContent('Tax registration ID TX-1');
    expect(tid('issued-view-customer')).toHaveTextContent('Ada Customer');
    for (const id of ['issued-view-seller-legal', 'issued-view-seller-store', 'issued-view-seller-address', 'issued-view-seller-tax-id', 'issued-view-customer']) {
      expect(tid(id).querySelector('bdi'), id).not.toBeNull();
    }
    expect(cells()).toEqual([['1', 'Screen repair', '1', '$19.99', '$19.99'], ['2', 'Battery', '2', '$45.50', '$91.00'], ['3', 'Labour', '3', '$25.00', '$75.00']]);
    expect(within(dialog).getByRole('region', { name: 'Invoice lines' })).toHaveAttribute('tabindex', '0');
    // 18599 cents at 8.875 %: (18599 × 8875 + 50000) / 100000 = 1651 cents of tax.
    expect(tid('issued-view-subtotal')).toHaveTextContent('Subtotal $185.99');
    expect(tid('issued-view-tax')).toHaveTextContent('Tax (8.875%) $16.51');
    expect(tid('issued-view-total')).toHaveTextContent('Total $202.50');
    expect(tid('issued-view-note')).toHaveTextContent(VIEW_TEXT.note);
    // VOID-P2 supersession (was `['Close']`): an owner the server allows to void sees the one new control, "Void invoice…",
    // in the reserved row under the header — still no other control (no send, print, edit or delete) and no payment word.
    // The eligibility read answers beside the detail read: wait for it (review B1 F6).
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close', VOID_TEXT.open]);
    expect(dialog.textContent).toContain(VOID_TEXT.open);
    expect(unvoided(dialog.textContent)).not.toMatch(FORBIDDEN);
    expect(server.sent.filter((r) => r.url.startsWith('/api/v1/customers'))).toEqual([]);
    expect(server.writes()).toEqual([]);
  });

  it('SII-52. the tax line keeps its meanings apart: "No tax calculated" alone (no amount; Total = Subtotal), an explicit 0 % as "Tax (0%) $0.00" — never the same line — and a seller without a tax registration ID shows no such line', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2, (n) => (n === 1 ? { tax: { mode: 'none' }, seller: { ...SELLER, taxRegistrationId: null } } : { tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } }));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(1));
    await viewReady(1);
    expect(tid('issued-view-tax').textContent).toBe('No tax calculated');
    expect(tid('issued-view-subtotal')).toHaveTextContent('Subtotal $19.99');
    expect(tid('issued-view-total')).toHaveTextContent('Total $19.99');
    expect(screen.queryByTestId('issued-view-seller-tax-id')).toBeNull();
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await user().click(openButton(2));
    await viewReady(2);
    expect(tid('issued-view-tax').textContent).toBe('Tax (0%) $0.00');
    expect(tid('issued-view-total')).toHaveTextContent('Total $19.99');
    expect(tid('issued-view-seller-tax-id')).toHaveTextContent('Tax registration ID TX-1');
  });

  it('SII-53. money is exact across the safe range: 2^53-1 cents reads $90,071,992,547,409.91 in its row and in every amount of the dialog, each amount unbreakable; 0, 1 and 99 cents read $0.00, $0.01 and $0.99', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 4, (n) => ({ tax: { mode: 'none' }, lines: [line(1, `Line ${n}`, 1, [MAX, 0, 1, 99][n - 1])] }));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(screen.getAllByTestId('issued-row-total').map((s) => s.textContent)).toEqual(['Total $0.99', 'Total $0.01', 'Total $0.00', `Total ${MAX_TEXT}`]);
    await user().click(openButton(1));
    await viewReady(1);
    expect(cells()).toEqual([['1', 'Line 1', '1', MAX_TEXT, MAX_TEXT]]);
    expect(tid('issued-view-subtotal')).toHaveTextContent(`Subtotal ${MAX_TEXT}`);
    expect(tid('issued-view-total')).toHaveTextContent(`Total ${MAX_TEXT}`);
    for (const id of ['issued-view-subtotal', 'issued-view-total']) expect(within(tid(id)).getByText(MAX_TEXT)).toHaveClass('whitespace-nowrap');
    for (const td of screen.getAllByTestId('issued-view-line').flatMap((tr) => [...(tr as HTMLTableRowElement).cells].slice(2))) expect(td).toHaveClass('whitespace-nowrap');
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await user().click(openButton(3));
    await viewReady(3);
    expect(cells()).toEqual([['1', 'Line 3', '1', '$0.01', '$0.01']]);
  });

  it('SII-54. Escape and Close close the dialog and give focus back to the row\'s Open; Tab stays inside it (Close, "Void invoice…" where it is offered — VOID-P2 —, the lines region, Close); when that row is gone — the session ended while it was open — focus goes to the section heading, never the page body', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2);
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(1));
    await viewReady(1);
    // VOID-P2 supersession (was Close, the lines region, Close): an invoice the owner may void has "Void invoice…" in the
    // reserved row under the header, so the cycle is Close, Void invoice…, the lines region, Close — still contained.
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-void'));
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-lines-scroll'));
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-close'));
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(openButton(1)));
    await user().click(openButton(2));
    await viewReady(2);
    await click('issued-view-close');
    await waitFor(() => expect(document.activeElement).toBe(openButton(2)));
    await user().click(openButton(1));
    await viewReady(1);
    await act(async () => { await r.props().session!.logout(); });
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(screen.queryByTestId('issued-row')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
  });

  it('SII-55. a late answer changes nothing: an invoice answered after Close (Close cancels that GET; reopening reads afresh), one answered after a store change closed its dialog, and a first page answered after a sign-out (a 429 whose wait would hold the next choice: after Reconnect the store is read at once)', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2);
    server.issued.set(STORE_2, [invoice(1, { id: uuid(0x2a01), customerName: 'Second store 1' })]);
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    server.hold.detail = 1;
    await user().click(openButton(2));
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(tid('issued-view-state')).toHaveAttribute('data-phase', 'loading');
    expect(server.detailRequests()[0].signal?.aborted).toBe(false);
    await click('issued-view-close');
    expect(server.detailRequests()[0].signal?.aborted).toBe(true); // Close cancels the GET it had out
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-view')).toBeNull();
    await user().click(openButton(2));
    await viewReady(2);
    expect(server.details()).toHaveLength(2);
    await click('issued-view-close');
    server.hold.detail = 1;
    await user().click(openButton(1));
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } }); // the page behind is inert to a user; a change still reaches it
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await listReady();
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-view')).toBeNull();
    expect(customersShown()).toEqual(['Second store 1']);
    server.hold.list = 1;
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { await r.props().session!.logout(); });
    server.held.shift()!.release(chain(429, 'rate_limited', { 'retry-after': '30' }));
    await settle();
    expect(screen.queryByTestId('issued-row')).toBeNull();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    const before = server.lists(STORE_1).length;
    await click('issued-retry'); // Reconnect
    await storesReady();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await listReady(); // no wait: the late 429 started none
    expect(server.lists(STORE_1)).toHaveLength(before + 1);
    expect(rows()).toHaveLength(2);
    expect(tid('issued-list-state')).not.toHaveTextContent('Wait');
    expect(server.writes()).toEqual([]);
  });

  it('SII-56. the dialog says what the server answered: 404 "This invoice is not available."; a 403 after ONE fresh session check (no loop); a 503 offers Try again — one GET per press; a 429 holds Try again with its reason until the wait has passed (the timer reads nothing); a 401 ends the session — the dialog and the list go', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 1);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    const close = async () => { await click('issued-view-close'); await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull()); };
    server.detailStatus.push(404);
    await user().click(openButton(1));
    await waitFor(() => expect(viewPhase()).toBe('not-found'));
    expect(tid('issued-view-state')).toHaveTextContent(VIEW_TEXT.notFound);
    expect(screen.queryByTestId('issued-view-retry')).toBeNull();
    await close();
    server.detailStatus.push(403);
    const logins = server.logins().length;
    await user().click(openButton(1));
    await waitFor(() => expect(viewPhase()).toBe('denied'));
    expect(tid('issued-view-state')).toHaveTextContent(VIEW_TEXT.denied);
    const refused = server.sent.map((x) => x.url).lastIndexOf(server.details().slice(-1)[0]);
    // VOID-P2 supersession (was exactly the one session check): each open also sends its ONE void-eligibility GET beside
    // the detail read (design §4 "Trigger"); it is not part of the 403's check, which is still ONE fresh session check.
    expect(sentFrom(server, refused + 1).filter((line) => !line.endsWith('/void-eligibility'))).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.eligReads()).toEqual([1, 2].map(() => `${STORES_PATH}/${STORE_1}/invoices/${invoice(1).id}/void-eligibility`));
    expect(server.logins()).toHaveLength(logins);
    await close();
    server.detailStatus.push(503);
    await user().click(openButton(1));
    await waitFor(() => expect(viewPhase()).toBe('unavailable'));
    expect(tid('issued-view-state')).toHaveTextContent(VIEW_TEXT.unavailable);
    const before = server.details().length;
    await click('issued-view-retry');
    await viewReady(1);
    expect(server.details()).toHaveLength(before + 1);
    await close();
    fakeClock();
    server.detailStatus.push(429);
    fireEvent.click(openButton(1));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    expect(tid('issued-view-state')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-view-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-retry')).toHaveAccessibleDescription(VIEW_TEXT.waiting);
    const sent = server.details().length;
    fireEvent.click(tid('issued-view-retry'));
    await flush();
    await advance(31_000);
    await until(() => expect(tid('issued-view-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.details()).toHaveLength(sent);
    fireEvent.click(tid('issued-view-close'));
    await advance(10);
    vi.useRealTimers();
    server.detailStatus.push(401);
    await user().click(openButton(1));
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-view')).toBeNull();
    expect(screen.queryByTestId('issued-row')).toBeNull();
  });

  it('SII-57. nothing is read or written on its own: with the list and an invoice shown, a window focus, a tab return and timers past a minute send no list, invoice, settings or write request; under StrictMode a store choice is one first page and one Open is ONE GET at the fake (StrictMode\'s first mount cancels its read before it is sent; the one that arrives is never cancelled), and reopening reads once more', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    issueAt(server, STORE_1, 2);
    render(<StrictMode><ServerIssuedInvoices {...rig(server).props()} /></StrictMode>);
    await showAndChoose(STORE_1);
    await listReady();
    await settle();
    expect(server.lists()).toHaveLength(1);
    // StrictMode mounts the dialog, unmounts it and mounts it again: the first mount's read is cancelled by its cleanup
    // before it is sent, so the fake receives ONE GET — the second mount's, never cancelled — and nothing after it.
    server.hold.detail = 1;
    await user().click(openButton(1));
    await waitFor(() => expect(server.held).toHaveLength(1));
    await settle();
    expect(server.details()).toHaveLength(1);
    expect(server.detailRequests()[0].signal?.aborted).toBe(false);
    server.held.shift()!.release();
    await viewReady(1);
    await settle();
    expect(server.details()).toHaveLength(1);
    expect(server.detailRequests()[0].signal?.aborted).toBe(false);
    const quietCount = () => server.sent.filter((x) => !x.url.startsWith('/api/v1/session')).length;
    const before = quietCount();
    await focusEvents();
    fakeClock();
    await advance(65_000);
    vi.useRealTimers();
    await focusEvents();
    expect(quietCount()).toBe(before);
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await user().click(openButton(1));
    await viewReady(1);
    await settle();
    expect(server.details()).toHaveLength(2);
    expect(server.lists()).toHaveLength(1);
    expect(server.reads()).toHaveLength(0);
    expect(server.writes()).toEqual([]);
  });

  it('SII-58. an explicit sign-in (the settings\' step-up) renews the token, and the list read under the old one goes: its pages and cursor are cleared, the store stays chosen and the list says so with Try again — nothing is read on its own; Try again reads page one under the renewed token, and Load more then sends that page\'s cursor', async () => {
    const server = seeded();
    server.staleLogins = true;
    const sorted = issueAt(server, STORE_1, 25).sort((a, b) => b.number - a.number);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    await listReady();
    expect(rows()).toHaveLength(20);
    await renewBySignIn();
    expect(rows()).toEqual([]);
    expect(screen.queryByTestId('issued-load-more')).toBeNull();
    expect(listPhase()).toBe('unavailable');
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.renewed);
    expect(tid('issued-store')).toHaveValue(STORE_1);
    await settle();
    expect(server.lists()).toEqual([listPath(STORE_1)]); // nothing read on its own
    const old = server.sent.find((x) => x.url === listPath(STORE_1))!.headers.get('x-tmpos-session-csrf');
    const renewed = server.reads().at(-1)!.headers.get('x-tmpos-session-csrf'); // the settings' re-read after the sign-in
    expect(renewed).not.toBe(old);
    await click('issued-list-retry');
    await listReady();
    const firstPages = server.sent.filter((x) => x.url === listPath(STORE_1));
    expect(firstPages.map((x) => x.headers.get('x-tmpos-session-csrf'))).toEqual([old, renewed]);
    expect(rows()).toEqual(sorted.slice(0, 20).map((i) => i.id));
    await click('issued-load-more');
    await waitFor(() => expect(rows()).toHaveLength(25));
    expect(server.lists()).toEqual([listPath(STORE_1), listPath(STORE_1), listPath(STORE_1, cursorOf(sorted[19].id))]);
    expect(server.puts_()).toHaveLength(1); // the refused one only: nothing saved on its own
  });

  it('SII-59. a first page cancelled by that sign-in is never left "Loading": the list says it was cleared by the sign-in, with Try again; its late page changes nothing; Try again reads page one under the renewed session', async () => {
    const server = seeded();
    server.staleLogins = true;
    issueAt(server, STORE_1, 3);
    server.listStatus.push(503);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    await waitFor(() => expect(listPhase()).toBe('unavailable'));
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.hold.list = 1;
    await click('issued-list-retry');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(listPhase()).toBe('loading');
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    await waitFor(() => expect(listPhase()).toBe('unavailable'));
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.renewed);
    server.held.shift()!.release();
    await settle();
    expect(listPhase()).toBe('unavailable');
    expect(screen.queryByTestId('issued-row')).toBeNull();
    await click('issued-list-retry');
    await listReady();
    expect(rows()).toHaveLength(3);
    expect(server.lists()).toHaveLength(3);
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-60. AC-11: listing and opening invoices use no browser storage, history, address or log; no token in the DOM; the section and the dialog never name a payment state or offer send, print, edit or delete, and say "void" only in the exact void control (VOID-P2 supersession)', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const server = seeded();
    issueAt(server, STORE_1, 25, (n) => (n % 2 === 0 ? { tax: { mode: 'none' } } : {}));
    const href = window.location.href;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await click('issued-load-more');
    await waitFor(() => expect(rows()).toHaveLength(25));
    for (const n of [2, 3]) {
      await user().click(openButton(n));
      await viewReady(n);
      const dialog = tid('issued-view');
      // VOID-P2 supersession (was FORBIDDEN on the whole text and `['Close']`): the exact void control is the only void
      // wording and the only new control; every other word and control stays out.
      await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
      expect(unvoided(dialog.textContent)).not.toMatch(FORBIDDEN);
      expect(within(dialog).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Close', VOID_TEXT.open]);
      await click('issued-view-close');
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    }
    expect(tid('issued-section').textContent).not.toMatch(FORBIDDEN);
    expect(within(tid('issued-section')).getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Open')).toEqual(['Issuing settings']);
    expect(setItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(document.body.innerHTML).not.toContain('s'.repeat(40));
    expect(document.body.innerHTML).not.toContain(cursorOf(invoice(6).id));
  });
});

describe('Issued invoices — review fixes: continuations, late answers, refusals, focus and waits (M7B-INVOICES-ISSUE-P2, AC-08, AC-09, AC-10)', () => {
  it('SII-61. a continuation that does not continue the rows shown is refused whole — an invoice already shown (under another number), a source draft already shown, an invoice or a source draft twice in the page itself, or a number not below the last one shown: nothing joins, its cursor is not taken, nothing more is read on its own, and the list is unavailable with the rows as last known (Try again reads page one)', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 25); // page one: 25..6
    // A page repeating itself never passes the issuing client's own one-page check: those pages are handed to the section
    // as the client's answer (after the real request), to show the section refuses them too.
    const real = createInvoiceIssuingClient({ fetch: server.fetch });
    let handed: IssuedSummary[] | null = null;
    const issuing = { ...real, listIssued: async (...args: Parameters<typeof real.listIssued>) => {
      const answer = await real.listIssued(...args);
      const invoices = handed;
      handed = null;
      return invoices === null ? answer : { kind: 'ok' as const, invoices, nextCursor: null };
    } };
    render(<ServerIssuedInvoices {...rig(server).props({ issuing })} />);
    await showAndChoose(STORE_1);
    await listReady();
    const shown = rows();
    const [five, four, ...rest] = [5, 4, 3, 2, 1].map((n) => summaryOf(made[n - 1]));
    const page = (invoices: Array<ReturnType<typeof summaryOf>>): Response =>
      new Response(JSON.stringify({ invoices, nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    const malformed = [
      { invoices: [{ ...summaryOf(made[24]), number: 5, sourceDraftId: uuid(0xdeee) }, four, ...rest] }, // invoice 25's id again, under number 5
      { invoices: [{ ...five, sourceDraftId: made[24].sourceDraftId }, four, ...rest] }, // invoice 25's source draft again
      { invoices: [{ ...five, number: 6 }, four, ...rest] }, // not below 6, the last number shown
      { invoices: [five, { ...four, id: five.id, sourceDraftId: uuid(0xdeef) }, ...rest], within: true }, // invoice 5's id twice in the page
      { invoices: [five, { ...four, sourceDraftId: five.sourceDraftId }, ...rest], within: true }, // invoice 5's source draft twice in the page
    ];
    for (const { invoices, within } of malformed) {
      const sent = server.lists().length;
      if (within === true) handed = invoices as unknown as IssuedSummary[];
      else server.listStatus.push(page(invoices));
      await click('issued-load-more');
      await waitFor(() => expect(listPhase()).toBe('unavailable'));
      await settle();
      expect(rows()).toEqual(shown);
      expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.unavailable);
      expect(tid('issued-last-known')).toHaveTextContent(LIST_TEXT.lastKnown);
      expect(screen.queryByTestId('issued-load-more')).toBeNull();
      expect(server.lists()).toHaveLength(sent + 1);
      await click('issued-list-retry');
      await listReady();
      expect(server.lists().at(-1)).toBe(listPath(STORE_1));
      expect(rows()).toEqual(shown);
    }
  });

  it('SII-62. a closed dialog\'s read answers nothing, even once the same invoice is open again: its late 401 ends no session and its late 429 starts no wait', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 25);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    for (const late of [chain(401, 'unauthenticated'), chain(429, 'rate_limited', { 'retry-after': '30' })]) {
      server.hold.detail = 1;
      await user().click(openButton(25));
      await waitFor(() => expect(server.held).toHaveLength(1));
      await click('issued-view-close');
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
      await user().click(openButton(25)); // the same invoice again: its own read answers
      await viewReady(25);
      server.held.shift()!.release(late);
      await settle();
      expect(viewPhase()).toBe('ready');
      expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready');
      expect(rows()).toHaveLength(20);
      expect(tid('issued-load-more')).toHaveAttribute('aria-disabled', 'false');
      expect(tid('issued-load-more')).not.toHaveAttribute('aria-describedby');
      await click('issued-view-close');
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    }
    expect(server.logins()).toHaveLength(1);
  });

  it('SII-63. a 403 on the list takes every row and the cursor away at once — before its one fresh check has answered, and whatever that check then says: an outage says unavailable, a 429 the wait — with no row of this store left on screen and no Load more', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 25);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    for (const check of [503, 429]) {
      server.hold.list = 1;
      fireEvent.click(tid('issued-load-more'));
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.hold.current = 1; // the one fresh session check after the 403, held
      server.held.shift()!.release(chain(403, 'forbidden'));
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
      // Gone already, while that check has not answered.
      expect(rows()).toEqual([]);
      expect(screen.queryByTestId('issued-last-known')).toBeNull();
      expect(screen.queryByTestId('issued-load-more')).toBeNull();
      server.held.shift()!.release(check === 503 ? chain(503, 'service_unavailable') : chain(429, 'rate_limited', { 'retry-after': '30' }));
      await waitFor(() => expect(listPhase()).toBe(check === 503 ? 'unavailable' : 'rate-limited'));
      await settle();
      expect(rows()).toEqual([]);
      expect(screen.queryByTestId('issued-last-known')).toBeNull();
      expect(screen.queryByTestId('issued-load-more')).toBeNull();
      expect(tid('issued-list-state')).toHaveTextContent(check === 503 ? LIST_TEXT.unavailable : 'Wait 30 seconds');
      if (check === 503) {
        await click('issued-list-retry');
        await listReady();
        expect(rows()).toHaveLength(20);
      }
    }
  });

  it('SII-64. a Load more that fails hands its focus to the list\'s Try again — where the user tries again, not the section heading or the page body: an outage, then a 429', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 25);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    for (const status of [503, 429]) {
      const more = tid('issued-load-more');
      act(() => more.focus());
      server.listStatus.push(status);
      fireEvent.click(more);
      await waitFor(() => expect(listPhase()).toBe(status === 503 ? 'unavailable' : 'rate-limited'));
      await waitFor(() => expect(document.activeElement).toBe(tid('issued-list-retry')));
      expect(rows()).toHaveLength(20);
      if (status === 503) {
        await click('issued-list-retry');
        await listReady();
      }
    }
  });

  it('SII-65. under StrictMode (effects set up, cleaned up and set up again) Escape and Close still give focus back to the row\'s Open, not the section heading', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2);
    render(<StrictMode><ServerIssuedInvoices {...rig(server).props()} /></StrictMode>);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(1));
    await viewReady(1);
    expect(document.activeElement).toBe(tid('issued-view-close'));
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(openButton(1)));
    await user().click(openButton(2));
    await viewReady(2);
    await click('issued-view-close');
    await waitFor(() => expect(document.activeElement).toBe(openButton(2)));
  });

  it('SII-66. the status regions exist before their first text: the list\'s from the moment a store can be chosen (empty, a status), so choosing one changes its text to "Loading…" in place; the dialog\'s is in the dialog before "Loading this invoice…" is written into it', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await click('issued-show');
    await storesReady();
    const region = tid('issued-list-state');
    expect(region).toHaveAttribute('role', 'status');
    expect(region.textContent).toBe('');
    expect(region).not.toHaveAttribute('data-phase');
    server.hold.list = 1;
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(tid('issued-list-state')).toBe(region);
    expect(region).toHaveTextContent(LIST_TEXT.loading);
    server.held.shift()!.release();
    await listReady();
    expect(tid('issued-list-state')).toBe(region);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => { records.push(...list); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    server.hold.detail = 1;
    await user().click(openButton(1));
    await waitFor(() => expect(server.held).toHaveLength(1));
    const said = tid('issued-view-state');
    expect(said).toHaveTextContent(VIEW_TEXT.loading);
    await flush();
    observer.disconnect();
    // A record whose target is the region (or its text) means the text came after the region: it was not inserted with it.
    expect(records.some((r) => r.target === said || r.target.parentNode === said)).toBe(true);
    server.held.shift()!.release();
    await viewReady(1);
  });

  it('SII-67. the 429 wait is the whole section\'s: a list\'s 429 holds an Open (its dialog waits, no GET) and its Try again until the wait has passed; a dialog\'s 429 holds Load more (its reason said; a press reads nothing), another Open (no GET) and a store change (the wait said, Try again held, no list read); the timer reads nothing, and only a press reads again', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 25);
    server.issued.set(STORE_2, [invoice(1, { id: uuid(0x2a01), customerName: 'Second store 1' })]);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    fakeClock();
    // A list's 429: the dialog of an Open waits with it.
    server.listStatus.push(429);
    fireEvent.click(tid('issued-load-more'));
    await until(() => expect(listPhase()).toBe('rate-limited'));
    fireEvent.click(openButton(25));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    expect(server.details()).toEqual([]);
    expect(tid('issued-view-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-retry')).toHaveAccessibleDescription(VIEW_TEXT.waiting);
    fireEvent.click(tid('issued-view-retry'));
    await flush();
    await advance(31_000);
    await until(() => expect(tid('issued-view-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.details()).toEqual([]); // the timer reads nothing
    fireEvent.click(tid('issued-view-retry'));
    await until(() => expect(viewPhase()).toBe('ready'));
    expect(server.details()).toHaveLength(1);
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(listPhase()).toBe('ready'));
    // A dialog's 429: Load more, another Open and a store change wait with it.
    server.detailStatus.push(429);
    fireEvent.click(openButton(25));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    const lists = server.lists().length;
    const details = server.details().length;
    expect(tid('issued-load-more')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-load-more')).toHaveAccessibleDescription(LIST_TEXT.waiting);
    fireEvent.click(tid('issued-load-more'));
    await flush();
    fireEvent.click(openButton(24));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    expect(tid('issued-view-state')).toHaveTextContent('Wait 30 seconds');
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await until(() => expect(listPhase()).toBe('rate-limited'));
    expect(tid('issued-list-state')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-list-retry')).toHaveAccessibleDescription(LIST_TEXT.waiting);
    await flush();
    expect(server.lists()).toHaveLength(lists);
    expect(server.details()).toHaveLength(details);
    await advance(31_000);
    await until(() => expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.lists()).toHaveLength(lists); // the countdown gives Try again back; it never reads
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(listPhase()).toBe('ready'));
    expect(server.lists(STORE_2)).toEqual([listPath(STORE_2)]);
    expect(customersShown()).toEqual(['Second store 1']);
  });

  it('SII-68. an invoice still open when an explicit sign-in renews the token closes together with the list read under the old token; focus is not left on the page body, and nothing is saved on its own', async () => {
    const server = seeded();
    server.staleLogins = true;
    issueAt(server, STORE_1, 3);
    const r = rig(server);
    const base = r.props().identity!;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const identity: ShopIdentity = { ...base, reauthenticate: async (uid, password) => { await gate; return base.reauthenticate(uid, password); } };
    render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await openSettings();
    await listReady();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm'); // the sign-in is out
    await user().click(openButton(3));
    await viewReady(3);
    await act(async () => { release(); });
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(rows()).toEqual([]);
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.renewed);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(server.puts_()).toHaveLength(1);
  });

  // M7B-INVOICES-VOID-P1 — the lifecycle on the existing reads: a voided invoice keeps its number, customer, Total and issue
  // time, labelled "Voided" where "Issued" stood; its detail adds the void time (UTC, the issue time's form) and the reason's
  // label beside the unchanged snapshot. Nothing offers a void, and an issued invoice reads exactly as before.
  const VOIDED = Object.freeze({ voidedAt: '2026-10-17T08:30:05.000001Z', reasonCode: 'wrong_lines_or_amounts' });

  it('SII-69. a voided invoice stays in the list in its number\'s place, with its customer, Total and issue time — read "Issued <time>", the word outside the <time>, so the one time on the row is never taken for the void\'s — labelled "Voided" where an issued one says "Issued" (in its Open\'s description too); an issued row reads exactly as before; the P1 word scan and button set hold for it', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 3, (n) => (n === 2 ? { void: { ...VOIDED } } : {}));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(screen.getAllByTestId('issued-row-number').map((p) => p.textContent)).toEqual(['Invoice 3', 'Invoice 2', 'Invoice 1']);
    expect(screen.getAllByTestId('issued-row-status').map((p) => p.textContent)).toEqual(['Issued', 'Voided', 'Issued']);
    expect(openButton(2)).toHaveAccessibleDescription('Ada Customer · Total $21.76 · Issued 2026-10-16 21:00:02 UTC · Voided');
    expect(openButton(3)).toHaveAccessibleDescription('Ada Customer · Total $21.76 · 2026-10-16 21:00:03 UTC · Issued');
    const [three, two, one] = screen.getAllByTestId('issued-row-issued');
    expect([three, two, one].map((t) => t.textContent)).toEqual(['2026-10-16 21:00:03 UTC', '2026-10-16 21:00:02 UTC', '2026-10-16 21:00:01 UTC']);
    expect(two.previousSibling?.textContent).toBe('Issued '); // the prefix is text beside the <time>, never inside it
    for (const issued of [three, one]) expect(issued.previousSibling?.textContent).toBe(' · '); // an issued row: no prefix, as before
    expect(within(tid('issued-list')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open', 'Open', 'Open']);
    expect(tid('issued-section').textContent).not.toMatch(FORBIDDEN);
    expect(within(tid('issued-section')).getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Open')).toEqual(['Issuing settings']);
    expect(server.writes()).toEqual([]);
  });

  it('SII-70. a voided invoice\'s detail says "Voided", the void time in UTC and "Reason" with its label, beside the unchanged snapshot (its "Issued at", seller, customer, lines and Total); an issued one shows no void line, and nothing but reads is sent', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 2, (n) => (n === 2 ? { void: { ...VOIDED } } : {}));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(2));
    await viewReady(2);
    const dialog = screen.getByRole('dialog', { name: 'Invoice 2' });
    expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/);
    expect(tid('issued-view-issued-at')).toHaveTextContent('2026-10-16 21:00:02 UTC');
    const voidedAt = tid('issued-view-voided-at');
    expect(voidedAt.tagName).toBe('TIME');
    expect(voidedAt).toHaveAttribute('datetime', VOIDED.voidedAt);
    expect(voidedAt).toHaveTextContent(/^2026-10-17 08:30:05 UTC$/);
    expect(tid('issued-view-void-reason')).toHaveTextContent(/^Wrong lines or amounts$/);
    expect([...dialog.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Status', 'Issued at', 'Voided at', 'Reason']);
    expect(tid('issued-view-customer')).toHaveTextContent('Ada Customer');
    expect(tid('issued-view-total')).toHaveTextContent('Total $21.76');
    expect(tid('issued-view-note')).toHaveTextContent(VIEW_TEXT.note);
    expect(within(dialog).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    expect(dialog.textContent).not.toMatch(FORBIDDEN);
    expect(tid('issued-section').textContent).not.toMatch(FORBIDDEN);
    expect(within(tid('issued-section')).getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Open')).toEqual(['Issuing settings']);
    await user().click(tid('issued-view-close'));
    await user().click(openButton(1));
    await viewReady(1);
    expect(tid('issued-view-status')).toHaveTextContent(/^Issued$/);
    expect(screen.queryByTestId('issued-view-voided-at')).toBeNull();
    expect(screen.queryByTestId('issued-view-void-reason')).toBeNull();
    expect([...screen.getByRole('dialog', { name: 'Invoice 1' }).querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Status', 'Issued at']);
    expect(server.details()).toEqual([`${STORES_PATH}/${STORE_1}/invoices/${made[1].id}`, `${STORES_PATH}/${STORE_1}/invoices/${made[0].id}`]);
    expect(server.writes()).toEqual([]);
  });

  it('SII-71. a lifecycle the shop cannot name is never shown as issued: a voided row or detail whose void is malformed (an unknown reason, a void before the issue) leaves the list, or the dialog, unavailable', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2, (n) => (n === 2 ? { void: { voidedAt: '2026-10-16T21:00:01.000000Z', reasonCode: 'wrong_customer' } } : {}));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady(); // the rows carry no void member: the list cannot see the bad time
    expect(screen.getAllByTestId('issued-row-status').map((p) => p.textContent)).toEqual(['Voided', 'Issued']);
    await user().click(openButton(2));
    await waitFor(() => expect(viewPhase()).toBe('unavailable'));
    expect(screen.queryByTestId('issued-view-status')).toBeNull();
    await user().click(tid('issued-view-close'));
    server.issued.get(STORE_1)![1] = { ...server.issued.get(STORE_1)![1], void: { voidedAt: VOIDED.voidedAt, reasonCode: 'refunded' } };
    await user().click(openButton(2));
    await waitFor(() => expect(viewPhase()).toBe('unavailable'));
    expect(screen.queryByTestId('issued-view-status')).toBeNull();
    expect(server.writes()).toEqual([]);
  });
});

// M7B-INVOICES-VOID-P2 checkpoint A — the held void attempt below any UI (src/tenant/invoiceVoidHold.ts; design §3 and
// R4–R8): one live attempt per user in its own store; every answer settled BY KEY, a first send's and a Check again's
// apart; a late answer for a detached or replaced attempt changes nothing but the detach; detached is for good; the
// 23-hour cutoff counted from the FIRST send by the larger of the monotonic and wall-clock time, and its scrub timer
// clearing only the bytes. The clocks are injected and moved by hand; only the scrub timer runs on the fake clock.
describe('Issued invoices — the held void attempt, below any UI (M7B-INVOICES-VOID-P2 checkpoint A)', () => {
  const T0 = Object.freeze({ mono: 1_000, wall: Date.UTC(2026, 9, 18, 12) });
  const CSRF = `${'s'.repeat(40)}001`;
  const BODY = `{"expectedTenant":"${TENANT_A}","reasonCode":"duplicate"}`;
  const voidKey = (n: number) => ['5e1f0000', '1d2f', '4a6b', '9c8d', String(n).padStart(12, '0')].join('-');
  const held = (n: number, over: Partial<HeldVoid> = {}): HeldVoid => ({
    key: voidKey(n), body: BODY, storeId: STORE_1, storeLabel: 'Main Street', invoiceId: uuid(0x1a00 + n), number: n, csrf: CSRF,
    sentAt: T0.mono, sentWall: T0.wall, state: 'sending', note: '', refusal: null, seen: null, seenReason: null, retryable: true, ...over,
  });
  const voidRig = () => {
    const clock = { ...T0 };
    return { clock, holds: createVoidHoldStore({ now: () => clock.mono, wallNow: () => clock.wall }) };
  };
  /** What the request went with: the attempt's own token and the sign-out count read before it. */
  const sent = () => ({ csrf: CSRF, since: sessionEndsSoFar() });
  const refusedAs = (refusal: VoidRefusal): Partial<HeldVoid> => ({ state: 'refused', refusal, body: '', note: '' });
  const holdSource = () => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'invoiceVoidHold.ts'), 'utf8');
  /** The hold module cannot send anything: it takes the issuing client's types only, and names no network API. */
  const sendsNothing = () => {
    const source = holdSource();
    const fromClient = (source.match(/^import [^;]*;$/gm) ?? []).filter((line) => line.includes("from './invoiceIssuingClient'"));
    expect(fromClient.length).toBeGreaterThan(0);
    for (const line of fromClient) expect(line).toMatch(/^import type \{/);
    expect(source).not.toMatch(/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\(/);
  };

  it('SII-72. VOID-P2 hold: one live void attempt per user in its own store — a second is refused while one is sending, unresolved or checking, a settled one is replaced, another user\'s is apart; it keeps only the key, the bytes, its store and invoice, the token and the first send\'s times; a stale key changes and removes nothing; removing it only stops tracking it', () => {
    fakeClock();
    const { holds } = voidRig();
    expect(holds.put('uid-a', held(1))).toBe(true);
    expect(Object.keys(holds.get('uid-a')!).sort()).toEqual(['body', 'csrf', 'invoiceId', 'key', 'note', 'number', 'refusal', 'retryable', 'seen', 'seenReason', 'sentAt', 'sentWall', 'state', 'storeId', 'storeLabel']);
    expect(Object.isFrozen(holds.get('uid-a'))).toBe(true);
    for (const state of ['sending', 'unresolved', 'checking'] as const) {
      expect(holds.change('uid-a', voidKey(1), { state })).toBe(true);
      expect(isLiveVoid(holds.get('uid-a'))).toBe(true);
      expect(holds.put('uid-a', held(2))).toBe(false); // never silently replaced while it may still void
      expect(holds.get('uid-a')!.key).toBe(voidKey(1));
    }
    expect(holds.put('uid-b', held(3))).toBe(true);
    expect(holds.change('uid-a', voidKey(3), { state: 'voided' })).toBe(false); // another attempt's key
    expect(holds.remove('uid-a', voidKey(3))).toBe(false);
    expect(holds.get('uid-a')!.state).toBe('checking');
    for (const [state, next] of [['voided', 4], ['refused', 5]] as const) {
      holds.change('uid-a', holds.get('uid-a')!.key, { state, body: '' });
      expect(isLiveVoid(holds.get('uid-a'))).toBe(false);
      expect(holds.put('uid-a', held(next))).toBe(true);
      expect(holds.get('uid-a')!.key).toBe(voidKey(next));
    }
    expect(holds.remove('uid-a', voidKey(5))).toBe(true);
    expect(holds.get('uid-a')).toBeUndefined();
    expect(holds.get('uid-b')).toEqual(held(3));
    expect(isLiveVoid(undefined)).toBe(false);
  });

  it('SII-73. VOID-P2 hold: a FIRST send\'s answer settles its attempt by key — the exact 200 voided with its bytes gone; a sealed or rolled-back refusal refused with its kind; unknown and in-progress unresolved with a note, key and bytes kept; a refusal decided before the key (401, 429, step-up, 403) removes it while its confirmation is still open and settles it refused once that confirmation is gone; one never sent leaves nothing held', () => {
    fakeClock();
    const unresolved = (note: string): Partial<HeldVoid> => ({ state: 'unresolved', note });
    const rows: Array<[VoidResult, Partial<HeldVoid> | 'removed', Partial<HeldVoid> | 'removed']> = [
      [{ kind: 'voided', replayed: false }, { state: 'voided', body: '' }, { state: 'voided', body: '' }],
      [{ kind: 'voided', replayed: true }, { state: 'voided', body: '' }, { state: 'voided', body: '' }],
      ...(['already-void', 'version-conflict', 'tenant-conflict', 'not-found', 'key-reused', 'invalid'] as const)
        .map((kind): [VoidResult, Partial<HeldVoid>, Partial<HeldVoid>] => [{ kind }, refusedAs(kind), refusedAs(kind)]),
      [{ kind: 'unknown', responded: true }, unresolved(VOID_NOTE_TEXT.answered), unresolved(VOID_NOTE_TEXT.answered)],
      [{ kind: 'unknown', responded: false }, unresolved(VOID_NOTE_TEXT.noAnswer), unresolved(VOID_NOTE_TEXT.noAnswer)],
      [{ kind: 'in-progress' }, unresolved(VOID_NOTE_TEXT.inProgress), unresolved(VOID_NOTE_TEXT.inProgress)],
      [{ kind: 'rate-limited', retryAfterSeconds: 30 }, 'removed', refusedAs('rate-limited')],
      ...(['signed-out', 'step-up', 'denied'] as const).map((kind): [VoidResult, 'removed', Partial<HeldVoid>] => [{ kind }, 'removed', refusedAs(kind)]),
      [{ kind: 'not-sent' }, 'removed', 'removed'], // never sent (the section validates before put): there is nothing to track
    ];
    for (const [answer, whenOpen, whenClosed] of rows) {
      for (const [open, expected] of [[true, whenOpen], [false, whenClosed]] as const) {
        const { holds } = voidRig();
        holds.put('uid-a', held(1));
        settleVoid(holds, 'uid-a', voidKey(1), answer, true, sent(), open);
        if (expected === 'removed') expect(holds.get('uid-a'), `${answer.kind}, open ${open}`).toBeUndefined();
        else expect(holds.get('uid-a'), `${answer.kind}, open ${open}`).toEqual({ ...held(1), ...expected });
      }
    }
    // A caller that cannot say whether its confirmation is open keeps the refusal visible: it settles, never vanishes.
    const { holds } = voidRig();
    holds.put('uid-a', held(1));
    settleVoid(holds, 'uid-a', voidKey(1), { kind: 'step-up' }, true, sent());
    expect(holds.get('uid-a')).toEqual({ ...held(1), ...refusedAs('step-up') });
  });

  it('SII-74. VOID-P2 hold: a Check again is decided ONLY by its key\'s sealed answers (voided, already void, the version); a step-up, a 422, a 403, a 401, a 429, a 404, another tenant, no answer — anything unsealed, decided before or apart from the key — leaves it unresolved with a note about that CHECK alone, the same key, bytes and first-send times, an open confirmation or not; a step-up or a 422 also withdraws Check again', () => {
    fakeClock();
    const decided: Array<[VoidResult, Partial<HeldVoid>]> = [
      [{ kind: 'voided', replayed: true }, { state: 'voided', body: '', note: '' }],
      [{ kind: 'already-void' }, refusedAs('already-void')],
      [{ kind: 'version-conflict' }, refusedAs('version-conflict')],
    ];
    const unresolved: Array<[VoidResult, string]> = [
      [{ kind: 'step-up' }, VOID_NOTE_TEXT.stepUp],
      [{ kind: 'key-reused' }, VOID_NOTE_TEXT.keyReused], // unsealed: an integrity failure, never the outcome (D-VOID-5)
      [{ kind: 'denied' }, VOID_NOTE_TEXT.denied],
      [{ kind: 'signed-out' }, VOID_NOTE_TEXT.signedOut],
      [{ kind: 'rate-limited', retryAfterSeconds: 9 }, 'Too many requests. Wait 9 seconds.'],
      [{ kind: 'rate-limited', retryAfterSeconds: 1 }, 'Too many requests. Wait 1 second.'],
      [{ kind: 'not-found' }, VOID_NOTE_TEXT.notAccepted],
      [{ kind: 'tenant-conflict' }, VOID_NOTE_TEXT.notAccepted],
      [{ kind: 'invalid' }, VOID_NOTE_TEXT.notAccepted],
      [{ kind: 'not-sent' }, VOID_NOTE_TEXT.notSent], // refused here: the server heard nothing
      [{ kind: 'in-progress' }, VOID_NOTE_TEXT.inProgress],
      [{ kind: 'unknown', responded: true }, VOID_NOTE_TEXT.answered],
      [{ kind: 'unknown', responded: false }, VOID_NOTE_TEXT.noAnswer],
    ];
    expect(VOID_NOTE_TEXT.stepUp).toBe("Your sign-in is too old to check this request again here. Signing in again starts a new session that cannot send it. Use Check invoice to see the invoice's current state.");
    const checking = held(1, { state: 'checking', note: VOID_NOTE_TEXT.noAnswer, seen: 'issued' });
    const withdrawn = (a: VoidResult) => a.kind === 'step-up' || a.kind === 'key-reused';
    for (const [answer, expected] of [...decided, ...unresolved.map(([a, note]): [VoidResult, Partial<HeldVoid>] => [a, { state: 'unresolved', note, retryable: !withdrawn(a) }])]) {
      for (const open of [true, false]) {
        const { holds } = voidRig();
        holds.put('uid-a', checking);
        settleVoid(holds, 'uid-a', voidKey(1), answer, false, sent(), open);
        expect(holds.get('uid-a'), `${answer.kind}, open ${open}`).toEqual({ ...checking, ...expected }); // seen, key, times untouched
      }
    }
    for (const note of Object.values(VOID_NOTE_TEXT).map((t) => (typeof t === 'string' ? t : t(2)))) expect(note).not.toMatch(/\b(not voided|cancel|rolled back|failed)\b/i);
  });

  it('SII-75. VOID-P2 hold: a late answer never settles or removes an attempt it no longer speaks for — sent with another token, sent before a sign-out began, or already detached, the attempt is DETACHED (state kept) and nothing else changes; an answer for a replaced key changes nothing at all', () => {
    fakeClock();
    const answers: VoidResult[] = [{ kind: 'voided', replayed: false }, { kind: 'already-void' }, { kind: 'step-up' }, { kind: 'rate-limited', retryAfterSeconds: 5 }, { kind: 'unknown', responded: false }];
    for (const answer of answers) {
      for (const first of [true, false]) {
        const start = held(1, { state: first ? 'sending' : 'checking' });
        const detached = { ...start, csrf: null, body: '' };
        const other = voidRig(); // the request went with another session's token
        other.holds.put('uid-a', start);
        settleVoid(other.holds, 'uid-a', voidKey(1), answer, first, { csrf: `${'s'.repeat(40)}002`, since: sessionEndsSoFar() }, true);
        expect(other.holds.get('uid-a'), `${answer.kind} other token`).toEqual(detached);
        const ended = voidRig(); // a sign-out began after it was sent
        ended.holds.put('uid-a', start);
        const before = sent();
        createTenantSessionClient().reset();
        settleVoid(ended.holds, 'uid-a', voidKey(1), answer, first, before, true);
        expect(ended.holds.get('uid-a'), `${answer.kind} sign-out`).toEqual(detached);
        const gone = voidRig(); // already detached (a token change found by the section, a user change)
        gone.holds.put('uid-a', start);
        gone.holds.detach('uid-a');
        settleVoid(gone.holds, 'uid-a', voidKey(1), answer, first, sent(), true);
        expect(gone.holds.get('uid-a'), `${answer.kind} detached`).toEqual(detached);
      }
      const replaced = voidRig(); // a settled attempt replaced by a newer one: the old key's late answer is no-one's
      replaced.holds.put('uid-a', held(1, { state: 'voided', body: '' }));
      replaced.holds.put('uid-a', held(2));
      settleVoid(replaced.holds, 'uid-a', voidKey(1), answer, true, sent(), true);
      expect(replaced.holds.get('uid-a')).toEqual(held(2));
    }
  });

  it('SII-76. VOID-P2 hold: detaching keeps what its card needs — the state (live or settled), the note, what Check invoice saw, its store and invoice — and drops the token and the bytes for good: no change gives either back (none moves what was sent, attached or not; no change re-keys it, sets a field to undefined, adds a field or gives Check again back), its scrub timer goes, and a detached live attempt still holds a new void back until it is dismissed; detachOthers spares only the user named', () => {
    fakeClock();
    const { holds } = voidRig();
    holds.put('uid-a', held(1));
    holds.change('uid-a', voidKey(1), { state: 'unresolved', note: VOID_NOTE_TEXT.noAnswer, seen: 'voided', seenReason: 'other' });
    expect(vi.getTimerCount()).toBe(1);
    for (const sentChange of [
      { body: `{"expectedTenant":"${TENANT_A}","reasonCode":"other"}` }, { csrf: `${'s'.repeat(40)}002` }, { csrf: null }, { sentAt: T0.mono + HOUR }, { sentWall: T0.wall + HOUR },
      { storeId: STORE_2 }, { invoiceId: uuid(0x1aff) }, { number: 9 }, { storeLabel: 'Kiosk' }, { state: 'checking' as const, body: BODY },
      { key: voidKey(9) } as never, { unknownField: 1 } as never, { body: undefined }, { state: undefined }, { note: undefined, state: 'checking' as const },
      { refusal: undefined }, { retryable: true },
    ]) expect(holds.change('uid-a', voidKey(1), sentChange), `${Object.keys(sentChange)} ${JSON.stringify(sentChange)}`).toBe(false); // what was sent is the put's for good
    expect(holds.get('uid-a')).toEqual({ ...held(1), state: 'unresolved', note: VOID_NOTE_TEXT.noAnswer, seen: 'voided', seenReason: 'other' });
    holds.detach('uid-a');
    const detached = { ...held(1), state: 'unresolved', note: VOID_NOTE_TEXT.noAnswer, seen: 'voided', seenReason: 'other', csrf: null, body: '' };
    expect(holds.get('uid-a')).toEqual(detached);
    expect(vi.getTimerCount()).toBe(0);
    for (const revive of [{ csrf: CSRF }, { body: BODY }, { csrf: CSRF, body: BODY, state: 'checking' as const }]) {
      expect(holds.change('uid-a', voidKey(1), revive)).toBe(false); // changing back cannot revive it
    }
    expect(holds.get('uid-a')).toEqual(detached);
    expect(holds.change('uid-a', voidKey(1), { seen: 'issued', seenReason: null })).toBe(true); // a later read may still say what it saw
    expect(holds.put('uid-a', held(2))).toBe(false); // still live: it may still void, so Dismiss comes first
    expect(holds.remove('uid-a', voidKey(1))).toBe(true);
    holds.put('uid-a', held(3, { state: 'voided', body: '' }));
    holds.detach('uid-a');
    expect(holds.get('uid-a')).toEqual({ ...held(3, { state: 'voided' }), csrf: null, body: '' }); // settled: its state stays
    holds.put('uid-b', held(4));
    holds.put('uid-m', held(5, { state: 'unresolved' }));
    expect(vi.getTimerCount()).toBe(2);
    holds.detachOthers('uid-b'); // a user change to uid-b
    expect(holds.get('uid-b')).toEqual(held(4));
    expect(holds.get('uid-m')).toEqual({ ...held(5, { state: 'unresolved' }), csrf: null, body: '' });
    expect(vi.getTimerCount()).toBe(1);
    holds.detachOthers(null); // a sign-out
    expect(holds.get('uid-b')).toEqual({ ...held(4), csrf: null, body: '' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SII-77. VOID-P2 hold: the shop\'s one void store is bound to the sign-out — at the start of every logout and reset each user\'s attempt is detached, its state kept — and the module can send nothing for it', async () => {
    fakeClock();
    const real = (n: number, over: Partial<HeldVoid> = {}) => held(n, { sentAt: performance.now(), sentWall: Date.now(), ...over }); // the singleton's own clocks
    try {
      const a = real(1);
      const b = real(2, { state: 'unresolved' });
      expect(voidHolds.put('uid-a', a)).toBe(true);
      expect(voidHolds.put('uid-b', b)).toBe(true);
      expect(voidHolds.get('uid-a')!.body).toBe(BODY);
      createTenantSessionClient().reset();
      expect(voidHolds.get('uid-a')).toEqual({ ...a, csrf: null, body: '' });
      expect(voidHolds.get('uid-b')).toEqual({ ...b, csrf: null, body: '' });
      voidHolds.remove('uid-a', a.key);
      voidHolds.remove('uid-b', b.key);
      const c = real(3, { state: 'checking' });
      voidHolds.put('uid-a', c);
      const session = createTenantSessionClient({ fetch: (async () => new Response(null, { status: 401 })) as typeof globalThis.fetch });
      const ending = session.logout(); // heard synchronously, before anything is sent or awaited
      expect(voidHolds.get('uid-a')).toEqual({ ...c, csrf: null, body: '' });
      await ending;
      voidHolds.remove('uid-a', c.key);
      expect(vi.getTimerCount()).toBe(0);
      sendsNothing();
    } finally {
      for (const uid of ['uid-a', 'uid-b']) { const h = voidHolds.get(uid); if (h !== undefined) voidHolds.remove(uid, h.key); } // the singleton is shared: leave it empty
    }
  });

  it('SII-78. VOID-P2 hold: the cutoff is 23 hours from the FIRST send by the larger of the monotonic and wall-clock time elapsed — a wall clock set back or a suspended monotonic clock never extends it, nor does a Check again\'s answer; the scrub timer armed at put clears only the bytes when it is due, keeps what the card needs, and sends nothing', () => {
    fakeClock();
    const h = held(1);
    expect(voidExpired(h, T0.mono, T0.wall)).toBe(false);
    expect(voidExpired(h, T0.mono + 23 * HOUR - 1, T0.wall + 23 * HOUR - 1)).toBe(false);
    expect(voidExpired(h, T0.mono + 23 * HOUR, T0.wall - 5 * HOUR)).toBe(true); // the wall clock set back: the monotonic one says it
    expect(voidExpired(h, T0.mono, T0.wall + 23 * HOUR)).toBe(true); // a suspended device: the wall clock says it
    const { clock, holds } = voidRig();
    holds.put('uid-a', h);
    expect(vi.getTimerCount()).toBe(1);
    const pass = (ms: number) => { clock.mono += ms; clock.wall += ms; vi.advanceTimersByTime(ms); };
    pass(22 * HOUR);
    holds.change('uid-a', h.key, { state: 'checking' }); // a Check again at 22 hours, its answer undecided
    settleVoid(holds, 'uid-a', h.key, { kind: 'unknown', responded: false }, false, sent());
    expect(holds.get('uid-a')).toMatchObject({ state: 'unresolved', body: BODY, sentAt: T0.mono, sentWall: T0.wall });
    pass(HOUR - 1);
    expect(holds.get('uid-a')!.body).toBe(BODY);
    pass(1);
    expect(holds.get('uid-a')).toEqual({ ...h, state: 'unresolved', note: VOID_NOTE_TEXT.noAnswer, body: '' }); // key, state, store, invoice and token stay
    expect(vi.getTimerCount()).toBe(0);
    sendsNothing();
  });

  it('SII-79. VOID-P2 hold: the scrub timer judges the clocks again when it fires — early it re-arms for what is left; late (timers held back while the wall clock ran on) it scrubs then, voidExpired already closing the send in between and any change of the attempt scrubbing it at once — and a timer exists exactly while the attempt holds bytes: none after a voided or decided settle, a removal, a pre-key removal or a detach, one while unresolved', () => {
    fakeClock();
    const early = voidRig();
    early.holds.put('uid-a', held(1));
    vi.advanceTimersByTime(23 * HOUR); // due, but neither clock has moved 23 hours (a test-only skew): nothing scrubbed
    expect(early.holds.get('uid-a')!.body).toBe(BODY);
    expect(vi.getTimerCount()).toBe(1); // armed again
    early.clock.mono += 23 * HOUR;
    vi.advanceTimersByTime(23 * HOUR);
    expect(early.holds.get('uid-a')!.body).toBe('');
    const late = voidRig();
    late.holds.put('uid-b', held(2, { state: 'unresolved' }));
    late.clock.wall += 23 * HOUR; // suspended: the timer has not fired
    expect(voidExpired(late.holds.get('uid-b')!, late.clock.mono, late.clock.wall)).toBe(true); // a send handler refuses already
    expect(late.holds.get('uid-b')!.body).toBe(BODY); // the recorded limit: the bytes wait for the timer, a change or the section's focus scrub
    vi.advanceTimersByTime(23 * HOUR); // the held-back timer finally runs
    expect(late.holds.get('uid-b')).toEqual({ ...held(2, { state: 'unresolved' }), body: '' });
    const touched = voidRig();
    touched.holds.put('uid-m', held(3, { state: 'unresolved' }));
    touched.clock.wall += 23 * HOUR;
    touched.holds.change('uid-m', voidKey(3), { seen: 'issued', seenReason: null }); // e.g. a Check invoice read's answer
    expect(touched.holds.get('uid-m')!.body).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    const { holds } = voidRig();
    holds.put('uid-a', held(4));
    expect(vi.getTimerCount()).toBe(1);
    settleVoid(holds, 'uid-a', voidKey(4), { kind: 'voided', replayed: false }, true, sent());
    expect(vi.getTimerCount()).toBe(0);
    holds.put('uid-a', held(5));
    holds.remove('uid-a', voidKey(5)); // a removal (the card's Dismiss, where it is offered)
    expect(vi.getTimerCount()).toBe(0);
    holds.put('uid-a', held(6));
    settleVoid(holds, 'uid-a', voidKey(6), { kind: 'step-up' }, true, sent(), true); // removed: nothing ran
    expect(vi.getTimerCount()).toBe(0);
    holds.put('uid-a', held(7));
    settleVoid(holds, 'uid-a', voidKey(7), { kind: 'in-progress' }, true, sent());
    expect(vi.getTimerCount()).toBe(1); // unresolved: still sendable, still timed
    settleVoid(holds, 'uid-a', voidKey(7), { kind: 'already-void' }, false, sent());
    expect(vi.getTimerCount()).toBe(0);
    holds.put('uid-a', held(8));
    holds.detach('uid-a');
    expect(vi.getTimerCount()).toBe(0);
    sendsNothing();
  });

  it('SII-80. VOID-P2 hold: a Check again\'s 422 (key reused, an UNSEALED chain answer) is an integrity failure that ends nothing — the attempt stays unresolved and live with its key, bytes and timer and the key-reused note, and Check again is withdrawn one way (no change and no later answer gives it back); its sealed answer still settles it; a step-up withdraws it the same way; a FIRST send\'s 422 (a fresh key: nothing ran) is refused', () => {
    fakeClock();
    expect(VOID_NOTE_TEXT.keyReused).toBe("The server reports this request key was already used for a different request. That is unexpected: the outcome of the original request is still unknown. Use Check invoice to see the invoice's current state.");
    const { holds } = voidRig();
    holds.put('uid-a', held(1, { state: 'checking' }));
    settleVoid(holds, 'uid-a', voidKey(1), { kind: 'key-reused' }, false, sent());
    expect(holds.get('uid-a')).toEqual({ ...held(1), state: 'unresolved', note: VOID_NOTE_TEXT.keyReused, retryable: false });
    expect(isLiveVoid(holds.get('uid-a'))).toBe(true); // it may still void: a new void waits for Dismiss, no key is rotated
    expect(holds.put('uid-a', held(2))).toBe(false);
    expect(vi.getTimerCount()).toBe(1); // its bytes stay, timed to the cutoff
    expect(holds.change('uid-a', voidKey(1), { retryable: true })).toBe(false); // one way
    holds.change('uid-a', voidKey(1), { state: 'checking' });
    settleVoid(holds, 'uid-a', voidKey(1), { kind: 'unknown', responded: false }, false, sent());
    expect(holds.get('uid-a')).toMatchObject({ state: 'unresolved', note: VOID_NOTE_TEXT.noAnswer, retryable: false, body: BODY }); // no later answer sets it back
    settleVoid(holds, 'uid-a', voidKey(1), { kind: 'voided', replayed: true }, false, sent());
    expect(holds.get('uid-a')).toMatchObject({ state: 'voided', body: '' });
    const stepped = voidRig();
    stepped.holds.put('uid-a', held(3, { state: 'checking' }));
    settleVoid(stepped.holds, 'uid-a', voidKey(3), { kind: 'step-up' }, false, sent());
    expect(stepped.holds.get('uid-a')).toEqual({ ...held(3), state: 'unresolved', note: VOID_NOTE_TEXT.stepUp, retryable: false });
    const fresh = voidRig();
    fresh.holds.put('uid-a', held(4));
    settleVoid(fresh.holds, 'uid-a', voidKey(4), { kind: 'key-reused' }, true, sent());
    expect(fresh.holds.get('uid-a')).toEqual({ ...held(4), ...refusedAs('key-reused') });
  });

  it('SII-81. VOID-P2 hold: a settled attempt is final — a late or duplicate answer for its own key (a 200, a sealed or unsealed refusal, an undecided one, a pre-key refusal, one never sent) changes nothing, first send or check, open or not; and a stamp or clock that is not a finite number counts as past the cutoff, the bytes scrubbed at once with no timer left to re-arm', () => {
    fakeClock();
    const late: VoidResult[] = [
      { kind: 'voided', replayed: true }, { kind: 'already-void' }, { kind: 'key-reused' }, { kind: 'unknown', responded: false }, { kind: 'in-progress' }, { kind: 'step-up' },
      { kind: 'signed-out' }, { kind: 'not-sent' },
    ];
    for (const settled of [held(1, { state: 'voided', body: '' }), held(1, refusedAs('tenant-conflict'))]) {
      for (const answer of late) {
        for (const first of [true, false]) {
          for (const open of [true, false]) {
            const { holds } = voidRig();
            holds.put('uid-a', settled);
            settleVoid(holds, 'uid-a', voidKey(1), answer, first, sent(), open);
            expect(holds.get('uid-a'), `${settled.state} then ${answer.kind}, first ${first}, open ${open}`).toEqual(settled);
          }
        }
      }
    }
    const NaN_ = Number.NaN;
    const INF = Number.POSITIVE_INFINITY;
    for (const [sentAt, sentWall, mono, wall] of [
      [NaN_, T0.wall, T0.mono, T0.wall], [T0.mono, NaN_, T0.mono, T0.wall], [-INF, T0.wall, T0.mono, T0.wall], [INF, INF, T0.mono, T0.wall],
      [T0.mono, T0.wall, NaN_, T0.wall], [T0.mono, T0.wall, T0.mono, NaN_],
    ]) expect(voidExpired({ sentAt, sentWall }, mono, wall), `${sentAt} ${sentWall} ${mono} ${wall}`).toBe(true);
    const broken = voidRig();
    broken.holds.put('uid-a', held(1, { sentAt: NaN_ }));
    expect(broken.holds.get('uid-a')!.body).toBe(''); // scrubbed at put: closed, never open
    const clockless = createVoidHoldStore({ now: () => NaN_, wallNow: () => T0.wall });
    clockless.put('uid-b', held(2));
    expect(clockless.get('uid-b')!.body).toBe('');
    expect(vi.getTimerCount()).toBe(0); // no NaN delay re-arming itself
    vi.advanceTimersByTime(HOUR);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SII-82. VOID-P2 hold: dispose (the end of a store a hot reload replaces) clears every scrub timer and detaches every attempt — token and bytes gone, state kept, live and settled alike — and nothing can give them back; the module disposes its one store together with its sign-out listener', () => {
    fakeClock();
    const { holds } = voidRig();
    holds.put('uid-a', held(1));
    holds.put('uid-b', held(2, { state: 'unresolved', note: VOID_NOTE_TEXT.noAnswer }));
    holds.put('uid-m', held(3, { state: 'voided', body: '' }));
    expect(vi.getTimerCount()).toBe(2);
    holds.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(holds.get('uid-a')).toEqual({ ...held(1), csrf: null, body: '' });
    expect(holds.get('uid-b')).toEqual({ ...held(2, { state: 'unresolved', note: VOID_NOTE_TEXT.noAnswer }), csrf: null, body: '' });
    expect(holds.get('uid-m')).toEqual({ ...held(3, { state: 'voided' }), csrf: null, body: '' });
    expect(holds.change('uid-a', voidKey(1), { body: BODY })).toBe(false);
    vi.advanceTimersByTime(24 * HOUR);
    expect(vi.getTimerCount()).toBe(0);
    // import.meta.hot is undefined under the test runner, so the module's own wiring is pinned in its source.
    expect(holdSource()).toContain('import.meta.hot?.dispose(() => { unbindVoidHolds(); voidHolds.dispose(); });');
    sendsNothing();
  });
});

// M7B-INVOICES-VOID-P2 checkpoint B — voiding from the Issued section's dialog (doc 13 §5 G, §12; design §4, §5 and
// R9–R23): the action and its gating, the review re-read, the confirmation, ONE send under ONE key held before it
// leaves, every answer settled by key, the held card's Check again and Check invoice, detachment, the 23-hour cutoff,
// the sign-in after a step-up, and what is never sent or kept. The REAL section, clients and hold over the fake server
// (its void command decides like P1's: authority and the recent sign-in before the key, then the key, the tenant, the
// target and the sealed outcome). Every assertion about a request is made on what the fake recorded.
describe('Issued invoices — voiding an issued invoice: the action, the confirmation and recovery (M7B-INVOICES-VOID-P2 checkpoint B)', () => {
  const box = () => screen.queryByTestId('issued-void-confirm');
  const cardState = () => tid('issued-void-card').getAttribute('data-state');
  const cardStatus = () => tid('issued-void-card-status').textContent ?? '';
  const heldA = (r: Rig) => r.holds.get('uid-a');
  const voidUrl = (storeId: string, invoiceId: string) => `${STORES_PATH}/${storeId}/invoices/${invoiceId}/void`;
  const eligUrl = (storeId: string, invoiceId: string) => `${voidUrl(storeId, invoiceId)}-eligibility`;
  const detailUrl = (storeId: string, invoiceId: string) => `${STORES_PATH}/${storeId}/invoices/${invoiceId}`;
  const VBODY = (reason: string, tenant = TENANT_A) => `{"expectedTenant":"${tenant}","reasonCode":"${reason}"}`;
  /** A sealed answer: exactly {error} (the chain's is {error, requestId}). */
  const sealed = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
  const json200 = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  /** What was sent from `from` on, without the session's own requests, as "METHOD url". */
  const apart = (server: Server, from = 0) => sentFrom(server, from).filter((line) => !line.includes(' /api/v1/session'));
  const buttons = (testId: string) => within(tid(testId)).queryAllByRole('button').map((b) => b.textContent);
  const radios = () => within(tid('issued-void-reasons')).getAllByRole('radio') as HTMLInputElement[];
  const LABELS = ['Issued by mistake', 'Wrong customer', 'Wrong lines or amounts', 'Wrong seller details', 'Duplicate of another invoice', 'Other reason'];
  const UNRESOLVED_2 = 'Void of invoice 2 at Main Street is not confirmed. The server may or may not have voided it.';

  async function setup(over: Partial<ServerIssuedInvoicesProps> = {}, prepare: (server: Server) => void = () => {}) {
    const server = seeded();
    prepare(server);
    const made = issueAt(server, STORE_1, 3);
    const r = rig(server);
    const page = render(<ServerIssuedInvoices {...r.props(over)} />);
    await showAndChoose(STORE_1);
    await listReady();
    return { server, made, r, page };
  }
  async function openVoidable(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
  }
  async function openConfirm(n: number) {
    await openVoidable(n);
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
  }
  async function pressWith(code: InvoiceVoidReasonCode) {
    await user().click(tid(`issued-void-reason-${code}`));
    await click('issued-void-send');
  }
  /** A first send whose request was lost before the server decided (nothing committed): unresolved, the confirmation still open. */
  async function unresolvedOn(server: Server, r: Rig, n = 2, code: InvoiceVoidReasonCode = 'wrong_customer') {
    await openConfirm(n);
    server.voids.push('lose-before');
    await pressWith(code);
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
  }
  async function closeAll() {
    if (box() !== null) await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    if (screen.queryByTestId('issued-view') !== null) await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
  }

  it('SII-83. VOID-12 AC-02 R14: "Void invoice…" sits in a row under the dialog\'s header held from the open on, and shows only for the eligibility read\'s exact allowed AND an issued invoice; a voided invoice, a refusal (ONE fresh session check), an outage, a malformed allowed and a 401 leave nothing but the empty row — no retry control; nothing is read before a dialog opens, and each open reads the eligibility once', async () => {
    const { server, made } = await setup();
    made[1].void = { voidedAt: server.voidAt, reasonCode: 'duplicate' };
    expect(server.eligReads()).toEqual([]); // the list and a store choice read no eligibility
    server.hold.elig = 1;
    await user().click(openButton(3));
    await viewReady(3);
    const row = tid('issued-view-void-row');
    // Layout round supersession (review B1 L-1; was `min-h-[2.125rem]` on the row and no child): the row's height is held
    // by an invisible copy of the trigger in the same grid cell — present from the open on, aria-hidden, nothing focusable
    // — and the real cell is empty while the answer is out. jsdom pins the structure only; the browser measures it.
    const placeholder = within(row).getByTestId('issued-view-void-placeholder');
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(placeholder).toHaveClass('invisible');
    expect(placeholder.querySelector('[data-reserve]')).toHaveAttribute('data-reserve', VOID_TEXT.open);
    expect(row).not.toHaveClass('min-h-[2.125rem]');
    expect(tid('issued-view-void-cell').children).toHaveLength(0);
    expect(tid('issued-view-close').compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(tid('issued-view-status')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // before the <dl>
    server.held.shift()!.release();
    await waitFor(() => expect(within(row).getByRole('button', { name: VOID_TEXT.open })).toHaveAttribute('aria-disabled', 'false'));
    expect(tid('issued-view-void-row')).toBe(row); // the answer filled the reserved row: nothing moved
    expect(tid('issued-view-void')).toHaveAttribute('aria-haspopup', 'dialog');
    expect(server.eligReads()).toEqual([eligUrl(STORE_1, made[2].id)]);
    await closeAll();
    // A voided invoice: the row is there and empty.
    await user().click(openButton(2));
    await viewReady(2);
    await waitFor(() => expect(server.eligReads()).toHaveLength(2));
    await settle();
    expect(tid('issued-view-void-cell').children).toHaveLength(0); // L-1: the real cell is empty (the copy stays)
    expect(buttons('issued-view')).toEqual(['Close']);
    await closeAll();
    // Not allowed (a refusal after its one fresh check), an outage, an allowed with an extra member: nothing but the row.
    for (const answer of ['refused', 'outage', 'malformed'] as const) {
      if (answer === 'refused') server.voidDenied.add('uid-a');
      else server.eligStatus.push(answer === 'outage' ? 503 : json200({ eligibility: 'allowed', extra: true }));
      const reads = server.eligReads().length;
      await user().click(openButton(3));
      await viewReady(3);
      await waitFor(() => expect(server.eligReads()).toHaveLength(reads + 1));
      await settle();
      expect(tid('issued-view-void-cell').children, answer).toHaveLength(0); // L-1: the real cell is empty (the copy stays)
      expect(buttons('issued-view'), answer).toEqual(['Close']);
      if (answer === 'refused') {
        const at = server.sent.map((x) => x.url).lastIndexOf(eligUrl(STORE_1, made[2].id));
        expect(sentFrom(server, at + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]); // ONE fresh check, no loop
      }
      server.voidDenied.delete('uid-a');
      await closeAll();
    }
    // A 401: the existing session-ended path (only Reconnect signs in again).
    server.eligStatus.push(401);
    await user().click(openButton(3));
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-view')).toBeNull();
    expect(server.voidPosts()).toEqual([]);
  });

  it('SII-84. VOID-12: the drafts card\'s "View invoice" (the dialog with no void capability) never offers voiding and reads no eligibility — its output is the read-only dialog byte for byte: the Issued section\'s differs ONLY by its void area', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 1);
    const session = createTenantSessionClient({ fetch: server.fetch });
    const issuing = createInvoiceIssuingClient({ fetch: server.fetch });
    const s = await session.ensure('uid-a', async () => 'tok-a');
    if (s.kind !== 'ok') throw new Error('no session');
    const got = await issuing.getIssued(STORE_1, made[0].id, s.csrf);
    if (got.kind !== 'ok') throw new Error('no invoice');
    const answer = { kind: 'ok' as const, invoice: got.invoice };
    const base = { storeId: STORE_1, invoiceId: made[0].id, read: async () => answer, current: () => true, waiting: false, onClose: () => {}, returnFocus: { current: null } };
    const mark = server.sent.length;
    render(<IssuedInvoiceDialog {...base} />);
    await viewReady(1);
    await settle();
    const plain = tid('issued-view').outerHTML;
    expect(buttons('issued-view')).toEqual(['Close']);
    expect(screen.queryByTestId('issued-view-void-area')).toBeNull();
    expect(plain).not.toContain('issued-view-void');
    cleanup();
    const eligibility = vi.fn(async () => 'not' as const);
    const voiding: IssuedVoidCapability = {
      store: store(STORE_1, 'Main Street'), held: undefined, expired: false, cooling: false, finding: false, checkText: '', confirmedDenial: null, reauthMethod: () => 'password', signingIn: false, generation: () => 1,
      eligibility, send: vi.fn(async () => null), check: vi.fn(), find: vi.fn(), signIn: vi.fn(async () => null),
    };
    render(<IssuedInvoiceDialog {...base} voiding={voiding} />);
    await viewReady(1);
    await waitFor(() => expect(eligibility).toHaveBeenCalledTimes(1));
    await settle();
    const withVoid = tid('issued-view').cloneNode(true) as HTMLElement;
    withVoid.querySelector('[data-testid="issued-view-void-area"]')!.remove();
    expect(withVoid.outerHTML).toBe(plain);
    expect(server.sent.slice(mark).filter((x) => x.url.includes('/void'))).toEqual([]);
  });

  it('SII-85. VOID-13 AC-04 R10: "Void invoice…" re-reads the detail ONCE (a double press is one GET) while the invoice and the trigger stay, "Checking this invoice…"; the confirmation is an alertdialog named "Void invoice 2?" described by ONE element — the number, the store, the customer, the UTC issue time, the exact Total on its own line and what voiding means — with a required reason group in the pinned order, none chosen, no free text; Keep invoice has the first focus; Keep invoice and Escape close it with nothing sent and give focus back to "Void invoice…"', async () => {
    const { server, made, r } = await setup();
    await openVoidable(2);
    const trigger = tid('issued-view-void');
    const before = server.details().length;
    server.hold.detail = 1;
    await user().dblClick(trigger);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveAccessibleDescription(VOID_TEXT.reviewing);
    expect(tid('issued-view-void-status')).toHaveTextContent(VOID_TEXT.reviewing); // said in the live region too (review B1 F5)
    expect(tid('issued-view-total')).toHaveTextContent('Total $21.76'); // the shown invoice stays during the review read
    fireEvent.click(trigger);
    await flush();
    expect(server.details()).toHaveLength(before + 1);
    server.held.shift()!.release();
    await waitFor(() => expect(box()).not.toBeNull());
    expect(server.details()).toHaveLength(before + 1);
    const dialog = box()!;
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Void invoice 2?');
    expect(dialog.getAttribute('aria-describedby')!.split(' ')).toHaveLength(1);
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect(tid('issued-void-facts')).toHaveTextContent(/^Invoice 2 at Main Street, for Ada Customer, issued 2026-10-16 21:00:02 UTC\.$/);
    expect(description).toContainElement(tid('issued-void-total'));
    expect(tid('issued-void-total').textContent).toBe('Total $21.76');
    expect(tid('issued-void-total')).toHaveClass('whitespace-nowrap');
    expect(tid('issued-void-total-scroll')).toHaveAttribute('role', 'region');
    expect(tid('issued-void-consequence').textContent).toBe(VOID_TEXT.consequence);
    expect(dialog).toHaveAccessibleDescription(/Invoice 2 at Main Street, for Ada Customer, issued 2026-10-16 21:00:02 UTC\..*Total \$21\.76.*Voiding is final in the shop/);
    for (const id of ['issued-void-store', 'issued-void-customer']) {
      expect(tid(id).tagName, id).toBe('BDI');
      expect(tid(id), id).toHaveClass('break-words');
    }
    expect(tid('issued-void-issued-at').tagName).toBe('TIME');
    expect(tid('issued-void-issued-at')).toHaveAttribute('datetime', made[1].issuedAt);
    // Layout round (review B1 L-2): the date and the clock are each one no-wrap token, so the time breaks only at spaces.
    expect([...tid('issued-void-issued-at').querySelectorAll('span.whitespace-nowrap')].map((t) => t.textContent)).toEqual(['2026-10-16', '21:00:02']);
    const group = within(dialog).getByRole('radiogroup', { name: VOID_TEXT.reasonLegend });
    expect(group).toHaveAttribute('aria-required', 'true');
    expect(group).toHaveAttribute('aria-invalid', 'false');
    expect(radios().map((x) => x.value)).toEqual([...VOID_REASON_CODES]);
    expect(radios().map((x) => x.value)).toEqual(['issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts', 'wrong_seller_details', 'duplicate', 'other']);
    expect(radios().map((x) => x.closest('label')!.textContent)).toEqual(LABELS);
    expect(radios().map((x) => x.checked)).toEqual([false, false, false, false, false, false]);
    expect(new Set(radios().map((x) => x.name)).size).toBe(1);
    expect(dialog.querySelectorAll('input:not([type="radio"]), textarea, select, input[type="hidden"]')).toHaveLength(0);
    // The first focus is the dialog's effect (DialogFrame): waited for, not raced (it failed once under host load, layout round).
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-void-keep')));
    expect(buttons('issued-void-confirm')).toEqual(['Keep invoice', 'Void invoice']);
    await user().click(tid('issued-void-reason-wrong_customer'));
    const mark = server.sent.length;
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-view-void')));
    expect(tid('issued-view')).toBeInTheDocument(); // the issued dialog stays
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    expect(radios().map((x) => x.checked)).toEqual([false, false, false, false, false, false]); // a new review: nothing kept
    await user().keyboard('{Escape}');
    await waitFor(() => expect(box()).toBeNull());
    expect(tid('issued-view')).toBeInTheDocument(); // Escape closes only the top dialog
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-view-void')));
    await settle();
    // Everything sent since the first review (review B1 tests 5: sentFrom, not `apart`): the second review's session check and read.
    expect(sentFrom(server, mark)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${detailUrl(STORE_1, made[1].id)}`]);
    expect([server.voidPosts(), r.keys, heldA(r)]).toEqual([[], [], undefined]);
  });

  it('SII-86. VOID-07 R10/R17: a review read that finds the invoice voided by now (another operator) shows the current detail — "Voided", its own recorded reason — says "This invoice is already voided." and opens no confirmation; the trigger goes and focus falls back to Close', async () => {
    const { server, made } = await setup();
    await openVoidable(2);
    made[1].void = { voidedAt: server.voidAt, reasonCode: 'duplicate' }; // voided elsewhere since the dialog read it
    await click('issued-view-void');
    await waitFor(() => expect(tid('issued-view-void-status')).toHaveTextContent(VOID_TEXT.alreadyVoided));
    expect(box()).toBeNull();
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/);
    expect(tid('issued-view-void-reason')).toHaveTextContent(/^Duplicate of another invoice$/);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-view-close')));
    expect(server.voidPosts()).toEqual([]);
  });

  it('SII-87. VOID-13 AC-04 R16: with no reason "Void invoice" is aria-disabled (never disabled) and says "Choose a reason first."; pressing it sends nothing at all — no session check, no key — marks the group invalid, describes it by that text and moves focus to the first reason; choosing one clears it; "Other reason" has no text field', async () => {
    const { server, r } = await setup();
    await openConfirm(2);
    const send = tid('issued-void-send');
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).not.toBeDisabled();
    expect(send).toHaveAccessibleDescription(VOID_TEXT.chooseReason);
    const mark = server.sent.length;
    await user().click(send);
    const group = screen.getByRole('radiogroup', { name: VOID_TEXT.reasonLegend });
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group).toHaveAccessibleDescription(VOID_TEXT.chooseReason);
    expect(tid('issued-void-reason-error')).toHaveTextContent(VOID_TEXT.chooseReason);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-void-reason-issued_in_error')));
    await settle();
    expect(sentFrom(server, mark)).toEqual([]);
    expect(r.keys).toEqual([]);
    await user().click(tid('issued-void-reason-other'));
    expect(group).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByTestId('issued-void-reason-error')).toBeNull();
    expect(send).toHaveAttribute('aria-disabled', 'false');
    expect(send).not.toHaveAttribute('aria-describedby');
    expect(box()!.querySelectorAll('input:not([type="radio"]), textarea')).toHaveLength(0);
  });

  it('SII-88. VOID-08/09 AC-01 AC-05 AC-06: ONE press is ONE POST under ONE key — a double click and repeated Enter send nothing more; the exact body {"expectedTenant","reasonCode"} with no version field, the command headers, the attempt (key and exact bytes) HELD before the request leaves; the reasons lock and Keep invoice reads "Close" (closing does not cancel); the validated 200 closes the confirmation (focus to Close), the detail is read again — "Voided" with the RECORDED reason and time — page one is re-read (the invoice stays listed, Voided), the section and the card say so; one void record', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 3);
    const r = rig(server);
    let atSend: HeldVoid | undefined | 'not sent' = 'not sent';
    const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).endsWith('/void') && atSend === 'not sent') atSend = r.holds.get('uid-a');
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    render(<ServerIssuedInvoices {...r.props({ issuing: createInvoiceIssuingClient({ fetch: watched }) })} />);
    await showAndChoose(STORE_1);
    await listReady();
    await openConfirm(2);
    await user().click(tid('issued-void-reason-wrong_customer'));
    server.hold.current = 1; // the press's session check, held: "Void invoice" is still there for the repeats
    server.hold.void = 1;
    const mark = server.sent.length;
    const send = tid('issued-void-send');
    act(() => send.focus());
    await user().keyboard('{Enter}{Enter}');
    fireEvent.click(send);
    await user().dblClick(send);
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
    expect(document.activeElement).toBe(send);
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveAccessibleDescription(VOID_TEXT.sendChecking);
    expect(tid('issued-void-confirm-status')).toHaveTextContent(VOID_TEXT.sendChecking); // said in the live region (review B1 F5)
    expect(box()).toHaveAttribute('aria-busy', 'false'); // never aria-busy: its live region is not held back
    expect(r.keys).toEqual([]); // no key before the session check has answered
    server.held.shift()!.release();
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['void']));
    await settle();
    expect(server.voidPosts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    const post = server.voidPosts()[0];
    expect(post.url).toBe(voidUrl(STORE_1, made[1].id));
    expect(post.body).toBe(VBODY('wrong_customer'));
    expect(post.body).not.toMatch(/version/i);
    expect(post.headers.get('idempotency-key')).toBe(r.keys[0]);
    expect(post.headers.get('x-tmpos-csrf')).toBe('1');
    const csrf = server.sent.find((x) => x.url === listPath(STORE_1))!.headers.get('x-tmpos-session-csrf');
    expect(post.headers.get('x-tmpos-session-csrf')).toBe(csrf);
    expect(atSend).toEqual({
      key: r.keys[0], body: VBODY('wrong_customer'), storeId: STORE_1, storeLabel: 'Main Street', invoiceId: made[1].id, number: 2, csrf,
      sentAt: r.clock.mono, sentWall: r.clock.wall, state: 'sending', note: '', refusal: null, seen: null, seenReason: null, retryable: true,
    });
    expect(tid('issued-void-reasons')).toBeDisabled();
    expect(screen.queryByTestId('issued-void-send')).toBeNull();
    expect(tid('issued-void-keep')).toHaveTextContent(/^Close$/);
    expect(tid('issued-void-keep')).toHaveAccessibleDescription(VOID_TEXT.closeWarning);
    expect(buttons('issued-void-confirm')).toEqual(['Close']);
    expect(tid('issued-void-confirm-status')).toHaveTextContent('Voiding invoice 2 at Main Street on the server…');
    fireEvent.click(tid('issued-void-reason-other')); // locked: a UI edit cannot change the held payload
    expect((tid('issued-void-reason-wrong_customer') as HTMLInputElement).checked).toBe(true);
    expect(heldA(r)!.body).toBe(VBODY('wrong_customer'));
    expect(tid('issued-void-confirm-alert').textContent).toBe(''); // the repeats were held back silently: no "Not sent" for them
    server.held.shift()!.release();
    await waitFor(() => expect(box()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-view-close')));
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    await waitFor(() => expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/));
    expect(tid('issued-view-void-status')).toHaveTextContent(VOID_TEXT.voided(2));
    expect(tid('issued-view-void-reason')).toHaveTextContent(/^Wrong customer$/);
    expect(tid('issued-view-voided-at')).toHaveAttribute('datetime', server.voidAt);
    expect(tid('issued-view-total')).toHaveTextContent('Total $21.76'); // the original contents
    await waitFor(() => expect(screen.getAllByTestId('issued-row-status').map((p) => p.textContent)).toEqual(['Issued', 'Voided', 'Issued']));
    expect(screen.getAllByTestId('issued-row-number').map((p) => p.textContent)).toEqual(['Invoice 3', 'Invoice 2', 'Invoice 1']); // no number allocated, none removed
    expect(tid('issued-notice')).toHaveTextContent(VOID_TEXT.voided(2));
    expect(cardState()).toBe('voided');
    expect(cardStatus()).toBe('Invoice 2 at Main Street was voided.');
    expect(heldA(r)).toMatchObject({ state: 'voided', body: '' });
    await settle();
    expect(apart(server, mark).sort()).toEqual([`POST ${voidUrl(STORE_1, made[1].id)}`, `GET ${detailUrl(STORE_1, made[1].id)}`, `GET ${listPath(STORE_1)}`].sort());
    expect(made[1].void).toEqual({ voidedAt: server.voidAt, reasonCode: 'wrong_customer' });
    expect(server.voidBodyViolations).toEqual([]);
    await closeAll();
    expect(buttons('issued-void-card')).toEqual(['Dismiss']);
    await click('issued-void-dismiss');
    expect(cardState()).toBe('none');
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-89. VOID-09 AC-06: a validated 200 whose detail read then fails says "Invoice 2 was voided. Its details could not be loaded." with "Load again", which sends ONLY the GET (never a second POST); the dialog then shows what the server records — its reason, never the one this attempt held', async () => {
    const { server, made } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.detailStatus.push(503);
    server.held.shift()!.release();
    await waitFor(() => expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.voidedUnread(2)));
    expect(box()).toBeNull();
    // Review B1 F3 (was `/^Issued$/`): the validated 200 says it is voided, so the Status says Voided before any read
    // does — but the void time and the reason come only from a read, never from the held attempt.
    expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/);
    expect(screen.queryByTestId('issued-view-voided-at')).toBeNull();
    expect(screen.queryByTestId('issued-view-void-reason')).toBeNull();
    made[1].void = { ...made[1].void!, reasonCode: 'duplicate' }; // what the server records is what a read shows
    const mark = server.sent.length;
    server.hold.detail = 1;
    await click('issued-view-void-load');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['detail']));
    // Through its own read Load again stays (aria-disabled, said why) and so does what it answers (review B1 react).
    expect(tid('issued-view-void-load')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-void-load')).toHaveAccessibleDescription(VIEW_TEXT.loading);
    expect(document.activeElement).toBe(tid('issued-view-void-load'));
    expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.voidedUnread(2));
    server.held.shift()!.release();
    await waitFor(() => expect(tid('issued-view-void-reason')).toBeInTheDocument());
    expect(tid('issued-view-void-reason')).toHaveTextContent(/^Duplicate of another invoice$/);
    expect(apart(server, mark)).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`]);
    expect(server.voidPosts()).toHaveLength(1);
    expect(screen.queryByTestId('issued-view-void-load')).toBeNull();
    expect(tid('issued-view-void-alert').textContent).toBe('');
  });

  const DECISIVE = [
    { name: 'a sealed 409 invalid_state (already void)', answer: () => sealed(409, 'invalid_state'), refusal: 'already-void' as const, reread: true },
    { name: 'a chain 404 (it may be the host\'s, R21)', answer: () => chain(404, 'not_found'), refusal: 'not-found' as const, reread: true },
    { name: 'a sealed 409 write_conflict (the version)', answer: () => sealed(409, 'write_conflict'), refusal: 'version-conflict' as const, reread: true },
    { name: 'a chain 409 write_conflict (the tenant)', answer: () => chain(409, 'write_conflict'), refusal: 'tenant-conflict' as const, reread: false },
    { name: 'a 422 idempotency_key_reused', answer: () => chain(422, 'idempotency_key_reused'), refusal: 'key-reused' as const, reread: false },
    { name: 'a 400 invalid_request', answer: () => chain(400, 'invalid_request'), refusal: 'invalid' as const, reread: false },
  ];
  it.each(DECISIVE)('SII-90. VOID-08 AC-07/08: a first send answered $name is decisive for its key — refused with that text, Close only, its bytes gone, never "voided"; a refusal that names the invoice reads its detail again (a GET); the card says the same', async ({ answer, refusal, reread }) => {
    const { server, made, r } = await setup();
    await openConfirm(2);
    server.voids.push(answer());
    const details = server.details().length;
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_REFUSED_TEXT[refusal]));
    expect(heldA(r)).toMatchObject({ state: 'refused', refusal, body: '' });
    expect(buttons('issued-void-confirm')).toEqual(['Close']);
    expect(tid('issued-void-keep')).not.toHaveAttribute('aria-describedby'); // decided: closing cancels nothing that is still out
    if (reread) await waitFor(() => expect(server.details()).toHaveLength(details + 1));
    await settle();
    expect(server.details()).toHaveLength(details + (reread ? 1 : 0));
    expect(server.voidPosts()).toHaveLength(1);
    expect(tid('issued-view-void-status').textContent).not.toContain('voided.');
    expect(screen.queryByText(VOID_TEXT.gone)).toBeNull(); // a 404 from the POST alone never says the invoice is gone
    expect(cardState()).toBe('refused');
    expect(tid('issued-void-card-refused')).toHaveTextContent(VOID_REFUSED_TEXT[refusal]);
    expect(made[1].void).toBeUndefined();
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(refusal === 'already-void' ? tid('issued-view-close') : tid('issued-view-void')));
  });

  const UNKNOWN = [
    { name: 'the request lost (no answer)', script: 'lose-before' as const, note: VOID_NOTE_TEXT.noAnswer },
    { name: 'a 503', script: () => chain(503, 'service_unavailable'), note: VOID_NOTE_TEXT.answered },
    { name: 'a 200 for another invoice', script: () => json200({ invoice: { id: uuid(0x1a09), status: 'voided' } }), note: VOID_NOTE_TEXT.answered },
    { name: 'a 200 replayed "false"', script: () => json200({ invoice: { id: uuid(0x1a02), status: 'voided' } }, { 'idempotent-replayed': 'false' }), note: VOID_NOTE_TEXT.answered },
    { name: 'request_in_progress', script: () => chain(409, 'request_in_progress'), note: VOID_NOTE_TEXT.inProgress },
  ];
  it.each(UNKNOWN)('SII-91. VOID-08 AC-07: a first send answered by $name leaves the outcome unknown — the attempt unresolved with its key and exact bytes, its note; the confirmation says so with Close, Check again and Check invoice, and so does the card (with Dismiss, which only stops tracking it)', async ({ script, note }) => {
    const { server, r } = await setup();
    await openConfirm(2);
    server.voids.push(typeof script === 'string' ? script : script());
    await pressWith('wrong_customer');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    expect(heldA(r)).toMatchObject({ key: r.keys[0], body: VBODY('wrong_customer'), note, retryable: true });
    // In progress (no Retry-After): Check again waits a moment, said; every other answer gives it back at once.
    expect(tid('issued-void-check')).toHaveAttribute('aria-disabled', note === VOID_NOTE_TEXT.inProgress ? 'true' : 'false');
    expect(tid('issued-void-confirm-status')).toHaveTextContent(UNRESOLVED_2);
    expect(tid('issued-void-confirm-note')).toHaveTextContent(note);
    expect(buttons('issued-void-confirm')).toEqual(['Close', 'Check again', 'Check invoice']);
    expect(tid('issued-void-keep')).toHaveAccessibleDescription(VOID_TEXT.closeWarning);
    expect(cardStatus()).toBe(UNRESOLVED_2);
    expect(buttons('issued-void-card')).toEqual(['Check again', 'Check invoice', 'Dismiss']);
    expect(tid('issued-void-dismiss')).toHaveAccessibleDescription(VOID_TEXT.dismissWarning);
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-92. VOID-08 AC-07: a first send\'s 429 (decided before the key: nothing ran) drops the attempt and says "Not voided: too many requests…"; "Void invoice" waits with its reason until Retry-After has passed — the countdown only gives it back — and the next press is a NEW key', async () => {
    const { server, r } = await setup();
    server.retryAfter = '30';
    await openConfirm(2);
    await user().click(tid('issued-void-reason-duplicate'));
    fakeClock();
    server.voids.push(429);
    fireEvent.click(tid('issued-void-send'));
    await until(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.rateLimited));
    expect(heldA(r)).toBeUndefined();
    expect(tid('issued-void-send')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-void-send')).toHaveAccessibleDescription(VOID_TEXT.sendWaiting);
    expect((tid('issued-void-reason-duplicate') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(tid('issued-void-send')); // held back: nothing
    await flush();
    await advance(31_000);
    await until(() => expect(tid('issued-void-send')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.voidPosts()).toHaveLength(1); // the countdown sends nothing
    fireEvent.click(tid('issued-void-send'));
    await until(() => expect(heldA(r)?.state).toBe('voided'));
    expect(server.voidPosts().map((x) => x.headers.get('idempotency-key'))).toEqual([r.keys[0], r.keys[1]]);
    expect(r.keys[0]).not.toBe(r.keys[1]);
  });

  it('SII-93. VOID-12 AC-02: a narrowing while the confirmation is open (the server now refuses 403) gets ONE fresh session check, then "You can no longer void invoices at this store.": the action is taken away (focus falls back to Close), nothing is sent twice and nothing is voided; a reopen asks the server again and offers nothing', async () => {
    const { server, made, r } = await setup();
    await openConfirm(2);
    server.voidDenied.add('uid-a'); // the owner's stored levels lost void_issued_invoices meanwhile
    await pressWith('wrong_lines_or_amounts');
    await waitFor(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.noLongerAllowed));
    const at = server.sent.findIndex((x) => x.method === 'POST' && x.url.endsWith('/void'));
    expect(sentFrom(server, at + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(buttons('issued-void-confirm')).toEqual(['Close']);
    expect(heldA(r)).toBeUndefined(); // decided before the key, said in the confirmation: nothing to track
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-view-close')));
    expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.noLongerAllowed);
    expect(made[1].void).toBeUndefined();
    await closeAll();
    await user().click(openButton(2));
    await viewReady(2);
    await waitFor(() => expect(server.eligReads()).toHaveLength(2));
    await settle();
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-94. VOID-08 AC-03 R22: a first send\'s 401 always ends the session (the dialogs and the list go; only Reconnect signs in): with its confirmation open the attempt is dropped; with it closed the card keeps "Not voided: your session had ended when it reached the server." (detached, no store named) — shown once Reconnect has begun a session, not beside the signed-out section — and nothing is re-sent', async () => {
    const { server, r } = await setup();
    await openConfirm(2);
    server.voids.push(401);
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect([box(), screen.queryByTestId('issued-view')]).toEqual([null, null]);
    expect(heldA(r)).toBeUndefined();
    expect(cardState()).toBe('none');
    await click('issued-retry'); // Reconnect
    await storesReady();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await listReady();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('issued-void-keep'); // closed while the POST is out
    await waitFor(() => expect(box()).toBeNull());
    server.held.shift()!.release(chain(401, 'unauthenticated'));
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(heldA(r)).toMatchObject({ state: 'refused', refusal: 'signed-out', csrf: null, body: '' });
    expect(cardState()).toBe('none'); // R22: not beside the signed-out section (review B1 iam 4) …
    await click('issued-retry');
    await storesReady();
    expect(tid('issued-void-card-refused')).toHaveTextContent(VOID_REFUSED_TEXT['signed-out']); // … but after Reconnect
    expect(VOID_REFUSED_TEXT['signed-out']).toBe('Not voided: your session had ended when it reached the server.'); // truth LOW-3
    expect(tid('issued-void-card').textContent).not.toContain('Main Street');
    expect(buttons('issued-void-card')).toEqual(['Dismiss']);
    await settle();
    expect(server.voidPosts()).toHaveLength(2);
  });

  it('SII-95. VOID-08 AC-07: after a lost answer (committed), "Check again" — inside the confirmation — re-sends the SAME key, the byte-identical body and the same session token to the same invoice; its sealed replay (Idempotent-Replayed) voids it: one void record, one key', async () => {
    const { server, made, r } = await setup();
    await openConfirm(2);
    server.voids.push('lose'); // the server committed; the answer never arrived
    await pressWith('other');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    expect(made[1].void).toEqual({ voidedAt: server.voidAt, reasonCode: 'other' });
    await click('issued-void-confirm-check');
    await waitFor(() => expect(box()).toBeNull());
    const [first, again] = server.voidPosts();
    expect(again.url).toBe(first.url);
    expect(again.body).toBe(first.body);
    for (const header of ['idempotency-key', 'x-tmpos-session-csrf', 'x-tmpos-csrf', 'content-type']) expect(again.headers.get(header), header).toBe(first.headers.get(header));
    expect(r.keys).toHaveLength(1);
    expect(heldA(r)).toMatchObject({ state: 'voided', body: '' });
    await waitFor(() => expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/));
    expect(tid('issued-view-void-reason')).toHaveTextContent(/^Other reason$/);
    expect(server.voidPosts()).toHaveLength(2);
    expect(server.voidBodyViolations).toEqual([]);
  });

  it('SII-96. VOID-07 AC-08: "Check invoice" is ONE ordinary GET of the held invoice that settles nothing: "still shows as issued" leaves the attempt unresolved; once another operator voided it with ANOTHER reason it says "voided now" and the reason it records — never the held reason, never that this request did it — and the attempt stays unresolved; a Check again then gets the sealed already-void: not this request\'s void', async () => {
    const { server, made, r } = await setup();
    await unresolvedOn(server, r, 2, 'wrong_customer');
    await closeAll();
    let mark = server.sent.length;
    await click('issued-void-find');
    await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.seenIssued(2)));
    expect(apart(server, mark)).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`]);
    expect(cardState()).toBe('unresolved');
    expect(buttons('issued-void-card')).toEqual(['Check again', 'Check invoice', 'Dismiss']);
    made[1].void = { voidedAt: server.voidAt, reasonCode: 'duplicate' }; // another operator, another reason
    mark = server.sent.length;
    await click('issued-void-find');
    await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.seenVoided(2)));
    expect(tid('issued-void-card-seen-reason')).toHaveTextContent(VOID_TEXT.seenReason('Duplicate of another invoice'));
    expect(apart(server, mark)).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`]);
    expect(cardState()).toBe('unresolved'); // the invoice's state now, not this attempt's outcome
    expect(cardStatus()).toBe(UNRESOLVED_2);
    expect(heldA(r)).toMatchObject({ state: 'unresolved', seen: 'voided', seenReason: 'duplicate', body: VBODY('wrong_customer') });
    expect(tid('issued-section').textContent).not.toContain(INVOICE_VOID_REASONS.wrong_customer);
    expect(document.body.textContent).not.toContain(INVOICE_VOID_REASONS.wrong_customer);
    await click('issued-void-check');
    await waitFor(() => expect(cardState()).toBe('refused'));
    expect(tid('issued-void-card-refused')).toHaveTextContent(VOID_REFUSED_TEXT['already-void']);
    expect(cardStatus()).not.toContain('was voided');
    expect(made[1].void).toEqual({ voidedAt: server.voidAt, reasonCode: 'duplicate' });
  });

  it('SII-97. VOID-07 AC-07/08: a Check invoice that fails proves nothing and says only that — an outage, a missing invoice, a refusal (after ONE fresh check) — the attempt stays unresolved; a Check again answered request_in_progress keeps the same key and bytes, and Check again waits a moment — the timer only gives it back', async () => {
    const { server, r } = await setup();
    await unresolvedOn(server, r);
    await closeAll();
    for (const [status, text] of [[503, VOID_TEXT.checkFailed], [404, VOID_TEXT.checkMissing], [403, VOID_TEXT.checkDenied]] as const) {
      server.detailStatus.push(status);
      await click('issued-void-find');
      await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(text));
      expect(cardState(), String(status)).toBe('unresolved');
      if (status === 403) { // ONE fresh session check after the refused read (review B1 tests 6)
        const at = server.sent.map((x) => x.url).lastIndexOf(detailUrl(STORE_1, invoice(2).id));
        expect(sentFrom(server, at + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
      }
    }
    fakeClock();
    server.voids.push(chain(409, 'request_in_progress'));
    fireEvent.click(tid('issued-void-check'));
    await until(() => expect(tid('issued-void-card-note')).toHaveTextContent(VOID_NOTE_TEXT.inProgress));
    expect(tid('issued-void-check')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-void-check')).toHaveAccessibleDescription(VOID_TEXT.coolDown);
    fireEvent.click(tid('issued-void-check')); // waits: nothing
    await flush();
    expect(server.voidPosts()).toHaveLength(2);
    await advance(5_000);
    await until(() => expect(tid('issued-void-check')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.voidPosts()).toHaveLength(2); // the countdown never sends
    const [first, again] = server.voidPosts();
    expect([again.body, again.headers.get('idempotency-key')]).toEqual([first.body, first.headers.get('idempotency-key')]);
    expect(heldA(r)).toMatchObject({ state: 'unresolved', key: r.keys[0], body: VBODY('wrong_customer') });
  });

  it('SII-98. VOID-11 AC-09: a store change keeps the attempt scoped to ITS store and invoice — the card still names Main Street, and Check invoice and Check again go to the held store\'s paths, never the store chosen now; its later 200 re-reads no list and says nothing in the section while another store is chosen (R23)', async () => {
    const { server, made, r } = await setup();
    server.issued.set(STORE_2, [invoice(1, { id: uuid(0x2a01), customerName: 'Second store 1' })]);
    await unresolvedOn(server, r);
    await closeAll();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await listReady();
    expect(customersShown()).toEqual(['Second store 1']);
    expect(cardStatus()).toBe(UNRESOLVED_2);
    let mark = server.sent.length;
    await click('issued-void-find');
    await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.seenIssued(2)));
    expect(apart(server, mark)).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`]);
    mark = server.sent.length;
    await click('issued-void-check');
    await waitFor(() => expect(cardState()).toBe('voided'));
    expect(cardStatus()).toBe('Invoice 2 at Main Street was voided.');
    await settle();
    expect(apart(server, mark)).toEqual([`POST ${voidUrl(STORE_1, made[1].id)}`]);
    expect(server.voidPosts()[1].body).toBe(VBODY('wrong_customer'));
    expect(screen.queryByTestId('issued-notice')).toBeNull();
    expect(customersShown()).toEqual(['Second store 1']);
    expect(server.voidBodyViolations).toEqual([]);
  });

  it('SII-99. VOID-11 AC-05 AC-09: the attempt outlives closing the confirmation and the dialog, a reopen and leaving the page (a remount over the same hold): the card is there at once; nothing is sent on mount, a focus, a tab return or timers; a new confirmation cannot send ("Another void is waiting to be confirmed."); Check again after the remount is the same key, bytes and token', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, r, page } = await setup();
    await unresolvedOn(server, r);
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    expect(tid('issued-view')).toBeInTheDocument(); // closing the confirmation keeps the dialog
    await closeAll();
    expect(cardState()).toBe('unresolved');
    await openConfirm(3);
    await user().click(tid('issued-void-reason-other'));
    expect(tid('issued-void-send')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-void-send')).toHaveAccessibleDescription(VOID_TEXT.pending);
    await click('issued-void-send');
    await settle();
    expect(server.voidPosts()).toHaveLength(1);
    await closeAll();
    page.unmount();
    const mark = server.sent.length;
    render(<ServerIssuedInvoices {...r.props()} />);
    expect(cardState()).toBe('unresolved');
    expect(cardStatus()).toBe(UNRESOLVED_2);
    await focusEvents();
    fakeClock();
    await advance(65_000);
    vi.useRealTimers();
    await focusEvents();
    expect(sentFrom(server, mark)).toEqual([]); // review B1 tests 5: nothing at all, not even a session check
    await click('issued-void-check');
    await waitFor(() => expect(server.voidPosts()).toHaveLength(2));
    const [first, again] = server.voidPosts();
    for (const header of ['idempotency-key', 'x-tmpos-session-csrf']) expect(again.headers.get(header), header).toBe(first.headers.get(header));
    expect([again.url, again.body]).toEqual([first.url, first.body]);
    await waitFor(() => expect(cardState()).toBe('voided'));
    expect(r.keys).toHaveLength(1);
    expect(server.voidBodyViolations).toEqual([]);
  });

  it.each(['another tab\'s token', 'a sign-out', 'a user change'] as const)('SII-100. VOID-11 AC-03 AC-09 R12: %s DETACHES an unconfirmed void for good — its token and bytes go; the card says it could not be confirmed, names no store and offers only Check invoice and Dismiss (never Check again); signing in again, Reconnect or changing back revives nothing and sends nothing', async (arm) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, r, page } = await setup();
    await unresolvedOn(server, r);
    await closeAll();
    if (arm === 'another tab\'s token') {
      server.otherTab('uid-a');
      await focusEvents();
    } else if (arm === 'a sign-out') {
      await act(async () => { await r.props().session!.logout(); });
    } else {
      page.rerender(<ServerIssuedInvoices {...r.props({ uid: 'uid-b' })} />);
      await settle();
      expect(cardState()).toBe('none'); // another user sees nothing of it
      page.rerender(<ServerIssuedInvoices {...r.props()} />);
    }
    await waitFor(() => expect(heldA(r)).toMatchObject({ csrf: null, body: '', state: 'unresolved', key: r.keys[0] }));
    expect(cardState()).toBe('detached');
    expect(cardStatus()).toBe(VOID_TEXT.detached);
    expect(tid('issued-void-card').textContent).not.toContain('Main Street');
    expect(buttons('issued-void-card')).toEqual(['Check invoice', 'Dismiss']);
    if (screen.queryByTestId('issued-retry') !== null) { await click('issued-retry'); await storesReady(); }
    else if (screen.queryByTestId('issued-show') !== null) { await click('issued-show'); await storesReady(); }
    await settle();
    expect(heldA(r)).toMatchObject({ csrf: null, body: '' });
    expect(buttons('issued-void-card')).toEqual(['Check invoice', 'Dismiss']);
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-101. VOID-11 AC-09 R4: a late answer for an attempt detached while its POST was out changes nothing but the detach — a late 200 never says "voided" there, re-reads nothing and settles nothing; Check invoice (a new authorized read under the new session) then shows the state now, without attribution', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, made, r } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await focusEvents(); // another token: a new generation (the dialogs go) and the attempt detached
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(heldA(r)).toMatchObject({ csrf: null, body: '', state: 'sending' });
    expect(buttons('issued-void-card')).toEqual(['Check invoice', 'Dismiss']); // detached: Dismiss even while sending (R8)
    const mark = server.sent.length;
    server.held.shift()!.release(); // its 200 (committed)
    await settle();
    expect(heldA(r)).toMatchObject({ csrf: null, state: 'sending' });
    expect(cardStatus()).toBe(VOID_TEXT.detached);
    expect(screen.queryByTestId('issued-notice')).toBeNull();
    expect(sentFrom(server, mark)).toEqual([]); // review B1 tests 5: nothing at all for the late 200
    await click('issued-void-find');
    await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.seenVoided(2)));
    expect(server.detailRequests().at(-1)!.headers.get('x-tmpos-session-csrf')).not.toBe(server.voidPosts()[0].headers.get('x-tmpos-session-csrf'));
    expect(cardState()).toBe('detached');
    expect(made[1].void?.reasonCode).toBe('wrong_customer');
  });

  it('SII-102. VOID-11 AC-09: the 23-hour window counts from the FIRST send by the larger of monotonic and wall time and never moves: a Check again at 22 hours goes, past 23 hours the card says it can no longer be checked again and the bytes go (a tab return scrubs them even when the timer was held back); judged again after the session check (monotonic), and at the press when timers were delayed — nothing is ever sent past it', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    {
      const { server, r } = await setup();
      await unresolvedOn(server, r);
      await closeAll();
      r.clock.wall += 22 * HOUR;
      server.voids.push('lose-before');
      await click('issued-void-check');
      await waitFor(() => expect(server.voidPosts()).toHaveLength(2));
      await waitFor(() => expect(cardState()).toBe('unresolved'));
      r.clock.wall += HOUR; // 23 hours after the FIRST send (the check at 22 hours moved nothing)
      await focusEvents();
      await waitFor(() => expect(heldA(r)!.body).toBe(''));
      expect(cardStatus()).toBe('Void of invoice 2 at Main Street is not confirmed, and it was sent too long ago to check again here. Use Check invoice to see the invoice\'s current state.');
      expect(buttons('issued-void-card')).toEqual(['Check invoice', 'Dismiss']);
      expect(server.voidPosts()).toHaveLength(2);
      cleanup();
    }
    {
      const { server, r } = await setup();
      await unresolvedOn(server, r);
      await closeAll();
      r.clock.mono += 23 * HOUR - 1_000;
      server.hold.current = 1;
      await click('issued-void-check');
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
      r.clock.mono += 2_000; // crossed while the session check was out
      server.held.shift()!.release();
      await waitFor(() => expect(heldA(r)!.body).toBe(''));
      await settle();
      expect(server.voidPosts()).toHaveLength(1);
      expect(heldA(r)!.state).toBe('unresolved');
      cleanup();
    }
    {
      fakeClock(); // the hold's scrub timer is armed on the fake clock and never runs: a throttled background tab
      const server = seeded();
      issueAt(server, STORE_1, 3);
      const r = rig(server);
      render(<ServerIssuedInvoices {...r.props()} />);
      fireEvent.click(tid('issued-show'));
      await until(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready'));
      fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
      await until(() => expect(listPhase()).toBe('ready'));
      fireEvent.click(openButton(2));
      await until(() => expect(tid('issued-view-void')).toBeInTheDocument());
      fireEvent.click(tid('issued-view-void'));
      await until(() => expect(box()).not.toBeNull());
      fireEvent.click(tid('issued-void-reason-wrong_customer'));
      server.voids.push('lose-before');
      fireEvent.click(tid('issued-void-send'));
      await until(() => expect(heldA(r)?.state).toBe('unresolved'));
      r.clock.wall += 23 * HOUR;
      expect(heldA(r)!.body).toBe(VBODY('wrong_customer')); // the timer has not run
      fireEvent.click(tid('issued-void-confirm-check'));
      await until(() => expect(heldA(r)!.body).toBe(''));
      await flush();
      expect(server.voidPosts()).toHaveLength(1);
    }
  });

  it('SII-103. VOID-11 AC-09: a page load loses the attempt — a new hold and a remount show no card, and nothing is sent on mount, a focus, Show or an open; the next void is a fresh review (nothing waiting)', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, r, page } = await setup();
    await unresolvedOn(server, r);
    await closeAll();
    page.unmount();
    const reloaded = createVoidHoldStore({ now: () => r.clock.mono, wallNow: () => r.clock.wall });
    render(<ServerIssuedInvoices {...r.props({ voidHolds: reloaded })} />);
    expect(cardState()).toBe('none');
    await focusEvents();
    await showAndChoose(STORE_1);
    await listReady();
    await openConfirm(2);
    await user().click(tid('issued-void-reason-other'));
    expect(tid('issued-void-send')).toHaveAttribute('aria-disabled', 'false');
    await settle();
    expect(server.voidPosts()).toHaveLength(1);
    expect(reloaded.get('uid-a')).toBeUndefined();
  });

  it('SII-104. VOID-12 AC-03 R11: a stale sign-in\'s 403 step_up_required (no key acquired) drops the attempt and offers an explicit sign-in group in the confirmation — nothing signs in on its own (a focus, a tab return); a wrong password says so; the sign-in keeps the dialog open, re-reads the invoice and its eligibility, clears the reason and asks for a NEW press, which is a NEW key under the NEW token', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, made, r } = await setup({}, (s) => { s.staleLogins = true; });
    await openConfirm(2);
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    expect(screen.getByRole('group', { name: VOID_TEXT.reauthTitle })).toBe(tid('issued-void-reauth-group'));
    expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.stepUp);
    expect(tid('issued-void-reauth-explain')).toHaveTextContent(VOID_TEXT.reauthExplain);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-void-reauth-password')));
    expect(heldA(r)).toBeUndefined();
    expect(server.keys.size).toBe(0); // nothing acquired at the server
    expect(buttons('issued-void-confirm')).toEqual(['Keep invoice', 'Confirm sign-in']);
    const logins = server.logins().length;
    await focusEvents();
    expect(server.logins()).toHaveLength(logins);
    type('issued-void-reauth-password', 'wrong');
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.reauthFailed));
    expect(server.logins()).toHaveLength(logins);
    const mark = server.sent.length;
    type('issued-void-reauth-password', 'correct horse');
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect(tid('issued-void-confirm-status')).toHaveTextContent(VOID_TEXT.renewed));
    expect(server.logins().slice(logins).map((x) => x.headers.get('x-tmpos-reauthenticate'))).toEqual(['1']);
    expect(apart(server, mark).sort()).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`, `GET ${eligUrl(STORE_1, made[1].id)}`].sort());
    expect(tid('issued-view')).toBeInTheDocument();
    expect(radios().map((x) => x.checked)).toEqual([false, false, false, false, false, false]);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-void-reason-issued_in_error')));
    expect(server.voidPosts()).toHaveLength(1);
    await pressWith('duplicate');
    await waitFor(() => expect(heldA(r)?.state).toBe('voided'));
    const [first, second] = server.voidPosts();
    expect(second.headers.get('idempotency-key')).toBe(r.keys[1]);
    expect(r.keys[1]).not.toBe(r.keys[0]);
    expect(second.headers.get('x-tmpos-session-csrf')).not.toBe(first.headers.get('x-tmpos-session-csrf'));
    expect(second.body).toBe(VBODY('duplicate'));
    expect(made[1].void?.reasonCode).toBe('duplicate');
    expect(server.voidBodyViolations).toEqual([]);
  });

  it('SII-105. VOID-12 R13: a Check again met by step_up_required (decided before the key: nothing about the earlier request) leaves the attempt unresolved with that note and withdraws Check again for good — Check invoice and Dismiss stay, and no sign-in is offered from it', async () => {
    const { server, r } = await setup();
    await unresolvedOn(server, r);
    await closeAll();
    const logins = server.logins().length;
    server.voids.push(chain(403, 'step_up_required'));
    await click('issued-void-check');
    await waitFor(() => expect(tid('issued-void-card-note')).toHaveTextContent(VOID_NOTE_TEXT.stepUp));
    expect(heldA(r)).toMatchObject({ state: 'unresolved', retryable: false, body: VBODY('wrong_customer') });
    expect(buttons('issued-void-card')).toEqual(['Check invoice', 'Dismiss']);
    expect(screen.queryByTestId('issued-void-reauth-group')).toBeNull();
    await settle();
    expect(server.logins()).toHaveLength(logins);
    expect(server.voidPosts()).toHaveLength(2);
  });

  it('SII-106. VOID-11 R15/R23: a 200 that arrives after the dialog closed still re-reads page one and says "Invoice 2 voided." while the same store is chosen; one that arrives after a store change re-reads no list and leaves only the card', async () => {
    for (const after of ['closed', 'store changed'] as const) {
      const { server, made, r } = await setup();
      server.issued.set(STORE_2, [invoice(1, { id: uuid(0x2a01), customerName: 'Second store 1' })]);
      await openConfirm(2);
      server.hold.void = 1;
      await pressWith('issued_in_error');
      await waitFor(() => expect(server.held).toHaveLength(1));
      if (after === 'closed') await closeAll();
      else {
        fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } }); // the page behind is inert to a user; a change still reaches it
        await listReady();
      }
      expect(screen.queryByTestId('issued-view')).toBeNull();
      const lists = server.lists(STORE_1).length;
      server.held.shift()!.release();
      await waitFor(() => expect(cardState()).toBe('voided'));
      await settle();
      expect(made[1].void?.reasonCode, after).toBe('issued_in_error');
      if (after === 'closed') {
        expect(server.lists(STORE_1)).toHaveLength(lists + 1);
        await waitFor(() => expect(screen.getAllByTestId('issued-row-status').map((p) => p.textContent)).toEqual(['Issued', 'Voided', 'Issued']));
        expect(tid('issued-notice')).toHaveTextContent(VOID_TEXT.voided(2));
      } else {
        expect(server.lists(STORE_1)).toHaveLength(lists);
        expect(screen.queryByTestId('issued-notice')).toBeNull();
        expect(customersShown()).toEqual(['Second store 1']);
      }
      expect(heldA(r)).toMatchObject({ state: 'voided' });
      cleanup();
    }
  });

  it('SII-107. AC-11 R8: an attached attempt that is out has no control (no Dismiss while sending); Dismiss of an unresolved one only stops tracking — said, nothing sent, focus to the heading; no key, body, token or tenant reaches the DOM, storage, the address or a log, and the void sources use none of them', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const href = window.location.href;
    const { server, r } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_seller_details');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(buttons('issued-void-card')).toEqual([]); // sending, attached
    expect(cardStatus()).toBe('Voiding invoice 2 at Main Street on the server…');
    server.held.shift()!.release(chain(503, 'service_unavailable'));
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    for (const secret of [r.keys[0], VBODY('wrong_seller_details'), 'expectedTenant', TENANT_A, 's'.repeat(40)]) expect(document.body.innerHTML).not.toContain(secret);
    // The consequence's design-mandated negation ("It does not refund or record a payment") is the one named exception (F7).
    expect(unvoided(box()!.textContent).split(VOID_TEXT.consequence).join('')).not.toMatch(FORBIDDEN);
    await closeAll();
    expect(unvoided(tid('issued-section').textContent)).not.toMatch(FORBIDDEN);
    const mark = server.sent.length;
    await click('issued-void-dismiss');
    expect(cardState()).toBe('none');
    expect(heldA(r)).toBeUndefined();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    await settle();
    expect(sentFrom(server, mark)).toEqual([]);
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
    expect(setItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    for (const file of ['ServerIssuedInvoices.tsx', 'invoiceVoidHold.ts']) {
      const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|history\.|location\.(href|search|hash)|from '[^']*server\//);
    }
  });

  it('SII-108. AC-10: the confirmation keeps Tab and Shift+Tab inside itself (from Keep invoice round to it again, and from Keep invoice back to "Void invoice"), with the issued dialog behind inert', async () => {
    await setup();
    await openConfirm(2);
    await user().click(tid('issued-void-reason-other'));
    act(() => tid('issued-void-keep').focus());
    const seen: Element[] = [];
    for (let i = 0; i < 12; i++) {
      await user().tab();
      expect(box()!.contains(document.activeElement)).toBe(true);
      seen.push(document.activeElement!);
    }
    expect(seen).toContain(tid('issued-void-send'));
    expect(seen).toContain(tid('issued-void-keep'));
    expect(seen).toContain(tid('issued-void-total-scroll'));
    act(() => tid('issued-void-keep').focus());
    await user().tab({ shift: true });
    expect(document.activeElement).toBe(tid('issued-void-send'));
    expect(tid('issued-view').closest('[inert]')).not.toBeNull();
  });

  it('SII-109. VOID-08 R5: a first send\'s pre-key refusal that comes back after its confirmation was closed (a step-up here) keeps the attempt as refused — "Not voided: …" with Dismiss on the card — and offers no sign-in from the card', async () => {
    const { server, made, r } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('issued-void-keep'); // Close while the POST is out: it is not cancelled
    await waitFor(() => expect(box()).toBeNull());
    const logins = server.logins().length;
    server.held.shift()!.release(chain(403, 'step_up_required'));
    await waitFor(() => expect(cardState()).toBe('refused'));
    expect(heldA(r)).toMatchObject({ state: 'refused', refusal: 'step-up', body: '' });
    expect(tid('issued-void-card-refused')).toHaveTextContent(VOID_REFUSED_TEXT['step-up']);
    expect(buttons('issued-void-card')).toEqual(['Dismiss']);
    expect(screen.queryByTestId('issued-void-reauth-group')).toBeNull();
    await settle();
    expect(server.logins()).toHaveLength(logins);
    expect(made[1].void).toBeUndefined();
  });

  it('SII-110. VOID-11 R12: the settings\' explicit sign-in (renew) adopts a new token, so a void sent under the old one is detached — it can never be checked again under the new session, and nothing is re-sent', async () => {
    const { server, r } = await setup();
    await unresolvedOn(server, r);
    await closeAll();
    await openSettings();
    await panelReady();
    server.puts.push(chain(403, 'step_up_required'));
    await renewBySignIn();
    await waitFor(() => expect(heldA(r)).toMatchObject({ csrf: null, body: '', state: 'unresolved' }));
    expect(cardState()).toBe('detached');
    expect(buttons('issued-void-card')).toEqual(['Check invoice', 'Dismiss']);
    await settle();
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-111. VOID-11 R12: after leaving the page, the FIRST token a remounted section finds being another session\'s (another tab signed in meanwhile) detaches the held void at its Check again — nothing is sent under the new token', async () => {
    const { server, r, page } = await setup();
    await unresolvedOn(server, r);
    await closeAll();
    page.unmount();
    server.otherTab('uid-a');
    render(<ServerIssuedInvoices {...r.props()} />);
    expect(cardState()).toBe('unresolved'); // from memory: no token known yet
    await click('issued-void-check');
    await waitFor(() => expect(heldA(r)).toMatchObject({ csrf: null, body: '' }));
    await settle();
    expect(cardState()).toBe('detached');
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-112. VOID-08 R1: a first send the client itself refuses to send (not-sent: nothing left) is never held or shown as out — the confirmation goes back to its review with "Not sent: …", and no POST reaches the server', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 3);
    const r = rig(server);
    const real = createInvoiceIssuingClient({ fetch: server.fetch });
    const voidInvoice = vi.fn(async (): Promise<VoidResult> => ({ kind: 'not-sent' }));
    render(<ServerIssuedInvoices {...r.props({ issuing: { ...real, voidInvoice } })} />);
    await showAndChoose(STORE_1);
    await listReady();
    await openConfirm(2);
    await pressWith('other');
    await waitFor(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.notSendable));
    expect(voidInvoice).toHaveBeenCalledTimes(1);
    expect(heldA(r)).toBeUndefined();
    expect(tid('issued-void-attempt')).toHaveAttribute('data-state', 'none');
    expect(buttons('issued-void-confirm')).toEqual(['Keep invoice', 'Void invoice']);
    expect(tid('issued-void-keep')).toHaveTextContent(/^Keep invoice$/);
    expect(server.voidPosts()).toEqual([]);
  });

  // ---- Review B1 fix round 1 (reconcile.md F1–F9 and the accepted LOW list) ----

  it('SII-113. Review B1 F1 (sequence A): an attempt for THIS invoice pressed from an earlier open is the dialog\'s too — reopened and reviewed while it is out (the confirmation held "Another void is waiting…"), its validated 200 closes that confirmation, hides the trigger and reads the detail ONCE; no second key is ever sent', async () => {
    const { server, made, r } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await closeAll();
    await openConfirm(2); // reopened and reviewed while K1 is out
    await user().click(tid('issued-void-reason-duplicate'));
    expect(tid('issued-void-send')).toHaveAccessibleDescription(VOID_TEXT.pending);
    const details = server.details().length;
    server.held.shift()!.release(); // K1's validated 200
    await waitFor(() => expect(box()).toBeNull());
    await waitFor(() => expect(tid('issued-view-void-reason')).toHaveTextContent(/^Wrong customer$/));
    expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/);
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    expect(tid('issued-view-void-status')).toHaveTextContent(VOID_TEXT.voided(2));
    await settle();
    expect(server.details()).toHaveLength(details + 1);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-view-close')));
    expect([server.voidPosts().length, r.keys.length]).toEqual([1, 1]);
  });

  it('SII-114. Review B1 F1 (sequence B): a review read answered with the invoice as it was BEFORE this open\'s void committed (it was out when the 200 came) never overwrites the voided detail read after it and never opens a confirmation — the detail reads of one open share one sequence', async () => {
    const { server, made } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('issued-void-keep'); // only the confirmation closes
    await waitFor(() => expect(box()).toBeNull());
    server.hold.detail = 1;
    await click('issued-view-void'); // a review read, out
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['void', 'detail']));
    const before = new Response(JSON.stringify(detailOf(made[1])), { status: 200, headers: { 'content-type': 'application/json' } }); // what it read pre-commit
    server.held.find((h) => h.kind === 'void')!.release();
    await waitFor(() => expect(tid('issued-view-void-reason')).toHaveTextContent(/^Wrong customer$/)); // the post-void read answered
    server.held.find((h) => h.kind === 'detail')!.release(before);
    await settle();
    expect(box()).toBeNull();
    expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/);
    expect(tid('issued-view-void-reason')).toHaveTextContent(/^Wrong customer$/);
    expect(server.voidPosts()).toHaveLength(1);
  });

  const CLOSED = [
    { name: 'an unknown answer (503)', kind: 'unknown' as const },
    { name: 'a step-up (403 step_up_required)', kind: 'step-up' as const },
    { name: 'a standing denial (403, confirmed by the fresh check)', kind: 'denied' as const },
  ];
  it.each(CLOSED)('SII-115. Review B1 F2: after only the confirmation was closed, $name is said in the still-open issued dialog (the card is behind it): out → "…on the server…", unknown → the unresolved sentence and where it is tracked, refused → its refusal; a standing denial also takes the action away', async ({ kind }) => {
    const { server, made, r } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    expect(tid('issued-view-void-status')).toHaveTextContent(`Voiding invoice 2 at Main Street on the server… ${VOID_TEXT.heldOutside}`);
    const held = server.held.shift()!;
    if (kind === 'denied') { server.voidDenied.add('uid-a'); held.release(); } // decided now: 403 forbidden
    else held.release(kind === 'unknown' ? chain(503, 'service_unavailable') : chain(403, 'step_up_required'));
    if (kind === 'unknown') {
      await waitFor(() => expect(tid('issued-view-void-status')).toHaveTextContent(`${UNRESOLVED_2} ${VOID_TEXT.heldOutside}`));
      expect(tid('issued-view-void')).toBeInTheDocument();
    } else if (kind === 'step-up') {
      await waitFor(() => expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_REFUSED_TEXT['step-up']));
      expect(tid('issued-view-void')).toBeInTheDocument();
    } else {
      await waitFor(() => expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.noLongerAllowed));
      expect(screen.queryByTestId('issued-view-void')).toBeNull();
      expect(tid('issued-void-card-refused')).toHaveTextContent(VOID_REFUSED_TEXT.denied); // the check confirmed it
      expect(heldA(r)).toMatchObject({ state: 'refused', refusal: 'denied' });
    }
    expect(made[1].void).toBeUndefined();
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-116. Review B1 F4: a validated 200 that lands during the section\'s Retry-After wait owes page one — the list says the wait over its last known rows, with Try again held until the wait has passed; the countdown reads nothing, and only Try again reads page one (Voided)', async () => {
    const { server } = await setup();
    server.retryAfter = '30';
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await closeAll();
    fakeClock();
    server.detailStatus.push(429); // another read's 429 starts the section's wait
    fireEvent.click(openButton(3));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    const lists = server.lists(STORE_1).length;
    server.held.shift()!.release();
    await until(() => expect(cardState()).toBe('voided'));
    await flush();
    expect(server.lists(STORE_1)).toHaveLength(lists);
    expect(listPhase()).toBe('rate-limited');
    expect(tid('issued-last-known')).toBeInTheDocument();
    expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-notice')).toHaveTextContent(VOID_TEXT.voided(2));
    await advance(31_000);
    await until(() => expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.lists(STORE_1)).toHaveLength(lists); // the countdown reads nothing
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(screen.getAllByTestId('issued-row-status').map((p) => p.textContent)).toEqual(['Issued', 'Voided', 'Issued']));
    expect(server.lists(STORE_1)).toHaveLength(lists + 1);
  });

  it.each([503, 404, 403, 429] as const)('SII-117. Review B1 F8: a review read answered %s says what it is — an outage keeps the invoice and the trigger ("could not be checked"), a 404 "This invoice is no longer available." (the detail READ), a 403 after ONE fresh check the denied state, a 429 the wait with the trigger held — and no confirmation opens', async (status) => {
    const { server, made } = await setup();
    server.retryAfter = '30';
    await openVoidable(2);
    server.detailStatus.push(status);
    await click('issued-view-void');
    if (status === 503) {
      await waitFor(() => expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.reviewFailed));
      expect(tid('issued-view-total')).toHaveTextContent('Total $21.76');
      expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false');
    } else if (status === 404) {
      await waitFor(() => expect(viewPhase()).toBe('not-found'));
      expect(tid('issued-view-state')).toHaveTextContent(VOID_TEXT.gone);
      expect(screen.queryByTestId('issued-view-void')).toBeNull();
    } else if (status === 403) {
      await waitFor(() => expect(viewPhase()).toBe('denied'));
      expect(tid('issued-view-state')).toHaveTextContent(VIEW_TEXT.denied);
      const at = server.sent.map((x) => x.url).lastIndexOf(detailUrl(STORE_1, made[1].id));
      expect(sentFrom(server, at + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    } else {
      await waitFor(() => expect(tid('issued-view-void-alert')).toHaveTextContent('Wait 30 seconds'));
      expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
      expect(tid('issued-view-void')).toHaveAccessibleDescription(VOID_TEXT.reviewWaiting);
    }
    await settle();
    expect(box()).toBeNull();
    expect(server.voidPosts()).toEqual([]);
  });

  it('SII-118. Review B1 F3/F8: a first send\'s sealed already-void whose re-read then fails says "The invoice could not be loaded again right now." with Load again, and the Status says Voided (the sealed answer proves it) with no void time or reason until a read gives them; the confirmation that pressed it keeps its refusal', async () => {
    const { server } = await setup();
    await openConfirm(2);
    server.voids.push(sealed(409, 'invalid_state'));
    server.detailStatus.push(503); // the re-read after the refusal
    await pressWith('duplicate');
    await waitFor(() => expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.afterUnread));
    expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_REFUSED_TEXT['already-void']);
    expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/);
    expect(screen.queryByTestId('issued-view-voided-at')).toBeNull();
    expect(screen.queryByTestId('issued-view-void-reason')).toBeNull();
    expect(tid('issued-view-void-load')).toBeInTheDocument();
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
  });

  it('SII-119. Review B1 F8: a first send\'s 403 whose one fresh session check cannot answer says "Not voided: the server refused this request, and your session could not be checked right now." — the action is NOT taken away (nothing confirmed a denial) and nothing ran, so nothing is held', async () => {
    const { server, r } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('other');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.voidDenied.add('uid-a');
    server.currentStatus.push(503); // the one fresh check
    server.held.shift()!.release(); // decided now: 403 forbidden
    await waitFor(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.refusedUnchecked));
    expect(heldA(r)).toBeUndefined();
    expect(tid('issued-view-void')).toBeInTheDocument();
    expect(buttons('issued-void-confirm')).toEqual(['Close']);
  });

  it('SII-120. Review B1 F8 / truth LOW-4: with no sign-in this page can offer, a step-up says "Not voided: your sign-in is too old to void invoices here." and only "Sign out and sign in again, then void this invoice." — no sign-in control, nothing signed in', async () => {
    const server = seeded();
    server.staleLogins = true;
    issueAt(server, STORE_1, 3);
    const r = rig(server);
    const base = r.props().identity!;
    render(<ServerIssuedInvoices {...r.props({ identity: { ...base, reauthMethod: () => null } })} />);
    await showAndChoose(STORE_1);
    await listReady();
    await openConfirm(2);
    const logins = server.logins().length;
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.stepUpNoMethod);
    expect(tid('issued-void-confirm-alert').textContent).not.toContain('confirm your sign-in');
    expect(tid('issued-void-reauth-explain')).toHaveTextContent(VOID_TEXT.reauthNone);
    expect(screen.queryByTestId('issued-void-reauth-password')).toBeNull();
    expect(screen.queryByTestId('issued-void-reauth-confirm')).toBeNull();
    expect(buttons('issued-void-confirm')).toEqual(['Keep invoice']);
    await settle();
    expect(server.logins()).toHaveLength(logins);
  });

  it.each(['voided', 'missing', 'refused'] as const)('SII-121. Review B1 F8 / R11: after the step-up\'s explicit sign-in, a re-read that finds the invoice %s closes the confirmation and the dialog shows that state — never a press, never a POST', async (found) => {
    const { server, made } = await setup({}, (s) => { s.staleLogins = true; });
    await openConfirm(2);
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    if (found === 'voided') made[1].void = { voidedAt: server.voidAt, reasonCode: 'duplicate' };
    if (found === 'missing') server.issued.set(STORE_1, made.filter((i) => i !== made[1]));
    if (found === 'refused') server.issuedDenied.add('uid-a');
    type('issued-void-reauth-password', 'correct horse');
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect(box()).toBeNull());
    if (found === 'voided') {
      await waitFor(() => expect(tid('issued-view-void-status')).toHaveTextContent(VOID_TEXT.alreadyVoided));
      expect(tid('issued-view-void-reason')).toHaveTextContent(/^Duplicate of another invoice$/);
    } else if (found === 'missing') {
      await waitFor(() => expect(viewPhase()).toBe('not-found'));
      expect(tid('issued-view-state')).toHaveTextContent(VOID_TEXT.gone);
    } else {
      await waitFor(() => expect(viewPhase()).toBe('denied'));
    }
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    await settle();
    expect(server.voidPosts()).toHaveLength(1);
  });

  it.each(['a Check invoice', 'a list read'] as const)('SII-122. Review B1 F8 / iam 5 (R12): a 401 on %s — not a sign-out — ends the session and DETACHES the unconfirmed void: no token, no bytes, never sent again', async (where) => {
    const { server, r } = await setup();
    server.issued.set(STORE_2, [invoice(1, { id: uuid(0x2a01) })]);
    await unresolvedOn(server, r);
    await closeAll();
    if (where === 'a Check invoice') {
      server.detailStatus.push(401);
      await click('issued-void-find');
    } else {
      server.listStatus.push(401);
      fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    }
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(heldA(r)).toMatchObject({ csrf: null, body: '', state: 'unresolved' });
    expect(cardState()).toBe('detached');
    expect(buttons('issued-void-card')).toEqual(['Check invoice', 'Dismiss']);
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-123. Review B1 iam 1: an open whose detail AND eligibility reads are both refused 403 gets ONE fresh session check between them, not two', async () => {
    const { server, made } = await setup();
    server.detailStatus.push(403);
    server.eligStatus.push(403);
    await user().click(openButton(2));
    await waitFor(() => expect(viewPhase()).toBe('denied'));
    await settle();
    const first = server.sent.map((x) => x.url).lastIndexOf(detailUrl(STORE_1, made[1].id));
    expect(sentFrom(server, first)).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`, `GET ${eligUrl(STORE_1, made[1].id)}`, `GET ${TENANT_SESSION_PATHS.current}`]);
    expect(tid('issued-view-void-cell').children).toHaveLength(0); // L-1: the real cell (the invisible copy stays)
  });

  it('SII-124. Review B1 iam 2: a Check invoice whose session check finds another tab\'s token detaches the attempt AND still reads the invoice — under the new session, a new authorized read — instead of saying nothing', async () => {
    const { server, made, r } = await setup();
    await unresolvedOn(server, r);
    await closeAll();
    server.otherTab('uid-a'); // no focus event: the section still holds the first token
    const details = server.details().length;
    await click('issued-void-find');
    await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.seenIssued(2)));
    expect(cardState()).toBe('detached');
    expect(server.details()).toHaveLength(details + 1);
    expect(server.detailRequests().at(-1)!.url).toBe(detailUrl(STORE_1, made[1].id));
    expect(server.detailRequests().at(-1)!.headers.get('x-tmpos-session-csrf')).not.toBe(server.voidPosts()[0].headers.get('x-tmpos-session-csrf'));
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-125. Review B1 iam 3: a first send\'s 403 that no fresh check confirmed (the section had gone when it came back) is refused with the neutral "Not voided: the server refused this request." — never "you can no longer void invoices"', async () => {
    const { server, r, page } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    page.unmount(); // the user left the page while the POST was out
    server.voidDenied.add('uid-a');
    const sent = server.sent.length;
    server.held.shift()!.release(); // decided now: 403 forbidden
    await waitFor(() => expect(heldA(r)?.state).toBe('refused'));
    expect(sentFrom(server, sent)).toEqual([]); // no fresh check was run for it
    render(<ServerIssuedInvoices {...r.props()} />);
    expect(tid('issued-void-card-refused')).toHaveTextContent(VOID_TEXT.refusedPlain);
    expect(tid('issued-void-card-refused').textContent).not.toContain('no longer');
  });

  it('SII-126. Review B1 L2 / R2-1a: while the void\'s own sign-in is out nothing new can be reviewed or sent — "Void invoice…" waits, said, and opens nothing — and once the sign-in completes the dialog still reads the invoice and its eligibility again, though its confirmation was closed meanwhile', async () => {
    const server = seeded();
    server.staleLogins = true;
    const made = issueAt(server, STORE_1, 3);
    const r = rig(server);
    const base = r.props().identity!;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const identity: ShopIdentity = { ...base, reauthenticate: async (uid, password) => { await gate; return base.reauthenticate(uid, password); } };
    render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await showAndChoose(STORE_1);
    await listReady();
    await openConfirm(2);
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    type('issued-void-reauth-password', 'correct horse');
    await click('issued-void-reauth-confirm'); // the sign-in is out
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    // Fix round 2 supersession (R2-1a; was: a second confirmation opened here and its press said "a sign-in is in
    // progress"): no review can start while the sign-in is out — "Void invoice…" waits, said, and opens nothing. The send
    // guard for it stays in sendVoid as a second line.
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-void')).toHaveAccessibleDescription(VOID_TEXT.reviewSignIn);
    const before = server.sent.length;
    await click('issued-view-void');
    await settle();
    expect(box()).toBeNull();
    expect(sentFrom(server, before)).toEqual([]);
    expect(server.voidPosts()).toHaveLength(1);
    const mark = server.sent.length;
    await act(async () => { release(); });
    await waitFor(() => expect(apart(server, mark).sort()).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`, `GET ${eligUrl(STORE_1, made[1].id)}`].sort()));
    expect(server.logins().slice(-1)[0].headers.get('x-tmpos-reauthenticate')).toBe('1');
    expect(tid('issued-view')).toBeInTheDocument();
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-127. Review B1 L3: a press while an earlier send is still out (its attempt detached and dismissed meanwhile) is never a silent no-op — "Another void is waiting to be confirmed." — and nothing is sent', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await focusEvents(); // another token: the dialogs go, the attempt is detached (its POST still out)
    await waitFor(() => expect(cardState()).toBe('detached'));
    await click('issued-void-dismiss');
    expect(cardState()).toBe('none');
    await storesReady();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await listReady();
    await openConfirm(2);
    await pressWith('other');
    await waitFor(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.pending));
    expect(server.voidPosts()).toHaveLength(1);
    server.held.shift()!.release();
    await settle();
  });

  it('SII-128. Review B1 L4 / truth LOW-1: a Check again starts afresh — an earlier Check invoice failure goes, an "issued" observation (perhaps out of date) goes; a "voided" one stays', async () => {
    const { server, made, r } = await setup();
    await unresolvedOn(server, r);
    await closeAll();
    server.detailStatus.push(503);
    await click('issued-void-find');
    await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.checkFailed));
    server.voids.push('lose-before');
    await click('issued-void-check');
    await waitFor(() => expect(tid('issued-void-card-note')).toHaveTextContent(VOID_NOTE_TEXT.noAnswer));
    expect(tid('issued-void-card-seen').textContent).toBe('');
    await click('issued-void-find');
    await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.seenIssued(2)));
    server.voids.push('lose-before');
    await click('issued-void-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    expect(heldA(r)).toMatchObject({ seen: null, seenReason: null });
    expect(tid('issued-void-card-seen').textContent).toBe('');
    made[1].void = { voidedAt: server.voidAt, reasonCode: 'duplicate' };
    await click('issued-void-find');
    await waitFor(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.seenVoided(2)));
    server.voids.push(chain(503, 'service_unavailable'));
    await click('issued-void-check');
    await waitFor(() => expect(tid('issued-void-card-note')).toHaveTextContent(VOID_NOTE_TEXT.answered));
    expect(heldA(r)).toMatchObject({ state: 'unresolved', seen: 'voided', seenReason: 'duplicate' });
    expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.seenVoided(2));
  });

  it('SII-129. Review B1 M3: a late answer to a request sent under a token that has since been replaced and then come back (no sign-out between) speaks for an older generation — its 401 ends no session', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, r } = await setup();
    await openConfirm(2);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    const first = server.cookie; // the session (token A) the POST went with
    server.otherTab('uid-a');
    await focusEvents(); // token B: a new generation, the attempt detached
    await waitFor(() => expect(heldA(r)?.csrf).toBeNull());
    server.cookie = first;
    await focusEvents(); // token A again: yet another generation
    await storesReady();
    server.held.shift()!.release(chain(401, 'unauthenticated')); // the old A request's late 401
    await settle();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready');
    expect(heldA(r)).toMatchObject({ csrf: null, state: 'sending' });
  });

  // ---- Review B1 fix round 2 (reconcile.md "Fix round 2": R2-1, R2-2, R2-3) ----

  /** A rig whose sign-in is stale (the first POST meets step_up_required) and whose provider re-authentication waits for `release`. */
  async function staleSignIn() {
    const server = seeded();
    server.staleLogins = true;
    const made = issueAt(server, STORE_1, 3);
    const r = rig(server);
    const base = r.props().identity!;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const identity: ShopIdentity = { ...base, reauthenticate: async (uid, password) => { await gate; return base.reauthenticate(uid, password); } };
    render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await showAndChoose(STORE_1);
    await listReady();
    await openConfirm(2);
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    type('issued-void-reauth-password', 'correct horse');
    return { server, made, r, release };
  }

  it.each(['voided', 'no longer allowed'] as const)('SII-130. Review B1 R2-1 (the reported sequence): confirmation A meets a step-up, its sign-in is out, A is closed — no confirmation B can be reviewed meanwhile ("Void invoice…" waits, said, opens nothing) — and when the renewal finds the invoice %s, no confirmation is open and nothing is ever sent', async (found) => {
    const { server, made, release } = await staleSignIn();
    await click('issued-void-reauth-confirm'); // the sign-in is out
    await click('issued-void-keep'); // A closed
    await waitFor(() => expect(box()).toBeNull());
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-void')).toHaveAccessibleDescription(VOID_TEXT.reviewSignIn);
    const before = server.sent.length;
    await click('issued-view-void'); // B: refused while the sign-in is out
    await settle();
    expect(box()).toBeNull();
    expect(sentFrom(server, before)).toEqual([]);
    if (found === 'voided') made[1].void = { voidedAt: server.voidAt, reasonCode: 'duplicate' };
    else server.voidDenied.add('uid-a');
    await act(async () => { release(); });
    if (found === 'voided') await waitFor(() => expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/));
    else await waitFor(() => expect(server.eligReads()).toHaveLength(2));
    await settle();
    expect(box()).toBeNull();
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    expect(server.voidPosts()).toHaveLength(1);
  });

  /**
   * The exported dialog over a stub capability (review B1 R2-1c/R3): the dialog's own layers, each alone — the section is
   * not there, so `ctl` plays its generation, its sign-in and its held attempt; reads and eligibility can be held.
   */
  async function stubbed(send: (press: VoidPress) => Promise<VoidSendOutcome | null>, signIn: IssuedVoidCapability['signIn'] = async () => null, generation = 1) {
    const server = seeded();
    const made = issueAt(server, STORE_1, 1);
    const session = createTenantSessionClient({ fetch: server.fetch });
    const issuing = createInvoiceIssuingClient({ fetch: server.fetch });
    const s = await session.ensure('uid-a', async () => 'tok-a');
    if (s.kind !== 'ok') throw new Error('no session');
    const got = await issuing.getIssued(STORE_1, made[0].id, s.csrf);
    if (got.kind !== 'ok') throw new Error('no invoice');
    const voidedInvoice = { ...got.invoice, status: 'voided', void: { voidedAt: '2026-10-17T08:30:05.000001Z', reasonCode: 'duplicate' } } as IssuedInvoice;
    const ctl = { generation, held: undefined as HeldVoid | undefined, holdReads: false, holdElig: false, answerVoided: false };
    const reads: Array<() => void> = [];
    const eligs: Array<(answer: 'allowed' | 'not' | null) => void> = [];
    const read = vi.fn(async (): Promise<IssuedReadAnswer | null> => {
      const now = (): IssuedReadAnswer => ({ kind: 'ok', invoice: ctl.answerVoided ? voidedInvoice : got.invoice });
      if (!ctl.holdReads) return now();
      return new Promise((done) => { reads.push(() => done(now())); });
    });
    const eligibility = vi.fn(async (): Promise<'allowed' | 'not' | null> => (ctl.holdElig ? new Promise((done) => { eligs.push(done); }) : 'allowed'));
    const capability = (): IssuedVoidCapability => ({
      store: store(STORE_1, 'Main Street'), held: ctl.held, expired: false, cooling: false, finding: false, checkText: '', confirmedDenial: null,
      reauthMethod: () => 'password', signingIn: false, generation: () => ctl.generation, eligibility, send, check: vi.fn(), find: vi.fn(), signIn,
    });
    const dialog = () => <IssuedInvoiceDialog storeId={STORE_1} invoiceId={made[0].id} read={read} current={() => true} waiting={false} onClose={() => {}} returnFocus={{ current: null }} voiding={capability()} />;
    const page = render(dialog());
    await viewReady(1);
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
    return { made, ctl, read, eligibility, reads, eligs, rerender: () => page.rerender(dialog()), heldOf: (over: Partial<HeldVoid>): HeldVoid => ({
      key: 'k1', body: '', storeId: STORE_1, storeLabel: 'Main Street', invoiceId: made[0].id, number: 1, csrf: 'c', sentAt: 0, sentWall: 0,
      state: 'sending', note: '', refusal: null, seen: null, seenReason: null, retryable: true, ...over,
    }) };
  }

  it('SII-131. Review B1 R2-1c (+ R3-1b): a confirmation reviewed under an earlier session generation can never send — pressed after the generation changed it closes with "Not sent: this invoice was reviewed before the session changed…" and the send is never asked for, the action then waits (its eligibility is from the older generation); under a generation whose eligibility was read, the section\'s own final guard answering "stale" closes it the same way', async () => {
    const send = vi.fn(async (_press: VoidPress): Promise<VoidSendOutcome | null> => ({ kind: 'stale' }));
    const h = await stubbed(send);
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    await user().click(tid('issued-void-reason-other'));
    h.ctl.generation = 2; // the session was replaced after this review
    await click('issued-void-send');
    await waitFor(() => expect(box()).toBeNull());
    expect(send).not.toHaveBeenCalled();
    expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.staleReview);
    // Fix round 3 supersession (was: a review straight away under generation 2): the eligibility was read under generation 1,
    // so it is not known again — the action waits, said as checking, and opens nothing (R3-1b).
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-void')).toHaveAccessibleDescription(VOID_TEXT.reviewing);
    cleanup();
    await stubbed(send, undefined, 2); // opened under generation 2: its eligibility is read under it
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    await user().click(tid('issued-void-reason-other'));
    await click('issued-void-send');
    await waitFor(() => expect(box()).toBeNull());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ reviewGen: 2, reasonCode: 'other' });
    expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.staleReview);
  });

  it('SII-132. Review B1 R2-1b / R3-1 (no longer allowed): A closed while the renewal\'s eligibility read is out — "Void invoice…" stays held (checking) and pressing it reviews nothing, so no B exists and nothing can be sent; the eligibility then says no longer allowed: the action goes; one POST, one key in all', async () => {
    const { server, r, release } = await staleSignIn();
    server.hold.elig = 1; // the renewal's eligibility read
    await act(async () => { release(); });
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    await click('issued-void-keep'); // A closed
    await waitFor(() => expect(box()).toBeNull());
    // Fix round 3 supersession (was: B reviewed here under the new session, then closed by the late refusal): no review can
    // start before the renewal's reads are applied (R3-1a), and the older generation's "allowed" counts for nothing (R3-1b).
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-void')).toHaveAccessibleDescription(VOID_TEXT.reviewing);
    const before = server.sent.length;
    await click('issued-view-void');
    await settle();
    expect(box()).toBeNull();
    expect(sentFrom(server, before)).toEqual([]);
    server.voidDenied.add('uid-a');
    server.held.shift()!.release(); // decided now: not allowed
    await waitFor(() => expect(screen.queryByTestId('issued-view-void')).toBeNull());
    expect(box()).toBeNull();
    expect([server.voidPosts().length, r.keys.length]).toEqual([1, 1]);
  });

  it('SII-133. Review B1 R2-2: the renewal\'s detail answer is applied only if no newer detail read started — it answered Issued while its eligibility was out, this open\'s attempt then settled voided and its re-read answered Voided; when the eligibility finishes, Voided and its recorded reason stay and no action comes back', async () => {
    // Fix round 3 supersession (was: the newer read was a review, which R3-1a now holds back during the renewal): the newer
    // detail read is the post-void re-read of this open's attempt, which no hold stops. Over the stub capability.
    const send = vi.fn(async (press: VoidPress): Promise<VoidSendOutcome | null> => { press.held('k1'); return { kind: 'step-up', method: 'password' }; });
    const h = await stubbed(send, async () => ({ kind: 'renewed' }));
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    h.ctl.holdElig = true; // the renewal's eligibility read, held; its detail read answers Issued
    type('issued-void-reauth-password', 'correct horse');
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect(h.eligs).toHaveLength(1));
    await click('issued-void-keep');
    h.ctl.answerVoided = true;
    h.ctl.held = h.heldOf({ state: 'voided' }); // this open's attempt (k1) settled voided: its one re-read
    h.rerender();
    await waitFor(() => expect(tid('issued-view-void-reason')).toHaveTextContent(/^Duplicate of another invoice$/));
    await act(async () => { h.eligs.shift()!('allowed'); });
    await settle();
    expect(tid('issued-view-status')).toHaveTextContent(/^Voided$/);
    expect(tid('issued-view-void-reason')).toHaveTextContent(/^Duplicate of another invoice$/);
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    expect(box()).toBeNull();
  });

  it('SII-134. Review B1 R2-3: an owed page one outlives an older list read — page one was out, another request\'s 429 started the wait, the void\'s 200 owed page one, then the older read answered Issued: the list stays "wait" with Try again held; the countdown reads nothing; only Try again reads page one (Voided)', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 25);
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    server.retryAfter = '30';
    const target = made.find((i) => i.number === 24)!;
    await openConfirm(24);
    server.hold.void = 1;
    await pressWith('wrong_customer');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await closeAll();
    server.listStatus.push(503);
    await click('issued-load-more');
    await waitFor(() => expect(listPhase()).toBe('unavailable')); // rows kept as last known, with Try again
    const sorted = [...made].sort((a, b) => b.number - a.number);
    const older = new Response(JSON.stringify({ invoices: sorted.slice(0, 20).map(summaryOf), nextCursor: cursorOf(sorted[19].id) }), { status: 200, headers: { 'content-type': 'application/json' } });
    server.hold.list = 1;
    await click('issued-list-retry'); // page one, out
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['void', 'list']));
    fakeClock();
    server.getStatus.push(429);
    fireEvent.click(tid('issued-settings-open')); // another request's 429 starts the section's wait
    await until(() => expect(panelPhase()).toBe('rate-limited'));
    server.held.find((h) => h.kind === 'void')!.release(); // the void's 200: page one is owed
    await until(() => expect(cardState()).toBe('voided'));
    expect(listPhase()).toBe('rate-limited');
    server.held.find((h) => h.kind === 'list')!.release(older); // the older read answers Issued
    await flush();
    await flush();
    expect(listPhase()).toBe('rate-limited');
    expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'true');
    const lists = server.lists(STORE_1).length;
    await advance(31_000);
    await until(() => expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.lists(STORE_1)).toHaveLength(lists); // the countdown reads nothing
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(within(screen.getAllByTestId('issued-row').find((li) => li.getAttribute('data-id') === target.id)!).getByTestId('issued-row-status')).toHaveTextContent('Voided'));
    expect(server.lists(STORE_1)).toHaveLength(lists + 1);
  });

  // ---- Review B1 fix round 3 (reconcile.md "Fix round 3": R3-1a/b, R3-2, R3-3) ----

  it('SII-135. Review B1 R3-1 (the reported sequence, still allowed): step-up, sign-in done, the renewal\'s detail answered Issued and its eligibility HELD, A closed — "Void invoice…" stays held and reviews nothing; once the eligibility answers allowed under the new session the action comes back, and only a new review and a new press send — a NEW key under the NEW token', async () => {
    const { server, made, r, release } = await staleSignIn();
    server.hold.elig = 1;
    await act(async () => { release(); });
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['elig']));
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    const before = server.sent.length;
    await click('issued-view-void');
    await settle();
    expect([box(), sentFrom(server, before)]).toEqual([null, []]);
    server.held.shift()!.release(); // allowed, under the new session
    await waitFor(() => expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false'));
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    await pressWith('duplicate');
    await waitFor(() => expect(server.voidPosts()).toHaveLength(2));
    await waitFor(() => expect(made[1].void?.reasonCode).toBe('duplicate'));
    const [first, second] = server.voidPosts();
    expect(r.keys).toHaveLength(2);
    expect(second.headers.get('idempotency-key')).toBe(r.keys[1]);
    expect(second.headers.get('x-tmpos-session-csrf')).not.toBe(first.headers.get('x-tmpos-session-csrf'));
  });

  it('SII-136. Review B1 R3-1b: an eligibility "allowed" read under an older generation counts as not yet known — the action is held with the checking reason (never said as not allowed) and reviews nothing; and a send whose generation moved meanwhile is told the action is not allowed now (press.allowed())', async () => {
    const seen: boolean[] = [];
    const h = await stubbed(async (press) => {
      h.ctl.generation = 2; // the generation moved while the press was being checked
      seen.push(press.allowed());
      return { kind: 'sent' };
    });
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    await pressWith('other');
    await waitFor(() => expect(seen).toEqual([false]));
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    h.rerender();
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-void')).toHaveAccessibleDescription(VOID_TEXT.reviewing);
    expect(tid('issued-view-void-alert').textContent).not.toContain('no longer');
    const reads = h.read.mock.calls.length;
    await click('issued-view-void');
    await settle();
    expect(box()).toBeNull();
    expect(h.read.mock.calls.length).toBe(reads);
  });

  it('SII-137. Review B1 R3-1a: the renewal itself holds the action — signed in again with NO generation change, its detail and eligibility reads out, A closed: "Void invoice…" is held (checking) and reviews nothing until both reads are applied; then it comes back', async () => {
    const h = await stubbed(async () => ({ kind: 'step-up', method: 'password' }), async () => ({ kind: 'renewed' }));
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    h.ctl.holdReads = true;
    h.ctl.holdElig = true;
    type('issued-void-reauth-password', 'correct horse');
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect([h.reads.length, h.eligs.length]).toEqual([1, 1]));
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-void')).toHaveAccessibleDescription(VOID_TEXT.reviewing);
    const reads = h.read.mock.calls.length;
    await click('issued-view-void');
    await settle();
    expect([box(), h.read.mock.calls.length]).toEqual([null, reads]);
    h.ctl.holdReads = false;
    h.ctl.holdElig = false;
    await act(async () => { h.reads.shift()!(); h.eligs.shift()!('allowed'); });
    await waitFor(() => expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false'));
  });

  it('SII-138. Review B1 R3-3: a review read answered after the generation changed is dropped AND said — "Not sent: this invoice was reviewed before the session changed…" — and no confirmation opens', async () => {
    const send = vi.fn(async (): Promise<VoidSendOutcome | null> => ({ kind: 'sent' }));
    const h = await stubbed(send);
    h.ctl.holdReads = true;
    await click('issued-view-void');
    await waitFor(() => expect(h.reads).toHaveLength(1));
    h.ctl.generation = 2;
    await act(async () => { h.reads.shift()!(); });
    await waitFor(() => expect(tid('issued-view-void-alert')).toHaveTextContent(VOID_TEXT.staleReview));
    expect(box()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  // ---- Review B1 fix round 4 (reconcile.md "Fix round 4": R4-1) ----

  it('SII-139. Review B1 R4-1: a renewal whose eligibility read answers nothing (aborted, failed or superseded) leaves no Void action in this open — absent, not held for good on the older generation\'s "allowed" and never said as not allowed — and the confirmation says it could not check; nothing more is sent', async () => {
    const send = vi.fn(async (): Promise<VoidSendOutcome | null> => ({ kind: 'step-up', method: 'password' }));
    let h!: Awaited<ReturnType<typeof stubbed>>;
    h = await stubbed(send, async () => { h.ctl.generation = 2; return { kind: 'renewed' }; }); // the renewal's new generation
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    h.ctl.holdElig = true;
    type('issued-void-reauth-password', 'correct horse');
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect(h.eligs).toHaveLength(1));
    await act(async () => { h.eligs.shift()!(null); }); // the renewal's eligibility: no answer
    await waitFor(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.renewUnread));
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    h.rerender();
    expect(screen.queryByTestId('issued-view-void')).toBeNull();
    expect(tid('issued-view-void-cell').children).toHaveLength(0); // L-1: the real cell (the invisible copy stays)
    expect(tid('issued-view-void-alert').textContent).not.toContain('no longer');
    expect(send).toHaveBeenCalledTimes(1);
  });

  // ---- Review B1 layout round (reconcile.md "Layout round": L-1, L-2; layout itself is measured in the browser, B2) ----

  it('SII-140. Review B1 L-1/L-2 (structure only): the void row\'s invisible copy of the trigger is there in every state of an open — while asking, offered, not offered (voided) — hidden (aria-hidden, invisible), with nothing focusable and nothing in the role tree, so Tab never reaches it; the confirmation\'s issue date and clock are no-wrap tokens', async () => {
    const { server, made } = await setup();
    made[1].void = { voidedAt: server.voidAt, reasonCode: 'duplicate' };
    const copyIsHidden = () => {
      const placeholder = within(tid('issued-view-void-row')).getByTestId('issued-view-void-placeholder');
      expect(placeholder).toHaveAttribute('aria-hidden', 'true');
      expect(placeholder).toHaveClass('invisible');
      expect(placeholder.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')).toHaveLength(0);
      expect(placeholder.textContent).toBe(''); // generated content only: the DOM says nothing
      expect(within(placeholder).queryAllByRole('button', { hidden: true })).toEqual([]);
    };
    server.hold.elig = 1;
    await user().click(openButton(3));
    await viewReady(3);
    copyIsHidden(); // asking
    server.held.shift()!.release();
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
    copyIsHidden(); // offered: the copy stays under the real trigger
    expect(within(tid('issued-view')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close', VOID_TEXT.open]);
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    expect([...tid('issued-void-issued-at').querySelectorAll('span.whitespace-nowrap')].map((t) => t.textContent)).toEqual(['2026-10-16', '21:00:03']);
    expect(tid('issued-void-issued-at').textContent).toBe('2026-10-16 21:00:03 UTC');
    await closeAll();
    await user().click(openButton(2)); // voided: not offered
    await viewReady(2);
    await settle();
    copyIsHidden();
    expect(tid('issued-view-void-cell').children).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-view-close'))); // the dialog's first focus (an effect)
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-lines-scroll'));
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-close')); // Close, the lines region, Close: the copy is no stop
  });
});

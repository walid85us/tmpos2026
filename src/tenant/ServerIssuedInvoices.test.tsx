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
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StrictMode } from 'react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ISSUED_TEXT, IssuedInvoiceDialog, LIST_TEXT, PAYMENTS_TEXT, SETTINGS_RULE_TEXT, SETTINGS_TEXT, ServerIssuedInvoices, VIEW_TEXT, VOID_REFUSED_TEXT, VOID_SIGNIN_WAIT_MS, VOID_TEXT, type IssuedPaymentsCapability, type IssuedVoidCapability, type IssuedReadAnswer, type PaymentsReadAnswer, type ServerIssuedInvoicesProps, type VoidPress, type VoidSendOutcome } from './ServerIssuedInvoices';
import { INVOICE_VOID_REASONS, VOID_REASON_CODES, createInvoiceIssuingClient, issuingSettingsPathOf, type InvoiceVoidReasonCode, type IssuedInvoice, type IssuedSummary, type VoidResult } from './invoiceIssuingClient';
import { STORES_PATH, createInvoiceDraftsClient, type StoreEntry } from './invoiceDraftsClient';
import { RECORD_ID_TEXT } from './ServerInvoiceDrafts';
import { TENANT_SESSION_PATHS, createTenantSessionClient, sessionEndsSoFar } from './tenantSessionClient';
import { VOID_NOTE_TEXT, createVoidHoldStore, isLiveVoid, settleVoid, voidExpired, voidHolds, type HeldVoid, type VoidHoldStore, type VoidRefusal } from './invoiceVoidHold';
import type { ShopIdentity } from './ServerCustomerLevels';
import { createPaymentHoldStore, judgePayment, type HeldPayment, type PaymentHoldStore } from './invoicePaymentHold';
import { idEndingText, pickerWaitText } from './ServerCustomerPicker';
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
type Kind = 'stores' | 'settings' | 'put' | 'current' | 'list' | 'detail' | 'elig' | 'void' | 'payments' | 'payElig' | 'register' | 'proof' | 'record' | 'settle' | 'attempts';
type TaxWire = { mode: 'none' } | { mode: 'exclusive_rate'; rateMilliPercent: number };
type LineWire = { position: number; description: string; quantity: number; unitPriceCents: number; lineTotalCents: number };
/** One issued invoice as the fake stores it (commit B): what the list summarizes and the detail answers. */
interface Issued {
  id: string; number: number; sourceDraftId: string; customerId: string; customerName: string; issuedAt: string;
  seller: { legalName: string; storeName: string; postalAddress: string; taxRegistrationId: string | null }; lines: LineWire[]; tax: TaxWire;
  /** M7B-INVOICES-VOID-P1: present once voided (the detail's `void` member, the rows' status "voided"); absent, the 034 answer byte for byte. */
  void?: { voidedAt: string; reasonCode: string };
}
/** One recorded payment as the payments read writes it (M7B-PAYMENTS-P2A). */
type PaymentWire = { id: string; attemptId: string; amountCents: number; method: string; recordedAt: string; reversal: { reversedAt: string; reasonCode: string } | null };
/** What the next PUTs do: lose the answer after deciding (committed), lose the request, answer a status in the chain's envelope, or a whole answer. */
type PutScript = 'lose' | 'lose-before' | number | Response;
type PayScript = PutScript | 'commit-404';

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
    hold: { stores: 0, settings: 0, put: 0, current: 0, list: 0, detail: 0, elig: 0, void: 0, payments: 0, payElig: 0, register: 0, proof: 0, record: 0, settle: 0, attempts: 0 } as Record<Kind, number>,
    // M7B-PAYMENTS-P2A: the payments read as server/runtime/invoicePayments.ts answers it — the amounts and word over the
    // whole history (due the Total while issued, 0 once voided), pages of 50 oldest first, the cursor the last id of a full page.
    payments: new Map<string, PaymentWire[]>(), // invoice -> its payments, oldest first
    paymentsStatus: [] as Array<number | Response>, // what the next payments GETs answer instead
    /** The payments reads that reached the fake (path and query). */
    paymentReads(): string[] { return server.sent.filter((r) => r.method === 'GET' && /\/invoices\/[^/]+\/payments(\?|$)/.test(r.url)).map((r) => r.url); },
    // M7B-INVOICES-VOID-P2: the void command and its action-only eligibility, as P1's server answers them.
    voids: [] as PutScript[], // what the next void POSTs do (as `puts`)
    eligStatus: [] as Array<number | Response>, // what the next void-eligibility GETs answer instead
    voidDenied: new Set<string>(), // users whose stored levels lack void_issued_invoices (Invoices Approve with Customers View)
    voidAt: '2026-10-17T08:30:05.000001Z', // the database clock's void time
    /** Void bodies whose keys were not exactly expectedTenant, reasonCode in that order (a throw here would read as transport loss). */
    voidBodyViolations: [] as string[],
    // M7B-PAYMENTS-P2B: the caller's registrations (the attempts read's rows, oldest first), what the next recording
    // requests do (as `puts`; the proof's 'lose' loses its answer), and who lacks record_invoice_payments.
    regs: [] as Array<{ id: string; uid: string; storeId: string; invoiceId: string; number: number; attemptId: string; csrf: string; state: 'open' | 'recorded' | 'withdrawn' | 'confirmed'; registeredAt: string; settledAt: string | null; payment: PaymentWire | null; proof?: string }>,
    // 'commit-404' (record only, R1 T6): decide — the payment commits — then answer the chain's 404 (037 checks the scope first).
    payScripts: { register: [] as PayScript[], proof: [] as PayScript[], record: [] as PayScript[], settle: [] as PayScript[] },
    payEligStatus: [] as Array<number | Response>,
    attemptsStatus: [] as Array<number | Response>,
    attemptsPage: 50,
    /** Who holds record_invoice_payments (opt-in, so the older describes see no Record control): the P2B tests add 'uid-a'. */
    recorders: new Set<string>(),
    payBodyViolations: [] as string[],
    /** The registration's proof (037: an HMAC of the registration and its session): 64 hex, per registration and session. */
    /** The registration's proof: random per registration (R2 U4: not derivable from anything the client sees), '' for a seeded row. */
    proofOf(g: { proof?: string }): string { return g.proof ?? ''; },
    /** A fresh random proof for a seeded row (R3-9): never empty, never derivable. */
    newProof(): string { return randomBytes(32).toString('hex'); },
    mayRecord(user: User, storeId: string): boolean {
      const entry = server.stores[user.uid]?.find((s) => s.id === storeId);
      return entry !== undefined && !entry.readOnly && user.role === 'owner' && server.recorders.has(user.uid);
    },
    /** The recording requests that reached the fake, as sent: `${METHOD} ${route}` names below. */
    payRequests(route?: 'payment-eligibility' | 'payment-registrations' | 'payment-registration-proof' | 'payments' | 'payment-settlement' | 'payment-attempts'): Sent[] {
      return server.sent.filter((r) => (r.method === 'POST' && /\/(payment-registrations|payments|payment-settlement)$/.test(r.url))
        || (r.method === 'GET' && /\/(payment-eligibility|payment-registration-proof\?|payment-attempts)/.test(r.url)))
        .filter((r) => route === undefined || (route === 'payments' ? r.method === 'POST' && r.url.endsWith('/payments') : r.url.includes(`/${route}`) && (route !== 'payment-registrations' || r.url.endsWith(route))));
    },
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
      const paymentsPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\/([0-9a-f-]{36})\/payments(?:\?after=([0-9a-f-]{36}))?$/.exec(url);
      if (method === 'GET' && paymentsPath !== null) {
        return server.maybeHold('payments', url, () => {
          const refused = gate();
          if (refused !== null) return refused;
          const scripted = server.paymentsStatus.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          const [, storeId, invoiceId, after] = paymentsPath;
          if (server.issuedDenied.has(session!.user.uid) || !server.stores[session!.user.uid]?.some((s) => s.id === storeId)) return refuse(403, 'forbidden');
          const found = server.issued.get(storeId)?.find((i) => i.id === invoiceId);
          if (found === undefined) return refuse(404, 'not_found');
          const answer = paymentsOf(found, server.payments.get(invoiceId) ?? [], after ?? null);
          return answer === null ? refuse(400, 'invalid_request') : reply(200, answer); // a cursor that is not a payment of this invoice
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
      // M7B-PAYMENTS-P2B: recording as server/runtime/invoicePayments.ts and 037 answer it — register (session-bound key),
      // the proof (same session, open only), the record (the whole scope then the sealed states), the settlement (not
      // session-bound), the caller's own attempts and the action-only eligibility.
      const payRoute = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\/([0-9a-f-]{36})\/(payment-eligibility|payment-registrations|payment-registration-proof|payments|payment-settlement)(?:\?registration=([0-9a-f-]{36}))?$/.exec(url);
      const attemptsRoute = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/payment-attempts(?:\?after=([0-9a-f-]{36})\.([0-9a-f-]{36}))?$/.exec(url);
      if (attemptsRoute !== null && method === 'GET') {
        return server.maybeHold('attempts', url, () => {
          const refused = gate();
          if (refused !== null) return refused;
          const scripted = server.attemptsStatus.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          if (!server.mayRecord(session!.user, attemptsRoute[1])) return refuse(403, 'forbidden');
          const own = server.regs.filter((g) => g.uid === session!.user.uid && g.storeId === attemptsRoute[1]);
          const start = attemptsRoute[2] === undefined ? 0 : own.findIndex((g) => g.invoiceId === attemptsRoute[2] && g.attemptId === attemptsRoute[3]) + 1;
          if (start === 0 && attemptsRoute[2] !== undefined) return refuse(400, 'invalid_request');
          const page = own.slice(start, start + server.attemptsPage);
          const last = page[page.length - 1];
          return reply(200, {
            attempts: page.map((g) => ({
              invoiceId: g.invoiceId, invoiceNumber: g.number, attemptId: g.attemptId, state: g.state, version: g.state === 'open' ? 1 : g.state === 'recorded' ? 2 : 3,
              registeredAt: g.registeredAt, settledAt: g.settledAt,
              payment: g.payment === null ? null : { id: g.payment.id, amountCents: g.payment.amountCents, method: g.payment.method, recordedAt: g.payment.recordedAt, reversal: null },
            })),
            nextCursor: start + server.attemptsPage < own.length && last !== undefined ? `${last.invoiceId}.${last.attemptId}` : null,
          });
        });
      }
      if (payRoute !== null && (method === 'GET' ? ['payment-eligibility', 'payment-registration-proof'].includes(payRoute[3]) : payRoute[3] !== 'payment-eligibility')) {
        const [, storeId, invoiceId, route, registration] = payRoute;
        const kind: Kind = route === 'payment-eligibility' ? 'payElig' : route === 'payment-registrations' ? 'register' : route === 'payment-registration-proof' ? 'proof' : route === 'payments' ? 'record' : 'settle';
        if (method === 'GET' && route === 'payment-eligibility') {
          return server.maybeHold('payElig', url, () => {
            const refused = gate();
            if (refused !== null) return refused;
            const scripted = server.payEligStatus.shift();
            if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
            return server.mayRecord(session!.user, storeId) ? reply(200, { eligibility: 'allowed' }) : refuse(403, 'forbidden');
          });
        }
        const script = server.payScripts[kind as 'register' | 'proof' | 'record' | 'settle'].shift();
        if (script === 'lose-before') throw new TypeError('network');
        // The chain first (R1 T11): a scripted answer replaces only what comes after the session, CSRF and authority.
        const chain = (): Response | null => {
          const refused = gate();
          if (refused !== null) return refused;
          if (method === 'POST' && headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
          return server.mayRecord(session!.user, storeId) ? null : refuse(403, 'forbidden');
        };
        if (typeof script === 'number') return chain() ?? refuse(script);
        if (script instanceof Response) return chain() ?? script;
        const decide = (): Response => {
          const refused = chain();
          if (refused !== null) return refused;
          const uid = session!.user.uid;
          const found = server.issued.get(storeId)?.find((i) => i.id === invoiceId);
          if (kind === 'proof') {
            const g = server.regs.find((r) => r.id === registration && r.uid === uid && r.invoiceId === invoiceId && r.state === 'open' && r.csrf === session!.csrf);
            return g === undefined ? refuse(404, 'not_found') : reply(200, { registration: { id: g.id, invoiceId, attemptId: g.attemptId }, proof: server.proofOf(g) });
          }
          const key = headers.get('idempotency-key') ?? '';
          const bound = kind === 'register' || kind === 'record' ? session!.csrf : '';
          const fingerprint = `${uid}\n${kind}\n${storeId}\n${invoiceId}\n${bound}\n${body}`;
          const known = server.keys.get(key);
          if (known !== undefined && known.fingerprint !== fingerprint) return refuse(422, 'idempotency_key_reused');
          if (known !== undefined) return reply(known.status, known.body, { 'idempotent-replayed': 'true' });
          const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
          const order = { register: 'expectedTenant,attemptId', record: 'expectedTenant,registrationId,attemptId,amountCents,method,registrationProof', settle: 'expectedTenant,attemptId,expectedVersion' }[kind as 'register'];
          if (Object.keys(parsed).join(',') !== order) server.payBodyViolations.push(kind);
          const entry = server.stores[uid]?.find((s) => s.id === storeId);
          if (entry === undefined || parsed.expectedTenant !== entry.tenantId) return refuse(409, 'write_conflict');
          if (found === undefined) return refuse(404, 'not_found');
          const seal = (status: number, sealed: unknown): Response => { server.keys.set(key, { fingerprint, status, body: sealed }); return reply(status, sealed); };
          const mine = server.regs.filter((r) => r.uid === uid && r.invoiceId === invoiceId);
          const own = mine.find((r) => r.attemptId === parsed.attemptId);
          if (kind === 'register') {
            if (own?.state === 'recorded') return seal(409, { error: 'already_recorded' });
            if (mine.some((r) => r.state === 'open' || r.state === 'recorded')) return seal(409, { error: 'write_conflict' });
            if (own !== undefined || found.void !== undefined) return seal(409, { error: 'invalid_state' });
            const g = {
              id: uuid(0x4e00 + server.regs.length + 1), uid, storeId, invoiceId, number: found.number, attemptId: parsed.attemptId as string, csrf: session!.csrf,
              state: 'open' as 'open' | 'recorded' | 'withdrawn' | 'confirmed', registeredAt: `2026-10-17T10:00:${String(server.regs.length).padStart(2, '0')}.000001Z`,
              settledAt: null as string | null, payment: null as PaymentWire | null, proof: randomBytes(32).toString('hex'),
            };
            server.regs.push(g);
            return seal(201, { registration: { id: g.id, invoiceId, attemptId: g.attemptId, state: 'open' } });
          }
          if (kind === 'record') {
            if (own === undefined || own.id !== parsed.registrationId || own.csrf !== session!.csrf || parsed.registrationProof !== server.proofOf(own)) return refuse(404, 'not_found');
            if (own.state === 'recorded' || own.state === 'confirmed') return seal(409, { error: 'already_recorded' });
            if (own.state === 'withdrawn' || found.void !== undefined) return seal(409, { error: 'invalid_state' });
            const all = server.payments.get(invoiceId) ?? [];
            const due = amountsFor(subtotalOf(found), found.tax).totalCents;
            const applied = all.reduce((n, p) => n + (p.reversal === null ? p.amountCents : 0), 0);
            if (applied + (parsed.amountCents as number) > due) return seal(409, { error: 'amount_exceeds_remaining' });
            const p: PaymentWire = { id: uuid(0x9e00 + all.length + 1), attemptId: own.attemptId, amountCents: parsed.amountCents as number, method: parsed.method as string, recordedAt: `2026-10-17T11:00:${String(all.length).padStart(2, '0')}.000001Z`, reversal: null };
            server.payments.set(invoiceId, [...all, p]);
            own.state = 'recorded';
            own.payment = p;
            return seal(201, { payment: { id: p.id, invoiceId, attemptId: own.attemptId, amountCents: p.amountCents, method: p.method } });
          }
          if (own === undefined) return refuse(404, 'not_found');
          const want = parsed.expectedVersion === 1 ? 'withdrawn' : 'confirmed';
          if (own.state === want) return seal(200, { settlement: { invoiceId, attemptId: own.attemptId, state: want } });
          if ((want === 'withdrawn' && own.state !== 'open') || (want === 'confirmed' && own.state !== 'recorded')) return seal(409, { error: 'write_conflict' });
          own.state = want;
          own.settledAt = '2026-10-17T12:00:00.000001Z';
          return seal(200, { settlement: { invoiceId, attemptId: own.attemptId, state: want } });
        };
        if (script === 'lose') { decide(); throw new TypeError('network'); } // committed, but the answer is lost
        if (script === 'commit-404') { decide(); return refuse(404, 'not_found'); } // committed, answered as a scope miss
        return server.maybeHold(kind, url, decide);
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
/** The payments read's 200 for `i` with `all` its payments (oldest first), the page after `after`; null for an unknown cursor. */
function paymentsOf(i: Issued, all: PaymentWire[], after: string | null) {
  const start = after === null ? 0 : all.findIndex((p) => p.id === after) + 1;
  if (start === 0 && after !== null) return null;
  const voided = i.void !== undefined;
  const due = voided ? 0 : amountsFor(subtotalOf(i), i.tax).totalCents;
  const applied = voided ? 0 : all.reduce((n, p) => n + (p.reversal === null ? p.amountCents : 0), 0);
  const page = all.slice(start, start + 50);
  return {
    invoice: { id: i.id, status: voided ? 'voided' : 'issued' },
    amounts: { currency: 'USD', dueCents: due, appliedCents: applied, remainingCents: due - applied },
    paymentStatus: voided ? 'voided' : due === 0 ? 'nothing_due' : applied === 0 ? 'no_payment_recorded' : applied === due ? 'recorded_in_full' : 'recorded_partly',
    payments: page,
    nextCursor: start + 50 < all.length ? page[page.length - 1].id : null,
  };
}
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

interface Rig { keys: string[]; clock: { mono: number; wall: number }; reauth: Array<string | null>; holds: VoidHoldStore; payHolds: PaymentHoldStore; props: (over?: Partial<ServerIssuedInvoicesProps>) => ServerIssuedInvoicesProps }
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
  const payHolds = createPaymentHoldStore({ now: () => clock.mono, wallNow: () => clock.wall });
  const identity: ShopIdentity = {
    idToken: async (uid) => tokens[uid] ?? null,
    reauthMethod: () => 'password',
    reauthenticate: async (uid, password) => { reauth.push(password); return password === 'correct horse' ? tokens[uid] ?? null : null; },
  };
  return {
    keys, clock, reauth, holds, payHolds,
    props: (over = {}) => ({
      uid: 'uid-a', session, issuing, drafts, identity, now: () => clock.mono, wallNow: () => clock.wall, voidHolds: holds, paymentHolds: payHolds,
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
    for (const file of ['ServerIssuedInvoices.tsx', 'invoiceIssuingClient.ts', 'invoiceVoidHold.ts', 'invoicePaymentHold.ts']) { // the held void (VOID-P2) and payment (P2B) attempts too
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
/**
 * M7B-PAYMENTS-P2A supersession of FORBIDDEN (as `unvoided` above): the issued dialog's Payments section speaks of
 * payments, the amount due and what is recorded by design (doc 15 §3 D-PAY-1). ONLY that section's text is taken out
 * before a scan — everything outside it is scanned exactly as before, and FORBIDDEN is unchanged. The section's own words
 * are pinned by SII-153 and later (never "Paid" or "Unpaid").
 */
const outsidePayments = (el: Element | null): string | null => {
  if (el === null) return null;
  const copy = el.cloneNode(true) as Element;
  for (const section of copy.querySelectorAll('[data-testid="issued-payments"]')) section.remove();
  return copy.textContent;
};
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
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close', VOID_TEXT.open, RECORD_ID_TEXT.copy]);
    expect(dialog.textContent).toContain(VOID_TEXT.open);
    expect(unvoided(outsidePayments(dialog))).not.toMatch(FORBIDDEN); // P2A: outside the Payments section
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

  it('SII-54. Escape and Close close the dialog and give focus back to the row\'s Open; Tab stays inside it (Close, "Void invoice…" where it is offered — VOID-P2 —, Copy ID — QA-UI-02 —, the lines region, Close); when that row is gone — the session ended while it was open — focus goes to the section heading, never the page body', async () => {
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
    expect(document.activeElement).toBe(tid('issued-view-id-copy'));
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
      expect(unvoided(outsidePayments(dialog))).not.toMatch(FORBIDDEN); // P2A: outside the Payments section
      expect(within(dialog).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Close', VOID_TEXT.open, RECORD_ID_TEXT.copy]);
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
    // P2A: the invoice's own terms, outside the Payments section (whose summary has its own).
    expect([...dialog.querySelectorAll('dt')].filter((dt) => dt.closest('[data-testid="issued-payments"]') === null).map((dt) => dt.textContent)).toEqual(['Status', 'Issued at', 'Voided at', 'Reason', 'Invoice record ID']);
    expect(tid('issued-view-customer')).toHaveTextContent('Ada Customer');
    expect(tid('issued-view-total')).toHaveTextContent('Total $21.76');
    expect(tid('issued-view-note')).toHaveTextContent(VIEW_TEXT.note);
    expect(within(dialog).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Close', RECORD_ID_TEXT.copy]);
    expect(outsidePayments(dialog)).not.toMatch(FORBIDDEN); // P2A: outside the Payments section
    expect(outsidePayments(tid('issued-section'))).not.toMatch(FORBIDDEN);
    expect(within(tid('issued-section')).getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Open')).toEqual(['Issuing settings']);
    await user().click(tid('issued-view-close'));
    await user().click(openButton(1));
    await viewReady(1);
    expect(tid('issued-view-status')).toHaveTextContent(/^Issued$/);
    expect(screen.queryByTestId('issued-view-voided-at')).toBeNull();
    expect(screen.queryByTestId('issued-view-void-reason')).toBeNull();
    expect([...screen.getByRole('dialog', { name: 'Invoice 1' }).querySelectorAll('dt')].filter((dt) => dt.closest('[data-testid="issued-payments"]') === null).map((dt) => dt.textContent)).toEqual(['Status', 'Issued at', 'Invoice record ID']); // P2A: outside the Payments section
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
      ...(['already-void', 'version-conflict', 'payments-recorded', 'tenant-conflict', 'not-found', 'key-reused', 'invalid'] as const)
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
      [{ kind: 'payments-recorded' }, refusedAs('payments-recorded')], // M7B-PAYMENTS-P1: the key's sealed payments_recorded
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
  /**
   * CI fix (SIS-22 S320H600: the held card's "Check invoice" was 7 px wider than its card on CI's fonts): every void control
   * may shrink below its longest word, which then wraps inside it. jsdom has no layout, so this pins the classes only —
   * the browser measures the result; no red/green is possible for the layout itself here.
   */
  const FITS = ['min-w-0', 'max-w-full', 'whitespace-normal', '[overflow-wrap:anywhere]'];
  const fits = (el: HTMLElement, name = el.getAttribute('data-testid') ?? el.tagName) => { for (const c of FITS) expect(el, `${name} ${c}`).toHaveClass(c); };

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
    expect(buttons('issued-view')).toEqual(['Close', RECORD_ID_TEXT.copy]);
    await closeAll();
    // Not allowed (a refusal after its one fresh check), an outage, an allowed with an extra member: nothing but the row.
    for (const answer of ['refused', 'outage', 'malformed'] as const) {
      if (answer === 'refused') server.voidDenied.add('uid-a');
      else server.eligStatus.push(answer === 'outage' ? 503 : json200({ eligibility: 'allowed', extra: true }));
      const reads = server.eligReads().length;
      const opens = server.paymentReads().filter((x) => x.includes(made[2].id)).length;
      await user().click(openButton(3));
      await viewReady(3);
      await waitFor(() => expect(server.eligReads()).toHaveLength(reads + 1));
      await settle();
      expect(tid('issued-view-void-cell').children, answer).toHaveLength(0); // L-1: the real cell is empty (the copy stays)
      expect(buttons('issued-view'), answer).toEqual(['Close', RECORD_ID_TEXT.copy]);
      if (answer === 'refused') {
        const at = server.sent.map((x) => x.url).lastIndexOf(eligUrl(STORE_1, made[2].id));
        // ONE fresh check, no loop. P2A: the open's ONE payments read (decision D4) follows the eligibility read once the
        // detail answered — its own session check, then its GET; nothing else is sent.
        await waitFor(() => expect(server.paymentReads().filter((x) => x.includes(made[2].id))).toHaveLength(opens + 1));
        await settle();
        // M7B-PAYMENTS-P2B: beside it the open's ONE payment eligibility read (its own session check, then its GET).
        await waitFor(() => expect(server.payRequests('payment-eligibility').filter((x) => x.url.includes(made[2].id)).length).toBeGreaterThan(0));
        await settle();
        // In order (R1 T10): the fresh check, then ONE session check the two reads started together share, the payments GET
        // and the payment eligibility GET.
        expect(sentFrom(server, at + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${TENANT_SESSION_PATHS.current}`,
          `GET ${STORES_PATH}/${STORE_1}/invoices/${made[2].id}/payments`, `GET ${STORES_PATH}/${STORE_1}/invoices/${made[2].id}/payment-eligibility`]);
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
    expect(buttons('issued-view')).toEqual(['Close', RECORD_ID_TEXT.copy]);
    expect(screen.queryByTestId('issued-view-void-area')).toBeNull();
    expect(plain).not.toContain('issued-view-void');
    cleanup();
    const eligibility = vi.fn(async () => 'not' as const);
    const voiding: IssuedVoidCapability = {
      store: store(STORE_1, 'Main Street'), held: undefined, expired: false, cooling: false, finding: false, checkText: '', confirmedDenial: null, reauthMethod: () => 'password', signingIn: false, generation: () => 1,
      eligibility, send: vi.fn(async () => null), check: vi.fn(), find: vi.fn(), signIn: vi.fn(async () => null), stopSignIn: vi.fn(),
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
    // P2A: a confirmed void re-reads payments page one ONCE (the summary never keeps the issued amounts).
    expect(apart(server, mark).sort()).toEqual([`POST ${voidUrl(STORE_1, made[1].id)}`, `GET ${detailUrl(STORE_1, made[1].id)}`, `GET ${listPath(STORE_1)}`, `GET ${detailUrl(STORE_1, made[1].id)}/payments`].sort());
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
    fits(tid('issued-view-void-load')); // CI fix: never wider than its row
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
    { name: 'a sealed 409 payments_recorded (M7B-PAYMENTS-P1)', answer: () => sealed(409, 'payments_recorded'), refusal: 'payments-recorded' as const, reread: false },
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
  it('SII-152. doc 15 §12.6: the payments_recorded refusal SII-90 shows is exactly the contract\'s sentence', () => {
    expect(VOID_REFUSED_TEXT['payments-recorded']).toBe("This invoice has payments recorded, so it can't be voided. If a payment was recorded by mistake, reverse that payment first.");
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
    // CI fix: the step-up row cannot run past the confirmation — its button wraps inside itself, its password column and field shrink.
    fits(tid('issued-void-reauth-confirm'));
    for (const el of [tid('issued-void-reauth-password'), tid('issued-void-reauth-password').parentElement!]) for (const c of ['min-w-0', 'max-w-full']) expect(el, c).toHaveClass(c);
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
    expect(unvoided(outsidePayments(tid('issued-section')))).not.toMatch(FORBIDDEN);
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
    for (const file of ['ServerIssuedInvoices.tsx', 'invoiceVoidHold.ts', 'invoicePaymentHold.ts']) {
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

  it('SII-126. Review B1 L2 / R2-1a: while the void\'s own sign-in is out nothing new can be reviewed or sent — "Void invoice…" waits, said — and Keep invoice during it ends the wait at once (R1): the action comes back, and the sign-in\'s late completion signs nothing in and reads nothing', async () => {
    const server = seeded();
    server.staleLogins = true;
    issueAt(server, STORE_1, 3);
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
    // Fix round 2 (R2-1a): no review can start while the sign-in is out — the dialog's "Void invoice…" behind the
    // confirmation waits, said. The send guard for it stays in sendVoid as a second line.
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-void')).toHaveAccessibleDescription(VOID_TEXT.reviewSignIn);
    await click('issued-void-keep');
    await waitFor(() => expect(box()).toBeNull());
    // R1 supersession (was: Keep invoice left the sign-in out — "Void invoice…" held, opening nothing, until the provider
    // answered — and its late success then renewed the session and read the invoice and its eligibility again): Keep
    // invoice ends the wait here at once. The provider is not cancelled; its late success applies nothing — no
    // re-authentication login, no re-read (a session it did renew is found by the next session check, SII-151).
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false');
    expect(describedBy('issued-view-void')).toBe('');
    const mark = server.sent.length;
    const logins = server.logins().length;
    await act(async () => { release(); });
    await settle();
    expect(sentFrom(server, mark)).toEqual([]);
    expect(server.logins()).toHaveLength(logins);
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

  it('SII-130. Review B1 R2-1 (the reported sequence): confirmation A meets a step-up, its sign-in is out, A is closed — R1: closing A ends that wait, so its sign-in can never renew the session under a confirmation B: B is reviewed under the session that stands, and the provider\'s late answer (the invoice voided meanwhile) signs nothing in, reads nothing and changes no confirmation; nothing is ever sent', async () => {
    const { server, made, release } = await staleSignIn();
    await click('issued-void-reauth-confirm'); // the sign-in is out
    await click('issued-void-keep'); // A closed
    await waitFor(() => expect(box()).toBeNull());
    // R1 supersession (was: while A's sign-in was still out "Void invoice…" waited, said, and opened nothing — so no B could
    // be reviewed under the session that sign-in would replace — and its late renewal then found the invoice voided or no
    // longer allowed): closing A ended the wait, and a sign-in this page no longer waits for renews nothing here.
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false');
    const before = server.sent.length;
    await click('issued-view-void'); // B: a review under the session that stands
    await waitFor(() => expect(box()).not.toBeNull());
    expect(apart(server, before)).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`]);
    made[1].void = { voidedAt: server.voidAt, reasonCode: 'duplicate' };
    const mark = server.sent.length;
    await act(async () => { release(); });
    await settle();
    expect(sentFrom(server, mark)).toEqual([]); // no re-authentication login, no re-read
    expect(tid('issued-void-title')).toHaveTextContent(VOID_TEXT.title(2));
    expect(tid('issued-void-confirm-status').textContent).toBe(''); // B as reviewed: nothing said to it
    expect(tid('issued-void-confirm-alert').textContent).toBe('');
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
      reauthMethod: () => 'password', signingIn: false, generation: () => ctl.generation, eligibility, send, check: vi.fn(), find: vi.fn(), signIn, stopSignIn: vi.fn(),
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
    expect(within(tid('issued-view')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close', VOID_TEXT.open, RECORD_ID_TEXT.copy]);
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
    expect(document.activeElement).toBe(tid('issued-view-id-copy')); // QA-UI-02: Copy ID, the dialog's own control
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-lines-scroll'));
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-close')); // Close, Copy ID, the lines region, Close: the hidden copy is no stop
  });

  // ---- CI fix after checkpoint B (SIS-22 S320H600: a held-card button wider than its card) ----

  it('SII-141. CI fix (structure only; jsdom has no layout): every void control can never be wider than its row — the trigger and its invisible copy (the same box), the confirmation\'s Keep invoice / Close, Void invoice, Check again and Check invoice, and the held card\'s Check again, Check invoice and Dismiss each may shrink and wrap inside itself; their text, order and names are unchanged', async () => {
    const { server, r } = await setup();
    await openVoidable(2);
    fits(tid('issued-view-void'));
    fits(tid('issued-view-void-placeholder').querySelector('span')!, 'placeholder copy');
    await click('issued-view-void');
    await waitFor(() => expect(box()).not.toBeNull());
    fits(tid('issued-void-keep'));
    fits(tid('issued-void-send'));
    expect(buttons('issued-void-confirm')).toEqual(['Keep invoice', 'Void invoice']);
    server.voids.push('lose-before');
    await pressWith('wrong_customer');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    for (const id of ['issued-void-keep', 'issued-void-confirm-check', 'issued-void-confirm-find']) fits(tid(id));
    expect(buttons('issued-void-confirm')).toEqual(['Close', 'Check again', 'Check invoice']);
    await closeAll();
    for (const id of ['issued-void-check', 'issued-void-find', 'issued-void-dismiss']) fits(tid(id));
    expect(buttons('issued-void-card')).toEqual(['Check again', 'Check invoice', 'Dismiss']);
    expect(screen.getByRole('button', { name: 'Check invoice' })).toBe(tid('issued-void-find'));
  });

  // ---- M7B-INVOICES-VOID-P2-R1: the void's sign-in is waited for at most 30 s from Confirm sign-in, by one owner ----

  /**
   * A stale sign-in's step-up over a provider whose re-authentications are each held until the test answers them (`calls`,
   * in order): the fake clock goes on BEFORE the press (the deadline is the fake's), then Confirm sign-in is pressed — the
   * sign-in is out. `press` presses it again (a new attempt).
   */
  async function stalled() {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    server.staleLogins = true;
    const made = issueAt(server, STORE_1, 3);
    const r = rig(server);
    const calls: Array<{ readonly resolve: (token: string | null) => void; readonly reject: (error: Error) => void }> = [];
    const identity: ShopIdentity = { ...r.props().identity!, reauthenticate: () => new Promise<string | null>((resolve, reject) => { calls.push({ resolve, reject }); }) };
    const page = render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await showAndChoose(STORE_1);
    await listReady();
    await openConfirm(2);
    await pressWith('wrong_customer');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    fakeClock();
    const press = async (): Promise<void> => {
      type('issued-void-reauth-password', 'correct horse');
      fireEvent.click(tid('issued-void-reauth-confirm'));
      await until(() => expect(tid('issued-void-reauth-hint')).toHaveTextContent(SETTINGS_TEXT.confirmingSignIn));
    };
    await press();
    return { server, made, r, page, calls, press };
  }
  const OTHER_KEY = '5e1f0000-1d2f-4a6b-9c8d-0000000000aa';
  /** An unresolved attempt for invoice 3 under the session that stands, put in the rig's own hold (no shop path holds one beside a step-up's sign-in). */
  function holdOther(server: Server, made: Issued[], r: Rig): HeldVoid {
    const other: HeldVoid = {
      key: OTHER_KEY, body: VBODY('duplicate'), storeId: STORE_1, storeLabel: 'Main Street', invoiceId: made[2].id, number: 3,
      csrf: server.voidPosts()[0].headers.get('x-tmpos-session-csrf'), sentAt: r.clock.mono, sentWall: r.clock.wall,
      state: 'unresolved', note: '', refusal: null, seen: null, seenReason: null, retryable: true,
    };
    act(() => { expect(r.holds.put('uid-a', other)).toBe(true); });
    return other;
  }
  /** The fake timers still pending once those due now have run (jsdom's own 0 ms selectionchange, a dialog's focus return and the selectionchange that focus queues). */
  const timersLeft = async (): Promise<number> => { for (let i = 0; i < 3; i++) await advance(0); return vi.getTimerCount(); };
  const renewalReads = (made: Issued[]) => [`GET ${detailUrl(STORE_1, made[1].id)}`, `GET ${eligUrl(STORE_1, made[1].id)}`].sort();

  it('SII-142. R1 AC-04 (the R1-probe, kept): a provider re-authentication that never settles is waited for 30 s from Confirm sign-in and no longer — at 29 999 ms still "Confirming your sign-in…" (the field read-only, Stop waiting offered, "Void invoice…" and Check again held, a tab return checks nothing); at exactly 30 000 ms the wait is over without a remount: the confirmation says this page stopped waiting and sent nothing, the field is empty, editable and focused, a tab return checks the session again, Check again sends its own request, and Keep invoice, Close and reopen leave "Void invoice…" usable — nothing is sent on its own: no void POST, no re-authentication login, no second provider call', async () => {
    const { server, made, r, calls } = await stalled();
    const other = holdOther(server, made, r);
    const logins = server.logins().length;
    const mark = server.sent.length;
    await advance(29_999);
    expect(tid('issued-void-reauth-hint')).toHaveTextContent(SETTINGS_TEXT.confirmingSignIn);
    expect(tid('issued-void-reauth-password')).toHaveAttribute('readonly');
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(describedBy('issued-view-void')).toBe(VOID_TEXT.reviewSignIn);
    fireEvent.click(tid('issued-void-check'));
    await until(() => expect(tid('issued-void-card-seen')).toHaveTextContent(VOID_TEXT.signingIn));
    await focusEvents();
    expect(sentFrom(server, mark)).toEqual([]); // no tab-return check, nothing for Check again
    await advance(1); // exactly 30 000 ms after the press
    expect(tid('issued-void-reauth-hint')).not.toHaveTextContent(SETTINGS_TEXT.confirmingSignIn);
    expect(tid('issued-void-reauth-password')).not.toHaveAttribute('readonly');
    expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.signInTimedOut);
    expect(tid('issued-void-reauth-password')).toHaveValue('');
    await until(() => expect(document.activeElement).toBe(tid('issued-void-reauth-password')));
    expect(screen.queryByTestId('issued-void-reauth-stop')).toBeNull();
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false');
    expect(sentFrom(server, mark)).toEqual([]); // the deadline itself sends nothing
    await focusEvents();
    expect(sentFrom(server, mark)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]); // the tab return checks the session again
    expect(server.voidPosts()).toHaveLength(1); // only the press that met step_up_required
    fireEvent.click(tid('issued-void-check')); // the user's own Check again: the held attempt's key and bytes
    await until(() => expect(server.voidPosts()).toHaveLength(2));
    expect(server.voidPosts()[1].headers.get('idempotency-key')).toBe(OTHER_KEY);
    expect(server.voidPosts()[1].body).toBe(other.body);
    fireEvent.click(tid('issued-void-keep'));
    await until(() => expect(box()).toBeNull());
    fireEvent.click(tid('issued-view-void'));
    await until(() => expect(box()).not.toBeNull()); // a new review, without a remount
    fireEvent.click(tid('issued-void-keep'));
    await until(() => expect(box()).toBeNull());
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    fireEvent.click(openButton(2));
    await until(() => expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false'));
    expect(server.logins()).toHaveLength(logins); // no re-authentication login, no automatic sign-in
    expect(calls).toHaveLength(1); // no second provider call
    expect(server.voidPosts()).toHaveLength(2);
    expect(VOID_SIGNIN_WAIT_MS).toBe(30_000);
    expect(VOID_TEXT.signInTimedOut).toMatch(/^Not voided: this page stopped waiting for your sign-in after 30 seconds /);
  });

  it('SII-143. R1 AC-04: a provider re-authentication that fails within the 30 s (at 10 s here) takes today\'s path — "Not signed in: your sign-in was not confirmed. Try again." with the field focused — and its deadline goes with it: nothing fires later and nothing is sent; Stop waiting, offered only while it was waited for, is gone', async () => {
    const { server, calls } = await stalled();
    expect(tid('issued-void-reauth-stop')).toHaveTextContent(VOID_TEXT.stopWaiting);
    const logins = server.logins().length;
    const mark = server.sent.length;
    await advance(10_000);
    await act(async () => { calls[0].reject(new Error('synthetic provider failure')); });
    await until(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.reauthFailed));
    await until(() => expect(document.activeElement).toBe(tid('issued-void-reauth-password')));
    expect(screen.queryByTestId('issued-void-reauth-stop')).toBeNull();
    expect(await timersLeft()).toBe(0);
    await advance(60_000);
    expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.reauthFailed);
    expect(tid('issued-void-confirm-alert')).not.toHaveTextContent(VOID_TEXT.signInTimedOut);
    expect(sentFrom(server, mark)).toEqual([]);
    expect(server.logins()).toHaveLength(logins);
  });

  it('SII-144. R1 AC-08: a sign-in that answers 1 ms before the deadline goes on exactly as before — one re-authentication login, the invoice and its eligibility read again under the new session, the reason cleared, then a NEW press with a NEW key under the NEW token — and its deadline is gone: nothing fires later', async () => {
    const { server, made, r, calls } = await stalled();
    const logins = server.logins().length;
    await advance(29_999);
    expect(tid('issued-void-reauth-stop')).toBeInTheDocument(); // still waited for
    const mark = server.sent.length;
    await act(async () => { calls[0].resolve('tok-a'); });
    await until(() => expect(tid('issued-void-confirm-status')).toHaveTextContent(VOID_TEXT.renewed));
    expect(server.logins().slice(logins).map((x) => x.headers.get('x-tmpos-reauthenticate'))).toEqual(['1']);
    expect(apart(server, mark).sort()).toEqual(renewalReads(made));
    expect(radios().map((x) => x.checked)).toEqual([false, false, false, false, false, false]);
    expect(await timersLeft()).toBe(0);
    await advance(60_000);
    expect(tid('issued-void-confirm-status')).toHaveTextContent(VOID_TEXT.renewed);
    expect(tid('issued-void-confirm-alert').textContent).toBe('');
    expect(server.voidPosts()).toHaveLength(1);
    fireEvent.click(tid('issued-void-reason-duplicate'));
    fireEvent.click(tid('issued-void-send'));
    await until(() => expect(heldA(r)?.state).toBe('voided'));
    const [first, second] = server.voidPosts();
    expect(second.headers.get('idempotency-key')).toBe(r.keys[1]);
    expect(r.keys[1]).not.toBe(r.keys[0]);
    expect(second.headers.get('x-tmpos-session-csrf')).not.toBe(first.headers.get('x-tmpos-session-csrf'));
  });

  it('SII-145. R1 AC-06: a provider success that comes after the deadline applies nothing — the session is never asked to renew for it (no re-authentication login), nothing is read again, the list stays, the confirmation\'s "stopped waiting" alert and the focus the user moved stay; nothing is sent', async () => {
    const { server, calls } = await stalled();
    const logins = server.logins().length;
    await advance(30_000);
    await until(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.signInTimedOut));
    act(() => { tid('issued-void-keep').focus(); });
    const mark = server.sent.length;
    await act(async () => { calls[0].resolve('tok-a'); });
    await settle();
    expect(sentFrom(server, mark)).toEqual([]);
    expect(server.logins()).toHaveLength(logins);
    expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.signInTimedOut);
    expect(tid('issued-void-confirm-status').textContent).toBe('');
    expect(tid('issued-void-reauth-group')).toBeInTheDocument(); // still the sign-in, never the renewed review
    expect(document.activeElement).toBe(tid('issued-void-keep'));
    expect(listPhase()).toBe('ready'); // no renewal took the list read under the old token
    expect(server.voidPosts()).toHaveLength(1);
  });

  it.each(['succeeds', 'fails'] as const)('SII-146. R1 AC-06: a new attempt after the deadline owns the wait alone — the timed-out attempt\'s provider then %s late and changes nothing of it: the new one is still "Confirming your sign-in…" with Stop waiting, its field read-only and "Void invoice…" held; only the new attempt\'s answer renews — one re-authentication login', async (late) => {
    const { server, made, calls, press } = await stalled();
    const logins = server.logins().length;
    await advance(30_000);
    await until(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.signInTimedOut));
    await press(); // the explicit new try
    expect(calls).toHaveLength(2);
    const mark = server.sent.length;
    await act(async () => { if (late === 'succeeds') calls[0].resolve('tok-a'); else calls[0].reject(new Error('synthetic late failure')); });
    await settle();
    expect(sentFrom(server, mark)).toEqual([]);
    expect(tid('issued-void-reauth-hint')).toHaveTextContent(SETTINGS_TEXT.confirmingSignIn);
    expect(tid('issued-void-reauth-stop')).toBeInTheDocument();
    expect(tid('issued-void-reauth-password')).toHaveAttribute('readonly');
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-void-confirm-alert').textContent).toBe('');
    await act(async () => { calls[1].resolve('tok-a'); });
    await until(() => expect(tid('issued-void-confirm-status')).toHaveTextContent(VOID_TEXT.renewed));
    expect(server.logins().slice(logins).map((x) => x.headers.get('x-tmpos-reauthenticate'))).toEqual(['1']);
    expect(apart(server, mark).sort()).toEqual(renewalReads(made));
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-147. R1 AC-05: Stop waiting ends the wait at once, long before the deadline — the confirmation says this page stopped waiting and sent nothing (never that anything was cancelled or failed), the field is editable and focused, its deadline is gone, a tab return checks the session again; the provider\'s late success then signs nothing in; nothing is sent', async () => {
    const { server, calls } = await stalled();
    const logins = server.logins().length;
    const mark = server.sent.length;
    await advance(5_000);
    expect(tid('issued-void-reauth-stop')).toHaveTextContent(VOID_TEXT.stopWaiting);
    fireEvent.click(tid('issued-void-reauth-stop'));
    await until(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.signInStopped));
    expect(tid('issued-void-reauth-hint')).not.toHaveTextContent(SETTINGS_TEXT.confirmingSignIn);
    expect(tid('issued-void-reauth-password')).not.toHaveAttribute('readonly');
    await until(() => expect(document.activeElement).toBe(tid('issued-void-reauth-password')));
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false');
    expect(await timersLeft()).toBe(0);
    await focusEvents();
    expect(sentFrom(server, mark)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    await act(async () => { calls[0].resolve('tok-a'); });
    await settle();
    expect(sentFrom(server, mark)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.logins()).toHaveLength(logins);
    expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.signInStopped);
    expect(server.voidPosts()).toHaveLength(1);
    for (const text of [VOID_TEXT.signInTimedOut, VOID_TEXT.signInStopped, VOID_TEXT.stopWaitingHint]) expect(text).not.toMatch(/cancel|revoke|failed|signed out/i);
  });

  it('SII-148. R1 AC-05: Escape during the wait closes the confirmation and ends the wait at once; the invoice then closes and reopens without a remount, "Void invoice…" usable and reviewing again, and a tab return checks the session; the provider\'s late success signs nothing in and reads nothing; nothing is sent', async () => {
    const { server, calls } = await stalled();
    const logins = server.logins().length;
    fireEvent.keyDown(tid('issued-void-reauth-password'), { key: 'Escape' });
    await until(() => expect(box()).toBeNull());
    expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    fireEvent.click(openButton(2));
    await until(() => expect(tid('issued-view-void')).toHaveAttribute('aria-disabled', 'false'));
    await until(() => expect(tid('issued-payments-state')).toHaveAttribute('data-phase', 'ready')); // P2A: the open's payments read has answered
    const mark = server.sent.length;
    await focusEvents();
    expect(sentFrom(server, mark)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    fireEvent.click(tid('issued-view-void'));
    await until(() => expect(box()).not.toBeNull());
    const late = server.sent.length;
    await act(async () => { calls[0].resolve('tok-a'); });
    await settle();
    expect(sentFrom(server, late)).toEqual([]);
    expect(server.logins()).toHaveLength(logins);
    expect(tid('issued-void-confirm-status').textContent).toBe(''); // the new review's confirmation, untouched
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-149. R1 AC-05: leaving the page during the wait (the section unmounts) takes its deadline with it, and the provider\'s late answer — a failure here — changes nothing: no state update, no unhandled rejection, nothing sent', async () => {
    const rejections: unknown[] = [];
    const heard = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', heard);
    try {
      const { server, page, calls } = await stalled();
      expect(await timersLeft()).toBe(1); // the deadline, armed at the press
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mark = server.sent.length;
      page.unmount();
      expect(await timersLeft()).toBe(0);
      await act(async () => { calls[0].reject(new Error('synthetic late failure')); });
      await advance(60_000);
      await settle();
      expect(sentFrom(server, mark)).toEqual([]);
      expect(rejections).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', heard);
    }
  });

  it.each(['a sign-out', 'another session'] as const)('SII-150. R1 AC-07: %s during the wait is a real session change and keeps its normal handling — the invoice closes, the held attempt is detached for good — and it ends the wait: afterwards a tab return checks the session again, and the provider\'s late success rebinds nothing (no re-authentication login, nothing re-read); nothing is sent', async (change) => {
    const { server, made, r, calls } = await stalled();
    holdOther(server, made, r);
    const logins = server.logins().length;
    if (change === 'a sign-out') {
      await act(async () => { await r.props().session!.logout(); });
    } else {
      server.otherTab('uid-a');
      fireEvent.click(tid('issued-void-find')); // a Check invoice's session check finds the other session's token
    }
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(heldA(r)?.csrf).toBeNull(); // detached: never checked again under a later session
    if (change === 'a sign-out') {
      fireEvent.click(tid('issued-retry')); // Reconnect
      await until(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready'));
    } else {
      await until(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready'));
    }
    await settle(); // the Check invoice read goes on under the new session (SII-124)
    const mark = server.sent.length;
    await focusEvents();
    expect(sentFrom(server, mark)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    const plain = server.logins().length; // a Reconnect's plain login only
    expect(server.logins().slice(logins).map((x) => x.headers.get('x-tmpos-reauthenticate'))).toEqual(change === 'a sign-out' ? [null] : []);
    await act(async () => { calls[0].resolve('tok-a'); });
    await settle();
    expect(server.logins()).toHaveLength(plain);
    expect(sentFrom(server, mark)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.voidPosts()).toHaveLength(1);
  });

  it('SII-151. R1 AC-07: a session renewal still in flight at the deadline is not applied to the dialog — its late "ok" reads nothing again and the "stopped waiting" alert stays — but the session it installed is real: the next session check (a tab return) adopts it as a new generation, which closes the invoice and detaches the attempt sent under the old token, as any session change does', async () => {
    const { server, made, r, calls } = await stalled();
    holdOther(server, made, r);
    const logins = server.logins().length;
    await advance(20_000);
    server.hold.current = 1; // the renewal's confirming session read, held at the server
    await act(async () => { calls[0].resolve('tok-a'); });
    await until(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
    expect(server.logins().slice(logins).map((x) => x.headers.get('x-tmpos-reauthenticate'))).toEqual(['1']); // sent before the deadline
    await advance(10_000); // 30 000 ms after the press (the session read's own 15 s bound is not reached)
    await until(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.signInTimedOut));
    const mark = server.sent.length;
    await act(async () => { server.held.shift()!.release(); }); // the renewal's late "ok"
    await settle();
    expect(apart(server, mark)).toEqual([]); // no detail or eligibility read again
    expect(tid('issued-void-confirm-alert')).toHaveTextContent(VOID_TEXT.signInTimedOut);
    expect(tid('issued-void-reauth-group')).toBeInTheDocument();
    expect(listPhase()).toBe('ready');
    expect(heldA(r)?.csrf).not.toBeNull();
    await focusEvents(); // the next session check finds the renewed session
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(heldA(r)?.csrf).toBeNull();
    expect(server.voidPosts()).toHaveLength(1);
  });
});

// QA-UI-02-P1: each issued invoice's own record ID (never its source draft's, customer's or store's) — its ending under the
// invoice number in the list, the whole ID with Copy ID in the dialog. navigator.clipboard is set after the last
// user-event call before each press (userEvent.setup() installs its own stub).
const clip = (writeText?: (text: string) => Promise<void>) =>
  Object.defineProperty(navigator, 'clipboard', { value: writeText === undefined ? undefined : { writeText }, configurable: true, writable: true });

describe('Issued invoices — visible record IDs (QA-UI-02)', () => {
  afterEach(() => { clip(); });

  it('SRI-04. each row keeps "Invoice {number}" first and says the invoice\'s own ID ending; the dialog keeps the number and names the whole Invoice record ID — not the source draft\'s, the customer\'s or the store\'s — with a Copy ID button named for it', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 2);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(screen.getAllByTestId('issued-row-number').map((p) => p.textContent)).toEqual(['Invoice 2', 'Invoice 1']);
    expect(screen.getAllByTestId('issued-row-id').map((p) => p.textContent)).toEqual([idEndingText(made[1].id), idEndingText(made[0].id)]);
    expect(within(tid('issued-list')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open', 'Open']);
    await user().click(openButton(2));
    await viewReady(2);
    expect(tid('issued-view-id').textContent).toBe(made[1].id);
    expect([made[1].sourceDraftId, made[1].customerId, STORE_1]).not.toContain(tid('issued-view-id').textContent);
    expect(within(tid('issued-view')).getByText('Invoice record ID').tagName).toBe('DT');
    expect(tid('issued-view-id')).toHaveClass('select-all', 'break-all');
    expect(screen.getByRole('button', { name: 'Copy ID (invoice record)' })).toHaveAttribute('type', 'button');
    expect(tid('issued-store')).toHaveValue(STORE_1); // the store stays named beside the number
  });

  it('SRI-05. loaded invoices that share an ID ending each show their whole ID; another keeps its ending; nothing more is read for it', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 3, (n) => (n === 3 ? {} : { id: `0000000${n}-0000-4000-8000-0000feedbeef` }));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(screen.getAllByTestId('issued-row-id').map((p) => p.textContent)).toEqual([idEndingText(made[2].id), `ID ${made[1].id}`, `ID ${made[0].id}`]);
    await settle();
    expect(server.lists()).toEqual([listPath(STORE_1)]);
    expect(server.details()).toEqual([]);
  });

  it('SRI-06. Copy ID copies the invoice\'s WHOLE record ID and says Copied only once the copy succeeded; a refusal says to copy it by hand, the ID still shown; a press sends nothing and opens no void', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 1);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(1));
    await viewReady(1);
    await settle();
    const sent = server.sent.length;
    let finish = () => {};
    const writeText = vi.fn((_text: string) => new Promise<void>((ok) => { finish = ok; }));
    clip(writeText);
    fireEvent.click(tid('issued-view-id-copy'));
    await waitFor(() => expect(writeText.mock.calls).toEqual([[made[0].id]])); // the call is made a microtask later
    expect(tid('issued-view-id-note').textContent).toBe('');
    await act(async () => { finish(); });
    expect(tid('issued-view-id-note')).toHaveTextContent(RECORD_ID_TEXT.copied);
    writeText.mockImplementationOnce(() => Promise.reject(new Error('denied')));
    fireEvent.click(tid('issued-view-id-copy'));
    await waitFor(() => expect(tid('issued-view-id-note')).toHaveTextContent(RECORD_ID_TEXT.failed));
    expect(tid('issued-view-id').textContent).toBe(made[0].id);
    expect(server.sent.length).toBe(sent);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

// M7B-PAYMENTS-P2A — the issued dialog's read-only Payments section (doc 15 §3 D-PAY-1, §12.3; decision D4): page one
// once per open after the detail answered, "Load more payments" for the next, the server's amounts and word as they are,
// every label "recorded". The REAL section and clients over the fake's payments read (server/runtime/invoicePayments.ts:
// due the Total while issued, 0 once voided; 50 a page, oldest first). Every assertion about a request is on the wire.
describe('Issued invoices — payments in the issued dialog (M7B-PAYMENTS-P2A)', () => {
  const T = (n: number) => `2026-10-17T09:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000001Z`;
  const pay = (n: number, over: Partial<PaymentWire> = {}): PaymentWire => ({ id: uuid(0x9000 + n), attemptId: uuid(0xa000 + n), amountCents: 100, method: 'cash', recordedAt: T(n), reversal: null, ...over });
  const reversed = (reasonCode: string): PaymentWire['reversal'] => ({ reversedAt: '2026-10-18T10:00:00.000001Z', reasonCode });
  const paymentsUrl = (invoiceId: string, after?: string) => `${STORES_PATH}/${STORE_1}/invoices/${invoiceId}/payments${after === undefined ? '' : `?after=${after}`}`;
  const payPhase = () => screen.queryByTestId('issued-payments-state')?.getAttribute('data-phase') ?? 'none';
  const paymentsReady = () => waitFor(() => expect(payPhase()).toBe('ready'));
  const items = () => screen.queryAllByTestId('issued-payments-item');
  const summary = () => ['issued-payments-status', 'issued-payments-due', 'issued-payments-recorded', 'issued-payments-remaining'].map((id) => tid(id).textContent);
  const json200 = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  async function setup(over: (n: number) => Partial<Issued> = () => ({}), count = 3) {
    const server = seeded();
    const made = issueAt(server, STORE_1, count, over);
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    return { server, made, r };
  }
  async function open(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
  }
  async function close() {
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
  }

  it('SII-153. each of the five words has its shop label, beside the note "Payments are recorded by staff; the product does not verify them." and the server\'s due, recorded and remaining amounts — in a "Payments" region after the invoice; never "Paid" or "Unpaid"', async () => {
    const { server, made } = await setup((n) => (n === 1 ? { lines: [line(1, 'Free check', 1, 0)], tax: { mode: 'none' } } : n === 5 ? { void: { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' } } : {}), 5);
    server.payments.set(made[2].id, [pay(1), pay(2, { amountCents: 500, reversal: reversed('wrong_amount') })]);
    server.payments.set(made[3].id, [pay(3, { amountCents: 2176, method: 'external_card_terminal' })]);
    server.payments.set(made[4].id, [pay(4, { amountCents: 2176, reversal: reversed('wrong_invoice') })]);
    const expected: Record<number, string[]> = {
      1: ['Nothing due', '$0.00', '$0.00', '$0.00'],
      2: ['No payment recorded', '$21.76', '$0.00', '$21.76'],
      3: ['Payment recorded in part', '$21.76', '$1.00', '$20.76'],
      4: ['Payment recorded in full', '$21.76', '$21.76', '$0.00'],
      5: ['Voided', '$0.00', '$0.00', '$0.00'],
    };
    for (const n of [1, 2, 3, 4, 5]) {
      await open(n);
      await paymentsReady();
      expect(summary(), `invoice ${n}`).toEqual(expected[n]);
      const section = screen.getByRole('region', { name: 'Payments' });
      expect(section).toBe(tid('issued-payments'));
      expect(tid('issued-view').contains(section)).toBe(true);
      expect(tid('issued-view-note').compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // after the invoice
      expect(tid('issued-payments-note')).toHaveTextContent(/^Payments are recorded by staff; the product does not verify them\.$/);
      expect([...section.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Payment status', 'Amount due', 'Recorded', 'Remaining']);
      // A long amount wraps only when it cannot fit (320 px at 24 px text); never cut at the panel's edge.
      for (const id of ['issued-payments-due', 'issued-payments-recorded', 'issued-payments-remaining']) expect(tid(id)).toHaveClass('[overflow-wrap:anywhere]');
      expect(section.textContent).not.toMatch(/\b(un)?paid\b/i);
      expect(tid('issued-payments-state')).toHaveTextContent(n === 2 || n === 1 ? PAYMENTS_TEXT.empty : '');
      await close();
    }
    expect(server.writes()).toEqual([]);
  });

  it('SII-154. the history is an ordered list, oldest first, one item per payment: the amount, "Cash" or "Card on a separate terminal", "Recorded at" its UTC time; a reversed one visibly "Reversed", with "Reversed at" and each of the six reasons\' labels', async () => {
    const { server, made } = await setup();
    const reasons: Array<[string, string]> = [
      ['recorded_in_error', 'Recorded by mistake'], ['wrong_amount', 'Wrong amount'], ['wrong_method', 'Wrong method'], ['wrong_invoice', 'Wrong invoice'],
      ['duplicate', 'Payment recorded twice'], ['other', 'Other reason'],
    ];
    server.payments.set(made[1].id, [
      pay(1, { amountCents: 150 }), pay(2, { amountCents: 25, method: 'external_card_terminal' }),
      ...reasons.map(([code], i) => pay(3 + i, { amountCents: 1000 + i, reversal: reversed(code) })),
    ]);
    await open(2);
    await paymentsReady();
    const list = tid('issued-payments-list');
    expect(list.tagName).toBe('OL');
    expect(items()).toHaveLength(8);
    expect(items().map((li) => li.getAttribute('data-id'))).toEqual(Array.from({ length: 8 }, (_, i) => uuid(0x9001 + i)));
    expect(items()[0]).toHaveTextContent(/^\$1\.50 · CashRecorded at 2026-10-17 09:00:01 UTC$/);
    expect(items()[1]).toHaveTextContent(/^\$0\.25 · Card on a separate terminalRecorded at 2026-10-17 09:00:02 UTC$/);
    const times = screen.getAllByTestId('issued-payments-recorded-at');
    expect(times[0].tagName).toBe('TIME');
    expect(times[0]).toHaveAttribute('datetime', T(1));
    expect(screen.getAllByTestId('issued-payments-reversed').map((x) => x.textContent)).toEqual(Array(6).fill('Reversed'));
    expect(screen.getAllByTestId('issued-payments-reason').map((x) => x.textContent)).toEqual(reasons.map(([, label]) => label));
    expect(items()[2]).toHaveTextContent(/^\$10\.00 · Cash · ReversedRecorded at 2026-10-17 09:00:03 UTCReversed at 2026-10-18 10:00:00 UTC · Reason Recorded by mistake$/);
    expect(screen.getAllByTestId('issued-payments-reversed-at')[0]).toHaveAttribute('datetime', '2026-10-18T10:00:00.000001Z');
    for (const amount of screen.getAllByTestId('issued-payments-amount')) expect(amount).toHaveClass('whitespace-nowrap');
    // The server's amounts: only the two standing payments are recorded.
    expect(summary()).toEqual(['Payment recorded in part', '$21.76', '$1.75', '$20.01']);
    expect(screen.queryByTestId('issued-payments-load-more')).toBeNull();
    expect(tid('issued-payments').textContent).not.toMatch(/\b(un)?paid\b/i);
  });

  it('SII-155. D4: an open of the Issued section is ONE detail GET, ONE void eligibility GET and ONE payments GET (page one, no query) — and, for an issued invoice only, ONE payment eligibility GET (M7B-PAYMENTS-P2B: 4 issued, 3 voided); nothing more on focus, a tab return or time passing; a detail that answers 404, 503, 403 or 429 sends NO payments GET', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, made } = await setup((n) => (n === 1 ? { void: { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' } } : {}));
    for (const n of [3, 1]) {
      const mark = server.sent.length;
      await open(n);
      await paymentsReady();
      await settle();
      const sent = server.sent.slice(mark).filter((x) => !x.url.startsWith('/api/v1/session')).map((x) => `${x.method} ${x.url}`);
      // M7B-PAYMENTS-P2B: an issued invoice adds its ONE recording eligibility (4); a voided one sends none (3).
      const recordElig = n === 3 ? [`GET ${paymentsUrl(made[n - 1].id).replace('/payments', '/payment-eligibility')}`] : [];
      expect(sent.sort(), `invoice ${n}`).toEqual([`GET ${STORES_PATH}/${STORE_1}/invoices/${made[n - 1].id}`, `GET ${paymentsUrl(made[n - 1].id)}`, `GET ${paymentsUrl(made[n - 1].id).replace('/payments', '/void-eligibility')}`, ...recordElig].sort());
      const reads = server.paymentReads().length;
      await focusEvents();
      fakeClock();
      await advance(10 * 60_000);
      vi.useRealTimers();
      await settle();
      expect(server.paymentReads()).toHaveLength(reads);
      await close();
    }
    // A detail 401 ends the section (the session-end way): no payments GET. Reconnect, then the other refusals.
    server.detailStatus.push(401);
    const before401 = server.paymentReads().length;
    await user().click(openButton(2));
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    await settle();
    expect(server.paymentReads(), '401').toHaveLength(before401);
    await click('issued-retry'); // Reconnect
    await storesReady();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    for (const status of [404, 503, 403, 429]) {
      server.detailStatus.push(status);
      const reads = server.paymentReads().length;
      await user().click(openButton(2));
      await waitFor(() => expect(['not-found', 'unavailable', 'denied', 'rate-limited']).toContain(viewPhase()));
      await settle();
      expect(server.paymentReads(), String(status)).toHaveLength(reads);
      expect(screen.queryByTestId('issued-payments')).toBeNull();
      await close();
    }
  });

  it('SII-156. the drafts card\'s View invoice (no `payments`) reads and renders exactly as before; with `payments` the dialog differs ONLY by its Payments section, page one asked once (after: null) and only after the detail answered an invoice — never on a refused detail', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 1);
    const session = createTenantSessionClient({ fetch: server.fetch });
    const issuing = createInvoiceIssuingClient({ fetch: server.fetch });
    const s = await session.ensure('uid-a', async () => 'tok-a');
    if (s.kind !== 'ok') throw new Error('no session');
    const got = await issuing.getIssued(STORE_1, made[0].id, s.csrf);
    if (got.kind !== 'ok') throw new Error('no invoice');
    const base = { storeId: STORE_1, invoiceId: made[0].id, read: async (): Promise<IssuedReadAnswer> => ({ kind: 'ok', invoice: got.invoice }), current: () => true, waiting: false, onClose: () => {}, returnFocus: { current: null } };
    const mark = server.sent.length;
    render(<IssuedInvoiceDialog {...base} />);
    await viewReady(1);
    await settle();
    const plain = tid('issued-view').outerHTML;
    expect(screen.queryByTestId('issued-payments')).toBeNull();
    expect(server.sent.length).toBe(mark);
    cleanup();
    const page = { invoice: { id: made[0].id, status: 'issued' as const }, amounts: { currency: 'USD' as const, dueCents: 2176, appliedCents: 0, remainingCents: 2176 }, paymentStatus: 'no_payment_recorded' as const, payments: [], nextCursor: null };
    const read = vi.fn<IssuedPaymentsCapability['read']>(async () => ({ kind: 'ok', page }));
    const payments: IssuedPaymentsCapability = { read };
    render(<StrictMode><IssuedInvoiceDialog {...base} payments={payments} /></StrictMode>);
    await viewReady(1);
    await paymentsReady();
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toBeNull();
    const withPayments = tid('issued-view').cloneNode(true) as HTMLElement;
    withPayments.querySelector('[data-testid="issued-payments"]')!.remove();
    expect(withPayments.outerHTML).toBe(plain);
    cleanup();
    for (const kind of ['not-found', 'denied', 'unavailable'] as const) {
      const refusedRead = vi.fn(async (): Promise<PaymentsReadAnswer> => ({ kind: 'ok', page }));
      render(<IssuedInvoiceDialog {...base} read={async () => ({ kind })} payments={{ read: refusedRead }} />);
      await waitFor(() => expect(viewPhase()).toBe(kind));
      await settle();
      expect(refusedRead, kind).not.toHaveBeenCalled();
      expect(screen.queryByTestId('issued-payments')).toBeNull();
      cleanup();
    }
    expect(server.sent.length).toBe(mark);
  });

  it('SII-157. the section\'s states in its live region, present before page one is asked: loading, empty, denied (after the ONE fresh check), not found, a malformed answer and an outage alike, the wait; each failure offers "Try again" (aria-disabled during the wait), which reads page one again', async () => {
    const { server, made } = await setup();
    server.hold.payments = 1;
    await open(2);
    await waitFor(() => expect(payPhase()).toBe('loading'));
    expect(tid('issued-payments-state')).toHaveTextContent(PAYMENTS_TEXT.loading);
    expect(tid('issued-payments-state')).toHaveAttribute('role', 'status');
    server.held.shift()!.release();
    await paymentsReady();
    expect(tid('issued-payments-state')).toHaveTextContent(PAYMENTS_TEXT.empty);
    expect(screen.queryByTestId('issued-payments-retry')).toBeNull();
    await close();
    const cases: Array<[number | Response, string, string]> = [
      [404, 'not-found', PAYMENTS_TEXT.notFound],
      [503, 'unavailable', PAYMENTS_TEXT.unavailable],
      [json200({ invoice: { id: made[1].id, status: 'issued' }, amounts: { currency: 'USD', dueCents: 2176, appliedCents: 0, remainingCents: 2176 }, paymentStatus: 'unpaid', payments: [], nextCursor: null }), 'unavailable', PAYMENTS_TEXT.unavailable],
      [400, 'unavailable', PAYMENTS_TEXT.unavailable],
    ];
    for (const [answer, phase, text] of cases) {
      server.paymentsStatus.push(answer);
      const reads = server.paymentReads().length;
      await open(2);
      await waitFor(() => expect(payPhase()).toBe(phase));
      expect(tid('issued-payments-state')).toHaveTextContent(text);
      expect(screen.queryByTestId('issued-payments-status')).toBeNull(); // nothing read is shown
      expect(server.paymentReads()).toHaveLength(reads + 1);
      await click('issued-payments-retry');
      await paymentsReady();
      expect(server.paymentReads()).toHaveLength(reads + 2);
      expect(summary()).toEqual(['No payment recorded', '$21.76', '$0.00', '$21.76']);
      await close();
    }
    // Denied: the reads' ONE fresh check, then the alert.
    server.paymentsStatus.push(403);
    await open(2);
    await waitFor(() => expect(payPhase()).toBe('denied'));
    expect(tid('issued-payments-state')).toHaveTextContent(PAYMENTS_TEXT.denied);
    expect(tid('issued-payments-state')).toHaveAttribute('role', 'alert');
    expect(tid('issued-view-total')).toBeInTheDocument(); // the invoice stays
    await close();
    // The wait: a 429 says it, Try again waits with it, and nothing is sent meanwhile.
    server.retryAfter = '30';
    server.paymentsStatus.push(429);
    await open(2);
    await waitFor(() => expect(payPhase()).toBe('rate-limited'));
    expect(tid('issued-payments-state')).toHaveTextContent(pickerWaitText(30));
    expect(tid('issued-payments-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(describedBy('issued-payments-retry')).toBe(PAYMENTS_TEXT.waiting);
    const reads = server.paymentReads().length;
    await click('issued-payments-retry');
    await settle();
    expect(server.paymentReads()).toHaveLength(reads);
  });

  it('SII-158. "Load more payments" only while there is a cursor: ONE GET per press with after= the last id shown (a double press is one), aria-disabled through its read; the summary is always the server\'s (a page one of 50 shows the whole history\'s recorded amount); its last page takes it away and focus goes to the heading', async () => {
    const { server, made } = await setup((n) => (n === 2 ? { lines: [line(1, 'Long job', 1, 20_000)], tax: { mode: 'none' } } : {}));
    server.payments.set(made[1].id, Array.from({ length: 120 }, (_, i) => pay(i + 1)));
    await open(2);
    await paymentsReady();
    expect(items()).toHaveLength(50);
    // 50 × $1.00 on screen; the server says $120.00 recorded over the whole history — its numbers are shown, never a sum.
    expect(summary()).toEqual(['Payment recorded in part', '$200.00', '$120.00', '$80.00']);
    const more = tid('issued-payments-load-more');
    expect(more).toHaveTextContent(PAYMENTS_TEXT.loadMore);
    server.hold.payments = 1;
    await user().dblClick(more);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(server.paymentReads()).toEqual([paymentsUrl(made[1].id), paymentsUrl(made[1].id, uuid(0x9000 + 50))]);
    expect(more).toHaveAttribute('aria-disabled', 'true');
    expect(describedBy('issued-payments-load-more')).toBe(PAYMENTS_TEXT.loading);
    expect(tid('issued-payments-state')).toHaveTextContent(PAYMENTS_TEXT.loading); // R1 F3: the live region says it reads
    expect(items()).toHaveLength(50); // the rows stay meanwhile
    server.held.shift()!.release();
    await waitFor(() => expect(items()).toHaveLength(100));
    expect(tid('issued-payments-state').textContent).toBe(''); // joined: the region is quiet again
    expect(more).toHaveAttribute('aria-disabled', 'false');
    more.focus();
    await user().click(more);
    await waitFor(() => expect(items()).toHaveLength(120));
    expect(server.paymentReads()).toEqual([paymentsUrl(made[1].id), paymentsUrl(made[1].id, uuid(0x9000 + 50)), paymentsUrl(made[1].id, uuid(0x9000 + 100))]);
    expect(screen.queryByTestId('issued-payments-load-more')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Payments' }));
    expect(items().map((li) => li.getAttribute('data-id'))).toEqual(Array.from({ length: 120 }, (_, i) => uuid(0x9001 + i)));
    expect(summary()).toEqual(['Payment recorded in part', '$200.00', '$120.00', '$80.00']);
    await settle();
    expect(server.paymentReads()).toHaveLength(3);
  });

  it('SII-159. a Load more page that does not continue what is held — another amount or word, an id again — keeps the rows shown, drops the page and says "The payments changed while loading. Close and reopen this invoice to see them." with no read of its own; an outage keeps them and the cursor', async () => {
    const { server, made } = await setup((n) => (n === 2 ? { lines: [line(1, 'Long job', 1, 20_000)], tax: { mode: 'none' } } : {}));
    const all = Array.from({ length: 60 }, (_, i) => pay(i + 1));
    server.payments.set(made[1].id, all);
    await open(2);
    await paymentsReady();
    // An outage on Load more: the 50 stay, the cursor too.
    server.paymentsStatus.push(503);
    await click('issued-payments-load-more');
    await waitFor(() => expect(payPhase()).toBe('unavailable'));
    expect(items()).toHaveLength(50);
    expect(tid('issued-payments-load-more')).toBeInTheDocument();
    // Another payment recorded meanwhile: the next page's amounts differ.
    all.push(pay(61, { amountCents: 500 }));
    await click('issued-payments-load-more');
    await waitFor(() => expect(payPhase()).toBe('changed'));
    expect(tid('issued-payments-state')).toHaveTextContent(/^The payments changed while loading\. Close and reopen this invoice to see them\.$/);
    expect(items()).toHaveLength(50);
    expect(summary()).toEqual(['Payment recorded in part', '$200.00', '$60.00', '$140.00']); // the held answer's
    expect(screen.queryByTestId('issued-payments-load-more')).toBeNull();
    const reads = server.paymentReads().length;
    await settle();
    expect(server.paymentReads()).toHaveLength(reads); // no automatic re-read
    await close();
    // An id again (the same amounts and word): also a change.
    all.pop();
    await open(2);
    await paymentsReady();
    const repeat = { invoice: { id: made[1].id, status: 'issued' }, amounts: { currency: 'USD', dueCents: 20_000, appliedCents: 6000, remainingCents: 14_000 }, paymentStatus: 'recorded_partly', payments: [pay(10)], nextCursor: null };
    server.paymentsStatus.push(json200(repeat));
    await click('issued-payments-load-more');
    await waitFor(() => expect(payPhase()).toBe('changed'));
    expect(items()).toHaveLength(50);
    await close();
    // R1 F5c, each alone, the amounts held $200.00 due / $60.00 recorded unless the case changes them.
    const pageAfter = (over: Record<string, unknown>) => json200({ ...repeat, ...over });
    const cases: Array<[string, Response, string]> = [
      // (i) the word alone: no 200 can carry another word for equal amounts and status (the decoder derives it), so it is
      // never a page — refused as malformed; the rows and the cursor stay.
      ['word', pageAfter({ payments: [pay(51)], paymentStatus: 'recorded_in_full' }), 'unavailable'],
      // (ii) the invoice voided meanwhile: amounts 0, "voided", its payment reversed.
      ['status', pageAfter({ invoice: { id: made[1].id, status: 'voided' }, amounts: { currency: 'USD', dueCents: 0, appliedCents: 0, remainingCents: 0 }, paymentStatus: 'voided', payments: [pay(51, { reversal: reversed('other') })] }), 'changed'],
      // (iii) an order break, no id again, the final total right (5000 + 1000 = 6000).
      ['order', pageAfter({ payments: [pay(0, { amountCents: 1000 })] }), 'changed'],
      // (iv) in order, no id again, but the final total across pages 5000 + 500 ≠ 6000.
      ['total', pageAfter({ payments: [51, 52, 53, 54, 55].map((n) => pay(n)) }), 'changed'],
    ];
    for (const [name, answer, phase] of cases) {
      await open(2);
      await paymentsReady();
      server.paymentsStatus.push(answer);
      await click('issued-payments-load-more');
      await waitFor(() => expect(payPhase(), name).toBe(phase));
      expect(items(), name).toHaveLength(50);
      expect(summary(), name).toEqual(['Payment recorded in part', '$200.00', '$60.00', '$140.00']);
      expect(screen.queryByTestId('issued-payments-load-more') !== null, name).toBe(phase === 'unavailable');
      await close();
    }
    // The control: the true next page joins (60 in all, the total right).
    await open(2);
    await paymentsReady();
    await click('issued-payments-load-more');
    await waitFor(() => expect(items()).toHaveLength(60));
    expect(payPhase()).toBe('ready');
  });

  it('SII-160. a payments answer whose open is gone changes nothing: after Close (and another invoice opened), a store change, or another tab\'s session (a new generation) — the late answer is released and nothing shows it', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, made } = await setup();
    server.payments.set(made[0].id, [pay(1)]);
    // Close, then another invoice.
    server.hold.payments = 1;
    await open(1);
    await waitFor(() => expect(server.held).toHaveLength(1));
    await close();
    await open(2);
    await paymentsReady();
    server.held.shift()!.release();
    await settle();
    expect(summary()).toEqual(['No payment recorded', '$21.76', '$0.00', '$21.76']);
    expect(items()).toHaveLength(0);
    await close();
    // A store change while it is out.
    server.hold.payments = 1;
    await open(1);
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-payments')).toBeNull();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready');
    // Another tab's session while it is out: a new generation closes the dialog; its late answer finds nothing.
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    server.hold.payments = 1;
    await open(1);
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await focusEvents();
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-payments')).toBeNull();
    expect(server.writes()).toEqual([]);
  });

  it('SII-160b. R1 F5d: a late Load more answer after Close, or after a store change, changes nothing — the reopened invoice shows its own page one', async () => {
    const { server, made } = await setup((n) => (n === 2 ? { lines: [line(1, 'Long job', 1, 20_000)], tax: { mode: 'none' } } : {}));
    server.payments.set(made[1].id, Array.from({ length: 60 }, (_, i) => pay(i + 1)));
    for (const leave of ['close', 'store'] as const) {
      await open(2);
      await paymentsReady();
      server.hold.payments = 1;
      await click('issued-payments-load-more');
      await waitFor(() => expect(server.held).toHaveLength(1));
      if (leave === 'close') await close();
      else {
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
        await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
      }
      server.held.shift()!.release();
      await settle();
      expect(screen.queryByTestId('issued-payments'), leave).toBeNull();
      if (leave === 'store') {
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
        await listReady();
      }
      await open(2);
      await paymentsReady();
      expect(items(), leave).toHaveLength(50);
      expect(tid('issued-payments-load-more'), leave).toBeInTheDocument();
      await close();
    }
    expect(server.writes()).toEqual([]);
  });

  it('SII-160c. R1 F2: a Load more whose context is gone (a null answer, or the owner\'s context no longer current) keeps what is held — the rows, the summary and the cursor, no failure said; page one in that case is "could not be loaded", never "Loading" for good', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 1, () => ({ lines: [line(1, 'Long job', 1, 20_000)], tax: { mode: 'none' } }));
    const session = createTenantSessionClient({ fetch: server.fetch });
    const issuing = createInvoiceIssuingClient({ fetch: server.fetch });
    const s = await session.ensure('uid-a', async () => 'tok-a');
    if (s.kind !== 'ok') throw new Error('no session');
    const got = await issuing.getIssued(STORE_1, made[0].id, s.csrf);
    if (got.kind !== 'ok') throw new Error('no invoice');
    server.payments.set(made[0].id, Array.from({ length: 60 }, (_, i) => pay(i + 1)));
    const first = await issuing.getPayments(STORE_1, made[0].id, null, s.csrf);
    if (first.kind !== 'ok') throw new Error('no payments');
    let current = true;
    const base = { storeId: STORE_1, invoiceId: made[0].id, read: async (): Promise<IssuedReadAnswer> => ({ kind: 'ok', invoice: got.invoice }), current: () => current, waiting: false, onClose: () => {}, returnFocus: { current: null } };
    for (const gone of ['null', 'not current'] as const) {
      current = true;
      const read = vi.fn<IssuedPaymentsCapability['read']>(async (after) => {
        if (after === null) return { kind: 'ok', page: first.page };
        if (gone === 'not current') current = false;
        return gone === 'null' ? null : { kind: 'unavailable' };
      });
      render(<IssuedInvoiceDialog {...base} payments={{ read }} />);
      await paymentsReady();
      await click('issued-payments-load-more');
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await settle();
      expect(payPhase(), gone).toBe('ready');
      expect(tid('issued-payments-state').textContent, gone).toBe('');
      expect(items(), gone).toHaveLength(50);
      expect(summary(), gone).toEqual(['Payment recorded in part', '$200.00', '$60.00', '$140.00']);
      expect(tid('issued-payments-load-more'), gone).toHaveAttribute('aria-disabled', 'false');
      cleanup();
    }
    // Page one with its context gone: said unavailable, with Try again.
    current = true;
    const nothing = vi.fn<IssuedPaymentsCapability['read']>(async () => null);
    render(<IssuedInvoiceDialog {...base} payments={{ read: nothing }} />);
    await waitFor(() => expect(payPhase()).toBe('unavailable'));
    expect(tid('issued-payments-state')).toHaveTextContent(PAYMENTS_TEXT.unavailable);
    expect(tid('issued-payments-retry')).toBeInTheDocument();
  });

  it('SII-160d. R1 F4: when the focused "Try again" goes (its read starts), focus moves to the Payments heading, never to the body', async () => {
    const { server } = await setup();
    server.paymentsStatus.push(503);
    await open(2);
    await waitFor(() => expect(payPhase()).toBe('unavailable'));
    const retry = tid('issued-payments-retry');
    retry.focus();
    server.hold.payments = 1;
    await user().click(retry);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(screen.queryByTestId('issued-payments-retry')).toBeNull();
    const heading = screen.getByRole('heading', { name: 'Payments' });
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');
    server.held.shift()!.release();
    await paymentsReady();
    expect(document.activeElement).toBe(heading);
  });

  it('SII-161. a sign-out while page one is out, or its 401, ends the section the session-end way (the dialog closes; only Reconnect signs in again)', async () => {
    const { server, r } = await setup();
    server.hold.payments = 1;
    await open(2);
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { await r.props().session!.logout(); });
    await settle();
    expect(screen.queryByTestId('issued-view')).toBeNull();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-payments')).toBeNull();
    await click('issued-retry'); // Reconnect
    await storesReady();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    server.paymentsStatus.push(401);
    await open(2);
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-view')).toBeNull();
  });

  it('SII-162. a void confirmed in the dialog re-reads payments page one ONCE: the summary then says "Voided" with nothing due, never the issued amounts', async () => {
    const { server, made } = await setup();
    await open(2);
    await paymentsReady();
    expect(summary()).toEqual(['No payment recorded', '$21.76', '$0.00', '$21.76']);
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
    await click('issued-view-void');
    await waitFor(() => expect(screen.queryByTestId('issued-void-confirm')).not.toBeNull());
    await user().click(tid('issued-void-reason-wrong_customer'));
    await click('issued-void-send');
    await waitFor(() => expect(tid('issued-view-status')).toHaveTextContent('Voided'));
    await waitFor(() => expect(summary()).toEqual(['Voided', '$0.00', '$0.00', '$0.00']));
    await settle();
    expect(server.paymentReads()).toEqual([paymentsUrl(made[1].id), paymentsUrl(made[1].id)]);
  });

  it('SII-163. R1 F1: another tab voided it first — the dialog\'s void answers the sealed already-void; payments page one is read again ONCE and says "Voided" with nothing due', async () => {
    const { server, made } = await setup();
    await open(2);
    await paymentsReady();
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
    await click('issued-view-void');
    await waitFor(() => expect(screen.queryByTestId('issued-void-confirm')).not.toBeNull());
    made[1].void = { voidedAt: '2026-10-17T08:00:00.000001Z', reasonCode: 'duplicate' }; // another tab's void, after this review
    await user().click(tid('issued-void-reason-wrong_customer'));
    await click('issued-void-send');
    await waitFor(() => expect(tid('issued-view-status')).toHaveTextContent('Voided'));
    await waitFor(() => expect(summary()).toEqual(['Voided', '$0.00', '$0.00', '$0.00']));
    await settle();
    expect(server.paymentReads()).toEqual([paymentsUrl(made[1].id), paymentsUrl(made[1].id)]);
    expect(server.voidPosts()).toHaveLength(1);
  });
});

// M7B-PAYMENTS-P2B — recording a payment inside the Payments section and recovering an uncertain recording (spec §1-§8):
// the fake answers register, proof, record, settle and the attempts read as 037 does (session-bound keys for register and
// record, the whole scope before the sealed states). Keys come from the rig in order: the attempt id, then each stage's.
describe('Issued invoices — recording a payment and recovering it (M7B-PAYMENTS-P2B)', () => {
  const paymentsUrl = (invoiceId: string) => `${STORES_PATH}/${STORE_1}/invoices/${invoiceId}/payments`;
  const payPhase = () => screen.queryByTestId('issued-payments-state')?.getAttribute('data-phase') ?? 'none';
  const paymentsReady = () => waitFor(() => expect(payPhase()).toBe('ready'));
  const flow = () => screen.queryByTestId('issued-payments-flow')?.textContent ?? '';
  const rawHeld = (r: Rig): HeldPayment | undefined => r.payHolds.get('uid-a');
  /** R4: past REGISTER_QUIET_MS (the server's 60 s lease) since the register's last send, so a lookup's absence may decide it. */
  const quiet = (r: Rig) => { r.clock.mono += 60_000; r.clock.wall += 60_000; };
  /** The hold as assertions see it (R2 U1): its state words, and only WHETHER a token, bytes or a proof are held — never them. */
  const heldA = (r: Rig) => {
    const h = rawHeld(r);
    return h === undefined ? undefined : { state: h.state, stage: h.stage, say: h.say, csrf: h.csrf === null ? null : 'held', body: h.body === '' ? '' : 'held', proof: h.proof === null ? null : 'held' };
  };
  const posts = (server: Server, route: 'payment-registrations' | 'payments' | 'payment-settlement') => server.payRequests(route);
  const keyOf = (s: { headers: Headers }) => s.headers.get('idempotency-key');
  /** R2 U1: secret-bearing values (keys, proofs, tokens, bodies) are compared as booleans — never printed on a failure. */
  const same = (a: unknown, b: unknown, label: string) => expect(a === b, label).toBe(true);
  const apart = (server: Server, from = 0) => sentFrom(server, from).filter((line) => !line.includes(' /api/v1/session'));
  const regBody = (attemptId: string) => `{"expectedTenant":"${TENANT_A}","attemptId":"${attemptId}"}`;
  async function setup(over: (n: number) => Partial<Issued> = () => ({}), count = 3, recorder = true) {
    const server = seeded();
    if (recorder) server.recorders.add('uid-a');
    const made = issueAt(server, STORE_1, count, over);
    const r = rig(server);
    const view = render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    return { server, made, r, view };
  }
  async function open(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
    await paymentsReady();
  }
  async function openRecordable(n: number) {
    await open(n);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
  }
  async function close() {
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
  }
  async function fill(amount: string, method: 'cash' | 'card' | null = 'cash') {
    await click('issued-payments-record');
    typeAmount(amount);
    if (method !== null) await click(`issued-payments-method-${method}`);
  }
  /** The amount input (its own test id; P2A's rows carry issued-payments-amount). */
  const amountInput = () => within(tid('issued-payments-form')).getByTestId('issued-payments-amount-input');
  const typeAmount = (value: string) => fireEvent.change(amountInput(), { target: { value } });
  async function recordWith(amount: string, method: 'cash' | 'card' = 'cash') {
    await fill(amount, method);
    await click('issued-payments-submit');
  }

  it('SII-164. one Record press is ONE chain in order — register, the proof GET, the record — under three distinct v4 keys (the attempt id, the register key, the record key), the record\'s exact bytes in the fixed order; then payments page one ONCE; "Payment recorded: $12.50, Cash." with Confirm; Confirm is ONE settle v2 under a new key; "Payment confirmed." and nothing more is read; the proof never reaches the DOM or the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined); // never calls through (R2 U1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, made, r } = await setup();
    await openRecordable(3);
    const id = made[2].id;
    const reads = server.paymentReads().length;
    const mark = server.sent.length;
    await recordWith('12.50');
    await waitFor(() => expect(flow()).toBe(`Payment recorded: $12.50, Cash. ${"Confirm it to finish. Until you confirm, you can't record another payment."}`));
    await waitFor(() => expect(server.paymentReads()).toHaveLength(reads + 1));
    await settle();
    same(JSON.stringify(sentFrom(server, mark).filter((x) => !x.endsWith('/api/v1/session'))), JSON.stringify([
      `POST ${STORES_PATH}/${STORE_1}/invoices/${id}/payment-registrations`, `GET ${STORES_PATH}/${STORE_1}/invoices/${id}/payment-registration-proof?registration=${server.regs[0].id}`,
      `POST ${STORES_PATH}/${STORE_1}/invoices/${id}/payments`, `GET ${paymentsUrl(id)}`,
    ]), 'the exact request list (R4-8: compared, never printed)');
    const [attemptId, registerKey, recordKey] = r.keys;
    expect((r.keys).length).toBe(3);
    expect(new Set(r.keys).size).toBe(3);
    expect(r.keys.every((k) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(k)), 'three v4 keys').toBe(true);
    const [register] = posts(server, 'payment-registrations');
    const [record] = posts(server, 'payments');
    same(keyOf(register), registerKey, 'register key');
    same(register.body, regBody(attemptId), 'register bytes');
    same(keyOf(record), recordKey, 'record key');
    const proof = server.proofOf(server.regs[0]);
    same(record.body, `{"expectedTenant":"${TENANT_A}","registrationId":"${server.regs[0].id}","attemptId":"${attemptId}","amountCents":1250,"method":"cash","registrationProof":"${proof}"}`, 'record bytes in the fixed order');
    expect((server.payments.get(id)).length).toBe(1);
    expect(tid('issued-payments-remaining')).toHaveTextContent('$9.26');
    expect(screen.queryByTestId('issued-payments-record')).toBeNull(); // until confirmed, no other recording here
    const afterRecord = server.sent.length;
    await click('issued-payments-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await settle();
    expect(sentFrom(server, afterRecord).filter((x) => !x.endsWith('/api/v1/session'))).toEqual([`POST ${STORES_PATH}/${STORE_1}/invoices/${id}/payment-settlement`]);
    const [settle2] = posts(server, 'payment-settlement');
    same(keyOf(settle2), r.keys[3], 'settle key');
    same(settle2.body, `{"expectedTenant":"${TENANT_A}","attemptId":"${attemptId}","expectedVersion":2}`, 'settle bytes');
    expect(server.regs[0].state).toBe('confirmed');
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'confirmed', body: '', proof: null });
    expect(server.payBodyViolations).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull()); // recordable again
    expect(document.body.innerHTML.includes(proof), 'no proof in the DOM').toBe(false);
    for (const spy of [log, warn, error]) for (const call of spy.mock.calls) expect(JSON.stringify(call).includes(proof), 'no proof logged').toBe(false);
    expect(JSON.stringify(rawHeld(r)).includes(proof), 'no proof held after the record').toBe(false);
  });

  it('SII-165. the form checks everything first and sends nothing on an error: each amount rule and the method say why in an alert, the first invalid field takes focus; labels, legend and hint as worded', async () => {
    const { server } = await setup();
    await openRecordable(3);
    await click('issued-payments-record');
    expect(tid('issued-payments-form')).toHaveTextContent('Record a payment');
    expect(screen.getByLabelText('Amount (USD)')).toBe(amountInput());
    expect(tid('issued-payments-form')).toHaveTextContent('Up to $21.76 remaining.');
    expect(screen.getByRole('radio', { name: 'Cash' })).toBe(tid('issued-payments-method-cash'));
    expect(screen.getByRole('radio', { name: 'Card on a separate terminal' })).toBe(tid('issued-payments-method-card'));
    expect(tid('issued-payments-method-cash')).not.toBeChecked(); // no default
    expect(amountInput()).toHaveFocus();
    for (const [amount, text] of [
      ['', 'Enter an amount, such as 12.50.'], ['abc', 'Enter an amount, such as 12.50.'], ['1.234', 'Enter an amount with no more than two decimal places.'],
      ['0.00', 'Enter an amount of at least $0.01.'], ['21.77', "The amount can't be more than the $21.76 remaining."],
    ]) {
      typeAmount(amount);
      await click('issued-payments-submit');
      const alerts = within(tid('issued-payments-form')).getAllByRole('alert').map((a) => a.textContent);
      expect(alerts, amount).toEqual([text, 'Choose how the payment was taken.']);
      expect(amountInput()).toHaveFocus();
      expect(amountInput()).toHaveAttribute('aria-invalid', 'true');
    }
    typeAmount('21.76');
    await click('issued-payments-submit');
    expect(within(tid('issued-payments-form')).getAllByRole('alert').map((a) => a.textContent)).toEqual(['Choose how the payment was taken.']);
    expect(tid('issued-payments-method-cash')).toHaveFocus();
    expect((server.payRequests().filter((x) => x.method === 'POST')).length).toBe(0);
    await click('issued-payments-cancel');
    expect(screen.queryByTestId('issued-payments-form')).toBeNull();
    expect(tid('issued-payments-record')).toHaveFocus();
  });

  it('SII-166. "Record payment" only for the eligibility read\'s exact allowed: a 403 hides it (never retried on a focus or a tab return), a voided invoice sends no eligibility read, nothing remaining offers nothing; an open is 4 requests issued, 3 voided', async () => {
    const { server, made } = await setup((n) => (n === 1 ? { void: { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' } } : {}), 3, false);
    await open(3);
    await waitFor(() => expect((server.payRequests('payment-eligibility')).length).toBe(1));
    await settle();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    await focusEvents();
    await settle();
    expect((server.payRequests('payment-eligibility')).length).toBe(1);
    await close();
    await open(1); // voided
    await settle();
    expect((server.payRequests('payment-eligibility')).length).toBe(1);
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    await close();
    server.recorders.add('uid-a');
    server.payments.set(made[1].id, [{ id: uuid(0x9001), attemptId: uuid(0xa001), amountCents: 2176, method: 'cash', recordedAt: '2026-10-17T09:00:01.000001Z', reversal: null }]);
    await open(2); // recorded in full: nothing remaining
    await waitFor(() => expect((server.payRequests('payment-eligibility')).length).toBe(2));
    await settle();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    await close();
    server.payEligStatus.push(new Response(JSON.stringify({ eligibility: 'allowed', x: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await open(3); // a malformed allowed
    await waitFor(() => expect((server.payRequests('payment-eligibility')).length).toBe(3));
    await settle();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
  });

  it('SII-167. a double press is ONE chain: a second submit or Enter while the first is out sends no second register; while the attempt is out the Record control is gone', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.hold.register = 1;
    await fill('5.00');
    const form = tid('issued-payments-form');
    act(() => { fireEvent.submit(form); fireEvent.submit(form); }); // both in one batch, before any re-render (R1 T1)
    await waitFor(() => expect(server.held).toHaveLength(1));
    await settle();
    expect((posts(server, 'payment-registrations')).length).toBe(1);
    expect((r.keys).length).toBe(2); // one attempt id, one register key
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    expect(flow()).toBe('Recording the payment…');
    server.held.shift()!.release();
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    expect((posts(server, 'payment-registrations')).length).toBe(1);
    expect((posts(server, 'payments')).length).toBe(1);
    expect((server.payments.get(server.regs[0].invoiceId)).length).toBe(1);
    // The Enter path: Enter twice in the amount field is one chain too.
    await click('issued-payments-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await close();
    await openRecordable(2);
    await fill('1.00');
    await user().type(amountInput(), '{Enter}{Enter}');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    await settle();
    expect((posts(server, 'payment-registrations')).length).toBe(2);
    expect((r.keys).length).toBe(7); // 3 + the confirmation's + 3: never a second chain
  });

  it('SII-168. a LOST record answer (committed) leaves the attempt unresolved — nothing is sent again on its own (focus, a tab return, time) — and Check again re-sends the SAME key and byte-identical bytes with the same session; the replay\'s 201 records it; one payment', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    const mark = server.sent.length;
    await recordWith('3.00', 'card');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    expect(flow()).toBe("We couldn't confirm whether this payment was recorded. Nothing is sent again unless you press Check again.");
    const base = `${STORES_PATH}/${STORE_1}/invoices/${made[2].id}`;
    same(JSON.stringify(apart(server, mark)), JSON.stringify([`POST ${base}/payment-registrations`, `GET ${base}/payment-registration-proof?registration=${server.regs[0].id}`, `POST ${base}/payments`]), 'the exact request list (R4-8: compared, never printed)');
    expect((server.payments.get(made[2].id)).length).toBe(1); // the server committed it
    await focusEvents();
    fakeClock();
    await advance(10 * 60_000);
    vi.useRealTimers();
    await settle();
    expect((posts(server, 'payments')).length).toBe(1);
    expect(screen.getByTestId('issued-payments-find')).toBeInTheDocument();
    const beforeCheck = server.sent.length;
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    await waitFor(() => same(JSON.stringify(apart(server, beforeCheck)), JSON.stringify([`POST ${base}/payments`, `GET ${base}/payments`]), 'the held stage, then page one once'));
    const [first, again] = posts(server, 'payments');
    expect(again.url).toBe(first.url);
    same(again.body, first.body, 'the same bytes');
    for (const h of ['idempotency-key', 'x-tmpos-session-csrf', 'x-tmpos-csrf', 'content-type']) same(again.headers.get(h), first.headers.get(h), h);
    expect((r.keys).length).toBe(3);
    expect((server.payments.get(made[2].id)).length).toBe(1);
    expect(flow()).toContain('Payment recorded: $3.00, Card on a separate terminal.');
  });

  const UNCERTAIN = "We couldn't confirm whether this payment was recorded. Nothing is sent again unless you press Check again.";
  const DETACHED = "This payment attempt can't be checked from here any more. Find it to finish it.";
  /** G1: a record 404 is a registration, session or key mismatch — never "this invoice is missing". */
  const RECORD_404 = "This payment couldn't be finished from here. It may or may not have been recorded. No new payment will be sent. Find this payment attempt to finish it.";
  const finishOn = (n: number, store?: string) => `Finish your payment attempt on invoice ${n}${store === undefined ? '' : ` at ${store}`} first.`;
  const sealed409 = (error: string) => new Response(JSON.stringify({ error }), { status: 409, headers: { 'content-type': 'application/json' } });
  const attemptsReads = (server: Server) => server.payRequests('payment-attempts').map((x) => x.url);

  it('SII-169. a 429 on the register\'s first send keeps the attempt (nothing ran) and its wait: Check again is held back with the wait said until Retry-After has passed (fake clock: 29 s still held, 30 s given back), then sends exactly ONE register under the SAME key and bytes and the chain goes on', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.retryAfter = '30';
    server.payScripts.register.push(429);
    await fill('2.00');
    fakeClock();
    fireEvent.submit(tid('issued-payments-form'));
    await until(() => expect(heldA(r)?.state).toBe('unresolved'));
    expect(flow()).toBe(`${UNCERTAIN} ${pickerWaitText(30)}`);
    expect(tid('issued-payments-check')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(tid('issued-payments-check'));
    await advance(29_000);
    expect(tid('issued-payments-check')).toHaveAttribute('aria-disabled', 'true');
    expect((posts(server, 'payment-registrations')).length).toBe(1);
    await advance(1_000);
    await until(() => expect(tid('issued-payments-check')).toHaveAttribute('aria-disabled', 'false'));
    vi.useRealTimers();
    const before = posts(server, 'payment-registrations').length;
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    const regs = posts(server, 'payment-registrations');
    expect((regs).length).toBe(before + 1);
    const [first, again] = regs;
    same(keyOf(again), keyOf(first), 'the same key');
    same(again.body, first.body, 'the same bytes');
  });

  it('SII-170. a record 404 NEVER gets a fresh key or a resend: the attempt is never sent again, the lookup runs, and its open row offers the deliberate "Withdraw attempt" (settle v1): "Attempt withdrawn. No payment was recorded."', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(404);
    const mark = server.sent.length;
    await recordWith('4.00');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'ready'));
    const base = `${STORES_PATH}/${STORE_1}/invoices/${made[2].id}`;
    same(JSON.stringify(apart(server, mark)), JSON.stringify([`POST ${base}/payment-registrations`, `GET ${base}/payment-registration-proof?registration=${server.regs[0].id}`, `POST ${base}/payments`,
      `GET ${STORES_PATH}/${STORE_1}/payment-attempts`]), 'the exact request list (R4-8: compared, never printed)');
    expect(flow()).toBe(RECORD_404);
    expect(heldA(r)).toMatchObject({ state: 'lookup', body: '', proof: null });
    expect(screen.queryByTestId('issued-payments-check')).toBeNull();
    const rows = screen.getAllByTestId('issued-payments-attempt');
    expect(rows.map((x) => x.getAttribute('data-attempt-state'))).toEqual(['open']);
    expect(rows[0]).toHaveTextContent(/^Attempt started 2026-10-17 10:00:00 UTC: no payment recorded\.Withdraw attempt$/);
    const beforeWithdraw = server.sent.length;
    await click('issued-payments-withdraw');
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    await settle();
    expect(apart(server, beforeWithdraw)).toEqual([`POST ${base}/payment-settlement`]);
    expect((posts(server, 'payments')).length).toBe(1);
    const [withdraw] = posts(server, 'payment-settlement');
    same(withdraw.body, `{"expectedTenant":"${TENANT_A}","attemptId":"${r.keys[0]}","expectedVersion":1}`, 'withdraw bytes');
    expect((r.keys).length).toBe(4); // attempt, register, record, settle: never a second record key
    expect(server.regs[0].state).toBe('withdrawn');
    expect((server.payments.get(made[2].id) ?? []).length).toBe(0);
    expect((attemptsReads(server)).length).toBe(1);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull()); // a new attempt may start
  });

  it('SII-171. a page load after a lost record answer (a new hold, a remount): Record → the register\'s sealed write_conflict says so, the lookup finds the recorded attempt, and its deliberate Confirm (settle v2) releases it; payments page one once more; still ONE payment', async () => {
    const { server, made, r, view } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('3.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    view.unmount();
    const fresh = createPaymentHoldStore({ now: () => r.clock.mono, wallNow: () => r.clock.wall });
    render(<ServerIssuedInvoices {...r.props({ paymentHolds: fresh })} />);
    await showAndChoose(STORE_1);
    await listReady();
    await openRecordable(3);
    await recordWith('3.00');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'ready'));
    expect(flow()).toBe('You have an unfinished payment attempt on this invoice. Finish it before recording another payment.');
    const row = screen.getByTestId('issued-payments-attempt');
    expect(row).toHaveAttribute('data-attempt-state', 'recorded');
    expect(row).toHaveTextContent('Attempt started 2026-10-17 10:00:00 UTC: $3.00, Cash recorded 2026-10-17 11:00:00 UTC.');
    const reads = server.paymentReads().length;
    await click('issued-payments-attempt-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await waitFor(() => expect(server.paymentReads()).toHaveLength(reads + 1));
    expect(server.regs.map((g) => g.state)).toEqual(['confirmed']);
    expect((server.payments.get(made[2].id)).length).toBe(1);
    expect((posts(server, 'payments')).length).toBe(1);
  });

  it('SII-172. a sealed amount_exceeds_remaining records nothing and the registration stays open: said, payments page one again, the lookup offers Withdraw; afterwards a new press mints a NEW attempt id and NEW keys', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(sealed409('amount_exceeds_remaining'));
    const reads = server.paymentReads().length;
    await recordWith('6.00');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'ready'));
    expect(flow()).toBe('No payment was recorded: the amount is more than the remaining balance. Withdraw the attempt, then record the correct amount.');
    await waitFor(() => expect(server.paymentReads()).toHaveLength(reads + 1));
    await click('issued-payments-withdraw');
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    const regs = posts(server, 'payment-registrations');
    expect((regs).length).toBe(2);
    same(regs[1].body, regBody(r.keys[4]), 'a new attempt id');
    expect(new Set(r.keys).size).toBe(r.keys.length);
  });

  it('SII-173. a store switch (even back to the attempt\'s own store) and a session change DETACH an unresolved attempt for good: it says so, no Check again, Find stays; nothing is ever re-sent', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('3.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    await close();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
    await settle();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    expect(heldA(r)).toMatchObject({ csrf: null, body: '', proof: null, state: 'unresolved' });
    await open(3);
    expect(flow()).toBe(DETACHED);
    expect(screen.queryByTestId('issued-payments-check')).toBeNull();
    await settle();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull(); // G1b: registered, only Find and a settlement decide it — never a fresh key
    expect(tid('issued-payments-find')).toBeInTheDocument();
    await focusEvents();
    await settle();
    expect((posts(server, 'payments')).length).toBe(1);
    // A session change: another tab's login rotates the token — the next check adopts it and detaches.
    await click('issued-payments-find');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'ready'));
    await click('issued-payments-attempt-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await close();
    await openRecordable(2);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.otherTab('uid-a');
    await focusEvents();
    await waitFor(() => expect(heldA(r)?.csrf).toBeNull());
    expect(heldA(r)).toMatchObject({ body: '', state: 'unresolved', say: 'detached' });
    await storesReady(); // the new generation reads the stores again and closes the dialog
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(2);
    expect(flow()).toBe(DETACHED);
    expect(screen.queryByTestId('issued-payments-check')).toBeNull();
    expect(tid('issued-payments-find')).toBeInTheDocument();
    expect((posts(server, 'payments')).length).toBe(2);
  });

  it('SII-174. 23 hours after the stage\'s FIRST send (the larger of monotonic and wall time) Check again is gone for good and nothing is sent; Find stays', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('3.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    r.clock.mono += 23 * HOUR - 1; // just under, by the monotonic clock: still offered
    await focusEvents();
    await settle();
    expect(tid('issued-payments-check')).toBeInTheDocument();
    r.clock.mono += 1; // 23 h exactly by the monotonic clock (the wall clock never moved)
    await focusEvents();
    await waitFor(() => expect(screen.queryByTestId('issued-payments-check')).toBeNull());
    expect(flow()).toBe(DETACHED);
    expect(heldA(r)?.body).toBe('');
    expect(tid('issued-payments-find')).toBeInTheDocument();
    expect((posts(server, 'payments')).length).toBe(1);
  });

  it('SII-175. answers that come back after the dialog closed or while another invoice is open change only the hold: the other invoice offers no Record while it is undecided at this store and names the invoice to finish, and the attempt\'s own invoice shows it on its next open', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.hold.record = 1;
    await recordWith('2.50');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await close();
    await open(2);
    server.held.shift()!.release();
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    await settle();
    expect(flow()).toBe(finishOn(3)); // codexMED: the blocked invoice names the one to finish
    expect(screen.queryByTestId('issued-payments-confirm')).toBeNull();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    await close();
    await open(3);
    expect(flow()).toContain('Payment recorded: $2.50, Cash.');
    expect(tid('issued-payments-confirm')).toBeInTheDocument();
  });

  it('SII-176. the lookup pages GET payment-attempts from the start until nextCursor is null, keeps only this invoice\'s open/recorded rows, and a COMPLETE read started 60 s after the register\'s last send without the held attempt\'s row decides it (037 lists every unsettled registration): nothing sent, Record back', async () => {
    const { server, made, r } = await setup();
    // 101 earlier attempts of this user at the store, on the two other invoices: three pages of 50, 50 and 1.
    for (let i = 0; i < 101; i++) {
      server.regs.push({ id: uuid(0x4f00 + i), uid: 'uid-a', storeId: STORE_1, invoiceId: made[i % 2].id, number: made[i % 2].number, attemptId: uuid(0xaf00 + i), csrf: 'x', proof: server.newProof(),
        state: i === 0 ? 'open' : 'withdrawn', registeredAt: `2026-10-17T08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000001Z`,
        settledAt: i === 0 ? null : '2026-10-17T08:30:00.000001Z', payment: null });
    }
    // THIS invoice's settled attempts (withdrawn, confirmed) are listed by the server but never offered (R1 T9).
    server.regs.push({ id: uuid(0x4fa0), uid: 'uid-a', storeId: STORE_1, invoiceId: made[2].id, number: made[2].number, attemptId: uuid(0xafa0), csrf: 'x', proof: server.newProof(),
      state: 'withdrawn', registeredAt: '2026-10-17T09:00:00.000001Z', settledAt: '2026-10-17T09:10:00.000001Z', payment: null });
    server.regs.push({ id: uuid(0x4fa1), uid: 'uid-a', storeId: STORE_1, invoiceId: made[2].id, number: made[2].number, attemptId: uuid(0xafa1), csrf: 'x', proof: server.newProof(),
      state: 'confirmed', registeredAt: '2026-10-17T09:00:01.000001Z', settledAt: '2026-10-17T09:10:00.000001Z',
      payment: { id: uuid(0x9fa1), attemptId: uuid(0xafa1), amountCents: 100, method: 'cash', recordedAt: '2026-10-17T09:05:00.000001Z', reversal: null } });
    await openRecordable(3);
    server.payScripts.register.push('lose-before');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    quiet(r); // R4: within 60 s the register may still be committing (SII-213)
    await click('issued-payments-find');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'ready'));
    expect(JSON.stringify(attemptsReads(server)) === JSON.stringify([
      `${STORES_PATH}/${STORE_1}/payment-attempts`, `${STORES_PATH}/${STORE_1}/payment-attempts?after=${made[1].id}.${uuid(0xaf00 + 49)}`,
      `${STORES_PATH}/${STORE_1}/payment-attempts?after=${made[1].id}.${uuid(0xaf00 + 99)}`,
    ]), 'the three attempts pages, cursor by cursor').toBe(true);
    expect(tid('issued-payments-attempts')).toHaveTextContent('No unfinished payment attempts were found on this invoice.');
    expect(screen.queryAllByTestId('issued-payments-attempt').length).toBe(0);
    // R3 (L-M1): a COMPLETE read lists every unsettled registration whatever its age; no row of it decides it, nothing sent.
    expect(heldA(r)).toMatchObject({ state: 'done', body: '', proof: null });
    expect(screen.queryByTestId('issued-payments-check')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
    expect(posts(server, 'payment-registrations').length).toBe(1);
  });

  const lookupReady = () => waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'ready'));
  const reg = (server: Server, i: number, over: Partial<Server['regs'][number]>) => ({
    id: uuid(0x4c00 + i), uid: 'uid-a', storeId: STORE_1, invoiceId: '', number: 1, attemptId: uuid(0xac00 + i), csrf: 'x', proof: server.newProof(), state: 'open' as const,
    registeredAt: `2026-10-17T07:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000001Z`, settledAt: null, payment: null, ...over,
  });

  it('SII-177. answers that come back after a STORE change or a SESSION change while a request is out change nothing on screen and send nothing more: the attempt is detached (never "sending"), its chain stops there', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.hold.record = 1;
    await recordWith('2.00');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await close();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
    await settle();
    const mark = server.sent.length;
    server.held.shift()!.release(); // the record commits now; its answer comes back to another store
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', say: 'detached', csrf: null, body: '' }));
    await settle();
    expect(apart(server, mark)).toEqual([]);
    expect((server.payments.get(made[2].id)).length).toBe(1);
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(3);
    expect(flow()).toBe(DETACHED);
    await click('issued-payments-find');
    await lookupReady();
    await click('issued-payments-attempt-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await close();
    // A session change while the register is out: no proof GET follows its late answer.
    await openRecordable(2);
    server.hold.register = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await focusEvents();
    await waitFor(() => expect(heldA(r)?.csrf).toBeNull());
    const at = server.sent.length;
    server.held.shift()!.release();
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', say: 'detached' }));
    await settle();
    expect(apart(server, at).filter((x) => x.includes('payment'))).toEqual([]);
    expect((server.payRequests('payment-registration-proof')).length).toBe(1); // only the first attempt's
  });

  it('SII-178. a record that COMMITS and then answers 404 (037 checks the scope first) is never sent again and gets no fresh key: the lookup shows the recorded row, its Confirm settles it (v2); ONE payment', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('commit-404');
    await recordWith('5.00');
    await lookupReady();
    expect(flow()).toBe(RECORD_404);
    expect((r.keys).length).toBe(3);
    const row = screen.getByTestId('issued-payments-attempt');
    expect(row).toHaveAttribute('data-attempt-state', 'recorded');
    await click('issued-payments-attempt-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    expect((posts(server, 'payments')).length).toBe(1);
    expect((server.payments.get(made[2].id)).length).toBe(1);
    expect(server.regs[0].state).toBe('confirmed');
    same(posts(server, 'payment-settlement')[0].body, JSON.stringify({ expectedTenant: TENANT_A, attemptId: r.keys[0], expectedVersion: 2 }), 'confirm bytes');
  });

  it('SII-179. the proof: a 503 leaves the attempt unresolved and Check again repeats the SAME GET (no key), then the record goes on; a 404 means the registration cannot be sent here — the lookup decides it', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.proof.push(503);
    await recordWith('1.50');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    expect(heldA(r)?.stage).toBe('proof');
    expect(flow()).toBe(UNCERTAIN);
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    const proofs = server.payRequests('payment-registration-proof').map((x) => x.url);
    expect(proofs.length).toBe(2);
    same(proofs[1], proofs[0], 'the same proof GET repeated');
    expect((posts(server, 'payments')).length).toBe(1);
    await click('issued-payments-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await close();
    await openRecordable(2);
    server.payScripts.proof.push(404);
    await recordWith('1.00');
    await lookupReady();
    expect(flow()).toBe(DETACHED);
    expect(heldA(r)).toMatchObject({ state: 'lookup', body: '', proof: null });
    expect(screen.getByTestId('issued-payments-attempt')).toHaveAttribute('data-attempt-state', 'open');
    expect((posts(server, 'payments')).length).toBe(1);
  });

  it('SII-180. a settlement out says "Confirming…"; an uncertain one is retried ONLY by Check again (same key and bytes) — the lookup row\'s Confirm is held back meanwhile; a sealed write_conflict re-runs the lookup', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    server.hold.settle = 1;
    await click('issued-payments-confirm');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(flow()).toBe('Confirming…');
    server.held.shift()!.release(new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'r' }), { status: 503, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    await click('issued-payments-find');
    await lookupReady();
    const rowConfirm = tid('issued-payments-attempt-confirm');
    expect(rowConfirm).toHaveAttribute('aria-disabled', 'true');
    await user().click(rowConfirm);
    await settle();
    expect((posts(server, 'payment-settlement')).length).toBe(1);
    await click('issued-payments-check');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    const [first, again] = posts(server, 'payment-settlement');
    same(keyOf(again), keyOf(first), 'the same key');
    same(again.body, first.body, 'the same bytes');
    // A sealed write_conflict on a row's settlement: the lookup runs again.
    await close();
    await openRecordable(2);
    server.payScripts.record.push(404);
    await recordWith('1.00');
    await lookupReady();
    const reads = server.payRequests('payment-attempts').length;
    server.payScripts.settle.push(sealed409('write_conflict'));
    await click('issued-payments-withdraw');
    await waitFor(() => expect((server.payRequests('payment-attempts')).length).toBe(reads + 1));
    await lookupReady();
  });

  it('SII-181. a lookup that fails says "Your payment attempts could not be loaded." with Try again, which takes focus to the Payments heading as it goes and reads again; past 20 pages the cap is said; neither a failed nor a capped read decides the attempt, a complete one without its row (60 s after the register\'s last send) does, reached by Try again after a failed read', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.register.push('lose-before');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.attemptsStatus.push(503);
    await click('issued-payments-find');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'failed'));
    expect(tid('issued-payments-attempts')).toHaveTextContent('Your payment attempts could not be loaded.');
    expect(heldA(r)?.state, 'a failed read never decides').toBe('unresolved');
    // Settled ones (listed for 24 h): one unsettled registration per staff member and invoice is all the server allows (037).
    for (let i = 0; i < 1001; i++) server.regs.push(reg(server, i, { invoiceId: made[i % 2].id, number: made[i % 2].number, state: 'withdrawn', settledAt: '2026-10-17T08:30:00.000001Z' }));
    const before = server.payRequests('payment-attempts').length;
    tid('issued-payments-attempts-retry').focus();
    await click('issued-payments-attempts-retry');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'cap'));
    expect(document.getElementById('issued-payments-title')).toHaveFocus();
    expect(tid('issued-payments-attempts')).toHaveTextContent('There are too many payment attempts to check here.');
    expect((server.payRequests('payment-attempts')).length).toBe(before + 20);
    expect(heldA(r)?.state, 'a capped read never decides').toBe('unresolved');
    expect(tid('issued-payments-check')).toBeInTheDocument();
    server.regs.splice(0);
    server.attemptsStatus.push(503);
    await click('issued-payments-find');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'failed'));
    expect(heldA(r)?.state, 'a failed read never decides').toBe('unresolved');
    quiet(r); // R4: within 60 s of the register's last send absence decides nothing (SII-213)
    await click('issued-payments-attempts-retry');
    await lookupReady();
    expect(heldA(r)?.state, 'a complete read without its row decides').toBe('done');
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
  });

  const chain422 = () => new Response(JSON.stringify({ error: 'idempotency_key_reused', requestId: 'r' }), { status: 422, headers: { 'content-type': 'application/json' } });

  it('SII-182. a lookup row that is withdrawn or confirmed for the HELD attempt decides it (as a complete read\'s absence does): confirmed → "Payment confirmed." and page one once more; withdrawn → "Attempt withdrawn. No payment was recorded."', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    Object.assign(server.regs[0], { state: 'confirmed', settledAt: '2026-10-17T12:00:00.000001Z' }); // another tab confirmed it
    const reads = server.paymentReads().length;
    await click('issued-payments-find');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await waitFor(() => expect(server.paymentReads()).toHaveLength(reads + 1));
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'confirmed' });
    await close();
    await openRecordable(2);
    server.payScripts.register.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    Object.assign(server.regs[1], { state: 'withdrawn', settledAt: '2026-10-17T12:00:00.000001Z' });
    await click('issued-payments-find');
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    expect((posts(server, 'payment-settlement')).length).toBe(0);
  });

  it('SII-183. decided first answers: the register\'s 403 says "You cannot record payments…" and takes Record away; its sealed invalid_state or already_recorded say "can\'t take this payment now" and read page one again, nothing held; the record\'s sealed invalid_state says so and runs the lookup', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.register.push(403);
    await recordWith('1.00');
    await waitFor(() => expect(flow()).toBe('You cannot record payments for this invoice at this store.'));
    expect(heldA(r)?.state).toBe('done');
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    await close();
    for (const word of ['invalid_state', 'already_recorded']) {
      await openRecordable(2);
      server.payScripts.register.push(sealed409(word));
      const reads = server.paymentReads().length;
      await recordWith('1.00');
      await waitFor(() => expect(flow()).toBe("No payment was recorded: this invoice can't take this payment now."));
      await waitFor(() => expect(server.paymentReads()).toHaveLength(reads + 1));
      expect(heldA(r)?.state).toBe('done');
      await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
      await close();
    }
    await openRecordable(2);
    server.payScripts.record.push(sealed409('invalid_state'));
    await recordWith('1.00');
    await lookupReady();
    expect(flow()).toBe("No payment was recorded: this invoice can't take this payment now. Find this payment attempt to finish it.");
    expect(heldA(r)?.state).toBe('lookup');
  });

  it('SII-184. a Check again answered 403 stays unresolved (with Check again); answered 401 the session ends and the attempt is detached, never decided; a register whose request never arrived is replayed by Check again with the SAME key and bytes', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.register.push('lose-before');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.payScripts.register.push(403);
    await click('issued-payments-check');
    await waitFor(() => expect((posts(server, 'payment-registrations')).length).toBe(2));
    await settle();
    expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'register' });
    expect(tid('issued-payments-check')).toBeInTheDocument();
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    const regs = posts(server, 'payment-registrations');
    expect(new Set(regs.map((x) => `${keyOf(x)}|${x.body}`)).size).toBe(1);
    await click('issued-payments-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await close();
    await openRecordable(2);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.payScripts.record.push(401);
    await click('issued-payments-check');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(heldA(r)).toMatchObject({ state: 'unresolved', csrf: null, body: '' });
  });

  it('SII-185. a sign-out while the record is out (R1 S1): the attempt is detached at once and its late answer never leaves it "sending" — it stays unresolved, never sent again', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.hold.record = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { await r.props().session!.logout(); });
    await waitFor(() => expect(heldA(r)).toMatchObject({ csrf: null, state: 'unresolved', say: 'detached', body: '', proof: null }));
    server.held.shift()!.release();
    await settle();
    expect(heldA(r)).toMatchObject({ csrf: null, state: 'unresolved', say: 'detached' });
    expect((posts(server, 'payments')).length).toBe(1);
  });

  it('SII-186. a register sealed write_conflict (an earlier attempt of this user holds the invoice) holds nothing for this press — no phantom block — says so and runs the lookup, whose Confirm releases the earlier one; Record waits for that Confirm while the lookup lists it (R5 B)', async () => {
    const { server, made, r } = await setup();
    server.regs.push(reg(server, 1, { invoiceId: made[2].id, number: made[2].number, state: 'recorded',
      payment: { id: uuid(0x9c01), attemptId: uuid(0xac01), amountCents: 300, method: 'cash', recordedAt: '2026-10-17T07:30:00.000001Z', reversal: null } }));
    await openRecordable(3);
    await recordWith('1.00');
    await lookupReady();
    expect(flow()).toBe('You have an unfinished payment attempt on this invoice. Finish it before recording another payment.');
    expect(heldA(r)?.state).toBe('done');
    expect(screen.queryByTestId('issued-payments-record'), 'R5 B: no Record while the lookup lists the earlier attempt').toBeNull();
    expect(screen.getByTestId('issued-payments-attempt')).toHaveAttribute('data-attempt-state', 'recorded');
    await click('issued-payments-attempt-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    expect(server.regs[0].state).toBe('confirmed');
    expect((posts(server, 'payments')).length).toBe(0);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record'), 'nothing of this press blocks: settled, Record returns').not.toBeNull());
  });

  it('SII-187. (synthetic: two unsettled rows on one invoice meet only in a paging race) while one attempt is undecided another lookup row\'s action is held back with "Finish the payment attempt above first." and sends nothing; the held attempt is never dropped for it', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    // R6: synthetic — the server allows one unsettled registration per staff member and invoice (037), so two such rows can only
    // meet in one lookup through a paging race; this pins the defensive hold-back for that case.
    server.regs.push(reg(server, 2, { invoiceId: made[2].id, number: made[2].number, registeredAt: '2026-10-17T23:00:00.000001Z' }));
    await click('issued-payments-find');
    await lookupReady();
    const rows = screen.getAllByTestId('issued-payments-attempt');
    expect(rows.map((x) => x.getAttribute('data-attempt-state'))).toEqual(['recorded', 'open']);
    const other = within(rows[1]).getByTestId('issued-payments-withdraw');
    expect(other).toHaveAttribute('aria-disabled', 'true');
    expect(rows[1]).toHaveTextContent('Finish the payment attempt above first.');
    expect(other.getAttribute('aria-describedby')?.split(' ').includes('issued-payments-attempt-note-1')).toBe(true); // keyed by position (R3-1)
    // R4-3: the id resolves to the note itself, and no attempt id is anywhere in the DOM.
    expect(document.getElementById('issued-payments-attempt-note-1')?.textContent === 'Finish the payment attempt above first.', 'describedby resolves to the note').toBe(true);
    expect(document.body.innerHTML.includes(r.keys[0]) || document.body.innerHTML.includes(uuid(0xac02)), 'no attempt id in the DOM').toBe(false);
    await user().click(other);
    await settle();
    expect((posts(server, 'payment-settlement')).length).toBe(0);
    same(rawHeld(r)?.key, r.keys[0], 'the held attempt stays');
    expect(within(rows[0]).getByTestId('issued-payments-attempt-confirm')).toHaveAttribute('aria-disabled', 'false');
  });

  it('SII-188. Confirm works while the post-record page-one read is still out (R1 S12): ONE settle v2, "Payment confirmed."', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.hold.payments = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['payments']));
    expect(heldA(r)?.state).toBe('recorded');
    await click('issued-payments-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    expect((posts(server, 'payment-settlement')).length).toBe(1);
    server.held.shift()!.release();
    await paymentsReady();
  });

  it('SII-189. a 422 (another request under this key) is never Check-again-able: lookup only — the attempt never sent again, the lookup runs', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(chain422());
    await recordWith('1.00');
    await lookupReady();
    expect(heldA(r)).toMatchObject({ state: 'lookup', body: '' });
    expect(flow()).toBe(DETACHED);
    expect(screen.queryByTestId('issued-payments-check')).toBeNull();
    expect((posts(server, 'payments')).length).toBe(1);
  });

  it('SII-190. R2: a record-stage sealed write_conflict, a record 404 with a non-envelope body and a 422 with a non-envelope body are each lookup-only — never Check-again-able, never sent again; the lookup runs', async () => {
    const { server, r } = await setup();
    const cases: Array<[number, Response, string]> = [
      [3, sealed409('write_conflict'), DETACHED],
      [2, new Response('gone', { status: 404 }), RECORD_404],
      [1, new Response(JSON.stringify({ x: 1 }), { status: 422, headers: { 'content-type': 'application/json' } }), DETACHED],
    ];
    for (const [n, answer, text] of cases) {
      await openRecordable(n);
      const records = posts(server, 'payments').length;
      server.payScripts.record.push(answer);
      await recordWith('1.00');
      await lookupReady();
      expect(heldA(r), String(n)).toMatchObject({ state: 'lookup', body: '', proof: null });
      expect(flow(), String(n)).toBe(text);
      expect(screen.queryByTestId('issued-payments-check'), String(n)).toBeNull();
      expect(posts(server, 'payments').length, String(n)).toBe(records + 1);
      // G3: an undecided attempt past its registration is finished on its own invoice before another records.
      await click('issued-payments-withdraw');
      await waitFor(() => expect(flow(), String(n)).toBe('Attempt withdrawn. No payment was recorded.'));
      await close();
    }
  });

  it('SII-191. G1: after a record 404 "Record payment" is not offered on that invoice and nothing new is minted or registered (doc 15 §12.12: never a resubmission under a fresh key) — Find stays; once another tab withdrew it and a later attempt registered (one unsettled registration per invoice at a time), Find decides it by its withdrawn row, the later row is not held back and Record waits for it (R5 B); withdrawn, Record returns and records', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(404);
    await recordWith('1.00');
    await lookupReady();
    expect(heldA(r)).toMatchObject({ state: 'lookup', say: 'record404', body: '', proof: null });
    expect(flow()).toBe(RECORD_404);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record beside a record 404').toBeNull();
    expect(screen.queryByTestId('issued-payments-form')).toBeNull();
    expect(tid('issued-payments-find')).toBeInTheDocument();
    expect(r.keys.length, 'nothing minted after the 404').toBe(3);
    expect(posts(server, 'payment-registrations').length).toBe(1);
    // A reopen of the same invoice still offers nothing new.
    await close();
    await open(3);
    await settle();
    expect(flow()).toBe(RECORD_404);
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    // Another tab withdraws it; only then (the server allows one unsettled registration per staff member and invoice, 037)
    // does a later attempt of this staff member register there.
    expect(server.regs.length).toBe(1);
    server.regs[0].state = 'withdrawn';
    server.regs[0].settledAt = '2026-10-17T22:00:00.000001Z';
    server.regs.push(reg(server, 3, { invoiceId: made[2].id, number: made[2].number, registeredAt: '2026-10-17T23:00:00.000001Z' }));
    await click('issued-payments-find');
    await lookupReady();
    expect(heldA(r), 'decided by its withdrawn row').toMatchObject({ state: 'done', say: 'withdrawn' });
    expect(flow()).toBe('Attempt withdrawn. No payment was recorded.');
    const rows = screen.getAllByTestId('issued-payments-attempt');
    expect(rows.map((row) => row.getAttribute('data-attempt-state')), 'only the later, open attempt is listed').toEqual(['open']);
    expect(within(rows[0]).getByTestId('issued-payments-withdraw')).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByText('Finish the payment attempt above first.')).toBeNull();
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'R5 B: the later open attempt is listed: no Record yet').toBeNull();
    expect(r.keys.length).toBe(3);
    expect(posts(server, 'payment-registrations').length).toBe(1);
    expect(posts(server, 'payment-settlement').length, 'its withdrawal was another tab\'s').toBe(0);
    await click('issued-payments-withdraw');
    await waitFor(() => expect(server.regs.map((g) => g.state)).toEqual(['withdrawn', 'withdrawn']));
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull()); // decided, nothing listed: Record returns
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    expect(posts(server, 'payment-registrations').length).toBe(2);
  });

  it('SII-192. R2 R4: a decided attempt\'s text goes with the dialog — after the register\'s 403 hid Record, a later open whose eligibility says allowed offers Record again', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.register.push(403);
    await recordWith('1.00');
    await waitFor(() => expect(flow()).toBe('You cannot record payments for this invoice at this store.'));
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    await close();
    expect(rawHeld(r) === undefined, 'the decided attempt went with the dialog').toBe(true);
    await openRecordable(3);
    expect(flow()).toBe('');
  });

  it('SII-193. R2 R5: a lookup still out when Check again progresses the attempt is dropped — its late answer changes nothing on screen', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.hold.attempts = 1;
    await click('issued-payments-find');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['attempts']));
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    const g = server.regs[0];
    const late = new Response(JSON.stringify({ attempts: [{ invoiceId: made[2].id, invoiceNumber: made[2].number, attemptId: g.attemptId, state: 'open', version: 1, registeredAt: g.registeredAt, settledAt: null, payment: null }], nextCursor: null }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    server.held.shift()!.release(late);
    await settle();
    expect(screen.queryAllByTestId('issued-payments-attempt')).toEqual([]);
    expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'none');
    expect(flow()).toContain('Payment recorded: $1.00, Cash.');
    expect(tid('issued-payments-confirm')).toBeInTheDocument();
  });

  it('SII-194. R2 R6: record, Confirm ("Payment confirmed."), Escape at once, reopen the same invoice, record again, Confirm — exactly ONE more settle v2 and "Payment confirmed."; also with Escape while the first settlement is still out', async () => {
    const { server, r } = await setup();
    for (const escapeWhileOut of [false, true]) {
      await openRecordable(3);
      await recordWith('1.00');
      await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
      const settles = posts(server, 'payment-settlement').length;
      if (escapeWhileOut) server.hold.settle = 1;
      await click('issued-payments-confirm');
      if (escapeWhileOut) await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['settle']));
      else await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
      await user().keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
      if (escapeWhileOut) { server.held.shift()!.release(); await waitFor(() => expect(heldA(r)?.state ?? 'gone').not.toBe('sending')); }
      await openRecordable(3);
      server.hold.payments = 1; // the post-record page-one re-read (R3-5: must not collapse the view, R6)
      await recordWith('1.00');
      await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('payments'));
      expect(heldA(r)?.state).toBe('recorded');
      const node = tid('issued-payments-confirm');
      expect(screen.queryByTestId('issued-payments-status') !== null, 'the summary stays while the re-read is out').toBe(true);
      const rows = screen.getAllByTestId('issued-payments-item').length;
      expect(rows > 0, 'the rows stay while the re-read is out').toBe(true);
      server.held.shift()!.release();
      await waitFor(() => expect(screen.getAllByTestId('issued-payments-item').length).toBe(rows + 1));
      expect(node.isConnected && tid('issued-payments-confirm') === node, 'the same Confirm node across the re-read').toBe(true);
      await click('issued-payments-confirm');
      await waitFor(() => expect(flow(), `escape while out: ${escapeWhileOut}`).toBe('Payment confirmed.'));
      expect((posts(server, 'payment-settlement')).length, `escape while out: ${escapeWhileOut}`).toBe(settles + 2);
      await close();
    }
    expect(server.regs.map((g) => g.state)).toEqual(['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  });

  it('SII-195. R2 R6: while the post-record page-one re-read is out nothing above the recording controls changes — the summary and the rows stay shown (only the state line says it reads), and the flow and Confirm sit above the state line and the list — so a press as Confirm shows lands on it', async () => {
    const { server, made, r } = await setup();
    server.payments.set(made[2].id, [{ id: uuid(0x9101), attemptId: uuid(0xa101), amountCents: 100, method: 'cash', recordedAt: '2026-10-17T09:00:01.000001Z', reversal: null }]);
    await openRecordable(3);
    server.hold.payments = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['payments']));
    expect(heldA(r)?.state).toBe('recorded');
    expect(tid('issued-payments-status')).toHaveTextContent('Payment recorded in part'); // the shown summary stays
    expect(screen.getAllByTestId('issued-payments-item')).toHaveLength(1);
    expect(tid('issued-payments-state')).toHaveTextContent('Loading payments…');
    const confirm = tid('issued-payments-confirm');
    const after = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(after(tid('issued-payments-flow'), tid('issued-payments-state'))).toBe(true);
    expect(after(confirm, tid('issued-payments-state'))).toBe(true);
    expect(after(confirm, tid('issued-payments-list'))).toBe(true);
    expect(after(tid('issued-payments-remaining'), confirm)).toBe(true);
    // R4-1: pressed WHILE the re-read is still out — it works, exactly one settlement (the node identity across a re-read is SII-194's).
    await user().click(confirm);
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    expect(posts(server, 'payment-settlement').length, 'one settlement while the re-read is out').toBe(1);
    expect(server.held.map((h) => h.kind).join(','), 'the re-read is still out').toBe('payments');
    server.held.shift()!.release();
    await waitFor(() => expect(screen.getAllByTestId('issued-payments-item').length).toBe(2));
    expect(tid('issued-payments-remaining')).toHaveTextContent('$19.76');
    expect((posts(server, 'payment-settlement')).length).toBe(1);
  });

  it('SII-196. R3-4: a lookup answer that arrives while a Check again\'s session check is parked is never shown — its rows never become actionable once the attempt moves on', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.hold.attempts = 1;
    await click('issued-payments-find');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('attempts'));
    server.hold.current = 1;
    await click('issued-payments-check');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('attempts,current'));
    const g = server.regs[0];
    const late = new Response(JSON.stringify({ attempts: [{ invoiceId: made[2].id, invoiceNumber: made[2].number, attemptId: g.attemptId, state: 'open', version: 1, registeredAt: g.registeredAt, settledAt: null, payment: null }], nextCursor: null }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    server.held.find((h) => h.kind === 'attempts')!.release(late);
    await settle();
    expect(screen.queryAllByTestId('issued-payments-attempt').length, 'no row of the late lookup shown during the check').toBe(0);
    server.held.find((h) => h.kind === 'current')!.release();
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    expect(screen.queryAllByTestId('issued-payments-attempt').length, 'no row of the late lookup shown after it').toBe(0);
    expect(tid('issued-payments-attempts').getAttribute('data-phase') === 'ready', 'the late lookup never became ready').toBe(false);
  });

  it('SII-197. R3-6 (N2): while a detached attempt\'s request is still out, Find and the lookup rows say why they wait (aria-disabled, issued-payments-out / issued-payments-rows-out) instead of ignoring a press; once it answers Find works', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.hold.record = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('record'));
    await close();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
    await settle();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(3);
    expect(heldA(r)?.say).toBe('detached');
    const find = tid('issued-payments-find');
    expect(find).toHaveAttribute('aria-disabled', 'true');
    expect(find.getAttribute('aria-describedby')).toBe('issued-payments-out');
    expect(document.getElementById('issued-payments-out')?.textContent).toBe('Wait for the server to answer first.');
    expect(document.getElementById('issued-payments-rows-out')?.textContent).toBe('Wait for the server to answer first.');
    const reads = server.payRequests('payment-attempts').length;
    await user().click(find);
    await settle();
    expect(server.payRequests('payment-attempts').length, 'a waiting Find reads nothing').toBe(reads);
    server.held.shift()!.release();
    await waitFor(() => expect(tid('issued-payments-find')).toHaveAttribute('aria-disabled', 'false'));
    expect(document.getElementById('issued-payments-out')).toBeNull();
    expect(document.getElementById('issued-payments-rows-out')).toBeNull();
    await click('issued-payments-find');
    await lookupReady();
  });

  it('SII-198. R3-7: a lookup answer that arrives while Confirm\'s session check is parked is never shown — its rows never become actionable once the attempt is being settled', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.attemptsStatus.push(503);
    await click('issued-payments-find');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'failed'));
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    server.hold.attempts = 1;
    await click('issued-payments-attempts-retry'); // a lookup goes out while the attempt is recorded
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('attempts'));
    server.hold.current = 1;
    await click('issued-payments-confirm');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('attempts,current'));
    const g = server.regs[0];
    const late = new Response(JSON.stringify({ attempts: [{ invoiceId: made[2].id, invoiceNumber: made[2].number, attemptId: g.attemptId, state: 'recorded', version: 2, registeredAt: g.registeredAt, settledAt: null,
      payment: { id: g.payment!.id, amountCents: g.payment!.amountCents, method: g.payment!.method, recordedAt: g.payment!.recordedAt, reversal: null } }], nextCursor: null }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    server.held.find((h) => h.kind === 'attempts')!.release(late);
    await settle();
    expect(screen.queryAllByTestId('issued-payments-attempt').length, 'no row of the late lookup during Confirm').toBe(0);
    server.held.find((h) => h.kind === 'current')!.release();
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    expect(screen.queryAllByTestId('issued-payments-attempt').length, 'no row of the late lookup after Confirm').toBe(0);
    expect(posts(server, 'payment-settlement').length).toBe(1);
  });

  it('SII-199. R3-8 (N1, the blocking direction): an attempt still sendable here — unresolved with its bytes, or recorded and waiting for Confirm — is never replaced by a new recording: no Record on any invoice of the store, and the held attempt stays', async () => {
    const { server, r } = await setup();
    // R4-5: the positive control — with no attempt held, invoice 2 offers Record (the negatives below are not vacuous).
    await openRecordable(2);
    await close();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', body: 'held' }));
    const key = rawHeld(r)?.key;
    await close();
    await open(2);
    await waitFor(() => expect(server.payRequests('payment-eligibility').length).toBe(3));
    await paymentsReady();
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'blocked while unresolved with bytes').toBeNull();
    await close();
    await open(3);
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    await close();
    await open(1);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'blocked while recorded').toBeNull();
    expect(rawHeld(r)?.key === key, 'the held attempt stays').toBe(true);
    expect(posts(server, 'payment-registrations').length).toBe(1);
  });

  it('SII-200. R3-11: a page-one re-read after a recording that FAILS keeps the shown summary and rows (the state line says it failed, with Try again), the same Confirm node stays; Try again reads page one', async () => {
    const { server, made, r } = await setup();
    server.payments.set(made[2].id, [{ id: uuid(0x9201), attemptId: uuid(0xa201), amountCents: 100, method: 'cash', recordedAt: '2026-10-17T09:00:01.000001Z', reversal: null }]);
    await openRecordable(3);
    server.hold.payments = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('payments'));
    expect(heldA(r)?.state).toBe('recorded');
    const confirm = tid('issued-payments-confirm');
    server.held.shift()!.release(new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'r' }), { status: 503, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(tid('issued-payments-state')).toHaveAttribute('data-phase', 'unavailable'));
    expect(tid('issued-payments-state')).toHaveTextContent('Payments could not be loaded.');
    expect(screen.queryByTestId('issued-payments-status') !== null, 'the summary stays after a failed re-read').toBe(true);
    expect(screen.getAllByTestId('issued-payments-item').length).toBe(1);
    expect(confirm.isConnected && tid('issued-payments-confirm') === confirm, 'the same Confirm node').toBe(true);
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    const reads = server.paymentReads().length;
    await click('issued-payments-retry');
    await waitFor(() => expect(screen.getAllByTestId('issued-payments-item').length).toBe(2));
    expect(server.paymentReads().length).toBe(reads + 1);
    expect(server.paymentReads()[reads].endsWith('/payments'), 'Try again reads page one').toBe(true);
    // R4-7: a REFUSAL of that re-read (403) shows nothing read before — only a transient failure keeps the shown view.
    await click('issued-payments-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await close();
    await openRecordable(3);
    server.hold.payments = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('payments'));
    server.held.shift()!.release(new Response(JSON.stringify({ error: 'forbidden', requestId: 'r' }), { status: 403, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(tid('issued-payments-state')).toHaveAttribute('data-phase', 'denied'));
    expect(screen.queryByTestId('issued-payments-status') === null, 'a refused re-read drops the summary read before').toBe(true);
    expect(screen.queryAllByTestId('issued-payments-item').length).toBe(0);
  });

  it('SII-201. R3-12: closing another invoice\'s dialog never removes this invoice\'s decided attempt — Confirm on A, close A while the settlement is out, open B, the settlement answers, close B: A still says "Payment confirmed."', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    server.hold.settle = 1;
    await click('issued-payments-confirm');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('settle'));
    await close();
    await open(2);
    server.held.shift()!.release();
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'done', say: 'confirmed' }));
    await close();
    expect(heldA(r)?.say, 'A\'s decided attempt survives B\'s close').toBe('confirmed');
    await open(3);
    expect(flow()).toBe('Payment confirmed.');
    await close();
    expect(rawHeld(r) === undefined, 'A\'s own close removes it').toBe(true);
  });

  it('SII-202. R4-2: while a Confirm\'s session check is parked, the lookup\'s Try again reads nothing (Find waits for the Confirm); the Confirm then settles once', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.attemptsStatus.push(503);
    await click('issued-payments-find');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'failed'));
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    server.hold.current = 1;
    await click('issued-payments-confirm');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('current'));
    const reads = server.payRequests('payment-attempts').length;
    await click('issued-payments-attempts-retry');
    await settle();
    expect(tid('issued-payments-attempts').getAttribute('data-phase') === 'failed', 'the refused Try again starts no lookup (still failed, never "Checking…")').toBe(true);
    expect(server.payRequests('payment-attempts').length, 'no lookup while the Confirm is out').toBe(reads);
    server.held.shift()!.release();
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await settle();
    expect(server.payRequests('payment-attempts').length, 'the refused Try again never reads, even after the Confirm').toBe(reads);
    expect(posts(server, 'payment-settlement').length).toBe(1);
  });

  it('SII-203. R4-4 (synthetic: two unsettled rows on one invoice meet only in a paging race): while a row\'s settlement is out, every other row\'s action waits and says why (aria-disabled, described by issued-payments-rows-out) and a press sends nothing', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(404);
    await recordWith('1.00');
    await lookupReady(); // the held attempt's own open row (no longer sendable: blocks nothing)
    // R6: synthetic — two unsettled rows of one staff member on one invoice meet only through a paging race (037 allows one);
    // this pins that every other row waits while one settlement is out.
    server.regs.push(reg(server, 4, { invoiceId: made[2].id, number: made[2].number, registeredAt: '2026-10-17T23:00:00.000001Z' }));
    await click('issued-payments-find');
    await lookupReady();
    expect(screen.getAllByTestId('issued-payments-attempt').length).toBe(2);
    server.hold.current = 1;
    const [first, second] = screen.getAllByTestId('issued-payments-withdraw');
    await user().click(first);
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('current'));
    expect(second).toHaveAttribute('aria-disabled', 'true');
    expect(second.getAttribute('aria-describedby')?.split(' ').includes('issued-payments-rows-out'), 'described by the rows-out reason').toBe(true);
    expect(document.getElementById('issued-payments-rows-out')?.textContent).toBe('Wait for the server to answer first.');
    await user().click(second);
    await settle();
    expect(posts(server, 'payment-settlement').length, 'nothing sent while the first is out').toBe(0);
    server.held.shift()!.release();
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    expect(posts(server, 'payment-settlement').length).toBe(1);
    expect(heldA(r)?.say).toBe('withdrawn');
  });

  it('SII-204. G2: the server\'s only 422 (idempotency_key_reused) and its unsealed tenant 409 are decided before anything is written, so on the register\'s FIRST send nothing was registered: "No payment was recorded: the server did not accept this request.", nothing held undecided, no Find, no attempts read, Record again under a NEW attempt id; a 422 answering a Check again (same key) stays lookup-only', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    const chain409 = () => new Response(JSON.stringify({ error: 'write_conflict', requestId: 'r' }), { status: 409, headers: { 'content-type': 'application/json' } });
    for (const [i, answer] of [chain422(), chain409()].entries()) {
      server.payScripts.register.push(answer);
      await recordWith('1.00');
      await waitFor(() => expect(heldA(r), String(i)).toMatchObject({ state: 'done', say: 'notAccepted', body: '', proof: null }));
      expect(flow(), String(i)).toBe('No payment was recorded: the server did not accept this request.');
      await settle();
      expect(screen.queryByTestId('issued-payments-find'), String(i)).toBeNull();
      expect(screen.queryByTestId('issued-payments-check'), String(i)).toBeNull();
      expect(attemptsReads(server).length, String(i)).toBe(0);
      await waitFor(() => expect(screen.queryByTestId('issued-payments-record'), String(i)).not.toBeNull());
    }
    expect(posts(server, 'payment-registrations').length).toBe(2);
    expect(server.regs.length).toBe(0);
    // A register whose request never arrived, then a 422 on its Check again: unknown then — lookup only, and (R3 S-1) Record
    // stays off on its own invoice until a complete lookup finds no registration of it (R3 L-M1).
    server.payScripts.register.push('lose-before', chain422());
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    server.hold.attempts = 1;
    await click('issued-payments-check');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('attempts'));
    expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'register', say: 'detached', body: '' });
    expect(flow()).toBe(DETACHED);
    expect(screen.queryByTestId('issued-payments-check')).toBeNull();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record beside its own undecided attempt').toBeNull();
    const regs = posts(server, 'payment-registrations');
    expect(regs.length).toBe(4);
    same(keyOf(regs[3]), keyOf(regs[2]), 'the Check again went under the same key');
    same(regs[3].body, regs[2].body, 'and the same bytes');
    expect(new Set(regs.slice(0, 3).map((x) => x.body)).size, 'every press a new attempt id').toBe(3);
    server.held.shift()!.release();
    // R4: that lookup started with the Check again's answer, inside the register's 60 s: its absence decides nothing yet.
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'failed'));
    expect(tid('issued-payments-attempts')).toHaveTextContent('This payment attempt may still be in progress. Try again in a minute.');
    expect(heldA(r)?.state).toBe('lookup');
    expect(screen.queryByTestId('issued-payments-record'), 'still no Record beside it').toBeNull();
    quiet(r);
    await click('issued-payments-attempts-retry');
    await lookupReady();
    expect(heldA(r)?.state).toBe('done');
    expect(attemptsReads(server).length).toBe(2);
    expect(tid('issued-payments-attempts')).toHaveTextContent('No unfinished payment attempts were found on this invoice.');
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
    expect(posts(server, 'payment-registrations').length).toBe(4);
  });

  it('SII-205. G2 judge: a register\'s first-send key-reused or tenant-conflict is final "notAccepted"; on a Check again, or at any later stage, it stays lookup-only', () => {
    for (const kind of ['key-reused', 'tenant-conflict'] as const) {
      expect(judgePayment('register', { kind }, true), kind).toEqual({ kind: 'final', say: 'notAccepted', reread: false });
      expect(judgePayment('register', { kind }, false), kind).toEqual({ kind: 'lookup', say: 'detached', reread: false });
      for (const stage of ['proof', 'record', 'settle'] as const) {
        expect(judgePayment(stage, { kind }, true), `${stage} ${kind}`).toEqual({ kind: 'lookup', say: 'detached', reread: false });
      }
    }
  });

  it('SII-206. G3: an undecided attempt past its registration is never replaced from another invoice or store — after a store switch (its late answer changing nothing on the other store) "Record payment" and nothing else is offered on another invoice, which names the invoice to finish; no request ever carries its keys again; its own invoice still recovers it (Find, Confirm), then the other invoice records', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.hold.record = 1;
    await recordWith('2.00');
    await waitFor(() => expect(server.held).toHaveLength(1));
    const [attemptId, registerKey, recordKey] = r.keys;
    await close();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
    await settle();
    const otherStore = document.body.innerHTML;
    const mark = server.sent.length;
    server.held.shift()!.release(); // the record commits; its answer comes back to the other store
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'record', say: 'detached', csrf: null, body: '' }));
    await settle();
    expect(document.body.innerHTML === otherStore, 'the late answer changes nothing on the other store').toBe(true);
    expect(apart(server, mark).length, 'nothing sent').toBe(0);
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(2);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on another invoice').toBeNull();
    expect(flow()).toBe(finishOn(made[2].number));
    expect(screen.queryByTestId('issued-payments-find')).toBeNull();
    same(rawHeld(r)?.key, attemptId, 'the attempt is kept');
    expect(r.keys.length, 'nothing minted').toBe(3);
    expect(posts(server, 'payment-registrations').length).toBe(1);
    await close();
    await open(3);
    expect(flow()).toBe(DETACHED);
    expect(screen.queryByTestId('issued-payments-check')).toBeNull();
    await click('issued-payments-find');
    await lookupReady();
    await click('issued-payments-attempt-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    await close();
    await openRecordable(2);
    expect(flow()).toBe('');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    const all = (['payment-registrations', 'payments', 'payment-settlement'] as const).flatMap((route) => posts(server, route));
    const reused = all.filter((x) => [registerKey, recordKey].includes(keyOf(x) ?? '')).length;
    expect(reused, 'the detached attempt\'s keys went with their own first sends only').toBe(2);
    expect(all.filter((x) => (x.body ?? '').includes(attemptId)).length, 'its attempt id: its register, record and the deliberate Confirm only').toBe(3);
    expect(server.payments.get(made[2].id)?.length).toBe(1);
  });

  it('SII-207. G1b: any undecided attempt past its registration holds its OWN invoice too — after a proof 404 and after a sealed amount_exceeds_remaining "Record payment" is not offered and nothing is minted or sent; its text says what to do, Find is offered and its own row\'s Withdraw stays allowed; once withdrawn Record returns', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    const cases: Array<[string, () => void, string]> = [
      ['proof 404', () => server.payScripts.proof.push(404), DETACHED],
      ['amount exceeds', () => server.payScripts.record.push(sealed409('amount_exceeds_remaining')),
        'No payment was recorded: the amount is more than the remaining balance. Withdraw the attempt, then record the correct amount.'],
    ];
    for (const [name, script, text] of cases) {
      script();
      await recordWith('1.00');
      await lookupReady();
      expect(flow(), name).toBe(text);
      const keys = r.keys.length;
      const regs = posts(server, 'payment-registrations').length;
      await settle();
      expect(screen.queryByTestId('issued-payments-record'), `${name}: no Record on its own invoice`).toBeNull();
      expect(tid('issued-payments-find'), name).toBeInTheDocument();
      expect(r.keys.length, `${name}: nothing minted`).toBe(keys);
      expect(posts(server, 'payment-registrations').length, `${name}: nothing registered`).toBe(regs);
      const withdraw = screen.getByTestId('issued-payments-withdraw');
      expect(withdraw, name).toHaveAttribute('aria-disabled', 'false'); // its own row: the recovery
      await user().click(withdraw);
      await waitFor(() => expect(flow(), name).toBe('Attempt withdrawn. No payment was recorded.'));
      await waitFor(() => expect(screen.queryByTestId('issued-payments-record'), name).not.toBeNull());
    }
    expect(server.regs.map((g) => g.state)).toEqual(['withdrawn', 'withdrawn']);
    expect(posts(server, 'payments').length).toBe(1); // the proof 404 never reached the record
  });

  it('SII-208. codexMED: an ATTACHED same-store attempt still sendable on invoice 3 (unresolved at the record, Check again offered there) holds invoice 2 back with a line naming invoice 3 — no Record, nothing minted or sent, no Check again or Find here; invoice 3 still offers Check again', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'record', csrf: 'held', body: 'held' }));
    const keys = r.keys.length;
    const sent = server.sent.length;
    await close();
    await open(2);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on another invoice').toBeNull();
    expect(flow()).toBe(finishOn(made[2].number));
    expect(screen.queryByTestId('issued-payments-check')).toBeNull();
    expect(screen.queryByTestId('issued-payments-find')).toBeNull();
    expect(screen.queryAllByTestId('issued-payments-attempt').length).toBe(0); // no lookup here: only the attempt's own invoice runs one
    expect(r.keys.length, 'nothing minted').toBe(keys);
    expect(apart(server, sent).filter((x) => x.startsWith('POST ')).length, 'no payment command sent').toBe(0);
    await close();
    await open(3);
    expect(flow()).toBe(UNCERTAIN);
    expect(tid('issued-payments-check')).toBeInTheDocument();
  });

  it('SII-209. R7 (Part B): once a record may have been sent, a COMPLETE lookup that no longer lists the registration (settled over 24 h ago: withdrawn OR confirmed, 037) decides nothing — the hold, its line and its key stay, the lookup says it can\'t tell, nothing is sent, no Record on its invoice and the other invoice names it', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(404);
    await recordWith('1.00');
    await lookupReady();
    expect(screen.getAllByTestId('issued-payments-attempt').length).toBe(1);
    expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'record', say: 'record404', body: '', proof: null });
    const key = rawHeld(r)?.key;
    server.regs.splice(0); // no longer listed
    const count = () => ['payment-registrations', 'payments', 'payment-settlement', 'payment-registration-proof'].map((route) => server.payRequests(route as 'payments').length).join(',');
    const sent = count();
    const reads = attemptsReads(server).length;
    await click('issued-payments-find');
    await lookupReady();
    expect(attemptsReads(server).length, 'one complete read').toBe(reads + 1);
    expect(heldA(r), 'decided by nothing').toMatchObject({ state: 'lookup', stage: 'record', say: 'record404', body: '', proof: null });
    same(rawHeld(r)?.key, key, 'the same attempt, kept');
    expect(flow()).toBe(RECORD_404);
    expect(tid('issued-payments-attempts')).toHaveTextContent("This payment attempt is no longer listed, so it can't be finished from here. Check this invoice's payments.");
    expect(tid('issued-payments-attempts')).not.toHaveTextContent('No unfinished payment attempts were found on this invoice.');
    await settle();
    expect(count(), 'nothing sent: no registration, proof, record or settlement').toBe(sent);
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on its invoice').toBeNull();
    await close();
    await open(2);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on another invoice').toBeNull();
    expect(flow()).toBe(finishOn(made[2].number));
    expect(count(), 'still nothing sent').toBe(sent);
  });

  it('SII-210. R3 M2: on another store the line names the store too — an attempt registered at Main Street holds an invoice of another store back: no Record, nothing minted', async () => {
    const { server, made, r } = await setup();
    issueAt(server, STORE_2, 1);
    await openRecordable(3);
    server.payScripts.record.push(404);
    await recordWith('1.00');
    await lookupReady();
    await close();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
    await listReady();
    await open(1);
    await settle();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    expect(flow()).toBe(finishOn(made[2].number, 'Main Street'));
    expect(r.keys.length, 'nothing minted').toBe(3);
  });

  it('SII-211. R3 L1: a same-store attempt still sendable at its register on invoice 3 holds invoice 2 back with the line naming invoice 3 (never an empty line); nothing minted', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.register.push('lose-before');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'register', csrf: 'held', body: 'held' }));
    await close();
    await open(2);
    await settle();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    expect(flow()).toBe(finishOn(made[2].number));
    expect(r.keys.length, 'nothing minted').toBe(2);
  });

  it('SII-212. R3 L2: a settlement answered by the sealed write_conflict is never sent again and says so beside Find ("can\'t be checked from here any more"); the lookup reads again', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(404);
    await recordWith('1.00');
    await lookupReady();
    const reads = attemptsReads(server).length;
    server.payScripts.settle.push(sealed409('write_conflict'));
    await click('issued-payments-withdraw');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'settle' }));
    expect(heldA(r)?.say).toBe('detached');
    expect(flow()).toBe(DETACHED);
    await waitFor(() => expect(attemptsReads(server).length).toBe(reads + 1));
    await lookupReady();
    expect(tid('issued-payments-find')).toBeInTheDocument();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    expect(posts(server, 'payment-settlement').length).toBe(1);
  });

  it('SII-213. R4 (R3-1): a register whose answer was lost, a 503 or request_in_progress may still be committing, so a COMPLETE lookup started within 60 s of its LAST send without its row decides nothing: the hold stays undecided, no Record on its invoice, "may still be in progress" with Try again; past 60 s Try again decides it and Record is back; a Check again restarts the 60 s; never a new register', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    const inProgress = () => new Response(JSON.stringify({ error: 'request_in_progress', requestId: 'r' }), { status: 409, headers: { 'content-type': 'application/json' } });
    const sent = () => posts(server, 'payment-registrations').length;
    const attempts = () => tid('issued-payments-attempts');
    for (const [i, answer] of (['lose-before', 503, inProgress()] as const).entries()) {
      const at = String(i);
      server.payScripts.register.push(answer);
      await recordWith('1.00');
      await waitFor(() => expect(heldA(r)?.state, at).toBe('unresolved'));
      if (i === 0) {
        r.clock.mono += 59_000; r.clock.wall += 59_000;
        const before = sent();
        server.payScripts.register.push('lose-before');
        await click('issued-payments-check');
        await waitFor(() => expect(sent(), at).toBe(before + 1));
        await waitFor(() => expect(heldA(r)?.state, at).toBe('unresolved'));
        r.clock.mono += 59_000; r.clock.wall += 59_000; // 118 s after the first send, 59 s after the last
      }
      const regs = sent();
      const reads = attemptsReads(server).length;
      await click('issued-payments-find');
      await waitFor(() => expect(attempts(), at).toHaveAttribute('data-phase', 'failed'));
      expect(attemptsReads(server).length, `${at}: one complete read`).toBe(reads + 1);
      expect(attempts(), at).toHaveTextContent('This payment attempt may still be in progress. Try again in a minute.');
      expect(attempts(), at).not.toHaveTextContent('No unfinished payment attempts were found on this invoice.');
      expect(heldA(r), at).toMatchObject({ state: 'unresolved', stage: 'register', body: 'held' });
      await settle();
      expect(screen.queryByTestId('issued-payments-record'), `${at}: no Record beside its own undecided attempt`).toBeNull();
      quiet(r);
      await click('issued-payments-attempts-retry');
      await lookupReady();
      expect(heldA(r), at).toMatchObject({ state: 'done', body: '', proof: null });
      expect(attempts(), at).toHaveTextContent('No unfinished payment attempts were found on this invoice.');
      await waitFor(() => expect(screen.queryByTestId('issued-payments-record'), at).not.toBeNull());
      expect(sent(), `${at}: no new register`).toBe(regs);
    }
    expect(sent(), 'three presses and one Check again').toBe(4);
    expect(server.regs.length).toBe(0);
  });

  it('SII-214. R3-2: a register that COMMITTED but whose answer was lost, then a 422 on its Check again (same key: lookup-only): the lookup lists its open row, so the hold stays undecided ("lookup"), Record stays off on its invoice, nothing is sent again', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.register.push('lose', chain422());
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    expect(server.regs.length, 'the register committed').toBe(1);
    await click('issued-payments-check');
    await lookupReady();
    expect(posts(server, 'payment-registrations').length).toBe(2);
    expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'register', say: 'detached', body: '' });
    expect(screen.queryAllByTestId('issued-payments-attempt').length).toBe(1);
    expect(server.regs[0].invoiceId === made[2].id && server.regs[0].state === 'open', 'its open row on this invoice').toBe(true);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record beside its own undecided attempt').toBeNull();
    expect(posts(server, 'payment-registrations').length, 'nothing sent again').toBe(2);
    expect(attemptsReads(server).length).toBe(1);
  });

  const commands = (server: Server) => (['payment-registrations', 'payments', 'payment-settlement'] as const).reduce((n, route) => n + posts(server, route).length, 0);
  const releaseHeld = (server: Server, kind: string) => { const i = server.held.findIndex((h) => h.kind === kind); server.held.splice(i, 1)[0].release(); };
  const CONFLICT = 'You have an unfinished payment attempt on this invoice. Finish it before recording another payment.';

  it('SII-215. R5 A: an undecided attempt still at its register (its register lost, then a 422 on Check again: lookup-only, no bytes) is never replaced from another invoice or store — no Record on invoice 2 (the line names invoice 3) nor on another store (the line names Main Street), nothing minted or sent; detached by the store switch it holds them back the same; its own invoice still decides it (Find), then invoice 2 records', async () => {
    const { server, made, r } = await setup();
    issueAt(server, STORE_2, 1);
    await openRecordable(3);
    server.payScripts.register.push('lose-before', chain422());
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    await click('issued-payments-check');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'failed')); // R4: inside its 60 s
    expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'register', csrf: 'held', body: '' });
    const key = rawHeld(r)?.key;
    const minted = r.keys.length;
    await close();
    await open(2);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on another invoice').toBeNull();
    expect(flow()).toBe(finishOn(made[2].number));
    await close();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
    await listReady();
    await open(1);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on another store').toBeNull();
    expect(flow()).toBe(finishOn(made[2].number, 'Main Street'));
    expect(heldA(r), 'the store switch detached it').toMatchObject({ state: 'lookup', stage: 'register', csrf: null });
    await close();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(2);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'detached, it still holds invoice 2 back').toBeNull();
    expect(flow()).toBe(finishOn(made[2].number));
    same(rawHeld(r)?.key, key, 'the attempt is kept');
    expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'register' });
    expect(r.keys.length, 'nothing minted').toBe(minted);
    expect(commands(server), 'nothing sent: its first send and its Check again only').toBe(2);
    await close();
    await open(3);
    quiet(r);
    await click('issued-payments-find');
    await lookupReady();
    expect(heldA(r)?.state, 'its own invoice decides it by its absence').toBe('done');
    await close();
    await openRecordable(2);
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    expect(posts(server, 'payment-registrations').length).toBe(3);
  });

  it('SII-216. R5 A: a lookup row\'s Withdraw is never sent while an attempt still at its register is undecided on another invoice — pressed before that attempt appeared, it is refused after the session check; then held back with "Finish the payment attempt above first." and the line naming that invoice; nothing sent, that attempt kept', async () => {
    const { server, made, r } = await setup();
    server.regs.push(reg(server, 1, { invoiceId: made[1].id, number: made[1].number })); // an open attempt of this user on invoice 2
    await openRecordable(2);
    await recordWith('1.00'); // the sealed write_conflict: this press holds nothing, the lookup lists the open one
    await lookupReady();
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'writeConflict' });
    server.hold.current = 1;
    await user().click(tid('issued-payments-withdraw'));
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('current'));
    // Meanwhile an attempt of this user on invoice 3 is held, still at its register (lookup-only, detached).
    const other: HeldPayment = {
      key: uuid(0xa216), storeId: STORE_1, tenantId: TENANT_A, invoiceId: made[2].id, number: made[2].number, csrf: null, stage: 'register', stageKey: uuid(0xb216), body: '',
      sentAt: r.clock.mono, sentWall: r.clock.wall, lastSentAt: r.clock.mono, registrationId: null, proof: null, amountCents: 100, method: 'cash', payment: null, settleVersion: null,
      state: 'lookup', say: 'detached', retryAfter: 0, rereads: 0,
    };
    act(() => { expect(r.payHolds.put('uid-a', other)).toBe(true); });
    releaseHeld(server, 'current');
    await settle();
    expect(posts(server, 'payment-settlement').length, 'nothing settled').toBe(0);
    same(rawHeld(r)?.key, other.key, 'the undecided attempt is kept');
    expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'register' });
    expect(tid('issued-payments-withdraw')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Finish the payment attempt above first.')).toBeInTheDocument();
    expect(flow()).toBe(finishOn(made[2].number));
    await user().click(tid('issued-payments-withdraw'));
    await settle();
    expect(posts(server, 'payment-settlement').length, 'still nothing settled').toBe(0);
    expect(server.regs[0].state).toBe('open');
  });

  it('SII-217. R5 B: while the lookup lists an unsettled attempt on this invoice (a first-send register write_conflict ran it) "Record payment" is not offered, and a press already on its way when the rows arrive is refused after its session check — nothing minted or sent; once that attempt is withdrawn the press\'s form returns and records', async () => {
    const { server, made, r } = await setup();
    server.regs.push(reg(server, 1, { invoiceId: made[2].id, number: made[2].number })); // an open attempt of this user on invoice 3
    await openRecordable(3);
    server.hold.attempts = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('attempts'));
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'writeConflict' });
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record'), 'nothing listed yet').not.toBeNull());
    const minted = r.keys.length;
    server.hold.current = 1;
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind).sort().join(',')).toBe('attempts,current'));
    releaseHeld(server, 'attempts'); // the lookup lists the open attempt
    await lookupReady();
    expect(screen.getAllByTestId('issued-payments-attempt').length).toBe(1);
    releaseHeld(server, 'current'); // then the press's session check answers
    await settle();
    expect(r.keys.length, 'nothing minted').toBe(minted);
    expect(posts(server, 'payment-registrations').length, 'nothing sent').toBe(1);
    expect(flow()).toBe(CONFLICT);
    expect(screen.queryByTestId('issued-payments-record'), 'no Record while an unsettled attempt is listed').toBeNull();
    await click('issued-payments-withdraw');
    await waitFor(() => expect(server.regs[0].state).toBe('withdrawn'));
    // Nothing listed: the refused press's form comes back with its values (its line stays until the next press), and records.
    await waitFor(() => expect(screen.queryByTestId('issued-payments-form'), 'nothing listed: Record returns').not.toBeNull());
    expect(posts(server, 'payment-registrations').length).toBe(1);
    await click('issued-payments-submit');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    expect(posts(server, 'payment-registrations').length).toBe(2);
  });

  it('SII-218. R6: a listed open attempt already withdrawn in another tab — its Withdraw is answered 200 with the state unchanged (withdrawn): the row goes, nothing else is sent and Record returns', async () => {
    const { server, made, r } = await setup();
    server.regs.push(reg(server, 1, { invoiceId: made[2].id, number: made[2].number })); // an open attempt of this user on invoice 3
    await openRecordable(3);
    await recordWith('1.00'); // the sealed write_conflict: the lookup lists the open one
    await lookupReady();
    expect(screen.getAllByTestId('issued-payments-attempt').length).toBe(1);
    expect(screen.queryByTestId('issued-payments-record'), 'R5 B: listed, no Record').toBeNull();
    server.regs[0].state = 'withdrawn'; // another tab
    server.regs[0].settledAt = '2026-10-17T22:00:00.000001Z';
    await click('issued-payments-withdraw');
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    expect(screen.queryAllByTestId('issued-payments-attempt').length, 'the row goes').toBe(0);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record'), 'Record returns').not.toBeNull());
    expect(posts(server, 'payment-settlement').length).toBe(1);
    expect(posts(server, 'payment-registrations').length).toBe(1);
    expect(server.payRequests('payment-registration-proof').length, 'no proof read').toBe(0);
    expect(posts(server, 'payments').length, 'no record sent').toBe(0);
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'withdrawn' });
  });

  const FINISH_FIRST = 'Finish the payment attempt above first.';
  /** §12.7: a sign-out makes the held attempt unsendable (detached); sign in again (Reconnect) and reopen invoice `n`. */
  async function signOutAndBack(r: Rig, n: number) {
    await act(async () => { await r.props().session!.logout(); });
    await waitFor(() => expect(heldA(r)?.csrf, 'detached by the sign-out').toBeNull());
    await click('issued-retry'); // Reconnect
    await storesReady();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(n);
  }
  /**
   * R7: another tab's open registration A of this user on invoice 3, and in THIS tab a Record on invoice 3 whose register
   * the slot refuses (037: one unsettled registration per staff member and invoice) with its answer lost — B, at its
   * register, nothing committed — then made unsendable by a sign-out and sign-in (§12.7: detached). Find's read is CAPPED
   * (settled rows fill more than 20 pages; SII-181), so it never decides B and lists A on page one.
   */
  async function undecidedBesideListed() {
    const { server, made, r, view } = await setup();
    server.regs.push(reg(server, 1, { invoiceId: made[2].id, number: made[2].number }));
    for (let i = 0; i < 1001; i++) server.regs.push(reg(server, 2000 + i, { invoiceId: made[i % 2].id, number: made[i % 2].number, state: 'withdrawn', settledAt: '2026-10-17T08:30:00.000001Z' }));
    await openRecordable(3);
    server.payScripts.register.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'register', body: 'held' }));
    expect(server.regs.filter((g) => g.state === 'open').length, 'B registered nothing: the slot is A\'s').toBe(1);
    await signOutAndBack(r, 3);
    expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'register', say: 'detached', csrf: null, body: '' });
    await click('issued-payments-find');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'cap'));
    expect(heldA(r), 'a capped read decides nothing').toMatchObject({ state: 'unresolved', stage: 'register', say: 'detached', csrf: null });
    expect(screen.getAllByTestId('issued-payments-attempt').length, 'A on page one').toBe(1);
    return { server, made, r, view, key: rawHeld(r)?.key, a: server.regs[0].attemptId };
  }

  it('SII-219. R7: another tab\'s open attempt listed beside this tab\'s undecided attempt on the same invoice (unsendable, not decided by a capped read) — its Withdraw is held back with "Finish the payment attempt above first." and sends nothing; the undecided attempt is kept with its recording block: no Record on invoice 3, and invoice 2 names invoice 3', async () => {
    const { server, made, r, key, a } = await undecidedBesideListed();
    const withdraw = tid('issued-payments-withdraw');
    const mark = server.sent.length;
    await user().click(withdraw);
    await settle();
    expect(posts(server, 'payment-settlement').length, 'no settlement sent for A').toBe(0);
    expect(apart(server, mark).length, 'nothing sent').toBe(0);
    same(rawHeld(r)?.key, key, 'B is kept');
    expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'register', say: 'detached', csrf: null });
    expect(server.regs[0].state).toBe('open');
    expect(withdraw).toHaveAttribute('aria-disabled', 'true');
    expect(withdraw.getAttribute('aria-describedby')?.split(' ').includes('issued-payments-attempt-note-0'), 'described by its note').toBe(true);
    const note = document.getElementById('issued-payments-attempt-note-0');
    expect(note?.textContent === FINISH_FIRST, 'describedby resolves to the note').toBe(true);
    // "above": B's own line (the flow) comes before the list in the DOM.
    expect(flow()).toBe(DETACHED);
    expect(Boolean(note !== null && (tid('issued-payments-flow').compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING)), 'the held attempt\'s line is above the note').toBe(true);
    expect(document.body.innerHTML.includes(key ?? '-') || document.body.innerHTML.includes(a), 'no attempt id in the DOM').toBe(false);
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on invoice 3').toBeNull();
    await close();
    await open(2);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on invoice 2').toBeNull();
    expect(flow()).toBe(finishOn(made[2].number));
    same(rawHeld(r)?.key, key, 'B is still kept');
    expect(commands(server), 'B\'s one send only').toBe(1);
  });

  it('SII-220. R7: the undecided attempt stays recoverable — while it is undecided the listed row waits; once a COMPLETE read decides it by its own evidence (still at its register, past the 60 s), the row\'s Withdraw settles the listed attempt: ONE v1, "Attempt withdrawn. No payment was recorded.", nothing else sent', async () => {
    const { server, r, a } = await undecidedBesideListed();
    expect(tid('issued-payments-withdraw'), 'held back while B is undecided').toHaveAttribute('aria-disabled', 'true');
    server.regs.splice(1); // the settled rows age out: the next read is complete
    quiet(r);
    await click('issued-payments-find');
    await lookupReady();
    expect(heldA(r), 'B decided by its absence (it never registered)').toMatchObject({ state: 'done', body: '' });
    const withdraw = tid('issued-payments-withdraw');
    expect(withdraw).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByText(FINISH_FIRST)).toBeNull();
    await settle();
    const mark = server.sent.length;
    await user().click(withdraw);
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    await settle();
    same(JSON.stringify(apart(server, mark)), JSON.stringify([`POST ${STORES_PATH}/${STORE_1}/invoices/${server.regs[0].invoiceId}/payment-settlement`]), 'ONE settlement, nothing else (compared, never printed)');
    const [v1] = posts(server, 'payment-settlement');
    same(v1.body, `{"expectedTenant":"${TENANT_A}","attemptId":"${a}","expectedVersion":1}`, 'A\'s withdraw bytes');
    expect(server.regs[0].state).toBe('withdrawn');
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'withdrawn' });
    same(rawHeld(r)?.key, a, 'the hold is A\'s settlement');
    expect(rawHeld(r)?.amountCents === 0, 'no amount from another attempt').toBe(true);
  });

  it('SII-221. R7: only a matching terminal answer clears a hold, and only its own — the held attempt\'s own listed row (its register committed, its answer lost, then detached by a sign-out) is not held back; a (synthetic) 200 naming another attempt or another invoice leaves it undecided (Check again, same key and bytes), the matching 200 decides it: "Attempt withdrawn. No payment was recorded."', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.register.push('lose');
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('unresolved'));
    expect(server.regs.length, 'its register committed').toBe(1);
    await signOutAndBack(r, 3);
    await click('issued-payments-find');
    await lookupReady(); // its own open row is listed: no absence, nothing decided
    expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'register', say: 'detached', csrf: null, body: '' });
    const key = rawHeld(r)?.key;
    expect(screen.getAllByTestId('issued-payments-attempt').length).toBe(1);
    expect(tid('issued-payments-withdraw'), 'its own row: never "another attempt"').toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByText(FINISH_FIRST)).toBeNull();
    // SYNTHETIC: the real 200 is built from the request (IP:588-596), so it always names the attempt and invoice sent;
    // these two pin the client's identity check (invoiceIssuingClient settlePayment) and that a mismatch never decides a hold.
    const settlement = (over: Record<string, string>) => new Response(JSON.stringify({ settlement: { invoiceId: made[2].id, attemptId: key, state: 'withdrawn', ...over } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    server.payScripts.settle.push(settlement({ attemptId: uuid(0xa221) }), settlement({ invoiceId: made[1].id }));
    await click('issued-payments-withdraw');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'settle', say: 'uncertain', body: 'held' }));
    same(rawHeld(r)?.key, key, 'another attempt\'s 200 never decides it');
    expect(flow()).toBe(UNCERTAIN);
    expect(tid('issued-payments-withdraw'), 'its own settlement is out: only Check again').toHaveAttribute('aria-disabled', 'true');
    await click('issued-payments-check');
    await waitFor(() => {
      expect(posts(server, 'payment-settlement').length).toBe(2);
      expect(heldA(r), 'another invoice\'s 200 never decides it').toMatchObject({ state: 'unresolved', stage: 'settle', say: 'uncertain' });
    });
    expect(server.regs[0].state).toBe('open');
    await click('issued-payments-check');
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'withdrawn', body: '' });
    same(rawHeld(r)?.key, key, 'its own hold, decided');
    expect(server.regs[0].state).toBe('withdrawn');
    const settles = posts(server, 'payment-settlement');
    expect(settles.length).toBe(3);
    expect(settles.every((s) => keyOf(s) === keyOf(settles[0]) && s.body === settles[0].body), 'Check again: the same key and bytes').toBe(true);
    same(settles[0].body, `{"expectedTenant":"${TENANT_A}","attemptId":"${key}","expectedVersion":1}`, 'its own withdraw bytes');
    expect(posts(server, 'payment-registrations').length, 'nothing registered again').toBe(1);
  });

  /** A settlement's 200 as the server words it (built per answer: a body is read once). */
  const withdrawn200 = (invoiceId: string, attemptId: string) => new Response(JSON.stringify({ settlement: { invoiceId, attemptId, state: 'withdrawn' } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  /** Another tab's open attempt A on invoice 3, listed by a Record whose register the slot refuses (SII-218). */
  async function listedOther() {
    const { server, made, r, view } = await setup();
    server.regs.push(reg(server, 1, { invoiceId: made[2].id, number: made[2].number }));
    await openRecordable(3);
    await recordWith('1.00');
    await lookupReady();
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'writeConflict' });
    return { server, made, r, view, a: server.regs[0].attemptId };
  }

  it('SII-222. R7: a listed attempt\'s settlement out when a sign-out begins — its late 200 never decides it: the attempt stays held, detached and undecided (only the lookup and a deliberate settlement finish it); nothing more is sent', async () => {
    const { server, made, r, a } = await listedOther();
    server.hold.settle = 1;
    await click('issued-payments-withdraw');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('settle'));
    same(rawHeld(r)?.key, a, 'A\'s settlement is held');
    await act(async () => { await r.props().session!.logout(); });
    await waitFor(() => expect(heldA(r)).toMatchObject({ csrf: null, state: 'unresolved', say: 'detached', body: '' }));
    // The server had withdrawn it before the sign-out reached it; its 200 arrives late.
    server.regs[0].state = 'withdrawn';
    server.regs[0].settledAt = '2026-10-17T12:00:00.000001Z';
    const mark = server.sent.length;
    server.held.shift()!.release(withdrawn200(made[2].id, a));
    await settle();
    expect(heldA(r), 'a late answer never decides it').toMatchObject({ csrf: null, state: 'unresolved', say: 'detached', body: '' });
    same(rawHeld(r)?.key, a, 'the same attempt, kept');
    expect(apart(server, mark).length, 'nothing more sent').toBe(0);
    expect(posts(server, 'payment-settlement').length).toBe(1);
  });

  it('SII-222b. R7: a late settlement answer for an attempt no longer held changes nothing — the section left (navigation) while A\'s settlement was out; a second mount on the same hold store (the app\'s one store) finishes A and holds a new recording C; then A\'s first answer arrives: no hold removed or changed, nothing sent', async () => {
    const { server, made, r, view, a } = await listedOther();
    server.hold.settle = 1;
    await click('issued-payments-withdraw');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('settle'));
    view.unmount(); // its chain stays out
    render(<ServerIssuedInvoices {...r.props()} />); // the same hold store
    await showAndChoose(STORE_1);
    await listReady();
    await act(async () => { await r.props().session!.logout(); }); // the session ends: A is detached here
    await waitFor(() => expect(heldA(r)).toMatchObject({ csrf: null, state: 'unresolved', say: 'detached' }));
    await click('issued-retry'); // Reconnect
    await storesReady();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(3);
    await click('issued-payments-find');
    await lookupReady(); // A is still open: its first settlement has not been decided
    await click('issued-payments-withdraw'); // A's own row: a new settlement under a new key
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    expect(server.regs[0].state).toBe('withdrawn');
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)?.state).toBe('recorded'));
    const before = rawHeld(r);
    expect(before !== undefined && before.key !== a, 'C is held, not A').toBe(true);
    await settle();
    const mark = server.sent.length;
    server.held.shift()!.release(withdrawn200(made[2].id, a)); // A's first settlement answers at last
    await settle();
    expect(rawHeld(r) === before, 'no hold removed or changed').toBe(true);
    expect(heldA(r)).toMatchObject({ state: 'recorded' });
    expect(apart(server, mark).length, 'nothing sent').toBe(0);
  });

  it('SII-223. R7 (Part B): a PROOF-stage attempt (registered, its proof answered 404: lookup-only) never sent a record, so a COMPLETE read that no longer lists its registration decides it — done, the lookup says none, nothing sent, Record returns', async () => {
    const { server, r } = await setup();
    await openRecordable(3);
    server.payScripts.proof.push(404);
    await recordWith('1.00');
    await lookupReady();
    expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'proof', say: 'detached', body: '', proof: null });
    expect(screen.getAllByTestId('issued-payments-attempt').length).toBe(1);
    server.regs.splice(0); // no longer listed (settled over 24 h ago)
    const count = () => ['payment-registrations', 'payments', 'payment-settlement', 'payment-registration-proof'].map((route) => server.payRequests(route as 'payments').length).join(',');
    const sent = count();
    await click('issued-payments-find');
    await lookupReady();
    expect(heldA(r), 'decided by its absence').toMatchObject({ state: 'done', body: '', proof: null });
    expect(flow()).toBe('');
    expect(tid('issued-payments-attempts')).toHaveTextContent('No unfinished payment attempts were found on this invoice.');
    expect(posts(server, 'payments').length, 'no record ever sent').toBe(0);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
    expect(count(), 'nothing sent').toBe(sent);
  });

  it('SII-224. R7b: a RECORDED attempt (its payment known, Confirm not pressed) detached by a sign-out, whose registration a COMPLETE read no longer lists (confirmed elsewhere over 24 h ago: a registration with a payment is never withdrawn, 037), is decided confirmed — "Payment confirmed.", page one once more, nothing sent, Record returns', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'recorded', stage: 'record' }));
    const key = rawHeld(r)?.key;
    await act(async () => { await r.props().session!.logout(); });
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'recorded', csrf: null, say: 'detached' }));
    await click('issued-retry'); // Reconnect
    await storesReady();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(3);
    await settle();
    expect(flow()).toBe(DETACHED);
    expect(screen.queryByTestId('issued-payments-confirm'), 'detached: no Confirm from here').toBeNull();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record beside it').toBeNull();
    // Confirmed in another tab over 24 h ago: no longer listed.
    server.regs[0].state = 'confirmed';
    server.regs.splice(0);
    const count = () => ['payment-registrations', 'payments', 'payment-settlement', 'payment-registration-proof'].map((route) => server.payRequests(route as 'payments').length).join(',');
    const sent = count();
    const reads = server.paymentReads().length;
    await click('issued-payments-find');
    await lookupReady();
    expect(heldA(r), 'decided confirmed by its absence').toMatchObject({ state: 'done', say: 'confirmed', body: '', proof: null });
    same(rawHeld(r)?.key, key, 'its own hold');
    expect(flow()).toBe('Payment confirmed.');
    await waitFor(() => expect(server.paymentReads().length, 'page one once more').toBe(reads + 1));
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
    await settle();
    expect(server.paymentReads().length, 'only once').toBe(reads + 1);
    expect(count(), 'nothing sent').toBe(sent);
    expect((server.payments.get(made[2].id) ?? []).length, 'still ONE payment').toBe(1);
  });

  const NOT_LISTED = "This payment attempt is no longer listed, so it can't be finished from here. Check this invoice's payments.";
  /** Every recording request (registrations, proofs, records, settlements) so far, as one comparable value. */
  const recordingSent = (server: Server) => ['payment-registrations', 'payments', 'payment-settlement', 'payment-registration-proof']
    .map((route) => server.payRequests(route as 'payments').length).join(',');

  it('SII-225a. R7 (Part B): a row Withdraw (v1) whose answer is lost, then a sign-out and sign-in (detached), whose registration a COMPLETE read no longer lists — at its settlement, with no payment known, absence proves nothing: Find keeps the hold undecided, says it is no longer listed and sends nothing', async () => {
    const { server, r, a } = await listedOther();
    server.payScripts.settle.push('lose'); // committed (withdrawn), the answer lost
    await click('issued-payments-withdraw');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'settle', body: 'held' }));
    same(rawHeld(r)?.key, a, 'A\'s settlement is held');
    expect(rawHeld(r)?.payment === null, 'no payment known').toBe(true);
    await signOutAndBack(r, 3);
    expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'settle', say: 'detached', csrf: null, body: '' });
    server.regs.splice(0); // settled over 24 h ago: no longer listed
    const sent = recordingSent(server);
    await click('issued-payments-find');
    await lookupReady();
    expect(heldA(r), 'decided by nothing').toMatchObject({ state: 'unresolved', stage: 'settle', say: 'detached', csrf: null, body: '' });
    same(rawHeld(r)?.key, a, 'the same attempt, kept');
    expect(flow()).toBe(DETACHED);
    expect(tid('issued-payments-attempts')).toHaveTextContent(NOT_LISTED);
    await settle();
    expect(recordingSent(server), 'nothing sent').toBe(sent);
    expect(screen.queryByTestId('issued-payments-record'), 'no Record beside it').toBeNull();
  });

  it('SII-225b. R7 (Part B): a row Confirm (v2) of a listed recorded attempt (its payment known) whose answer is lost, then a sign-out and sign-in (detached), whose registration a COMPLETE read no longer lists — a registration with a payment is never withdrawn (037), so Find decides it confirmed: "Payment confirmed.", page one once more, nothing sent', async () => {
    const { server, made, r } = await setup();
    server.regs.push(reg(server, 1, { invoiceId: made[2].id, number: made[2].number, state: 'recorded',
      payment: { id: uuid(0x9c01), attemptId: uuid(0xac01), amountCents: 300, method: 'cash', recordedAt: '2026-10-17T07:30:00.000001Z', reversal: null } }));
    await openRecordable(3);
    await recordWith('1.00'); // the sealed write_conflict: the lookup lists the recorded attempt
    await lookupReady();
    const a = server.regs[0].attemptId;
    server.payScripts.settle.push('lose'); // committed (confirmed), the answer lost
    await click('issued-payments-attempt-confirm');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'settle', body: 'held' }));
    same(rawHeld(r)?.key, a, 'A\'s settlement is held');
    expect(rawHeld(r)?.payment !== null, 'its payment is known (the row\'s)').toBe(true);
    await signOutAndBack(r, 3);
    expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'settle', say: 'detached', csrf: null });
    expect(server.regs[0].state).toBe('confirmed');
    server.regs.splice(0); // confirmed over 24 h ago: no longer listed
    const sent = recordingSent(server);
    const reads = server.paymentReads().length;
    await click('issued-payments-find');
    await lookupReady();
    expect(heldA(r), 'decided confirmed by its absence').toMatchObject({ state: 'done', say: 'confirmed', body: '' });
    same(rawHeld(r)?.key, a, 'its own hold');
    expect(flow()).toBe('Payment confirmed.');
    await waitFor(() => expect(server.paymentReads().length, 'page one once more').toBe(reads + 1));
    await settle();
    expect(recordingSent(server), 'nothing sent').toBe(sent);
  });

  it('SII-226. R7 (Part B) — the FAIL-CLOSED LOCKOUT the owner accepts: a record-404 attempt whose registration is no longer listed (withdrawn in another tab over 24 h ago) stays undecided, so another tab\'s later open registration on the same invoice is listed but its Withdraw is held back ("Finish the payment attempt above first."); nothing sent, no Record — only the invoice\'s payments, outside this page, can tell', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(404);
    await recordWith('1.00');
    await lookupReady();
    expect(heldA(r)).toMatchObject({ state: 'lookup', stage: 'record', say: 'record404' });
    const key = rawHeld(r)?.key;
    // Another tab withdrew it, it aged out of the list, and only then did another tab of this user register here (037).
    server.regs.splice(0);
    server.regs.push(reg(server, 1, { invoiceId: made[2].id, number: made[2].number }));
    const sent = recordingSent(server);
    await click('issued-payments-find');
    await lookupReady();
    expect(heldA(r), 'decided by nothing').toMatchObject({ state: 'lookup', stage: 'record', say: 'record404' });
    same(rawHeld(r)?.key, key, 'the same attempt, kept');
    expect(flow()).toBe(RECORD_404);
    expect(tid('issued-payments-attempts')).toHaveTextContent(NOT_LISTED);
    const withdraw = tid('issued-payments-withdraw');
    expect(withdraw).toHaveAttribute('aria-disabled', 'true');
    expect(document.getElementById('issued-payments-attempt-note-0')?.textContent === FINISH_FIRST, 'the finish-first note').toBe(true);
    await user().click(withdraw);
    await settle();
    expect(recordingSent(server), 'nothing sent').toBe(sent);
    expect(server.regs[0].state).toBe('open');
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on its invoice').toBeNull();
  });

  it('SII-227. R8 (G1): a record that committed with its answer lost, whose Check again is answered the sealed already_recorded (037 answers it only for the caller\'s registration of THIS attempt once it has its payment), is recorded with its payment id unnamed; detached by a sign-out, a CAPPED read decides nothing, and a COMPLETE read that no longer lists it (confirmed over 24 h ago) decides it confirmed — "Payment confirmed.", no settlement sent, Record returns', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push('lose'); // committed: the registration has its payment; the answer is lost
    await recordWith('1.00');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'record', body: 'held' }));
    expect(server.regs.map((g) => g.state).join(','), 'the record committed').toBe('recorded');
    const key = rawHeld(r)?.key;
    const recordKey = keyOf(posts(server, 'payments')[0]) ?? '';
    // Its sealed 201 is gone (retention is 24 h, idempotency.ts IDEMPOTENCY_POLICY, longer than the 23 h a hold keeps its bytes,
    // so only a lost idempotency record does this), and the record runs again on a registration that has its payment: 037's
    // sealed already_recorded. Whenever 037 answers it, the client must take it as this attempt's payment, its id unnamed.
    expect(server.keys.delete(recordKey), 'its sealed 201 was held').toBe(true);
    await click('issued-payments-check');
    await waitFor(() => expect(heldA(r)).toMatchObject({ state: 'recorded', stage: 'record', body: '', proof: null }));
    expect(posts(server, 'payments').length, 'the Check again: one more record').toBe(2);
    same(keyOf(posts(server, 'payments')[1]), recordKey, 'under its same key');
    expect(server.keys.get(recordKey)?.status, 'answered 409').toBe(409);
    expect((server.keys.get(recordKey)?.body as { error?: string } | undefined)?.error).toBe('already_recorded');
    expect(rawHeld(r)?.payment, 'its payment known by its own amount, its id unnamed').toEqual({ id: null, amountCents: 100, method: 'cash' });
    await signOutAndBack(r, 3);
    expect(heldA(r)).toMatchObject({ state: 'recorded', say: 'detached', csrf: null });
    expect(flow()).toBe(DETACHED);
    // Settled ones (listed for 24 h) registered before it fill more than 20 pages: the read is capped before its row.
    // Timeline: this capped read is on 10-17 between 08:30 and 12:00 (those rows settled within 24 h, its own still recorded); another tab confirms it at 12:00; the complete read below is over 24 h later, when all have aged out.
    const own = server.regs[0];
    server.regs.unshift(...Array.from({ length: 1001 }, (_, i) => reg(server, 2000 + i, { invoiceId: made[i % 2].id, number: made[i % 2].number, state: 'withdrawn', settledAt: '2026-10-17T08:30:00.000001Z' })));
    const sent = recordingSent(server);
    const reads = attemptsReads(server).length;
    await click('issued-payments-find');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'cap'));
    expect(attemptsReads(server).length, '20 full pages').toBe(reads + 20);
    expect(tid('issued-payments-attempts')).toHaveTextContent('There are too many payment attempts to check here.');
    expect(screen.queryAllByTestId('issued-payments-attempt').length, 'none listing it').toBe(0);
    expect(heldA(r), 'a capped read decides nothing').toMatchObject({ state: 'recorded', say: 'detached', csrf: null });
    same(rawHeld(r)?.key, key, 'its own hold, kept');
    expect(flow()).toBe(DETACHED);
    await settle();
    expect(screen.queryByTestId('issued-payments-record'), 'no Record on its invoice').toBeNull();
    expect(recordingSent(server), 'nothing sent').toBe(sent);
    // Confirmed in another tab over 24 h ago: no longer listed, and the settled ones have aged out too.
    own.state = 'confirmed';
    own.settledAt = '2026-10-17T12:00:00.000001Z';
    server.regs.splice(0);
    await click('issued-payments-find');
    await lookupReady();
    expect(attemptsReads(server).length, 'one complete read').toBe(reads + 21);
    expect(heldA(r), 'decided confirmed by its absence').toMatchObject({ state: 'done', say: 'confirmed', body: '', proof: null });
    same(rawHeld(r)?.key, key, 'its own hold');
    expect(flow()).toBe('Payment confirmed.');
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record'), 'Record returns').not.toBeNull());
    await settle();
    expect(posts(server, 'payment-settlement').length, 'no settlement sent').toBe(0);
    expect(recordingSent(server), 'nothing sent').toBe(sent);
    expect((server.payments.get(made[2].id) ?? []).length, 'still ONE payment').toBe(1);
  });

  it('SII-228. R8 (G2, Decision 1): a register still out in transit when a sign-out begins (detached: unresolved, no token, no bytes) is retired past its 60 s by a COMPLETE read without its row — done, no line, "No unfinished…", Record back; when that register then commits late and its 201 arrives, it starts nothing: no proof GET, no record, the hold stays done and no line returns', async () => {
    const { server, r, view } = await setup();
    await openRecordable(3);
    server.hold.register = 1; // held at the front: it reaches the fake only when released
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('register'));
    const key = rawHeld(r)?.key;
    // In this section Find waits for its own chain (R3-4): the section is left while the register is out, and a second
    // mount on the same hold store (the app's one store, SII-222b) finds it once the sign-out has detached it.
    view.unmount(); // its chain stays out
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await signOutAndBack(r, 3);
    expect(heldA(r)).toMatchObject({ state: 'unresolved', stage: 'register', say: 'detached', csrf: null, body: '', proof: null });
    expect(server.regs.length, 'nothing registered yet').toBe(0);
    quiet(r); // past REGISTER_QUIET_MS since its last send
    const reads = attemptsReads(server).length;
    await click('issued-payments-find');
    await lookupReady();
    expect(attemptsReads(server).length, 'one complete read').toBe(reads + 1);
    expect(heldA(r), 'retired').toMatchObject({ state: 'done', say: '', body: '', proof: null });
    same(rawHeld(r)?.key, key, 'its own hold');
    expect(flow(), 'no hold line').toBe('');
    expect(tid('issued-payments-attempts')).toHaveTextContent('No unfinished payment attempts were found on this invoice.');
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record'), 'Record is back').not.toBeNull());
    await settle();
    // The register commits late (a request delayed in transit), and its 201 arrives. Four layers stop it: after the await the
    // hold-incarnation check (same stage and stage key, not done) and the token check; the loop's token and bytes check; and
    // the hold store's refusal of bytes for a detached hold.
    const mark = server.sent.length;
    server.held.shift()!.release();
    await settle();
    await settle();
    expect(server.regs.map((g) => g.state).join(','), 'the late registration committed').toBe('open');
    same(server.regs[0].attemptId, key, 'its own attempt');
    expect(server.payRequests('payment-registration-proof').length, 'no proof GET').toBe(0);
    expect(posts(server, 'payments').length, 'no record').toBe(0);
    expect(posts(server, 'payment-registrations').length, 'the one register').toBe(1);
    expect(apart(server, mark).length, 'nothing sent').toBe(0);
    expect(heldA(r), 'still retired').toMatchObject({ state: 'done', say: '', body: '', proof: null });
    same(rawHeld(r)?.key, key, 'the same hold');
    expect(flow(), 'no line returns').toBe('');
    expect(screen.queryByTestId('issued-payments-record'), 'Record stays').not.toBeNull();
  });

  it('SII-229. R8: a late PROOF answer of a chain whose hold was detached by a store switch and then re-created by its own row\'s Withdraw in a second mount (the same attempt, the same token) never starts a record on that hold, and the old chain never unsticks its settle — the settlement withdraws it: "Attempt withdrawn. No payment was recorded.", zero payments', async () => {
    const { server, made, r, view } = await setup();
    await openRecordable(3);
    server.hold.proof = 1; // the register commits; its proof GET is out, slow
    await recordWith('1.00');
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('proof'));
    expect(heldA(r)).toMatchObject({ state: 'sending', stage: 'proof' });
    const key = rawHeld(r)?.key;
    const token = rawHeld(r)?.csrf;
    await close();
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } }); // detached; the token is unchanged
    await settle();
    expect(heldA(r)).toMatchObject({ state: 'unresolved', say: 'detached', csrf: null, body: '' });
    view.unmount(); // the section left: its chain keeps awaiting the proof
    render(<ServerIssuedInvoices {...r.props()} />); // the same hold store
    await showAndChoose(STORE_1); // the store chosen back
    await listReady();
    await open(3);
    expect(flow()).toBe(DETACHED);
    await click('issued-payments-find');
    await lookupReady();
    expect(screen.getByTestId('issued-payments-attempt')).toHaveAttribute('data-attempt-state', 'open');
    server.hold.settle = 1;
    await click('issued-payments-withdraw'); // its own attempt: the hold re-created under the same key and token
    await waitFor(() => expect(server.held.map((h) => h.kind).join(',')).toBe('proof,settle'));
    expect(heldA(r)).toMatchObject({ state: 'sending', stage: 'settle' });
    same(rawHeld(r)?.key, key, 'the same attempt');
    same(rawHeld(r)?.csrf, token, 'the same token: only the hold incarnation tells the two chains apart');
    const proof = server.held.findIndex((h) => h.kind === 'proof');
    server.held.splice(proof, 1)[0].release(); // the first mount's proof answer arrives
    await settle();
    await settle();
    expect(posts(server, 'payments').length, 'no record POST').toBe(0);
    expect(heldA(r), 'its settle still out').toMatchObject({ state: 'sending', stage: 'settle' });
    same(rawHeld(r)?.key, key, 'the same hold');
    server.held.shift()!.release(); // the settle
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
    expect(heldA(r)).toMatchObject({ state: 'done', say: 'withdrawn' });
    expect(server.regs.map((g) => g.state).join(','), 'withdrawn on the server').toBe('withdrawn');
    expect((server.payments.get(made[2].id) ?? []).length, 'zero payments').toBe(0);
    expect(posts(server, 'payment-settlement').length, 'one settlement').toBe(1);
    expect(posts(server, 'payments').length, 'never a record').toBe(0);
  });
});

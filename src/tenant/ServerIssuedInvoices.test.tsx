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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ACTIVITY_TEXT, CREDIT_TEXT, creditNoteHoldsSignIns, ISSUED_TEXT, IssuedInvoiceDialog, LIST_TEXT, PAYMENTS_TEXT, REVERSE_TEXT, SETTINGS_RULE_TEXT, SETTINGS_TEXT, ServerIssuedInvoices, VIEW_TEXT, VOID_REFUSED_TEXT, VOID_SIGNIN_WAIT_MS, VOID_TEXT, type IssuedPaymentsCapability, type IssuedVoidCapability, type IssuedReadAnswer, type PaymentsReadAnswer, type ServerIssuedInvoicesProps, type VoidPress, type VoidSendOutcome, type CreditReads } from './ServerIssuedInvoices';
import { creditNoteIssueBodyOf, creditNoteRegisterBodyOf, settleBodyOf, utcText, INVOICE_CREDIT_NOTE_REASONS, INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS, INVOICE_PAYMENT_REVERSAL_REASONS, INVOICE_VOID_REASONS, VOID_REASON_CODES, createInvoiceIssuingClient, issuingSettingsPathOf, type InvoiceVoidReasonCode, type IssuedInvoice, type IssuedSummary, type VoidResult } from './invoiceIssuingClient';
import { STORES_PATH, createInvoiceDraftsClient, type StoreEntry } from './invoiceDraftsClient';
import { quiet as quietClass, RECORD_ID_TEXT } from './ServerInvoiceDrafts';
import { TENANT_SESSION_PATHS, createTenantSessionClient, sessionEndsSoFar } from './tenantSessionClient';
import { VOID_NOTE_TEXT, createVoidHoldStore, isLiveVoid, settleVoid, voidExpired, voidHolds, type HeldVoid, type VoidHoldStore, type VoidRefusal } from './invoiceVoidHold';
import type { ShopIdentity } from './ServerCustomerLevels';
import { createPaymentHoldStore, judgePayment, type HeldPayment, type PaymentHoldStore } from './invoicePaymentHold';
import { createReversalHoldStore, REVERSAL_NOTE_TEXT, seeReversal, type ReversalHoldStore } from './invoiceReversalHold';
import {
  CREDIT_NOTE_FIRST_SEND_MS, CREDIT_NOTE_REPLAY_MS, CREDIT_NOTE_SETTLE_REPLAY_MS, createCreditNoteHoldStore, replayWindowOpen, signInFresh,
  type CreditNoteHoldStore, type HeldCreditNote,
} from './invoiceCreditNoteHold';
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
type Kind = 'stores' | 'settings' | 'put' | 'current' | 'list' | 'detail' | 'elig' | 'void' | 'payments' | 'payElig' | 'register' | 'proof' | 'record' | 'settle' | 'attempts'
  | 'cnRegister' | 'cnProof' | 'cnIssue' | 'cnList' | 'cnSettle' | 'cnLookup' | 'activity';
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
/** One credit note as the fake keeps it (CN-P2): the list route's item, its names kept and served to the store owner only. */
type CreditNoteWire = {
  id: string; invoiceId: string; number: number; grossCents: number; taxCents: number; netCents: number; reason: string; issuedAt: string; issuedByName: string | null;
  withdrawal: { withdrawnAt: string; reason: string; withdrawnByName: string | null } | null;
};
/** One credit-note registration (038) as the lookup lists it and the commands find it: never served with its id or proof but to its own session. */
type CreditRegWire = {
  id: string; uid: string; storeId: string; invoiceId: string; number: number; attemptId: string; csrf: string; state: 'open' | 'issued' | 'released' | 'confirmed';
  registeredAt: string; settledAt: string | null; grossCents: number; reason: string; proof: string; creditNote: { id: string; issuedAt: string; withdrawnAt: string | null } | null;
};
type CnRoute = 'register' | 'proof' | 'issue' | 'list' | 'settle' | 'lookup';
const CN_KIND: Record<CnRoute, Kind> = { register: 'cnRegister', proof: 'cnProof', issue: 'cnIssue', list: 'cnList', settle: 'cnSettle', lookup: 'cnLookup' };
/** The database clock in 038's form (UTC, microseconds), `i` seconds into a synthetic day: fixed width, so string order is time order. */
const cnTime = (i: number): string => new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString().replace('Z', '000Z');

/** Each mount (never a rerender) is a new generation for P2-89 (the only same-token generation change, fix list 6 C). */
let mountEpoch = 0;
const render: typeof rtlRender = ((ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) => { mountEpoch += 1; return rtlRender(ui, options); }) as typeof rtlRender;
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
    hold: { stores: 0, settings: 0, put: 0, current: 0, list: 0, detail: 0, elig: 0, void: 0, payments: 0, payElig: 0, register: 0, proof: 0, record: 0, settle: 0, attempts: 0,
      cnRegister: 0, cnProof: 0, cnIssue: 0, cnList: 0, cnSettle: 0, cnLookup: 0, activity: 0 } as Record<Kind, number>,
    // M7B-PAYMENTS-P2A: the payments read as server/runtime/invoicePayments.ts answers it — the amounts and word over the
    // whole history (due the Total while issued, 0 once voided), pages of 50 oldest first, the cursor the last id of a full page.
    payments: new Map<string, PaymentWire[]>(), // invoice -> its payments, oldest first
    credits: new Map<string, number>(), // invoice -> its active credit notes' sum (M7B-CREDITNOTES-P1; the read's creditedCents)
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
    // M7B-CREDITNOTES-CN-P2 (doc 17 §5 support F): the six credit-note routes CN-P2 uses — never the withdrawal — as
    // server/runtime/invoiceCreditNotes.ts and 038 answer them: register and issue session-bound and recent-sign-in only,
    // a key ledger by key, store and exact bytes (a replay answers the stored response with Idempotent-Replayed), sealed 409s
    // exactly `{ error }`, the proof of the registering session only, the settlement's `unchanged`, the caller's own
    // attempts and the invoice's notes in pages of 50 with their cursors. Defaults: the lookup 403 (nobody in `cnOwners`)
    // and an empty list, so the older describes keep their control inventories.
    creditNotes: new Map<string, CreditNoteWire[]>(), // invoice -> its notes (served by issuedAt, then id)
    cnRegs: [] as CreditRegWire[],
    /** Who holds the store-owner credit-note keys (opt-in): an owner at a writable store; everyone else's lookup is 403. */
    cnOwners: new Set<string>(),
    /** Users whose list pages carry no names (a demotion the session read cannot show). */
    cnNamesHidden: new Set<string>(),
    /** The staff names the list shows the owner (null: never set). */
    cnNames: { 'uid-a': 'Ada Owner', 'uid-m': 'Max Manager' } as Record<string, string | null>,
    /** What the next requests of each route do: a status in the chain's envelope after the session (and, for commands, the chain), a whole answer, 'lose' (decide, then lose the answer), 'lose-before', 'commit-404'. */
    cnScripts: { register: [], proof: [], issue: [], list: [], settle: [], lookup: [] } as Record<CnRoute, PayScript[]>,
    cnPage: 50,
    cnAttemptsPage: 50,
    cnBodyViolations: [] as string[],
    cnClock: 0,
    cnNumber: 0,
    /** The database clock's next instant (after every seeded one). */
    cnTick(): string { server.cnClock += 1; return cnTime(100_000 + server.cnClock); },
    mayCredit(user: User, storeId: string): boolean {
      const entry = server.stores[user.uid]?.find((s) => s.id === storeId);
      return entry !== undefined && !entry.readOnly && user.role === 'owner' && server.cnOwners.has(user.uid);
    },
    /** `count` notes on `invoiceId`, numbered on from the store's last, a second apart from `at` (the payments read's credited amount is left as it is). */
    addCreditNotes(invoiceId: string, count: number, over: (i: number) => Partial<CreditNoteWire> = () => ({}), at = 0): CreditNoteWire[] {
      const made = Array.from({ length: count }, (_, i): CreditNoteWire => {
        server.cnNumber += 1;
        return { id: uuid(0xc000 + server.cnNumber), invoiceId, number: server.cnNumber, grossCents: 100, taxCents: 8, netCents: 92, reason: 'goodwill', issuedAt: cnTime(at + i), issuedByName: 'Ada Owner', withdrawal: null, ...over(i) };
      });
      server.creditNotes.set(invoiceId, [...(server.creditNotes.get(invoiceId) ?? []), ...made]);
      return made;
    },
    /** One registration of `uid` (an open one, registered now, unless `over` says otherwise). */
    addCreditReg(over: Partial<CreditRegWire> & { invoiceId: string }): CreditRegWire {
      const g: CreditRegWire = {
        id: uuid(0x7e000 + server.cnRegs.length + 1), uid: 'uid-a', storeId: STORE_1, number: 1, attemptId: uuid(0x6e000 + server.cnRegs.length + 1), csrf: '', state: 'open',
        registeredAt: server.cnTick(), settledAt: null, grossCents: 100, reason: 'goodwill', proof: randomBytes(32).toString('hex'), creditNote: null, ...over,
      };
      server.cnRegs.push(g);
      return g;
    },
    // Doc 18: the store-wide credit activity (GET /api/v1/stores/{id}/credit-notes, no invoice segment) as the route and
    // 039 answer it under D-CA-1 A: the store owner with the credit-note keys at a writable store (mayCredit) gets every
    // note of the store's issued invoices, newest number first, 50 a page, `nextCursor` the 50th id only when a 51st
    // exists; everyone else 403. Scripts answer after the chain (a status in its envelope, or a whole answer).
    activityScripts: [] as Array<number | Response>,
    activityPage: 50,
    /** The activity reads that reached the fake, as sent (the store-wide path only: never an invoice's list). */
    activityReads(): Sent[] { return server.sent.filter((r) => /^\/api\/v1\/stores\/[^/]+\/credit-notes(\?|$)/.test(r.url)); },
    /** The credit-note requests that reached the fake, as sent (one route's when given; never the store-wide activity). */
    cnRequests(route?: CnRoute): Sent[] {
      return server.sent.filter((r) => {
        const at = /\/(credit-note-registrations|credit-note-registration-proof|credit-notes|credit-note-settlement|credit-note-attempts)(\?|$)/.exec(r.url);
        if (at === null || /^\/api\/v1\/stores\/[^/]+\/credit-notes(\?|$)/.test(r.url)) return false;
        const named: CnRoute = at[1] === 'credit-note-registrations' ? 'register' : at[1] === 'credit-note-registration-proof' ? 'proof' : at[1] === 'credit-note-settlement' ? 'settle'
          : at[1] === 'credit-note-attempts' ? 'lookup' : r.method === 'POST' ? 'issue' : 'list';
        return route === undefined || route === named;
      });
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
    /** P2-89's request log: the credit-note lookup, issue and settlement answers (status and body text), by the request sent. */
    cnAnswers: new Map<Sent, { readonly status: number; readonly text: string }>(),
    /** Per request: the mount it was sent from (the generation, fix list 6 C) and, once answered, `sent.length` at delivery. */
    cnMeta: new Map<Sent, { readonly epoch: number; answeredAt: number | null }>(),
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const at = server.sent.length;
      const epoch = mountEpoch;
      const pending = server.serve(input, init);
      const sent = server.sent[at];
      const meta = { epoch, answeredAt: null as number | null };
      if (sent !== undefined) server.cnMeta.set(sent, meta);
      const answer = await pending;
      if (sent !== undefined && /\/(credit-note-attempts|credit-notes|credit-note-settlement)(\?|$)/.test(sent.url) && (sent.method === 'POST' || sent.url.includes('credit-note-attempts'))) {
        server.cnAnswers.set(sent, { status: answer.status, text: await answer.clone().text() });
      }
      meta.answeredAt = server.sent.length; // delivered to the page now: evidence only for what is sent after this
      return answer;
    }) as typeof globalThis.fetch,
    serve: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
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
          const answer = paymentsOf(found, server.payments.get(invoiceId) ?? [], after ?? null, server.credits.get(invoiceId) ?? 0);
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
      const activityPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/credit-notes(?:\?(.*))?$/.exec(url);
      if (activityPath !== null) {
        if (method !== 'GET') return refuse(404);
        return server.maybeHold('activity', url, () => {
          const refused = gate();
          if (refused !== null) return refused;
          const [, storeId, query] = activityPath;
          if (!server.mayCredit(session!.user, storeId)) return refuse(403, 'forbidden'); // authorization: the owner rule (PERM:563-565)
          const scripted = server.activityScripts.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          const q = query === undefined ? null : /^after=([0-9a-f-]{36})$/.exec(query);
          if (query !== undefined && q === null) return refuse(400, 'invalid_request');
          const invoices = server.issued.get(storeId) ?? [];
          const all = invoices.flatMap((i) => (server.creditNotes.get(i.id) ?? []).map((c) => ({ c, invoiceNumber: i.number }))).sort((a, b) => b.c.number - a.c.number);
          const start = q === null ? 0 : all.findIndex((x) => x.c.id === q[1]) + 1;
          if (q !== null && start === 0) return refuse(400, 'invalid_request'); // cursor_unknown
          const page = all.slice(start, start + server.activityPage);
          return reply(200, {
            store: { id: storeId },
            creditNotes: page.map(({ c, invoiceNumber }) => ({
              id: c.id, number: c.number, invoiceId: c.invoiceId, invoiceNumber, grossCents: c.grossCents, reason: c.reason, issuedAt: c.issuedAt, issuedByName: c.issuedByName,
              withdrawal: c.withdrawal === null ? null : { withdrawnAt: c.withdrawal.withdrawnAt, reason: c.withdrawal.reason, withdrawnByName: c.withdrawal.withdrawnByName },
            })),
            nextCursor: start + server.activityPage < all.length && page.length > 0 ? page[page.length - 1].c.id : null,
          });
        });
      }
      // M7B-CREDITNOTES-CN-P2: the credit-note routes (support F above).
      const cnLookup =/^\/api\/v1\/stores\/([0-9a-f-]{36})\/credit-note-attempts(?:\?(.*))?$/.exec(url);
      const cnRoute = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\/([0-9a-f-]{36})\/(credit-note-registrations|credit-note-registration-proof|credit-notes|credit-note-settlement)(?:\?(.*))?$/.exec(url);
      if ((cnLookup !== null && method === 'GET') || cnRoute !== null) {
        const storeId = (cnLookup ?? cnRoute)![1];
        const invoiceId = cnRoute?.[2] ?? '';
        const query = (cnLookup ?? cnRoute)![cnLookup !== null ? 2 : 4];
        const at = cnRoute?.[3];
        const route: CnRoute = cnLookup !== null ? 'lookup' : at === 'credit-note-registrations' ? 'register' : at === 'credit-note-registration-proof' ? 'proof'
          : at === 'credit-note-settlement' ? 'settle' : method === 'GET' ? 'list' : 'issue';
        if ((route === 'proof' || route === 'list' || route === 'lookup') !== (method === 'GET')) return refuse(404);
        const script = server.cnScripts[route].shift();
        if (script === 'lose-before') throw new TypeError('network');
        // The chain first: the session and its token (every route is session-bound or an unsafe method), the intent header,
        // the route's authority (the list: any reader of issued invoices; the rest: the store owner's keys), then a register's
        // or an issue's recent sign-in — all before any key.
        const chain = (): Response | null => {
          const refused = gate();
          if (refused !== null) return refused;
          if (method === 'POST' && headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
          const user = session!.user;
          if (route === 'list' ? server.issuedDenied.has(user.uid) || !server.stores[user.uid]?.some((s) => s.id === storeId) : !server.mayCredit(user, storeId)) return refuse(403, 'forbidden');
          if ((route === 'register' || route === 'issue') && !session!.fresh) return refuse(403, 'step_up_required');
          return null;
        };
        if (typeof script === 'number') return server.maybeHold(CN_KIND[route], url, () => chain() ?? refuse(script));
        if (script instanceof Response) return server.maybeHold(CN_KIND[route], url, () => chain() ?? script);
        const decide = (): Response => {
          const refused = chain();
          if (refused !== null) return refused;
          const uid = session!.user.uid;
          const found = server.issued.get(storeId)?.find((i) => i.id === invoiceId);
          if (route === 'lookup') {
            const q = query === undefined ? null : /^after=([0-9a-f-]{36})\.([0-9a-f-]{36})$/.exec(query);
            if (query !== undefined && q === null) return refuse(400, 'invalid_request');
            const own = server.cnRegs.filter((g) => g.uid === uid && g.storeId === storeId)
              .sort((a, b) => (a.registeredAt < b.registeredAt ? -1 : a.registeredAt > b.registeredAt ? 1 : a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : a.attemptId < b.attemptId ? -1 : 1));
            const start = q === null ? 0 : own.findIndex((g) => g.invoiceId === q[1] && g.attemptId === q[2]) + 1;
            if (q !== null && start === 0) return refuse(400, 'invalid_request'); // not one of the caller's rows
            const page = own.slice(start, start + server.cnAttemptsPage);
            const last = page[page.length - 1];
            return reply(200, {
              attempts: page.map((g) => ({
                invoiceId: g.invoiceId, invoiceNumber: g.number, attemptId: g.attemptId, state: g.state, version: g.state === 'open' ? 1 : g.state === 'issued' ? 2 : 3,
                registeredAt: g.registeredAt, settledAt: g.settledAt, grossCents: g.grossCents, reason: g.reason, creditNote: g.creditNote,
              })),
              nextCursor: start + server.cnAttemptsPage < own.length && last !== undefined ? `${last.invoiceId}.${last.attemptId}` : null,
            });
          }
          if (route === 'list') {
            if (found === undefined) return refuse(404, 'not_found');
            const q = query === undefined ? null : /^after=([0-9a-f-]{36})$/.exec(query);
            if (query !== undefined && q === null) return refuse(400, 'invalid_request');
            const all = [...(server.creditNotes.get(invoiceId) ?? [])].sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : a.issuedAt > b.issuedAt ? 1 : a.id < b.id ? -1 : 1));
            const start = q === null ? 0 : all.findIndex((c) => c.id === q[1]) + 1;
            if (q !== null && start === 0) return refuse(400, 'invalid_request'); // not a note of this invoice
            const page = all.slice(start, start + server.cnPage);
            // Names only for the store owner (038 :1923-1925): both keys present, a string or null; else both absent.
            const named = session!.user.role === 'owner' && !server.cnNamesHidden.has(uid);
            return reply(200, {
              invoice: { id: invoiceId },
              creditNotes: page.map((c) => ({
                id: c.id, number: c.number, grossCents: c.grossCents, taxCents: c.taxCents, netCents: c.netCents, reason: c.reason, issuedAt: c.issuedAt,
                ...(named ? { issuedByName: c.issuedByName } : {}),
                withdrawal: c.withdrawal === null ? null : { withdrawnAt: c.withdrawal.withdrawnAt, reason: c.withdrawal.reason, ...(named ? { withdrawnByName: c.withdrawal.withdrawnByName } : {}) },
              })),
              nextCursor: start + server.cnPage < all.length && page.length > 0 ? page[page.length - 1].id : null,
            });
          }
          if (route === 'proof') {
            const q = /^registration=([0-9a-f-]{36})$/.exec(query ?? '');
            if (q === null) return refuse(400, 'invalid_request');
            // Open, this caller's, on this invoice, made in THIS session (038: every other case is the same 404).
            const g = server.cnRegs.find((r) => r.id === q[1] && r.uid === uid && r.invoiceId === invoiceId && r.state === 'open' && r.csrf === session!.csrf);
            return g === undefined ? refuse(404, 'not_found') : reply(200, { registration: { id: g.id, invoiceId, attemptId: g.attemptId }, proof: g.proof });
          }
          if (query !== undefined) return refuse(400, 'invalid_request');
          const key = headers.get('idempotency-key') ?? '';
          const bound = route === 'settle' ? '' : session!.csrf; // register and issue bind the session into the fingerprint; the settlement does not
          const fingerprint = `${uid}\ncn-${route}\n${storeId}\n${invoiceId}\n${bound}\n${body}`;
          const known = server.keys.get(key);
          if (known !== undefined && known.fingerprint !== fingerprint) return refuse(422, 'idempotency_key_reused');
          if (known !== undefined) return reply(known.status, known.body, { 'idempotent-replayed': 'true' });
          const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
          const order = { register: 'expectedTenant,attemptId,grossCents,reason', issue: 'expectedTenant,registrationId,attemptId,grossCents,reason,registrationProof', settle: 'expectedTenant,attemptId,expectedVersion' }[route];
          if (Object.keys(parsed).join(',') !== order) server.cnBodyViolations.push(route);
          const entry = server.stores[uid]?.find((s) => s.id === storeId);
          if (entry === undefined || parsed.expectedTenant !== entry.tenantId) return refuse(409, 'write_conflict'); // unsealed: nothing stored
          if (found === undefined) return refuse(404, 'not_found');
          const seal = (status: number, sealed: unknown): Response => { server.keys.set(key, { fingerprint, status, body: sealed }); return reply(status, sealed); };
          const mine = server.cnRegs.filter((r) => r.uid === uid && r.invoiceId === invoiceId);
          const own = mine.find((r) => r.attemptId === parsed.attemptId);
          if (route === 'register') {
            if (own?.creditNote != null) return seal(409, { error: 'already_issued' });
            if (mine.some((r) => r.state === 'open' || r.state === 'issued')) return seal(409, { error: 'write_conflict' }); // the slot rule
            if (own !== undefined || found.void !== undefined) return seal(409, { error: 'invalid_state' });
            const g = server.addCreditReg({ uid, storeId, invoiceId, number: found.number, attemptId: parsed.attemptId as string, csrf: session!.csrf, grossCents: parsed.grossCents as number, reason: parsed.reason as string });
            return seal(201, { registration: { id: g.id, invoiceId, attemptId: g.attemptId, grossCents: g.grossCents, reason: g.reason, state: 'open' } });
          }
          if (route === 'issue') {
            if (own === undefined || own.id !== parsed.registrationId || own.csrf !== session!.csrf || parsed.registrationProof !== own.proof) return refuse(404, 'not_found');
            if (own.creditNote !== null) return seal(409, { error: 'already_issued' });
            if (own.state === 'released') return seal(409, { error: 'invalid_state' });
            if (parsed.grossCents !== own.grossCents || parsed.reason !== own.reason) return seal(409, { error: 'write_conflict' });
            if (found.void !== undefined) return seal(409, { error: 'invalid_state' });
            const due = amountsFor(subtotalOf(found), found.tax).totalCents;
            const applied = (server.payments.get(invoiceId) ?? []).reduce((n, p) => n + (p.reversal === null ? p.amountCents : 0), 0);
            const credited = server.credits.get(invoiceId) ?? 0;
            if (credited + applied + own.grossCents > due) return seal(409, { error: 'amount_exceeds_remaining' });
            const [note] = server.addCreditNotes(invoiceId, 1, () => ({ grossCents: own.grossCents, taxCents: 0, netCents: own.grossCents, reason: own.reason, issuedAt: server.cnTick(), issuedByName: server.cnNames[uid] ?? null }));
            server.credits.set(invoiceId, credited + own.grossCents);
            own.state = 'issued';
            own.creditNote = { id: note.id, issuedAt: note.issuedAt, withdrawnAt: null };
            return seal(201, { creditNote: { id: note.id, invoiceId, attemptId: own.attemptId, grossCents: own.grossCents, reason: own.reason } });
          }
          if (own === undefined) return refuse(404, 'not_found');
          const want = parsed.expectedVersion === 1 ? 'released' : 'confirmed';
          if (own.state === want) return seal(200, { settlement: { invoiceId, attemptId: own.attemptId, state: want } }); // `unchanged`: the same 200
          if (own.state !== (want === 'released' ? 'open' : 'issued')) return seal(409, { error: 'write_conflict' });
          own.state = want;
          own.settledAt = server.cnTick();
          return seal(200, { settlement: { invoiceId, attemptId: own.attemptId, state: want } });
        };
        if (script === 'lose') { decide(); throw new TypeError('network'); } // committed (or read), but the answer is lost
        if (script === 'commit-404') { decide(); return refuse(404, 'not_found'); }
        return server.maybeHold(CN_KIND[route], url, decide);
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
/** DIS-16 (doc 17 D-P2-4, Appendix A): the ONLY button names inside Payments that may say "credit"; none may say "withdraw" (CN-P3). */
const CREDIT_BUTTON_NAMES: readonly string[] = ['Issue credit note', 'Issue another credit note', 'Confirm credit note'];
/** Every button in `section` named /credit|withdraw/i that is not one of those three exact names. */
const creditNamedOutside = (section: HTMLElement): string[] =>
  within(section).queryAllByRole('button', { name: /credit|withdraw/i }).map((b) => b.textContent ?? '').filter((name) => !CREDIT_BUTTON_NAMES.includes(name));
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
function paymentsOf(i: Issued, all: PaymentWire[], after: string | null, credited = 0) {
  const start = after === null ? 0 : all.findIndex((p) => p.id === after) + 1;
  if (start === 0 && after !== null) return null;
  const voided = i.void !== undefined;
  const due = voided ? 0 : amountsFor(subtotalOf(i), i.tax).totalCents;
  const applied = voided ? 0 : all.reduce((n, p) => n + (p.reversal === null ? p.amountCents : 0), 0);
  const credit = voided ? 0 : credited;
  const remaining = due - credit - applied;
  const page = all.slice(start, start + 50);
  return {
    invoice: { id: i.id, status: voided ? 'voided' : 'issued' },
    amounts: { currency: 'USD', dueCents: due, creditedCents: credit, appliedCents: applied, remainingCents: remaining },
    paymentStatus: voided ? 'voided' : due === 0 ? 'nothing_due'
      : remaining === 0 ? (credit === 0 ? 'recorded_in_full' : applied === 0 ? 'credited_in_full' : 'settled_by_payment_and_credit')
        : applied === 0 ? 'no_payment_recorded' : 'recorded_partly',
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
/** Every fake made since the current test began (a test may make several): the P2-89 checker reads each one's log. */
const madeServers: Server[] = [];
function seeded() {
  const server = fakeServer();
  madeServers.push(server);
  server.stores['uid-a'] = [store(STORE_RO, 'Kiosk', true), store(STORE_1, 'Main Street'), store(STORE_2, null)];
  server.stores['uid-m'] = [store(STORE_1, 'Main Street')];
  server.stores['uid-b'] = [store(uuid(0x61), 'B Store', false, TENANT_B)];
  return server;
}

interface Rig { keys: string[]; clock: { mono: number; wall: number }; reauth: Array<string | null>; holds: VoidHoldStore; payHolds: PaymentHoldStore; revHolds: ReversalHoldStore; cnHolds: CreditNoteHoldStore; props: (over?: Partial<ServerIssuedInvoicesProps>) => ServerIssuedInvoicesProps }
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
  const revHolds = createReversalHoldStore({ now: () => clock.mono, wallNow: () => clock.wall });
  const cnHolds = createCreditNoteHoldStore({ now: () => clock.mono, wallNow: () => clock.wall });
  const identity: ShopIdentity = {
    idToken: async (uid) => tokens[uid] ?? null,
    reauthMethod: () => 'password',
    reauthenticate: async (uid, password) => { reauth.push(password); return password === 'correct horse' ? tokens[uid] ?? null : null; },
  };
  return {
    keys, clock, reauth, holds, payHolds, revHolds, cnHolds,
    props: (over = {}) => ({
      uid: 'uid-a', session, issuing, drafts, identity, now: () => clock.mono, wallNow: () => clock.wall, voidHolds: holds, paymentHolds: payHolds, reversalHolds: revHolds, creditNoteHolds: cnHolds,
      // Doc 18's activity read is opt-in here: the older describes' request logs and scripted session answers stay as written.
      creditActivity: false,
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
/**
 * Fix list 5, C (doc 17 §5 P2-89, layer C, request log): every FIRST settlement send follows a lookup read, under the same
 * session token, that listed that attempt in the state its version acts on (open for Release, issued for Confirm) — except
 * a Confirm after that attempt's own issue 201 under the same token; every settlement replay (same key) resends the first
 * send's exact bytes. Bytes are compared as booleans, never printed. Returns the first sends it checked.
 */
function checkP289(server: Server): number {
  const log = server.sent;
  const token = (r: Sent) => r.headers.get('x-tmpos-session-csrf');
  const epochOf = (r: Sent) => server.cnMeta.get(r)?.epoch ?? -1;
  // Answered (delivered to the page) before the request at index `i` was sent.
  const deliveredBefore = (q: Sent, i: number) => { const at = server.cnMeta.get(q)?.answeredAt; return at !== null && at !== undefined && at <= i; };
  const isSettle = (r: Sent) => r.method === 'POST' && /\/credit-note-settlement$/.test(r.url);
  const attemptOf = (r: Sent): string | undefined => { try { return (JSON.parse(r.body ?? '{}') as { attemptId?: string }).attemptId; } catch { return undefined; } };
  const first = new Map<string, Sent>();
  let checked = 0;
  log.forEach((r, i) => {
    if (!isSettle(r)) return;
    const key = r.headers.get('idempotency-key') ?? '';
    const was = first.get(key);
    if (was !== undefined) { expect(was.body === r.body, `P2-89: settlement ${i} replays its key with the held bytes`).toBe(true); return; }
    first.set(key, r);
    checked += 1;
    const { attemptId, expectedVersion } = JSON.parse(r.body ?? '{}') as { attemptId?: string; expectedVersion?: number };
    const invoiceId = /\/invoices\/([^/]+)\/credit-note-settlement$/.exec(r.url)?.[1];
    // Evidence: same token AND same mount (generation), its answer delivered before this send.
    const before = log.slice(0, i).filter((q) => token(q) === token(r) && epochOf(q) === epochOf(r) && deliveredBefore(q, i));
    const own201 = expectedVersion === 2 && before.some((q) => q.method === 'POST' && /\/credit-notes$/.test(q.url)
      && attemptOf(q) === attemptId && server.cnAnswers.get(q)?.status === 201);
    if (own201) return;
    const want = expectedVersion === 2 ? 'issued' : 'open';
    type Page = { readonly q: Sent; readonly rows: Array<{ attemptId: string; invoiceId: string; state: string }>; readonly next: string | null };
    const pages: Page[] = before.flatMap((q) => {
      const a = server.cnAnswers.get(q);
      if (q.method !== 'GET' || !q.url.includes('/credit-note-attempts') || a?.status !== 200) return [];
      const body = JSON.parse(a.text) as { attempts?: Page['rows']; nextCursor?: string | null };
      return [{ q, rows: body.attempts ?? [], next: body.nextCursor ?? null }];
    }); // in SEND order (fix list 7, CX6-01): reads are latest-request sequenced, so a late answer of an earlier read never decides
    const lists = (p: Page) => p.rows.find((x) => x.attemptId === attemptId && x.invoiceId === invoiceId);
    const last = [...pages].reverse().find(lists);
    expect(last !== undefined, `P2-89: first settlement ${i} (version ${expectedVersion}) follows a lookup that listed its attempt, same token and mount`).toBe(true);
    if (last === undefined) return;
    expect(lists(last)?.state, `P2-89: the last lookup before settlement ${i} lists its attempt ${want}`).toBe(want);
    // A complete scan (page one to nextCursor null) answered after that page and before the send that omits the attempt.
    const after = pages.slice(pages.indexOf(last) + 1);
    let scan: Page[] | null = null;
    for (const p of after) {
      if (!p.q.url.includes('?')) scan = [];
      if (scan === null) continue;
      scan.push(p);
      if (p.next === null) {
        expect(scan.some(lists), `P2-89: a complete lookup after the backing one omits settlement ${i}'s attempt`).toBe(true);
        scan = null;
      }
    }
  });
  return checked;
}
/** How far the P2-89 checker reached: tests with a settlement first send, and those sends. */
const p289 = { tests: 0, sends: 0 };
function afterEachP289(): void {
  const sends = madeServers.reduce((n, x) => n + checkP289(x), 0);
  if (sends > 0) { p289.tests += 1; p289.sends += sends; }
  madeServers.length = 0;
}

/** What the fake recorded from index `from` on, as "METHOD url". */
const sentFrom = (server: Server, from: number): string[] => server.sent.slice(from).map((s) => `${s.method} ${s.url}`);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  madeServers.length = 0;
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
    // The held void (VOID-P2), payment (P2B) and reversal (P2C) attempts too, and (CN-P2, P2-49) the held credit-note attempt.
    for (const file of ['ServerIssuedInvoices.tsx', 'invoiceIssuingClient.ts', 'invoiceVoidHold.ts', 'invoicePaymentHold.ts', 'invoiceReversalHold.ts', 'invoiceCreditNoteHold.ts']) {
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
      ...(['already-void', 'version-conflict', 'payments-recorded', 'credit-notes-recorded', 'tenant-conflict', 'not-found', 'key-reused', 'invalid'] as const)
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
      [{ kind: 'credit-notes-recorded' }, refusedAs('credit-notes-recorded')], // M7B-CREDITNOTES-P1: the key's sealed credit_notes_recorded
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
        // and the payment eligibility GET — and (M7B-PAYMENTS-P2C R1) the open's ONE reversal eligibility GET after it.
        // CN-P2 (doc 17 §4.1): the open's credit-note list GET shares that check too; the lookup is not asked again here (its
        // 403 was confirmed earlier in this generation and token, §2.2).
        expect(sentFrom(server, at + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${TENANT_SESSION_PATHS.current}`,
          `GET ${STORES_PATH}/${STORE_1}/invoices/${made[2].id}/payments`, `GET ${STORES_PATH}/${STORE_1}/invoices/${made[2].id}/credit-notes`,
          `GET ${STORES_PATH}/${STORE_1}/invoices/${made[2].id}/payment-eligibility`, `GET ${STORES_PATH}/${STORE_1}/invoices/${made[2].id}/payment-reversal-eligibility`]);
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
    { name: 'a sealed 409 credit_notes_recorded (M7B-CREDITNOTES-P1, CN-27a)', answer: () => sealed(409, 'credit_notes_recorded'), refusal: 'credit-notes-recorded' as const, reread: false },
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
  it('SII-152b. doc 16 CN-27a: the credit_notes_recorded refusal SII-90 shows is one fixed sentence, in the payments_recorded sentence\'s style, with no control to withdraw or issue anything', () => {
    expect(VOID_REFUSED_TEXT['credit-notes-recorded']).toBe("This invoice has credit notes, so it can't be voided. If a credit note was issued by mistake, withdraw it first.");
    for (const text of Object.values(VOID_REFUSED_TEXT)) expect(text).not.toMatch(/\b(paid|unpaid|refunded)\b/i);
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
    // CN-P2 (doc 17 §3.6 rule 3): the kept dialog's credit-note list and lookup are read again from page one under the new token.
    expect(apart(server, mark).sort()).toEqual([`GET ${detailUrl(STORE_1, made[1].id)}`, `GET ${eligUrl(STORE_1, made[1].id)}`,
      `GET ${detailUrl(STORE_1, made[1].id)}/credit-notes`, `GET ${STORES_PATH}/${STORE_1}/credit-note-attempts`].sort());
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
    for (const file of ['ServerIssuedInvoices.tsx', 'invoiceVoidHold.ts', 'invoicePaymentHold.ts', 'invoiceReversalHold.ts', 'invoiceCreditNoteHold.ts']) { // CN-P2, P2-49: the credit-note hold too
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
    const h = await stubbed(send, async () => ({ kind: 'renewed', gen: 1 }));
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
    const h = await stubbed(async () => ({ kind: 'step-up', method: 'password' }), async () => ({ kind: 'renewed', gen: 1 }));
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
    h = await stubbed(send, async () => { h.ctl.generation = 2; return { kind: 'renewed', gen: 2 }; }); // the renewal's new generation
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
  // CN-P2 (doc 17 §3.6 rule 3): with the invoice and its eligibility, the kept dialog's credit-note list and lookup from page one.
  const renewalReads = (made: Issued[]) => [`GET ${detailUrl(STORE_1, made[1].id)}`, `GET ${eligUrl(STORE_1, made[1].id)}`,
    `GET ${detailUrl(STORE_1, made[1].id)}/credit-notes`, `GET ${STORES_PATH}/${STORE_1}/credit-note-attempts`].sort();

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
  // A voided invoice's read shows the word alone (CN-37): its four amount rows are absent, which is null here.
  const summary = () => ['issued-payments-status', 'issued-payments-due', 'issued-payments-credited', 'issued-payments-recorded', 'issued-payments-remaining'].map((id) => screen.queryByTestId(id)?.textContent ?? null);
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

  it('SII-153. each of the five words a payment-only invoice shows has its shop label, beside the note "Payments are recorded by staff; the product does not verify them." and the server\'s total, credited, recorded and remaining amounts — in a "Payments" region after the invoice; never "Paid" or "Unpaid"', async () => {
    const { server, made } = await setup((n) => (n === 1 ? { lines: [line(1, 'Free check', 1, 0)], tax: { mode: 'none' } } : n === 5 ? { void: { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' } } : {}), 5);
    server.payments.set(made[2].id, [pay(1), pay(2, { amountCents: 500, reversal: reversed('wrong_amount') })]);
    server.payments.set(made[3].id, [pay(3, { amountCents: 2176, method: 'external_card_terminal' })]);
    server.payments.set(made[4].id, [pay(4, { amountCents: 2176, reversal: reversed('wrong_invoice') })]);
    const expected: Record<number, string[]> = {
      1: ['Nothing due', '$0.00', '$0.00', '$0.00', '$0.00'],
      2: ['No payment recorded', '$21.76', '$0.00', '$0.00', '$21.76'],
      3: ['Payment recorded in part', '$21.76', '$0.00', '$1.00', '$20.76'],
      4: ['Payment recorded in full', '$21.76', '$0.00', '$21.76', '$0.00'],
      5: ['Voided', null, null, null, null],
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
      // CN-31 / CN-37: "Invoice total" and "Credited", never "Amount due"; a voided invoice shows its word alone.
      expect([...section.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(n === 5 ? ['Payment status'] : ['Payment status', 'Invoice total', 'Credited', 'Recorded', 'Remaining']);
      expect(section.textContent).not.toMatch(/amount due/i);
      // A long amount wraps only when it cannot fit (320 px at 24 px text); never cut at the panel's edge.
      if (n !== 5) for (const id of ['issued-payments-due', 'issued-payments-credited', 'issued-payments-recorded', 'issued-payments-remaining']) expect(tid(id)).toHaveClass('[overflow-wrap:anywhere]');
      expect(section.textContent).not.toMatch(/\b(un)?paid\b/i);
      expect(tid('issued-payments-state')).toHaveTextContent(n === 2 || n === 1 ? PAYMENTS_TEXT.empty : '');
      await close();
    }
    expect(server.writes()).toEqual([]);
  });

  it('SII-153b. CN-31: after a credit the summary says "Invoice total" and "Credited" with the server\'s remaining, never the Total as an amount due; the two new words have their labels; no text says Paid, Unpaid, Refunded or "Amount due"; and CN-P1 adds no credit control', async () => {
    const { server, made } = await setup(() => ({}), 4);
    server.credits.set(made[0].id, 500); // partly credited, nothing recorded: keeps its word, the amounts show the credit
    server.credits.set(made[1].id, 2176); // credited in full
    server.credits.set(made[2].id, 2076); // 20.76 credited and 1.00 recorded: settled by both
    server.payments.set(made[2].id, [pay(1)]);
    server.credits.set(made[3].id, 1000); // credited in part and a payment: payment recorded in part
    server.payments.set(made[3].id, [pay(2, { amountCents: 200 })]);
    const expected: Record<number, Array<string | null>> = {
      1: ['No payment recorded', '$21.76', '$5.00', '$0.00', '$16.76'],
      2: ['Credited in full', '$21.76', '$21.76', '$0.00', '$0.00'],
      3: ['Settled by payment and credit', '$21.76', '$20.76', '$1.00', '$0.00'],
      4: ['Payment recorded in part', '$21.76', '$10.00', '$2.00', '$9.76'],
    };
    for (const n of [1, 2, 3, 4]) {
      await open(n);
      await paymentsReady();
      expect(summary(), `invoice ${n}`).toEqual(expected[n]);
      const section = tid('issued-payments');
      expect([...section.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Payment status', 'Invoice total', 'Credited', 'Recorded', 'Remaining']);
      expect(section.textContent).not.toMatch(/amount due|\b(un)?paid\b|refund/i);
      expect(creditNamedOutside(section)).toEqual([]); // DIS-16 (doc 17 Appendix A): only the three approved credit-note names; never "withdraw"
      await close();
    }
    expect(server.writes()).toEqual([]);
  });

  it('SII-153c. CN-37: a voided invoice shows "Payment status: Voided" and no amounts rows (no "Invoice total $0.00" under the snapshot Total); the snapshot Total stays as it was issued', async () => {
    const { made } = await setup((n) => (n === 2 ? { void: { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' } } : {}), 2);
    await open(2);
    await paymentsReady();
    const section = tid('issued-payments');
    expect([...section.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Payment status']);
    expect(tid('issued-payments-status')).toHaveTextContent('Voided');
    for (const id of ['issued-payments-due', 'issued-payments-credited', 'issued-payments-recorded', 'issued-payments-remaining']) expect(screen.queryByTestId(id)).toBeNull();
    expect(section.textContent).not.toMatch(/invoice total|credited|\$0\.00/i);
    expect(tid('issued-view-total')).toHaveTextContent('Total $21.76'); // the snapshot Total, unchanged
    expect(made[1].void).toBeDefined();
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
    expect(summary()).toEqual(['Payment recorded in part', '$21.76', '$0.00', '$1.75', '$20.01']);
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
      // M7B-PAYMENTS-P2C R1: and its ONE reversal eligibility (5 issued, 3 voided).
      const recordElig = n === 3 ? [`GET ${paymentsUrl(made[n - 1].id).replace('/payments', '/payment-eligibility')}`, `GET ${paymentsUrl(made[n - 1].id).replace('/payments', '/payment-reversal-eligibility')}`] : [];
      // CN-P2: each open's ONE credit-note list GET (a voided invoice's too, D-P2-12) and the first open's ONE attempts lookup
      // GET — its 403, confirmed by the one fresh check, is not asked again under this generation and token (doc 17 §2.2).
      const credit = [`GET ${paymentsUrl(made[n - 1].id).replace('/payments', '/credit-notes')}`, ...(n === 3 ? [`GET ${STORES_PATH}/${STORE_1}/credit-note-attempts`] : [])];
      expect(sent.sort(), `invoice ${n}`).toEqual([`GET ${STORES_PATH}/${STORE_1}/invoices/${made[n - 1].id}`, `GET ${paymentsUrl(made[n - 1].id)}`, `GET ${paymentsUrl(made[n - 1].id).replace('/payments', '/void-eligibility')}`, ...recordElig, ...credit].sort());
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
    const page = { invoice: { id: made[0].id, status: 'issued' as const }, amounts: { currency: 'USD' as const, dueCents: 2176, creditedCents: 0, appliedCents: 0, remainingCents: 2176 }, paymentStatus: 'no_payment_recorded' as const, payments: [], nextCursor: null };
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
      [json200({ invoice: { id: made[1].id, status: 'issued' }, amounts: { currency: 'USD', dueCents: 2176, appliedCents: 0, remainingCents: 2176 }, paymentStatus: 'no_payment_recorded', payments: [], nextCursor: null }), 'unavailable', PAYMENTS_TEXT.unavailable], // CN-20: the old four-key amounts are refused, never shown
      [json200({ invoice: { id: made[1].id, status: 'issued' }, amounts: { currency: 'USD', dueCents: 2176, creditedCents: 0, appliedCents: 0, remainingCents: 2176 }, paymentStatus: 'unpaid', payments: [], nextCursor: null }), 'unavailable', PAYMENTS_TEXT.unavailable],
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
      expect(summary()).toEqual(['No payment recorded', '$21.76', '$0.00', '$0.00', '$21.76']);
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
    expect(summary()).toEqual(['Payment recorded in part', '$200.00', '$0.00', '$120.00', '$80.00']);
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
    expect(summary()).toEqual(['Payment recorded in part', '$200.00', '$0.00', '$120.00', '$80.00']);
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
    expect(summary()).toEqual(['Payment recorded in part', '$200.00', '$0.00', '$60.00', '$140.00']); // the held answer's
    expect(screen.queryByTestId('issued-payments-load-more')).toBeNull();
    const reads = server.paymentReads().length;
    await settle();
    expect(server.paymentReads()).toHaveLength(reads); // no automatic re-read
    await close();
    // An id again (the same amounts and word): also a change.
    all.pop();
    await open(2);
    await paymentsReady();
    const repeat = { invoice: { id: made[1].id, status: 'issued' }, amounts: { currency: 'USD', dueCents: 20_000, creditedCents: 0, appliedCents: 6000, remainingCents: 14_000 }, paymentStatus: 'recorded_partly', payments: [pay(10)], nextCursor: null };
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
      ['status', pageAfter({ invoice: { id: made[1].id, status: 'voided' }, amounts: { currency: 'USD', dueCents: 0, creditedCents: 0, appliedCents: 0, remainingCents: 0 }, paymentStatus: 'voided', payments: [pay(51, { reversal: reversed('other') })] }), 'changed'],
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
      expect(summary(), name).toEqual(['Payment recorded in part', '$200.00', '$0.00', '$60.00', '$140.00']);
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
    expect(summary()).toEqual(['No payment recorded', '$21.76', '$0.00', '$0.00', '$21.76']);
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
      expect(summary(), gone).toEqual(['Payment recorded in part', '$200.00', '$0.00', '$60.00', '$140.00']);
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
    expect(summary()).toEqual(['No payment recorded', '$21.76', '$0.00', '$0.00', '$21.76']);
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
    await click('issued-view-void');
    await waitFor(() => expect(screen.queryByTestId('issued-void-confirm')).not.toBeNull());
    await user().click(tid('issued-void-reason-wrong_customer'));
    await click('issued-void-send');
    await waitFor(() => expect(tid('issued-view-status')).toHaveTextContent('Voided'));
    await waitFor(() => expect(summary()).toEqual(['Voided', null, null, null, null]));
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
    await waitFor(() => expect(summary()).toEqual(['Voided', null, null, null, null]));
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

  it('SII-269. FIX2 item 3 (R8): while a reversal of one of the invoice\'s payments is unresolved, its lookup rows\' Withdraw holds back (said) and sends nothing; once that attempt is gone it settles as before', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(404);
    await recordWith('4.00');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'ready'));
    const rev = {
      key: 'k-rev', body: '{"x":1}', storeId: STORE_1, storeLabel: 'Store 1', invoiceId: made[2].id, number: 3, paymentId: uuid(0x9009), amountCents: 100,
      reasonCode: 'other', csrf: 'csrf-live', sentAt: performance.now(), sentWall: Date.now(), state: 'unresolved', note: '', refusal: null, attributed: false,
      seen: null, retryable: false,
    } as const;
    await act(async () => { r.revHolds.put('uid-a', rev); });
    await waitFor(() => expect(tid('issued-payments-withdraw')).toHaveAttribute('aria-disabled', 'true'));
    expect(tid('issued-payments-withdraw').getAttribute('aria-describedby')).toContain('issued-payments-rows-reversing');
    expect(document.getElementById('issued-payments-rows-reversing')).toHaveTextContent(REVERSE_TEXT.pending);
    const mark = server.sent.length;
    await click('issued-payments-withdraw');
    await settle();
    expect(apart(server, mark), 'nothing sent').toEqual([]);
    await act(async () => { r.revHolds.remove('uid-a', 'k-rev'); });
    await waitFor(() => expect(tid('issued-payments-withdraw')).toHaveAttribute('aria-disabled', 'false'));
    await click('issued-payments-withdraw');
    await waitFor(() => expect(flow()).toBe('Attempt withdrawn. No payment was recorded.'));
  });

  /** A live reversal of one of invoice 3's payments (P2C R8), put straight into the hold store. */
  const liveRev = (made: Issued[]) => ({
    key: 'k-rev', body: '{"x":1}', storeId: STORE_1, storeLabel: 'Store 1', invoiceId: made[2].id, number: 3, paymentId: uuid(0x9009), amountCents: 100,
    reasonCode: 'other', csrf: 'csrf-live', sentAt: performance.now(), sentWall: Date.now(), state: 'unresolved', note: '', refusal: null, attributed: false,
    seen: null, retryable: false,
  } as const);

  it('SII-276. FIX3 E5: a lookup row\'s Withdraw pressed BEFORE a reversal on its invoice went live, its session check out meanwhile, is refused after that check — no settlement is sent', async () => {
    const { server, made, r } = await setup();
    await openRecordable(3);
    server.payScripts.record.push(404);
    await recordWith('4.00');
    await waitFor(() => expect(tid('issued-payments-attempts')).toHaveAttribute('data-phase', 'ready'));
    expect(tid('issued-payments-withdraw')).toHaveAttribute('aria-disabled', 'false');
    const mark = server.sent.length;
    server.hold.current = 1;
    await click('issued-payments-withdraw');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
    await act(async () => { r.revHolds.put('uid-a', liveRev(made)); });
    await act(async () => { server.held.shift()!.release(); });
    await settle();
    expect(apart(server, mark), 'no settlement sent').toEqual([]);
    expect(posts(server, 'payment-settlement')).toHaveLength(0);
  });

  it.each(['pressed while the reversal is live', 'pressed before it went live (its session check out)'] as const)('SII-277. FIX3 E5: a listed recorded attempt\'s Confirm on an invoice with a live reversal, %s, sends nothing (aria-disabled, said)', async (arm) => {
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
    expect(screen.getByTestId('issued-payments-attempt')).toHaveAttribute('data-attempt-state', 'recorded');
    const mark = server.sent.length;
    if (arm === 'pressed while the reversal is live') {
      await act(async () => { r.revHolds.put('uid-a', liveRev(made)); });
      await waitFor(() => expect(tid('issued-payments-attempt-confirm')).toHaveAttribute('aria-disabled', 'true'));
      expect(tid('issued-payments-attempt-confirm').getAttribute('aria-describedby')).toContain('issued-payments-rows-reversing');
      expect(document.getElementById('issued-payments-rows-reversing')).toHaveTextContent(REVERSE_TEXT.pending);
      await click('issued-payments-attempt-confirm');
    } else {
      server.hold.current = 1;
      await click('issued-payments-attempt-confirm');
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
      await act(async () => { r.revHolds.put('uid-a', liveRev(made)); });
      await act(async () => { server.held.shift()!.release(); });
    }
    await settle();
    expect(apart(server, mark), 'nothing sent').toEqual([]);
    expect(server.regs.map((g) => g.state)).not.toContain('confirmed');
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

  it('SII-230. QA: the FULL remaining balance recorded, then a page reload before Confirm (the attempt held only in memory is gone; the server holds it recorded; nothing remaining, so no Record): "Find an unfinished payment attempt" reads the attempts only when pressed, its recorded row\'s Confirm settles THAT attempt (v2) — "Payment confirmed.", still ONE payment and nothing registered, proved or recorded again; reopened or reloaded once more nothing is pending; a fully paid invoice says "No unfinished…" only when asked; view-only staff see the history without the control', async () => {
    const { server, made, r, view } = await setup();
    await openRecordable(3);
    expect(screen.queryByTestId('issued-payments-find-any'), 'something remaining: Record covers it').toBeNull();
    const full = tid('issued-payments-remaining').textContent ?? '';
    await recordWith(full.slice(1));
    await waitFor(() => expect(flow()).toBe(`Payment recorded: ${full}, Cash. Confirm it to finish. Until you confirm, you can't record another payment.`));
    await paymentsReady();
    expect(tid('issued-payments-remaining')).toHaveTextContent('$0.00');
    expect(screen.queryByTestId('issued-payments-confirm')).not.toBeNull();
    expect(screen.queryByTestId('issued-payments-find-any'), 'held in this page: its Confirm covers it').toBeNull();
    const attemptId = r.keys[0];
    const chain = () => ['payment-registrations', 'payment-registration-proof', 'payments'].map((route) => server.payRequests(route as 'payments').length).join(',');
    const before = chain();
    const lookups = () => server.payRequests('payment-attempts').length;
    // A full page reload before Confirm: the attempt held in this page's memory goes with it.
    let shown = view;
    const reload = async () => {
      shown.unmount();
      shown = render(<ServerIssuedInvoices {...r.props({ paymentHolds: createPaymentHoldStore({ now: () => r.clock.mono, wallNow: () => r.clock.wall }) })} />);
      await showAndChoose(STORE_1);
      await listReady();
    };
    const nothingPending = () => {
      expect(screen.queryByTestId('issued-payments-confirm')).toBeNull();
      expect(screen.queryByTestId('issued-payments-record'), 'nothing remaining: no Record').toBeNull();
      expect(screen.queryAllByTestId('issued-payments-attempt').length, 'no rows').toBe(0);
      expect(flow(), 'no pending line').toBe('');
      expect(tid('issued-payments-attempts').textContent, 'no lookup line').toBe('');
    };
    await reload();
    await open(3);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-find-any')).not.toBeNull());
    expect(screen.getAllByTestId('issued-payments-item').length, 'the one payment in the history').toBe(1);
    expect(tid('issued-payments-remaining')).toHaveTextContent('$0.00');
    nothingPending();
    expect(tid('issued-payments-find-any')).toHaveTextContent('Find an unfinished payment attempt');
    expect(tid('issued-payments-find-any')).toHaveAttribute('aria-disabled', 'false');
    await settle();
    expect(lookups(), 'no lookup on open: only on a press').toBe(0);
    await click('issued-payments-find-any');
    await lookupReady();
    expect(lookups()).toBe(1);
    const row = screen.getByTestId('issued-payments-attempt');
    expect(row).toHaveAttribute('data-attempt-state', 'recorded');
    expect(row).toHaveTextContent(`${full}, Cash recorded`);
    const reads = server.paymentReads().length;
    await click('issued-payments-attempt-confirm');
    await waitFor(() => expect(flow()).toBe('Payment confirmed.'));
    // In the same open: the settled row and its Confirm are gone at once — no stale confirmation action (owner AC 3).
    expect(screen.queryAllByTestId('issued-payments-attempt'), 'the settled row is gone').toHaveLength(0);
    expect(screen.queryByTestId('issued-payments-attempt-confirm'), 'no row Confirm left').toBeNull();
    expect(screen.queryByTestId('issued-payments-confirm'), 'no top Confirm').toBeNull();
    const settles = posts(server, 'payment-settlement');
    expect(settles.length, 'ONE settlement').toBe(1);
    same(settles[0].body, `{"expectedTenant":"${TENANT_A}","attemptId":"${attemptId}","expectedVersion":2}`, 'settle v2 of the ORIGINAL attempt');
    expect(server.regs.map((g) => g.state)).toEqual(['confirmed']);
    await waitFor(() => expect(server.paymentReads()).toHaveLength(reads + 1));
    await paymentsReady();
    expect(screen.getAllByTestId('issued-payments-item').length, 'still one history row').toBe(1);
    expect(tid('issued-payments-remaining')).toHaveTextContent('$0.00');
    expect((server.payments.get(made[2].id) ?? []).length, 'ONE payment').toBe(1);
    expect(chain(), 'nothing registered, proved or recorded after the reload').toBe(before);
    // Closed and reopened, then reloaded again: nothing pending, nothing read until asked.
    await close();
    await open(3);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-find-any')).not.toBeNull());
    nothingPending();
    await reload();
    await open(3);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-find-any')).not.toBeNull());
    nothingPending();
    await settle();
    expect(lookups(), 'still no lookup on open').toBe(1);
    await click('issued-payments-find-any'); // fully paid, nothing unfinished: said only when asked
    await lookupReady();
    expect(tid('issued-payments-attempts')).toHaveTextContent('No unfinished payment attempts were found on this invoice.');
    expect(screen.queryAllByTestId('issued-payments-attempt').length).toBe(0);
    // View-only staff (eligibility 403): the history, never the control.
    server.recorders.delete('uid-a');
    const eligibility = server.payRequests('payment-eligibility').length;
    await reload();
    await open(3);
    await waitFor(() => expect(server.payRequests('payment-eligibility').length).toBe(eligibility + 1));
    await settle();
    expect(screen.getAllByTestId('issued-payments-item').length).toBe(1);
    expect(screen.queryByTestId('issued-payments-find-any'), 'view-only: no control').toBeNull();
    expect(screen.queryByTestId('issued-payments-record')).toBeNull();
    expect(chain(), 'never a register, proof or record after the reload').toBe(before);
    expect(posts(server, 'payment-settlement').length).toBe(1);
  });
});

describe('Issued invoices — reversing a payment: smoke (M7B-PAYMENTS-P2C)', () => {
  const T = (n: number) => `2026-10-17T09:00:${String(n % 60).padStart(2, '0')}.000001Z`;
  const pay = (n: number, over: Partial<PaymentWire> = {}): PaymentWire => ({ id: uuid(0x9000 + n), attemptId: uuid(0xa000 + n), amountCents: 100, method: 'cash', recordedAt: T(n), reversal: null, ...over });
  const paymentsUrl = (invoiceId: string) => `${STORES_PATH}/${STORE_1}/invoices/${invoiceId}/payments`;
  const payPhase = () => screen.queryByTestId('issued-payments-state')?.getAttribute('data-phase') ?? 'none';
  const paymentsReady = () => waitFor(() => expect(payPhase()).toBe('ready'));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /** The fake's reversal routes, in front of the shared fake: the eligibility answers `allowed.value`; a POST reverses the payment. */
  async function setup(over: (n: number) => Partial<Issued> = () => ({})) {
    const server = seeded();
    const made = issueAt(server, STORE_1, 3, over);
    const r = rig(server);
    const allowed = { value: true };
    const eligReads: string[] = [];
    const posts: Array<{ url: string; body: string; key: string | null }> = [];
    const routed = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if ((init.method ?? 'GET') === 'GET' && url.endsWith('/payment-reversal-eligibility')) {
        eligReads.push(url);
        return allowed.value ? reply(200, { eligibility: 'allowed' }) : reply(403, { error: 'forbidden', requestId: 'r' });
      }
      const target = /\/invoices\/([0-9a-f-]{36})\/payments\/([0-9a-f-]{36})\/reversal$/.exec(url);
      if (init.method === 'POST' && target !== null) {
        posts.push({ url, body: String(init.body), key: new Headers(init.headers).get('idempotency-key') });
        const [, invoiceId, paymentId] = target;
        const reasonCode = (JSON.parse(String(init.body)) as { reasonCode: string }).reasonCode;
        server.payments.set(invoiceId, (server.payments.get(invoiceId) ?? []).map((p) => (p.id === paymentId ? { ...p, reversal: { reversedAt: '2026-10-18T10:00:00.000001Z', reasonCode } } : p)));
        return reply(200, { payment: { id: paymentId, invoiceId, status: 'reversed' } });
      }
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    render(<ServerIssuedInvoices {...r.props({ issuing: createInvoiceIssuingClient({ fetch: routed }) })} />);
    await showAndChoose(STORE_1);
    await listReady();
    return { server, made, r, allowed, eligReads, posts };
  }
  async function open(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
    await paymentsReady();
  }
  async function close() {
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
  }
  async function review() {
    await waitFor(() => expect(tid('issued-payments-reverse')).toBeInTheDocument());
    await user().click(tid('issued-payments-reverse'));
    await waitFor(() => expect(tid('issued-reverse-confirm')).toBeInTheDocument());
  }

  it('SII-231. P2C R1: "Reverse payment" shows in an unreversed history row only once the reversal eligibility read answered exactly allowed — never on a reversed row; none when that read is refused (403); a voided invoice sends no reversal eligibility read and shows none', async () => {
    const voidedAt = '2026-10-18T11:00:00.000001Z';
    const { server, made, allowed, eligReads } = await setup((n) => (n === 1 ? { void: { voidedAt, reasonCode: 'other' } } : {}));
    server.payments.set(made[1].id, [pay(1), pay(2, { amountCents: 50, reversal: { reversedAt: '2026-10-18T10:00:00.000001Z', reasonCode: 'wrong_amount' } })]);
    await open(2);
    await waitFor(() => expect(screen.getAllByTestId('issued-payments-reverse')).toHaveLength(1));
    expect(tid('issued-payments-reverse')).toHaveAttribute('data-id', uuid(0x9001));
    expect(tid('issued-payments-reverse').closest('[data-testid="issued-payments-item"]')).toHaveAttribute('data-id', uuid(0x9001));
    expect(tid('issued-payments-reverse')).toHaveTextContent(/^Reverse payment$/);
    expect(eligReads.filter((u) => u.includes(made[1].id))).toHaveLength(1);
    await close();
    allowed.value = false;
    await open(2);
    await waitFor(() => expect(eligReads.filter((u) => u.includes(made[1].id))).toHaveLength(2));
    await settle();
    expect(screen.queryByTestId('issued-payments-reverse')).toBeNull();
    await close();
    allowed.value = true;
    await open(1);
    await settle();
    expect(eligReads.filter((u) => u.includes(made[0].id))).toEqual([]);
    expect(screen.queryByTestId('issued-payments-reverse')).toBeNull();
  });

  it('SII-232. P2C R2-R4/R6 happy path: the review re-reads the invoice, the eligibility and the history before the confirmation opens on that payment (Keep payment first); an empty press says "Choose a reason first." and sends nothing; with a reason ONE press is ONE POST under ONE key with exactly {expectedTenant, reasonCode}; then "Payment reversed." and the history read again shows the row Reversed, its control gone', async () => {
    const { server, made, posts, eligReads, r } = await setup();
    server.payments.set(made[1].id, [pay(1, { amountCents: 150 })]);
    await open(2);
    const reads = server.paymentReads().length;
    await review();
    expect(server.paymentReads().length, 'the review read the history again').toBeGreaterThan(reads);
    expect(eligReads.filter((u) => u.includes(made[1].id)), 'and the eligibility').toHaveLength(2);
    expect(tid('issued-reverse-confirm')).toHaveAttribute('role', 'alertdialog');
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-reverse-keep')));
    expect(tid('issued-reverse-keep')).toHaveTextContent('Keep payment');
    expect(tid('issued-reverse-amount')).toHaveTextContent('$1.50');
    expect(tid('issued-reverse-consequence')).toHaveTextContent('Reversing records that this payment was entered in error. It does not return any money.');
    expect(tid('issued-reverse-reasons').querySelectorAll('input[type="radio"]')).toHaveLength(6);
    expect(tid('issued-reverse-confirm').textContent).not.toMatch(/refund/i);
    await user().click(tid('issued-reverse-send'));
    expect(tid('issued-reverse-reason-error')).toHaveTextContent('Choose a reason first.');
    expect(document.activeElement).toBe(tid('issued-reverse-reason-recorded_in_error'));
    expect(posts).toHaveLength(0);
    await user().click(tid('issued-reverse-reason-wrong_amount'));
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${paymentsUrl(made[1].id)}/${uuid(0x9001)}/reversal`);
    expect(JSON.parse(posts[0].body)).toEqual({ expectedTenant: TENANT_A, reasonCode: 'wrong_amount' });
    expect(posts[0].key).toBe(r.keys[0]);
    await waitFor(() => expect(tid('issued-reverse-status')).toHaveTextContent('Payment reversed.'));
    await waitFor(() => expect(tid('issued-payments-reversed')).toHaveTextContent('Reversed'));
    expect(screen.queryByTestId('issued-payments-reverse')).toBeNull();
    expect(r.revHolds.get('uid-a')?.state).toBe('reversed');
    expect(posts).toHaveLength(1);
  });

  it('SII-233. P2C R3: Keep payment closes the confirmation and sends nothing — focus back on the row\'s "Reverse payment"', async () => {
    const { server, made, posts, r } = await setup();
    server.payments.set(made[1].id, [pay(1)]);
    await open(2);
    await review();
    await user().click(tid('issued-reverse-reason-duplicate'));
    await user().click(tid('issued-reverse-keep'));
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    await settle();
    expect(posts).toEqual([]);
    expect(r.keys).toEqual([]);
    expect(r.revHolds.get('uid-a')).toBeUndefined();
    expect(document.activeElement).toBe(tid('issued-payments-reverse'));
  });
});

describe('Issued invoices — reversing a payment: boundaries, review, outcomes, recovery and coordination (M7B-PAYMENTS-P2C)', () => {
  const T = (n: number) => `2026-10-17T09:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000001Z`;
  const pay = (n: number, over: Partial<PaymentWire> = {}): PaymentWire => ({ id: uuid(0x9000 + n), attemptId: uuid(0xa000 + n), amountCents: 100, method: 'cash', recordedAt: T(n), reversal: null, ...over });
  const P = (n: number) => uuid(0x9000 + n);
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const sealed = (status: number, error: string) => reply(status, { error });
  const REVERSED_AT = '2026-10-18T10:00:00.000001Z';
  type RevScript = Response | 'network' | 'lose' | 'apply';
  type Gate = 'elig' | 'post';
  /**
   * The fake's reversal routes in front of the shared fake. Eligibility: the next `eligScripts` answer, else 200 allowed while
   * `allowed.value`, else a chain 403. POST: the next `revScripts` answer ('apply' or none: the payment is reversed and a 200
   * names it; 'lose': reversed, the answer lost; 'network': nothing reaches it). `gate` holds the next N of a kind until released.
   */
  async function setup(opts: { over?: (n: number) => Partial<Issued>; recorder?: boolean; identity?: (r: Rig) => ShopIdentity } = {}) {
    const server = seeded();
    if (opts.recorder === true) server.recorders.add('uid-a');
    const made = issueAt(server, STORE_1, 3, opts.over);
    const made2 = issueAt(server, STORE_2, 1);
    const r = rig(server);
    const allowed = { value: true };
    const eligScripts: Array<Response | 'network'> = [];
    const revScripts: RevScript[] = [];
    const eligReads: string[] = [];
    const posts: Array<{ url: string; body: string; key: string | null }> = [];
    const log: string[] = [];
    const gate: Record<Gate, number> = { elig: 0, post: 0 };
    const held: Array<{ kind: Gate; url: string; release: (late?: Response) => void }> = [];
    const hold = async (kind: Gate, url: string, answer: () => Response): Promise<Response> => {
      if (gate[kind] > 0) {
        gate[kind] -= 1;
        const late = await new Promise<Response | undefined>((release) => { held.push({ kind, url, release }); });
        if (late !== undefined) return late;
      }
      return answer();
    };
    const apply = (invoiceId: string, paymentId: string, body: string) => {
      const reasonCode = (JSON.parse(body) as { reasonCode: string }).reasonCode;
      server.payments.set(invoiceId, (server.payments.get(invoiceId) ?? []).map((p) => (p.id === paymentId ? { ...p, reversal: { reversedAt: REVERSED_AT, reasonCode } } : p)));
    };
    const routed = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      log.push(`${method} ${url}`);
      if (method === 'GET' && url.endsWith('/payment-reversal-eligibility')) {
        eligReads.push(url);
        const script = eligScripts.shift();
        if (script === 'network') throw new TypeError('network');
        return hold('elig', url, () => script ?? (allowed.value ? reply(200, { eligibility: 'allowed' }) : chain(403, 'forbidden')));
      }
      const target = /\/invoices\/([0-9a-f-]{36})\/payments\/([0-9a-f-]{36})\/reversal$/.exec(url);
      if (method === 'POST' && target !== null) {
        const body = String(init.body);
        posts.push({ url, body, key: new Headers(init.headers).get('idempotency-key') });
        const [, invoiceId, paymentId] = target;
        const script = revScripts.shift() ?? 'apply';
        if (script === 'network') throw new TypeError('network');
        return hold('post', url, () => {
          if (script instanceof Response) return script;
          apply(invoiceId, paymentId, body);
          if (script === 'lose') throw new TypeError('network'); // committed, the answer lost
          return reply(200, { payment: { id: paymentId, invoiceId, status: 'reversed' } });
        });
      }
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    const props = r.props({ issuing: createInvoiceIssuingClient({ fetch: routed }), ...(opts.identity === undefined ? {} : { identity: opts.identity(r) }) });
    const page = render(<ServerIssuedInvoices {...props} />);
    await showAndChoose(STORE_1);
    await listReady();
    return { server, made, made2, r, props, page, allowed, eligScripts, revScripts, eligReads, posts, log, gate, held, routed };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
  const payPhase = () => screen.queryByTestId('issued-payments-state')?.getAttribute('data-phase') ?? 'none';
  const paymentsReady = () => waitFor(() => expect(payPhase()).toBe('ready'));
  const reverseIds = () => screen.queryAllByTestId('issued-payments-reverse').map((b) => b.getAttribute('data-id'));
  const cardState = () => screen.queryByTestId('issued-reverse-card')?.getAttribute('data-state') ?? 'none';
  const cardButtons = () => within(tid('issued-reverse-card')).queryAllByRole('button').map((b) => b.textContent);
  const revStatus = () => tid('issued-reverse-status').textContent;
  const revAlert = () => tid('issued-reverse-alert').textContent;
  const heldRev = (r: Rig) => r.revHolds.get('uid-a');
  async function open(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
    await paymentsReady();
  }
  async function close() {
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
  }
  /** Press the row's Reverse payment for `paymentId` (the trigger must be there). */
  async function pressRow(paymentId: string) {
    await waitFor(() => expect(reverseIds()).toContain(paymentId));
    await user().click(screen.getAllByTestId('issued-payments-reverse').find((b) => b.getAttribute('data-id') === paymentId)!);
  }
  async function review(paymentId: string) {
    await pressRow(paymentId);
    await waitFor(() => expect(tid('issued-reverse-confirm')).toBeInTheDocument());
  }
  /** Review, choose `reason` and press the confirmation's Reverse payment once. */
  async function reverse(paymentId: string, reason = 'wrong_amount') {
    await review(paymentId);
    await user().click(tid(`issued-reverse-reason-${reason}`));
    await user().click(tid('issued-reverse-send'));
  }
  /** Invoice 2 with one unreversed payment, open; its reversal sent once and answered by `script`, ending UNRESOLVED (the card). */
  async function unresolved(s: Setup, script: RevScript = reply(500, { error: 'internal', requestId: 'r' })) {
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    s.revScripts.push(script);
    await reverse(P(1));
    await waitFor(() => expect(cardState()).toBe('unresolved'));
  }

  it.each([['403 forbidden', chain(403, 'forbidden')], ['401 unauthenticated', chain(401, 'unauthenticated')], ['429 rate limited', chain(429, 'rate_limited', { 'retry-after': '3' })], ['400 invalid', chain(400, 'invalid_request')], ['a network failure', 'network']] as const)('SII-234. P2C R1: a reversal eligibility read answered %s shows no "Reverse payment" on any row — only an exact 200 allowed does', async (_label, answer) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1), pay(2)]);
    s.eligScripts.push(answer instanceof Response ? answer.clone() : answer);
    await user().click(openButton(2));
    await waitFor(() => expect(s.eligReads).toHaveLength(1));
    await settle();
    expect(screen.queryByTestId('issued-payments-reverse')).toBeNull();
    expect(s.posts).toEqual([]);
  });

  it.each(['another invoice', 'the same invoice opened again', 'another store'] as const)('SII-235. P2C R1/R8: a reversal eligibility "allowed" that arrives late — after the dialog moved to %s whose own read refused — is ignored: no "Reverse payment" shows', async (arm) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    s.server.payments.set(s.made[2].id, [pay(2)]);
    s.server.payments.set(s.made2[0].id, [pay(3)]);
    s.gate.elig = 1;
    await open(2);
    await waitFor(() => expect(s.held).toHaveLength(1));
    await close();
    s.allowed.value = false;
    if (arm === 'another store') {
      await showAndChoose(STORE_2);
      await listReady();
      await open(1);
    } else {
      await open(arm === 'another invoice' ? 3 : 2);
    }
    await waitFor(() => expect(s.eligReads).toHaveLength(2));
    await settle();
    expect(screen.getAllByTestId('issued-payments-item')).toHaveLength(1);
    expect(screen.queryByTestId('issued-payments-reverse')).toBeNull();
    await act(async () => { s.held[0].release(reply(200, { eligibility: 'allowed' })); });
    await settle();
    expect(screen.queryByTestId('issued-payments-reverse')).toBeNull();
    expect(s.posts).toEqual([]);
  });

  it.each(['the invoice is now voided', 'the eligibility is now refused'] as const)('SII-236. P2C R2: the review on press finds %s — no confirmation opens, the reason is said, nothing is sent', async (arm) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await waitFor(() => expect(reverseIds()).toEqual([P(1)]));
    if (arm === 'the invoice is now voided') s.server.issued.set(STORE_1, s.made.map((i, n) => (n === 1 ? { ...i, void: { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' } } : i)));
    else s.allowed.value = false;
    const eligs = s.eligReads.length;
    await pressRow(P(1));
    await waitFor(() => expect(revAlert()).toBe(arm === 'the invoice is now voided' ? REVERSE_TEXT.voided : REVERSE_TEXT.notAllowed));
    await settle();
    expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull();
    expect(s.eligReads.length - eligs).toBe(arm === 'the invoice is now voided' ? 0 : 1);
    expect(screen.queryByTestId('issued-payments-reverse')).toBeNull();
    expect(s.posts).toEqual([]);
    expect(s.r.keys).toEqual([]);
    expect(heldRev(s.r)).toBeUndefined();
  });

  /** `count` older 1-cent payments (ids and times before nothing else), then the shown payment 1, moved last. */
  const behind = (count: number): PaymentWire[] => [...Array.from({ length: count }, (_, k) => pay(100 + k, { amountCents: 1 })), pay(1, { recordedAt: T(1500) })];

  it.each([
    ['already reversed', (s: Setup) => s.server.payments.set(s.made[1].id, [pay(1, { reversal: { reversedAt: REVERSED_AT, reasonCode: 'duplicate' } })]), REVERSE_TEXT.alreadyReversed, false, 1],
    ['no longer listed', (s: Setup) => s.server.payments.set(s.made[1].id, [pay(2)]), REVERSE_TEXT.missing, true, 1],
    ['unreadable (500)', (s: Setup) => { s.server.paymentsStatus.push(500); }, REVERSE_TEXT.unconfirmed, true, 1],
    ['past the 20-page lookup cap (page 21)', (s: Setup) => s.server.payments.set(s.made[1].id, behind(1000)), REVERSE_TEXT.unconfirmed, true, 20],
  ] as const)('SII-237. P2C R2/R7: the exact payment is %s on the review\'s read — no confirmation, no key, no POST; the reason is said', async (_label, change, text, alert, pages) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await waitFor(() => expect(reverseIds()).toEqual([P(1)]));
    change(s);
    const reads = s.server.paymentReads().length;
    await pressRow(P(1));
    await waitFor(() => expect(alert ? revAlert() : revStatus()).toBe(text));
    await settle();
    expect(alert ? revStatus() : revAlert()).toBe('');
    expect(s.server.paymentReads().slice(reads, reads + pages), 'the lookup read from page one following the cursor').toHaveLength(pages);
    if (pages === 20) expect(s.server.paymentReads().length - reads, 'never past the cap (the review itself)').toBe(20);
    expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull();
    expect(s.posts).toEqual([]);
    expect(s.r.keys).toEqual([]);
    expect(heldRev(s.r)).toBeUndefined();
  });

  it('SII-238. P2C R7: the exact payment on page 2 of the history is found by following nextCursor — the confirmation opens on THAT read row and ONE POST reverses it', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await waitFor(() => expect(reverseIds()).toEqual([P(1)]));
    s.server.payments.set(s.made[1].id, behind(50));
    const reads = s.server.paymentReads().length;
    await review(P(1));
    const lookup = s.server.paymentReads().slice(reads, reads + 2);
    expect(lookup[0]).not.toContain('after=');
    expect(lookup[1]).toContain(`after=${pay(149).id}`);
    expect(tid('issued-reverse-recorded-at')).toHaveTextContent('09:25:00');
    await user().click(tid('issued-reverse-reason-other'));
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(revStatus()).toBe(REVERSE_TEXT.reversed));
    expect(s.posts.map((p) => p.url)).toEqual([`${STORES_PATH}/${STORE_1}/invoices/${s.made[1].id}/payments/${P(1)}/reversal`]);
  });

  it('SII-239. P2C R3: the confirmation states the exact invoice, store, amount, method and time with "does not return any money" and the six reasons; Escape closes it, sends nothing and returns focus to the row\'s "Reverse payment"', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1, { amountCents: 1234, method: 'external_card_terminal' })]);
    await open(2);
    const rowTime = tid('issued-payments-recorded-at').textContent ?? '';
    await review(P(1));
    expect(tid('issued-reverse-title')).toHaveTextContent(REVERSE_TEXT.title);
    expect(tid('issued-reverse-number')).toHaveTextContent(/\b2\b/);
    expect(tid('issued-reverse-store')).toHaveTextContent('Main Street');
    expect(tid('issued-reverse-amount')).toHaveTextContent('$12.34');
    expect(tid('issued-reverse-method')).toHaveTextContent('Card on a separate terminal');
    expect(tid('issued-reverse-recorded-at')).toHaveTextContent(rowTime);
    expect(tid('issued-reverse-consequence')).toHaveTextContent('It does not return any money.');
    expect(tid('issued-reverse-reasons')).toHaveAttribute('role', 'radiogroup');
    const radios = within(tid('issued-reverse-reasons')).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('data-testid'))).toEqual(Object.keys(INVOICE_PAYMENT_REVERSAL_REASONS).map((c) => `issued-reverse-reason-${c}`));
    expect(radios.map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(Object.values(INVOICE_PAYMENT_REVERSAL_REASONS));
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(within(tid('issued-reverse-confirm')).queryByRole('textbox')).toBeNull(); // no free text
    expect(tid('issued-reverse-send')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-reverse-send')).not.toBeDisabled();
    expect(describedBy('issued-reverse-send')).toBe(REVERSE_TEXT.sendWhyReason);
    expect(tid('issued-reverse-confirm-status')).toHaveAttribute('role', 'status');
    expect(tid('issued-reverse-confirm-alert')).toHaveAttribute('role', 'alert');
    await user().click(tid('issued-reverse-reason-wrong_method'));
    expect(tid('issued-reverse-send')).toHaveAttribute('aria-disabled', 'false');
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    await settle();
    expect(s.posts).toEqual([]);
    expect(s.r.keys).toEqual([]);
    expect(heldRev(s.r)).toBeUndefined();
    expect(document.activeElement).toBe(tid('issued-payments-reverse'));
  });

  it('SII-240. P2C R4: a double press (two clicks in one tick, then a third while it is out) sends exactly ONE POST under ONE key; the button says "Reversing…" meanwhile', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await review(P(1));
    await user().click(tid('issued-reverse-reason-duplicate'));
    s.gate.post = 1;
    act(() => { fireEvent.click(tid('issued-reverse-send')); fireEvent.click(tid('issued-reverse-send')); });
    await waitFor(() => expect(s.held).toHaveLength(1));
    expect(tid('issued-reverse-send')).toHaveTextContent(REVERSE_TEXT.sending);
    fireEvent.click(tid('issued-reverse-send'));
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.r.keys).toHaveLength(1);
    await act(async () => { s.held[0].release(); });
    await waitFor(() => expect(revStatus()).toBe(REVERSE_TEXT.reversed));
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].key).toBe(s.r.keys[0]);
    expect(s.r.keys).toHaveLength(1);
  });

  it('SII-241. P2C R5: a FIRST send answered step-up runs nothing — the key is dropped and the sign-in opens in the confirmation; a successful sign-in re-reads the eligibility, the invoice and the history, CLEARS the reason and sends nothing until a new press, which goes under a NEW key', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    s.revScripts.push(chain(403, 'step_up_required'));
    await reverse(P(1), 'wrong_invoice');
    await waitFor(() => expect(tid('issued-reverse-reauth-group')).toBeInTheDocument());
    expect(tid('issued-reverse-confirm-alert')).toHaveTextContent(REVERSE_TEXT.stepUp);
    expect(s.posts).toHaveLength(1);
    expect(heldRev(s.r), 'nothing ran: the key is dropped').toBeUndefined();
    expect(cardState()).toBe('none');
    const before = { elig: s.eligReads.length, details: s.server.details().length, pays: s.server.paymentReads().length, logins: s.server.logins().length };
    type('issued-reverse-reauth-password', 'correct horse');
    await user().click(tid('issued-reverse-reauth-confirm'));
    await waitFor(() => expect(tid('issued-reverse-confirm-status')).toHaveTextContent(REVERSE_TEXT.renewed));
    expect(s.server.logins().length).toBe(before.logins + 1);
    expect(s.eligReads.length).toBeGreaterThan(before.elig);
    expect(s.server.details().length).toBeGreaterThan(before.details);
    expect(s.server.paymentReads().length).toBeGreaterThan(before.pays);
    expect(screen.queryByTestId('issued-reverse-reauth-group')).toBeNull();
    expect(within(tid('issued-reverse-reasons')).getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked), 'the reason is cleared').toBe(true);
    await settle();
    expect(s.posts, 'the sign-in never submits').toHaveLength(1);
    await user().click(tid('issued-reverse-send'));
    expect(tid('issued-reverse-reason-error')).toHaveTextContent(REVERSE_TEXT.chooseReason);
    expect(s.posts).toHaveLength(1);
    await user().click(tid('issued-reverse-reason-wrong_invoice'));
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(revStatus()).toBe(REVERSE_TEXT.reversed));
    expect(s.posts).toHaveLength(2);
    expect(s.r.keys).toHaveLength(2);
    expect(s.r.keys[1]).not.toBe(s.r.keys[0]);
    expect(s.posts.map((p) => p.key)).toEqual(s.r.keys);
    expect(heldRev(s.r)?.state).toBe('reversed');
  });

  it.each(['Keep payment while it is waited for', 'Stop waiting', 'the 30 s deadline'] as const)('SII-242. P2C R5: after a first send\'s step-up, %s ends the sign-in — the provider\'s late success then renews nothing and submits nothing (no login, no re-read, no reversal POST, no key)', async (arm) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const calls: Array<(token: string | null) => void> = [];
    const s = await setup({ identity: (r) => ({ ...r.props().identity!, reauthenticate: () => new Promise<string | null>((resolve) => { calls.push(resolve); }) }) });
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    s.revScripts.push(chain(403, 'step_up_required'));
    await reverse(P(1));
    await waitFor(() => expect(tid('issued-reverse-reauth-group')).toBeInTheDocument());
    fakeClock();
    type('issued-reverse-reauth-password', 'correct horse');
    fireEvent.click(tid('issued-reverse-reauth-confirm'));
    await until(() => expect(calls).toHaveLength(1));
    await until(() => expect(tid('issued-reverse-reauth-stop')).toBeInTheDocument());
    if (arm === 'Keep payment while it is waited for') {
      fireEvent.click(tid('issued-reverse-keep'));
      await until(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    } else if (arm === 'Stop waiting') {
      fireEvent.click(tid('issued-reverse-reauth-stop'));
      await until(() => expect(screen.queryByTestId('issued-reverse-reauth-stop')).toBeNull());
    } else {
      await advance(30_000);
      await until(() => expect(screen.queryByTestId('issued-reverse-reauth-stop')).toBeNull());
    }
    const logins = s.server.logins().length;
    const eligs = s.eligReads.length;
    await act(async () => { calls[0]('tok-a'); });
    await settle();
    await advance(60_000);
    expect(s.server.logins().length, 'the late success renews nothing').toBe(logins);
    expect(s.eligReads.length, 'and re-reads nothing').toBe(eligs);
    expect(s.posts).toHaveLength(1);
    expect(s.r.keys).toHaveLength(1);
    expect(heldRev(s.r)).toBeUndefined();
  });

  it('SII-243. P2C R6: a first send answered reversed says "Payment reversed." and reads the invoice and history again; when that history read fails, the failure is said in the payments state line, SEPARATE from the confirmed reversal (rows kept)', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await review(P(1));
    const details = s.server.details().length;
    const reads = s.server.paymentReads().length;
    s.server.paymentsStatus.push(500);
    await user().click(tid('issued-reverse-reason-recorded_in_error'));
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(revStatus()).toBe(REVERSE_TEXT.reversed));
    await waitFor(() => expect(payPhase()).toBe('unavailable'));
    expect(s.server.details().length).toBeGreaterThan(details);
    expect(s.server.paymentReads().length).toBe(reads + 1);
    expect(tid('issued-payments-state')).toHaveTextContent(PAYMENTS_TEXT.unavailable);
    expect(revStatus()).toBe(REVERSE_TEXT.reversed);
    expect(revAlert()).toBe('');
    expect(screen.getAllByTestId('issued-payments-item')).toHaveLength(1);
    expect(heldRev(s.r)).toMatchObject({ state: 'reversed', attributed: true });
    expect(cardState()).toBe('none');
    expect(s.posts).toHaveLength(1);
  });

  it.each([
    ['invalid_state; the fresh read shows the exact row reversed', 'invalid_state', 'reversed', REVERSE_TEXT.alreadyReversed, false],
    // A voided invoice's history has every payment reversed (a void refuses while one is recorded; the client rejects anything else).
    ['invalid_state; the fresh read shows the invoice voided and the row reversed', 'invalid_state', 'voided', REVERSE_TEXT.alreadyReversed, false],
    // The fresh INVOICE read says voided while the history read failed: R6's words come from either fresh read (FIX1).
    ['invalid_state; the fresh invoice read shows it voided while the history read fails', 'invalid_state', 'voided-unread', REVERSE_TEXT.voided, true],
    ['invalid_state; the fresh read shows neither', 'invalid_state', 'neither', REVERSE_TEXT.cannotNow, true],
    // FIX3 E1: a SIBLING payment reversed, the exact one not — nothing may say this payment was reversed.
    ['invalid_state; the fresh read shows a sibling reversed and the exact row not', 'invalid_state', 'sibling', REVERSE_TEXT.cannotNow, true],
    ['a sealed write_conflict; the fresh read shows neither', 'write_conflict', 'neither', REVERSE_TEXT.cannotNow, true],
  ] as const)('SII-244. P2C R6: a first send refused with %s — a fresh invoice and history read decides the words; the attempt is settled (no card with Retry), never left unresolved', async (_label, error, now, text, alert) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await review(P(1));
    if (now === 'reversed') s.server.payments.set(s.made[1].id, [pay(1, { reversal: { reversedAt: REVERSED_AT, reasonCode: 'other' } })]);
    if (now === 'sibling') s.server.payments.set(s.made[1].id, [pay(1), pay(2, { reversal: { reversedAt: REVERSED_AT, reasonCode: 'other' } })]);
    if (now === 'voided' || now === 'voided-unread') {
      s.server.payments.set(s.made[1].id, [pay(1, { reversal: { reversedAt: REVERSED_AT, reasonCode: 'other' } })]);
      s.server.issued.set(STORE_1, s.made.map((i, n) => (n === 1 ? { ...i, void: { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' } } : i)));
    }
    if (now === 'voided-unread') s.server.paymentsStatus.push(500);
    s.revScripts.push(sealed(409, error));
    const details = s.server.details().length;
    const reads = s.server.paymentReads().length;
    await user().click(tid('issued-reverse-reason-wrong_amount'));
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(alert ? revAlert() : revStatus()).toBe(text));
    await settle();
    expect(alert ? revStatus() : revAlert()).toBe('');
    expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull();
    expect(s.server.details().length).toBeGreaterThan(details);
    expect(s.server.paymentReads().length).toBeGreaterThan(reads);
    expect(['sending', 'unresolved', 'checking']).not.toContain(heldRev(s.r)?.state);
    expect(screen.queryByTestId('issued-reverse-retry')).toBeNull();
    // FIX3 E1: a refused attempt's card is never titled "Payment reversed." — this request reversed nothing.
    expect(heldRev(s.r)?.state).toBe('refused');
    if (cardState() !== 'none') {
      expect(cardState()).toBe('refused');
      expect(tid('issued-reverse-card-title')).toHaveTextContent(REVERSE_TEXT.cardRefusedTitle);
    }
    expect(screen.queryAllByText(REVERSE_TEXT.reversed)).toEqual([]);
    expect(s.posts).toHaveLength(1);
  });

  it.each([
    ['denied (403)', () => chain(403, 'forbidden'), REVERSE_TEXT.denied],
    ['not found (chain 404)', () => chain(404, 'not_found'), REVERSE_TEXT.notRun],
    ['tenant conflict (chain 409 write_conflict)', () => chain(409, 'write_conflict'), REVERSE_TEXT.notRun],
    ['invalid (400)', () => chain(400, 'invalid_request'), REVERSE_TEXT.notRun],
    ['rate limited (429, Retry-After 7)', () => chain(429, 'rate_limited', { 'retry-after': '7' }), REVERSE_TEXT.rateLimited(7)],
    ['signed out (401)', () => chain(401, 'unauthenticated'), null],
  ] as const)('SII-245. P2C R6: a first send answered %s ran nothing — the attempt is removed (no held card), the confirmation closes and the section says so (fix2 item 2); nothing is resent', async (_label, answer, text) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    s.revScripts.push(answer());
    await reverse(P(1));
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    if (text !== null) expect(revAlert()).toBe(text);
    await settle();
    expect(heldRev(s.r)).toBeUndefined();
    expect(screen.queryByTestId('issued-reverse-card')).toBeNull();
    expect(s.posts).toHaveLength(1);
    expect(s.r.keys).toHaveLength(1);
  });

  it.each([
    ['a 500 (unknown, answered)', () => reply(500, { error: 'internal', requestId: 'r' }), true],
    ['no answer (network)', () => 'network' as const, true],
    ['an answer lost after the server reversed it', () => 'lose' as const, true],
    ['in progress (409 request_in_progress)', () => chain(409, 'request_in_progress'), true],
    ['key reused (422)', () => reply(422, { error: 'idempotency_key_reused' }), false],
  ] as const)('SII-246. P2C R6/R8: a first send answered %s is UNRESOLVED — the confirmation closes to a held card (Retry reversal only when retryable, Check payment, Dismiss) and NOTHING is resent on its own, however long it waits', async (_label, answer, retryable) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const s = await setup();
    await unresolved(s, answer());
    expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull();
    expect(tid('issued-reverse-card')).toHaveAttribute('data-id', P(1));
    expect(tid('issued-reverse-card-title')).toHaveTextContent(REVERSE_TEXT.cardTitle);
    expect(tid('issued-reverse-card-status')).toHaveTextContent(REVERSE_TEXT.cardUnresolved('$1.00', 2));
    expect(tid('issued-reverse-card').textContent).not.toMatch(/refund/i);
    expect(cardButtons()).toEqual(retryable ? [REVERSE_TEXT.retry, REVERSE_TEXT.check, REVERSE_TEXT.dismiss] : [REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    // R3: focus back to the row's button, else the payments heading (the row's button is hidden while this is held);
    // UI-NOTES deviation 2 names the card's heading. Either is accepted here: focus never stays on a removed node.
    await settle();
    expect([tid('issued-reverse-card-title'), document.getElementById('issued-payments-title')]).toContain(document.activeElement);
    expect(heldRev(s.r)).toMatchObject({ state: 'unresolved', key: s.r.keys[0], retryable });
    const mark = s.log.length;
    fakeClock();
    for (let i = 0; i < 12; i++) await advance(10_000);
    await focusEvents();
    expect(s.posts).toHaveLength(1);
    expect(s.log.slice(mark).filter((l) => !l.startsWith('GET ')), 'nothing but reads on its own').toEqual([]);
    expect(heldRev(s.r)?.state).toBe('unresolved');
    expect(s.r.keys).toHaveLength(1);
  });

  it('SII-247. P2C R6/R8: Retry reversal resends the SAME key and the SAME body bytes to the same payment; a validated reversed answer settles it — "Payment reversed.", the card goes, the history reads the row Reversed; no new key', async () => {
    const s = await setup();
    await unresolved(s);
    await click('issued-reverse-retry');
    await waitFor(() => expect(s.posts).toHaveLength(2));
    const [first, again] = s.posts;
    expect(again.key).toBe(first.key);
    expect(again.body).toBe(first.body);
    expect(again.url).toBe(first.url);
    expect(JSON.parse(again.body)).toEqual({ expectedTenant: TENANT_A, reasonCode: 'wrong_amount' });
    await waitFor(() => expect(heldRev(s.r)).toMatchObject({ state: 'reversed', attributed: true }));
    await waitFor(() => expect(revStatus()).toBe(REVERSE_TEXT.reversed));
    await waitFor(() => expect(tid('issued-payments-reversed')).toHaveTextContent('Reversed'));
    expect(cardState()).toBe('none');
    expect(s.r.keys).toHaveLength(1);
    await settle();
    expect(s.posts).toHaveLength(2);
  });

  it.each([
    ['step-up', () => chain(403, 'step_up_required'), false],
    ['denied (403)', () => chain(403, 'forbidden'), true],
    ['not found (chain 404)', () => chain(404, 'not_found'), true],
    ['tenant conflict (chain 409)', () => chain(409, 'write_conflict'), true],
    ['rate limited (429)', () => chain(429, 'rate_limited', { 'retry-after': '2' }), true],
    ['key reused (422)', () => reply(422, { error: 'idempotency_key_reused' }), false],
    ['invalid_state while the exact row is NOT reversed', () => sealed(409, 'invalid_state'), true],
    ['invalid_state while a SIBLING is reversed and the exact row is NOT', () => sealed(409, 'invalid_state'), true],
  ] as const)('SII-248. P2C R6: a refusal on RESEND — %s — does not tell what the first request did: the attempt stays UNRESOLVED (never settled, never removed); Retry stays only where it may run again', async (label, answer, retryable) => {
    const s = await setup();
    await unresolved(s);
    s.revScripts.push(answer());
    if (label.includes('SIBLING')) s.server.payments.set(s.made[1].id, [pay(1), pay(2, { reversal: { reversedAt: REVERSED_AT, reasonCode: 'other' } })]);
    const reads = s.server.paymentReads().length;
    await click('issued-reverse-retry');
    await waitFor(() => expect(s.posts).toHaveLength(2));
    await waitFor(() => expect(heldRev(s.r)?.state).toBe('unresolved'));
    if (label.startsWith('invalid_state')) {
      await waitFor(() => expect(heldRev(s.r)?.seen).toBe('not-reversed'));
      expect(s.server.paymentReads().length, 'only the exact row may say reversed: it is read').toBeGreaterThan(reads);
    }
    await settle();
    expect(heldRev(s.r)).toMatchObject({ state: 'unresolved', attributed: false, key: s.r.keys[0], retryable });
    expect(cardState()).toBe('unresolved');
    expect(screen.queryByTestId('issued-reverse-retry') !== null).toBe(retryable);
    expect(cardButtons()).toContain(REVERSE_TEXT.check);
    expect(tid('issued-reverse-card-title')).toHaveTextContent(REVERSE_TEXT.cardTitle);
    expect(screen.queryAllByText(REVERSE_TEXT.reversed), 'FIX3 E1: never "Payment reversed."').toEqual([]);
    expect(s.posts).toHaveLength(2);
    expect(s.r.keys).toHaveLength(1);
  });

  it('SII-249. P2C R6: a resend answered rate limited (Retry-After 7) keeps Retry reversal aria-disabled — a press sends nothing — until the 7 s have passed; then Retry resends the same key', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const s = await setup();
    await unresolved(s);
    s.revScripts.push(chain(429, 'rate_limited', { 'retry-after': '7' }));
    fakeClock();
    fireEvent.click(tid('issued-reverse-retry'));
    await until(() => expect(s.posts).toHaveLength(2));
    await until(() => expect(tid('issued-reverse-retry')).toHaveAttribute('aria-disabled', 'true'));
    expect(tid('issued-reverse-retry')).not.toBeDisabled();
    fireEvent.click(tid('issued-reverse-retry'));
    await advance(6_000);
    expect(tid('issued-reverse-retry')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(tid('issued-reverse-retry'));
    await settle();
    expect(s.posts).toHaveLength(2);
    await advance(1_500);
    await until(() => expect(tid('issued-reverse-retry')).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(tid('issued-reverse-retry'));
    await until(() => expect(s.posts).toHaveLength(3));
    expect(s.posts[2].key).toBe(s.posts[0].key);
    expect(s.posts[2].body).toBe(s.posts[0].body);
    await until(() => expect(heldRev(s.r)?.state).toBe('reversed'));
  });

  it.each([
    ['the server reversed it (answer lost)', 'lose' as const, 'reversed'],
    ['the server never reversed it (500)', null, 'not-reversed'],
  ] as const)('SII-250. P2C R7/R8: Check payment when %s — GETs only (no POST, no key); found reversed settles the attempt as reversed WITHOUT attributing it; found unreversed settles nothing ("not reversed as of this read")', async (_label, script, seen) => {
    const s = await setup();
    await unresolved(s, script ?? reply(500, { error: 'internal', requestId: 'r' }));
    const mark = s.log.length;
    await click('issued-reverse-check');
    if (seen === 'reversed') {
      await waitFor(() => expect(heldRev(s.r)).toMatchObject({ state: 'reversed', attributed: false }));
      await waitFor(() => expect(tid('issued-reverse-card-status')).toHaveTextContent(REVERSE_TEXT.cardSeenReversed));
      expect(cardButtons()).toEqual([REVERSE_TEXT.dismiss]);
    } else {
      await waitFor(() => expect(tid('issued-reverse-card-seen')).toHaveTextContent(REVERSE_TEXT.seenNotReversed));
      expect(heldRev(s.r)).toMatchObject({ state: 'unresolved', seen: 'not-reversed' });
      expect(cardButtons()).toEqual([REVERSE_TEXT.retry, REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    }
    await settle();
    const sent = s.log.slice(mark);
    expect(sent.some((l) => /\/payments(\?|$)/.test(l))).toBe(true);
    expect(sent.filter((l) => !l.startsWith('GET ')), 'Check payment only reads').toEqual([]);
    expect(s.posts).toHaveLength(1);
    expect(s.r.keys).toHaveLength(1);
  });

  it.each([
    ['no longer listed (complete traversal)', (s: Setup) => s.server.payments.set(s.made[1].id, [pay(2)]), 1],
    ['unreadable (500)', (s: Setup) => { s.server.paymentsStatus.push(500); }, 1],
    ['past the 20-page cap', (s: Setup) => s.server.payments.set(s.made[1].id, behind(1000)), 20],
  ] as const)('SII-251. P2C R7: Check payment finds the exact payment %s — "couldn\'t confirm", the attempt stays UNRESOLVED with Retry, nothing settles; GETs only', async (_label, change, pages) => {
    const s = await setup();
    await unresolved(s);
    change(s);
    const reads = s.server.paymentReads().length;
    const mark = s.log.length;
    await click('issued-reverse-check');
    await waitFor(() => expect(tid('issued-reverse-card-seen')).toHaveTextContent(REVERSE_TEXT.seenUnconfirmed));
    await settle();
    expect(s.server.paymentReads().length - reads).toBe(pages);
    expect(heldRev(s.r)).toMatchObject({ state: 'unresolved', seen: 'unconfirmed', retryable: true });
    expect(cardButtons()).toEqual([REVERSE_TEXT.retry, REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    expect(s.log.slice(mark).filter((l) => !l.startsWith('GET '))).toEqual([]);
    expect(s.posts).toHaveLength(1);
  });

  it('SII-252. P2C R8: while a reversal is unresolved on invoice 2, Record payment and Void are hidden on invoice 2 and Reverse is hidden EVERYWHERE; invoice 3 keeps working Record payment and Void; after Dismiss, Reverse is back', async () => {
    const s = await setup({ recorder: true });
    s.server.payments.set(s.made[2].id, [pay(2)]);
    const controls = () => ({
      record: screen.queryByTestId('issued-payments-record') !== null, void: screen.queryByTestId('issued-view-void') !== null, reverse: reverseIds().length > 0,
    });
    await open(3);
    await waitFor(() => expect(controls()).toEqual({ record: true, void: true, reverse: true }));
    await close();
    await unresolved(s);
    await settle();
    expect(controls()).toEqual({ record: false, void: false, reverse: false });
    expect(cardState()).toBe('unresolved');
    await close();
    await open(3);
    await waitFor(() => expect(controls()).toMatchObject({ record: true, void: true }));
    await settle();
    expect(controls()).toEqual({ record: true, void: true, reverse: false });
    expect(cardState(), 'the card is invoice 2\'s alone').toBe('none');
    await click('issued-view-void');
    await waitFor(() => expect(tid('issued-void-confirm')).toBeInTheDocument());
    await click('issued-void-keep');
    await waitFor(() => expect(screen.queryByTestId('issued-void-confirm')).toBeNull());
    await click('issued-payments-record');
    await waitFor(() => expect(screen.getByRole('radio', { name: /Cash/ })).toBeInTheDocument());
    await close();
    await open(2);
    await click('issued-reverse-dismiss');
    await waitFor(() => expect(cardState()).toBe('none'));
    expect(heldRev(s.r)).toBeUndefined();
    await waitFor(() => expect(controls()).toEqual({ record: true, void: true, reverse: true }));
    await close();
    await open(3);
    await waitFor(() => expect(controls()).toEqual({ record: true, void: true, reverse: true }));
    expect(s.posts).toHaveLength(1);
  });

  it.each(['an unresolved void attempt', 'an unresolved record attempt'] as const)('SII-253. P2C R1/R8: while the user holds %s (invoice 3), "Reverse payment" is hidden on every invoice — invoice 2 shows none although its read says allowed', async (arm) => {
    const s = await setup({ recorder: true });
    s.server.payments.set(s.made[1].id, [pay(1)]);
    s.server.payments.set(s.made[2].id, [pay(2)]);
    await open(2);
    await waitFor(() => expect(reverseIds()).toEqual([P(1)]));
    await close();
    await open(3);
    if (arm === 'an unresolved void attempt') {
      await click('issued-view-void');
      await waitFor(() => expect(tid('issued-void-confirm')).toBeInTheDocument());
      s.server.voids.push('lose-before');
      await click('issued-void-reason-wrong_customer');
      await click('issued-void-send');
      await waitFor(() => expect(s.r.holds.get('uid-a')?.state).toBe('unresolved'));
      if (screen.queryByTestId('issued-void-confirm') !== null) await click('issued-void-keep');
    } else {
      await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
      s.server.payScripts.register.push('lose-before');
      await click('issued-payments-record');
      fireEvent.change(within(tid('issued-payments-form')).getByTestId('issued-payments-amount-input'), { target: { value: '1.00' } });
      await click('issued-payments-method-cash');
      await click('issued-payments-submit');
      await waitFor(() => expect(s.r.payHolds.get('uid-a')?.state).toBe('unresolved'));
    }
    await settle();
    expect(reverseIds(), 'none on the invoice it is held for').toEqual([]);
    await close();
    const eligs = s.eligReads.length;
    await open(2);
    await waitFor(() => expect(s.eligReads.length).toBeGreaterThan(eligs));
    await settle();
    expect(reverseIds(), 'none on another invoice').toEqual([]);
    expect(s.posts).toEqual([]);
  });

  it.each(['a sign-out', 'a user change', 'another tab\'s session token', 'a store switch'] as const)('SII-254. P2C R8: %s DETACHES an unresolved reversal — token and bytes go; back in its store and invoice the card shows no Retry, only Check payment and Dismiss; it is never shown to another user or in another store', async (arm) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const s = await setup();
    s.server.payments.set(s.made2[0].id, [pay(3)]);
    await unresolved(s);
    await close();
    if (arm === 'a sign-out') {
      await act(async () => { await s.props.session!.logout(); });
    } else if (arm === 'a user change') {
      s.page.rerender(<ServerIssuedInvoices {...s.props} uid="uid-b" />);
      await settle();
      expect(cardState()).toBe('none');
      expect(s.r.revHolds.get('uid-b')).toBeUndefined();
      s.page.rerender(<ServerIssuedInvoices {...s.props} />);
    } else if (arm === 'another tab\'s session token') {
      s.server.otherTab('uid-a');
      await focusEvents();
    } else {
      await showAndChoose(STORE_2);
      await listReady();
      await open(1);
      await settle();
      expect(cardState(), 'never in another store').toBe('none');
      await close();
    }
    await waitFor(() => expect(heldRev(s.r)).toMatchObject({ csrf: null, body: '', state: 'unresolved', key: s.r.keys[0] }));
    if (screen.queryByTestId('issued-retry') !== null) await click('issued-retry');
    if ((screen.queryByTestId('issued-store') as HTMLSelectElement | null)?.value !== STORE_1 || screen.queryByTestId('issued-show') !== null) await showAndChoose(STORE_1);
    await listReady();
    await open(2);
    await waitFor(() => expect(cardState()).toBe('detached'));
    expect(tid('issued-reverse-card-status')).toHaveTextContent(REVERSE_TEXT.cardDetached);
    expect(cardButtons()).toEqual([REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    const mark = s.log.length;
    await click('issued-reverse-check');
    await waitFor(() => expect(tid('issued-reverse-card-seen')).toHaveTextContent(REVERSE_TEXT.seenNotReversed));
    expect(s.log.slice(mark).filter((l) => !l.startsWith('GET '))).toEqual([]);
    expect(cardButtons()).toEqual([REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    expect(s.posts).toHaveLength(1);
  });

  it.each(['another invoice', 'another store'] as const)('SII-255. P2C R8: a reversal answer that arrives after the dialog moved to %s settles only its own attempt (by key) — the open invoice\'s rows, status and alert are untouched and no card shows there', async (arm) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    s.server.payments.set(s.made[2].id, [pay(2)]);
    s.server.payments.set(s.made2[0].id, [pay(3)]);
    await open(2);
    await review(P(1));
    await user().click(tid('issued-reverse-reason-duplicate'));
    s.gate.post = 1;
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(s.held).toHaveLength(1));
    expect(tid('issued-reverse-close-warning')).toHaveTextContent(REVERSE_TEXT.closeWarning);
    await click('issued-reverse-keep');
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    await close();
    if (arm === 'another store') {
      await showAndChoose(STORE_2);
      await listReady();
      await open(1);
    } else {
      await open(3);
    }
    // The row's facts (its Reverse control may come back once nothing is live: R1, not this answer's doing).
    const rows = () => screen.getAllByTestId('issued-payments-item').map((li) => `${li.getAttribute('data-id')} ${li.querySelector('p')?.textContent} ${li.querySelector('time')?.textContent}`);
    const before = rows();
    const reads = s.server.paymentReads().length;
    const details = s.server.details().length;
    await act(async () => { s.held[0].release(); });
    await settle();
    expect(rows()).toEqual(before);
    expect(screen.queryByTestId('issued-payments-reversed')).toBeNull();
    expect(revStatus()).toBe('');
    expect(revAlert()).toBe('');
    expect(cardState()).toBe('none');
    expect(s.server.paymentReads().length, 'no re-read for the other invoice').toBe(reads);
    expect(s.server.details().length).toBe(details);
    if (arm === 'another invoice') expect(heldRev(s.r)).toMatchObject({ state: 'reversed', key: s.r.keys[0] });
    expect(s.posts).toHaveLength(1);
  });

  it.each(['another invoice', 'another store'] as const)('SII-256. P2C R2/R8: the review\'s exact-payment lookup answered late — after the dialog moved to %s — opens no confirmation and says nothing there; nothing is sent', async (arm) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    s.server.payments.set(s.made[2].id, [pay(2)]);
    s.server.payments.set(s.made2[0].id, [pay(3)]);
    await open(2);
    await waitFor(() => expect(reverseIds()).toEqual([P(1)]));
    s.server.hold.payments = 1;
    await pressRow(P(1));
    await waitFor(() => expect(s.server.held.filter((h) => h.kind === 'payments')).toHaveLength(1));
    expect(tid('issued-payments-reverse')).toHaveAttribute('aria-disabled', 'true');
    await close();
    if (arm === 'another store') {
      await showAndChoose(STORE_2);
      await listReady();
      await open(1);
    } else {
      await open(3);
    }
    await act(async () => { s.server.held.find((h) => h.kind === 'payments')!.release(); });
    await settle();
    expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull();
    expect(revStatus()).toBe('');
    expect(revAlert()).toBe('');
    expect(s.posts).toEqual([]);
    expect(s.r.keys).toEqual([]);
  });

  it.each(['Dismiss', 'a reload (a fresh page: the memory-only hold is gone)'] as const)('SII-257. P2C R8: after %s, Reverse needs everything again — a review whose exact payment cannot be verified sends nothing; a verified one needs a fresh reason and an explicit press, and goes under a NEW key', async (arm) => {
    const s = await setup();
    await unresolved(s);
    const firstKey = s.posts[0].key;
    let keys = s.r.keys;
    if (arm === 'Dismiss') {
      await click('issued-reverse-dismiss');
      await waitFor(() => expect(cardState()).toBe('none'));
    } else {
      s.page.unmount();
      const r2 = rig(s.server);
      keys = [];
      render(<ServerIssuedInvoices {...r2.props({ issuing: createInvoiceIssuingClient({ fetch: s.routed }), newKey: () => { const k = `5e1f0000-1d2f-4a6b-9c8d-${String(900 + keys.length).padStart(12, '0')}`; keys.push(k); return k; } })} />);
      await showAndChoose(STORE_1);
      await listReady();
      await open(2);
      expect(cardState(), 'nothing of it survives a reload').toBe('none');
    }
    await waitFor(() => expect(reverseIds()).toEqual([P(1)]));
    s.server.paymentsStatus.push(500);
    await pressRow(P(1));
    await waitFor(() => expect(revAlert()).toBe(REVERSE_TEXT.unconfirmed));
    await settle();
    expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull();
    expect(s.posts).toHaveLength(1);
    const reads = s.server.paymentReads().length;
    await review(P(1));
    expect(s.server.paymentReads().length).toBeGreaterThan(reads);
    expect(within(tid('issued-reverse-reasons')).getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    await user().click(tid('issued-reverse-send'));
    expect(tid('issued-reverse-reason-error')).toHaveTextContent(REVERSE_TEXT.chooseReason);
    expect(s.posts).toHaveLength(1);
    await user().click(tid('issued-reverse-reason-other'));
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(revStatus()).toBe(REVERSE_TEXT.reversed));
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1].key).not.toBe(firstKey);
    expect(s.posts[1].key).toBe(keys[keys.length - 1]);
    expect(JSON.parse(s.posts[1].body)).toEqual({ expectedTenant: TENANT_A, reasonCode: 'other' });
  });

  // ---- FIX1 regressions (review F1-F4, F6) ----
  /** A LIVE reversal hold of uid-a put straight into the store (what another dialog's send would have held). */
  const liveHold = (invoiceId: string, over: Partial<Parameters<ReversalHoldStore['put']>[1]> = {}): Parameters<ReversalHoldStore['put']>[1] => ({
    key: 'k-live', body: '{"x":1}', storeId: STORE_1, storeLabel: 'Store 1', invoiceId, number: 2, paymentId: P(9), amountCents: 100, reasonCode: 'other',
    csrf: 'csrf-live', sentAt: performance.now(), sentWall: Date.now(), state: 'unresolved', note: '', refusal: null, attributed: false, seen: null, retryable: false, ...over,
  });
  const voidTrigger = () => screen.queryByTestId('issued-view-void') !== null;

  it('SII-258. FIX1 F3: while a reversal review is out, "Void invoice…" is not shown (no void review can start beside it); the reversal confirmation then opens alone', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await waitFor(() => expect(voidTrigger()).toBe(true));
    s.gate.elig = 1;
    await pressRow(P(1));
    await waitFor(() => expect(s.held.filter((h) => h.kind === 'elig')).toHaveLength(1));
    expect(voidTrigger()).toBe(false);
    const details = s.server.details().length;
    await act(async () => { s.held[0].release(); });
    await waitFor(() => expect(tid('issued-reverse-confirm')).toBeInTheDocument());
    expect(screen.queryByTestId('issued-void-confirm')).toBeNull();
    expect(s.server.details().length).toBe(details);
    expect(s.posts).toEqual([]);
  });

  it('SII-259. FIX1 F3: while a void review is out and while its confirmation is open, no row shows "Reverse payment"; Keep invoice brings it back', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await waitFor(() => expect(reverseIds()).toEqual([P(1)]));
    s.server.hold.detail = 1;
    await click('issued-view-void');
    await waitFor(() => expect(s.server.held.filter((h) => h.kind === 'detail')).toHaveLength(1));
    expect(reverseIds()).toEqual([]);
    await act(async () => { s.server.held.find((h) => h.kind === 'detail')!.release(); });
    await waitFor(() => expect(tid('issued-void-confirm')).toBeInTheDocument());
    expect(reverseIds()).toEqual([]);
    await click('issued-void-keep');
    await waitFor(() => expect(screen.queryByTestId('issued-void-confirm')).toBeNull());
    await waitFor(() => expect(reverseIds()).toEqual([P(1)]));
    expect(s.posts).toEqual([]);
  });

  it('SII-260. FIX1 F3: a void confirmation already open when a reversal of one of the invoice\'s payments goes live sends NO void — "Another request is waiting to be confirmed."', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await click('issued-view-void');
    await waitFor(() => expect(tid('issued-void-confirm')).toBeInTheDocument());
    await act(async () => { s.r.revHolds.put('uid-a', liveHold(s.made[1].id)); });
    await click('issued-void-reason-wrong_customer');
    await click('issued-void-send');
    await waitFor(() => expect(tid('issued-void-confirm-alert')).toHaveTextContent(REVERSE_TEXT.pending));
    await settle();
    expect(s.log.filter((l) => l.startsWith('POST ') && l.endsWith('/void'))).toEqual([]);
    expect(s.r.holds.get('uid-a')).toBeUndefined();
  });

  it('SII-261. FIX1 F3: a Record press whose session check is out when a reversal on the same invoice goes live sends NO register — the flow says "Another request is waiting to be confirmed."', async () => {
    const s = await setup({ recorder: true });
    await open(3);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
    await click('issued-payments-record');
    fireEvent.change(within(tid('issued-payments-form')).getByTestId('issued-payments-amount-input'), { target: { value: '1.00' } });
    await click('issued-payments-method-cash');
    s.server.hold.current = 1;
    await click('issued-payments-submit');
    await waitFor(() => expect(s.server.held.filter((h) => h.kind === 'current')).toHaveLength(1));
    await act(async () => { s.r.revHolds.put('uid-a', liveHold(s.made[2].id, { number: 3 })); });
    await act(async () => { s.server.held.find((h) => h.kind === 'current')!.release(); });
    await waitFor(() => expect(tid('issued-payments-flow')).toHaveTextContent(REVERSE_TEXT.pending));
    await settle();
    expect(s.r.payHolds.get('uid-a')).toBeUndefined();
    expect(s.log.filter((l) => l.startsWith('POST ') && l.includes('/payment'))).toEqual([]);
  });

  it('SII-262. FIX1 F1: the store turns a DETACHED sending/checking attempt unresolved (every detach path: detach, detachOthers); a settled one stays settled', () => {
    for (const state of ['sending', 'checking'] as const) {
      const one = createReversalHoldStore();
      one.put('u', liveHold('i', { state }));
      one.detach('u');
      expect(one.get('u')).toMatchObject({ csrf: null, body: '', state: 'unresolved', key: 'k-live' });
      const many = createReversalHoldStore();
      many.put('u', liveHold('i', { state }));
      many.put('v', liveHold('i', { state, key: 'k-v' }));
      many.detachOthers('v');
      expect(many.get('u')).toMatchObject({ csrf: null, state: 'unresolved' });
      expect(many.get('v'), 'the kept user is untouched').toMatchObject({ csrf: 'csrf-live', state });
      many.detachOthers(null);
      expect(many.get('v')).toMatchObject({ csrf: null, state: 'unresolved' });
      one.dispose();
      many.dispose();
    }
    const done = createReversalHoldStore();
    done.put('u', liveHold('i', { state: 'refused', refusal: 'invalid-state' }));
    done.detach('u');
    expect(done.get('u')).toMatchObject({ state: 'refused' });
    done.dispose();
  });

  it('SII-263. FIX1 F1: a sign-out while the FIRST send is out leaves the attempt unresolved (not "sending"): back in, its card says detached with Check payment and Dismiss; the late 200 changes nothing', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await review(P(1));
    await user().click(tid('issued-reverse-reason-duplicate'));
    s.gate.post = 1;
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(s.held.filter((h) => h.kind === 'post')).toHaveLength(1));
    await click('issued-reverse-keep');
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    await close();
    await act(async () => { await s.props.session!.logout(); });
    await waitFor(() => expect(heldRev(s.r)).toMatchObject({ csrf: null, body: '', state: 'unresolved' }));
    if (screen.queryByTestId('issued-retry') !== null) await click('issued-retry');
    if ((screen.queryByTestId('issued-store') as HTMLSelectElement | null)?.value !== STORE_1 || screen.queryByTestId('issued-show') !== null) await showAndChoose(STORE_1);
    await listReady();
    await open(2);
    await waitFor(() => expect(cardState()).toBe('detached'));
    expect(tid('issued-reverse-card-status')).toHaveTextContent(REVERSE_TEXT.cardDetached);
    expect(cardButtons()).toEqual([REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    await act(async () => { s.held.find((h) => h.kind === 'post')!.release(); });
    await settle();
    expect(heldRev(s.r)).toMatchObject({ csrf: null, state: 'unresolved' });
    expect(cardButtons()).toEqual([REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    expect(s.posts).toHaveLength(1);
  });

  it.each([
    ['a sealed invalid_state', () => sealed(409, 'invalid_state')],
    ['a step-up', () => chain(403, 'step_up_required')],
  ] as const)('SII-264. FIX1 F6: a FIRST send detached while out and then answered %s follows the hold, not the answer — no sign-in group, no refusal words; the confirmation closes onto the detached card', async (_label, answer) => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    await review(P(1));
    await user().click(tid('issued-reverse-reason-duplicate'));
    s.gate.post = 1;
    await user().click(tid('issued-reverse-send'));
    await waitFor(() => expect(s.held.filter((h) => h.kind === 'post')).toHaveLength(1));
    await act(async () => { s.r.revHolds.detach('uid-a'); });
    const reads = s.server.paymentReads().length;
    await act(async () => { s.held.find((h) => h.kind === 'post')!.release(answer()); });
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    await settle();
    expect(screen.queryByTestId('issued-reverse-reauth-group')).toBeNull();
    expect(revAlert()).toBe('');
    expect(revStatus()).toBe('');
    expect(s.server.paymentReads().length, 'no refusal lookup').toBe(reads);
    expect(heldRev(s.r)).toMatchObject({ csrf: null, state: 'unresolved' });
    expect(cardState()).toBe('detached');
    expect(cardButtons()).toEqual([REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    expect(s.posts).toHaveLength(1);
  });

  it('SII-265. FIX1 F2: Retry reversal hands focus to the card\'s heading before its controls go; a Retry that settles reversed takes the card away and focus lands on the payments heading (not Close); Check payment focuses the heading too', async () => {
    const s = await setup();
    await unresolved(s);
    await click('issued-reverse-check');
    expect(document.activeElement).toBe(tid('issued-reverse-card-title'));
    await waitFor(() => expect(tid('issued-reverse-card-seen')).toHaveTextContent(REVERSE_TEXT.seenNotReversed));
    s.gate.post = 1;
    await click('issued-reverse-retry');
    expect(document.activeElement).toBe(tid('issued-reverse-card-title'));
    await waitFor(() => expect(s.held.filter((h) => h.kind === 'post')).toHaveLength(1));
    await act(async () => { s.held.find((h) => h.kind === 'post')!.release(); });
    await waitFor(() => expect(cardState()).toBe('none'));
    await settle();
    expect(document.activeElement).toBe(document.getElementById('issued-payments-title'));
    expect(s.posts).toHaveLength(2);
  });

  it('SII-266. FIX1 F4: with no dialog open, the user\'s live reversal stays reachable in its own store — the section shows its card (Retry, Check payment, Dismiss), never beside an open dialog or in another store; Dismiss focuses the section heading', async () => {
    const s = await setup();
    await unresolved(s);
    await close();
    await waitFor(() => expect(cardState()).toBe('unresolved'));
    expect(cardButtons()).toEqual([REVERSE_TEXT.retry, REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    const mark = s.log.length;
    await click('issued-reverse-check');
    await waitFor(() => expect(tid('issued-reverse-card-seen')).toHaveTextContent(REVERSE_TEXT.seenNotReversed));
    expect(s.log.slice(mark).filter((l) => !l.startsWith('GET '))).toEqual([]);
    await open(3);
    expect(screen.queryAllByTestId('issued-reverse-card'), 'none beside another invoice\'s dialog').toHaveLength(0);
    await close();
    expect(screen.queryAllByTestId('issued-reverse-card')).toHaveLength(1);
    await click('issued-reverse-dismiss');
    await waitFor(() => expect(cardState()).toBe('none'));
    expect(heldRev(s.r)).toBeUndefined();
    expect(document.activeElement).toBe(document.getElementById('issued-title'));
    await act(async () => { s.r.revHolds.put('uid-a', liveHold(s.made[1].id)); });
    await showAndChoose(STORE_2);
    await listReady();
    await settle();
    expect(cardState(), 'never in another store').toBe('none');
    expect(s.posts).toHaveLength(1);
  });

  it('SII-267. FIX2 item 1: a Check payment read begun while the attempt was ATTACHED settles nothing once it was detached before the read answered; a read begun after the detach (its own context) may say reversed', () => {
    const late = createReversalHoldStore();
    late.put('u', liveHold('i'));
    late.detach('u');
    seeReversal(late, 'u', 'k-live', 'reversed', true);
    expect(late.get('u'), 'the late answer changes nothing').toMatchObject({ csrf: null, state: 'unresolved', seen: null, attributed: false });
    seeReversal(late, 'u', 'k-live', 'not-reversed', true);
    expect(late.get('u')).toMatchObject({ seen: null });
    seeReversal(late, 'u', 'k-live', 'reversed', false);
    expect(late.get('u'), 'a read begun detached (after the detach) is its own').toMatchObject({ state: 'reversed', attributed: false, seen: 'reversed' });
    late.dispose();
  });

  it('SII-268. FIX2 item 2: after a FIRST send that ran nothing (denied) the confirmation is gone — focus back on the row\'s Reverse payment — so no second key can leave on the old review; a new press runs a NEW R2 review first', async () => {
    const s = await setup();
    s.server.payments.set(s.made[1].id, [pay(1)]);
    await open(2);
    s.revScripts.push(chain(403, 'forbidden'));
    await reverse(P(1));
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    expect(revAlert()).toBe(REVERSE_TEXT.denied);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-payments-reverse')));
    expect(s.posts).toHaveLength(1);
    const mark = s.log.length;
    await review(P(1));
    expect(s.log.slice(mark).filter((l) => l.startsWith('GET ')).length, 'a fresh review read').toBeGreaterThan(0);
    expect(tid('issued-reverse-confirm').querySelector('input[type=radio]:checked'), 'no reason carried over').toBeNull();
    expect(s.posts).toHaveLength(1);
  });

  /** After a first send's step-up on invoice 2's P(1) (P(2) listed too): the password typed, the sign-in pressed. */
  async function stepUpSignIn(s: Setup) {
    s.server.payments.set(s.made[1].id, [pay(1), pay(2)]);
    await open(2);
    s.revScripts.push(chain(403, 'step_up_required'));
    await reverse(P(1));
    await waitFor(() => expect(tid('issued-reverse-reauth-group')).toBeInTheDocument());
    type('issued-reverse-reauth-password', 'correct horse');
  }

  it('SII-270. FIX3 req 1 (review-3 LOW-1): a renewal whose re-read settles AFTER its confirmation was kept and another row\'s confirmation opened never closes that other confirmation', async () => {
    const s = await setup();
    await stepUpSignIn(s);
    s.server.hold.payments = 1; // the renewal's history read (R7) stays out
    await user().click(tid('issued-reverse-reauth-confirm'));
    await waitFor(() => expect(s.server.held.map((h) => h.kind)).toEqual(['payments']));
    await click('issued-reverse-keep');
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    await review(P(2)); // a NEW confirmation, on the other payment
    await act(async () => { s.server.held.shift()!.release(); }); // the renewal's superseded read answers late
    await settle();
    expect(tid('issued-reverse-confirm'), 'the other confirmation stays open').toBeInTheDocument();
    expect(tid('issued-reverse-confirm-status')).not.toHaveTextContent(REVERSE_TEXT.renewed);
    expect(revAlert()).toBe('');
    expect(s.posts).toHaveLength(1);
  });

  it('SII-271. FIX3 req 2: a renewal whose confirmation was closed while its eligibility re-read was out leaves it closed and says nothing about it (no "can no longer reverse"); nothing is sent', async () => {
    const s = await setup();
    await stepUpSignIn(s);
    s.gate.elig = 1;
    await user().click(tid('issued-reverse-reauth-confirm'));
    await waitFor(() => expect(s.held.map((h) => h.kind)).toEqual(['elig']));
    await click('issued-reverse-keep');
    await waitFor(() => expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull());
    await act(async () => { s.held.shift()!.release(reply(200, { eligibility: 'not_allowed' })); });
    await settle();
    expect(screen.queryByTestId('issued-reverse-confirm')).toBeNull();
    expect(revAlert()).toBe('');
    expect(revStatus()).toBe('');
    expect(s.posts).toHaveLength(1);
  });

  it.each([
    ['step-up', () => chain(403, 'step_up_required'), REVERSAL_NOTE_TEXT.stepUp],
    ['key reused (422)', () => reply(422, { error: 'idempotency_key_reused' }), REVERSAL_NOTE_TEXT.keyReused],
    ['signed out (401)', () => chain(401, 'unauthenticated'), REVERSAL_NOTE_TEXT.signedOut],
  ] as const)('SII-272. FIX3 req 4: a resend answered %s withdraws Retry reversal and the card says why and what is left (Check payment, Dismiss); never "refund"', async (_label, answer, note) => {
    const s = await setup();
    await unresolved(s);
    s.revScripts.push(answer());
    await click('issued-reverse-retry');
    await waitFor(() => expect(heldRev(s.r)).toMatchObject({ state: 'unresolved', retryable: false }));
    expect(note).toMatch(/Use Check payment\.$/);
    if (note === REVERSAL_NOTE_TEXT.signedOut) {
      // The 401 ends the session, which detaches the attempt at once: the note is held, but a detached card shows its own
      // reason (the note line is for attached attempts). Reconnected and reopened, the card says why and what is left.
      expect(heldRev(s.r)).toMatchObject({ note, csrf: null });
      await waitFor(() => expect(screen.queryByTestId('issued-retry')).not.toBeNull());
      await click('issued-retry');
      if ((screen.queryByTestId('issued-store') as HTMLSelectElement | null)?.value !== STORE_1 || screen.queryByTestId('issued-show') !== null) await showAndChoose(STORE_1);
      await listReady();
      await open(2);
      await waitFor(() => expect(tid('issued-reverse-card-status')).toHaveTextContent(REVERSE_TEXT.cardDetached));
      expect(screen.queryByTestId('issued-reverse-card-note')).toBeNull();
    } else await waitFor(() => expect(tid('issued-reverse-card-note')).toHaveTextContent(note));
    expect(cardButtons()).toEqual([REVERSE_TEXT.check, REVERSE_TEXT.dismiss]);
    expect(tid('issued-reverse-card').textContent).not.toMatch(/refund/i);
    expect(s.posts).toHaveLength(2);
  });

  it('SII-273. FIX3 req 4 (review-3 LOW-3): a Check payment begun while the attempt was attached, refused because another tab\'s session detached it mid-read, says so on the card (never silent); a new Check may then read', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const s = await setup();
    await unresolved(s);
    s.server.hold.payments = 1;
    await click('issued-reverse-check');
    await waitFor(() => expect(s.server.held.map((h) => h.kind)).toEqual(['payments']));
    s.server.otherTab('uid-a');
    await focusEvents();
    await waitFor(() => expect(heldRev(s.r)).toMatchObject({ csrf: null, state: 'unresolved' }));
    await act(async () => { s.server.held.shift()!.release(); });
    await settle();
    // The new session closed the dialog: back on invoice 2, its card says why that Check settled nothing.
    if (screen.queryByTestId('issued-view') === null) {
      if (screen.queryByTestId('issued-retry') !== null) await click('issued-retry');
      if ((screen.queryByTestId('issued-store') as HTMLSelectElement | null)?.value !== STORE_1 || screen.queryByTestId('issued-show') !== null) await showAndChoose(STORE_1);
      await listReady();
      await open(2);
    }
    await waitFor(() => expect(tid('issued-reverse-card-seen')).toHaveTextContent(REVERSE_TEXT.checkDetached));
    expect(cardState()).toBe('detached');
    expect(heldRev(s.r)).toMatchObject({ state: 'unresolved', seen: null });
    // A new Check then reads (detached, so its answer is shown, never a resend): the refusal text goes, the read is seen.
    await click('issued-reverse-check');
    await waitFor(() => expect(tid('issued-reverse-card-seen')).toHaveTextContent(REVERSE_TEXT.seenNotReversed));
    expect(tid('issued-reverse-card-seen')).not.toHaveTextContent(REVERSE_TEXT.checkDetached);
    expect(heldRev(s.r)).toMatchObject({ state: 'unresolved', seen: 'not-reversed' });
    expect(s.posts).toHaveLength(1);
  });

  it.each(['a store switch', 'another tab\'s session token'] as const)('SII-274. FIX3 E2: a Check payment whose page-2 history read is out when %s detaches the attempt — released with the exact row REVERSED — settles nothing: unresolved, seen null, nothing sent', async (arm) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const s = await setup();
    await unresolved(s);
    s.server.payments.set(s.made[1].id, behind(50).map((p) => (p.id === P(1) ? { ...p, reversal: { reversedAt: REVERSED_AT, reasonCode: 'other' } } : p)));
    const reads = s.server.paymentReads().length;
    s.server.hold.payments = 2;
    await click('issued-reverse-check');
    await waitFor(() => expect(s.server.held).toHaveLength(1));
    await act(async () => { s.server.held.shift()!.release(); }); // page one answers
    await waitFor(() => expect(s.server.held).toHaveLength(1)); // page two is out
    expect(s.server.paymentReads()[reads + 1]).toContain('after=');
    if (arm === 'a store switch') {
      await close();
      await showAndChoose(STORE_2);
      await listReady();
    } else {
      s.server.otherTab('uid-a');
      await focusEvents();
    }
    await waitFor(() => expect(heldRev(s.r)).toMatchObject({ csrf: null }));
    await act(async () => { s.server.held.shift()!.release(); });
    await settle();
    expect(heldRev(s.r)).toMatchObject({ state: 'unresolved', seen: null, key: s.r.keys[0] });
    expect(s.posts).toHaveLength(1);
  });

  it.each([
    ['the Retry POST', 'a sign-out'], ['the Retry POST', 'another tab\'s session token'],
    ['the Retry\'s session check', 'a sign-out'], ['the Retry\'s session check', 'another tab\'s session token'],
  ] as const)('SII-275. FIX3 E3: while %s is out, %s detaches the attempt — its late answer changes nothing: no further POST, the hold stays unresolved with no token', async (out, arm) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const s = await setup();
    await unresolved(s);
    if (out === 'the Retry POST') s.gate.post = 1;
    else s.server.hold.current = 1;
    await click('issued-reverse-retry');
    if (out === 'the Retry POST') await waitFor(() => expect(s.held.map((h) => h.kind)).toEqual(['post']));
    else await waitFor(() => expect(s.server.held.map((h) => h.kind)).toEqual(['current']));
    if (arm === 'a sign-out') {
      await act(async () => { await s.props.session!.logout(); });
      await waitFor(() => expect(heldRev(s.r)).toMatchObject({ csrf: null }));
    } else {
      s.server.otherTab('uid-a');
      await focusEvents();
    }
    const late = out === 'the Retry POST' ? s.held.shift()! : s.server.held.shift()!;
    // A held session check answers with the session as it stands NOW (the other tab's token), as a real late answer would.
    const now = out === 'the Retry\'s session check' && arm !== 'a sign-out' ? await s.server.fetch(late.url) : undefined;
    await act(async () => { late.release(now); });
    await settle();
    expect(heldRev(s.r)).toMatchObject({ csrf: null, state: 'unresolved', key: s.r.keys[0] });
    expect(s.posts).toHaveLength(out === 'the Retry POST' ? 2 : 1);
  });
});

// M7B-CREDITNOTES-CN-P2 — the read side (doc 17 §2.2, §3.3, §3.6, §4.1; D-P2-1, D-P2-3, D-P2-12): the invoice's credit-note
// list inside Payments and the owner's attempts lookup that gates the issue action, both under ONE section generation AND
// token. The REAL section and clients over the fake's credit-note routes (support F); the issue side's refresh is driven
// through the section's `creditReads` (what the issue side calls after a 201, a confirm, a release or a settlement).
describe('Issued invoices — credit notes: the list and the owner\'s attempts lookup (M7B-CREDITNOTES-CN-P2)', { timeout: 30_000 }, () => {
  beforeEach(() => { madeServers.length = 0; });
  afterEach(afterEachP289); // fix list 5, C: the P2-89 request-log invariant over every settlement this describe sends
  const OTHER = uuid(0x1aff); // another invoice of the store: the lookup is store-wide
  const cnUrl = (invoiceId: string, after?: string, storeId = STORE_1) => `${STORES_PATH}/${storeId}/invoices/${invoiceId}/credit-notes${after === undefined ? '' : `?after=${after}`}`;
  const lookupUrl = (after?: string) => `${STORES_PATH}/${STORE_1}/credit-note-attempts${after === undefined ? '' : `?after=${after}`}`;
  const cnPhase = () => screen.queryByTestId('issued-payments-credit-state')?.getAttribute('data-phase') ?? 'none';
  const cnReady = () => waitFor(() => expect(cnPhase()).toBe('ready'));
  const lookupPhase = () => screen.queryByTestId('issued-payments-credit-lookup')?.getAttribute('data-phase') ?? 'none';
  const lookupRows = () => Number(tid('issued-payments-credit-lookup').getAttribute('data-rows'));
  const items = () => screen.queryAllByTestId('issued-payments-credit-item');
  const numbers = () => screen.queryAllByTestId('issued-payments-credit-number').map((x) => x.textContent);
  const names = () => screen.queryAllByTestId('issued-payments-credit-issued-by').map((x) => x.textContent);
  const gets = (server: Server, route: 'list' | 'lookup', from = 0) => server.cnRequests(route).slice(from).map((r) => r.url);
  /** The credit-note controls inside Payments (their test ids say so): the list's and the lookup's (the issue side's own describe pins "Issue credit note"). */
  const cnButtons = () => within(tid('issued-payments')).queryAllByRole('button').filter((b) => (b.getAttribute('data-testid') ?? '').startsWith('issued-payments-credit-') && b.getAttribute('data-testid') !== 'issued-payments-credit-issue').map((b) => b.textContent);
  const ok200 = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  /** The next held request's answer: the fake decides it now, or `late` stands in for it (deciding nothing). */
  const releaseNext = async (server: Server, late?: Response) => {
    await waitFor(() => expect(server.held.length).toBeGreaterThan(0));
    server.held.shift()!.release(late);
    await flush();
  };
  /** `count` settled rows of another invoice, oldest first: the lookup's bulk (1,001 rows are 21 pages). */
  const bulk = (server: Server, count: number) => {
    for (let i = 0; i < count; i++) server.addCreditReg({ invoiceId: OTHER, number: 99, registeredAt: cnTime(i), state: 'released', settledAt: cnTime(i) });
  };
  /** The notes of `invoiceId` as the list serves them (issuedAt, then id). */
  const served = (server: Server, invoiceId: string) => [...(server.creditNotes.get(invoiceId) ?? [])].sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : a.issuedAt > b.issuedAt ? 1 : a.id < b.id ? -1 : 1));
  async function setup(o: { owner?: boolean; uid?: string; count?: number; storeId?: string; over?: (n: number) => Partial<Issued>; prepare?: (server: Server, made: Issued[]) => void } = {}) {
    const server = seeded();
    const storeId = o.storeId ?? STORE_1;
    const made = issueAt(server, storeId, o.count ?? 2, o.over);
    if (o.owner !== false) server.cnOwners.add('uid-a');
    o.prepare?.(server, made);
    const r = rig(server);
    let api: CreditReads | null = null;
    const page = render(<ServerIssuedInvoices {...r.props({ uid: o.uid ?? 'uid-a', creditReads: (x) => { api = x; } })} />);
    await showAndChoose(storeId);
    await listReady();
    return { server, made, r, page, api: (): CreditReads => api! };
  }
  async function open(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
  }
  async function close() {
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
  }

  it('P2-02. a non-owner (a manager; an owner without the credit-note keys alike) gets the lookup\'s 403, ONE fresh session check confirms it: hidden — no lookup text or control — and never asked again under this generation and token (another open, a focus, a tab return); the list stays readable, without names for the manager', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    for (const who of [{ uid: 'uid-m', owner: true }, { uid: 'uid-a', owner: false }]) {
      const { server, made } = await setup({ ...who, prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
      await open(1);
      await waitFor(() => expect(lookupPhase()).toBe('denied'));
      await cnReady();
      expect(gets(server, 'lookup'), who.uid).toEqual([lookupUrl()]);
      const at = server.sent.map((x) => x.url).indexOf(lookupUrl());
      expect(sentFrom(server, at + 1), who.uid).toContain(`GET ${TENANT_SESSION_PATHS.current}`); // the one fresh check
      expect(tid('issued-payments-credit-lookup-alert').textContent).toBe('');
      expect(lookupRows()).toBe(0);
      expect(cnButtons(), who.uid).toEqual([]);
      expect(screen.queryByTestId('issued-payments-credit-issue'), `${who.uid}: no Issue action (T-10)`).toBeNull();
      expect(items()).toHaveLength(2);
      expect(names(), who.uid).toEqual(who.uid === 'uid-m' ? [] : ['Issued by Ada Owner', 'Issued by Ada Owner']);
      await focusEvents();
      await close();
      await open(2);
      await cnReady();
      await settle();
      expect(gets(server, 'lookup'), `${who.uid}: not retried`).toEqual([lookupUrl()]);
      expect(lookupPhase()).toBe('denied');
      expect(gets(server, 'list').filter((u) => u === cnUrl(made[1].id))).toEqual([cnUrl(made[1].id)]);
      cleanup();
    }
  });

  it('P2-03. a read-only (or overdue) store: the lookup is 403 (no recover key) — hidden, no lookup control, so no action, Look up attempt or Continue checking; the list stays readable with its paging, and its Try again resumes from the page that failed', async () => {
    const { server, made } = await setup({ storeId: STORE_RO, prepare: (s, m) => { s.addCreditNotes(m[0].id, 52); } });
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('denied'));
    await settle();
    await cnReady();
    expect(items()).toHaveLength(50);
    expect(cnButtons()).toEqual([CREDIT_TEXT.showMore]);
    server.cnScripts.list.push(503);
    await click('issued-payments-credit-more');
    await waitFor(() => expect(cnPhase()).toBe('failed'));
    // The rows stay, never as complete: the failure is said, Show more goes, Try again resumes.
    expect(items()).toHaveLength(50);
    expect(tid('issued-payments-credit-state')).toHaveTextContent(CREDIT_TEXT.listFailed);
    expect(cnButtons()).toEqual([CREDIT_TEXT.tryAgain]);
    const from = gets(server, 'list').length;
    await click('issued-payments-credit-retry');
    await cnReady();
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id, served(server, made[0].id)[49].id, STORE_RO)]);
    expect(items()).toHaveLength(52);
    expect(cnButtons()).toEqual([]);
    expect(server.cnRequests().filter((x) => x.method !== 'GET')).toEqual([]);
  });

  it('P2-04. a voided invoice still shows its credit notes (D-P2-12) — withdrawn ones with "Withdrawn {time}" and the withdrawal reason — and its Payments still never says "Invoice total", "Credited" or "$0.00"', async () => {
    const { made } = await setup({
      over: (n) => (n === 2 ? { void: { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' } } : {}),
      prepare: (s, m) => { s.addCreditNotes(m[1].id, 2, (i) => ({ withdrawal: { withdrawnAt: cnTime(500 + i), reason: i === 0 ? 'wrong_amount' : 'entered_in_error', withdrawnByName: null } })); },
    });
    await open(2);
    await cnReady();
    expect(made[1].void).toBeDefined();
    expect(items()).toHaveLength(2);
    expect(screen.getAllByTestId('issued-payments-credit-status').map((x) => x.textContent)).toEqual([CREDIT_TEXT.withdrawn, CREDIT_TEXT.withdrawn]);
    expect(screen.getAllByTestId('issued-payments-credit-withdrawn-at')[0]).toHaveAttribute('datetime', cnTime(500));
    expect(screen.getAllByTestId('issued-payments-credit-withdrawal-reason').map((x) => x.textContent)).toEqual(['Wrong amount', 'Entered by mistake']);
    expect(screen.getAllByTestId('issued-payments-credit-withdrawn-by').map((x) => x.textContent)).toEqual(['Withdrawn by Name not set', 'Withdrawn by Name not set']);
    expect(tid('issued-payments').textContent).not.toMatch(/invoice total|credited|\$0\.00/i);
  });

  it('P2-07. the lookup: hidden from its start until read to the end; a malformed page → lookupFailed with Try again (a new lookup from page one); a 503 mid-scan → lookupIncomplete with Continue checking, the rows found so far kept, resumed from the last good cursor; a confirmed 403 drops the rows and their actions; a 401 signs the section out', async () => {
    const { server, made, api } = await setup({
      prepare: (s, m) => {
        s.addCreditReg({ invoiceId: m[0].id, registeredAt: cnTime(0), state: 'open' });
        bulk(s, 55);
      },
    });
    server.hold.cnLookup = 1;
    await open(1);
    await cnReady();
    expect(lookupPhase()).toBe('loading'); // hidden from the lookup's start
    await releaseNext(server);
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(lookupRows()).toBe(1);
    expect(tid('issued-payments-credit-lookup-alert').textContent).toBe('');
    // A malformed page: lookupFailed (nothing claimed), Try again starts over from page one.
    server.cnScripts.lookup.push(ok200({ attempts: 'none', nextCursor: null }));
    act(() => { api().lookup(STORE_1, made[0].id); });
    await waitFor(() => expect(lookupPhase()).toBe('failed'));
    expect(tid('issued-payments-credit-lookup-alert')).toHaveTextContent(CREDIT_TEXT.lookupFailed);
    expect(lookupRows()).toBe(0);
    expect(cnButtons()).toEqual([CREDIT_TEXT.tryAgain]);
    expect(describedBy('issued-payments-credit-lookup-retry')).toContain(CREDIT_TEXT.lookupFailed);
    const from = gets(server, 'lookup').length;
    await click('issued-payments-credit-lookup-retry');
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(gets(server, 'lookup', from)).toEqual([lookupUrl(), lookupUrl(`${OTHER}.${server.cnRegs[49].attemptId}`)]);
    expect(document.activeElement).toBe(document.getElementById('issued-payments-title')); // the pressed control went: the Payments heading
    // A 503 on page two: incomplete, the rows of page one kept; Continue checking resumes from page one's cursor.
    server.hold.cnLookup = 2;
    act(() => { api().lookup(STORE_1, made[0].id); });
    await releaseNext(server);
    await releaseNext(server, chain(503, 'service_unavailable'));
    await waitFor(() => expect(lookupPhase()).toBe('incomplete'));
    expect(tid('issued-payments-credit-lookup-alert')).toHaveTextContent(CREDIT_TEXT.lookupIncomplete);
    expect(lookupRows()).toBe(1);
    const resume = gets(server, 'lookup').length;
    await click('issued-payments-credit-lookup-continue');
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(gets(server, 'lookup', resume)).toEqual([lookupUrl(`${OTHER}.${server.cnRegs[49].attemptId}`)]);
    expect(lookupRows()).toBe(1);
    // A 403 the one check confirms with the same token: the rows and their actions go; nothing is asked again here.
    server.cnScripts.lookup.push(403);
    act(() => { api().lookup(STORE_1, made[0].id); });
    await waitFor(() => expect(lookupPhase()).toBe('denied'));
    expect(lookupRows()).toBe(0);
    expect(cnButtons()).toEqual([]);
    // A 401: the section signs out (Reconnect), every credit-note row with it.
    await close();
    server.cnScripts.list.push(401);
    await user().click(openButton(2));
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-view')).toBeNull();
    expect(server.cnRequests().filter((x) => x.method !== 'GET')).toEqual([]);
  });

  it('P2-76. over 20 pages: 1,001 rows stop the first batch at 20 pages (lookupIncomplete, Continue checking) and Continue checking ends it from the last good cursor; 2,001 need two continuations; ONE cursor-400 restart per lookup generation (a second → lookupFailed); a context change between presses restarts at page one', async () => {
    const one = await setup({ prepare: (s) => bulk(s, 1001) });
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('incomplete'), { timeout: 10_000 });
    expect(gets(one.server, 'lookup')).toHaveLength(20);
    expect(gets(one.server, 'lookup')[0]).toBe(lookupUrl());
    expect(tid('issued-payments-credit-lookup-alert')).toHaveTextContent(CREDIT_TEXT.lookupIncomplete);
    await click('issued-payments-credit-lookup-continue');
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'), { timeout: 10_000 });
    expect(gets(one.server, 'lookup').slice(20)).toEqual([lookupUrl(`${OTHER}.${one.server.cnRegs[999].attemptId}`)]);
    expect(document.activeElement).toBe(document.getElementById('issued-payments-title'));
    // A context change between presses (another tab's sign-in, adopted on a tab return): the generation goes with the
    // dialog, and the next open's lookup starts at page one — the old cursor is never sent.
    await close();
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('incomplete'), { timeout: 10_000 });
    one.server.otherTab('uid-a');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await focusEvents();
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull(), { timeout: 10_000 });
    const before = gets(one.server, 'lookup').length;
    await showAndChoose(STORE_1);
    await listReady();
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('incomplete'), { timeout: 10_000 });
    expect(gets(one.server, 'lookup', before)[0]).toBe(lookupUrl());
    expect(gets(one.server, 'lookup', before)).toHaveLength(20);
    cleanup();
    vi.restoreAllMocks();

    const two = await setup({ prepare: (s) => bulk(s, 2001) });
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('incomplete'), { timeout: 10_000 });
    await click('issued-payments-credit-lookup-continue');
    await waitFor(() => expect(gets(two.server, 'lookup')).toHaveLength(40), { timeout: 10_000 });
    await waitFor(() => expect(lookupPhase()).toBe('incomplete'), { timeout: 10_000 });
    await click('issued-payments-credit-lookup-continue');
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'), { timeout: 10_000 });
    expect(gets(two.server, 'lookup')).toHaveLength(41);
    cleanup();

    // A cursor 400 restarts ONCE from page one (rows and counters discarded); a second in the same lookup generation fails.
    const four = await setup({ prepare: (s) => bulk(s, 120) });
    four.server.hold.cnLookup = 4;
    await open(1);
    await releaseNext(four.server);
    await releaseNext(four.server, chain(400, 'invalid_request'));
    await releaseNext(four.server);
    await releaseNext(four.server);
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'), { timeout: 10_000 });
    const c50 = `${OTHER}.${four.server.cnRegs[49].attemptId}`;
    expect(gets(four.server, 'lookup')).toEqual([lookupUrl(), lookupUrl(c50), lookupUrl(), lookupUrl(c50), lookupUrl(`${OTHER}.${four.server.cnRegs[99].attemptId}`)]);
    four.server.hold.cnLookup = 4;
    act(() => { four.api().lookup(STORE_1, four.made[0].id); });
    await releaseNext(four.server);
    await releaseNext(four.server, chain(400, 'invalid_request'));
    await releaseNext(four.server);
    await releaseNext(four.server, chain(400, 'invalid_request'));
    await waitFor(() => expect(lookupPhase()).toBe('failed'), { timeout: 10_000 });
    expect(tid('issued-payments-credit-lookup-alert')).toHaveTextContent(CREDIT_TEXT.lookupFailed);
  });

  it('P2-76 (session first, doc 17 §3.6 rule 1). every lookup send — page one, page two, and the first send after a cursor-400 restart — leaves only after its own session read', async () => {
    const { server } = await setup({ prepare: (s) => bulk(s, 120) });
    server.hold.cnLookup = 4;
    await open(1);
    server.hold.current = 1; // the session read before page two
    await releaseNext(server);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(gets(server, 'lookup')).toEqual([lookupUrl()]); // page two waits for its session read: not sent while it is held
    await releaseNext(server);
    await releaseNext(server, chain(400, 'invalid_request'));
    await releaseNext(server);
    await releaseNext(server);
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'), { timeout: 10_000 });
    // The session reads and lookup sends in the order they left; each lookup send must follow a session read of its own.
    const trail = server.sent.filter((r) => r.method === 'GET' && (r.url === '/api/v1/session' || r.url.startsWith(lookupUrl())))
      .map((r) => (r.url === '/api/v1/session' ? 'session' : r.url));
    const sends = trail.flatMap((u, i) => (u === 'session' ? [] : [[trail[i - 1], u]]));
    const c50 = `${OTHER}.${server.cnRegs[49].attemptId}`;
    expect(sends).toEqual([lookupUrl(), lookupUrl(c50), lookupUrl(), lookupUrl(c50), lookupUrl(`${OTHER}.${server.cnRegs[99].attemptId}`)].map((u) => ['session', u]));
  });

  it('P2-76 (repeat). a page that repeats an attempt the scan already loaded — even after the last one in order — fails the lookup (lookupFailed, its rows dropped); Try again starts over from page one', async () => {
    const { server } = await setup({ prepare: (s) => bulk(s, 60) });
    server.hold.cnLookup = 2;
    await open(1);
    await releaseNext(server);
    const again = server.cnRegs[0];
    await releaseNext(server, ok200({
      attempts: [{ invoiceId: again.invoiceId, invoiceNumber: 99, attemptId: again.attemptId, state: 'released', version: 3, registeredAt: cnTime(60), settledAt: cnTime(60), grossCents: 100, reason: 'goodwill', creditNote: null }],
      nextCursor: null,
    }));
    await waitFor(() => expect(lookupPhase()).toBe('failed'), { timeout: 10_000 });
    expect(tid('issued-payments-credit-lookup-alert')).toHaveTextContent(CREDIT_TEXT.lookupFailed);
    const from = gets(server, 'lookup').length;
    await click('issued-payments-credit-lookup-retry');
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'), { timeout: 10_000 });
    expect(gets(server, 'lookup', from)).toEqual([lookupUrl(), lookupUrl(`${OTHER}.${server.cnRegs[49].attemptId}`)]);
  });

  it('P2-64. the lookup decides nothing: an exhausted read with no row of this invoice only opens the gate; incomplete and failed texts claim nothing about any credit note; a page that answers after a context change (another tab\'s sign-in adopted meanwhile) is dropped, and the next open starts at page one', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    for (const said of [CREDIT_TEXT.lookupFailed, CREDIT_TEXT.lookupIncomplete]) expect(said).not.toMatch(/no credit note|not issued|was(n't| not) issued|issued/i);
    const { server, made } = await setup({ prepare: (s, m) => { bulk(s, 60); s.addCreditReg({ invoiceId: m[0].id, state: 'open' }); } });
    await open(2);
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(lookupRows()).toBe(0); // invoice 2 has no row: the gate opens, nothing more is said
    expect(tid('issued-payments-credit-lookup-alert').textContent).toBe('');
    await close();
    server.hold.cnLookup = 2;
    await open(1);
    await releaseNext(server);
    await waitFor(() => expect(server.held).toHaveLength(1)); // page two out
    server.otherTab('uid-a');
    await focusEvents(); // this tab adopts the new token: a new generation closes the dialog
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await releaseNext(server); // the old session's page two answers late: nothing takes it
    await settle();
    const before = gets(server, 'lookup').length;
    await showAndChoose(STORE_1);
    await listReady();
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(gets(server, 'lookup', before)).toEqual([lookupUrl(), lookupUrl(`${OTHER}.${server.cnRegs[49].attemptId}`)]);
    expect(lookupRows()).toBe(1); // only this generation's own pages
    expect(made).toHaveLength(2);
  });

  it('P2-45. each note in the server\'s order (oldest first) as one li of a ul under a level-4 "Credit notes" heading (Payments is level 3): "CN-<n>", "Active" or "Withdrawn" as words, the gross amount, the reason\'s label, "Issued {time}" in a time element; a withdrawal\'s "Withdrawn {time}" and its reason\'s label; tax and net never shown', async () => {
    const reasons = Object.keys(INVOICE_CREDIT_NOTE_REASONS);
    const why = Object.keys(INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS);
    const { made } = await setup({
      prepare: (s, m) => {
        s.addCreditNotes(m[0].id, 1, () => ({ grossCents: 2500, taxCents: 203, netCents: 2297 }), 50); // CN-1, issued last
        s.addCreditNotes(m[0].id, 4, (i) => ({
          reason: reasons[i], grossCents: 1000 + i, taxCents: 89, netCents: 911 + i,
          withdrawal: i < 3 ? { withdrawnAt: cnTime(600 + i), reason: why[i], withdrawnByName: 'Ada Owner' } : null,
        }));
      },
    });
    await open(1);
    await cnReady();
    const title = within(tid('issued-payments')).getByRole('heading', { level: 4, name: CREDIT_TEXT.listTitle });
    expect(title).toBe(tid('issued-payments-credit-title'));
    expect(document.getElementById('issued-payments-title').tagName).toBe('H3');
    const list = within(tid('issued-payments')).getByRole('list', { name: CREDIT_TEXT.listTitle });
    expect(list.tagName).toBe('UL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(numbers()).toEqual(['CN-2', 'CN-3', 'CN-4', 'CN-5', 'CN-1']);
    expect(items()[0].textContent).toBe('CN-2 · Withdrawn · $10.00 · Pricing errorIssued 2026-11-01 00:00:00 UTCWithdrawn 2026-11-01 00:10:00 UTC · Entered by mistakeIssued by Ada OwnerWithdrawn by Ada Owner');
    expect(items()[3].textContent).toBe('CN-5 · Active · $10.03 · Billing errorIssued 2026-11-01 00:00:03 UTCIssued by Ada Owner');
    expect(screen.getAllByTestId('issued-payments-credit-reason').map((x) => x.textContent)).toEqual(['Pricing error', 'Service issue', 'Goodwill', 'Billing error', 'Goodwill']);
    expect(screen.getAllByTestId('issued-payments-credit-withdrawal-reason').map((x) => x.textContent)).toEqual(['Entered by mistake', 'Wrong amount', 'Wrong invoice']);
    expect(screen.getAllByTestId('issued-payments-credit-status').map((x) => x.textContent)).toEqual(['Withdrawn', 'Withdrawn', 'Withdrawn', 'Active', 'Active']);
    const times = screen.getAllByTestId('issued-payments-credit-issued-at');
    expect(times[0].tagName).toBe('TIME');
    expect(times[0]).toHaveAttribute('datetime', cnTime(0));
    expect(screen.getAllByTestId('issued-payments-credit-withdrawn-at')[2]).toHaveAttribute('datetime', cnTime(602));
    for (const amount of screen.getAllByTestId('issued-payments-credit-amount')) expect(amount).toHaveClass('whitespace-nowrap');
    expect(list.textContent).not.toMatch(/\$0\.89|\$9\.1[1-4]|\$2\.03|\$22\.97|tax|net/i); // no tax or net (D-P2-7)
    expect(made).toHaveLength(2);
  });

  it('P2-56. names: the owner\'s page carries them — "Issued by {name}", "Withdrawn by {name}", null as "Name not set" (wrapping anywhere) — and a manager\'s page carries none, so nothing is shown', async () => {
    const seed = (s: Server, m: Issued[]) => {
      s.addCreditNotes(m[0].id, 1, () => ({ issuedByName: 'Ada Owner', withdrawal: { withdrawnAt: cnTime(700), reason: 'wrong_invoice', withdrawnByName: null } }));
      s.addCreditNotes(m[0].id, 1, () => ({ issuedByName: null }), 1);
    };
    await setup({ prepare: seed });
    await open(1);
    await cnReady();
    expect(names()).toEqual(['Issued by Ada Owner', 'Issued by Name not set']);
    expect(screen.getAllByTestId('issued-payments-credit-withdrawn-by').map((x) => x.textContent)).toEqual(['Withdrawn by Name not set']);
    for (const el of [...screen.getAllByTestId('issued-payments-credit-issued-by'), ...screen.getAllByTestId('issued-payments-credit-withdrawn-by')]) expect(el).toHaveClass('[overflow-wrap:anywhere]');
    cleanup();
    await setup({ uid: 'uid-m', prepare: seed });
    await open(1);
    await cnReady();
    expect(items()).toHaveLength(2);
    expect(names()).toEqual([]);
    expect(screen.queryAllByTestId('issued-payments-credit-withdrawn-by')).toEqual([]);
    expect(tid('issued-payments-credit-list').textContent).not.toMatch(/Issued by|Withdrawn by|Name not set/);
  });

  it('P2-55. Show more keeps focus and says "{n} more loaded."; when it goes, focus moves to the first new item (tabindex -1 until it blurs) — or to the list\'s heading when nothing new loaded', async () => {
    const { server, made } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 101); s.addCreditNotes(m[1].id, 51); } });
    await open(1);
    await cnReady();
    expect(items()).toHaveLength(50);
    const more = tid('issued-payments-credit-more');
    await user().click(more);
    await waitFor(() => expect(items()).toHaveLength(100));
    expect(tid('issued-payments-credit-more')).toBe(more);
    expect(document.activeElement).toBe(more);
    expect(tid('issued-payments-credit-state')).toHaveTextContent(/^50 more loaded\.$/);
    await user().click(more);
    await waitFor(() => expect(items()).toHaveLength(101));
    expect(screen.queryByTestId('issued-payments-credit-more')).toBeNull();
    const first = items()[100];
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first).toHaveAttribute('tabindex', '-1');
    expect(tid('issued-payments-credit-state')).toHaveTextContent(/^1 more loaded\.$/);
    act(() => { first.blur(); });
    await waitFor(() => expect(first).not.toHaveAttribute('tabindex'));
    expect(gets(server, 'list')).toEqual([cnUrl(made[0].id), cnUrl(made[0].id, served(server, made[0].id)[49].id), cnUrl(made[0].id, served(server, made[0].id)[99].id)]);
    await close();
    // Nothing new: the 51st note is gone by the time Show more reads (an empty last page): focus to the list's heading.
    await open(2);
    await cnReady();
    server.creditNotes.set(made[1].id, served(server, made[1].id).slice(0, 50));
    await user().click(tid('issued-payments-credit-more'));
    await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-more')).toBeNull());
    expect(items()).toHaveLength(50);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-payments-credit-title')));
  });

  it('P2-57. the list\'s states: loading; empty — "No credit notes on this invoice." with "None have been issued yet." for the owner only, and only after a read to the end; an error ("Credit notes couldn\'t be loaded.") with Try again for a 503 (the name residual too), a 404 or a malformed page — no rows shown as complete', async () => {
    const { server, made } = await setup();
    server.hold.cnList = 1;
    await open(1);
    await waitFor(() => expect(cnPhase()).toBe('loading'));
    expect(tid('issued-payments-credit-state')).toHaveTextContent(CREDIT_TEXT.listLoading);
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(tid('issued-payments-credit-state').textContent).not.toMatch(/No credit notes/); // never before the read ends
    await releaseNext(server);
    await cnReady();
    expect(tid('issued-payments-credit-state').textContent).toBe(`${CREDIT_TEXT.listEmpty} ${CREDIT_TEXT.listEmptyOwner}`);
    expect(screen.queryByTestId('issued-payments-credit-list')).toBeNull();
    expect(cnButtons()).toEqual([]);
    await close();
    for (const failure of [503, 404, ok200({ invoice: { id: made[1].id }, creditNotes: [{ id: 'x' }], nextCursor: null })]) {
      server.cnScripts.list.push(failure);
      await open(2);
      await waitFor(() => expect(cnPhase()).toBe('failed'));
      expect(tid('issued-payments-credit-state').textContent, String(failure)).toBe(CREDIT_TEXT.listFailed);
      expect(items()).toEqual([]);
      expect(cnButtons()).toEqual([CREDIT_TEXT.tryAgain]);
      await click('issued-payments-credit-retry');
      await cnReady();
      await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
      expect(tid('issued-payments-credit-state').textContent).toBe(`${CREDIT_TEXT.listEmpty} ${CREDIT_TEXT.listEmptyOwner}`);
      await close();
    }
    cleanup();
    await setup({ uid: 'uid-m' });
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('denied'));
    await cnReady();
    expect(tid('issued-payments-credit-state').textContent).toBe(CREDIT_TEXT.listEmpty);
  });

  it('P2-58. the refresh the issue side calls after an issue (followed to its creditNote.id), a confirm, a release or a recovery settlement re-reads from page one — ONE page-one GET each, nothing else; the number shows only from the row whose id matches', async () => {
    const { server, made, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
    await open(1);
    await cnReady();
    const from = gets(server, 'list').length;
    const [issued] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    expect(api().numberOf(STORE_1, made[0].id, issued.id)).toBeNull();
    act(() => { api().refresh(STORE_1, made[0].id, issued.id); }); // after the issue's 201
    await waitFor(() => expect(items()).toHaveLength(3));
    await cnReady();
    expect(api().numberOf(STORE_1, made[0].id, issued.id)).toBe(issued.number);
    expect(numbers()[2]).toBe(`CN-${issued.number}`);
    for (const [i, after] of ['confirm', 'release', 'recovery settlement'].entries()) {
      act(() => { api().refresh(STORE_1, made[0].id, null); });
      await waitFor(() => expect(gets(server, 'list', from)).toHaveLength(i + 2));
      await cnReady();
      expect(items(), after).toHaveLength(3);
    }
    expect(gets(server, 'list', from)).toEqual(Array(4).fill(cnUrl(made[0].id)));
    expect(server.cnRequests().filter((x) => x.method !== 'GET')).toEqual([]);
    // A late refresh or lookup for another invoice while this dialog is open sends nothing and keeps this dialog's list.
    const sent = server.cnRequests().length;
    act(() => { api().refresh(STORE_1, made[1].id, null); api().lookup(STORE_1, made[1].id); });
    await settle();
    expect(server.cnRequests()).toHaveLength(sent);
    expect(items()).toHaveLength(3);
    expect(api().numberOf(STORE_1, made[0].id, issued.id)).toBe(issued.number);
  });

  it('P2-74. the new note on page two: the refresh follows nextCursor to the row whose id is creditNote.id (CN-<n> from that row only); page two failing leaves the number pending, and Try again resumes from page two', async () => {
    const { server, made, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); } });
    await open(1);
    await cnReady();
    const from = gets(server, 'list').length;
    const [first] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    act(() => { api().refresh(STORE_1, made[0].id, first.id); });
    await waitFor(() => expect(api().numberOf(STORE_1, made[0].id, first.id)).toBe(first.number));
    const page1Last = served(server, made[0].id)[49].id;
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id), cnUrl(made[0].id, page1Last)]);
    expect(numbers()).toContain(`CN-${first.number}`);
    // Page two fails: the number stays pending (null), the rows of page one stay, Try again resumes from page two.
    const [second] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    server.hold.cnList = 2;
    const mark = gets(server, 'list').length;
    act(() => { api().refresh(STORE_1, made[0].id, second.id); });
    await releaseNext(server);
    await releaseNext(server, chain(503, 'service_unavailable'));
    await waitFor(() => expect(cnPhase()).toBe('failed'));
    expect(api().numberOf(STORE_1, made[0].id, second.id)).toBeNull();
    expect(items()).toHaveLength(50);
    await click('issued-payments-credit-retry');
    await waitFor(() => expect(api().numberOf(STORE_1, made[0].id, second.id)).toBe(second.number));
    expect(gets(server, 'list', mark)).toEqual([cnUrl(made[0].id), cnUrl(made[0].id, page1Last), cnUrl(made[0].id, page1Last)]);
  });

  it('P2-75 (session first, doc 17 §3.6 rule 1). every list send the refresh makes on its own — page one, page two, page three — leaves only after its own session read', async () => {
    const { server, made, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 101); } });
    await open(1);
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    const [target] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    const all = served(server, made[0].id);
    const from = gets(server, 'list').length;
    const sentFrom = server.sent.length;
    server.hold.cnList = 1; // page one
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.hold.current = 1; // the session read before page two
    await releaseNext(server);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id)]); // page two waits for its session read: not sent while it is held
    await releaseNext(server);
    await waitFor(() => expect(api().numberOf(STORE_1, made[0].id, target.id)).toBe(target.number));
    // The session reads and list sends in the order they left; each list send must follow a session read of its own.
    const trail = server.sent.slice(sentFrom).filter((r) => r.method === 'GET' && (r.url === '/api/v1/session' || r.url.startsWith(cnUrl(made[0].id))))
      .map((r) => (r.url === '/api/v1/session' ? 'session' : r.url));
    const sends = trail.flatMap((u, i) => (u === 'session' ? [] : [[trail[i - 1], u]]));
    expect(sends).toEqual([cnUrl(made[0].id), cnUrl(made[0].id, all[49].id), cnUrl(made[0].id, all[99].id)].map((u) => ['session', u]));
    // A cursor 400 on page two restarts at page one: that first send after the restart waits for its own session read too.
    const again = gets(server, 'list').length;
    server.hold.cnList = 2; // page one, page two
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await releaseNext(server); // page one
    await waitFor(() => expect(server.held).toHaveLength(1)); // page two, out
    server.hold.current = 1; // the session read before the restart's page one
    await releaseNext(server, chain(400, 'invalid_request'));
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(gets(server, 'list', again)).toEqual([cnUrl(made[0].id), cnUrl(made[0].id, all[49].id)]); // not sent while it is held
    await releaseNext(server);
    await waitFor(() => expect(gets(server, 'list', again)).toEqual([cnUrl(made[0].id), cnUrl(made[0].id, all[49].id), cnUrl(made[0].id), cnUrl(made[0].id, all[49].id), cnUrl(made[0].id, all[99].id)]));
  });

  it('P2-81 (81.8). an automatic list page two across another page\'s sign-in: its session read finds the change first, so the old cursor never leaves and nothing of page one stays', async () => {
    const { server, made, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 101); } });
    await open(1);
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    const [target] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    const from = gets(server, 'list').length;
    server.hold.cnList = 1; // page one, out under this page's token
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-b'); // another owner signs in in this browser between the refresh's pages one and two
    const logins = server.logins().length;
    await releaseNext(server); // page one answers for the old session
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    // Before page two the chain's session read finds uid-b's session: this page signs its own user in again (a new token),
    // a new generation drops the credit-note state and the dialog, and page two never leaves with the old cursor.
    expect(server.logins()).toHaveLength(logins + 1);
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id)]);
    expect(api().numberOf(STORE_1, made[0].id, target.id)).toBeNull();
  });

  it('P2-75. three pages, one view: the refresh follows pages two and three on its own (three page GETs); a view change between pages drops every row and reloads from page one once (a second → the error state); a 403 on a page → the one check → the error state; a cursor 400 restarts once', async () => {
    const { server, made, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 101); } });
    await open(1);
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    const [target] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    const all = served(server, made[0].id);
    const p2 = cnUrl(made[0].id, all[49].id);
    const p3 = cnUrl(made[0].id, all[99].id);
    let from = gets(server, 'list').length;
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await waitFor(() => expect(api().numberOf(STORE_1, made[0].id, target.id)).toBe(target.number));
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id), p2, p3]);
    expect(names()).toHaveLength(102);
    // The owner's names vanish between pages one and two (a view change): every row goes, page one again ONCE, now
    // without names — and, the names being gone after a named view, the lookup's rows go too (rule 4).
    server.hold.cnList = 2;
    from = gets(server, 'list').length;
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await releaseNext(server); // page one, named
    server.cnNamesHidden.add('uid-a');
    await releaseNext(server); // page two, without names
    await waitFor(() => expect(api().numberOf(STORE_1, made[0].id, target.id)).toBe(target.number));
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id), p2, cnUrl(made[0].id), p2, p3]);
    expect(names()).toEqual([]);
    expect(lookupPhase()).toBe('denied');
    // A second change within one chain: the error state, no rows.
    server.cnNamesHidden.delete('uid-a');
    server.hold.cnList = 4;
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await releaseNext(server); // page one, named
    server.cnNamesHidden.add('uid-a');
    await releaseNext(server); // page two, without names: page one again
    server.cnNamesHidden.delete('uid-a');
    await releaseNext(server); // page one again, named
    server.cnNamesHidden.add('uid-a');
    await releaseNext(server); // page two, without names again
    await waitFor(() => expect(cnPhase()).toBe('failed'));
    expect(items()).toEqual([]);
    server.cnNamesHidden.delete('uid-a');
    // A 403 on page two: the one fresh check confirms the same token → the error (denied) state, no rows.
    server.hold.cnList = 2;
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await releaseNext(server);
    await releaseNext(server, chain(403, 'forbidden'));
    await waitFor(() => expect(cnPhase()).toBe('denied'));
    expect(tid('issued-payments-credit-state').textContent).toBe(CREDIT_TEXT.listFailed);
    expect(items()).toEqual([]);
    expect(cnButtons()).toEqual([CREDIT_TEXT.tryAgain]);
    // A cursor 400 on page two: page one again once, then on to the target.
    server.hold.cnList = 2;
    from = gets(server, 'list').length;
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await releaseNext(server);
    await releaseNext(server, chain(400, 'invalid_request'));
    await waitFor(() => expect(api().numberOf(STORE_1, made[0].id, target.id)).toBe(target.number));
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id), p2, cnUrl(made[0].id), p2, p3]);
  });

  it('P2-80. a target beyond 1,000 notes: the refresh stops after 20 pages with the number still pending; Show more continues the same target search from its cursor until that row loads', async () => {
    const { server, made, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 1000); } });
    await open(1);
    await cnReady();
    const [target] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    const from = gets(server, 'list').length;
    act(() => { api().refresh(STORE_1, made[0].id, target.id); });
    await waitFor(() => expect(gets(server, 'list', from)).toHaveLength(20), { timeout: 10_000 });
    await cnReady();
    expect(api().numberOf(STORE_1, made[0].id, target.id)).toBeNull();
    expect(items()).toHaveLength(1000);
    await click('issued-payments-credit-more');
    await waitFor(() => expect(api().numberOf(STORE_1, made[0].id, target.id)).toBe(target.number), { timeout: 10_000 });
    expect(gets(server, 'list', from)).toHaveLength(21);
    expect(gets(server, 'list', from)[20]).toBe(cnUrl(made[0].id, served(server, made[0].id)[999].id));
  });

  it('P2-81. owner → owner: another owner signs in in this browser between list pages one and two — this page\'s Show more re-reads the session, signs its own user in again (a new token), and the new generation drops every row and name with the dialog; the page-two GET never leaves; the next open reads from page one. A renewal that keeps the dialog (the void\'s sign-in) drops them too and reads page one and the lookup again', async () => {
    const { server, made } = await setup({ prepare: (s, m) => { s.staleLogins = true; s.addCreditNotes(m[0].id, 51); s.addCreditNotes(m[1].id, 51); } });
    await open(1);
    await cnReady();
    expect(names()).toHaveLength(50);
    server.otherTab('uid-b');
    await click('issued-payments-credit-more');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(screen.queryAllByTestId('issued-payments-credit-item')).toEqual([]);
    expect(gets(server, 'list').filter((x) => x.includes('?after='))).toEqual([]);
    await showAndChoose(STORE_1);
    await listReady();
    const from = gets(server, 'list').length;
    await open(1);
    await cnReady();
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id)]);
    await close();
    // The void's own sign-in renews the session and keeps the dialog: the credit notes read under the old token go and
    // page one and the lookup are read again under the new one (doc 17 §3.6 rule 3).
    await open(2); // this page's own plain sign-in is stale: the void answers step_up_required
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    await waitFor(() => expect(tid('issued-view-void')).toBeInTheDocument());
    await click('issued-view-void');
    await waitFor(() => expect(tid('issued-void-confirm')).toBeInTheDocument());
    await user().click(tid('issued-void-reason-wrong_customer'));
    await click('issued-void-send');
    await waitFor(() => expect(tid('issued-void-reauth-group')).toBeInTheDocument());
    const list = gets(server, 'list').length;
    const lookup = gets(server, 'lookup').length;
    type('issued-void-reauth-password', 'correct horse');
    await click('issued-void-reauth-confirm');
    await waitFor(() => expect(tid('issued-void-confirm-status')).toHaveTextContent(VOID_TEXT.renewed));
    await waitFor(() => expect(gets(server, 'list', list)).toEqual([cnUrl(made[1].id)]));
    await waitFor(() => expect(gets(server, 'lookup', lookup)).toEqual([lookupUrl()]));
    expect(server.cnRequests().filter((x) => x.method !== 'GET')).toEqual([]);
  });

  it('P2-81 (81.2). lookup page two across another page\'s sign-in joins nothing; read again from page one under the new token', async () => {
    const { server } = await setup({
      prepare: (s, m) => {
        s.addCreditReg({ invoiceId: m[0].id, registeredAt: cnTime(0), state: 'open' });
        bulk(s, 55);
      },
    });
    server.hold.cnLookup = 1;
    await open(1);
    await cnReady();
    await waitFor(() => expect(server.held).toHaveLength(1)); // the lookup's page one, out under this page's token
    const old = server.cnRequests('lookup')[0].headers.get('x-tmpos-session-csrf');
    server.otherTab('uid-b'); // another owner signs in in this browser between the lookup's pages one and two
    const logins = server.logins().length;
    await releaseNext(server); // page one answers for the old session
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(screen.queryByTestId('issued-payments-credit-lookup')).toBeNull();
    // Before page two the pager's session read finds uid-b's session: this page signs its own user in again (a new token)
    // and the dialog closes, so page two never leaves.
    expect(server.logins()).toHaveLength(logins + 1);
    expect(gets(server, 'lookup').filter((x) => x.includes('?after='))).toEqual([]);
    const before = gets(server, 'lookup').length;
    await showAndChoose(STORE_1);
    await listReady();
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(gets(server, 'lookup', before)).toEqual([lookupUrl(), lookupUrl(`${OTHER}.${server.cnRegs[49].attemptId}`)]);
    expect(server.cnRequests('lookup').slice(before).map((x) => x.headers.get('x-tmpos-session-csrf'))).not.toContain(old);
    expect(lookupRows()).toBe(1); // this invoice's one row, once
    expect(server.cnRequests().filter((x) => x.method !== 'GET')).toEqual([]);
  });

  it('P2-82. owner → non-owner: another user\'s section shows nothing of the owner\'s (their lookup 403 confirmed, their list without names); the same owner demoted with the same token keeps the names read so far until an answer shows the change — a list page without names after a named view, the lookup\'s 403 the one check confirms, or the list\'s own 403 — which drops every name and lookup row (the list reloads once in the new view, or shows its error state)', async () => {
    const { server, made, page, r, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); } });
    await open(1);
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(names()).toHaveLength(50);
    // The same owner demoted (same token): nothing has shown it yet, so the names read so far stay.
    server.cnOwners.delete('uid-a');
    server.cnNamesHidden.add('uid-a');
    await settle();
    expect(names()).toHaveLength(50);
    // Show more's page carries no names after a named view: every name goes, page one again once, and the lookup's rows go.
    let from = gets(server, 'list').length;
    await click('issued-payments-credit-more');
    await waitFor(() => expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id, served(server, made[0].id)[49].id), cnUrl(made[0].id)]));
    await cnReady();
    expect(items()).toHaveLength(50);
    expect(names()).toEqual([]);
    expect(lookupPhase()).toBe('denied');
    // The lookup's 403, confirmed with the same token, drops names read before it: the list reloads once in the new view.
    server.cnNamesHidden.delete('uid-a');
    act(() => { api().refresh(STORE_1, made[0].id, null); });
    await waitFor(() => expect(names()).toHaveLength(50));
    server.cnNamesHidden.add('uid-a');
    act(() => { api().lookup(STORE_1, made[0].id); }); // the view change hid the action but confirmed no 403: asked once more
    await waitFor(() => expect(gets(server, 'lookup')).toHaveLength(2));
    await waitFor(() => expect(names()).toEqual([])); // its 403 confirmed with the same token: the names go (one reload)
    act(() => { api().lookup(STORE_1, made[0].id); }); // confirmed now: never asked again under this generation and token
    await settle();
    expect(gets(server, 'lookup')).toHaveLength(2);
    await close();
    server.otherTab('uid-a'); // a new token: the lookup is asked again there
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await focusEvents();
    // The focus re-read adopts the new token (stores read again, the choice cleared) before a store is chosen: chosen earlier,
    // that adoption would clear the choice and no list would be read.
    await waitFor(() => expect(screen.queryByTestId('issued-connection-changed')).not.toBeNull());
    server.cnNamesHidden.delete('uid-a');
    await showAndChoose(STORE_1);
    await listReady();
    server.cnOwners.add('uid-a');
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    await cnReady();
    expect(names()).toHaveLength(50);
    server.cnOwners.delete('uid-a');
    server.cnNamesHidden.add('uid-a');
    from = gets(server, 'list').length;
    act(() => { api().lookup(STORE_1, made[0].id); });
    await waitFor(() => expect(lookupPhase()).toBe('denied'));
    await waitFor(() => expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id)]));
    await cnReady();
    expect(names()).toEqual([]);
    // The list's own 403, confirmed with the same token: its error state, no rows, no names.
    server.issuedDenied.add('uid-a');
    act(() => { api().refresh(STORE_1, made[0].id, null); });
    await waitFor(() => expect(cnPhase()).toBe('denied'));
    expect(items()).toEqual([]);
    server.issuedDenied.delete('uid-a');
    await close();
    // Another user (a manager) in this page: a new section, nothing of the owner's; their lookup 403 confirmed, no names.
    page.rerender(<ServerIssuedInvoices {...r.props({ uid: 'uid-m' })} />);
    expect(screen.queryAllByTestId('issued-payments-credit-item')).toEqual([]);
    await showAndChoose(STORE_1);
    await listReady();
    await open(1);
    await waitFor(() => expect(lookupPhase()).toBe('denied'));
    await cnReady();
    expect(items()).toHaveLength(50);
    expect(names()).toEqual([]);
  });

  it('P2-83. a session change while page two is out: the old session\'s 200 is taken (this tab had adopted nothing), then the next read drops everything; adopted first → the late page is stale; sent with the new cookie → 403 → the one check finds the new token → dropped, never an error; a 401 → the section signs out and Reconnect starts again from page one', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, made } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); } });
    const page2 = () => cnUrl(made[0].id, served(server, made[0].id)[49].id);
    const reopen = async () => { await showAndChoose(STORE_1); await listReady(); await open(1); await cnReady(); };
    // 1. The old session answers page two (no token adopted here meanwhile): it is taken; the next read drops it all.
    await open(1);
    await cnReady();
    server.hold.cnList = 1;
    await click('issued-payments-credit-more');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await releaseNext(server);
    await waitFor(() => expect(items()).toHaveLength(51));
    await focusEvents(); // the next read: the session check finds the new token
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(screen.queryAllByTestId('issued-payments-credit-item')).toEqual([]);
    // 2. This tab adopts the new token first: the late page two is stale (its dialog is gone; the next open reads page one).
    await reopen();
    server.hold.cnList = 1;
    await click('issued-payments-credit-more');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await focusEvents();
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await releaseNext(server);
    await settle();
    let from = gets(server, 'list').length;
    await reopen();
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id)]);
    expect(items()).toHaveLength(50);
    // 3. Page two leaves with the new cookie and the old token: 403 → the one fresh check → the new token → dropped.
    server.hold.current = 1;
    await click('issued-payments-credit-more'); // its session check is held: the old session answers it
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await releaseNext(server);
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(gets(server, 'list').at(-1)).toBe(page2());
    expect(screen.queryByTestId('issued-payments-credit-state')).toBeNull();
    // 4. A 401 on page two: the section signs out (holds detach); Reconnect, and the next open starts from page one.
    await reopen();
    server.cnScripts.list.push(401);
    await click('issued-payments-credit-more');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-view')).toBeNull();
    await click('issued-retry'); // Reconnect
    await storesReady();
    from = gets(server, 'list').length;
    const looked = gets(server, 'lookup').length;
    fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
    await listReady();
    await open(1);
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id)]);
    expect(gets(server, 'lookup', looked)).toEqual([lookupUrl()]);
  });

  it('Fix list 1, F11 (SEC-2). named → unnamed across a refresh from page one is rule 4\'s access loss: the lookup\'s rows go, and the page already in the new view is not read again', async () => {
    const { server, made, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 3); } });
    await open(1);
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    expect(names()).toHaveLength(3);
    server.cnNamesHidden.add('uid-a');
    const from = gets(server, 'list').length;
    act(() => { api().refresh(STORE_1, made[0].id, null); });
    await waitFor(() => expect(names()).toEqual([]));
    await cnReady();
    expect(lookupPhase()).toBe('denied');
    expect(items()).toHaveLength(3);
    expect(gets(server, 'list', from)).toEqual([cnUrl(made[0].id)]);
  });

  it('Fix list 2, H6 (I1). the slice\'s view outlives a refresh that fails: named → a failed refresh → a page without names is still rule 4\'s access loss', async () => {
    const { server, made, api } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 3); } });
    await open(1);
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('exhausted'));
    server.cnScripts.list.push(503);
    act(() => { api().refresh(STORE_1, made[0].id, null); });
    await waitFor(() => expect(cnPhase()).toBe('failed'));
    server.cnNamesHidden.add('uid-a');
    act(() => { api().refresh(STORE_1, made[0].id, null); });
    await cnReady();
    expect(names()).toEqual([]);
    expect(lookupPhase()).toBe('denied');
  });

  it('Fix list 1, F22 (SCN-02). the lookup\'s 403 confirmed while the first list read is still out: that read is not sent again — an unnamed page is kept (ONE list read); a named page is dropped and read once more in the new view (ONE reload)', async () => {
    for (const named of [false, true]) {
      // Unnamed: SCN-02's view without names; named: the owner's names on the read sent before the confirmed denial.
      const { server, made } = await setup({ owner: named, prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); if (named) s.cnScripts.lookup.push(403); else s.cnNamesHidden.add('uid-a'); } });
      server.hold.cnList = 2;
      await open(1);
      await waitFor(() => expect(lookupPhase(), String(named)).toBe('denied'));
      expect(gets(server, 'list'), String(named)).toEqual([cnUrl(made[0].id)]);
      await releaseNext(server); // the read sent before the denial: named or not
      if (named) {
        server.cnNamesHidden.add('uid-a'); // the reload answers in the view the server gives now
        await releaseNext(server);
      }
      await waitFor(() => expect(cnPhase(), String(named)).toBe('ready'));
      expect(gets(server, 'list'), String(named)).toEqual(named ? [cnUrl(made[0].id), cnUrl(made[0].id)] : [cnUrl(made[0].id)]);
      expect(items(), String(named)).toHaveLength(2);
      expect(names(), String(named)).toEqual([]);
      cleanup();
    }
  });

  it('P2-53, P2-51. the list\'s status region (role status) and the lookup\'s alert region (role alert) are in place, empty, before their first text, each one region; the heading is level 4 and the list a named list; Show more and Try again are buttons, aria-disabled (never disabled) with their reason while a read is out', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); } });
    server.cnScripts.lookup.push(ok200({ attempts: [], nextCursor: 'x' }));
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => { records.push(...list); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    server.hold.cnList = 1;
    await user().click(openButton(1));
    await waitFor(() => expect(server.held).toHaveLength(1));
    const state = tid('issued-payments-credit-state');
    expect(state).toHaveAttribute('role', 'status');
    expect(state).toHaveTextContent(CREDIT_TEXT.listLoading);
    const alert = tid('issued-payments-credit-lookup-alert');
    expect(alert).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(alert).toHaveTextContent(CREDIT_TEXT.lookupFailed));
    await flush();
    observer.disconnect();
    // A record whose target is the region (or its text) means the text came after the region: it was not inserted with it.
    for (const region of [state, alert]) expect(records.some((x) => x.target === region || x.target.parentNode === region)).toBe(true);
    expect(within(tid('issued-payments')).getAllByRole('status').filter((x) => x === state)).toHaveLength(1);
    await releaseNext(server);
    await cnReady();
    expect(tid('issued-payments-credit-state')).toBe(state);
    server.hold.cnList = 1;
    const more = tid('issued-payments-credit-more');
    await user().click(more);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(more).toHaveAttribute('aria-disabled', 'true');
    expect(more).not.toBeDisabled();
    expect(describedBy('issued-payments-credit-more')).toBe(CREDIT_TEXT.listLoading);
    await releaseNext(server);
    await waitFor(() => expect(items()).toHaveLength(51));
    const retry = tid('issued-payments-credit-lookup-retry');
    expect(retry.tagName).toBe('BUTTON');
    expect(retry).toHaveAttribute('aria-disabled', 'false');
    expect(within(tid('issued-payments')).getByRole('heading', { level: 4 })).toHaveTextContent(CREDIT_TEXT.listTitle);
    expect(within(tid('issued-payments')).getByRole('list', { name: CREDIT_TEXT.listTitle })).toBe(tid('issued-payments-credit-list'));
  });

  it('P2-60. the list and lookup strings are exactly the wording table\'s (doc 17 §2.7); none says paid, unpaid, refunded or refund; "withdraw" only for a credit note; no credit-note list or lookup control is named credit or withdraw', async () => {
    // The issue side's strings join this block; its own P2-60 pins the whole block exactly.
    expect({ ...CREDIT_TEXT, moreLoaded: CREDIT_TEXT.moreLoaded(3), number: CREDIT_TEXT.number(12) }).toMatchObject({
      listTitle: 'Credit notes', listEmpty: 'No credit notes on this invoice.', listEmptyOwner: 'None have been issued yet.', listLoading: 'Loading credit notes…',
      listFailed: "Credit notes couldn't be loaded.", tryAgain: 'Try again', showMore: 'Show more', moreLoaded: '3 more loaded.', number: 'CN-12',
      active: 'Active', withdrawn: 'Withdrawn', issuedAt: 'Issued', withdrawnAt: 'Withdrawn', issuedBy: 'Issued by', withdrawnBy: 'Withdrawn by', nameNotSet: 'Name not set',
      numberPending: 'The credit note number will show here when its row in the list loads.',
      lookupFailed: "We couldn't check for unfinished credit notes on this invoice, so issuing is off for now.",
      lookupIncomplete: "We haven't checked all your unfinished credit notes yet, so issuing is off for now.",
      continueChecking: 'Continue checking',
    });
    expect(INVOICE_CREDIT_NOTE_REASONS).toEqual({ pricing_error: 'Pricing error', service_issue: 'Service issue', goodwill: 'Goodwill', billing_error: 'Billing error' });
    expect(INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS).toEqual({ entered_in_error: 'Entered by mistake', wrong_amount: 'Wrong amount', wrong_invoice: 'Wrong invoice' });
    const strings = [...Object.values(CREDIT_TEXT).map((x) => (typeof x === 'function' ? (x as (...xs: unknown[]) => string)(2) : x)), ...Object.values(INVOICE_CREDIT_NOTE_REASONS), ...Object.values(INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS)];
    for (const said of strings) {
      expect(said).not.toMatch(/\b(un)?paid\b|refund/i);
      if (/withdraw/i.test(said)) expect(['Withdrawn', 'Withdrawn by']).toContain(said);
    }
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51, (i) => (i === 0 ? { withdrawal: { withdrawnAt: cnTime(800), reason: 'wrong_amount', withdrawnByName: 'Ada Owner' } } : {})); } });
    server.cnScripts.lookup.push(503);
    await open(1);
    await cnReady();
    await waitFor(() => expect(lookupPhase()).toBe('incomplete'));
    const section = tid('issued-payments');
    expect(cnButtons()).toEqual([CREDIT_TEXT.continueChecking, CREDIT_TEXT.showMore]);
    expect(within(section).queryAllByRole('button', { name: /credit|withdraw/i })).toEqual([]);
    expect(section.textContent).not.toMatch(/amount due|\b(un)?paid\b|refund/i);
  });
});

describe('Issued invoices — credit notes: issuing one (M7B-CREDITNOTES-CN-P2, the issue side)', { timeout: 30_000 }, () => {
  beforeEach(() => { madeServers.length = 0; });
  afterAll(() => { console.info(`P2-89 request-log checker: ${p289.tests} tests, ${p289.sends} first settlement sends`); });
  afterEach(afterEachP289); // fix list 5, C: the P2-89 request-log invariant over every settlement this describe sends
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const sealedAnswer = (error: string) => json(409, { error });
  const AT = (r: Rig) => utcText(new Date(r.clock.wall).toISOString());
  const action = () => screen.queryByTestId('issued-payments-credit-issue');
  const inlineSay = () => tid('issued-payments-credit-say').textContent;
  const inlineAlert = () => tid('issued-payments-credit-alert').textContent;
  const cardText = (prefix = 'issued-payments-credit-card') => screen.queryByTestId(`${prefix}-text`)?.textContent ?? null;
  const cardButtons = (prefix = 'issued-payments-credit-card') => (screen.queryByTestId(prefix) === null ? [] : within(tid(prefix)).queryAllByRole('button').map((b) => b.textContent));
  const rowStates = () => screen.queryAllByTestId('issued-payments-credit-row-state').map((x) => x.textContent);
  const posts = (server: Server, route: 'register' | 'issue' | 'settle') => server.cnRequests(route).map((x) => x.body);
  const held = (r: Rig) => r.cnHolds.get('uid-a');
  const releaseNext = async (server: Server, late?: Response) => {
    await until(() => expect(server.held.length).toBeGreaterThan(0));
    server.held.shift()!.release(late);
    await settle();
  };
  /** An owner at STORE_1 with the credit-note keys; `fetch` wraps the fake (the reversal eligibility, for P2-06). */
  async function setup(o: { count?: number; prepare?: (server: Server, made: Issued[]) => void; identity?: (r: Rig) => ShopIdentity; fetch?: (server: Server) => typeof globalThis.fetch } = {}) {
    const server = seeded();
    const made = issueAt(server, STORE_1, o.count ?? 2);
    server.cnOwners.add('uid-a');
    o.prepare?.(server, made);
    const r = rig(server);
    const over: Partial<ServerIssuedInvoicesProps> = {
      ...(o.identity === undefined ? {} : { identity: o.identity(r) }),
      ...(o.fetch === undefined ? {} : { issuing: createInvoiceIssuingClient({ fetch: o.fetch(server) }) }),
    };
    const page = render(<ServerIssuedInvoices {...r.props(over)} />);
    await showAndChoose(STORE_1);
    await listReady();
    return { server, made, r, page };
  }
  async function open(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
  }
  async function startForm(amount: string, reason: string | null) {
    await waitFor(() => expect(action()).not.toBeNull());
    await user().click(action()!);
    type('issued-payments-credit-form-amount', amount);
    if (reason !== null) fireEvent.click(tid(`issued-payments-credit-form-reason-${reason}`));
  }
  async function toConfirm(amount = '5.00', reason = 'goodwill') {
    await startForm(amount, reason);
    await click('issued-payments-credit-continue');
    await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).not.toBeNull());
  }
  /** "Issue credit note" without a shop sign-in → the sign-in group → the rig's password → signedIn. */
  async function signIn() {
    await click('issued-credit-send');
    await waitFor(() => expect(screen.queryByTestId('issued-credit-reauth-password')).not.toBeNull());
    type('issued-credit-reauth-password', 'correct horse');
    await click('issued-credit-reauth-confirm');
    await waitFor(() => expect(tid('issued-credit-confirm-status').textContent).toMatch(/^Signed in again at /));
  }
  /** Set up, open invoice 1, fill the form, review, sign in: the confirmation is open with a fresh shop sign-in. */
  async function ready(o: Parameters<typeof setup>[0] & { amount?: string; reason?: string } = {}) {
    const x = await setup(o);
    await open(1);
    await toConfirm(o.amount, o.reason);
    await signIn();
    return x;
  }
  const issuedText = CREDIT_TEXT.issued('$5.00', 'Goodwill');

  it('P2-01. the store-scope owner, an issued invoice, the lookup read to the end, no blocker: "Issue credit note" is shown and enabled, with no reason; a manager sees no action', async () => {
    const { page } = await setup();
    await open(1);
    await waitFor(() => expect(action()).not.toBeNull());
    expect(action()).toHaveTextContent(CREDIT_TEXT.action);
    expect(action()).toHaveAttribute('aria-disabled', 'false');
    expect(action()!.getAttribute('aria-describedby')).toBeNull();
    page.unmount();
    cleanup();
    const m = seeded();
    issueAt(m, STORE_1, 1);
    m.cnOwners.add('uid-m');
    render(<ServerIssuedInvoices {...rig(m).props({ uid: 'uid-m' })} />);
    await showAndChoose(STORE_1);
    await listReady();
    await open(1);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'denied'));
    expect(action()).toBeNull();
  });

  it('P2-05, P2-51. disabled with a reason (aria-disabled, the reason its aria-describedby): Remaining 0 → blockedRemaining; this owner\'s open row → blockedOwn; an attached payment attempt anywhere → blockedSibling; pressing does nothing', async () => {
    const { server, made, r } = await setup({ count: 3, prepare: (s, m) => { s.credits.set(m[0].id, 2176); s.addCreditReg({ invoiceId: m[1].id, number: 2 }); } });
    await open(1);
    await waitFor(() => expect(action()).not.toBeNull());
    expect(action()).toHaveAttribute('aria-disabled', 'true');
    expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedRemaining);
    await user().click(action()!);
    expect(screen.queryByTestId('issued-payments-credit-form')).toBeNull();
    await click('issued-view-close');
    await open(2);
    await waitFor(() => expect(action()).not.toBeNull());
    expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn);
    expect(rowStates()).toEqual([CREDIT_TEXT.rowOpen(AT(r))]);
    await click('issued-view-close');
    await open(3);
    await waitFor(() => expect(action()).toHaveAttribute('aria-disabled', 'false'));
    act(() => {
      r.payHolds.put('uid-a', {
        key: uuid(0x9001), storeId: STORE_1, tenantId: TENANT_A, invoiceId: made[0].id, number: 1, csrf: 'c', stage: 'register', stageKey: uuid(0x9002), body: '{}',
        sentAt: r.clock.mono, sentWall: r.clock.wall, lastSentAt: r.clock.mono, registrationId: null, proof: null, amountCents: 100, method: 'cash', payment: null,
        settleVersion: null, state: 'unresolved', say: '', retryAfter: 0, rereads: 0,
      } as HeldPayment);
    });
    expect(action()).toHaveAttribute('aria-disabled', 'true');
    expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedSibling);
    expect(server.cnRequests('register')).toEqual([]);
  });

  it('P2-06. coordination (D-P2-10 A): an open row or attempt here hides Record payment, Reverse and Void on this invoice; an attempt that can still be checked hides Void and Reverse on every invoice (Record stays there); the predicate is the exported one', async () => {
    const reversible = (server: Server) => (async (input: RequestInfo | URL, init: RequestInit = {}) => (
      String(input).endsWith('/payment-reversal-eligibility') ? json(200, { eligibility: 'allowed' }) : server.fetch(input, init)
    )) as typeof globalThis.fetch;
    const paid = (n: number) => ({ id: uuid(0x9100 + n), attemptId: uuid(0x9200 + n), amountCents: 100, method: 'cash', recordedAt: '2026-10-17T08:00:00.000001Z', reversal: null });
    const { server, made, r } = await setup({
      count: 3, fetch: reversible,
      prepare: (s, m) => { s.recorders.add('uid-a'); for (const i of [0, 1, 2]) s.payments.set(m[i].id, [paid(i)]); s.addCreditReg({ invoiceId: m[1].id, number: 2 }); },
    });
    const shown = () => ({ record: screen.queryByTestId('issued-payments-record') !== null, reverse: screen.queryAllByTestId('issued-payments-reverse').length > 0, void: screen.queryByTestId('issued-view-void') !== null });
    await open(3);
    await waitFor(() => expect(shown()).toEqual({ record: true, reverse: true, void: true }));
    await click('issued-view-close');
    await open(2);
    await waitFor(() => expect(rowStates()).toHaveLength(1));
    await settle();
    expect(shown()).toEqual({ record: false, reverse: false, void: false });
    await click('issued-view-close');
    // A register still out on invoice 1: Check-again-able (its window open) — Void and Reverse go everywhere.
    server.cnRegs.splice(0);
    server.hold.cnRegister = 1;
    await open(1);
    await toConfirm();
    await signIn();
    await click('issued-credit-send');
    await until(() => expect(server.held.length).toBe(1));
    expect(creditNoteHoldsSignIns(held(r), r.clock.mono, r.clock.wall)).toBe(true);
    expect(shown()).toEqual({ record: false, reverse: false, void: false });
    fireEvent.keyDown(tid('issued-credit-keep'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
    await click('issued-view-close');
    await click('issued-list-retry'); // the sign-in cleared the list read before it (LIST_TEXT.renewed)
    await listReady();
    await open(3);
    await waitFor(() => expect(shown().record).toBe(true));
    await settle();
    expect(shown()).toEqual({ record: true, reverse: false, void: false });
    void made;
  });

  it('P2-08, P2-51. form validation on Continue: each error text tied to its field (aria-invalid, aria-describedby = hint + error), ONE alert summary, the reasons a fieldset with its legend, focus on the first invalid control, nothing sent', async () => {
    const { server } = await setup();
    await open(1);
    await startForm('', null);
    expect(within(tid('issued-payments-credit-form')).getByRole('group', { name: CREDIT_TEXT.legend })).toBeInTheDocument();
    expect(within(tid('issued-payments-credit-form-reasons')).getByText(CREDIT_TEXT.reasonLegend).tagName).toBe('LEGEND');
    expect(within(tid('issued-payments-credit-form-reasons')).getAllByRole('radio').map((x) => x.parentElement?.textContent)).toEqual(Object.values(INVOICE_CREDIT_NOTE_REASONS));
    expect(tid('issued-payments-credit-form-amount-hint')).toHaveTextContent(CREDIT_TEXT.amountHint('$21.76'));
    expect(tid('issued-payments-credit-form-errors').textContent).toBe('');
    const cases: Array<[string, string]> = [['', CREDIT_TEXT.errFormat], ['$5', CREDIT_TEXT.errFormat], ['1,000', CREDIT_TEXT.errFormat], ['12.345', CREDIT_TEXT.errDecimals], ['0', CREDIT_TEXT.errZero], ['99.00', CREDIT_TEXT.errOver('$21.76')]];
    for (const [typed, said] of cases) {
      type('issued-payments-credit-form-amount', typed);
      await click('issued-payments-credit-continue');
      expect(tid('issued-payments-credit-form-amount-error').textContent, typed).toBe(said);
      expect(tid('issued-payments-credit-form-amount')).toHaveAttribute('aria-invalid', 'true');
      expect(describedBy('issued-payments-credit-form-amount')).toBe(`${CREDIT_TEXT.amountHint('$21.76')} ${said}`);
      expect(tid('issued-payments-credit-form-errors')).toHaveTextContent(CREDIT_TEXT.errSummary);
      expect(screen.getAllByRole('alert').filter((x) => x.textContent === CREDIT_TEXT.errSummary)).toHaveLength(1);
      await waitFor(() => expect(document.activeElement).toBe(tid('issued-payments-credit-form-amount')));
    }
    expect(tid('issued-payments-credit-form-reason-error').textContent).toBe(CREDIT_TEXT.errReason);
    expect(tid('issued-payments-credit-form-reasons')).toHaveAttribute('aria-invalid', 'true');
    type('issued-payments-credit-form-amount', '5.00');
    await click('issued-payments-credit-continue');
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-payments-credit-form-reason-pricing_error')));
    expect(screen.queryByTestId('issued-payments-credit-form-amount-error')).toBeNull();
    expect(screen.queryByTestId('issued-credit-confirm')).toBeNull();
    expect(server.writes()).toEqual([]);
  });

  it('P2-09. the review before the confirmation re-reads the invoice, the payments and the lookup: Remaining fell → errOver on the amount (focus there); voided → reviewVoided; the lookup failing or stopping → its own text; an own open row → unfinished — never a confirmation', async () => {
    const { server, made, r } = await setup();
    await open(1);
    await startForm('5.00', 'goodwill');
    server.credits.set(made[0].id, 2000);
    await click('issued-payments-credit-continue');
    await waitFor(() => expect(tid('issued-payments-credit-form-amount-error').textContent).toBe(CREDIT_TEXT.errOver('$1.76')));
    expect(document.activeElement).toBe(tid('issued-payments-credit-form-amount'));
    server.credits.delete(made[0].id);
    server.cnScripts.lookup.push(503);
    type('issued-payments-credit-form-amount', '1.00'); // within the remaining this page read last ($1.76); the review reads $21.76
    await click('issued-payments-credit-continue');
    await waitFor(() => expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'incomplete'));
    expect(tid('issued-payments-credit-lookup-alert')).toHaveTextContent(CREDIT_TEXT.lookupIncomplete);
    expect(screen.queryByTestId('issued-payments-credit-form')).toBeNull();
    await click('issued-payments-credit-lookup-continue');
    await waitFor(() => expect(action()).not.toBeNull());
    server.addCreditReg({ invoiceId: made[0].id });
    await startForm('5.00', 'goodwill');
    await click('issued-payments-credit-continue');
    await waitFor(() => expect(inlineAlert()).toBe(CREDIT_TEXT.unfinished));
    expect(rowStates()).toEqual([CREDIT_TEXT.rowOpen(AT(r))]);
    server.cnRegs.splice(0);
    await click('issued-view-close');
    await open(1);
    await startForm('5.00', 'goodwill');
    made[0].void = { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' };
    await click('issued-payments-credit-continue');
    await waitFor(() => expect(inlineAlert()).toBe(CREDIT_TEXT.reviewVoided));
    expect(screen.queryByTestId('issued-payments-credit-form')).toBeNull();
    expect(screen.queryByTestId('issued-credit-confirm')).toBeNull();
    expect(server.writes()).toEqual([]);
  });

  it('P2-10, P2-51. the confirmation: an alertdialog named by its title and described by the exact consequence, the facts the review read, "Don\'t issue" focused', async () => {
    await setup();
    await open(1);
    await toConfirm('5.00', 'service_issue');
    const dialog = screen.getByRole('alertdialog', { name: CREDIT_TEXT.title });
    expect(dialog).toHaveAccessibleDescription(CREDIT_TEXT.consequence('$5.00'));
    expect(tid('issued-credit-description').textContent).toBe('This creates a separate credit note and lowers what the customer owes on this invoice by $5.00. The issued invoice and its total stay the same. It moves no money and returns nothing to the customer. You can\'t undo it here.');
    expect([tid('issued-credit-number').textContent, tid('issued-credit-amount').textContent, tid('issued-credit-reason').textContent, tid('issued-credit-remaining').textContent]).toEqual(['1', '$5.00', 'Service issue', '$21.76']);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-credit-keep')));
    expect(tid('issued-credit-keep')).toHaveTextContent(CREDIT_TEXT.keep);
    expect(tid('issued-credit-send')).toHaveTextContent(CREDIT_TEXT.action);
    expect([tid('issued-credit-confirm-status').textContent, tid('issued-credit-confirm-alert').textContent]).toEqual(['', '']);
  });

  it('P2-11, P2-12. no shop sign-in ≤ 8 minutes → the sign-in group (signInNeeded; password autocomplete current-password, focused), nothing sent; after it the review re-runs, the values stay, signedIn gives the clock times, and only a NEW press sends', async () => {
    const { server, r } = await setup();
    await open(1);
    await toConfirm('5.00', 'goodwill');
    await click('issued-credit-send');
    await waitFor(() => expect(tid('issued-credit-confirm-alert').textContent).toBe(CREDIT_TEXT.signInNeeded));
    expect(tid('issued-credit-reauth-password')).toHaveAttribute('autocomplete', 'current-password');
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-credit-reauth-password')));
    expect(server.cnRequests('register')).toEqual([]);
    const from = server.sent.length;
    type('issued-credit-reauth-password', 'correct horse');
    await click('issued-credit-reauth-confirm');
    const at = AT(r);
    await waitFor(() => expect(tid('issued-credit-confirm-status').textContent).toBe(CREDIT_TEXT.signedIn(at, utcText(new Date(r.clock.wall + 8 * 60_000).toISOString()))));
    expect(CREDIT_TEXT.signedIn(at, '2026-10-16 12:08:00 UTC')).toBe('Signed in again at 2026-10-16 12:00:00 UTC. Check the details, then press Issue credit note below before 2026-10-16 12:08:00 UTC.');
    const reread = sentFrom(server, from).filter((x) => x.startsWith('GET /api/v1/stores/'));
    expect(reread.some((x) => /\/invoices\/[^/]+$/.test(x))).toBe(true);
    expect(reread.some((x) => x.endsWith('/payments'))).toBe(true);
    expect(reread.some((x) => x.endsWith('/credit-note-attempts'))).toBe(true);
    expect(reread.some((x) => x.endsWith('/credit-notes'))).toBe(true);
    expect([tid('issued-credit-amount').textContent, tid('issued-credit-reason').textContent]).toEqual(['$5.00', 'Goodwill']);
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-credit-keep')));
    expect(server.cnRequests('register')).toEqual([]);
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(issuedText));
    expect(server.cnRequests('register')).toHaveLength(1);
  });

  it('P2-13. the sign-in wait: bounded at 30 s (signInTimeout, nothing sent); Stop waiting and Escape end the wait at once', async () => {
    const pending: Array<() => void> = [];
    const { server } = await setup({ identity: (r) => ({ idToken: async () => 'tok-a', reauthMethod: () => 'password', reauthenticate: (uid, pw) => new Promise((done) => { r.reauth.push(pw); pending.push(() => done('tok-a')); }) }) });
    await open(1);
    await toConfirm();
    await click('issued-credit-send');
    await waitFor(() => expect(screen.queryByTestId('issued-credit-reauth-password')).not.toBeNull());
    type('issued-credit-reauth-password', 'correct horse');
    fakeClock();
    fireEvent.click(tid('issued-credit-reauth-confirm'));
    await flush();
    expect(tid('issued-credit-reauth-stop')).toHaveTextContent(VOID_TEXT.stopWaiting);
    await advance(30_000);
    await until(() => expect(tid('issued-credit-confirm-alert').textContent).toBe(CREDIT_TEXT.signInTimeout));
    vi.useRealTimers();
    type('issued-credit-reauth-password', 'correct horse');
    await click('issued-credit-reauth-confirm');
    await click('issued-credit-reauth-stop');
    await waitFor(() => expect(screen.queryByTestId('issued-credit-reauth-stop')).toBeNull());
    expect(tid('issued-credit-confirm-alert').textContent).toBe('');
    type('issued-credit-reauth-password', 'correct horse');
    await click('issued-credit-reauth-confirm');
    fireEvent.keyDown(tid('issued-credit-reauth-password'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
    for (const late of pending) late();
    await settle();
    expect(screen.queryByTestId('issued-credit-confirm')).toBeNull();
    expect(server.cnRequests('register')).toEqual([]);
  });

  it('P2-14. a slow reader: the 8 minutes pass before the press → signInExpired with the old time, the values still shown; one more sign-in continues', async () => {
    const { server, r } = await ready();
    const first = AT(r);
    r.clock.mono += 8 * 60_000 + 1_000;
    r.clock.wall += 8 * 60_000 + 1_000;
    await click('issued-credit-send');
    await waitFor(() => expect(tid('issued-credit-confirm-alert').textContent).toBe(CREDIT_TEXT.signInExpired(first)));
    expect([tid('issued-credit-amount').textContent, tid('issued-credit-reason').textContent]).toEqual(['$5.00', 'Goodwill']);
    expect(server.cnRequests('register')).toEqual([]);
    type('issued-credit-reauth-password', 'correct horse');
    await click('issued-credit-reauth-confirm');
    await waitFor(() => expect(tid('issued-credit-confirm-status').textContent).toMatch(/^Signed in again at /));
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(issuedText));
    expect(server.cnRequests('register')).toHaveLength(1);
  });

  it('P2-15, P2-53. one press: ONE register, ONE proof, ONE issue, each held (stage, key, exact bytes, the registration id once known) before it leaves; one "sending" for the whole chain; the dialog\'s own pair while it is open, the section pair quiet while the dialog says it inline', async () => {
    const { server, made, r } = await ready();
    expect([tid('issued-credit-status').textContent, tid('issued-credit-alert').textContent, inlineSay(), inlineAlert()]).toEqual(['', '', '', '']);
    server.hold.cnRegister = 1;
    server.hold.cnProof = 1;
    server.hold.cnIssue = 1;
    await click('issued-credit-send');
    await until(() => expect(server.held.length).toBe(1));
    const [attemptId, regKey] = r.keys;
    const reg = server.cnRequests('register');
    expect(reg).toHaveLength(1);
    expect(reg[0].headers.get('idempotency-key')).toBe(regKey);
    expect(reg[0].body).toBe(creditNoteRegisterBodyOf(TENANT_A, attemptId, 500, 'goodwill'));
    expect(held(r)).toMatchObject({ attemptId, stage: 'register', state: 'registering', register: { key: regKey, body: reg[0].body }, registrationId: null });
    expect(tid('issued-credit-confirm-status').textContent).toBe(CREDIT_TEXT.sending);
    expect(tid('issued-credit-keep')).toHaveTextContent(CREDIT_TEXT.close);
    expect(describedBy('issued-credit-keep')).toBe(CREDIT_TEXT.closeWarning);
    // Fix list 1 (F17): the page behind is inert while the confirmation is open — only its own pair says sending.
    expect([inlineSay(), tid('issued-credit-status').textContent]).toEqual(['', '']);
    await releaseNext(server);
    await until(() => expect(server.held.length).toBe(1));
    const g = server.cnRegs.find((x) => x.attemptId === attemptId)!;
    expect(held(r)).toMatchObject({ stage: 'proof', state: 'registered', registrationId: g.id });
    expect(server.cnRequests('proof').map((x) => x.url)).toEqual([`${STORES_PATH}/${STORE_1}/invoices/${made[0].id}/credit-note-registration-proof?registration=${g.id}`]);
    expect([inlineSay(), tid('issued-credit-confirm-status').textContent]).toEqual(['', CREDIT_TEXT.sending]);
    await releaseNext(server);
    await until(() => expect(server.held.length).toBe(1));
    const iss = server.cnRequests('issue');
    expect(iss).toHaveLength(1);
    expect(iss[0].headers.get('idempotency-key')).toBe(r.keys[2]);
    // T-14: the bytes carry a proof — compared, never printed on a failure.
    expect(iss[0].body === creditNoteIssueBodyOf({ expectedTenant: TENANT_A, registrationId: g.id, attemptId, grossCents: 500, reason: 'goodwill', registrationProof: g.proof }), 'the issue\'s exact bytes').toBe(true);
    expect(held(r)).toMatchObject({ stage: 'issue', state: 'issuing', issue: { key: r.keys[2] } });
    expect(held(r)?.issue?.body === iss[0].body, 'the held issue bytes are the sent ones').toBe(true);
    await releaseNext(server);
    await waitFor(() => expect(inlineSay()).toBe(issuedText));
    expect([server.cnRequests('register'), server.cnRequests('proof'), server.cnRequests('issue')].map((x) => x.length)).toEqual([1, 1, 1]);
    expect(server.cnBodyViolations).toEqual([]);
    expect(tid('issued-credit-status').textContent).toBe('');
    expect(screen.queryByTestId('issued-credit-confirm')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(tid('issued-payments-credit-card-heading')));
  });

  it('P2-16, P2-89. issued: the card says issued, issuedHint and confirmHint with "Confirm credit note"; the payments and the list are read again and CN-<n> comes from the matching row; Confirm (version 2, a new key, no lookup needed) → confirmed, read again; the action comes back', async () => {
    const { server, made, r } = await ready({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 1, () => ({ issuedAt: cnTime(1) })); } });
    const payReads = server.paymentReads().length;
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(issuedText));
    expect(tid('issued-payments-credit-card-hint').textContent).toBe(CREDIT_TEXT.issuedHint);
    expect(describedBy('issued-payments-credit-card-confirm')).toBe(CREDIT_TEXT.confirmHint);
    await waitFor(() => expect(tid('issued-payments-credit-card-number').textContent).toBe('CN-2'));
    await waitFor(() => expect(tid('issued-payments-credited')).toHaveTextContent('$5.00'));
    expect(server.paymentReads().length).toBeGreaterThan(payReads);
    expect(cardButtons()).toEqual([CREDIT_TEXT.confirm]);
    expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn);
    const lookups = server.cnRequests('lookup').length;
    const lists = server.cnRequests('list').length;
    await click('issued-payments-credit-card-confirm');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
    const settle1 = server.cnRequests('settle');
    expect(settle1).toHaveLength(1);
    expect(settle1[0].body).toBe(settleBodyOf(TENANT_A, r.keys[0], 2));
    expect(settle1[0].headers.get('idempotency-key')).toBe(r.keys[3]);
    // E: the lookup is sent after its own session read — awaited as the state it is, not assumed sent with the card's line.
    await waitFor(() => expect(server.cnRequests('lookup').length).toBeGreaterThan(lookups)); // read after the 200 (not before: the post-201 Confirm needs none)
    expect(server.sent.findIndex((x) => x === settle1[0])).toBeLessThan(server.sent.findIndex((x, i) => i > server.sent.indexOf(settle1[0]) && x.url.endsWith('/credit-note-attempts')));
    await waitFor(() => expect(server.cnRequests('list').length).toBeGreaterThan(lists));
    expect(cardButtons()).toEqual([]);
    await waitFor(() => expect(action()).toHaveAttribute('aria-disabled', 'false'));
    expect(creditNamedOutside(tid('issued-payments'))).toEqual([]);
    void made;
  });

  it('P2-17, P2-89. sealed amount_exceeds_remaining → overRemaining, the amounts read again, "Look up attempt" (no Release on the card) → the open row → "Release attempt" (releaseHint) → released; the action comes back; the release followed a lookup read of this generation and token', async () => {
    const { server, made } = await ready();
    server.credits.set(made[0].id, 2000);
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.overRemaining));
    expect(inlineAlert()).toBe(CREDIT_TEXT.overRemaining);
    await waitFor(() => expect(tid('issued-payments-remaining')).toHaveTextContent('$1.76'));
    expect(cardButtons()).toEqual([CREDIT_TEXT.find]);
    expect(screen.queryByTestId('issued-payments-credit-row-release')).toBeNull();
    await click('issued-payments-credit-card-find');
    await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull());
    expect(describedBy('issued-payments-credit-row-release')).toBe(CREDIT_TEXT.releaseHint);
    const lookupAt = server.sent.length;
    await click('issued-payments-credit-row-release');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.released));
    const settles = server.cnRequests('settle');
    expect(settles).toHaveLength(1);
    expect(JSON.parse(settles[0].body!)).toMatchObject({ expectedVersion: 1 });
    const settleAt = server.sent.indexOf(settles[0]);
    const lastLookup = server.sent.map((x, i) => (x.url.endsWith('/credit-note-attempts') && i < settleAt ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(lastLookup).toBeGreaterThan(-1);
    expect(lastLookup).toBeLessThan(lookupAt);
    await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowReleased]));
    server.credits.delete(made[0].id);
    await waitFor(() => expect(action()).not.toBeNull());
  });

  it('P2-18. a sealed issue invalid_state: the invoice re-read says voided → voided + Look up attempt (→ the open row → Release); not voided → attemptReleased, the attempt ends; the re-read failing → invalidStateUnknown', async () => {
    for (const cause of ['voided', 'released', 'unread'] as const) {
      const { server, made, r } = await ready();
      server.hold.cnIssue = 1;
      await click('issued-credit-send');
      await until(() => expect(server.held.length).toBe(1));
      if (cause === 'voided') made[0].void = { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' };
      if (cause === 'released') server.cnRegs.find((x) => x.attemptId === r.keys[0])!.state = 'released';
      if (cause === 'unread') { server.cnRegs.find((x) => x.attemptId === r.keys[0])!.state = 'released'; server.detailStatus.push(503); }
      await releaseNext(server);
      const said = cause === 'voided' ? CREDIT_TEXT.voided : cause === 'released' ? CREDIT_TEXT.attemptReleased : CREDIT_TEXT.invalidStateUnknown;
      await waitFor(() => expect(cardText(), cause).toBe(said));
      expect(cardButtons(), cause).toEqual(cause === 'released' ? [] : [CREDIT_TEXT.find]);
      if (cause === 'released') expect(held(r)?.state).toBe('released');
      if (cause === 'voided') {
        await click('issued-payments-credit-card-find');
        await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull());
        await click('issued-payments-credit-row-release');
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.released));
      }
      cleanup();
    }
  });

  it('P2-19. a register\'s sealed write_conflict (an unfinished attempt of this owner here): unfinished, the attempt ends, and the lookup runs — its open row offers Release', async () => {
    const { server, made, r } = await ready();
    server.addCreditReg({ invoiceId: made[0].id });
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unfinished));
    expect(held(r)?.state).toBe('ended');
    expect(cardButtons()).toEqual([]);
    await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowOpen(AT(r))]));
    expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull();
    expect(server.cnRequests('proof')).toEqual([]);
  });

  it('P2-20. a sealed already_issued: alreadyIssued and Look up attempt; the lookup offers "Confirm credit note" only for an issued row (never Release)', async () => {
    const { server, made, r } = await ready();
    server.cnScripts.issue.push(sealedAnswer('already_issued'));
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.alreadyIssued));
    const g = server.cnRegs.find((x) => x.attemptId === r.keys[0])!;
    const [note] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    g.state = 'issued';
    g.creditNote = { id: note.id, issuedAt: note.issuedAt, withdrawnAt: null };
    await click('issued-payments-credit-card-find');
    await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowIssued]));
    expect(screen.queryByTestId('issued-payments-credit-row-release')).toBeNull();
    expect(describedBy('issued-payments-credit-row-confirm')).toBe(CREDIT_TEXT.confirmHint);
    await click('issued-payments-credit-row-confirm');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
    expect(JSON.parse(server.cnRequests('settle')[0].body!)).toMatchObject({ expectedVersion: 2 });
  });

  it('P2-21. a register\'s first-send answers with no Check again sent: 401 (ended), 403 (one fresh check: notAllowed), 400, 404, an unsealed 409 (notAccepted) and a 429 (rateLimited) end the attempt; 409 request_in_progress keeps it (inProgress); a 422 fails closed (internalError) — nothing under a new key', async () => {
    const cases: Array<[string, Response | number, string, 'ended' | 'registering']> = [
      ['401', 401, CREDIT_TEXT.ended, 'ended'], ['403', 403, CREDIT_TEXT.notAllowed, 'ended'], ['400', 400, CREDIT_TEXT.notAccepted, 'ended'], ['404', 404, CREDIT_TEXT.notAccepted, 'ended'],
      ['409 unsealed', chain(409, 'write_conflict'), CREDIT_TEXT.notAccepted, 'ended'], ['429', 429, CREDIT_TEXT.rateLimited(7), 'ended'],
      ['409 in progress', chain(409, 'request_in_progress'), CREDIT_TEXT.inProgress, 'registering'], ['422', chain(422, 'idempotency_key_reused'), CREDIT_TEXT.internalError, 'registering'],
    ];
    for (const [name, answer, said, state] of cases) {
      const { server, r } = await ready();
      server.retryAfter = '7';
      server.cnScripts.register.push(answer as PayScript);
      await click('issued-credit-send');
      const where = name === '401' ? () => tid('issued-credit-alert').textContent : name === '409 in progress' ? inlineSay : inlineAlert;
      await waitFor(() => expect(where(), name).toBe(said));
      if (name !== '401') expect(held(r)?.state, name).toBe(state);
      expect(server.cnRequests('register'), name).toHaveLength(1);
      expect(server.cnRequests('proof'), name).toEqual([]);
      if (name === '403') expect(sentFrom(server, server.sent.indexOf(server.cnRequests('register')[0]) + 1)).toContain(`GET ${TENANT_SESSION_PATHS.current}`);
      if (name === '422') expect(cardButtons(), name).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]); // an unresolved card: Hide this attempt (D-P2-6)
      cleanup();
    }
  });

  it('P2-27, P2-28 (12). no answer within 30 s: the stage shows unresolved (register: regUnknown; issue: unresolved; settlement: settleUnknown) with Look up attempt; the request is never aborted and its late answer still counts — a late register 201 records registeredOnly and starts no proof', async () => {
    const { server, r } = await ready();
    server.hold.cnRegister = 1;
    fakeClock();
    fireEvent.click(tid('issued-credit-send'));
    await until(() => expect(server.held.length).toBe(1));
    await advance(30_000);
    await until(() => expect(cardText()).toBe(CREDIT_TEXT.regUnknown));
    expect(screen.queryByTestId('issued-credit-confirm')).toBeNull();
    expect(cardButtons()).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]); // in flight under 30 s on the rig clock: no Check again yet
    expect(server.cnRequests('register')[0].signal?.aborted).toBe(false); // T-09: its signal exists and was never aborted (no `?? false` stand-in)
    expect(held(r)?.unresolved).toBe(true);
    server.held.shift()!.release();
    await until(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true))); // the card waits for Continue issuing (§2.6 item 3)
    expect(held(r)?.state).toBe('registered');
    await advance(60_000);
    expect(server.cnRequests('proof')).toEqual([]);
    expect(server.cnRequests('issue')).toEqual([]);
    vi.useRealTimers();
    cleanup();
    const second = await ready();
    second.server.hold.cnIssue = 1;
    fakeClock();
    fireEvent.click(tid('issued-credit-send'));
    await until(() => expect(second.server.held.length).toBe(1));
    expect(second.server.held[0].kind).toBe('cnIssue');
    await advance(30_000);
    await until(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(false)));
    expect(CREDIT_TEXT.unresolved(false)).toBe("We can't tell whether this credit note was issued. Don't assume it wasn't. Look up this attempt.");
    second.server.held.shift()!.release();
    await until(() => expect(cardText()).toBe(issuedText));
    expect(cardButtons()).toEqual([CREDIT_TEXT.confirm]);
    // A Confirm with no answer: settleUnknown at 30 s, and Look up attempt is usable at once (the request runs on); no second Confirm.
    second.server.hold.cnSettle = 1;
    fireEvent.click(tid('issued-payments-credit-card-confirm'));
    await until(() => expect(second.server.held.length).toBe(1));
    await advance(30_000);
    await until(() => expect(cardText()).toBe(CREDIT_TEXT.settleUnknown(false)));
    expect(cardButtons()).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]);
    expect(tid('issued-payments-credit-card-find')).toHaveAttribute('aria-disabled', 'false');
    expect(second.server.cnRequests('settle')).toHaveLength(1);
  });

  it('P2-77. the 8-minute window passes inside the chain (register and proof succeed): registeredOnly + continueLapsed + Look up attempt; no issue is sent', async () => {
    const { server, r } = await ready();
    // The press at 7 min 50 s (a first send may leave); the register answers 20 s later (inside its 30 s), so the proof's
    // 200 lands with the sign-in 8 min 10 s old: the window passed inside the chain, before the issue's first send.
    r.clock.mono += 8 * 60_000 - 10_000;
    r.clock.wall += 8 * 60_000 - 10_000;
    server.hold.cnRegister = 1;
    await click('issued-credit-send');
    await until(() => expect(server.held.length).toBe(1));
    r.clock.mono += 20_000;
    r.clock.wall += 20_000;
    await releaseNext(server);
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.continueLapsed));
    expect(tid('issued-payments-credit-card-also').textContent).toBe(CREDIT_TEXT.registeredOnly(false));
    expect(cardButtons()).toEqual([CREDIT_TEXT.find]);
    expect(server.cnRequests('issue')).toEqual([]);
    expect(held(r)?.issue).toBeNull();
  });

  it('P2-32, P2-33. the lookup row of an attempt this page does not hold: issued (version 2) → Confirm (confirmHint) → confirmed; open (version 1) → Release → released; the list read again', async () => {
    const { server, made, r } = await setup({
      prepare: (s, m) => {
        const g = s.addCreditReg({ invoiceId: m[0].id, state: 'issued' });
        const [note] = s.addCreditNotes(m[0].id, 1, () => ({ issuedAt: s.cnTick() }));
        g.creditNote = { id: note.id, issuedAt: note.issuedAt, withdrawnAt: null };
        s.addCreditReg({ invoiceId: m[1].id, number: 2 });
      },
    });
    await open(1);
    await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowIssued]));
    expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn);
    const lists = server.cnRequests('list').length;
    await click('issued-payments-credit-row-confirm');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
    expect(JSON.parse(server.cnRequests('settle')[0].body!)).toEqual({ expectedTenant: TENANT_A, attemptId: server.cnRegs[0].attemptId, expectedVersion: 2 });
    await waitFor(() => expect(server.cnRequests('list').length).toBeGreaterThan(lists));
    await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowConfirmed]));
    await click('issued-view-close');
    await open(2);
    await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowOpen(AT(r))]));
    await click('issued-payments-credit-row-release');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.released));
    expect(server.cnRegs[1].state).toBe('released');
    void made;
  });

  it('P2-39. duplicate presses: a double click on "Issue credit note" (and on Confirm) sends ONE request per stage', async () => {
    const { server } = await ready();
    server.hold.cnRegister = 1;
    await user().dblClick(tid('issued-credit-send'));
    fireEvent.click(tid('issued-credit-send'));
    await releaseNext(server);
    await waitFor(() => expect(cardText()).toBe(issuedText));
    expect([server.cnRequests('register'), server.cnRequests('proof'), server.cnRequests('issue')].map((x) => x.length)).toEqual([1, 1, 1]);
    await user().dblClick(tid('issued-payments-credit-card-confirm'));
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
    expect(server.cnRequests('settle')).toHaveLength(1);
  });

  it('P2-43. nothing is sent on its own: timers, a focus, a tab return, a remount and a late answer send no register, proof, issue or settlement', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, r, page } = await ready();
    server.hold.cnRegister = 1;
    fakeClock();
    fireEvent.click(tid('issued-credit-send'));
    await until(() => expect(server.held.length).toBe(1));
    await advance(10 * 60_000);
    vi.useRealTimers();
    await focusEvents();
    const writes = () => [server.cnRequests('register'), server.cnRequests('proof'), server.cnRequests('issue'), server.cnRequests('settle')].map((x) => x.length);
    expect(writes()).toEqual([1, 0, 0, 0]);
    mountEpoch += 1; // a key remount is a new mount (fix list 7 › N3: the P2-89 generation)
    page.rerender(<ServerIssuedInvoices {...r.props({ uid: 'uid-a' })} key="again" />);
    await settle();
    server.held.shift()!.release();
    await settle();
    await focusEvents();
    expect(writes()).toEqual([1, 0, 0, 0]);
  });

  it('P2-54. Escape in flight closes the confirmation and aborts nothing (closedInFlight said); the late outcome is said in the section\'s regions once the dialog is closed too', async () => {
    const { server } = await ready();
    server.hold.cnIssue = 1;
    await click('issued-credit-send');
    await until(() => expect(server.held.length).toBe(1));
    fireEvent.keyDown(tid('issued-credit-keep'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
    expect(inlineSay()).toBe(CREDIT_TEXT.closedInFlight);
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await releaseNext(server);
    await waitFor(() => expect(tid('issued-credit-status').textContent).toBe(issuedText));
    expect(cardText('issued-credit-card')).toBe(issuedText);
    expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.confirm]);
    expect(server.cnRequests('issue')).toHaveLength(1);
  });

  it('P2-64. card texts with a lookup that does not decide: an issue sent and no row → notListed (never "not issued"); no issue sent and no row → regUnknown; open rows read "Registered, not issued when checked at {time}"', async () => {
    const { server, r } = await ready();
    server.cnScripts.issue.push('lose');
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true))); // answered (lost): Check again is offered (§3.1)
    server.cnRegs.splice(0);
    await click('issued-payments-credit-card-find');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.notListed));
    expect(cardText()).not.toMatch(/no credit note was issued/i);
    cleanup();
    const two = await ready();
    two.server.cnScripts.proof.push(503);
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true))); // proof 503: Continue issuing is offered (§3.1)
    await click('issued-payments-credit-card-find');
    await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowOpen(AT(two.r))]));
    expect(CREDIT_TEXT.rowOpen('2026-10-16 12:00:00 UTC')).toBe('Registered, not issued when checked at 2026-10-16 12:00:00 UTC');
    two.server.cnRegs.splice(0);
    await click('issued-payments-credit-card-find');
    await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.regUnknown));
    void r;
  });

  it('P2-28 (5, 11, 12). first sends judged per attempt, forward only, never starting a later stage: an issue left unresolved that the lookup shows issued → Confirm on its row; the stalled original then refused before the key (a step-up) changes nothing — no "No credit note" text, no Release; a late proof 200 after released restores nothing', async () => {
    const { server, made, r } = await ready();
    server.hold.cnIssue = 1;
    fakeClock();
    fireEvent.click(tid('issued-credit-send'));
    await until(() => expect(server.held.length).toBe(1));
    await advance(30_000);
    await until(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(false)));
    vi.useRealTimers();
    // The same key committed meanwhile (the server's side of case 5's replay): the lookup shows the attempt issued.
    const g = server.cnRegs.find((x) => x.attemptId === r.keys[0])!;
    const [note] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick() }));
    g.state = 'issued';
    g.creditNote = { id: note.id, issuedAt: note.issuedAt, withdrawnAt: null };
    await click('issued-payments-credit-card-find');
    await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowIssued]));
    expect(held(r)?.state).toBe('issued');
    expect(screen.queryByTestId('issued-payments-credit-row-confirm')).not.toBeNull();
    server.held.shift()!.release(chain(403, 'step_up_required'));
    await settle();
    expect(held(r)?.state).toBe('issued');
    expect(tid('issued-payments').textContent).not.toMatch(/No credit note was issued|sign-in was too old/);
    expect(screen.queryByTestId('issued-payments-credit-row-release')).toBeNull();
    cleanup();
    const two = await ready();
    two.server.hold.cnProof = 1;
    fakeClock();
    fireEvent.click(tid('issued-credit-send'));
    await until(() => expect(two.server.held.length).toBe(1));
    await advance(30_000);
    await until(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(false)));
    vi.useRealTimers();
    await click('issued-payments-credit-card-find');
    await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull());
    await click('issued-payments-credit-row-release');
    await waitFor(() => expect(held(two.r)?.state).toBe('released'));
    const g2 = two.server.cnRegs.find((x) => x.attemptId === two.r.keys[0])!;
    two.server.held.shift()!.release(json(200, { registration: { id: g2.id, invoiceId: two.made[0].id, attemptId: g2.attemptId }, proof: g2.proof }));
    await settle();
    expect(held(two.r)?.state).toBe('released');
    expect(cardText()).toBe(CREDIT_TEXT.released);
    expect(cardButtons()).toEqual([]);
    expect(two.server.cnRequests('issue')).toEqual([]);
  });

  it('P2-60, CN-27b, DIS-16. every credit-note string is exactly the wording table\'s (doc 17 §2.7); none says paid, unpaid, refunded or refund; "withdraw" only for a credit note; inside Payments only the three approved names say "credit" and none says "withdraw"', async () => {
    const at = '2026-10-16 12:00:00 UTC';
    const evaluated = Object.fromEntries(Object.entries(CREDIT_TEXT).map(([k, v]) => [k, typeof v === 'function' ? (v as (...xs: unknown[]) => string)(...({
      moreLoaded: [3], number: [12], amountHint: ['$21.76'], errOver: ['$21.76'], consequence: ['$5.00'], signedIn: [at, '2026-10-16 12:08:00 UTC'], signInExpired: [at],
      registeredOnly: [true], issued: ['$5.00', 'Goodwill'], unresolved: [true], rateLimited: [1], rateLimitedWait: [2], settleUnknown: [true], checkUntil: [at], rowOpen: [at],
    } as Record<string, unknown[]>)[k]) : v]));
    expect(evaluated).toEqual({
      listTitle: 'Credit notes', listEmpty: 'No credit notes on this invoice.', listEmptyOwner: 'None have been issued yet.', listLoading: 'Loading credit notes…',
      listFailed: "Credit notes couldn't be loaded.", tryAgain: 'Try again', showMore: 'Show more', moreLoaded: '3 more loaded.', number: 'CN-12',
      active: 'Active', withdrawn: 'Withdrawn', issuedAt: 'Issued', withdrawnAt: 'Withdrawn', issuedBy: 'Issued by', withdrawnBy: 'Withdrawn by', nameNotSet: 'Name not set',
      numberPending: 'The credit note number will show here when its row in the list loads.',
      lookupFailed: "We couldn't check for unfinished credit notes on this invoice, so issuing is off for now.",
      lookupIncomplete: "We haven't checked all your unfinished credit notes yet, so issuing is off for now.", continueChecking: 'Continue checking',
      action: 'Issue credit note', legend: 'Issue a credit note', amountLabel: 'Amount (USD)', amountHint: 'Up to $21.76 remaining.', reasonLegend: 'Reason', continue: 'Continue', cancel: 'Cancel',
      errFormat: 'Enter an amount in dollars and cents, such as 12.50, without $ or commas.', errDecimals: 'Enter an amount with no more than two decimal places.',
      errZero: 'Enter an amount of at least $0.01.', errOver: "The amount can't be more than the $21.76 remaining.", errReason: 'Choose a reason.', errSummary: 'Fix the marked fields to continue.',
      reviewVoided: "This invoice was voided, so a credit note can't be issued.", title: 'Issue a credit note?',
      consequence: "This creates a separate credit note and lowers what the customer owes on this invoice by $5.00. The issued invoice and its total stay the same. It moves no money and returns nothing to the customer. You can't undo it here.",
      keep: "Don't issue", close: 'Close', closeWarning: "Closing this window doesn't cancel the credit note. It may still be issued.", closedInFlight: 'Closed. The credit note is still being sent.',
      signInNeeded: 'Issuing a credit note needs a recent sign-in. Sign in again to continue. No credit note has been issued yet.',
      signInTimeout: "Sign-in didn't finish within 30 seconds. No credit note has been issued yet. Try again.",
      signedIn: `Signed in again at ${at}. Check the details, then press Issue credit note below before 2026-10-16 12:08:00 UTC.`,
      signInExpired: `Your sign-in from ${at} is too old to issue now. Sign in again to continue. No credit note has been issued yet.`,
      sending: 'Issuing the credit note…',
      registeredOnly: 'Registered. No credit note has been issued from this attempt yet. Check the amounts, then press Continue issuing, or look up this attempt to release it.',
      continueIssuing: 'Continue issuing', continueHint: 'This uses the attempt you already registered. No new attempt is made.',
      continueLapsed: "Your sign-in is too old to continue this attempt, and a new sign-in can't use it. Look up this attempt to release it, then start again.",
      continueAfterSignIn: "This attempt can't continue after a new sign-in. Look up this attempt to release it, then start again.",
      anotherNoteFound: 'Credit notes were issued on this invoice since you started this attempt. Check them before you continue.',
      anotherNoteUnknown: "We couldn't compare every credit note on this invoice with the list from when you started, so one may have been issued since. Check the list before you continue.",
      issueAnother: 'Issue another credit note',
      anotherHint: "This issues one more credit note on this invoice. If one of this invoice's credit notes already covers it, look up this attempt to release it instead.",
      regUnknown: 'No credit note was issued from this attempt. If the lookup finds it open, you can release it here.', issued: 'Credit note issued: $5.00, Goodwill.',
      issuedHint: "Confirm it to finish. Until you confirm, you can't issue another credit note on this invoice.",
      confirmHint: 'The credit note is already issued. Confirming only closes this attempt. It moves no money.', confirm: 'Confirm credit note', confirmed: 'Credit note confirmed.',
      release: 'Release attempt', released: 'Attempt released. No credit note was issued from it.',
      releaseHint: 'Release this attempt to free the invoice. Then you can issue a new credit note, for a smaller amount if needed.',
      overRemaining: 'No credit note was issued: the amount is more than what remains on this invoice now.', voided: 'No credit note was issued: this invoice was voided.',
      attemptReleased: 'No credit note was issued: this attempt was released.',
      invalidStateUnknown: 'No credit note was issued from this attempt. The invoice may have been voided, or the attempt released. Look up this attempt.',
      issueStale: 'Your sign-in was too old, so no credit note was issued. Look up this attempt to release it, then start again.',
      alreadyIssued: 'A credit note already exists for this attempt. Look up this attempt to confirm it.',
      cantContinue: "This attempt can't continue from here. Look up attempt to see what happened.",
      unfinished: 'You have an unfinished credit note on this invoice. Confirm or release it before you issue another.',
      notAccepted: 'No credit note was issued: the server did not accept this request.', notAllowed: "You can't issue credit notes at this store now. No credit note was issued.",
      unresolved: "We can't tell whether this credit note was issued. Don't assume it wasn't. Check again, or look up this attempt.",
      replayGone: "We can't check this attempt from this sign-in, so we don't know whether the credit note was issued. Look up this attempt to see.",
      notListed: "We can't tell whether this credit note was issued. The lookup didn't find this attempt. Check this invoice's credit notes later.",
      inProgress: "This request is still being processed. We don't know the result yet. Check again in a few seconds.",
      rateLimited: 'Too many tries at once. Wait 1 second, then try again.', rateLimitedWait: 'Too many tries at once. Wait 2 seconds, then check again.',
      noAccess: "Your access to credit notes at this store changed, so you can't finish this attempt. It may already have been issued. Ask an owner to check this invoice's credit notes.",
      noAccessShort: "Your access to credit notes at this store changed, so you can't finish this attempt.",
      endedUnknown: "You were signed out, so we can't tell whether this credit note was issued. Sign in again, then look up this attempt.",
      ended: 'Your server session ended. Reconnect to see issued invoices.',
      internalError: 'Something went wrong with this request, so nothing more was sent. Look up this attempt.',
      settleNotDone: "We couldn't confirm that this attempt was finished for this account. Look up this attempt.",
      settleUnknown: "We can't tell whether this attempt was finished. Check again, or look up this attempt to see.",
      find: 'Look up attempt', checkAgain: 'Check again', checkUntil: `You can check again until ${at}.`,
      checkReplayHint: "Sends the same request again. If it wasn't recorded yet, this can finish it. It never starts a new attempt.",
      checkReadHint: 'Only checks this attempt. It changes nothing.', hide: 'Hide this attempt',
      hideWarning: "This only hides it here. It releases nothing, issues nothing and moves no money, and it doesn't tell us whether the credit note was issued. If the attempt is still open, it still blocks your next credit note on this invoice. Check this invoice's credit notes later.",
      rowOpen: `Registered, not issued when checked at ${at}`, rowIssued: 'Issued, not confirmed', rowReleased: 'Released', rowConfirmed: 'Confirmed',
      blockedOwn: 'Confirm or release the unfinished credit note below first.', blockedSibling: 'Finish your unfinished payment, reversal or void attempt first.',
      blockedRemaining: 'Nothing remains to credit on this invoice.',
    });
    // The variants without the words a button would back (§2.7 notes): no dangling lower case.
    expect([CREDIT_TEXT.registeredOnly(false), CREDIT_TEXT.settleUnknown(false), CREDIT_TEXT.rateLimited(2)]).toEqual([
      'Registered. No credit note has been issued from this attempt yet. Check the amounts, then look up this attempt to release it.',
      "We can't tell whether this attempt was finished. Look up this attempt to see.", 'Too many tries at once. Wait 2 seconds, then try again.']);
    expect(CREDIT_BUTTON_NAMES).toEqual([CREDIT_TEXT.action, CREDIT_TEXT.issueAnother, CREDIT_TEXT.confirm]);
    for (const said of Object.values(evaluated)) {
      expect(said).not.toMatch(/\b(un)?paid\b|refund/i); // CN-27b, and no "refund" anywhere
      if (/withdraw/i.test(said)) expect(['Withdrawn', 'Withdrawn by']).toContain(said);
    }
    // Rendered: the issued card, the rows and the action inside Payments; outside it the section's words stay clear.
    const { server } = await ready({ prepare: (s, m) => { s.addCreditReg({ invoiceId: m[1].id, number: 2 }); } });
    await click('issued-credit-send');
    await waitFor(() => expect(cardText()).toBe(issuedText), { timeout: 10_000 });
    await waitFor(() => expect(action()).not.toBeNull()); // the form resets once the press returns (after the card speaks)
    const section = tid('issued-payments');
    expect(creditNamedOutside(section)).toEqual([]);
    expect(within(section).getAllByRole('button', { name: /credit/i }).map((b) => b.textContent).sort()).toEqual([CREDIT_TEXT.confirm, CREDIT_TEXT.action]);
    expect(section.textContent).not.toMatch(/amount due|\b(un)?paid\b|refund/i);
    await click('issued-view-close');
    await waitFor(() => expect(cardText('issued-credit-card')).toBe(issuedText), { timeout: 10_000 });
    expect(unvoided(outsidePayments(tid('issued-section')))).not.toMatch(FORBIDDEN);
    void server;
  });

  // ---- the recovery side (doc 17 §3): Check again, Continue issuing (E1-E7, D-P2-15), Hide, detach, reload ----
  // Most rows here walk several scenarios (each its own page and fake): a longer budget than the 5 s default.
  describe('recovering one (M7B-CREDITNOTES-CN-P2, the recovery side)', { timeout: 30_000 }, () => {
    const control = (name: string, prefix = 'issued-payments-credit-card') => screen.queryByTestId(`${prefix}-${name}`);
    /** One press on a card control (works with fake timers on: no userEvent). */
    const press = async (name: string, prefix?: string) => { fireEvent.click(control(name, prefix)!); await settle(); };
    /** Both rig clocks and the faked timers move together. */
    const pass = async (r: Rig, ms: number) => { r.clock.mono += ms; r.clock.wall += ms; await advance(ms); };
    const keyOf = (x: Sent) => x.headers.get('idempotency-key');
    const at = (wallMs: number) => utcText(new Date(wallMs).toISOString());
    /** Every successive text `el` shows from now on (one entry per change). */
    const watch = (el: HTMLElement) => {
      const seen: string[] = [];
      const o = new MutationObserver(() => { const t = el.textContent ?? ''; if (seen[seen.length - 1] !== t) seen.push(t); });
      o.observe(el, { childList: true, characterData: true, subtree: true });
      return () => { o.disconnect(); return seen; };
    };
    const writes = (server: Server) => [server.cnRequests('register'), server.cnRequests('issue'), server.cnRequests('settle')].map((x) => x.length);
    /** `stage`'s first send held at the fake past its 30 s (fake timers from here on): the card offers Check again. */
    async function stalled(x: { server: Server; r: Rig }, kind: 'cnRegister' | 'cnIssue') {
      x.server.hold[kind] = 1;
      fakeClock();
      fireEvent.click(tid('issued-credit-send'));
      await until(() => expect(x.server.held.length).toBe(1));
      await pass(x.r, 30_000);
      await until(() => expect(control('check')).not.toBeNull());
    }
    /** An issued attempt whose Confirm is held at the fake past its 30 s (fake timers from here on): settleUnknown with Check again. */
    async function stalledSettle(x: { server: Server; r: Rig }) {
      fireEvent.click(tid('issued-credit-send'));
      await until(() => expect(cardText()).toBe(issuedText));
      x.server.hold.cnSettle = 1;
      fakeClock();
      fireEvent.click(control('confirm')!);
      await until(() => expect(x.server.held.length).toBe(1));
      await pass(x.r, 30_000);
      await until(() => expect(control('check')).not.toBeNull());
      expect(cardText()).toBe(CREDIT_TEXT.settleUnknown(true));
    }
    /** ready(), then the proof's first send 503: registeredOnly with Check again and Continue issuing. */
    async function registeredOnly(o: Parameters<typeof ready>[0] = {}) {
      const x = await ready(o);
      x.server.cnScripts.proof.push(503);
      fireEvent.click(tid('issued-credit-send'));
      await until(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true)));
      return x;
    }
    /** A reload: the same session and keys, a NEW hold store (memory only) and a remount. */
    async function reload(r: Rig) {
      cleanup();
      render(<ServerIssuedInvoices {...r.props({ creditNoteHolds: createCreditNoteHoldStore({ now: () => r.clock.mono, wallNow: () => r.clock.wall }) })} />);
      await showAndChoose(STORE_1);
      await listReady();
    }

    it('CN-07b, P2-22. a lost register reply: regUnknown with Check again (checkReplayHint; checkUntil a clock time) replaying the register only — the same key and exact bytes; a replay 400, 404 or unsealed 409 → regUnknown, the attempt kept; a 201 → registeredOnly, never the proof; nothing is sent on its own', async () => {
      for (const how of ['lose-before', 'lose'] as const) {
        const { server, r } = await ready();
        const signedAt = r.clock.wall;
        server.cnScripts.register.push(how);
        await click('issued-credit-send');
        await waitFor(() => expect(cardText(), how).toBe(CREDIT_TEXT.regUnknown));
        expect(cardButtons(), how).toEqual([CREDIT_TEXT.checkAgain, CREDIT_TEXT.find, CREDIT_TEXT.hide]);
        expect(describedBy('issued-payments-credit-card-check')).toBe(CREDIT_TEXT.checkReplayHint);
        expect(tid('issued-payments-credit-card-until').textContent).toBe(CREDIT_TEXT.checkUntil(at(signedAt + 9 * 60_000)));
        await settle();
        expect(server.cnRequests('register'), how).toHaveLength(1); // nothing on its own (§3.4)
        if (how === 'lose-before') {
          for (const refusal of [400, 404, chain(409, 'write_conflict')]) {
            const before = server.cnRequests('register').length;
            server.cnScripts.register.push(refusal);
            await press('check');
            await waitFor(() => expect(server.cnRequests('register')).toHaveLength(before + 1));
            await settle();
            expect(cardText()).toBe(CREDIT_TEXT.regUnknown);
            expect(held(r)?.state).toBe('registering');
            expect(cardButtons()).toEqual([CREDIT_TEXT.checkAgain, CREDIT_TEXT.find, CREDIT_TEXT.hide]);
          }
        }
        await press('check');
        await waitFor(() => expect(cardText(), how).toBe(CREDIT_TEXT.registeredOnly(true)));
        const regs = server.cnRequests('register');
        expect(new Set(regs.map(keyOf))).toEqual(new Set([r.keys[1]]));
        expect(new Set(regs.map((x) => x.body)).size).toBe(1);
        expect(held(r)).toMatchObject({ state: 'registered', registrationId: server.cnRegs[0].id });
        await settle();
        expect([server.cnRequests('proof'), server.cnRequests('issue')]).toEqual([[], []]); // a Check again never runs on
        expect(cardButtons()).toEqual([CREDIT_TEXT.continueIssuing, CREDIT_TEXT.find, CREDIT_TEXT.hide]);
        cleanup();
      }
    });

    it('P2-23, P2-86, P2-79. the two-device sequence: the register\'s first send 503 (rolled back); another session issues (one note since withdrawn); Check again registers → registeredOnly, the review re-reads the lookup and the list, no proof or issue; Continue issuing → anotherNoteFound listing those notes (status, withdrawal time and reason), focus on Look up attempt, no issue; only "Issue another credit note" sends — exactly one issue', async () => {
      const { server, made, r } = await ready();
      server.hold.cnRegister = 1;
      await click('issued-credit-send');
      await releaseNext(server, json(503, { error: 'service_unavailable', requestId: 'req-synthetic' }));
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.regUnknown));
      const [b, w] = server.addCreditNotes(made[0].id, 2, (i) => ({
        issuedAt: server.cnTick(), ...(i === 1 ? { withdrawal: { withdrawnAt: server.cnTick(), reason: 'wrong_amount', withdrawnByName: 'Ada Owner' } } : {}),
      }));
      server.credits.set(made[0].id, 100);
      const from = server.sent.length;
      await press('check');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true)));
      await waitFor(() => expect(sentFrom(server, from).filter((x) => x.endsWith('/credit-notes'))).not.toEqual([]));
      expect(sentFrom(server, from).some((x) => x.endsWith('/credit-note-attempts'))).toBe(true);
      expect([server.cnRequests('proof'), server.cnRequests('issue')]).toEqual([[], []]);
      await settle();
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteFound));
      expect(inlineAlert()).toBe(CREDIT_TEXT.anotherNoteFound);
      expect(screen.getAllByTestId('issued-payments-credit-card-note').map((x) => x.getAttribute('data-id'))).toEqual([b.id, w.id]);
      expect(screen.getAllByTestId('issued-payments-credit-card-note-status').map((x) => x.textContent)).toEqual([CREDIT_TEXT.active, CREDIT_TEXT.withdrawn]);
      expect(tid('issued-payments-credit-card-note-withdrawn-at')).toHaveAttribute('datetime', w.withdrawal!.withdrawnAt);
      expect(tid('issued-payments-credit-card-note-withdrawal-reason').textContent).toBe('Wrong amount');
      await waitFor(() => expect(document.activeElement).toBe(tid('issued-payments-credit-card-find')));
      expect(cardButtons()).toEqual([CREDIT_TEXT.issueAnother, CREDIT_TEXT.find, CREDIT_TEXT.hide]);
      expect(describedBy('issued-payments-credit-card-another')).toBe(CREDIT_TEXT.anotherHint);
      expect([server.cnRequests('proof'), server.cnRequests('issue')]).toEqual([[], []]);
      expect(held(r)?.shown).toEqual({ ids: [b.id, w.id], complete: true });
      await press('another');
      await waitFor(() => expect(cardText()).toBe(issuedText));
      expect([server.cnRequests('register'), server.cnRequests('proof'), server.cnRequests('issue')].map((x) => x.length)).toEqual([2, 1, 1]);
      expect(keyOf(server.cnRequests('issue')[0])).toBe(held(r)?.issue?.key);
    });

    it('P2-86 (variant). the other note comes from another store owner → anotherNoteFound lists it', async () => {
      const { server, made, r } = await ready();
      server.hold.cnRegister = 1;
      await click('issued-credit-send');
      await releaseNext(server, json(503, { error: 'service_unavailable', requestId: 'req-synthetic' }));
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.regUnknown));
      // Another owner of this store registers, issues and confirms. Their registration is theirs (D16:339): never in this
      // owner's lookup and never this owner's slot; only their note, with their name, reaches this invoice's list.
      const theirs = server.addCreditReg({ uid: 'uid-o2', invoiceId: made[0].id });
      const [note] = server.addCreditNotes(made[0].id, 1, () => ({ issuedAt: server.cnTick(), issuedByName: 'Bo Owner' }));
      theirs.state = 'confirmed';
      theirs.settledAt = server.cnTick();
      theirs.creditNote = { id: note.id, issuedAt: note.issuedAt, withdrawnAt: null };
      server.credits.set(made[0].id, note.grossCents);
      const from = server.sent.length;
      await press('check');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true)));
      await waitFor(() => expect(sentFrom(server, from).filter((x) => x.endsWith('/credit-notes'))).not.toEqual([]));
      expect([server.cnRequests('proof'), server.cnRequests('issue')]).toEqual([[], []]);
      await settle();
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteFound));
      expect(screen.getAllByTestId('issued-payments-credit-card-note').map((x) => x.getAttribute('data-id'))).toEqual([note.id]);
      expect(tid('issued-payments-credit-card-note-issued-by').textContent).toBe('Issued by Bo Owner');
      expect(held(r)?.shown).toEqual({ ids: [note.id], complete: true });
      expect(cardButtons()).toEqual([CREDIT_TEXT.issueAnother, CREDIT_TEXT.find, CREDIT_TEXT.hide]);
      expect([server.cnRequests('proof'), server.cnRequests('issue')]).toEqual([[], []]);
      await press('another');
      await waitFor(() => expect(cardText()).toBe(issuedText));
      expect([server.cnRequests('register'), server.cnRequests('proof'), server.cnRequests('issue')].map((x) => x.length)).toEqual([2, 1, 1]);
    });

    it('P2-24, P2-65. a lost proof reply: registeredOnly with Check again (checkReadHint, no checkUntil: the proof has no window) and Continue issuing (continueHint); Check again only reads the proof; Continue issuing re-reads the review and the list, sends its own proof, claims ONE issue key and holds it before the send — never a register; the main action stays blockedOwn', async () => {
      const { server, r } = await registeredOnly();
      expect(cardButtons()).toEqual([CREDIT_TEXT.checkAgain, CREDIT_TEXT.continueIssuing, CREDIT_TEXT.find]); // known registered: no Hide
      expect(describedBy('issued-payments-credit-card-check')).toBe(CREDIT_TEXT.checkReadHint);
      expect(describedBy('issued-payments-credit-card-continue')).toBe(CREDIT_TEXT.continueHint);
      expect(control('until')).toBeNull();
      await waitFor(() => expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn));
      await press('check');
      await waitFor(() => expect(server.cnRequests('proof')).toHaveLength(2));
      await settle();
      expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true));
      expect(server.cnRequests('issue')).toEqual([]);
      server.hold.cnIssue = 1;
      const from = server.sent.length;
      await press('continue');
      await until(() => expect(server.held.length).toBe(1));
      const reads = sentFrom(server, from).filter((x) => x.startsWith('GET '));
      for (const read of [/\/invoices\/[^/]+$/, /\/payments$/, /\/credit-note-attempts$/, /\/credit-notes$/, /\/credit-note-registration-proof\?/]) expect(reads.some((x) => read.test(x)), String(read)).toBe(true);
      const iss = server.cnRequests('issue');
      expect(iss).toHaveLength(1);
      expect(held(r)).toMatchObject({ state: 'issuing', issue: { key: keyOf(iss[0]) } });
      expect(held(r)?.issue?.body === iss[0].body, 'the held issue bytes are the sent ones').toBe(true);
      await releaseNext(server);
      await waitFor(() => expect(cardText()).toBe(issuedText));
      expect(server.cnRequests('register')).toHaveLength(1);
      expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn);
    });

    it('P2-25, P2-68, P2-28 (5). a lost issue reply: unresolved with Check again (checkReplayHint, checkUntil) and never Continue issuing once the issue key is claimed; Check again replays the issue — the same key, exact bytes — and its 201 issues ONE credit note; an original 503 then the Check again\'s 201 → issued', async () => {
      for (const first of ['lose', 503] as const) {
        const { server, made, r } = await ready();
        server.cnScripts.issue.push(first);
        await click('issued-credit-send');
        await waitFor(() => expect(cardText(), String(first)).toBe(CREDIT_TEXT.unresolved(true)));
        expect(cardButtons()).toEqual([CREDIT_TEXT.checkAgain, CREDIT_TEXT.find, CREDIT_TEXT.hide]);
        expect(describedBy('issued-payments-credit-card-check')).toBe(CREDIT_TEXT.checkReplayHint);
        expect(control('until')).not.toBeNull();
        const said = watch(tid('issued-payments-credit-say'));
        await press('check');
        await waitFor(() => expect(cardText(), String(first)).toBe(issuedText));
        await settle();
        expect(said().filter((t) => t === issuedText), `${first}: one announcement (T-05)`).toHaveLength(1);
        const iss = server.cnRequests('issue');
        expect(iss).toHaveLength(2);
        expect(new Set(iss.map(keyOf))).toEqual(new Set([held(r)?.issue?.key]));
        expect(iss[1].body === iss[0].body, 'the replay\'s bytes are the original\'s').toBe(true);
        expect(server.creditNotes.get(made[0].id), String(first)).toHaveLength(1);
        expect(cardButtons()).toEqual([CREDIT_TEXT.confirm]);
        cleanup();
      }
    });

    it('P2-28 (6). the original\'s 201, then the Check again\'s stored 201: the same completion → one transition, one announcement; a different stored body → internalError with Look up attempt, no Confirm', async () => {
      for (const variant of ['same', 'different'] as const) {
        const x = await ready();
        await stalled(x, 'cnIssue');
        x.server.hold.cnIssue = 1;
        fireEvent.click(control('check')!);
        await until(() => expect(x.server.held.length).toBe(2));
        const said = watch(tid('issued-payments-credit-say'));
        x.server.held.shift()!.release();
        await until(() => expect(cardText()).toBe(issuedText));
        const other = new Response(JSON.stringify({ creditNote: { id: uuid(0xdead1), invoiceId: x.made[0].id, attemptId: x.r.keys[0], grossCents: 500, reason: 'goodwill' } }), {
          status: 201, headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
        });
        x.server.held.shift()!.release(variant === 'same' ? undefined : other);
        await settle();
        if (variant === 'same') {
          expect(cardText()).toBe(issuedText);
          expect(cardButtons()).toEqual([CREDIT_TEXT.confirm]);
          expect(said()).toEqual([issuedText]);
        } else {
          expect(cardText()).toBe(CREDIT_TEXT.internalError);
          expect(cardButtons()).toEqual([CREDIT_TEXT.find]);
        }
        expect(x.server.cnRequests('settle')).toEqual([]);
        vi.useRealTimers();
        cleanup();
      }
    });

    it('P2-28 (1)-(4), P2-27 (Check again). the issue: a Check again answered 409 in progress (a concurrent same-key request) or 429 before the original\'s 201 → issued, one transition; the original\'s 201 first, then the Check again\'s 409 or 429 → issued stays, stale: no inProgress, cool-down or rateLimitedWait', async () => {
      for (const [answer, order] of [[409, 'replay first'], [429, 'replay first'], [409, 'original first'], [429, 'original first']] as const) {
        const x = await ready();
        const name = `${answer} ${order}`;
        await stalled(x, 'cnIssue');
        const said = watch(tid('issued-payments-credit-say'));
        const late = answer === 409 ? chain(409, 'request_in_progress') : chain(429, 'rate_limited', { 'retry-after': '7' });
        if (order === 'replay first') {
          x.server.cnScripts.issue.push(late);
          fireEvent.click(control('check')!);
          await until(() => expect(cardText(), name).toBe(answer === 409 ? CREDIT_TEXT.inProgress : CREDIT_TEXT.unresolved(false)));
          if (answer === 429) expect(tid('issued-payments-credit-card-also').textContent).toBe(CREDIT_TEXT.rateLimitedWait(7));
          expect(control('check'), name).toBeNull(); // cooling
          expect(x.server.cnRequests('issue')[1].signal?.aborted, name).toBe(false); // T-09: a real signal, never aborted
          x.server.held.shift()!.release();
          await until(() => expect(cardText(), name).toBe(issuedText));
        } else {
          x.server.hold.cnIssue = 1;
          fireEvent.click(control('check')!);
          await until(() => expect(x.server.held.length).toBe(2));
          x.server.held.shift()!.release();
          await until(() => expect(cardText(), name).toBe(issuedText));
          x.server.held.shift()!.release(late);
          await settle();
          expect(cardText(), name).toBe(issuedText);
          expect(held(x.r)?.notBefore.issue, name).toBeUndefined();
          expect(inlineAlert(), name).not.toMatch(/Too many tries|still being processed/);
        }
        expect(cardButtons(), name).toEqual([CREDIT_TEXT.confirm]);
        expect(x.server.cnRequests('issue'), name).toHaveLength(2);
        expect(x.server.cnRequests('settle'), name).toEqual([]);
        expect(said().filter((t) => t === issuedText), `${name}: one announcement (T-05)`).toHaveLength(1);
        vi.useRealTimers();
        cleanup();
      }
    });

    it('P2-28 (7)-(10). the register: a Check again answered 409 or 429 before the original\'s 201 → registeredOnly, no proof or issue sent; the reverse order → registeredOnly stays. The settlement: the same both ways → confirmed, one transition', async () => {
      // T-01: all eight stage × answer × order combinations, one announcement of the end state, the request counts per route.
      const combos = (['register', 'settle'] as const).flatMap((stage) => ([409, 429] as const).flatMap((answer) => (['replay first', 'original first'] as const).map((order) => [stage, answer, order] as const)));
      for (const [stage, answer, order] of combos) {
        const x = await ready();
        const name = `${stage} ${answer} ${order}`;
        if (stage === 'register') await stalled(x, 'cnRegister');
        else await stalledSettle(x);
        const said = watch(tid('issued-payments-credit-say'));
        const late = answer === 409 ? chain(409, 'request_in_progress') : chain(429, 'rate_limited', { 'retry-after': '7' });
        if (order === 'replay first') {
          x.server.cnScripts[stage].push(late);
          fireEvent.click(control('check')!);
          await until(() => expect(control('check'), name).toBeNull());
          await settle();
          x.server.held.shift()!.release();
        } else {
          x.server.hold[stage === 'register' ? 'cnRegister' : 'cnSettle'] = 1;
          fireEvent.click(control('check')!);
          await until(() => expect(x.server.held.length).toBe(2));
          x.server.held.shift()!.release();
          await until(() => expect(cardText(), name).toBe(stage === 'register' ? CREDIT_TEXT.registeredOnly(true) : CREDIT_TEXT.confirmed));
          x.server.held.shift()!.release(late);
        }
        await settle();
        const end = stage === 'register' ? CREDIT_TEXT.registeredOnly(true) : CREDIT_TEXT.confirmed;
        await until(() => expect(cardText(), name).toBe(end));
        await settle();
        expect(inlineAlert(), name).not.toMatch(/Too many tries|still being processed/);
        expect(said().filter((t) => t === end), `${name}: one announcement`).toHaveLength(1);
        expect(writes(x.server), name).toEqual(stage === 'register' ? [2, 0, 0] : [1, 1, 2]);
        if (stage === 'register') {
          expect([x.server.cnRequests('proof'), x.server.cnRequests('issue')], name).toEqual([[], []]);
          expect(held(x.r)?.state, name).toBe('registered');
        } else {
          expect(held(x.r)?.state, name).toBe('confirmed');
          expect(cardButtons(), name).toEqual([]);
        }
        vi.useRealTimers();
        cleanup();
      }
    });

    it('P2-28 (11). the issue\'s first send stalls, Check again commits 201, then the original is refused before the key: a step-up → no change; 403 forbidden → the one session check: the same token → noAccess with no buttons, a new token → detached; 401 → the section signs out and the card is detached with issued as its last state — never a "No credit note" text or a Release', async () => {
      for (const refusal of ['step-up', 'same token', 'new token', '401'] as const) {
        const x = await ready();
        await stalled(x, 'cnIssue');
        const from = x.server.sent.length;
        fireEvent.click(control('check')!);
        await until(() => expect(cardText(), refusal).toBe(issuedText));
        // Check again's 201 starts a refresh (the list to the new row, the amounts). The refusal goes once that has been sent
        // and answered, so what is sent after `mark` is the refusal's own traffic.
        const out = () => x.server.sent.slice(from);
        await until(() => expect([/\/invoices\/[^/]+\/credit-notes(\?|$)/, /\/invoices\/[^/?]+$/, /\/payments(\?|$)/].map((p) => out().some((s) => s.method === 'GET' && p.test(s.url))), refusal).toEqual([true, true, true]));
        await until(() => expect(out().filter((s) => x.server.cnMeta.get(s)?.answeredAt == null), refusal).toEqual([]));
        if (refusal === 'new token') x.server.otherTab('uid-a');
        const mark = x.server.sent.length;
        x.server.held.shift()!.release(refusal === 'step-up' ? chain(403, 'step_up_required') : refusal === '401' ? chain(401, 'unauthenticated') : chain(403, 'forbidden'));
        await settle();
        await settle();
        expect(x.server.cnRequests('settle'), refusal).toEqual([]); // T-02: never a confirm sent
        // T-02: a 403 forbidden runs the ONE fresh session check before anything else is sent.
        const after = sentFrom(x.server, mark);
        const current = `GET ${TENANT_SESSION_PATHS.current}`;
        if (refusal === 'same token' || refusal === 'new token') expect(after[0], refusal).toBe(current);
        if (refusal === 'step-up') expect(after, refusal).not.toContain(current);
        expect(held(x.r)?.state, refusal).toBe('issued');
        expect(tid('issued-section').textContent, refusal).not.toMatch(/No credit note was issued|sign-in was too old/);
        expect(screen.queryByTestId('issued-payments-credit-row-release'), refusal).toBeNull();
        if (refusal === 'step-up') expect([cardText(), cardButtons()]).toEqual([issuedText, [CREDIT_TEXT.confirm]]);
        if (refusal === 'same token') expect([cardText(), cardButtons()]).toEqual([CREDIT_TEXT.noAccess, []]);
        if (refusal === 'new token' || refusal === '401') {
          expect(held(x.r)?.csrf, refusal).toBeNull();
          expect([cardText('issued-credit-card'), cardButtons('issued-credit-card')], refusal).toEqual([issuedText, [CREDIT_TEXT.hide]]);
        }
        vi.useRealTimers();
        cleanup();
      }
    });

    it('P2-28 (12), Check again. a late register 201 after the attempt was issued (through Check again and Continue issuing) changes nothing and restores no action', async () => {
      const x = await ready();
      await stalled(x, 'cnRegister');
      fireEvent.click(control('check')!);
      await until(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true)));
      await settle();
      fireEvent.click(control('continue')!);
      await until(() => expect(cardText()).toBe(issuedText));
      x.server.held.shift()!.release(); // the original register, processed now: the same stored 201
      await settle();
      expect(held(x.r)?.state).toBe('issued');
      expect(cardText()).toBe(issuedText);
      expect(cardButtons()).toEqual([CREDIT_TEXT.confirm]);
      expect(x.server.cnRequests('issue')).toHaveLength(1);
      expect(x.server.cnRequests('settle')).toEqual([]); // T-02: never a confirm sent
    });

    it('P2-29. the Check-again window of the issue and the register (the proof has none): offered under 9 minutes with checkUntil; when it passes the bytes are scrubbed and the button is replaced by replayGone (regUnknown at the register) through the alert region, focus to the card heading when the button had it', async () => {
      for (const stage of ['issue', 'register'] as const) {
        const x = await ready();
        const signedAt = x.r.clock.wall;
        fakeClock();
        x.server.cnScripts[stage].push('lose');
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(control('check'), stage).not.toBeNull());
        expect(tid('issued-payments-credit-card-until').textContent).toBe(CREDIT_TEXT.checkUntil(at(signedAt + 9 * 60_000)));
        act(() => control('check')!.focus());
        await pass(x.r, 9 * 60_000 - 1_000);
        expect(control('check'), stage).not.toBeNull();
        await pass(x.r, 1_000);
        await until(() => expect(control('check'), stage).toBeNull());
        expect(inlineAlert(), stage).toBe(stage === 'issue' ? CREDIT_TEXT.replayGone : CREDIT_TEXT.regUnknown);
        expect(cardText(), stage).toBe(stage === 'issue' ? CREDIT_TEXT.replayGone : CREDIT_TEXT.regUnknown);
        expect(held(x.r)?.[stage]?.body, stage).toBe('');
        expect(document.activeElement, stage).toBe(tid('issued-payments-credit-card-heading'));
        expect(cardButtons(), stage).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]);
        vi.useRealTimers();
        cleanup();
      }
      // The proof: a read with no window — its Check again stays; Continue issuing goes with the 8-minute sign-in.
      const x = await ready();
      fakeClock();
      x.server.cnScripts.proof.push(503);
      fireEvent.click(tid('issued-credit-send'));
      await until(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true)));
      await pass(x.r, 10 * 60_000);
      await until(() => expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(false)));
      expect(cardButtons()).toEqual([CREDIT_TEXT.checkAgain, CREDIT_TEXT.find]); // a registration known open: not unresolved, no Hide
    });

    it('P2-31, P2-63, P2-27 (Check again). the Check-again gate answers: at the issue 401 → endedUnknown, detached; 403 step_up_required → replayGone; 403 forbidden → one fresh check: the same token → noAccess, no buttons, a new token → detached; 422 → replayGone; 429 → unresolved + rateLimitedWait, Check again after Retry-After; 409 in progress → inProgress, 5 s (static text). At the register: regUnknown on evidence (b) each time. None says nothing was issued', async () => {
      type Case = [stage: 'issue' | 'register', answer: string, text: string, buttons: string[]];
      const cases: Case[] = [
        ['issue', '401', CREDIT_TEXT.endedUnknown, [CREDIT_TEXT.hide]], ['issue', 'step-up', CREDIT_TEXT.replayGone, [CREDIT_TEXT.find, CREDIT_TEXT.hide]],
        ['issue', 'forbidden', CREDIT_TEXT.noAccess, []], ['issue', 'forbidden, new token', CREDIT_TEXT.unresolved(false), [CREDIT_TEXT.hide]],
        ['issue', '422', CREDIT_TEXT.replayGone, [CREDIT_TEXT.find, CREDIT_TEXT.hide]], ['issue', '429', CREDIT_TEXT.unresolved(false), [CREDIT_TEXT.find, CREDIT_TEXT.hide]],
        ['issue', 'in progress', CREDIT_TEXT.inProgress, [CREDIT_TEXT.find, CREDIT_TEXT.hide]],
        ['register', 'step-up', CREDIT_TEXT.regUnknown, [CREDIT_TEXT.find, CREDIT_TEXT.hide]], ['register', '422', CREDIT_TEXT.regUnknown, [CREDIT_TEXT.find, CREDIT_TEXT.hide]],
        ['register', 'forbidden', CREDIT_TEXT.regUnknown, []], ['register', '429', CREDIT_TEXT.regUnknown, [CREDIT_TEXT.find, CREDIT_TEXT.hide]],
        ['register', '401', CREDIT_TEXT.regUnknown, [CREDIT_TEXT.hide]],
      ];
      for (const [stage, answer, text, buttons] of cases) {
        const name = `${stage} ${answer}`;
        const x = await ready();
        fakeClock();
        x.server.cnScripts[stage].push(503);
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(control('check'), name).not.toBeNull());
        const replay = answer === '401' ? chain(401, 'unauthenticated') : answer === 'step-up' ? chain(403, 'step_up_required') : answer.startsWith('forbidden') ? chain(403, 'forbidden')
          : answer === '422' ? chain(422, 'idempotency_key_reused') : answer === '429' ? chain(429, 'rate_limited', { 'retry-after': '7' }) : chain(409, 'request_in_progress');
        if (answer === 'forbidden, new token') {
          x.server.hold[stage === 'issue' ? 'cnIssue' : 'cnRegister'] = 1;
          fireEvent.click(control('check')!);
          await until(() => expect(x.server.held.length).toBe(1));
          x.server.otherTab('uid-a');
          x.server.held.shift()!.release(replay);
        } else {
          x.server.cnScripts[stage].push(replay);
          fireEvent.click(control('check')!);
        }
        const prefix = answer === '401' || answer === 'forbidden, new token' ? 'issued-credit-card' : 'issued-payments-credit-card';
        await until(() => expect(cardText(prefix), name).toBe(text));
        await settle();
        expect(cardButtons(prefix), name).toEqual(buttons);
        expect(tid('issued-section').textContent, name).not.toMatch(/No credit note was issued:|sign-in was too old/);
        if (answer === '429') expect(tid(`${prefix}-also`).textContent, name).toBe(CREDIT_TEXT.rateLimitedWait(7));
        if (answer === 'forbidden' && stage === 'register') expect(tid(`${prefix}-also`).textContent, name).toBe(CREDIT_TEXT.noAccessShort);
        if (answer === '429' || answer === 'in progress') {
          await pass(x.r, answer === '429' ? 7_000 : 5_000);
          await until(() => expect(control('check'), name).not.toBeNull()); // after the wait, Check again again; the text stays static
        }
        if (answer === '401' || answer === 'forbidden, new token') expect(held(x.r)?.csrf, name).toBeNull();
        expect(x.server.cnRequests(stage).length, name).toBe(2);
        vi.useRealTimers();
        cleanup();
      }
    });

    it('P2-31, rule 4 sticks. a Check again refused 403 with the same token leaves the card with no buttons; the stalled original\'s late 503 never gives them back', async () => {
      const x = await ready();
      await stalled(x, 'cnRegister');
      x.server.cnScripts.register.push(chain(403, 'forbidden'));
      fireEvent.click(control('check')!);
      await until(() => expect(tid('issued-payments-credit-card-also').textContent).toBe(CREDIT_TEXT.noAccessShort));
      expect(cardButtons()).toEqual([]);
      x.server.held.shift()!.release(json(503, { error: 'service_unavailable', requestId: 'req-synthetic' }));
      await settle();
      expect([cardText(), tid('issued-payments-credit-card-also').textContent, cardButtons()]).toEqual([CREDIT_TEXT.regUnknown, CREDIT_TEXT.noAccessShort, []]);
      expect(creditNoteHoldsSignIns(held(x.r), x.r.clock.mono, x.r.clock.wall, [], true)).toBe(false); // a bare card has nothing for D-P2-10 to protect
    });

    it('P2-26 (C), P2-85 (C). a lost settlement reply: Check again in the same session with the held bytes, under 23 hours after the key\'s first send (checkUntil) → confirmed; at 23 hours (the larger of monotonic and wall-clock time) the bytes go → settleUnknown and Look up attempt; a press just after the deadline with the timer suppressed sends nothing', async () => {
      const x = await ready();
      await stalledSettle(x);
      const first = held(x.r)!.settle!;
      expect(tid('issued-payments-credit-card-until').textContent).toBe(CREDIT_TEXT.checkUntil(at(first.firstWall! + 23 * 60 * 60_000)));
      vi.useRealTimers();
      x.server.cnScripts.settle.push('lose'); // the Check again commits, its answer lost too
      await press('check');
      await until(() => expect(cardText()).toBe(CREDIT_TEXT.settleUnknown(true)));
      await press('check'); // and once more: the stored 200
      await until(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
      const keys = new Set(x.server.cnRequests('settle').map(keyOf));
      expect(keys.size).toBe(1);
      x.server.held.shift()!.release(json(503, { error: 'service_unavailable', requestId: 'req-synthetic' })); // the original's late answer: stale
      await settle();
      expect(cardText()).toBe(CREDIT_TEXT.confirmed);
      cleanup();
      // The limit: wall-clock time alone past 23 h (monotonic short of it), the UI timer never run — the press refuses, nothing leaves.
      const y = await ready();
      y.server.cnScripts.settle.push(503);
      await click('issued-credit-send');
      await waitFor(() => expect(cardText()).toBe(issuedText));
      await press('confirm');
      await waitFor(() => expect(control('check')).not.toBeNull());
      const sent = y.server.cnRequests('settle').length;
      y.r.clock.mono += 60_000;
      y.r.clock.wall += 23 * 60 * 60_000;
      await press('check');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.settleUnknown(false)));
      expect(y.server.cnRequests('settle')).toHaveLength(sent);
      expect(held(y.r)?.settle?.body).toBe('');
      expect(inlineAlert()).toBe(CREDIT_TEXT.settleUnknown(false));
      expect(cardButtons()).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]);
      // Look up attempt (lookup-first): the row's own Confirm under a new key settles it.
      await press('find');
      await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-row-confirm')).not.toBeNull());
      await press('confirm', 'issued-payments-credit-row');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
      expect(new Set(y.server.cnRequests('settle').map(keyOf)).size).toBe(2);
    });

    it('P2-85 (C), display. at 23 hours after the settlement key\'s first send the Check again goes by itself (timers on the injected clocks): settleUnknown without Check again, through the alert region', async () => {
      const x = await ready();
      await stalledSettle(x);
      await pass(x.r, 23 * 60 * 60_000 - 30_000 - 1_000); // 30 s already passed in stalledSettle
      expect(control('check')).not.toBeNull();
      await pass(x.r, 1_000);
      await until(() => expect(control('check')).toBeNull());
      expect(cardText()).toBe(CREDIT_TEXT.settleUnknown(false));
      expect(inlineAlert()).toBe(CREDIT_TEXT.settleUnknown(false));
      expect(held(x.r)?.settle?.body).toBe('');
      x.server.held.shift()!.release();
      await settle();
      expect(cardText()).toBe(CREDIT_TEXT.confirmed); // a stored answer still counts
    });

    it('P2-26 (C), P2-30, P2-67. after a sign-in of the same owner the attempt is detached: only Look up attempt and Hide this attempt (continueAfterSignIn for a registration), in its own store; the lookup row then offers Release (a new key, this session); a store switch and a sign-out detach too; another user sees no card, row or action', async () => {
      const { server, r, page } = await registeredOnly();
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      server.otherTab('uid-a'); // a sign-in elsewhere in this browser: a new token
      await focusEvents();
      await waitFor(() => expect(cardText('issued-credit-card')).toBe(CREDIT_TEXT.continueAfterSignIn));
      expect(tid('issued-credit-card-also').textContent).toBe(CREDIT_TEXT.registeredOnly(false));
      expect(held(r)?.csrf).toBeNull();
      expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.hide]); // no store chosen under the new session yet
      await showAndChoose(STORE_1);
      await waitFor(() => expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]));
      await press('find', 'issued-credit-card');
      await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull());
      const sessionNow = server.cnRequests('lookup').at(-1)!.headers.get('x-tmpos-session-csrf');
      await press('release', 'issued-payments-credit-row');
      await waitFor(() => expect(cardText('issued-credit-card')).toBe(CREDIT_TEXT.released));
      const [rel] = server.cnRequests('settle');
      expect(rel.headers.get('x-tmpos-session-csrf')).toBe(sessionNow);
      expect(keyOf(rel)).not.toBe(r.keys[1]);
      expect(server.cnRegs[0].state).toBe('released');
      // A store switch, and a sign-out: detached at once; Look up only back in its own store, signed in.
      page.unmount();
      cleanup();
      const two = await registeredOnly();
      await click('issued-view-close');
      fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
      await waitFor(() => expect(held(two.r)?.csrf).toBeNull());
      expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.hide]);
      fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
      await waitFor(() => expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]));
      two.server.expire();
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      await focusEvents();
      await waitFor(() => expect(screen.queryByTestId('issued-retry')).not.toBeNull());
      expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.hide]);
      // Another user in this page: no card, no row, no action of the former owner.
      cleanup();
      two.server.cnOwners.add('uid-m');
      render(<ServerIssuedInvoices {...two.r.props({ uid: 'uid-m' })} />);
      await showAndChoose(STORE_1);
      await listReady();
      await open(1);
      await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'denied'));
      expect(screen.queryByTestId('issued-credit-card')).toBeNull();
      expect(screen.queryByTestId('issued-payments-credit-card')).toBeNull();
      expect(rowStates()).toEqual([]);
    });

    it('P2-81, P2-82, P2-83 (card parts). a Check again whose send leaves after another page\'s sign-in → 403 → the fresh check finds the new token → detached, never noAccess; a same-token denial (the owner demoted) → noAccess, no buttons, the listed notes and names gone; a 401 → Reconnect (same generation number, new token) → detached, no row action until a fresh lookup', async () => {
      const x = await registeredOnly();
      x.server.hold.current = 1; // the press's session read answers for the old session
      fireEvent.click(control('check')!);
      await until(() => expect(x.server.held.length).toBe(1));
      x.server.otherTab('uid-a');
      x.server.held.shift()!.release();
      await waitFor(() => expect(held(x.r)?.csrf).toBeNull());
      await waitFor(() => expect(cardText('issued-credit-card')).toBe(CREDIT_TEXT.continueAfterSignIn));
      expect(tid('issued-section').textContent).not.toContain(CREDIT_TEXT.noAccessShort);
      cleanup();
      // The same token, demoted (P2-82): anotherNoteFound listing a named note, then a confirmed lookup 403 (rule 4).
      const y = await registeredOnly();
      y.server.addCreditNotes(y.made[0].id, 1, () => ({ issuedAt: y.server.cnTick(), issuedByName: 'Bo Owner' }));
      y.server.credits.set(y.made[0].id, 100);
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteFound));
      expect(tid('issued-payments-credit-card-note-issued-by').textContent).toBe('Issued by Bo Owner');
      y.server.cnOwners.delete('uid-a');
      y.server.cnNamesHidden.add('uid-a');
      await press('find');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.noAccessShort));
      expect(tid('issued-payments-credit-card-also').textContent).toBe(CREDIT_TEXT.anotherNoteFound);
      expect(cardButtons()).toEqual([]);
      expect(screen.queryByTestId('issued-payments-credit-card-notes')).toBeNull();
      expect(held(y.r)?.shown).toBeNull();
      await waitFor(() => expect(tid('issued-section').textContent).not.toContain('Bo Owner'));
      expect(screen.queryByTestId('issued-payments-credit-issue')).toBeNull();
      cleanup();
      // A 401: the section signs out, the attempt detaches; Reconnect's token is a first token (same number): no row action until a fresh lookup.
      const z = await registeredOnly();
      z.server.expire();
      await press('check');
      await waitFor(() => expect(screen.queryByTestId('issued-retry')).not.toBeNull());
      expect(held(z.r)?.csrf).toBeNull();
      expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.hide]);
      await click('issued-retry');
      await showAndChoose(STORE_1);
      await waitFor(() => expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]));
      expect(screen.queryByTestId('issued-payments-credit-row-release')).toBeNull();
      expect(cardText('issued-credit-card')).toBe(CREDIT_TEXT.continueAfterSignIn);
    });

    it('P2-81 (81.6). a Continue issuing whose send leaves after another page\'s sign-in → 403 → the one check finds the new token → detached, never noAccess', async () => {
      const x = await registeredOnly();
      x.server.hold.cnProof = 1; // Continue issuing's own proof
      await press('continue');
      await until(() => expect(x.server.held.map((h) => h.kind)).toEqual(['cnProof']));
      x.server.hold.current = 1; // the session read just before the issue (§3.6 rule 1) answers for the old session
      x.server.held.shift()!.release();
      await until(() => expect(x.server.held.map((h) => h.kind)).toEqual(['current']));
      x.server.otherTab('uid-a'); // another page's sign-in in this browser: a new cookie and token
      x.server.held.shift()!.release(); // the same token still: the issue leaves with it, under the other page's cookie
      await waitFor(() => expect(held(x.r)?.csrf).toBeNull());
      const issues = x.server.cnRequests('issue');
      expect(issues).toHaveLength(1);
      expect(x.server.cnAnswers.get(issues[0])?.status).toBe(403);
      expect(sentFrom(x.server, x.server.sent.indexOf(issues[0]) + 1)).toContain(`GET ${TENANT_SESSION_PATHS.current}`); // the one fresh check
      await settle();
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull()); // the new token's generation closes the dialog
      // A first-send 403 the one check finds gone: the detached texts "as after a 401" (§3.1), never replayGone (O6).
      await waitFor(() => expect(cardText('issued-credit-card')).toBe(CREDIT_TEXT.ended));
      const page = document.body.textContent; // the view and confirmation are DialogFrame portals: the whole body
      for (const denial of [CREDIT_TEXT.noAccess, CREDIT_TEXT.noAccessShort, CREDIT_TEXT.notAllowed]) expect(page).not.toContain(denial);
      // Detached, not rule 4: the card keeps Hide this attempt (a confirmed denial leaves no buttons at all).
      await waitFor(() => expect(cardButtons('issued-credit-card')).toContain(CREDIT_TEXT.hide));
      expect(x.server.cnRequests('issue')).toHaveLength(1);
    });

    it('P2-81 (81.7). `renew` (the settings sign-in) drops the credit-note list, lookup rows, cursors and baseline', async () => {
      let release!: () => void;
      let gate: Promise<void> | null = null;
      const x = await registeredOnly({
        prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); },
        identity: (r) => {
          const base = r.props().identity!;
          return { ...base, reauthenticate: async (uid, password) => { if (gate !== null) await gate; return base.reauthenticate(uid, password); } };
        },
      });
      expect(held(x.r)?.baseline).not.toBeNull(); // frozen at the register's first send
      await click('issued-view-close');
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
      // ready()'s own sign-in (the confirmation's, which keeps the view) already cleared the issued list (LIST_TEXT.renewed):
      // page one again under that token, so invoice 1 can be opened while the settings' sign-in is out.
      await click('issued-list-retry');
      await listReady();
      // The settings' own sign-in (SII-11): a Save refused step_up_required, then the explicit sign-in, held out while the
      // invoice is open again (SII-68's order).
      await click('issued-settings-open');
      await waitFor(() => expect(panelPhase()).not.toBe('loading'));
      fill();
      x.server.puts.push(chain(403, 'step_up_required'));
      await click('issued-settings-save');
      await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
      gate = new Promise<void>((done) => { release = done; });
      type('issued-settings-reauth-password', 'correct horse');
      await click('issued-settings-reauth-confirm'); // the sign-in is out
      await open(1);
      await waitFor(() => expect(screen.queryAllByTestId('issued-payments-credit-item')).toHaveLength(50));
      expect(screen.queryByTestId('issued-payments-credit-more')).not.toBeNull(); // page one, its cursor kept
      await waitFor(() => expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'exhausted'));
      const old = x.server.cnRequests('lookup').at(-1)!.headers.get('x-tmpos-session-csrf');
      await act(async () => { release(); });
      await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
      expect(screen.queryAllByTestId('issued-payments-credit-item')).toEqual([]);
      expect(screen.queryByTestId('issued-payments-credit-lookup')).toBeNull();
      expect(held(x.r)).toMatchObject({ csrf: null, baseline: null, shown: null });
      // An earlier note lands meanwhile: the new page one ends a row sooner than the old one, so the cursors differ.
      const notes = [...x.server.creditNotes.get(x.made[0].id)!]; // the 51, oldest first (as the list serves them)
      x.server.addCreditNotes(x.made[0].id, 1, () => ({}), -10);
      // The next open reads the list and the lookup from page one under the renewed token: no old cursor is sent.
      const lists = x.server.cnRequests('list').length;
      const lookups = x.server.cnRequests('lookup').length;
      await click('issued-list-retry');
      await listReady();
      await open(1);
      await waitFor(() => expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'exhausted'));
      await waitFor(() => expect(screen.queryAllByTestId('issued-payments-credit-item')).toHaveLength(50));
      const again = [...x.server.cnRequests('list').slice(lists), ...x.server.cnRequests('lookup').slice(lookups)];
      expect(again).not.toEqual([]);
      expect(again.map((s) => s.url).filter((u) => u.includes('?after='))).toEqual([]);
      expect(again.map((s) => s.headers.get('x-tmpos-session-csrf'))).not.toContain(old);
      // Show more after the reopen: page two's cursor is the NEW page one's last row (not the old 50th), under the new token.
      const pageOne = x.server.cnRequests('list').at(-1)!;
      expect(pageOne.url).toBe(`${STORES_PATH}/${STORE_1}/invoices/${x.made[0].id}/credit-notes`);
      const more = x.server.cnRequests('list').length;
      await click('issued-payments-credit-more');
      await waitFor(() => expect(screen.queryAllByTestId('issued-payments-credit-item')).toHaveLength(52));
      const pageTwo = x.server.cnRequests('list').slice(more);
      expect(pageTwo.map((s) => s.url)).toEqual([`${STORES_PATH}/${STORE_1}/invoices/${x.made[0].id}/credit-notes?after=${notes[48].id}`]);
      expect(pageTwo[0].headers.get('x-tmpos-session-csrf')).toBe(pageOne.headers.get('x-tmpos-session-csrf'));
      expect(pageTwo[0].headers.get('x-tmpos-session-csrf')).not.toBe(old);
    });

    it('P2-34, P2-35. the lookup decides only what it shows: a released or confirmed row ends the attempt; a row the lookup no longer lists is never settled from memory — notListed once an issue was sent (regUnknown before), lasting until Hide or a reload; after a reload an exhausted lookup with no row restores the action, claiming nothing', async () => {
      const x = await ready();
      x.server.cnScripts.issue.push('lose');
      await click('issued-credit-send');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
      x.server.cnRegs.splice(0); // aged out of the lookup (settled over 24 h ago): nothing listed
      await press('find');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.notListed));
      expect(cardText()).not.toMatch(/no credit note was issued/i);
      expect(x.server.cnRequests('settle')).toEqual([]);
      expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn);
      await press('hide');
      expect(control('heading')).toBeNull();
      expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn); // the blockers stay (D-P2-6)
      await reload(x.r);
      await open(1);
      await waitFor(() => expect(action()).toHaveAttribute('aria-disabled', 'false')); // an operational choice, not evidence (D-P2-5)
      expect(x.server.cnRequests('settle')).toEqual([]);
      cleanup();
      // A released row ends the attempt (forward only), and a confirmed one too.
      for (const settled of ['released', 'confirmed'] as const) {
        const y = await ready();
        y.server.cnScripts.issue.push(settled === 'released' ? 503 : 'lose');
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
        y.server.cnRegs[0].state = settled;
        y.server.cnRegs[0].settledAt = y.server.cnTick();
        await press('find');
        await waitFor(() => expect(cardText(), settled).toBe(settled === 'released' ? CREDIT_TEXT.released : CREDIT_TEXT.confirmed));
        expect(held(y.r)?.state).toBe(settled);
        expect(cardButtons()).toEqual([]);
        cleanup();
      }
    });

    it('P2-36, P2-62. a renewed session: a proof 404 (first send, Check again or Continue issuing) → cantContinue; an issue 404 → cantContinue; a replay 422 → replayGone — each with Look up attempt, never a "no credit note" text; the row then gives Release (version 1) or Confirm (version 2)', async () => {
      for (const where of ['proof first', 'proof check', 'proof continue', 'issue 404', 'replay 422'] as const) {
        const x = await (where === 'proof first' || where === 'issue 404' || where === 'replay 422' ? ready() : registeredOnly());
        if (where === 'proof first') x.server.cnScripts.proof.push(404);
        if (where === 'issue 404') x.server.cnScripts.issue.push(404);
        if (where === 'replay 422') x.server.cnScripts.issue.push('lose', chain(422, 'idempotency_key_reused'));
        if (where === 'proof check' || where === 'proof continue') {
          x.server.cnScripts.proof.push(404);
          await press(where === 'proof check' ? 'check' : 'continue');
        } else {
          await click('issued-credit-send');
          if (where === 'replay 422') { await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true))); await press('check'); }
        }
        const said = where === 'replay 422' ? CREDIT_TEXT.replayGone : CREDIT_TEXT.cantContinue;
        await waitFor(() => expect(cardText(), where).toBe(said));
        expect(cardButtons(), where).toEqual(where === 'replay 422' ? [CREDIT_TEXT.find, CREDIT_TEXT.hide] : [CREDIT_TEXT.find]);
        expect(tid('issued-payments').textContent, where).not.toMatch(/No credit note was issued/);
        expect(x.server.cnRequests('issue').length, where).toBe(where === 'issue 404' ? 1 : where === 'replay 422' ? 2 : 0);
        await press('find');
        const version = where === 'replay 422' ? 'confirm' : 'release';
        await waitFor(() => expect(screen.queryByTestId(`issued-payments-credit-row-${version}`), where).not.toBeNull());
        await press(version, 'issued-payments-credit-row');
        await waitFor(() => expect(cardText(), where).toBe(version === 'confirm' ? CREDIT_TEXT.confirmed : CREDIT_TEXT.released));
        cleanup();
      }
    });

    it('P2-37. a demoted owner: a settlement 403 → ONE fresh session check, the same token → the card keeps its last known state with no buttons (noAccess); a lookup 403 the same', async () => {
      const x = await ready();
      await click('issued-credit-send');
      await waitFor(() => expect(cardText()).toBe(issuedText));
      x.server.cnOwners.delete('uid-a');
      const from = x.server.sent.length;
      await press('confirm');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.noAccess));
      expect(cardButtons()).toEqual([]);
      expect(tid('issued-payments-credit-card')).toHaveAttribute('data-state', 'issued');
      expect(sentFrom(x.server, from).filter((s) => s === `GET ${TENANT_SESSION_PATHS.current}`).length).toBeGreaterThanOrEqual(1);
      cleanup();
      const y = await ready();
      y.server.cnScripts.issue.push('lose');
      await click('issued-credit-send');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
      y.server.cnOwners.delete('uid-a');
      await press('find');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.noAccess));
      expect(tid('issued-payments-credit-card-also').textContent).toBe(CREDIT_TEXT.unresolved(false)); // its words without the buttons
      expect(cardButtons()).toEqual([]);
      expect(tid('issued-payments-credit-card')).toHaveAttribute('data-state', 'issuing');
    });

    it('P2-37 (503 clause, scripted). 503 at register, proof, issue and settlement → regUnknown / registeredOnly / unresolved / settleUnknown', async () => {
      // The 503 is scripted with the owner kept (a real demotion here would get the fake chain's 403): it stands in for the
      // routine's own role check answering 503 (M38:1202) after the chain passed. The shop sees a 503 only: each stage's
      // unknown outcome with Check again and Look up attempt (§3.7), never noAccess; nothing runs on, and no text says no
      // credit note was issued.
      const cases = [
        ['register', CREDIT_TEXT.regUnknown, [1, 0, 0], 0],
        ['proof', CREDIT_TEXT.registeredOnly(true), [1, 0, 0], 1],
        ['issue', CREDIT_TEXT.unresolved(true), [1, 1, 0], 1],
        ['settle', CREDIT_TEXT.settleUnknown(true), [1, 1, 1], 1],
      ] as const;
      for (const [stage, said, sent, proofs] of cases) {
        const x = await ready();
        if (stage === 'settle') {
          await click('issued-credit-send');
          await waitFor(() => expect(cardText(), stage).toBe(issuedText));
        }
        x.server.cnScripts[stage].push(503);
        if (stage === 'settle') await press('confirm');
        else await click('issued-credit-send');
        await waitFor(() => expect(cardText(), stage).toBe(said));
        expect(control('check'), `${stage}: Check again`).not.toBeNull();
        expect(control('find'), `${stage}: Look up attempt`).not.toBeNull();
        await settle();
        expect(writes(x.server), stage).toEqual(sent); // nothing on its own after the 503 (§3.4)
        expect(x.server.cnRequests('proof'), stage).toHaveLength(proofs);
        if (stage === 'issue' || stage === 'settle') expect(tid('issued-payments').textContent, stage).not.toMatch(/No credit note was issued/);
        cleanup();
      }
    });

    it('P2-37 (503 clause, CA-35). an issue the server completed while this older tab still holds it unresolved: Check again resends the same key and bytes and gets 503; Look up attempt then shows that attempt issued, sending no write', async () => {
      // The fake commits the issue and loses its answer ('lose'); the retry's 503 is scripted after the chain, standing in for
      // the write setting `off`, whose gate answers before the key is looked up (doc 18 §6.6), so no replay reaches the tab.
      const x = await ready();
      x.server.cnScripts.issue.push('lose');
      await click('issued-credit-send');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
      expect(x.server.cnRegs.map((g) => g.state)).toEqual(['issued']); // completed on the server
      const [reg] = x.server.cnRegs;
      const notes = x.server.creditNotes.get(reg.invoiceId)?.length ?? 0;
      // The documented retry (doc 17 §3.7, "Lost reply at issue"): Check again, the same key and the same bytes, answered 503.
      x.server.cnScripts.issue.push(503);
      await press('check');
      await until(() => expect(x.server.cnRequests('issue')).toHaveLength(2));
      await settle();
      const [first, retry] = x.server.cnRequests('issue');
      expect(keyOf(retry)).not.toBeNull();
      expect(keyOf(retry)).toBe(keyOf(first));
      expect(retry.body).toBe(first.body);
      expect(JSON.parse(retry.body!).attemptId).toBe(reg.attemptId);
      expect(x.server.cnScripts.issue).toEqual([]); // the retry took the scripted 503
      expect(x.server.creditNotes.get(reg.invoiceId)?.length).toBe(notes); // no second note
      expect(cardText()).toBe(CREDIT_TEXT.unresolved(true));
      expect(control('find'), 'Look up attempt').not.toBeNull();
      expect(tid('issued-payments').textContent).not.toMatch(/No credit note was issued/);
      // Look up attempt: one read, no write, and the row it shows is this attempt, issued.
      const before = writes(x.server);
      const lookups = x.server.cnRequests('lookup').length;
      await press('find');
      await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-row-confirm')).not.toBeNull());
      const rows = screen.queryAllByTestId('issued-payments-credit-row');
      expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['issued']);
      expect(screen.getByTestId('issued-payments-credit-row-state').textContent).toBe(CREDIT_TEXT.rowIssued);
      expect(x.server.cnRegs.map((g) => [g.attemptId, g.state])).toEqual([[reg.attemptId, 'issued']]); // the only row the lookup lists
      expect(x.server.cnRequests('lookup')).toHaveLength(lookups + 1);
      expect(writes(x.server)).toEqual(before);
    });

    it('P2-38. Hide this attempt (hideWarning its description, apart from Check again) hides the card only: the action stays blockedOwn, Record payment and Void stay hidden here; a stored answer for the hidden attempt lifts them without showing a card or saying anything', async () => {
      const x = await ready({ prepare: (s) => { s.recorders.add('uid-a'); } });
      await stalled(x, 'cnRegister');
      expect(describedBy('issued-payments-credit-card-hide')).toBe(CREDIT_TEXT.hideWarning);
      expect(control('hide')!.parentElement).not.toBe(control('check')!.parentElement);
      await press('hide');
      expect(screen.queryByTestId('issued-payments-credit-card')).toBeNull();
      expect(held(x.r)?.hidden).toBe(true);
      expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn);
      expect([screen.queryByTestId('issued-payments-record'), screen.queryByTestId('issued-view-void')]).toEqual([null, null]);
      const said = [inlineSay(), inlineAlert()];
      x.server.held.shift()!.release(sealedAnswer('invalid_state'));
      await until(() => expect(held(x.r)?.state).toBe('ended'));
      await settle();
      expect(screen.queryByTestId('issued-payments-credit-card')).toBeNull();
      expect([inlineSay(), inlineAlert()]).toEqual(said);
      await until(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
      expect(screen.queryByTestId('issued-view-void')).not.toBeNull();
      expect(action()).toHaveAttribute('aria-disabled', 'false');
    });

    it('P2-40, P2-28 (13). stale answers change nothing: a Check again keeps the hold generation; an answer for an attempt detached by another token (its stored 201 included) or by a sign-out and Reconnect (the same generation number, another token) changes no text, focus or action — the lookup shows what the server did', async () => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const x = await ready();
      await stalled(x, 'cnIssue');
      const g = held(x.r)!.generation;
      x.server.cnScripts.issue.push(503);
      fireEvent.click(control('check')!);
      await until(() => expect(x.server.cnRequests('issue')).toHaveLength(2));
      await settle();
      expect(held(x.r)!.generation).toBe(g);
      x.server.otherTab('uid-a');
      await focusEvents();
      await until(() => expect(held(x.r)?.csrf).toBeNull());
      await settle();
      const before = () => [cardText('issued-credit-card'), cardButtons('issued-credit-card'), document.activeElement, tid('issued-credit-alert').textContent];
      const was = before();
      x.server.held.shift()!.release(); // the original commits now: its stored 201 belongs to no live attempt
      await settle();
      expect(before()).toEqual(was);
      expect(held(x.r)?.state).toBe('issuing');
      vi.useRealTimers();
      await showAndChoose(STORE_1);
      await press('find', 'issued-credit-card');
      await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowIssued]));
      cleanup();
      const y = await ready();
      y.server.hold.cnIssue = 1;
      await click('issued-credit-send');
      await until(() => expect(y.server.held.length).toBe(1));
      y.server.expire();
      await focusEvents();
      await waitFor(() => expect(screen.queryByTestId('issued-retry')).not.toBeNull());
      await click('issued-retry');
      await storesReady();
      expect(held(y.r)?.csrf).toBeNull();
      const then = () => [cardText('issued-credit-card'), cardButtons('issued-credit-card'), tid('issued-credit-alert').textContent];
      const had = then();
      y.server.held.shift()!.release();
      await settle();
      expect(then()).toEqual(had);
      expect(held(y.r)?.state).toBe('issuing');
      expect(y.server.cnRequests('settle')).toEqual([]); // T-02: never a confirm sent
    });

    it('P2-41. a reload forgets the attempt (memory only): on open the lookup finds this owner\'s unsettled rows for the invoice and shows each with its own action — Confirm for an issued row, Release for an open one — and no Check again; nothing is sent on mount', async () => {
      const x = await ready();
      x.server.cnScripts.issue.push('lose');
      await click('issued-credit-send');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
      x.server.addCreditReg({ invoiceId: x.made[1].id, number: 2 });
      const writesBefore = x.server.writes();
      await reload(x.r);
      await open(1);
      await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowIssued]));
      expect(screen.queryByTestId('issued-payments-credit-card')).toBeNull();
      expect(screen.queryAllByRole('button', { name: CREDIT_TEXT.checkAgain })).toEqual([]);
      expect(describedBy('issued-payments-credit-issue')).toBe(CREDIT_TEXT.blockedOwn);
      expect(x.server.writes()).toEqual(writesBefore);
      await press('confirm', 'issued-payments-credit-row');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
      await click('issued-view-close');
      await open(2);
      await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowOpen(AT(x.r))]));
      expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull();
    });

    it('P2-66. Continue issuing blocked by the window: the shop-observed sign-in over 8 minutes → continueLapsed with Look up attempt; no sign-in is offered and no issue is sent (the press\'s reads may go out)', async () => {
      const x = await registeredOnly();
      x.r.clock.mono += 8 * 60_000 + 1_000;
      x.r.clock.wall += 8 * 60_000 + 1_000;
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.continueLapsed));
      expect(tid('issued-payments-credit-card-also').textContent).toBe(CREDIT_TEXT.registeredOnly(false));
      expect(cardButtons()).toEqual([CREDIT_TEXT.find]);
      expect(screen.queryByTestId('issued-credit-reauth-password')).toBeNull();
      expect(x.server.cnRequests('issue')).toEqual([]);
      expect(held(x.r)?.issue).toBeNull();
    });

    it('P2-69, P2-42. a Continue issuing review that fails says why and sends no register, issue or settlement: Remaining fell (another session\'s payment or credit) → overRemaining, the amounts read again; voided → voided; a proof 404 → cantContinue; a proof 503 → registeredOnly stays; a proof 403 → one fresh check, the same token → noAccessShort with no buttons', async () => {
      for (const kind of ['remaining', 'voided', 'proof 404', 'proof 503', 'proof 403'] as const) {
        const x = await registeredOnly();
        const w = writes(x.server);
        if (kind === 'remaining') x.server.credits.set(x.made[0].id, 2000);
        if (kind === 'voided') x.made[0].void = { voidedAt: '2026-10-18T11:00:00.000001Z', reasonCode: 'other' };
        if (kind.startsWith('proof')) x.server.cnScripts.proof.push(kind === 'proof 404' ? 404 : kind === 'proof 503' ? 503 : 403);
        await press('continue');
        const said = { remaining: CREDIT_TEXT.overRemaining, voided: CREDIT_TEXT.voided, 'proof 404': CREDIT_TEXT.cantContinue, 'proof 503': CREDIT_TEXT.registeredOnly(true), 'proof 403': CREDIT_TEXT.registeredOnly(false) }[kind];
        await waitFor(() => expect(cardText(), kind).toBe(said));
        if (kind === 'proof 403') {
          expect(tid('issued-payments-credit-card-also').textContent).toBe(CREDIT_TEXT.noAccessShort);
          expect(cardButtons()).toEqual([]);
        } else expect(cardButtons(), kind).toContain(CREDIT_TEXT.find);
        if (kind === 'remaining') await waitFor(() => expect(tid('issued-payments-remaining')).toHaveTextContent('$1.76'));
        expect(writes(x.server), kind).toEqual(w);
        cleanup();
      }
    });

    it('P2-84 (C). continuation eligibility, each of E1-E7 failing alone, says its text and sends no register, issue or settlement (reads may go out): E1 its own row issued → that state; E2 another token → continueAfterSignIn; E3 the lookup stopped → lookupIncomplete, another unfinished row here → unfinished; E4 another note → anotherNoteFound; E5 a proof 503 → registeredOnly; E6 lapsed → continueLapsed; E7 the key already taken → nothing sent. Its own row not listed passes E1 (its proof goes out)', async () => {
      const cases = ['E1', 'E1 unlisted', 'E2', 'E3 incomplete', 'E3 unfinished', 'E4', 'E5', 'E6', 'E7'] as const;
      for (const e of cases) {
        const x = await registeredOnly();
        const w = writes(x.server);
        const proofs = x.server.cnRequests('proof').length;
        const g = x.server.cnRegs[0];
        if (e === 'E1') {
          const [note] = x.server.addCreditNotes(x.made[0].id, 1, () => ({ issuedAt: x.server.cnTick() }));
          g.state = 'issued';
          g.creditNote = { id: note.id, issuedAt: note.issuedAt, withdrawnAt: null };
        }
        if (e === 'E1 unlisted') x.server.cnRegs.splice(0);
        if (e === 'E2') x.server.otherTab('uid-a');
        if (e === 'E3 incomplete') x.server.cnScripts.lookup.push(503);
        if (e === 'E3 unfinished') x.server.addCreditReg({ invoiceId: x.made[0].id });
        if (e === 'E4') x.server.addCreditNotes(x.made[0].id, 1, () => ({ issuedAt: x.server.cnTick() }));
        if (e === 'E5') x.server.cnScripts.proof.push(503);
        if (e === 'E6') { x.r.clock.mono += 8 * 60_000 + 1_000; x.r.clock.wall += 8 * 60_000 + 1_000; }
        if (e === 'E7') x.server.hold.cnProof = 1;
        fireEvent.click(control('continue')!);
        if (e === 'E7') {
          // Another contender claims the one key while this press's proof is out (§2.6 item 2).
          await until(() => expect(x.server.held.length).toBe(1));
          const h = held(x.r)!;
          const body = creditNoteIssueBodyOf({ expectedTenant: TENANT_A, registrationId: g.id, attemptId: h.attemptId, grossCents: 500, reason: 'goodwill', registrationProof: g.proof })!;
          expect(x.r.cnHolds.claimIssueKey('uid-a', h.attemptId, h.generation, uuid(0xe7e7), body)).toBe('claimed');
          x.server.held.shift()!.release();
        }
        const said: Record<typeof e, [string, string]> = {
          E1: ['issued-payments-credit-card', CREDIT_TEXT.alreadyIssued], 'E1 unlisted': ['issued-payments-credit-card', CREDIT_TEXT.cantContinue],
          E2: ['issued-credit-card', CREDIT_TEXT.continueAfterSignIn], 'E3 incomplete': ['issued-payments-credit-card', CREDIT_TEXT.lookupIncomplete],
          'E3 unfinished': ['issued-payments-credit-card', CREDIT_TEXT.unfinished], E4: ['issued-payments-credit-card', CREDIT_TEXT.anotherNoteFound],
          E5: ['issued-payments-credit-card', CREDIT_TEXT.registeredOnly(true)], E6: ['issued-payments-credit-card', CREDIT_TEXT.continueLapsed],
          E7: ['issued-payments-credit-card', CREDIT_TEXT.registeredOnly(false)],
        };
        await until(() => expect(cardText(said[e][0]), e).toBe(said[e][1]));
        await settle();
        expect(writes(x.server), e).toEqual(w);
        if (e === 'E1 unlisted' || e === 'E5' || e === 'E6') expect(x.server.cnRequests('proof').length, e).toBe(proofs + 1);
        if (e === 'E1' || e === 'E3 unfinished') expect(screen.queryAllByTestId('issued-payments-credit-row').length, e).toBeGreaterThan(0);
        if (e === 'E7') expect(held(x.r)?.issue?.key).toBe(uuid(0xe7e7));
        cleanup();
      }
    });

    it('P2-78. a late proof against Continue issuing: the proof times out, Continue issuing is pressed, then the first proof\'s 200 arrives — stale (not the attempt\'s latest proof); only the press\'s own proof 200 claims the key: one issue key, one issue', async () => {
      const x = await ready();
      x.server.hold.cnProof = 1;
      fakeClock();
      fireEvent.click(tid('issued-credit-send'));
      await until(() => expect(x.server.held.length).toBe(1));
      await pass(x.r, 30_000);
      await until(() => expect(control('continue')).not.toBeNull());
      fireEvent.click(control('continue')!);
      await until(() => expect(cardText()).toBe(issuedText));
      x.server.held.shift()!.release();
      await settle();
      expect(cardText()).toBe(issuedText);
      expect(x.server.cnRequests('proof')).toHaveLength(2);
      expect(x.server.cnRequests('issue')).toHaveLength(1);
      expect(held(x.r)?.issue?.key).toBe(keyOf(x.server.cnRequests('issue')[0]));
    });

    it('P2-87 (C). D-P2-15 beyond page one: a baseline read to nextCursor null over 51 notes, one withdrawn since (still listed: not new), and another session\'s note landing past page one → anotherNoteFound with that note only; a baseline of page one only → anotherNoteUnknown; a baseline id missing from a complete current read → anotherNoteUnknown', async () => {
      const x = await registeredOnly({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); } });
      expect(held(x.r)?.baseline?.complete).toBe(true);
      expect(held(x.r)?.baseline?.ids).toHaveLength(51);
      const notes = x.server.creditNotes.get(x.made[0].id)!;
      notes[3].withdrawal = { withdrawnAt: x.server.cnTick(), reason: 'entered_in_error', withdrawnByName: null };
      const [late] = x.server.addCreditNotes(x.made[0].id, 1, () => ({ issuedAt: x.server.cnTick() }));
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteFound));
      expect(screen.getAllByTestId('issued-payments-credit-card-note').map((n) => n.getAttribute('data-id'))).toEqual([late.id]);
      expect(held(x.r)?.shown).toEqual({ ids: [late.id], complete: true });
      expect(x.server.cnRequests('issue')).toEqual([]);
      cleanup();
      // Page one only: the baseline's page two failed (a 503) — the comparison cannot be complete.
      let failPageTwo = true;
      const y = await registeredOnly({
        prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); },
        fetch: (server) => (async (input: RequestInfo | URL, init: RequestInit = {}) => (
          failPageTwo && /\/credit-notes\?after=/.test(String(input)) ? json(503, { error: 'service_unavailable', requestId: 'req-synthetic' }) : server.fetch(input, init)
        )) as typeof globalThis.fetch,
      });
      expect(held(y.r)?.baseline).toMatchObject({ complete: false });
      expect(held(y.r)?.baseline?.ids).toHaveLength(50);
      failPageTwo = false;
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteUnknown));
      expect(held(y.r)?.shown?.complete).toBe(false);
      expect(held(y.r)?.shown?.ids).toHaveLength(51);
      cleanup();
      // A baseline id missing from a complete read now (notes are never deleted: the shop cannot compare, so it says so).
      const z = await registeredOnly({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
      z.server.creditNotes.set(z.made[0].id, z.server.creditNotes.get(z.made[0].id)!.slice(1));
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteUnknown));
      expect(z.server.cnRequests('issue')).toEqual([]);
    });

    it('P2-88. an incomplete comparison: a failed baseline does not block the fresh issue; Continue issuing → anotherNoteUnknown, focus on Look up attempt; "Issue another credit note" with the stated uncertainty persisting and no unshown id sends exactly one issue; a newly seen unshown id updates the card and sends nothing; an anotherNoteFound card with a complete comparison whose re-read fails states the uncertainty and sends nothing until another press', async () => {
      let failList = true;
      const failing = (server: Server) => (async (input: RequestInfo | URL, init: RequestInit = {}) => (
        failList && /\/credit-notes(\?|$)/.test(String(input)) && (init.method ?? 'GET') === 'GET' ? json(503, { error: 'service_unavailable', requestId: 'req-synthetic' }) : server.fetch(input, init)
      )) as typeof globalThis.fetch;
      const x = await registeredOnly({ fetch: failing });
      expect(held(x.r)?.baseline).toEqual({ ids: [], complete: false });
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteUnknown));
      await waitFor(() => expect(document.activeElement).toBe(tid('issued-payments-credit-card-find')));
      expect(x.server.cnRequests('issue')).toEqual([]);
      await press('another'); // the list still fails: the uncertainty it stated persists, no unshown id
      await waitFor(() => expect(cardText()).toBe(issuedText));
      expect(x.server.cnRequests('issue')).toHaveLength(1);
      cleanup();
      // A newly seen, unshown id: the card says so and nothing is sent until another press.
      failList = true;
      const y = await registeredOnly({ fetch: failing });
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteUnknown));
      failList = false;
      const [seen] = y.server.addCreditNotes(y.made[0].id, 1, () => ({ issuedAt: y.server.cnTick() }));
      await press('another');
      await waitFor(() => expect(held(y.r)?.shown?.ids).toEqual([seen.id]));
      expect(cardText()).toBe(CREDIT_TEXT.anotherNoteUnknown);
      expect(screen.getAllByTestId('issued-payments-credit-card-note').map((n) => n.getAttribute('data-id'))).toEqual([seen.id]);
      expect(y.server.cnRequests('issue')).toEqual([]);
      await press('another');
      await waitFor(() => expect(cardText()).toBe(issuedText));
      expect(y.server.cnRequests('issue')).toHaveLength(1);
      cleanup();
      // anotherNoteFound with a complete comparison; its re-read fails: the uncertainty is stated, nothing sent; the next press sends.
      failList = false;
      const z = await registeredOnly({ fetch: failing });
      const [found] = z.server.addCreditNotes(z.made[0].id, 1, () => ({ issuedAt: z.server.cnTick() }));
      await press('continue');
      await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.anotherNoteFound));
      expect(held(z.r)?.shown).toEqual({ ids: [found.id], complete: true });
      failList = true;
      await press('another');
      await waitFor(() => expect(held(z.r)?.shown).toEqual({ ids: [found.id], complete: false }));
      expect([cardText(), tid('issued-payments-credit-card-also').textContent]).toEqual([CREDIT_TEXT.anotherNoteFound, CREDIT_TEXT.anotherNoteUnknown]);
      expect(z.server.cnRequests('issue')).toEqual([]);
      await press('another');
      await waitFor(() => expect(cardText()).toBe(issuedText));
      expect(z.server.cnRequests('issue')).toHaveLength(1);
    });

    it('P2-70 (C). a reload with a register in flight: the lookup shows no row and a new attempt registers — the old one committing first makes the new one a sealed write_conflict → unfinished → the lookup re-read shows the old row open → Release → released → the action is back, nothing started on its own; the new one first leaves the old one a sealed write_conflict', async () => {
      for (const first of ['old', 'new'] as const) {
        const x = await ready();
        x.server.hold.cnRegister = 1;
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(x.server.held.length).toBe(1));
        const old = x.server.held.shift()!;
        const oldKey = x.r.keys[1];
        await reload(x.r);
        await open(1);
        await waitFor(() => expect(action()).toHaveAttribute('aria-disabled', 'false'));
        expect(rowStates()).toEqual([]);
        await toConfirm();
        await signIn();
        if (first === 'old') { old.release(); await settle(); }
        await click('issued-credit-send');
        if (first === 'old') {
          await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.unfinished));
          await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowOpen(AT(x.r))]));
          await press('release', 'issued-payments-credit-row');
          await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.released));
          await waitFor(() => expect(action()).toHaveAttribute('aria-disabled', 'false'));
          await settle();
          expect(x.server.cnRequests('register')).toHaveLength(2);
          expect(x.server.cnRequests('issue')).toEqual([]);
        } else {
          await waitFor(() => expect(cardText()).toBe(issuedText));
          old.release();
          await settle();
          expect(x.server.keys.get(oldKey)?.body).toEqual({ error: 'write_conflict' });
          expect(x.server.cnRegs.map((g) => g.attemptId)).not.toContain(x.r.keys[0]);
        }
        cleanup();
      }
    });

    it('P2-71, P2-72 (C). a reload with the issue in flight: the fresh lookup shows the row open. Release first → 200 released, then the late issue is a sealed invalid_state: no credit note from this attempt, Remaining unchanged; the issue first → Release is a sealed write_conflict → the lookup shows it issued → Confirm → confirmed', async () => {
      for (const first of ['release', 'issue'] as const) {
        const x = await ready();
        x.server.hold.cnIssue = 1;
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(x.server.held.length).toBe(1));
        const late = x.server.held.shift()!;
        const issueKey = x.r.keys[2];
        await reload(x.r);
        await open(1);
        await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowOpen(AT(x.r))]));
        if (first === 'issue') { late.release(); await settle(); }
        await press('release', 'issued-payments-credit-row');
        if (first === 'release') {
          await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.released));
          late.release();
          await settle();
          expect(x.server.keys.get(issueKey)?.body).toEqual({ error: 'invalid_state' });
          expect(x.server.creditNotes.get(x.made[0].id) ?? []).toEqual([]);
          await waitFor(() => expect(tid('issued-payments-remaining')).toHaveTextContent('$21.76'));
        } else {
          await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowIssued]));
          await press('confirm', 'issued-payments-credit-row');
          await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
          expect(x.server.creditNotes.get(x.made[0].id)).toHaveLength(1);
        }
        cleanup();
      }
    });

    it('P2-73 (C). a reload with the settlement in flight: the fresh lookup shows the old state (issued); two keys asking for the same target, in both orders — exactly one transition (settled once), the other answering 200 unchanged', async () => {
      for (const first of ['fresh', 'old'] as const) {
        const x = await ready();
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(issuedText));
        x.server.hold.cnSettle = 1;
        await press('confirm');
        await until(() => expect(x.server.held.length).toBe(1));
        const old = x.server.held.shift()!;
        const oldKey = x.r.keys[3];
        await reload(x.r);
        await open(1);
        await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowIssued]));
        const g = x.server.cnRegs[0];
        if (first === 'old') { old.release(); await settle(); }
        const settledAt = g.settledAt;
        await press('confirm', 'issued-payments-credit-row');
        await waitFor(() => expect(cardText(), first).toBe(CREDIT_TEXT.confirmed));
        if (first === 'fresh') {
          const once = g.settledAt;
          old.release();
          await settle();
          expect(g.settledAt).toBe(once);
          expect(x.server.keys.get(oldKey)?.body).toMatchObject({ settlement: { state: 'confirmed' } });
        } else expect(g.settledAt).toBe(settledAt);
        expect(g.state).toBe('confirmed');
        expect(new Set(x.server.cnRequests('settle').map(keyOf)).size).toBe(2);
        cleanup();
      }
    });

    it('P2-06 (recovery), D-P2-10 A. Void and Reverse are hidden on every invoice while the attempt can still Continue issuing, and come back once it cannot (the sign-in past 8 minutes, the register decided)', async () => {
      const x = await registeredOnly({ count: 3 });
      await click('issued-view-close');
      await click('issued-list-retry'); // the sign-in cleared the list read before it (LIST_TEXT.renewed)
      await listReady();
      await open(3);
      await settle();
      expect(screen.queryByTestId('issued-view-void')).toBeNull();
      await click('issued-view-close');
      x.r.clock.mono += 8 * 60_000 + 1_000;
      x.r.clock.wall += 8 * 60_000 + 1_000;
      await open(3);
      await waitFor(() => expect(screen.queryByTestId('issued-view-void')).not.toBeNull());
      expect(creditNoteHoldsSignIns(held(x.r), x.r.clock.mono, x.r.clock.wall)).toBe(false);
    });

    describe('fix list 1 (the chair-adjudicated review fixes)', () => {
      /** ready(), then the issue's answer lost after it committed: unresolved with Check again and Look up attempt (no fake timers). */
      async function lostIssue(o: Parameters<typeof ready>[0] = {}) {
        const x = await ready(o);
        x.server.cnScripts.issue.push('lose');
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
        return x;
      }
      const sectionCard = 'issued-credit-card';

      it('F1 (A11Y-1). a card\'s second line is announced with its line, once: a Check again 429 at the issue → the alert region says unresolved and rateLimitedWait together', async () => {
        const x = await lostIssue();
        x.server.cnScripts.issue.push(chain(429, 'rate_limited', { 'retry-after': '7' }));
        await press('check');
        await until(() => expect(control('also')?.textContent).toBe(CREDIT_TEXT.rateLimitedWait(7)));
        expect(inlineAlert()).toBe(`${CREDIT_TEXT.unresolved(false)} ${CREDIT_TEXT.rateLimitedWait(7)}`);
        expect(x.server.cnRequests('settle')).toEqual([]);
      });

      it('F2 (SEC-1, ASY-4, CR-4). a confirmed same-token denial leaves a DETACHED card with no buttons (no Look up attempt, no Hide); a later known session change gives it back Look up attempt and Hide', async () => {
        const x = await lostIssue();
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        x.server.otherTab('uid-a'); // another tab's sign-in: a new token, adopted on the tab's return
        await focusEvents();
        await until(() => expect(held(x.r)?.csrf).toBeNull());
        await showAndChoose(STORE_1);
        await listReady();
        await until(() => expect(cardButtons(sectionCard)).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]));
        x.server.cnOwners.delete('uid-a'); // demoted under that same token: the lookup's 403, the one check confirms it
        await press('find', sectionCard);
        await until(() => expect(cardText(sectionCard)).toBe(CREDIT_TEXT.noAccess));
        expect(cardButtons(sectionCard)).toEqual([]);
        expect(creditNamedOutside(tid('issued-section'))).toEqual([]); // T-g: the three approved names only
        x.server.otherTab('uid-a');
        await focusEvents();
        await showAndChoose(STORE_1);
        await listReady();
        await until(() => expect(cardButtons(sectionCard)).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]));
        expect(x.server.cnRequests('settle')).toEqual([]);
        vi.restoreAllMocks();
      });

      it('F3 (CR-1). a hold put from a lookup row (no issue sent by it) whose row the lookup no longer lists → notListed, never regUnknown ("No credit note was issued")', async () => {
        const x = await lostIssue();
        await reload(x.r);
        await open(1);
        await until(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowIssued]));
        x.server.cnScripts.settle.push(503);
        await click('issued-payments-credit-row-confirm');
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.settleUnknown(true)));
        x.server.cnRegs.splice(0); // settled over 24 h ago elsewhere: the lookup no longer lists it
        await press('find');
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.notListed));
        expect(creditNamedOutside(tid('issued-section'))).toEqual([]); // T-g: the three approved names only
        expect(tid('issued-section').textContent).not.toMatch(/No credit note was issued/);
      });

      it('F4 (ASY-1). the page left while a stage was out (the section unmounted, the hold kept): its answer still counts, and the card back offers what its stage allows — issued with Confirm; registered with Continue issuing', async () => {
        for (const stage of ['issue', 'register'] as const) {
          const x = await ready();
          x.server.hold[stage === 'issue' ? 'cnIssue' : 'cnRegister'] = 1;
          fireEvent.click(tid('issued-credit-send'));
          await until(() => expect(x.server.held.length, stage).toBe(1));
          cleanup(); // another page of the app: the section goes, the module-level hold stays
          x.server.held.shift()!.release();
          await settle();
          expect(held(x.r)?.state, stage).toBe(stage === 'issue' ? 'issued' : 'registered');
          expect([x.server.cnRequests('proof').length, x.server.cnRequests('issue').length], stage).toEqual(stage === 'issue' ? [1, 1] : [0, 0]);
          render(<ServerIssuedInvoices {...x.r.props()} />);
          await showAndChoose(STORE_1);
          await listReady();
          if (stage === 'issue') {
            expect(cardText(sectionCard)).toBe(issuedText);
            expect(cardButtons(sectionCard)).toContain(CREDIT_TEXT.confirm);
          } else {
            expect(cardText(sectionCard)).toBe(CREDIT_TEXT.registeredOnly(true));
            expect(cardButtons(sectionCard)).toContain(CREDIT_TEXT.continueIssuing);
          }
          expect(creditNamedOutside(tid('issued-section'))).toEqual([]); // T-g: the three approved names only
          expect(x.server.cnRequests('settle'), stage).toEqual([]);
          cleanup();
        }
      });

      it('F5 (SF-1). a press that throws (the client never rejects; staged here) fails closed: internalError with Look up attempt, busy released, no unhandled rejection', async () => {
        const server = seeded();
        issueAt(server, STORE_1, 2);
        server.cnOwners.add('uid-a');
        const r = rig(server);
        const real = r.props().issuing;
        const issuing = { ...real, creditNoteProof: () => { throw new Error('synthetic'); } } as typeof real;
        render(<ServerIssuedInvoices {...r.props({ issuing })} />);
        await showAndChoose(STORE_1);
        await listReady();
        await open(1);
        await toConfirm();
        await signIn();
        await click('issued-credit-send');
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.internalError));
        expect(cardButtons()).toContain(CREDIT_TEXT.find);
        expect(control('find')).toHaveAttribute('aria-disabled', 'false');
        expect(server.cnRequests('issue')).toEqual([]);
      });

      it('F6 (SF-5, ATTR-01). two stored register answers that differ (the original\'s 201, a Check again\'s sealed 409) fail closed: internalError with Look up attempt', async () => {
        const x = await ready();
        await stalled(x, 'cnRegister');
        x.server.hold.cnRegister = 1;
        fireEvent.click(control('check')!);
        await until(() => expect(x.server.held.length).toBe(2));
        x.server.held.shift()!.release();
        await until(() => expect(held(x.r)?.state).toBe('registered'));
        x.server.held.shift()!.release(sealedAnswer('write_conflict'));
        await settle();
        expect(cardText()).toBe(CREDIT_TEXT.internalError);
        expect(cardButtons()).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]);
        expect([x.server.cnRequests('proof'), x.server.cnRequests('issue')]).toEqual([[], []]);
      });

      it('F7 (SF-7b). a sealed 409 word the outcome table does not list fails closed (internalError, Look up attempt, the hold kept): at the register it never ends the attempt; at the issue it never says "No credit note was issued"', async () => {
        for (const stage of ['register', 'issue'] as const) {
          const x = await ready();
          x.server.cnScripts[stage].push(sealedAnswer('unlisted_word'));
          await click('issued-credit-send');
          await waitFor(() => expect(cardText(), stage).toBe(CREDIT_TEXT.internalError));
          expect(held(x.r)?.state, stage).toBe(stage === 'register' ? 'registering' : 'issuing');
          expect(cardButtons(), stage).toContain(CREDIT_TEXT.find);
          expect(tid('issued-section').textContent, stage).not.toMatch(/No credit note was issued/);
          cleanup();
        }
      });

      it('F8 (SF-3). Check again whose session read fails (no sign-out, no wait) says the shipped unavailable text; the card keeps its line and Check again', async () => {
        const x = await lostIssue();
        x.server.currentStatus.push(503);
        const before = x.server.cnRequests('issue').length;
        await press('check');
        await until(() => expect(inlineAlert()).toBe(ISSUED_TEXT.unavailable));
        expect(x.server.cnRequests('issue')).toHaveLength(before);
        expect(cardText()).toBe(CREDIT_TEXT.unresolved(true));
        expect(cardButtons()).toContain(CREDIT_TEXT.checkAgain);
      });

      it('F8 (SF-6). a lookup row the hold cannot move to (released after it was known issued) fails closed instead of saying released', async () => {
        const x = await ready();
        x.server.cnScripts.issue.push(sealedAnswer('already_issued'));
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.alreadyIssued));
        const g = x.server.cnRegs.find((y) => y.attemptId === x.r.keys[0])!;
        const [note] = x.server.addCreditNotes(x.made[0].id, 1, () => ({ issuedAt: x.server.cnTick() }));
        g.state = 'issued';
        g.creditNote = { id: note.id, issuedAt: note.issuedAt, withdrawnAt: null };
        await click('issued-payments-credit-card-find');
        await waitFor(() => expect(held(x.r)?.state).toBe('issued'));
        Object.assign(g, { state: 'released', settledAt: x.server.cnTick(), creditNote: null }); // a server inconsistency
        await click('issued-payments-credit-card-find');
        await waitFor(() => expect(rowStates()).toEqual([CREDIT_TEXT.rowReleased]));
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.internalError));
        expect(held(x.r)?.state).toBe('issued');
      });

      it('F9 (SEC-3). a settings read\'s 403 the one check confirms with the same token is rule 4 for the section: the credit-note card keeps its last state with no buttons', async () => {
        const x = await lostIssue();
        await click('issued-view-close');
        await until(() => expect(cardButtons(sectionCard)).toContain(CREDIT_TEXT.find));
        x.server.getStatus.push(403);
        await click('issued-settings-open');
        await waitFor(() => expect(panelPhase()).toBe('denied'));
        await until(() => expect(cardButtons(sectionCard)).toEqual([]));
        expect(cardText(sectionCard)).toBe(CREDIT_TEXT.noAccess);
        expect(x.server.cnRequests('settle')).toEqual([]);
      });

      it('F10 (SEC-4). a 403 confirmed with the same token after the hold DETACHED (a store switch) is not rule 4: the detached card keeps Look up attempt and Hide', async () => {
        const x = await ready();
        x.server.hold.cnIssue = 1;
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(x.server.held.length).toBe(1));
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
        await until(() => expect(held(x.r)?.csrf).toBeNull());
        x.server.held.shift()!.release(chain(403, 'forbidden'));
        await settle();
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
        await until(() => expect(cardButtons(sectionCard)).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]));
      });

      it('T-c (T-03), P2-40, P2-28 (13) "replaced". attempt A ends while its register\'s first send is still out; attempt B starts and is issued; A\'s late answer then changes nothing on B — text, buttons, focus and the request log', async () => {
        const x = await ready();
        await stalled(x, 'cnRegister');
        x.server.cnScripts.register.push(sealedAnswer('write_conflict')); // the Check again: the slot rule — A ends (unfinished)
        await press('check');
        await until(() => expect(held(x.r)?.state).toBe('ended'));
        vi.useRealTimers();
        const a = held(x.r)!.attemptId;
        await waitFor(() => expect(action()).toHaveAttribute('aria-disabled', 'false'));
        await toConfirm();
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(issuedText));
        expect(held(x.r)?.attemptId).not.toBe(a);
        await settle(); // the closed confirmation's queued focus to B's card heading lands first
        const before = () => [cardText(), cardButtons(), document.activeElement, inlineSay(), inlineAlert(), held(x.r)?.state];
        const was = before();
        const sent = x.server.sent.length;
        x.server.held.shift()!.release(); // A's original register, decided now
        await settle();
        expect(before()).toEqual(was);
        expect(x.server.sent.slice(sent).filter((r) => !r.url.startsWith('/api/v1/session'))).toEqual([]);
        expect(x.server.cnRequests('settle')).toEqual([]);
        expect(creditNamedOutside(tid('issued-section'))).toEqual([]);
      });

      it('T-d (T-07), P2-28 (12). a late register 201 after the attempt was released, and a late proof 200 after it was issued, change no state and restore no action', async () => {
        for (const late of ['register after released', 'proof after issued'] as const) {
          const x = await ready();
          if (late === 'register after released') {
            await stalled(x, 'cnRegister');
            await press('check'); // the replay answers 201
            await until(() => expect(cardText(), late).toBe(CREDIT_TEXT.registeredOnly(true)));
            await press('find');
            await until(() => expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull());
            fireEvent.click(tid('issued-payments-credit-row-release'));
            await until(() => expect(held(x.r)?.state, late).toBe('released'));
          } else {
            x.server.hold.cnProof = 1;
            fakeClock();
            fireEvent.click(tid('issued-credit-send'));
            await until(() => expect(x.server.held.length).toBe(1));
            await pass(x.r, 30_000);
            await until(() => expect(control('continue')).not.toBeNull());
            await press('continue'); // its own proof (not held), then the issue
            await until(() => expect(held(x.r)?.state, late).toBe('issued'));
          }
          const before = () => [cardText(), cardButtons(), held(x.r)?.state, writes(x.server)];
          const was = before();
          x.server.held.shift()!.release();
          await settle();
          expect(before(), late).toEqual(was);
          expect(x.server.cnRequests('settle').length, late).toBe(late === 'register after released' ? 1 : 0); // only the Release itself
          expect(creditNamedOutside(tid('issued-section')), late).toEqual([]);
          vi.useRealTimers();
          cleanup();
        }
      });

      it('T-e (T-08). the windows at both edges, as literal constants: 8 minutes for a first send (inclusive), 9 for a Check again counted from the sign-in, 23 hours for a settlement replay (both exclusive) — each the larger of the monotonic and wall-clock times, so a short wall with a long monotonic time (and the reverse) has passed', () => {
        expect([CREDIT_NOTE_FIRST_SEND_MS, CREDIT_NOTE_REPLAY_MS, CREDIT_NOTE_SETTLE_REPLAY_MS]).toEqual([480_000, 540_000, 82_800_000]);
        const at = { mono: 1_000, wall: Date.UTC(2026, 10, 16, 12) };
        const after = (mono: number, wall: number) => [at.mono + mono, at.wall + wall] as const;
        expect([0, 480_000, 480_001].map((d) => signInFresh(at, ...after(d, d)))).toEqual([true, true, false]);
        expect([signInFresh(at, ...after(480_001, 0)), signInFresh(at, ...after(0, 480_001))]).toEqual([false, false]);
        const bytes = { key: 'k', body: 'b', firstMono: at.mono, firstWall: at.wall, completion: null, unstored: false };
        const h = { csrf: 'c', signIn: at, register: bytes, issue: bytes, settle: { ...bytes, version: 2 } } as unknown as HeldCreditNote;
        for (const stage of ['register', 'issue'] as const) {
          expect([539_999, 540_000].map((d) => replayWindowOpen(h, stage, ...after(d, d))), stage).toEqual([true, false]);
          expect([replayWindowOpen(h, stage, ...after(540_000, 0)), replayWindowOpen(h, stage, ...after(0, 540_000))], stage).toEqual([false, false]);
        }
        expect([82_799_999, 82_800_000].map((d) => replayWindowOpen(h, 'settle', ...after(d, d)))).toEqual([true, false]);
        expect([replayWindowOpen(h, 'settle', ...after(82_800_000, 0)), replayWindowOpen(h, 'settle', ...after(0, 82_800_000))]).toEqual([false, false]);
      });

      it('F21 (A11Y-10). checkUntil is said through the status region (§2.6) when Check again is offered', async () => {
        await lostIssue();
        await until(() => expect(control('until')).not.toBeNull());
        expect(inlineSay()).toBe(control('until')!.textContent);
        expect(inlineAlert()).toBe(CREDIT_TEXT.unresolved(true)); // the line keeps its own region
      });

      it('F15 (ASY-2). busy has an owner: a Check again that answers while a later one is still out does not give the presses back', async () => {
        const x = await ready();
        await stalled(x, 'cnIssue');
        x.server.hold.cnIssue = 2;
        await press('check'); // #2, held
        await pass(x.r, 30_000); // its 30 s: offered again
        await until(() => expect(control('check')).toHaveAttribute('aria-disabled', 'false'));
        await press('check'); // #3, held
        await until(() => expect(x.server.held.length).toBe(3));
        expect(control('find')).toHaveAttribute('aria-disabled', 'true');
        x.server.held.splice(1, 1)[0].release(chain(409, 'request_in_progress')); // #2 answers while #3 is out
        await settle();
        expect(control('find')).toHaveAttribute('aria-disabled', 'true');
        expect(describedBy('issued-payments-credit-card-find')).toBe(VIEW_TEXT.loading); // F16: why it is aria-disabled
      });

      it('F14 (ASY-6). Look up attempt holds the presses while its read is out: Continue issuing sends nothing meanwhile; the lookup\'s answer then speaks', async () => {
        const x = await registeredOnly();
        x.server.hold.cnLookup = 1;
        const reads = x.server.details().length;
        await press('find');
        await until(() => expect(x.server.held.length).toBe(1));
        expect(control('continue')).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(control('continue')!);
        await settle();
        expect([x.server.cnRequests('proof').length, x.server.details().length]).toEqual([1, reads]);
        x.server.held.shift()!.release();
        await until(() => expect(control('continue')).toHaveAttribute('aria-disabled', 'false'));
      });

      it('F13 (ASY-5). a register\'s sealed invalid_state whose invoice re-read answers after the hold detached says nothing on the card (the lookup explains)', async () => {
        const x = await ready();
        x.server.cnScripts.register.push(sealedAnswer('invalid_state'));
        x.server.hold.detail = 1;
        await click('issued-credit-send');
        await until(() => expect(x.server.held.length).toBe(1));
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } }); // a store switch detaches it
        await until(() => expect(held(x.r)?.csrf).toBeNull());
        x.server.held.shift()!.release();
        await settle();
        expect(held(x.r)?.state).toBe('registering');
        expect(tid('issued-section').textContent).not.toMatch(/may have been voided|has been voided/);
      });

      it('F12 (ASY-3). "no Check again" is kept per settlement KEY: after a 404 shut the first key and its limit passed, a new key\'s lost answer offers Check again again', async () => {
        const x = await ready();
        await stalledSettle(x);
        x.server.cnScripts.settle.push(404);
        await press('check');
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.settleUnknown(false)));
        expect(control('check')).toBeNull();
        await pass(x.r, 23 * 60 * 60_000); // the first key's limit: its bytes go, the row path may hold a new key
        await press('find');
        await until(() => expect(screen.queryByTestId('issued-payments-credit-row-confirm')).not.toBeNull());
        x.server.cnScripts.settle.push(503);
        fireEvent.click(tid('issued-payments-credit-row-confirm'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.settleUnknown(true)));
        expect(control('check')).not.toBeNull();
        expect(new Set(x.server.cnRequests('settle').map(keyOf)).size).toBe(2);
      });

      it('F16 (A11Y-8). a card control the user left (focus moved on, the control still there) is forgotten: its later removal does not pull focus to the heading', async () => {
        const x = await ready();
        await stalled(x, 'cnIssue');
        await advance(0); // the closed confirmation's queued focus to the card heading
        fireEvent.click(tid('issued-view-close')); // the section-level card (no dialog's focus recovery)
        await until(() => expect(control('check', sectionCard)).not.toBeNull());
        act(() => { control('check', sectionCard)!.focus(); });
        act(() => { control('check', sectionCard)!.blur(); }); // the user clicked plain text: focus on the body
        await settle();
        expect(document.activeElement).toBe(document.body);
        await pass(x.r, 9 * 60_000); // the window passes: Check again goes
        await until(() => expect(control('check', sectionCard)).toBeNull());
        expect(document.activeElement).not.toBe(tid('issued-credit-card-heading')); // not the card's: the removed button had no focus (§2.6)
      });

      it('F17 (A11Y-2). the same words twice still speak (a fresh node in the region); a reopened dialog mounts its pair empty; closing it does not say the outcome again in the section pair', async () => {
        const x = await lostIssue();
        x.server.cnScripts.issue.push('lose');
        const first = tid('issued-payments-credit-alert').firstElementChild;
        expect(first?.textContent).toBe(CREDIT_TEXT.unresolved(true));
        await press('check');
        await until(() => expect(tid('issued-payments-credit-alert').firstElementChild).not.toBe(first));
        expect(inlineAlert()).toBe(CREDIT_TEXT.unresolved(true));
        await click('issued-view-close');
        await settle();
        expect(tid('issued-credit-alert').textContent).toBe('');
        await click('issued-list-retry'); // the sign-in cleared the list read before it (LIST_TEXT.renewed)
        await listReady();
        await open(1);
        expect([inlineSay(), inlineAlert()]).toEqual(['', '']);
      });

      it('F18 (CR-2). while this user\'s attempt on another invoice is open, another attempt\'s lookup row offers Release aria-disabled with the blockedOwn reason, and its press sends nothing', async () => {
        const x = await lostIssue({ prepare: (s, m) => { s.addCreditReg({ invoiceId: m[1].id }); } });
        await click('issued-view-close');
        await click('issued-list-retry');
        await listReady();
        await open(2);
        await until(() => expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull());
        expect(tid('issued-payments-credit-row-release')).toHaveAttribute('aria-disabled', 'true');
        expect(describedBy('issued-payments-credit-row-release')).toBe(`${CREDIT_TEXT.releaseHint} ${CREDIT_TEXT.blockedOwn}`);
        fireEvent.click(tid('issued-payments-credit-row-release'));
        await settle();
        expect(x.server.cnRequests('settle')).toEqual([]);
        expect(creditNamedOutside(tid('issued-section'))).toEqual([]); // T-g: the three approved names only
      });

      it('F19 (CR-3). a first-send issue refusal that offers no Check again (a step-up → issueStale) no longer holds Void and Reverse back', async () => {
        const x = await ready();
        x.server.cnScripts.issue.push(chain(403, 'step_up_required'));
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.issueStale));
        expect(cardButtons()).not.toContain(CREDIT_TEXT.checkAgain);
        await click('issued-view-close');
        await click('issued-list-retry');
        await listReady();
        await open(2);
        await waitFor(() => expect(screen.queryByTestId('issued-view-void')).not.toBeNull());
      });

      it('F20 (CR-5, §4.1). the number\'s follow fails after the 201: the card shows numberPending with its own "Try again", which resumes the follow until CN-<n> loads', async () => {
        const x = await ready();
        await settle();
        x.server.cnScripts.list.push(503);
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(issuedText));
        await waitFor(() => expect(control('retry')).not.toBeNull());
        expect(creditNamedOutside(tid('issued-section'))).toEqual([]); // T-g: the three approved names only
        expect(control('number')?.textContent).toBe(CREDIT_TEXT.numberPending);
        await waitFor(() => expect(inlineSay()).toBe(CREDIT_TEXT.numberPending)); // its own transition, once the follow stopped short
        await press('retry');
        await waitFor(() => expect(control('number')?.textContent).toMatch(/^CN-\d+$/));
        expect(control('retry')).toBeNull();
        expect(x.server.cnRequests('settle')).toEqual([]);
      });

      it('F16 (A11Y-6, A11Y-9, A11Y-11). a failed Continue review (the lookup not read to its end) moves focus to the Payments heading; the reason error describes each radio; the sign-in group keeps a name with its alert empty', async () => {
        const x = await setup();
        await open(1);
        await startForm('5.00', null);
        await click('issued-payments-credit-continue');
        await waitFor(() => expect(tid('issued-payments-credit-form-reason-goodwill').getAttribute('aria-describedby')).toBe('issued-payments-credit-form-reason-error'));
        expect(describedBy('issued-payments-credit-form-reason-goodwill')).toBe(CREDIT_TEXT.errReason);
        fireEvent.click(tid('issued-payments-credit-form-reason-goodwill'));
        x.server.cnScripts.lookup.push(503);
        await click('issued-payments-credit-continue');
        await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-form')).toBeNull());
        expect(document.activeElement).toBe(document.getElementById('issued-payments-title'));
        await click('issued-payments-credit-lookup-continue');
        await waitFor(() => expect(action()).not.toBeNull());
        await toConfirm();
        await click('issued-credit-send');
        await waitFor(() => expect(screen.queryByTestId('issued-credit-reauth-group')).not.toBeNull());
        const group = tid('issued-credit-reauth-group');
        const name = (group.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        expect(name).toContain(VOID_TEXT.reauthExplain);
      });
    });

    describe('fix list 2 (the review of fix list 1)', () => {
      const sectionCard = 'issued-credit-card';
      async function lostIssue(o: Parameters<typeof ready>[0] = {}) {
        const x = await ready(o);
        x.server.cnScripts.issue.push('lose');
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
        return x;
      }
      async function remount(r: Rig) {
        cleanup();
        render(<ServerIssuedInvoices {...r.props()} />);
        await showAndChoose(STORE_1);
        await listReady();
      }

      it('G1 (RF1-01). the form\'s Cancel keeps the shared quiet button class (its padding, border and focus ring), never a boolean', async () => {
        await setup();
        await open(1);
        await startForm('5.00', 'goodwill');
        expect(tid('issued-payments-credit-cancel').className).toBe(`${quietClass} shrink-0 max-w-full whitespace-normal break-normal`); // T2-06: the whole class
      });

      it('G2 (RF1-02). a remount keeps rule 4 and the shut stages: after a confirmed same-token denial the card has no buttons; after issueStale no Check again, and Void is back', async () => {
        const x = await lostIssue();
        x.server.cnScripts.issue.push(chain(403, 'forbidden'));
        await press('check');
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.noAccess));
        await remount(x.r);
        expect([cardText(sectionCard), cardButtons(sectionCard)]).toEqual([CREDIT_TEXT.noAccess, []]);
        cleanup();
        const y = await ready();
        y.server.cnScripts.issue.push(chain(403, 'step_up_required'));
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.issueStale));
        await remount(y.r);
        expect([cardText(sectionCard), held(y.r)?.state]).toEqual([CREDIT_TEXT.issueStale, 'issuing']); // T2-02: the card and its open hold are there
        expect(cardButtons(sectionCard)).not.toContain(CREDIT_TEXT.checkAgain);
        expect(cardButtons(sectionCard)).not.toContain(CREDIT_TEXT.continueIssuing);
        await open(2);
        await waitFor(() => expect(screen.queryByTestId('issued-view-void')).not.toBeNull());
      });

      it('G3 (RF1-03). Continue issuing whose proof answers after the section unmounted records it only: no issue key claimed, no issue sent; back, Continue issuing is offered', async () => {
        const x = await registeredOnly();
        x.server.hold.cnProof = 1;
        await press('continue');
        await until(() => expect(x.server.held.length).toBe(1));
        cleanup();
        x.server.held.shift()!.release();
        await settle();
        expect(x.server.held).toEqual([]); // T2-03: the held proof was released and answered
        expect(x.server.cnRequests('proof')).toHaveLength(2); // the first send's and this press's only
        expect([x.server.cnRequests('issue'), held(x.r)?.issue, held(x.r)?.state]).toEqual([[], null, 'registered']);
        render(<ServerIssuedInvoices {...x.r.props()} />);
        await showAndChoose(STORE_1);
        await listReady();
        expect(cardButtons(sectionCard)).toContain(CREDIT_TEXT.continueIssuing);
      });

      it('G4 (RF1-04). a 403 confirmed at another store does not strip a detached card at its own store: Look up attempt and Hide stay', async () => {
        const x = await lostIssue();
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
        await until(() => expect(held(x.r)?.csrf).toBeNull());
        x.server.getStatus.push(403);
        await click('issued-settings-open');
        await waitFor(() => expect(panelPhase()).toBe('denied'));
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
        await until(() => expect(cardButtons(sectionCard)).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]));
      });

      it('G6 (RF1-06). a throw before the chain starts fails closed: internalError said, the confirmation closes (never left on sending), no unhandled rejection', async () => {
        const server = seeded();
        issueAt(server, STORE_1, 2);
        server.cnOwners.add('uid-a');
        const r = rig(server);
        const holds = { ...r.cnHolds, put: () => { throw new Error('synthetic'); } } as CreditNoteHoldStore;
        render(<ServerIssuedInvoices {...r.props({ creditNoteHolds: holds })} />);
        await showAndChoose(STORE_1);
        await listReady();
        await open(1);
        await toConfirm();
        await signIn();
        await click('issued-credit-send');
        await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
        await waitFor(() => expect(inlineAlert()).toBe(CREDIT_TEXT.internalError));
        expect(server.cnRequests('register')).toEqual([]);
        expect(held(r)).toBeUndefined(); // T2-05: nothing held; the throw was caught (no unhandled rejection)
      });

      it('F17 part 4 (A11Y-3), T2-01. an outcome written while the confirmation is open (the page inert) is announced once, and only after it closes; the section pair stays empty while the view is open', async () => {
        const x = await ready();
        const pair = tid('issued-payments-credit-say');
        const seen: Array<{ readonly text: string; readonly closed: boolean }> = [];
        let node = pair.firstElementChild;
        const o = new MutationObserver(() => {
          const now = pair.firstElementChild;
          if (now === node) return;
          node = now;
          if ((now?.textContent ?? '') !== '') seen.push({ text: now!.textContent!, closed: screen.queryByTestId('issued-credit-confirm') === null });
        });
        o.observe(pair, { childList: true, subtree: true, characterData: true });
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(issuedText));
        await settle();
        o.disconnect();
        expect(seen).toEqual([{ text: issuedText, closed: true }]);
        expect([tid('issued-credit-status').textContent, tid('issued-credit-alert').textContent]).toEqual(['', '']);
        expect(x.server.cnRequests('settle')).toEqual([]);
      });

      it('H1 (R1). a press that throws late fails closed on ITS attempt only: a newer hold is left as it is', async () => {
        const server = seeded();
        const made = issueAt(server, STORE_1, 2);
        server.cnOwners.add('uid-a');
        const r = rig(server);
        const real = r.props().issuing;
        let reject: (e: Error) => void = () => undefined;
        let called = false;
        const issuing = { ...real, creditNoteProof: () => { called = true; return new Promise<never>((_, no) => { reject = no; }); } } as typeof real;
        render(<ServerIssuedInvoices {...r.props({ issuing })} />);
        await showAndChoose(STORE_1);
        await listReady();
        await open(1);
        await toConfirm();
        await signIn();
        await click('issued-credit-send');
        await until(() => expect(held(r)?.state).toBe('registered'));
        await until(() => expect(called).toBe(true)); // E: the proof leaves after the session read before it (P3), not with the 201
        const a = held(r)!;
        r.cnHolds.change('uid-a', a.attemptId, a.generation, { state: 'ended' });
        r.cnHolds.remove('uid-a', a.attemptId);
        const b = uuid(0xb0b1);
        const put = r.cnHolds.put('uid-a', {
          start: 'settle', version: 1, creditNoteId: null, attemptId: b, storeId: STORE_1, tenantId: TENANT_A, invoiceId: made[0].id, invoiceNumber: 1,
          grossCents: 100, reason: 'goodwill', csrf: a.csrf as string, key: uuid(0xb0b2), body: settleBodyOf(TENANT_A, b, 1) as string,
        } as Parameters<CreditNoteHoldStore['put']>[1]);
        expect(put.kind).toBe('held');
        expect(called).toBe(true);
        act(() => { reject(new Error('synthetic')); });
        await settle();
        expect([held(r)?.attemptId, held(r)?.unresolved]).toEqual([b, false]);
        expect(inlineAlert()).toBe(CREDIT_TEXT.internalError); // T2-04: said, on no card
        expect(screen.queryByText(CREDIT_TEXT.internalError, { selector: '[data-testid$="-text"]' })).toBeNull();
      });

      it('H5 (R5). one access-loss transition, one announcement: a second same-token denial for the attempt says nothing again', async () => {
        const x = await ready();
        await stalled(x, 'cnIssue');
        x.server.cnScripts.issue.push(chain(403, 'forbidden'));
        await press('check');
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.noAccess));
        await settle();
        const node = tid('issued-payments-credit-alert').firstElementChild;
        x.server.held.shift()!.release(chain(403, 'forbidden'));
        await settle();
        await settle();
        expect(tid('issued-payments-credit-alert').firstElementChild).toBe(node);
        expect(cardButtons()).toEqual([]);
        expect(x.server.cnRequests('issue')).toHaveLength(2); // T2-07: the original and the Check again only
      });

      it('H10 (CN-03). checkUntil and numberPending both apply: the status region says both', async () => {
        const x = await ready();
        await settle();
        x.server.cnScripts.list.push(503);
        const said = watch(tid('issued-payments-credit-say'));
        await stalledSettle(x);
        await until(() => expect(control('retry')).not.toBeNull());
        // Fix list 3 (P9): each is said once when it comes, neither suppressing the other.
        expect(said().filter((t) => t === CREDIT_TEXT.numberPending || t === control('until')!.textContent)).toEqual([CREDIT_TEXT.numberPending, control('until')!.textContent]);
      });

      it('H12 (CN-08). the number\'s "Try again" waits for a press still out (aria-disabled with its reason)', async () => {
        const x = await ready();
        await settle();
        x.server.cnScripts.list.push(503);
        await click('issued-credit-send');
        await waitFor(() => expect(control('retry')).not.toBeNull());
        x.server.hold.cnSettle = 1;
        await press('confirm');
        await until(() => expect(x.server.held.length).toBe(1));
        expect(control('retry')).toHaveAttribute('aria-disabled', 'true');
        expect(describedBy('issued-payments-credit-card-retry')).toBe(VIEW_TEXT.loading);
        const reads = x.server.cnRequests('list').length;
        fireEvent.click(control('retry')!);
        await settle();
        expect(x.server.cnRequests('list')).toHaveLength(reads);
      });
    });

    describe('fix list 3 (the review of fix list 2)', () => {
      const sectionCard = 'issued-credit-card';
      /** ready(), with the issuing client changed by `over` (a throw staged where the client never throws). */
      async function readyWith(over: (real: ReturnType<typeof createInvoiceIssuingClient>) => Partial<ReturnType<typeof createInvoiceIssuingClient>>) {
        const server = seeded();
        const made = issueAt(server, STORE_1, 2);
        server.cnOwners.add('uid-a');
        const r = rig(server);
        const real = r.props().issuing as ReturnType<typeof createInvoiceIssuingClient>;
        render(<ServerIssuedInvoices {...r.props({ issuing: { ...real, ...over(real) } })} />);
        await showAndChoose(STORE_1);
        await listReady();
        await open(1);
        await toConfirm();
        await signIn();
        return { server, made, r };
      }

      it('P1 (RV2C-01, A2-3). remounted BEFORE any session read (Show not pressed): a confirmed no-access card still has no buttons and nothing is announced; after Show, still none, and no request leaves', async () => {
        const x = await ready();
        x.server.cnScripts.issue.push('lose');
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
        x.server.cnScripts.issue.push(chain(403, 'forbidden'));
        await press('check');
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.noAccess));
        cleanup();
        render(<ServerIssuedInvoices {...x.r.props()} />);
        await settle();
        expect([cardText(sectionCard), cardButtons(sectionCard)]).toEqual([CREDIT_TEXT.noAccess, []]);
        expect([tid('issued-credit-status').textContent, tid('issued-credit-alert').textContent]).toEqual(['', '']);
        const sent = x.server.cnRequests().length;
        await showAndChoose(STORE_1);
        await listReady();
        await settle();
        expect(cardButtons(sectionCard)).toEqual([]);
        expect(x.server.cnRequests().filter((q) => q.method === 'POST')).toHaveLength(x.server.cnRequests().slice(0, sent).filter((q) => q.method === 'POST').length);
      });

      it('P2 (CX2-01). a send that throws clears its 30 s timer: one internalError, and nothing at 30 s (no regUnknown)', async () => {
        await readyWith(() => ({ registerCreditNote: () => { throw new Error('synthetic'); } }));
        fakeClock();
        const said = watch(tid('issued-payments-credit-alert'));
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.internalError));
        await advance(31_000);
        await settle();
        expect(cardText()).toBe(CREDIT_TEXT.internalError);
        expect(said().filter((t) => t !== '')).toEqual([CREDIT_TEXT.internalError]);
      });

      it('P3 (CX2-02/03, §3.6 rule 1). the session is read again before the proof and before the issue: another token between them → the hold detaches and nothing more is sent', async () => {
        for (const between of ['register and proof', 'proof and issue'] as const) {
          const x = await ready();
          x.server.hold[between === 'register and proof' ? 'cnRegister' : 'cnProof'] = 1;
          fireEvent.click(tid('issued-credit-send'));
          await until(() => expect(x.server.held.length, between).toBe(1));
          x.server.otherTab('uid-a'); // another tab's sign-in: a new token
          x.server.held.shift()!.release();
          await until(() => expect(held(x.r)?.csrf, between).toBeNull());
          await settle();
          expect([x.server.cnRequests('proof').length, x.server.cnRequests('issue').length], between).toEqual(between === 'register and proof' ? [0, 0] : [1, 0]);
          expect(held(x.r)?.issue, between).toBeNull();
          cleanup();
        }
      });

      it('P4 (A2-1, P2-53). a confirmation opened and closed does not mount again what the pair said before it ("Credit note confirmed.")', async () => {
        const x = await ready();
        await click('issued-credit-send');
        await waitFor(() => expect(cardText()).toBe(issuedText));
        await click('issued-payments-credit-card-confirm');
        await waitFor(() => expect(inlineSay()).toBe(CREDIT_TEXT.confirmed));
        await waitFor(() => expect(action()).toHaveAttribute('aria-disabled', 'false'));
        const said = watch(tid('issued-payments-credit-say'));
        await toConfirm();
        await click('issued-credit-keep');
        await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
        await settle();
        expect(said().filter((t) => t === CREDIT_TEXT.confirmed)).toEqual([]);
        expect(x.server.cnRequests('register')).toHaveLength(1);
      });

      it('P6, G5 (A2-6, A2-5). the hold on invoice 1 answers while invoice 2\'s dialog is open: that dialog\'s pair says it once; closing it repeats nothing in the section pair', async () => {
        const x = await ready();
        x.server.cnScripts.issue.push('lose');
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
        x.server.hold.cnIssue = 1;
        await press('check');
        await until(() => expect(x.server.held.length).toBe(1));
        await click('issued-view-close');
        await click('issued-list-retry');
        await listReady();
        await open(2);
        x.server.held.shift()!.release();
        await waitFor(() => expect(inlineSay()).toBe(issuedText));
        await click('issued-view-close');
        await settle();
        expect(tid('issued-credit-status').textContent).not.toBe(issuedText); // not said again (its numberPending may follow: a new line)
      });

      it('P5 (A2-2), verified. a Check again answered 409 in progress is ONE status announcement (inProgress): Check again is cooling, so no checkUntil rides on it', async () => {
        const x = await ready();
        x.server.cnScripts.issue.push('lose');
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
        const pair = tid('issued-payments-credit-say');
        const seen: string[] = [];
        let node = pair.firstElementChild;
        const o = new MutationObserver(() => { const now = pair.firstElementChild; if (now !== node) { node = now; if ((now?.textContent ?? '') !== '') seen.push(now!.textContent!); } });
        o.observe(pair, { childList: true, subtree: true, characterData: true });
        x.server.cnScripts.issue.push(chain(409, 'request_in_progress'));
        await press('check');
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.inProgress));
        await settle();
        o.disconnect();
        expect(seen).toEqual([CREDIT_TEXT.inProgress]);
        expect(control('until')).toBeNull();
      });

      it('H9 (CN-02). the number\'s "Try again" whose read throws fails closed: internalError, Look up attempt, the attempt unresolved, no unhandled rejection', async () => {
        let boom = false;
        const x = await readyWith((real) => ({ listCreditNotes: (...a: Parameters<typeof real.listCreditNotes>) => { if (boom) throw new Error('synthetic'); return real.listCreditNotes(...a); } }));
        await settle();
        x.server.cnScripts.list.push(503);
        await click('issued-credit-send');
        await waitFor(() => expect(control('retry')).not.toBeNull());
        boom = true;
        await press('retry');
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.internalError));
        expect(cardButtons()).toContain(CREDIT_TEXT.find);
        expect(held(x.r)?.unresolved).toBe(true);
      });
    });

    describe('fix list 4 (the review of fix list 3)', () => {
      const sectionCard = 'issued-credit-card';
      async function back(r: Rig) {
        render(<ServerIssuedInvoices {...r.props()} />);
        await showAndChoose(STORE_1);
        await listReady();
      }

      it('Q1 (RV3C-01). the page left while the issue is out and back past its 30 s: the card offers what the hold\'s state derives (Check again, Look up attempt), never a dead "sending" line', async () => {
        const x = await ready();
        x.server.hold.cnIssue = 1;
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(x.server.cnRequests('issue')).toHaveLength(1));
        cleanup();
        x.r.clock.mono += 31_000;
        x.r.clock.wall += 31_000;
        await back(x.r);
        expect(cardText(sectionCard)).toBe(CREDIT_TEXT.unresolved(true));
        expect(cardButtons(sectionCard)).toEqual(expect.arrayContaining([CREDIT_TEXT.checkAgain, CREDIT_TEXT.find]));
      });

      it('Q1 (RV3C-01). the page left during the session read before the proof (after an in-time register 201), and back: Continue issuing and Look up attempt per the registration\'s own line', async () => {
        const x = await ready();
        x.server.hold.cnRegister = 1;
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(x.server.held.length).toBe(1));
        x.server.hold.current = 1;
        x.server.held.shift()!.release();
        await until(() => expect(x.server.held.length).toBe(1)); // the session read before the proof
        cleanup();
        x.server.held.shift()!.release();
        await settle();
        expect([held(x.r)?.state, x.server.cnRequests('proof')]).toEqual(['registered', []]);
        await back(x.r);
        expect(cardText(sectionCard)).toBe(CREDIT_TEXT.registeredOnly(true));
        expect(cardButtons(sectionCard)).toEqual(expect.arrayContaining([CREDIT_TEXT.continueIssuing, CREDIT_TEXT.find]));
      });

      it('Q3 (RV3C-04). the session read before the proof fails: the shipped connect-failure text; the registration\'s line offers Continue issuing, and no proof leaves', async () => {
        const x = await ready();
        x.server.hold.cnRegister = 1;
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(x.server.held.length).toBe(1));
        x.server.currentStatus.push(503);
        x.server.held.shift()!.release();
        await waitFor(() => expect(inlineAlert()).toBe(ISSUED_TEXT.unavailable));
        expect(cardText()).toBe(CREDIT_TEXT.registeredOnly(true));
        expect(cardButtons()).toContain(CREDIT_TEXT.continueIssuing);
        expect(x.server.cnRequests('proof')).toEqual([]);
      });
    });

    describe('fix list 5 (owner-directed)', () => {
      const take = (server: Server, kind: string) => {
        const i = server.held.findIndex((h) => h.kind === kind);
        if (i < 0) throw new Error(`nothing held: ${kind}`);
        return server.held.splice(i, 1)[0];
      };
      /** The register held, Show more's page held, then the session read before the proof held (hold order: register, list, current). */
      async function atProofSession() {
        // Over 1,000 notes: the list's 20-page read stops with Show more (a read the chain does not wait for).
        const x = await ready({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 1001); } });
        await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-more')).not.toBeNull(), { timeout: 10_000 });
        x.server.hold.cnRegister = 1;
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(x.server.held.map((h) => h.kind)).toEqual(['cnRegister']));
        x.server.hold.cnList = 1;
        fireEvent.click(tid('issued-payments-credit-more')); // a section read whose page will answer 403 (the page behind is inert, not gone)
        await until(() => expect(x.server.held.map((h) => h.kind)).toEqual(['cnRegister', 'cnList']));
        x.server.hold.current = 1;
        take(x.server, 'cnRegister').release();
        await until(() => expect(x.server.held.map((h) => h.kind)).toEqual(['cnList', 'current'])); // cnSession's read is out
        return x;
      }

      it('C (P2-89) self-check, fix list 6 › C. the request-log checker refuses: no backing lookup; another mount with the same token; a lookup answered after the send; a later lookup showing issued or released, or a later complete one missing it; a replay with other bytes', () => {
        const server = seeded();
        madeServers.splice(madeServers.indexOf(server), 1); // staged here, not by a test of the section
        const inv = uuid(0x1a01);
        const att = uuid(0xa1);
        const push = (r: Sent, epoch: number, answeredAt: number | null, text?: string) => {
          server.sent.push(r);
          server.cnMeta.set(r, { epoch, answeredAt });
          if (text !== undefined) server.cnAnswers.set(r, { status: 200, text });
        };
        const head = (h: Record<string, string>) => new Headers({ 'x-tmpos-session-csrf': 't', ...h });
        const lookup = (state: string | null, epoch = 1, answeredAt: number | null = server.sent.length + 1, after = false) => push(
          { method: 'GET', url: `${STORES_PATH}/${STORE_1}/credit-note-attempts${after ? '?after=x' : ''}`, headers: head({}), body: undefined, signal: null }, epoch, answeredAt,
          JSON.stringify({ attempts: state === null ? [] : [{ attemptId: att, invoiceId: inv, state }], nextCursor: null }),
        );
        const settle = (body: string | null, epoch = 1) => push(
          { method: 'POST', url: `${STORES_PATH}/${STORE_1}/invoices/${inv}/credit-note-settlement`, headers: head({ 'idempotency-key': uuid(0xe1) }), body: body ?? undefined, signal: null }, epoch, null,
        );
        const release = settleBodyOf(TENANT_A, att, 1);
        const run = (stage: () => void) => { server.sent.length = 0; server.cnMeta.clear(); server.cnAnswers.clear(); stage(); return () => checkP289(server); };
        expect(run(() => { lookup('open'); settle(release); })()).toBe(1);
        expect(run(() => { settle(release); })).toThrow(/follows a lookup that listed its attempt/);
        expect(run(() => { lookup('open', 1); settle(release, 2); })).toThrow(/follows a lookup that listed its attempt/); // another mount, same token
        expect(run(() => { lookup('open', 1, 5); settle(release); })).toThrow(/follows a lookup that listed its attempt/); // answered after the send
        for (const later of ['issued', 'released'] as const) expect(run(() => { lookup('open'); lookup(later); settle(release); }), later).toThrow(/lists its attempt open/);
        expect(run(() => { lookup('open'); lookup(null); settle(release); })).toThrow(/a complete lookup after the backing one omits/);
        expect(run(() => { lookup('open'); settle(release); settle(settleBodyOf(TENANT_A, uuid(0xa2), 1)); })).toThrow(/replays its key with the held bytes/);
        // fix list 8 › N6: both answered BEFORE the send; the earlier-sent (issued) answered after the later-sent (open):
        // delivery order would pick issued and fail this Release; send order picks open and passes it.
        expect(run(() => { lookup('issued', 1, 2); lookup('open', 1, 1); settle(release); })()).toBe(1);
        // fix list 7 › CX6-01: pages count in SEND order (a stale earlier read answered late never decides).
        expect(run(() => { lookup('issued', 1, 3); lookup('open', 1, 2); settle(release); })()).toBe(1); // earlier-sent issued, delivered after a later-sent open
        expect(run(() => { lookup('open', 1, 3); lookup('issued', 1, 2); settle(release); })).toThrow(/lists its attempt open/); // later-sent issued, delivered before the send
      });

      it('fix list 6 › B (1)(2), fix list 7 › F1. "Don\'t issue" and Escape close the confirmation only: the form keeps its amount and reason; focus goes straight to the Payments heading — never Continue, never body; nothing is sent', async () => {
        for (const how of ['keep', 'escape'] as const) {
          const x = await setup();
          await open(1);
          await toConfirm('5.00', 'goodwill');
          const focused: Element[] = [];
          const on = (e: FocusEvent) => { focused.push(e.target as Element); };
          document.addEventListener('focusin', on);
          if (how === 'keep') await click('issued-credit-keep');
          else fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
          await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm'), how).toBeNull());
          await settle();
          document.removeEventListener('focusin', on);
          expect(focused, `${how}: one focus move, straight to the heading`).toEqual([document.getElementById('issued-payments-title')]);
          expect(tid('issued-payments-credit-form-amount'), how).toHaveValue('5.00');
          expect(tid('issued-payments-credit-form-reason-goodwill'), how).toBeChecked();
          expect(action(), how).toBeNull();
          expect(document.activeElement, how).toBe(document.getElementById('issued-payments-title'));
          expect(x.server.cnRequests().filter((q) => q.method === 'POST'), how).toEqual([]);
          cleanup();
        }
      });

      it('fix list 6 › B (3) (P2-13, SCN-09). Escape during the sign-in wait ends the wait and closes the confirmation; the form keeps its values', async () => {
        const pending: Array<() => void> = [];
        const x = await setup({ identity: (r) => ({ idToken: async () => 'tok-a', reauthMethod: () => 'password', reauthenticate: (uid, pw) => new Promise((done) => { r.reauth.push(pw); pending.push(() => done('tok-a')); }) }) });
        await open(1);
        await toConfirm('5.00', 'goodwill');
        await click('issued-credit-send');
        await waitFor(() => expect(screen.queryByTestId('issued-credit-reauth-password')).not.toBeNull());
        type('issued-credit-reauth-password', 'correct horse');
        await click('issued-credit-reauth-confirm');
        await waitFor(() => expect(screen.queryByTestId('issued-credit-reauth-stop')).not.toBeNull());
        fireEvent.keyDown(tid('issued-credit-reauth-password'), { key: 'Escape' });
        await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
        for (const late of pending) late();
        await settle();
        expect(tid('issued-payments-credit-form-amount')).toHaveValue('5.00');
        expect(tid('issued-payments-credit-form-reason-goodwill')).toBeChecked();
        expect(document.activeElement).toBe(document.getElementById('issued-payments-title'));
        expect(x.server.cnRequests().filter((q) => q.method === 'POST')).toEqual([]);
      });

      it('fix list 6 › B (4) (B2), fix list 7 › F1, CX6-03. Close or Escape while sending: closedInFlight is said once, the form is kept, focus goes straight to the Payments heading (never Continue, never body); the late answer still applies to the card', async () => {
        for (const how of ['keep', 'escape'] as const) {
          const x = await ready();
          x.server.hold.cnRegister = 1;
          await click('issued-credit-send');
          await until(() => expect(x.server.held.length, how).toBe(1));
          const pair = tid('issued-payments-credit-say');
          const seen: string[] = [];
          let node = pair.firstElementChild;
          const o = new MutationObserver(() => { const now = pair.firstElementChild; if (now !== node) { node = now; if ((now?.textContent ?? '') !== '') seen.push(now!.textContent!); } });
          o.observe(pair, { childList: true, subtree: true });
          const focused: Element[] = [];
          const on = (e: FocusEvent) => { focused.push(e.target as Element); };
          document.addEventListener('focusin', on);
          if (how === 'keep') fireEvent.click(tid('issued-credit-keep')); // a press that moves no focus by itself
          else fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
          await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm'), how).toBeNull());
          await settle();
          expect(document.activeElement, how).toBe(document.getElementById('issued-payments-title'));
          expect(tid('issued-payments-credit-form-amount'), how).toHaveValue('5.00');
          x.server.held.shift()!.release();
          await waitFor(() => expect(cardText(), how).toBe(issuedText));
          await settle();
          o.disconnect();
          document.removeEventListener('focusin', on);
          expect(focused, `${how}: one focus move, straight to the heading`).toEqual([document.getElementById('issued-payments-title')]);
          expect(seen.filter((t) => t === CREDIT_TEXT.closedInFlight), how).toEqual([CREDIT_TEXT.closedInFlight]);
          expect(document.activeElement, how).not.toBe(document.body);
          cleanup();
        }
      });

      it('fix list 7 › F1 (CX6-02). the late answer lands between Close and the close timer: focus goes once, to what is there then (the action the reset brought back), never Continue, never body', async () => {
        const x = await ready();
        x.server.hold.cnRegister = 1;
        await click('issued-credit-send');
        await until(() => expect(x.server.held.length).toBe(1));
        const focused: Element[] = [];
        const on = (e: FocusEvent) => { focused.push(e.target as Element); };
        document.addEventListener('focusin', on);
        fakeClock(); // the close timer waits
        fireEvent.click(tid('issued-credit-keep'));
        x.server.held.shift()!.release();
        await until(() => expect(cardText()).toBe(issuedText)); // answered and the form reset, timer still pending
        await advance(0);
        await settle();
        document.removeEventListener('focusin', on);
        expect(focused).toHaveLength(1); // one move, straight to its target
        expect(document.activeElement).not.toBe(document.body);
        expect([document.getElementById('issued-payments-title'), action()]).toContain(document.activeElement);
      });

      it('fix list 7 › F2 (§2.6 "Vanishes while focused"). after Close while sending the owner is in the kept form; the answer resets it: focus to the Payments heading, never body', async () => {
        const x = await ready();
        x.server.hold.cnRegister = 1;
        await click('issued-credit-send');
        await until(() => expect(x.server.held.length).toBe(1));
        await click('issued-credit-keep');
        await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
        await settle();
        act(() => { tid('issued-payments-credit-form-amount').focus(); });
        x.server.held.shift()!.release();
        await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-form')).toBeNull());
        await settle();
        expect(document.activeElement).toBe(document.getElementById('issued-payments-title'));
      });

      it('fix list 8 › CX7-01, not reproduced (§2.6 "Vanishes while focused"). Close while sending a credit of the WHOLE remaining amount, then into the kept form: the answer takes the form away; focus to the Payments heading — never body, never the view\'s Close', async () => {
        const x = await setup();
        await open(1);
        await waitFor(() => expect(screen.queryByTestId('issued-payments-remaining')).not.toBeNull()); // the payments read answered
        const whole = (tid('issued-payments-remaining').textContent ?? '').replace(/[$,]/g, '');
        await toConfirm(whole, 'goodwill');
        await signIn();
        x.server.hold.cnRegister = 1;
        await click('issued-credit-send');
        await until(() => expect(x.server.held.length).toBe(1));
        fireEvent.click(tid('issued-credit-keep'));
        await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
        await settle();
        act(() => { tid('issued-payments-credit-form-amount').focus(); });
        const focused: Element[] = [];
        const on = (e: FocusEvent) => { focused.push(e.target as Element); };
        document.addEventListener('focusin', on);
        x.server.held.shift()!.release();
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.issued('$' + whole, 'Goodwill')));
        await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-form')).toBeNull());
        await settle();
        document.removeEventListener('focusin', on);
        expect(focused.filter((el) => el.getAttribute('data-testid') === 'issued-view-close')).toEqual([]);
        expect(document.activeElement).toBe(document.getElementById('issued-payments-title'));
      });

      it('fix list 7 › F3 (A1). numberPending is said once for the attempt: a later list re-read that ends short again (after Confirm, around a review note) does not say it again', async () => {
        const x = await ready({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 50, () => ({ issuedAt: cnTime(1) })); } });
        await settle();
        const pair = tid('issued-payments-credit-say');
        const mounted: string[] = [];
        let node = pair.firstElementChild;
        const o = new MutationObserver(() => { const now = pair.firstElementChild; if (now !== node) { node = now; mounted.push(now?.textContent ?? ''); } });
        o.observe(pair, { childList: true, subtree: true });
        x.server.cnScripts.list.push(503);
        await click('issued-credit-send');
        await waitFor(() => expect(control('retry')).not.toBeNull());
        await waitFor(() => expect(mounted).toContain(CREDIT_TEXT.numberPending));
        x.server.cnScripts.list.push(503); // Confirm's list re-read fails too: still short
        await press('confirm');
        await waitFor(() => expect(cardText()).toBe(CREDIT_TEXT.confirmed));
        await waitFor(() => expect(control('retry')).not.toBeNull());
        await waitFor(() => expect(action()).toHaveAttribute('aria-disabled', 'false'));
        x.server.cnScripts.list.push(503); // the review's list read ends short again
        x.server.paymentsStatus.push(503); // and the review closes with its note
        await startForm('1.00', 'goodwill');
        await click('issued-payments-credit-continue');
        await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-form')).toBeNull());
        await waitFor(() => expect(control('retry')).not.toBeNull());
        await settle();
        o.disconnect();
        expect(mounted.filter((t) => t === CREDIT_TEXT.numberPending)).toEqual([CREDIT_TEXT.numberPending]);
      });

      it('fix list 6 › D1 (P2-82, §3.6 rule 4). a card offering Continue issuing: the void eligibility read gets a 403 the one check confirms with the same token — the card loses its buttons and no proof or issue is sent', async () => {
        const x = await registeredOnly();
        const proofs = x.server.cnRequests('proof').length;
        await click('issued-view-close');
        await click('issued-list-retry');
        await listReady();
        x.server.eligStatus.push(403);
        await open(1);
        await waitFor(() => expect(cardButtons()).toEqual([]));
        expect(cardText()).toBe(CREDIT_TEXT.noAccessShort);
        await settle();
        expect([x.server.cnRequests('proof').length, x.server.cnRequests('issue').length]).toEqual([proofs, 0]);
      });

      it('fix list 6 › D1b (RF1-04). a denial confirmed through denialOf at STORE_2 (settings) does not strip the STORE_1 card: back at STORE_1 it keeps Look up attempt and Hide, and Look up reads under the same token (the store switch itself detached the hold, so Continue issuing cannot be offered there)', async () => {
        const x = await registeredOnly();
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_2 } });
        await until(() => expect(held(x.r)?.csrf).toBeNull());
        x.server.getStatus.push(403);
        await click('issued-settings-open');
        await waitFor(() => expect(panelPhase()).toBe('denied'));
        fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: STORE_1 } });
        await until(() => expect(cardButtons('issued-credit-card')).toEqual([CREDIT_TEXT.find, CREDIT_TEXT.hide]));
        expect(cardText('issued-credit-card')).not.toBe(CREDIT_TEXT.noAccessShort);
        const lookups = x.server.cnRequests('lookup').length;
        await press('find', 'issued-credit-card');
        await until(() => expect(x.server.cnRequests('lookup').length).toBeGreaterThan(lookups));
      });

      it('A1 (RV3C-02, A3-1). while the review note "unfinished" is up, a row Release answers: released is said once (in the dialog, not again by the section after close); settleNotDone takes the alert region from the note', async () => {
        for (const answer of ['released', 'not done'] as const) {
          const x = await setup();
          await open(1);
          await startForm('5.00', 'goodwill');
          x.server.addCreditReg({ invoiceId: x.made[0].id }); // registered meanwhile (another device): the review closes unfinished
          await click('issued-payments-credit-continue');
          await waitFor(() => expect(inlineAlert(), answer).toBe(CREDIT_TEXT.unfinished));
          await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-row-release')).not.toBeNull());
          if (answer === 'not done') x.server.cnScripts.settle.push(chain(409, 'write_conflict'));
          await click('issued-payments-credit-row-release');
          if (answer === 'released') {
            await waitFor(() => expect(inlineSay(), answer).toBe(CREDIT_TEXT.released));
            await click('issued-view-close');
            await settle();
            expect(tid('issued-credit-status').textContent, answer).toBe('');
          } else {
            await waitFor(() => expect(inlineAlert(), answer).toBe(CREDIT_TEXT.settleNotDone));
          }
          cleanup();
        }
      });

      it('A2 (RV3C-03, A3-2). a write made while the dialog\'s invoice still loads (the issuer not yet mounted) is said by that dialog\'s pair once it mounts', async () => {
        const x = await ready();
        x.server.cnScripts.issue.push('lose');
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.unresolved(true)));
        x.server.hold.cnIssue = 1;
        await press('check');
        await until(() => expect(x.server.held.length).toBe(1));
        await click('issued-view-close');
        await click('issued-list-retry');
        await listReady();
        x.server.hold.detail = 1;
        await user().click(openButton(1));
        await until(() => expect(x.server.held.map((h) => h.kind)).toEqual(['cnIssue', 'detail']));
        take(x.server, 'cnIssue').release(); // the Check again's 201 while the detail still loads
        await settle();
        take(x.server, 'detail').release();
        await viewReady(1);
        await waitFor(() => expect(inlineSay()).toBe(issuedText));
      });

      it('A3 (A3-3), not reproduced. Check again going out and coming back with the same deadline does not say "You can check again until …" again', async () => {
        const x = await ready();
        x.server.cnScripts.issue.push('lose');
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(control('until')).not.toBeNull());
        const until0 = control('until')!.textContent;
        // Each region write mounts a new node: count the nodes that carry the deadline (watch() would merge equal ends).
        const pair = tid('issued-payments-credit-say');
        const nodes: string[] = [];
        let node = pair.firstElementChild;
        const o = new MutationObserver(() => { const now = pair.firstElementChild; if (now !== node) { node = now; nodes.push(now?.textContent ?? ''); } });
        o.observe(pair, { childList: true, subtree: true });
        x.server.hold.cnIssue = 1;
        await press('check');
        await until(() => expect(x.server.held.length).toBe(1));
        expect(control('until')).toBeNull(); // in flight: Check again and its deadline are gone meanwhile
        x.server.held.shift()!.release(chain(503, 'service_unavailable'));
        await until(() => expect(control('check')).not.toBeNull());
        await settle();
        expect(control('until')!.textContent).toBe(until0);
        o.disconnect();
        expect(nodes.filter((t) => t === until0)).toEqual([]);
      });

      it('fix list 6 › A4 (CX3-03, CX5-05). a credit-note write made while the confirmation is open ("sending") is spoken once by the confirmation\'s own pair, and the issuer pair does not mount it after Close; signedIn lives only in the confirmation\'s pair', async () => {
        const x = await ready();
        expect(tid('issued-credit-confirm-status').textContent).toMatch(/^Signed in again at /);
        expect([inlineSay(), inlineAlert()]).toEqual(['', '']); // signedIn never reaches c.live (CX5-05: confirmed by design, not a defect)
        // fix list 8 › CX7-04 (H5's rule): one announcement per NODE the region holds — a new node, or new words in its node;
        // this pair renders its words as a text node, so that node (not textContent per record) is what is tracked.
        const texts = (el: HTMLElement) => {
          const seen: string[] = [];
          let node: Node | null = el.firstChild;
          let words = node?.textContent ?? '';
          const o = new MutationObserver(() => {
            const now = el.firstChild;
            const t = now?.textContent ?? '';
            if (now !== node || t !== words) { node = now; words = t; if (t !== '') seen.push(t); }
          });
          o.observe(el, { childList: true, subtree: true, characterData: true });
          return () => { o.disconnect(); return seen; };
        };
        const confirmPair = texts(tid('issued-credit-confirm-status'));
        const issuer = tid('issued-payments-credit-say');
        const mounted: string[] = [];
        let node = issuer.firstElementChild;
        const o = new MutationObserver(() => { const now = issuer.firstElementChild; if (now !== node) { node = now; if ((now?.textContent ?? '') !== '') mounted.push(now!.textContent!); } });
        o.observe(issuer, { childList: true, subtree: true });
        x.server.hold.cnRegister = 1;
        await click('issued-credit-send');
        await until(() => expect(x.server.held.length).toBe(1));
        await click('issued-credit-keep'); // "Close" while sending: observed through it
        await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
        const spoken = confirmPair();
        x.server.held.shift()!.release();
        await waitFor(() => expect(cardText()).toBe(issuedText));
        await settle();
        o.disconnect();
        expect(spoken.filter((t) => t === CREDIT_TEXT.sending)).toEqual([CREDIT_TEXT.sending]);
        expect(mounted).not.toContain(CREDIT_TEXT.sending);
      });

      it('D (a) (CX4-01). a 403 whose one fresh check waits on the session read cnSession started, confirmed with the same token: no proof or issue is sent, and the card has no buttons', async () => {
        const x = await atProofSession();
        take(x.server, 'cnList').release(chain(403, 'forbidden')); // its fresh check shares the pending session read
        await settle();
        take(x.server, 'current').release(); // the same token
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.noAccessShort)); // fix list 6 › D2: the check has settled (its read answered) first
        expect(cardButtons()).toEqual([]);
        await settle();
        expect([x.server.cnRequests('proof'), x.server.cnRequests('issue')]).toEqual([[], []]);
      });

      it('D (b) (CX4-01). the proof already left when a section read\'s 403 is confirmed with the same token: its answer is judged, no issue is sent, and the card has no buttons', async () => {
        const x = await ready({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 1001); } });
        await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-more')).not.toBeNull(), { timeout: 10_000 });
        x.server.hold.cnProof = 1;
        fireEvent.click(tid('issued-credit-send'));
        await until(() => expect(x.server.held.map((h) => h.kind)).toEqual(['cnProof']));
        x.server.hold.cnList = 1;
        fireEvent.click(tid('issued-payments-credit-more'));
        await until(() => expect(x.server.held.map((h) => h.kind)).toEqual(['cnProof', 'cnList']));
        take(x.server, 'cnList').release(chain(403, 'forbidden'));
        await until(() => expect(cardText()).toBe(CREDIT_TEXT.noAccessShort));
        take(x.server, 'cnProof').release(); // a valid 200: judged, and the chain stops before the issue
        await settle();
        await settle();
        expect(x.server.cnRequests('issue')).toEqual([]);
        expect([cardText(), cardButtons()]).toEqual([CREDIT_TEXT.noAccessShort, []]);
      });
    });
  });
  describe('QA r2 (manual QA items 12 and 16): the next Tab after a scripted focus move goes on from where focus is, never to the dialog\'s Close', () => {
    const heading = () => document.getElementById('issued-payments-title')!;
    /** One Tab (or Shift+Tab) keydown on the focused element, as the browser sends it; the dialog moves focus itself. */
    const tab = (shiftKey = false) => {
      const from = document.activeElement as HTMLElement;
      const e = createEvent.keyDown(from, { key: 'Tab', shiftKey });
      fireEvent(from, e);
      expect(e.defaultPrevented, `${shiftKey ? 'Shift+Tab' : 'Tab'} handled by the dialog`).toBe(true);
      return document.activeElement;
    };

    it('QA r2 › item 12. "Don\'t issue" and Escape close the confirmation only (the issued dialog stays): amount and reason keep their values, focus is on the Payments heading; Tab then goes to the next stop after it (the kept amount, in this fixture with no payment rights), Shift+Tab to the stop before it (the lines\' scroll region) — never the dialog\'s Close', async () => {
      for (const how of ['keep', 'escape'] as const) {
        await setup();
        await open(1);
        await toConfirm('5.00', 'goodwill');
        if (how === 'keep') await click('issued-credit-keep');
        else fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm'), how).toBeNull());
        await settle();
        expect(screen.queryByTestId('issued-view'), `${how}: only the topmost dialog closed`).not.toBeNull();
        expect(tid('issued-payments-credit-form-amount'), how).toHaveValue('5.00');
        expect(tid('issued-payments-credit-form-reason-goodwill'), how).toBeChecked();
        expect(document.activeElement, how).toBe(heading());
        expect(tab(), how).toBe(tid('issued-payments-credit-form-amount'));
        expect(document.activeElement, how).not.toBe(tid('issued-view-close'));
        act(() => { heading().focus(); });
        expect(tab(true), how).toBe(tid('issued-view-lines-scroll')); // the invoice lines' scroll region (tabindex 0), just above Payments
        expect(document.activeElement, how).not.toBe(tid('issued-view-close'));
        cleanup();
      }
    });

    it('QA r2 › item 12 (payment rights). with Record payment shown, "Don\'t issue" puts focus on the Payments heading; Tab then goes to Record payment (the next stop after it), Shift+Tab to the lines\' scroll region — never the dialog\'s Close', async () => {
      await setup({ prepare: (s) => { s.recorders.add('uid-a'); } });
      await open(1);
      await waitFor(() => expect(screen.queryByTestId('issued-payments-record')).not.toBeNull());
      await toConfirm('5.00', 'goodwill');
      await click('issued-credit-keep');
      await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).toBeNull());
      await settle();
      expect(document.activeElement).toBe(heading());
      expect(tab()).toBe(tid('issued-payments-record'));
      act(() => { heading().focus(); });
      expect(tab(true)).toBe(tid('issued-view-lines-scroll'));
      expect(document.activeElement).not.toBe(tid('issued-view-close'));
    });

    it('QA r2 › item 16. issued: focus is on the card\'s heading; Tab goes to "Confirm credit note", Shift+Tab to the stop before the card (the action) — never the dialog\'s Close; the wrap at the dialog\'s ends is unchanged', async () => {
      await ready({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 1, () => ({ issuedAt: cnTime(1) })); } });
      await click('issued-credit-send');
      await waitFor(() => expect(cardText()).toBe(issuedText));
      await waitFor(() => expect(tid('issued-payments-credit-card-number').textContent).toBe('CN-2'));
      const cardHeading = tid('issued-payments-credit-card-heading');
      await waitFor(() => expect(document.activeElement).toBe(cardHeading));
      expect(tab()).toBe(tid('issued-payments-credit-card-confirm'));
      expect(document.activeElement).toHaveTextContent(CREDIT_TEXT.confirm);
      act(() => { cardHeading.focus(); });
      expect(tab(true)).toBe(tid('issued-payments-credit-issue'));
      // The ends still wrap: Shift+Tab on Close (the first stop) → the last stop; Tab there → Close.
      act(() => { tid('issued-view-close').focus(); });
      const last = tab(true);
      expect(last).not.toBe(tid('issued-view-close'));
      expect(tid('issued-view').contains(last)).toBe(true);
      expect(tab()).toBe(tid('issued-view-close'));
    });
  });
  describe('P2-46a, P2-46c: focus inside the credit-note confirmation', () => {
    /** One Tab (or Shift+Tab) keydown on the focused element, as the browser sends it; at its ends the dialog moves focus itself. */
    const tab = (shiftKey = false) => {
      const from = document.activeElement as HTMLElement;
      const e = createEvent.keyDown(from, { key: 'Tab', shiftKey });
      fireEvent(from, e);
      expect(e.defaultPrevented, `${shiftKey ? 'Shift+Tab' : 'Tab'} handled by the dialog`).toBe(true);
      return document.activeElement;
    };

    it('P2-46a. Tab and Shift+Tab stay inside the credit-note confirmation', async () => {
      await setup();
      await open(1);
      await toConfirm('5.00', 'goodwill');
      const dialog = screen.getByRole('alertdialog', { name: CREDIT_TEXT.title });
      await waitFor(() => expect(document.activeElement).toBe(tid('issued-credit-keep')));
      // Its stops: "Don't issue" first, "Issue credit note" last. The browser moves between the stops inside; the dialog wraps
      // at both ends, so neither key ever reaches the issued dialog behind it (inert) or the page.
      expect(tab(true)).toBe(tid('issued-credit-send'));
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(tab()).toBe(tid('issued-credit-keep'));
      expect(dialog.contains(document.activeElement)).toBe(true);
      // With the sign-in group: "Don't issue", the password, "Confirm sign-in" (the last stop) — the same wrap.
      await click('issued-credit-send');
      await waitFor(() => expect(document.activeElement).toBe(tid('issued-credit-reauth-password')));
      act(() => { tid('issued-credit-keep').focus(); });
      expect(tab(true)).toBe(tid('issued-credit-reauth-confirm'));
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(tab()).toBe(tid('issued-credit-keep'));
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(tid('issued-view').contains(document.activeElement)).toBe(false);
    });

    it('P2-46c. with a provider-only re-authentication, focus goes to the provider button', async () => {
      const { server } = await setup({ identity: (r) => ({ ...r.props().identity!, reauthMethod: () => 'google' }) });
      await open(1);
      await toConfirm('5.00', 'goodwill');
      await click('issued-credit-send');
      await waitFor(() => expect(tid('issued-credit-confirm-alert').textContent).toBe(CREDIT_TEXT.signInNeeded));
      expect(screen.queryByTestId('issued-credit-reauth-password')).toBeNull(); // no password field: the provider's own window
      await waitFor(() => expect(document.activeElement).toBe(tid('issued-credit-reauth-confirm')));
      expect(document.activeElement).toHaveTextContent('Sign in with Google again');
      expect(server.cnRequests('register')).toEqual([]);
    });
  });
});

// Doc 18 (M7B credit activity), the shop slice: the "Credit activity" sub-section of the issued-invoices section, over the
// fake's store-wide route (GET /api/v1/stores/{id}/credit-notes). AUTHORED, NOT RUN. Every (B2) case below is a CONTROLLED
// response of this fake (a scripted same-token 403 and a directory that no longer lists the store), never live runtime
// coverage: doc 18 §13 flags that the shipped runtime ends the session on these mutations instead.
describe('Issued invoices — the store-wide credit activity (doc 18 §4, §8.4; shop slice AUTHORED, NOT RUN)', { timeout: 30_000 }, () => {
  beforeEach(() => { madeServers.length = 0; });
  afterEach(afterEachP289);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const actUrl = (after?: string, storeId = STORE_1) => `${STORES_PATH}/${storeId}/credit-notes${after === undefined ? '' : `?after=${after}`}`;
  const actPhase = () => screen.queryByTestId('issued-credit-activity-state')?.getAttribute('data-phase') ?? 'none';
  const actIs = (phase: string) => waitFor(() => expect(actPhase()).toBe(phase));
  const actText = () => tid('issued-credit-activity-state').textContent;
  const actShown = () => screen.queryByTestId('issued-credit-activity') !== null;
  const actNumbers = () => screen.queryAllByTestId('issued-credit-activity-number').map((x) => x.textContent);
  const actButtons = () => (actShown() ? within(tid('issued-credit-activity')).queryAllByRole('button').map((b) => b.textContent) : []);
  const reads = (server: Server, from = 0) => server.activityReads().slice(from).map((x) => x.url);
  const csrfOf = (x: Sent) => x.headers.get('x-tmpos-session-csrf');
  const select = (id: string) => fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: id } });
  const options = () => [...(tid('issued-store') as HTMLSelectElement).options].map((o) => o.value);
  /** Every note of the store's issued invoices, newest number first (what the route serves; the fake's own objects). */
  const desc = (server: Server, storeId = STORE_1) => (server.issued.get(storeId) ?? []).flatMap((i) => server.creditNotes.get(i.id) ?? []).sort((a, b) => b.number - a.number);
  /** One note as the route writes it. */
  const wire = (server: Server, c: CreditNoteWire) => ({
    id: c.id, number: c.number, invoiceId: c.invoiceId, invoiceNumber: [...server.issued.values()].flat().find((i) => i.id === c.invoiceId)!.number,
    grossCents: c.grossCents, reason: c.reason, issuedAt: c.issuedAt, issuedByName: c.issuedByName, withdrawal: c.withdrawal,
  });
  /** The held request of `kind` answers: the fake decides it now, or `late` stands in for it. Works under fake timers. */
  const releaseHeld = async (server: Server, kind: string, late?: Response) => {
    await until(() => expect(server.held.some((h) => h.kind === kind)).toBe(true));
    server.held.splice(server.held.findIndex((h) => h.kind === kind), 1)[0].release(late);
    await flush();
  };
  /** The store owner with the credit-note keys at STORE_1 (or `storeId`), the activity read on; `ready` false skips the issued list's wait. */
  async function setup(o: { uid?: string; owner?: boolean; storeId?: string; count?: number; ready?: boolean; prepare?: (server: Server, made: Issued[]) => void } = {}) {
    const server = seeded();
    const storeId = o.storeId ?? STORE_1;
    const made = issueAt(server, storeId, o.count ?? 2);
    if (o.owner !== false) server.cnOwners.add(o.uid ?? 'uid-a');
    o.prepare?.(server, made);
    const r = rig(server);
    const page = render(<ServerIssuedInvoices {...r.props({ uid: o.uid ?? 'uid-a', creditActivity: true })} />);
    await showAndChoose(storeId);
    if (o.ready !== false) await listReady();
    return { server, made, r, page };
  }
  /** Opens invoice `n` with its credit-note list (names) and the lookup read to the end. */
  async function openWithCredit(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
    await waitFor(() => expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'exhausted'));
    await waitFor(() => expect(screen.queryAllByTestId('issued-payments-credit-issued-by').length).toBeGreaterThan(0));
  }

  it('CA-01, CA-07, CA-22. the owner reads the store\'s notes newest number first, 50 a page (the cursor the 50th id); Show more walks 125 notes over three pages strictly descending with no repeat and no gap, keeps focus on itself and announces "{n} more loaded."; the last page takes it away and focus goes to the heading', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 70); s.addCreditNotes(m[1].id, 55); } });
    await actIs('ready');
    const all = desc(server);
    expect(all).toHaveLength(125);
    expect(reads(server)).toEqual([actUrl()]);
    expect(actNumbers()).toEqual(all.slice(0, 50).map((c) => `CN-${c.number}`));
    expect(actButtons()).toEqual([ACTIVITY_TEXT.refresh, CREDIT_TEXT.showMore]);
    act(() => { tid('issued-credit-activity-more').focus(); }); // from the keyboard: focus, then Enter
    await user().keyboard('{Enter}');
    await waitFor(() => expect(actNumbers()).toHaveLength(100));
    expect(document.activeElement).toBe(tid('issued-credit-activity-more'));
    expect(tid('issued-credit-activity-state')).toHaveAttribute('role', 'status');
    expect(actText()).toBe(CREDIT_TEXT.moreLoaded(50));
    await user().keyboard('{Enter}');
    await waitFor(() => expect(actNumbers()).toHaveLength(125));
    expect(actText()).toBe(CREDIT_TEXT.moreLoaded(25));
    expect(screen.queryByTestId('issued-credit-activity-more')).toBeNull();
    expect(document.activeElement).toBe(tid('issued-credit-activity-title'));
    expect(actNumbers()).toEqual(all.map((c) => `CN-${c.number}`)); // 125 .. 1: strictly descending, none twice, none missing
    expect(new Set(screen.queryAllByTestId('issued-credit-activity-item').map((li) => li.getAttribute('data-id'))).size).toBe(125);
    expect(reads(server)).toEqual([actUrl(), actUrl(all[49].id), actUrl(all[99].id)]);
  });

  it('CA-01, CA-21, CA-31. the shell (heading one level under the section\'s, the intro) renders with Loading while page one is out; an empty store says "No credit notes have been issued at this store yet." only after the read to nextCursor null; it sits after the issued list and before the issuing settings', async () => {
    const { server } = await setup({ prepare: (s) => { s.hold.activity = 1; } });
    await until(() => expect(server.held.some((h) => h.kind === 'activity')).toBe(true));
    expect(actPhase()).toBe('loading');
    expect(actText()).toBe(ACTIVITY_TEXT.loading);
    expect(tid('issued-credit-activity-title')).toHaveTextContent(ACTIVITY_TEXT.title);
    expect(tid('issued-credit-activity-title').tagName).toBe('H4');
    expect(document.getElementById('issued-title')?.tagName).toBe('H3'); // the section's heading carries an id, not a test id (cf. :9623)
    expect(tid('issued-credit-activity-intro')).toHaveTextContent(ACTIVITY_TEXT.intro);
    expect(actButtons()).toEqual([]);
    await releaseHeld(server, 'activity');
    await actIs('ready');
    expect(actText()).toBe(ACTIVITY_TEXT.empty);
    expect(screen.queryByTestId('issued-credit-activity-list')).toBeNull();
    expect(actButtons()).toEqual([ACTIVITY_TEXT.refresh]);
    expect(tid('issued-list-area').compareDocumentPosition(tid('issued-credit-activity')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tid('issued-credit-activity').compareDocumentPosition(tid('issued-store-area')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('CA-11, CA-12, CA-22. each row in §4.2\'s order — CN-<n>, Invoice <n>, Active or Withdrawn as text, the gross, the reason label — then "Issued {time}" in a time element and "Issued by" (null → "Name not set"); a withdrawn note adds "Withdrawn {time}" with its reason label and "Withdrawn by"; names inside bdi, wrapping anywhere', async () => {
    const long = 'N'.repeat(1000);
    const { server } = await setup({
      prepare: (s, m) => {
        s.addCreditNotes(m[0].id, 1, () => ({ grossCents: 1500, reason: 'pricing_error', issuedByName: long, issuedAt: cnTime(10) }));
        s.addCreditNotes(m[1].id, 1, () => ({ grossCents: 2000, reason: 'billing_error', issuedByName: null, issuedAt: cnTime(11), withdrawal: { withdrawnAt: cnTime(20), reason: 'wrong_amount', withdrawnByName: null } }));
      },
    });
    await actIs('ready');
    const [newest, older] = desc(server);
    const [withdrawn, active] = screen.getAllByTestId('issued-credit-activity-item');
    expect(withdrawn.querySelector('p')?.textContent).toBe(`CN-${newest.number} · Invoice 2 · Withdrawn · $20.00 · Billing error`);
    expect(active.querySelector('p')?.textContent).toBe(`CN-${older.number} · Invoice 1 · Active · $15.00 · Pricing error`);
    const issued = within(withdrawn).getByTestId('issued-credit-activity-issued-at');
    expect(issued.tagName).toBe('TIME');
    expect(issued).toHaveAttribute('datetime', cnTime(11));
    expect(issued.parentElement).toHaveTextContent(`Issued ${utcText(cnTime(11))}`);
    expect(within(withdrawn).getByTestId('issued-credit-activity-issued-by')).toHaveTextContent('Issued by Name not set');
    const out = within(withdrawn).getByTestId('issued-credit-activity-withdrawn-at');
    expect(out.tagName).toBe('TIME');
    expect(out).toHaveAttribute('datetime', cnTime(20));
    expect(out.parentElement).toHaveTextContent(`Withdrawn ${utcText(cnTime(20))} · Wrong amount`);
    expect(within(withdrawn).getByTestId('issued-credit-activity-withdrawn-by')).toHaveTextContent('Withdrawn by Name not set');
    const by = within(active).getByTestId('issued-credit-activity-issued-by');
    expect(by.className).toContain('[overflow-wrap:anywhere]');
    expect(by.querySelector('bdi')?.textContent).toBe(long);
    expect(within(active).queryByTestId('issued-credit-activity-withdrawn-at')).toBeNull();
    expect(within(tid('issued-credit-activity-list')).queryAllByRole('button')).toEqual([]); // no action on any row
  });

  it('CA-12, CA-20. the decoder fails closed to the error state with Try again and no rows — a name over 1,000 characters or with a control character, another store\'s id, a cursor not behind a full page, numbers not descending, a tax key, an empty page with a cursor — and Try again restarts at page one', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
    await actIs('ready');
    const [a, b] = desc(server);
    const page = (notes: unknown[], nextCursor: string | null = null, storeId = STORE_1) => json(200, { store: { id: storeId }, creditNotes: notes, nextCursor });
    const bad: Response[] = [
      page([{ ...wire(server, a), issuedByName: 'N'.repeat(1001) }]), page([{ ...wire(server, a), issuedByName: 'A\u0007B' }]), page([wire(server, a)], null, STORE_2),
      page([wire(server, a), wire(server, b)], b.id), page([wire(server, b), wire(server, a)]), page([{ ...wire(server, a), taxCents: 0 }]), page([], a.id),
    ];
    for (const answer of bad) {
      server.activityScripts.push(answer);
      await user().click(tid(actPhase() === 'ready' ? 'issued-credit-activity-refresh' : 'issued-credit-activity-retry'));
      await actIs('failed');
      expect(actText()).toBe(ACTIVITY_TEXT.failed);
      expect(screen.queryAllByTestId('issued-credit-activity-item')).toEqual([]);
      expect(actButtons()).toEqual([CREDIT_TEXT.tryAgain]);
    }
    const from = server.activityReads().length;
    await user().click(tid('issued-credit-activity-retry'));
    await actIs('ready');
    expect(reads(server, from)).toEqual([actUrl()]);
    expect(actNumbers()).toHaveLength(2);
  });

  it('CA-20, CA-38. across pages: a Show more page repeating a loaded id, or not below the last loaded number, is the error state (no partial rows shown as complete); a page answering a cursor 400 too', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 55); } });
    await actIs('ready');
    const all = desc(server);
    const page = (notes: CreditNoteWire[]) => json(200, { store: { id: STORE_1 }, creditNotes: notes.map((c) => wire(server, c)), nextCursor: null });
    for (const answer of [page([all[49], ...all.slice(51, 55)]), page([all[10]]), json(400, { error: 'invalid_request', requestId: 'req-synthetic' })]) {
      if (actPhase() !== 'ready') { await user().click(tid('issued-credit-activity-retry')); await actIs('ready'); }
      server.activityScripts.push(answer);
      await user().click(tid('issued-credit-activity-more'));
      await actIs('failed');
      expect(screen.queryAllByTestId('issued-credit-activity-item')).toEqual([]);
      expect(actText()).toBe(ACTIVITY_TEXT.failed);
    }
  });

  it('CA-14, CA-29. a 429 with Retry-After: the wait text and Try again held back; nothing of this sub-section is sent before the wait passes — Try again and a store re-choice included — and the timer only gives Try again back; then it reads page one', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); s.retryAfter = '30'; } });
    await actIs('ready');
    fakeClock();
    server.activityScripts.push(429);
    fireEvent.click(tid('issued-credit-activity-more'));
    await until(() => expect(actPhase()).toBe('rate-limited'));
    expect(actText()).toBe(LIST_TEXT.waiting);
    expect(screen.queryAllByTestId('issued-credit-activity-item')).toEqual([]);
    expect(tid('issued-credit-activity-retry')).toHaveAttribute('aria-disabled', 'true');
    const sent = server.activityReads().length;
    fireEvent.click(tid('issued-credit-activity-retry'));
    select(STORE_2);
    select(STORE_1);
    await flush();
    expect(actPhase()).toBe('rate-limited');
    expect(server.activityReads()).toHaveLength(sent);
    await advance(31_000);
    await until(() => expect(tid('issued-credit-activity-retry')).toHaveAttribute('aria-disabled', 'false'));
    expect(server.activityReads()).toHaveLength(sent);
    fireEvent.click(tid('issued-credit-activity-retry'));
    await until(() => expect(actPhase()).toBe('ready'));
    expect(reads(server, sent)).toEqual([actUrl()]);
  });

  it('CA-15a, CA-16 (401), CA-28. a page answered 401 (the server ended the session: a role change or a store reassignment): the section\'s ended text, every activity row gone, nothing re-sent — a focus, a tab return, Reconnect itself — until a store is chosen again', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); } });
    await actIs('ready');
    server.activityScripts.push(401);
    await user().click(tid('issued-credit-activity-more'));
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(tid('issued-stores-state')).toHaveTextContent(ISSUED_TEXT.ended);
    expect(actShown()).toBe(false);
    expect(screen.queryAllByTestId('issued-credit-activity-item')).toEqual([]);
    const sent = server.activityReads().length;
    await focusEvents();
    expect(server.activityReads()).toHaveLength(sent);
    await click('issued-retry'); // Reconnect
    await storesReady();
    await settle();
    expect(server.activityReads()).toHaveLength(sent);
    select(STORE_1);
    await actIs('ready');
    expect(reads(server, sent)).toEqual([actUrl()]);
  });

  it('CA-16 (403 after the check). a store reassignment that races an admitted request: its 403 runs the one fresh session check, which finds the session ended → (B0), the session-end path, with no directory read', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
    await actIs('ready');
    server.hold.activity = 1;
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await until(() => expect(server.held.some((h) => h.kind === 'activity')).toBe(true));
    server.expire();
    const at = server.sent.length;
    await releaseHeld(server, 'activity', chain(403, 'forbidden'));
    await waitFor(() => expect(tid('issued-stores-state')).toHaveTextContent(ISSUED_TEXT.ended));
    await settle();
    expect(sentFrom(server, at)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(actShown()).toBe(false);
  });

  it('CA-15b (C part only), CA-26, CA-32 (A). a same-token 403 with the store still listed under the same tenant (a demotion the session read cannot show): ONE fresh check, then the directory read directly under the same token; only this view goes — rows dropped, the sub-section hidden with no text; the CN-P2 names, lookup rows and holds are untouched, the picker unchanged; nothing more is asked for this store in this generation, until the store choice changes', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, r } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); s.addCreditReg({ invoiceId: m[0].id, number: 1, state: 'released', registeredAt: cnTime(0), settledAt: cnTime(5) }); } });
    await actIs('ready');
    await openWithCredit(1);
    expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-rows', '1');
    const before = options();
    const cn = server.cnRequests().length;
    const logins = server.logins().length;
    server.cnOwners.delete('uid-a'); // the route's owner rule now refuses this session (PERM:563-565)
    const at = server.sent.length;
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await waitFor(() => expect(actShown()).toBe(false));
    await settle();
    expect(sentFrom(server, at)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${actUrl()}`, `GET ${TENANT_SESSION_PATHS.current}`, `GET ${STORES_PATH}`]);
    expect(csrfOf(server.sent[at + 3])).toBe(csrfOf(server.sent[at + 1]));
    expect(tid('issued-section').textContent).not.toContain(ACTIVITY_TEXT.title);
    expect(options()).toEqual(before);
    expect((tid('issued-store') as HTMLSelectElement).value).toBe(STORE_1);
    expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'exhausted');
    expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-rows', '1');
    expect(screen.queryAllByTestId('issued-payments-credit-issued-by')).toHaveLength(2);
    expect(server.cnRequests()).toHaveLength(cn); // no rule-4 reload
    expect(r.cnHolds.get('uid-a')).toBeUndefined();
    expect(server.logins()).toHaveLength(logins);
    const sent = server.activityReads().length;
    await focusEvents();
    await click('issued-view-close');
    await settle();
    expect(server.activityReads()).toHaveLength(sent);
    server.cnOwners.add('uid-a');
    select(STORE_2);
    await actIs('ready');
    select(STORE_1);
    await actIs('ready');
    expect(reads(server, sent)).toEqual([actUrl(undefined, STORE_2), actUrl()]);
  });

  it('CA-32 (B2), a CONTROLLED response — not live runtime coverage (doc 18 §13 flag): a fake same-token 403 with a fake directory that no longer lists the store, or lists it under another tenant: D17 rule 4\'s second bullet only — the lookup rows go, the list reloads in the view the server gives now (no names) — plus this view; no token adoption, the store stays chosen, the picker unchanged', async () => {
    for (const lost of ['gone', 'other-tenant'] as const) {
      const { server, r } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); s.addCreditReg({ invoiceId: m[0].id, number: 1, state: 'released', registeredAt: cnTime(0), settledAt: cnTime(5) }); } });
      await actIs('ready');
      await openWithCredit(1);
      const before = options();
      const logins = server.logins().length;
      const lists = server.cnRequests('list').length;
      server.activityScripts.push(403);
      server.cnNamesHidden.add('uid-a');
      server.stores['uid-a'] = lost === 'gone' ? server.stores['uid-a'].filter((x) => x.id !== STORE_1) : server.stores['uid-a'].map((x) => (x.id === STORE_1 ? store(STORE_1, 'Main Street', false, TENANT_B) : x));
      const at = server.sent.length;
      fireEvent.click(tid('issued-credit-activity-refresh'));
      await waitFor(() => expect(actShown()).toBe(false));
      await waitFor(() => expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'denied'));
      expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-rows', '0');
      await waitFor(() => expect(server.cnRequests('list').length).toBeGreaterThan(lists));
      await waitFor(() => expect(screen.queryAllByTestId('issued-payments-credit-issued-by')).toEqual([]));
      expect(sentFrom(server, at).slice(0, 4), lost).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${actUrl()}`, `GET ${TENANT_SESSION_PATHS.current}`, `GET ${STORES_PATH}`]);
      expect(server.logins(), lost).toHaveLength(logins);
      expect((tid('issued-store') as HTMLSelectElement).value).toBe(STORE_1);
      expect(options()).toEqual(before);
      expect(r.cnHolds.get('uid-a')).toBeUndefined();
      cleanup();
    }
  });

  it('CA-32 (B2 after a renewal), a CONTROLLED response — not live runtime coverage: a sign-in renewal keeps the picker and does not re-read the directory, so a store listed before it is still "listed before"; a fake same-token 403 with a fake directory that no longer lists it is then (B2), not (A): the lookup rows go and the list reloads without names, plus this view; no token adoption, the store still chosen', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.staleLogins = true; s.addCreditNotes(m[0].id, 2); s.addCreditReg({ invoiceId: m[0].id, number: 1, state: 'released', registeredAt: cnTime(0), settledAt: cnTime(5) }); } });
    await actIs('ready');
    await click('issued-settings-open');
    await panelReady();
    await renewBySignIn();
    await actIs('ready');
    await click('issued-list-retry'); // the renewal cleared the list read under the old token (LIST_TEXT.renewed)
    await listReady();
    await openWithCredit(1);
    const logins = server.logins().length;
    const lists = server.cnRequests('list').length;
    server.activityScripts.push(403);
    server.cnNamesHidden.add('uid-a');
    server.stores['uid-a'] = server.stores['uid-a'].filter((x) => x.id !== STORE_1);
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await waitFor(() => expect(actShown()).toBe(false));
    await waitFor(() => expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-phase', 'denied'));
    expect(tid('issued-payments-credit-lookup')).toHaveAttribute('data-rows', '0');
    await waitFor(() => expect(server.cnRequests('list').length).toBeGreaterThan(lists));
    await waitFor(() => expect(screen.queryAllByTestId('issued-payments-credit-issued-by')).toEqual([]));
    expect(server.logins()).toHaveLength(logins);
    expect((tid('issued-store') as HTMLSelectElement).value).toBe(STORE_1);
  });

  // CA-32 (A, never listed) is not constructed here: the shop sends this read only for a store in the picker, and the picker
  // is always a directory answer recorded as "listed" under the generation and token that hold it (begin, Reconnect and the
  // first token re-read it; renew and renewKeepingView carry it over). A never-listed store needs a shop defect the rig cannot make.

  it('CA-32 (sequence), CA-30. the directory read is sent only after the same-token check, under this sub-section\'s own request number: a store switch while it is out drops its answer — no rule-4 clearing, the new store\'s view stands, the picker unchanged', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
    await actIs('ready');
    const before = options();
    server.activityScripts.push(403);
    server.hold.stores = 1;
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await until(() => expect(server.held.some((h) => h.kind === 'stores')).toBe(true));
    const dir = server.sent.length - 1;
    expect(server.sent[dir - 1].url).toBe(TENANT_SESSION_PATHS.current);
    expect(server.sent[dir - 2].url).toBe(actUrl());
    select(STORE_2);
    await actIs('ready');
    server.stores['uid-a'] = server.stores['uid-a'].filter((x) => x.id !== STORE_1); // what would read as (B2)
    await releaseHeld(server, 'stores');
    await settle();
    expect(actPhase()).toBe('ready');
    expect(server.cnRequests()).toEqual([]);
    expect(options()).toEqual(before);
  });

  it('CA-25, CA-32 (B1). a 403 whose fresh check finds another token (another tab\'s session): the answer is dropped silently — nothing hidden or said for it — the generation begins again (the chosen store cleared, the stores read again) and the view reads page one under the new token once a store is chosen', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
    await actIs('ready');
    const old = csrfOf(server.activityReads()[0]);
    server.hold.activity = 1;
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await until(() => expect(server.held.some((h) => h.kind === 'activity')).toBe(true));
    server.otherTab('uid-a');
    await releaseHeld(server, 'activity', chain(403, 'forbidden'));
    await waitFor(() => expect((tid('issued-store') as HTMLSelectElement).value).toBe(''));
    await storesReady();
    expect(actShown()).toBe(false);
    expect(tid('issued-connection-changed')).toHaveTextContent(ISSUED_TEXT.connection);
    const sent = server.activityReads().length;
    select(STORE_1);
    await actIs('ready');
    const fresh = server.activityReads().slice(sent);
    expect(fresh.map((x) => x.url)).toEqual([actUrl()]);
    expect(csrfOf(fresh[0])).not.toBe(old);
    expect(actNumbers()).toHaveLength(2);
  });

  it('CA-39. the directory read after a same-token 403 fails — 403, 429, an outage, an unreadable answer: (U) this view hidden, no rule-4 cascade, the picker unchanged; a 401 there is (B0), the session-end path', async () => {
    const answers: Array<[string, Response]> = [
      ['403', chain(403, 'forbidden')], ['429', chain(429, 'rate_limited', { 'retry-after': '1' })], ['503', chain(503, 'service_unavailable')],
      ['unreadable', new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })], ['401', chain(401, 'unauthenticated')],
    ];
    for (const [name, late] of answers) {
      const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
      await actIs('ready');
      const before = options();
      server.activityScripts.push(403);
      server.hold.stores = 1;
      fireEvent.click(tid('issued-credit-activity-refresh'));
      await releaseHeld(server, 'stores', late);
      if (name === '401') {
        await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
        expect(tid('issued-stores-state')).toHaveTextContent(ISSUED_TEXT.ended);
      } else {
        await waitFor(() => expect(actShown(), name).toBe(false));
        await settle();
        expect(options(), name).toEqual(before);
        expect((tid('issued-store') as HTMLSelectElement).value, name).toBe(STORE_1);
        expect(tid('issued-stores-state'), name).toHaveAttribute('data-phase', 'ready');
      }
      expect(server.cnRequests(), name).toEqual([]);
      cleanup();
    }
  });

  it('CA-41. the fresh session check after a 403 fails — a 429 or an outage: (U) this view hidden, no cascade and no directory read; after the 429 nothing of this sub-section is sent before Retry-After passes', async () => {
    for (const status of [429, 503]) {
      const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); s.retryAfter = '30'; } });
      await actIs('ready');
      server.hold.activity = 1;
      fireEvent.click(tid('issued-credit-activity-refresh'));
      await until(() => expect(server.held.some((h) => h.kind === 'activity')).toBe(true));
      server.currentStatus.push(status); // what the one check answers
      const at = server.sent.length;
      await releaseHeld(server, 'activity', chain(403, 'forbidden'));
      await waitFor(() => expect(actShown()).toBe(false));
      await settle();
      expect(sentFrom(server, at), String(status)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
      if (status === 429) {
        const sent = server.activityReads().length;
        select(STORE_2);
        select(STORE_1);
        await settle();
        expect(actPhase()).toBe('rate-limited');
        expect(server.activityReads()).toHaveLength(sent);
      }
      cleanup();
    }
  });

  it('CA-42. a store the directory marks readOnly gets no request of this sub-section and no sub-section; after an (A) denial nothing more is asked for that store until the store choice changes', async () => {
    const { server } = await setup({ storeId: STORE_RO, prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
    await settle();
    expect(server.activityReads()).toEqual([]);
    expect(actShown()).toBe(false);
    select(STORE_1);
    await actIs('ready');
    expect(reads(server)).toEqual([actUrl()]);
    server.activityScripts.push(403);
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await waitFor(() => expect(actShown()).toBe(false));
    await settle();
    const sent = server.activityReads().length;
    await focusEvents();
    expect(server.activityReads()).toHaveLength(sent);
    select(STORE_RO);
    await settle();
    expect(server.activityReads()).toHaveLength(sent);
    select(STORE_1);
    await actIs('ready');
    expect(reads(server, sent)).toEqual([actUrl()]);
  });

  it('CA-43. a 404 not_found (the route absent): the error state, never Empty, no cascade and no automatic retry; Try again reads page one again', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); s.activityScripts.push(404); } });
    await actIs('failed');
    expect(actText()).toBe(ACTIVITY_TEXT.failed);
    expect(actButtons()).toEqual([CREDIT_TEXT.tryAgain]);
    await settle();
    const after = server.sent.slice(server.sent.indexOf(server.activityReads()[0]) + 1);
    expect(after.filter((x) => x.url === STORES_PATH || /credit-notes/.test(x.url))).toEqual([]);
    expect(server.activityReads()).toHaveLength(1);
    await user().click(tid('issued-credit-activity-retry'));
    await actIs('ready');
    expect(reads(server)).toEqual([actUrl(), actUrl()]);
    expect(actNumbers()).toHaveLength(2);
  });

  it('CA-44. this tab\'s own issue (201) at the store re-reads page one of the loaded view once, and the new note shows first; its own Confirm (200) re-reads it once more', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[1].id, 1, () => ({ issuedAt: cnTime(1) })); } });
    await actIs('ready');
    await user().click(openButton(1));
    await viewReady(1);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-issue')).not.toBeNull());
    await user().click(tid('issued-payments-credit-issue'));
    type('issued-payments-credit-form-amount', '5.00');
    fireEvent.click(tid('issued-payments-credit-form-reason-goodwill'));
    await click('issued-payments-credit-continue');
    await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).not.toBeNull());
    await click('issued-credit-send');
    await waitFor(() => expect(screen.queryByTestId('issued-credit-reauth-password')).not.toBeNull());
    type('issued-credit-reauth-password', 'correct horse');
    await click('issued-credit-reauth-confirm');
    await waitFor(() => expect(tid('issued-credit-confirm-status').textContent).toMatch(/^Signed in again at /));
    await actIs('ready'); // the sign-in's renewal read page one once under the new token
    const before = server.activityReads().length;
    await click('issued-credit-send');
    await waitFor(() => expect(tid('issued-payments-credit-card-text').textContent).toBe(CREDIT_TEXT.issued('$5.00', 'Goodwill')));
    await waitFor(() => expect(server.activityReads()).toHaveLength(before + 1));
    await actIs('ready');
    expect(reads(server, before)).toEqual([actUrl()]);
    expect(desc(server)).toHaveLength(2);
    expect(actNumbers()[0]).toBe(`CN-${desc(server)[0].number}`);
    await click('issued-payments-credit-card-confirm');
    await waitFor(() => expect(tid('issued-payments-credit-card-text').textContent).toBe(CREDIT_TEXT.confirmed));
    await waitFor(() => expect(server.activityReads()).toHaveLength(before + 2));
    await settle();
    expect(reads(server, before)).toEqual([actUrl(), actUrl()]);
  });

  /** Invoice `n` open, the form filled ($5.00 Goodwill), reviewed, and the confirmation's sign-in done (renewKeepingView). */
  async function signedInToIssue(n: number) {
    await user().click(openButton(n));
    await viewReady(n);
    await waitFor(() => expect(screen.queryByTestId('issued-payments-credit-issue')).not.toBeNull());
    await user().click(tid('issued-payments-credit-issue'));
    type('issued-payments-credit-form-amount', '5.00');
    fireEvent.click(tid('issued-payments-credit-form-reason-goodwill'));
    await click('issued-payments-credit-continue');
    await waitFor(() => expect(screen.queryByTestId('issued-credit-confirm')).not.toBeNull());
    await click('issued-credit-send');
    await waitFor(() => expect(screen.queryByTestId('issued-credit-reauth-password')).not.toBeNull());
    type('issued-credit-reauth-password', 'correct horse');
    await click('issued-credit-reauth-confirm');
    await waitFor(() => expect(tid('issued-credit-confirm-status').textContent).toMatch(/^Signed in again at /));
  }

  it('CA-29, CA-44 (an own write during a wait). this tab\'s own 201 lands while a 429 wait is on and a Show more is out: the re-read sends nothing and cuts the Show more off (dropActivity first), so its late page lands nowhere; the wait text stands', async () => {
    const { server } = await setup({ count: 25, prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); s.retryAfter = '30'; } });
    await actIs('ready');
    await signedInToIssue(25); // invoice 25: on the issued list's first page
    await actIs('ready');
    server.hold.cnIssue = 1;
    await click('issued-credit-send');
    await until(() => expect(server.held.some((h) => h.kind === 'cnIssue')).toBe(true));
    server.hold.activity = 1;
    fireEvent.click(tid('issued-credit-activity-more'));
    await until(() => expect(server.held.some((h) => h.kind === 'activity')).toBe(true));
    server.listStatus.push(429);
    fireEvent.click(tid('issued-list-retry')); // the issued list's own read starts the section's wait
    await waitFor(() => expect(listPhase()).toBe('rate-limited'));
    const sent = server.activityReads().length;
    await releaseHeld(server, 'cnIssue');
    await waitFor(() => expect(tid('issued-payments-credit-card-text').textContent).toBe(CREDIT_TEXT.issued('$5.00', 'Goodwill')));
    await actIs('rate-limited');
    expect(server.activityReads()).toHaveLength(sent);
    await releaseHeld(server, 'activity');
    await settle();
    expect(actPhase()).toBe('rate-limited');
    expect(actNumbers()).toEqual([]);
  });

  it('CA-32 (B2) with D17 rule 4, a CONTROLLED response — not live runtime coverage: a credit-note press (Continue issuing) while this view\'s 403 is being classified waits for that check like any same-token 403 check of the section, and the (B2) verdict then stops its send — no proof, no issue', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[1].id, 1); } });
    await actIs('ready');
    await signedInToIssue(1);
    server.cnScripts.proof.push(503);
    await click('issued-credit-send');
    await waitFor(() => expect(tid('issued-payments-credit-card-text').textContent).toBe(CREDIT_TEXT.registeredOnly(true)));
    await settle();
    const proofs = server.cnRequests('proof').length;
    const issues = server.cnRequests('issue').length;
    server.activityScripts.push(403);
    server.hold.stores = 1; // the classification's directory read
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await until(() => expect(server.held.some((h) => h.kind === 'stores')).toBe(true));
    fireEvent.click(tid('issued-payments-credit-card-continue'));
    await settle(); // the press's own reads answered; its session step now waits for the pending check
    expect(server.cnRequests('proof')).toHaveLength(proofs);
    server.stores['uid-a'] = server.stores['uid-a'].filter((x) => x.id !== STORE_1); // what the held directory read now answers
    await releaseHeld(server, 'stores');
    await waitFor(() => expect(actShown()).toBe(false));
    await settle();
    expect(server.cnRequests('proof')).toHaveLength(proofs);
    expect(server.cnRequests('issue')).toHaveLength(issues);
  });

  it('CA-27 (a hidden view across a renewal). a view an (A) 403 hid reads page one exactly once after a sign-in renewal (the generation moved: doc 18 §4.1, §4.3), under the new token, and shows its rows again', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.staleLogins = true; s.addCreditNotes(m[0].id, 2); } });
    await actIs('ready');
    await click('issued-settings-open');
    await panelReady();
    server.cnOwners.delete('uid-a');
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await waitFor(() => expect(actShown()).toBe(false));
    await settle();
    server.cnOwners.add('uid-a');
    const sent = server.activityReads().length;
    const old = csrfOf(server.activityReads()[sent - 1]);
    await renewBySignIn();
    await actIs('ready');
    await settle();
    const after = server.activityReads().slice(sent);
    expect(after.map((x) => x.url)).toEqual([actUrl()]);
    expect(csrfOf(after[0])).not.toBe(old);
    expect(actNumbers()).toHaveLength(2);
  });

  it('CA-20 (tenant binding, doc 18 §4.4). page one binds the store\'s tenant as the directory lists it, and each Show more page is sent and applied only under that same tenant: a traversal under an unchanged directory entry walks to the end', async () => {
    // The mismatch branch (the directory listing the chosen store under another tenant within one generation) has no UI path
    // in this rig: the picker is re-read only by `begin` or Reconnect, which clear the store and the traversal first.
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); } });
    await actIs('ready');
    expect(server.stores['uid-a'].find((x) => x.id === STORE_1)?.tenantId).toBe(TENANT_A);
    await user().click(tid('issued-credit-activity-more'));
    await waitFor(() => expect(actNumbers()).toHaveLength(51));
    expect(actPhase()).toBe('ready');
  });

  it('CA-29, CA-38, CA-21 (a failed Show more). page one loaded, then Show more answered 429: the rows AND the cursor go (no Show more, only Try again, the wait text), nothing of this sub-section is sent during the wait, and Try again after it sends page one with no after= and replaces the chain; the same for a non-429 failure (503) without a wait', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); s.retryAfter = '30'; } });
    await actIs('ready');
    const cursor = () => tid('issued-credit-activity').getAttribute('data-cursor');
    expect(cursor()).toBe('held'); // page one with a cursor behind it
    const all = desc(server);
    fakeClock();
    server.activityScripts.push(429);
    const from = server.activityReads().length;
    fireEvent.click(tid('issued-credit-activity-more'));
    await until(() => expect(actPhase()).toBe('rate-limited'));
    expect(cursor()).toBe('none'); // the cursor went with the rows
    expect(reads(server, from)).toEqual([actUrl(all[49].id)]);
    expect(actText()).toBe(LIST_TEXT.waiting);
    expect(screen.queryAllByTestId('issued-credit-activity-item')).toEqual([]);
    expect(actButtons()).toEqual([CREDIT_TEXT.tryAgain]); // only Try again: Show more has no cursor to send
    const waited = server.activityReads().length;
    fireEvent.click(tid('issued-credit-activity-retry'));
    await flush();
    expect(server.activityReads()).toHaveLength(waited);
    await advance(31_000);
    await until(() => expect(tid('issued-credit-activity-retry')).toHaveAttribute('aria-disabled', 'false'));
    expect(server.activityReads()).toHaveLength(waited);
    fireEvent.click(tid('issued-credit-activity-retry'));
    await until(() => expect(actPhase()).toBe('ready'));
    expect(reads(server, waited)).toEqual([actUrl()]); // page one, no after=: a fresh traversal
    expect(actNumbers()).toEqual(all.slice(0, 50).map((c) => `CN-${c.number}`));
    expect(cursor()).toBe('held');
    vi.useRealTimers();
    server.activityScripts.push(503);
    const before = server.activityReads().length;
    fireEvent.click(tid('issued-credit-activity-more'));
    await actIs('failed');
    expect(cursor()).toBe('none'); // the 503 drops the cursor with the rows too
    expect(reads(server, before)).toEqual([actUrl(all[49].id)]);
    expect(screen.queryAllByTestId('issued-credit-activity-item')).toEqual([]);
    expect(actButtons()).toEqual([CREDIT_TEXT.tryAgain]); // only Try again: no cursor left to resume from
    const failedAt = server.activityReads().length;
    fireEvent.click(tid('issued-credit-activity-retry'));
    await actIs('ready');
    expect(reads(server, failedAt)).toEqual([actUrl()]);
    expect(actNumbers()).toHaveLength(50);
  });

  it('CA-38, CA-45. Refresh starts a new traversal at page one and REPLACES the loaded chain (page one alone, Show more back) with focus kept on it; a Show more page with a newer status than page one is appended as served, never re-sorted or rewritten; during a wait Refresh and Show more send nothing', async () => {
    const { server } = await setup({ count: 25, prepare: (s, m) => { s.addCreditNotes(m[0].id, 60); } });
    await actIs('ready');
    const all = desc(server);
    const statuses = () => screen.queryAllByTestId('issued-credit-activity-status').map((x) => x.textContent);
    all[1].withdrawal = { withdrawnAt: cnTime(900), reason: 'entered_in_error', withdrawnByName: 'Ada Owner' }; // on page one, after it loaded
    all[55].withdrawal = { withdrawnAt: cnTime(901), reason: 'wrong_invoice', withdrawnByName: 'Ada Owner' }; // on page two
    await user().click(tid('issued-credit-activity-more'));
    await waitFor(() => expect(actNumbers()).toHaveLength(60));
    expect(statuses()[1]).toBe('Active');
    expect(statuses()[55]).toBe('Withdrawn');
    expect(actNumbers()).toEqual(all.map((c) => `CN-${c.number}`));
    await user().click(tid('issued-credit-activity-refresh'));
    await waitFor(() => expect(actNumbers()).toHaveLength(50));
    await actIs('ready');
    expect(document.activeElement).toBe(tid('issued-credit-activity-refresh'));
    expect(statuses()[1]).toBe('Withdrawn');
    expect(screen.queryByTestId('issued-credit-activity-more')).not.toBeNull();
    expect(reads(server)).toEqual([actUrl(), actUrl(all[49].id), actUrl()]);
    server.retryAfter = '30';
    server.listStatus.push(429);
    await user().click(tid('issued-load-more')); // another read of the section starts the wait
    await waitFor(() => expect(tid('issued-credit-activity-refresh')).toHaveAttribute('aria-disabled', 'true'));
    const n = server.activityReads().length;
    fireEvent.click(tid('issued-credit-activity-refresh'));
    fireEvent.click(tid('issued-credit-activity-more'));
    await settle();
    expect(server.activityReads()).toHaveLength(n);
    expect(actPhase()).toBe('ready');
    expect(actNumbers()).toHaveLength(50);
  });

  it('CA-27. a context change drops every row and reads page one once: a store switch (and back); a sign-in renewal, under the new token; a later, separate renewal reloads once more; a second change while a reload is still out shows the error (its late page changes nothing); another user gets a section of their own', async () => {
    const { server, r, page } = await setup({ prepare: (s, m) => { s.staleLogins = true; s.addCreditNotes(m[0].id, 51); } });
    await actIs('ready');
    await user().click(tid('issued-credit-activity-more'));
    await waitFor(() => expect(actNumbers()).toHaveLength(51));
    select(STORE_2);
    await actIs('ready');
    expect(actNumbers()).toEqual([]);
    select(STORE_1);
    await actIs('ready');
    expect(actNumbers()).toHaveLength(50);
    expect(reads(server).slice(2)).toEqual([actUrl(undefined, STORE_2), actUrl()]);
    await click('issued-settings-open');
    await panelReady();
    const sent = server.activityReads().length;
    const old = csrfOf(server.activityReads()[sent - 1]);
    await renewBySignIn();
    await actIs('ready');
    const after = server.activityReads().slice(sent);
    expect(after.map((x) => x.url)).toEqual([actUrl()]);
    expect(csrfOf(after[0])).not.toBe(old);
    const renewAgain = async () => {
      const logins = server.logins().length;
      server.puts.push(chain(403, 'step_up_required'));
      fill();
      await click('issued-settings-save');
      await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
      type('issued-settings-reauth-password', 'correct horse');
      await click('issued-settings-reauth-confirm');
      await waitFor(() => expect(server.logins().length).toBeGreaterThan(logins));
      await settle();
    };
    // A second, separate renewal after that reload succeeded: one more reload, never the error (D17:571 counts within one load).
    const separate = server.activityReads().length;
    await renewAgain();
    await actIs('ready');
    expect(reads(server, separate)).toEqual([actUrl()]);
    expect(actNumbers()).toHaveLength(50);
    // Within ONE load: a renewal while the reload it started is still out shows the error.
    server.hold.activity = 1;
    await renewAgain();
    await until(() => expect(server.held.some((h) => h.kind === 'activity')).toBe(true));
    expect(actPhase()).toBe('loading');
    await renewAgain();
    await actIs('failed');
    expect(actText()).toBe(ACTIVITY_TEXT.failed);
    const n = server.activityReads().length;
    await releaseHeld(server, 'activity');
    await settle();
    expect(actPhase()).toBe('failed');
    expect(server.activityReads()).toHaveLength(n);
    page.rerender(<ServerIssuedInvoices {...r.props({ uid: 'uid-b', creditActivity: true })} />);
    expect(actShown()).toBe(false);
  });

  it('CA-30. races: a page answered after a store switch and back (a later request of the same kind), or after a sign-out began, is dropped with no state change', async () => {
    const { server, r } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2); } });
    await actIs('ready');
    const shown = actNumbers();
    server.hold.activity = 1;
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await until(() => expect(server.held.some((h) => h.kind === 'activity')).toBe(true));
    select(STORE_2);
    select(STORE_1);
    await actIs('ready');
    const strange = { ...wire(server, desc(server)[0]), id: uuid(0xfeed), number: 999 };
    await releaseHeld(server, 'activity', json(200, { store: { id: STORE_1 }, creditNotes: [strange], nextCursor: null }));
    await settle();
    expect(actNumbers()).toEqual(shown);
    server.hold.activity = 1;
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await until(() => expect(server.held.some((h) => h.kind === 'activity')).toBe(true));
    await act(async () => { await r.props().session!.logout(); });
    await releaseHeld(server, 'activity', json(200, { store: { id: STORE_1 }, creditNotes: [strange], nextCursor: null }));
    await settle();
    expect(actShown()).toBe(false);
    expect(screen.queryAllByTestId('issued-credit-activity-number')).toEqual([]);
  });

  it('CA-31. the first-load shell before any 200: an outage gives the error with Try again, a 429 the wait text, a 401 the section\'s ended text', async () => {
    for (const status of [503, 429, 401]) {
      const { server } = await setup({ ready: false, prepare: (s) => { s.activityScripts.push(status); s.retryAfter = '30'; } });
      if (status === 401) {
        await waitFor(() => expect(tid('issued-stores-state')).toHaveTextContent(ISSUED_TEXT.ended));
        expect(actShown()).toBe(false);
      } else {
        await actIs(status === 503 ? 'failed' : 'rate-limited');
        expect(actText()).toBe(status === 503 ? ACTIVITY_TEXT.failed : LIST_TEXT.waiting);
        expect(actButtons()).toEqual([CREDIT_TEXT.tryAgain]);
        expect(tid('issued-credit-activity-title')).toHaveTextContent(ACTIVITY_TEXT.title);
      }
      expect(server.activityReads(), String(status)).toHaveLength(1);
      cleanup();
    }
  });

  it('CA-21. the §4.3 strings exactly; none says paid, unpaid, refund or balance or fails the shipped FORBIDDEN scan; "withdraw" appears only inside this view\'s list (the shipped scan\'s scope widened to it alone, as DIS-16 did for three button names) and only as "Withdrawn" / "Withdrawn by"; a 403 leaves no text', async () => {
    expect({ ...ACTIVITY_TEXT, invoice: ACTIVITY_TEXT.invoice(7) }).toEqual({
      title: 'Credit activity', intro: 'Credit notes issued at this store, newest first. Use it to spot a credit note issued twice. It does not stop one being issued.',
      loading: 'Loading credit activity…', empty: 'No credit notes have been issued at this store yet.', failed: "Credit activity couldn't be loaded.", refresh: 'Refresh', invoice: 'Invoice 7',
    });
    for (const said of [...Object.values({ ...ACTIVITY_TEXT, invoice: ACTIVITY_TEXT.invoice(7) }), LIST_TEXT.waiting, ISSUED_TEXT.ended, CREDIT_TEXT.tryAgain, CREDIT_TEXT.showMore, CREDIT_TEXT.moreLoaded(3)]) {
      expect(said).not.toMatch(FORBIDDEN);
      expect(said).not.toMatch(/\b(un)?paid\b|refund|balance|withdraw/i);
    }
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 2, (i) => (i === 0 ? { withdrawal: { withdrawnAt: cnTime(800), reason: 'wrong_amount', withdrawnByName: 'Ada Owner' } } : {})); } });
    await actIs('ready');
    const view = tid('issued-credit-activity');
    expect(view.textContent).not.toMatch(FORBIDDEN);
    expect(view.textContent).not.toMatch(/\b(un)?paid\b|refund|balance/i);
    // Line by line over the list: its whole textContent runs adjacent block lines together ("…Ada Owner" +
    // "Withdrawn <time>" → "OwnerWithdrawn"; "Wrong amount" + "Withdrawn by" → "amountWithdrawn"), which no user reads.
    // Block by block (each line its own element), so a separator lost inside a line still shows ("Withdrawn2026…").
    const words = Array.from(tid('issued-credit-activity-list').querySelectorAll('p'), (p) => p.textContent ?? '');
    expect(words.join('\n').match(/\w*withdraw\w*/gi)).toEqual(['Withdrawn', 'Withdrawn', 'Withdrawn']); // status, time line, "Withdrawn by"
    const outside = tid('issued-section').cloneNode(true) as Element;
    outside.querySelector('[data-testid="issued-credit-activity-list"]')?.remove();
    expect(outside.textContent).not.toMatch(/withdraw/i);
    expect(unvoided(outsidePayments(tid('issued-section')))).not.toMatch(FORBIDDEN);
    expect(creditNamedOutside(tid('issued-section'))).toEqual([]);
    server.cnOwners.delete('uid-a');
    fireEvent.click(tid('issued-credit-activity-refresh'));
    await waitFor(() => expect(actShown()).toBe(false));
    expect(tid('issued-section').textContent).not.toMatch(/Credit activity|credit activity|No credit notes have been issued/);
  });

  it('CA-24. the sub-section never sends a write: a traversal, Show more, Refresh, Try again and a 403\'s classification are GETs only', async () => {
    const { server } = await setup({ prepare: (s, m) => { s.addCreditNotes(m[0].id, 51); } });
    await actIs('ready');
    await user().click(tid('issued-credit-activity-more'));
    await waitFor(() => expect(actNumbers()).toHaveLength(51));
    await user().click(tid('issued-credit-activity-refresh'));
    await waitFor(() => expect(actNumbers()).toHaveLength(50));
    server.activityScripts.push(503);
    await user().click(tid('issued-credit-activity-refresh'));
    await actIs('failed');
    await user().click(tid('issued-credit-activity-retry'));
    await actIs('ready');
    server.activityScripts.push(403);
    await user().click(tid('issued-credit-activity-refresh'));
    await waitFor(() => expect(actShown()).toBe(false));
    await settle();
    expect(server.writes()).toEqual([]);
    expect(server.activityReads().every((x) => x.method === 'GET' && x.body === undefined)).toBe(true);
    expect(server.activityReads()).toHaveLength(6);
  });
});

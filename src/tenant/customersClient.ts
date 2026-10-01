// M7A-CUSTOMERS-P5 — the shop's client for the tenant customer routes:
// GET /api/v1/customers (server/runtime/customerDirectory.ts, one keyset page of `{ id, name }`),
// GET /api/v1/customers/{id} (the same module's detail read, `{ id, name }`),
// GET /api/v1/customers/{id}/profile (M7A-CUSTOMERS-P6: the same module's contact record, `{ id, name, phone, email,
// createdAt }` — phone and email a stored value or null, createdAt toISOString's UTC form or null for a customer created
// before the server kept that time) and
// POST /api/v1/customers (server/runtime/customerCreate.ts, the idempotent create: a name, and optionally a phone and an
// email — a contact left blank is left out of the body, so a name-only body keeps its exact bytes).
//
//   - The server is the authority for everything: who may read or create, which tenant this is, what a valid name is and
//     what was stored. Nothing here names a tenant, store, role or actor — the session does. This client reports what
//     the server answered and decides nothing.
//   - An answer is untrusted: only a JSON body that matches the contract EXACTLY is a result — no extra key anywhere, at
//     most 100 rows, every id canonical, every name a string, a cursor in the cursor grammar, a profile's phone and email
//     null or a value the create rule stores unchanged, its createdAt null or an instant in exactly toISOString's form.
//     Anything else is
//     `unavailable` (a read) or `unknown` (a create), so the shop never renders half an answer, and a static host's HTML
//     fallback (a 200) is never an empty directory.
//   - A create is `created` on a validated 201 ONLY: the exact body, a canonical id, and a `Location` that is absent or
//     exactly this customer's path. A 200, any other 2xx, a 5xx, an unexpected 409 or no answer at all is `unknown` — the
//     outcome is undecided, with `responded` saying whether the server answered (a 5xx may still have committed). The
//     CALLER compares the name with the one it sent, and owns the policy of the key: only the same key and the same bytes
//     can ask again what an undecided attempt did.
//   - The body of a create is the caller's exact string: the server fingerprints the raw bytes, so this module never
//     re-serializes it.
//   - The phone and email rules below restate the server's (customerDirectory.ts); customersClient.test.ts sweeps one
//     corpus through both. They are the shop's own check before a create is sent: the server still decides.
//   - A route id or a cursor that is not in its grammar is never put into a request path.
//   - Reads carry the session CSRF token the caller was just handed, in a header (M7A-CUSTOMERS-P5-R1, DA-138): the
//     server answers a read only under the session that token belongs to, and refuses (403) one whose cookie is another
//     session's. The token is never put into a URL.
//   - It keeps nothing: no cache, no storage, no cookie access, no log. Requests are same-origin with credentials. No
//     method ever rejects.

import { INTENT_HEADER, JSON_TYPE_RE, REQUEST_TIMEOUT_MS, SESSION_CSRF_HEADER, parseRetryAfter } from './tenantSessionClient';

export const CUSTOMERS_PATH = '/api/v1/customers';
// A full page of 100 names of 200 astral scalars, each escaped as two \uXXXX units, is about 245,000 characters.
const MAX_BODY_CHARS = 524_288;
const MAX_PAGE_ROWS = 100; // server/runtime/customerDirectory.ts CUSTOMER_DIRECTORY_MAX_LIMIT
const CUSTOMER_NAME_MAX_CHARACTERS = 200; // server/runtime/customerDirectory.ts
const DEFAULT_RETRY_AFTER_SECONDS = 60;
// The server's own id rule (routes.ts CANONICAL_UUID_RE): any canonical lowercase UUID.
const CUSTOMER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{23}$/; // customerDirectory.ts CURSOR_RE: opaque, sent back verbatim
// customerCreate.ts, restated (this module cannot import the server's: it reaches node:buffer). customersClient.test.ts
// sweeps one corpus through both and requires identical answers.
const REFUSED_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}|\p{Bidi_Control}/u;
const VISIBLE_RE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{M}\u2800]/u;
const CUSTOMER_PHONE_MAX_CHARACTERS = 64; // customerDirectory.ts, migration 023's CHECK
const CUSTOMER_EMAIL_MAX_CHARACTERS = 254;
const ASCII_DIGIT_RE = /[0-9]/;
const WHITE_SPACE_RE = /\p{White_Space}/u;
const EMAIL_SHAPE_RE = /^[^@]+@[^@]+$/u; // exactly one '@', a non-empty part on each side
const LONE_SURROGATE_RE = /\p{Cs}/u; // with the u flag only an unpaired surrogate is a Cs code point
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/; // toISOString's exact form

/** A customer as the server stores it: its id and its name, nothing else. */
export interface CustomerEntry {
  readonly id: string;
  readonly name: string;
}

/** Whether `value` is a customer id in the one spelling the detail route admits. */
export const isCustomerId = (value: unknown): value is string => typeof value === 'string' && CUSTOMER_ID_RE.test(value);

/** The name as the server would store it — trimmed, 1-200 scalars, no refused character, one visible scalar — or null. */
export function normalizeCustomerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (REFUSED_CHARACTER_RE.test(name) || !VISIBLE_RE.test(name)) return null;
  const scalars = [...name].length;
  return scalars >= 1 && scalars <= CUSTOMER_NAME_MAX_CHARACTERS ? name : null;
}

/** What a contact normalizer answers for a value no customer may hold (the server refuses it, 400). */
export const CONTACT_INVALID: unique symbol = Symbol('contact invalid');
/** A contact as the server would store it, null when not provided (blank), or CONTACT_INVALID. */
export type CustomerContact = string | null | typeof CONTACT_INVALID;

/** Absent (undefined, null, blank after trim) is null; any other non-string is invalid; else trimmed, then judged. */
function contactOf(raw: unknown, max: number, admits: (value: string) => boolean): CustomerContact {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return CONTACT_INVALID;
  const value = raw.trim();
  if (value === '') return null;
  if (REFUSED_CHARACTER_RE.test(value) || [...value].length > max) return CONTACT_INVALID;
  return admits(value) ? value : CONTACT_INVALID;
}

/** The phone as the server would store it — trimmed, 1-64 scalars, no refused character, an ASCII digit — null, or invalid. */
export const normalizeCustomerPhone = (raw: unknown): CustomerContact =>
  contactOf(raw, CUSTOMER_PHONE_MAX_CHARACTERS, (phone) => ASCII_DIGIT_RE.test(phone));

/** The email as the server would store it — trimmed, 1-254 scalars, no refused or white-space character, one '@' between non-empty parts — null, or invalid. */
export const normalizeCustomerEmail = (raw: unknown): CustomerContact =>
  contactOf(raw, CUSTOMER_EMAIL_MAX_CHARACTERS, (email) => !WHITE_SPACE_RE.test(email) && EMAIL_SHAPE_RE.test(email));

/** One customer's contact record as the profile read answers it (M7A-CUSTOMERS-P6). */
export interface CustomerProfile extends CustomerEntry {
  readonly phone: string | null;
  readonly email: string | null;
  /** When the server created it (`YYYY-MM-DDTHH:mm:ss.sssZ`), or null: created before the server kept that time. */
  readonly createdAt: string | null;
}

/** How long a 429 asks the caller to wait: its `Retry-After` in whole seconds (1..300), or 60 when it named none. */
export const retryAfterSeconds = (header: string | null): number => parseRetryAfter(header) ?? DEFAULT_RETRY_AFTER_SECONDS;

interface RateLimited { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }

export type ListResult =
  | { readonly kind: 'ok'; readonly customers: readonly CustomerEntry[]; readonly nextCursor: string | null }
  | { readonly kind: 'bad-cursor' | 'signed-out' | 'denied' | 'unavailable' }
  | RateLimited;

export type DetailResult =
  | { readonly kind: 'ok'; readonly customer: CustomerEntry }
  | { readonly kind: 'not-found' | 'signed-out' | 'denied' | 'unavailable' }
  | RateLimited;

export type ProfileResult =
  | { readonly kind: 'ok'; readonly customer: CustomerProfile }
  | { readonly kind: 'not-found' | 'signed-out' | 'denied' | 'unavailable' }
  | RateLimited;

export type CreateResult =
  | { readonly kind: 'created'; readonly customer: CustomerEntry; readonly replayed: boolean }
  | { readonly kind: 'signed-out' | 'denied' | 'invalid' | 'absent' | 'key-reused' | 'in-progress' }
  | RateLimited
  | { readonly kind: 'unknown'; readonly responded: boolean };

export interface CustomersClient {
  /**
   * One page of the session's tenant: page one (`cursor` null) or the page after a `nextCursor`, on the session whose
   * CSRF token is `csrf` (the server refuses it, 403, when the cookie is another session's). Never rejects.
   */
  list(cursor: string | null, csrf: string, signal?: AbortSignal): Promise<ListResult>;
  /** One customer of the session's tenant by id, on the session whose CSRF token is `csrf`; a malformed id is `not-found` and nothing is sent. Never rejects. */
  detail(id: string, csrf: string, signal?: AbortSignal): Promise<DetailResult>;
  /** One customer's contact record by id, exactly as `detail` reads (M7A-CUSTOMERS-P6). Never rejects. */
  profile(id: string, csrf: string, signal?: AbortSignal): Promise<ProfileResult>;
  /** One create attempt: `body` exactly as given, under `idempotencyKey`, on the session whose CSRF token is `csrf`. Never rejects. */
  create(body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<CreateResult>;
}

type Data = Record<string, unknown>;
const isPlain = (value: unknown): value is Data => {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasKeys = (data: Data, keys: readonly string[]): boolean => {
  const own = Object.keys(data);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

/** `{ id, name }` exactly — a canonical id and a string name — frozen, otherwise null. */
function entryOf(value: unknown): CustomerEntry | null {
  if (!isPlain(value) || !hasKeys(value, ['id', 'name'])) return null;
  const { id, name } = value;
  return isCustomerId(id) && typeof name === 'string' ? Object.freeze({ id, name }) : null;
}

/** `{ customer: { id, name } }` exactly, otherwise null. */
function customerOf(body: unknown): CustomerEntry | null {
  return isPlain(body) && hasKeys(body, ['customer']) ? entryOf(body.customer) : null;
}

/** A stored contact for `normalize`: null, or a string the create rule keeps unchanged (already trimmed and admitted). */
const isStoredContact = (value: unknown, normalize: (raw: unknown) => CustomerContact): value is string | null =>
  value === null || (typeof value === 'string' && normalize(value) === value);

/** null, or an instant in exactly toISOString's form that spells itself back (an invalid date is refused, never thrown). */
function isCreatedAt(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !CREATED_AT_RE.test(value)) return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

/** A name the server could have stored (its isStorableName): 1-200 scalars, no lone surrogate. Checked by the profile only. */
const isStorableName = (name: unknown): name is string =>
  typeof name === 'string' && !LONE_SURROGATE_RE.test(name) && [...name].length >= 1 && [...name].length <= CUSTOMER_NAME_MAX_CHARACTERS;

/** `{ customer: { id, name, phone, email, createdAt } }` exactly, frozen, otherwise null. */
function profileOf(body: unknown): CustomerProfile | null {
  if (!isPlain(body) || !hasKeys(body, ['customer'])) return null;
  const value = body.customer;
  if (!isPlain(value) || !hasKeys(value, ['id', 'name', 'phone', 'email', 'createdAt'])) return null;
  const { id, name, phone, email, createdAt } = value;
  if (!isCustomerId(id) || !isStorableName(name)) return null;
  if (!isStoredContact(phone, normalizeCustomerPhone) || !isStoredContact(email, normalizeCustomerEmail) || !isCreatedAt(createdAt)) return null;
  return Object.freeze({ id, name, phone, email, createdAt });
}

/** `{ customers: [{ id, name }…], nextCursor }` exactly, at most one full page, no repeated id, otherwise null. */
function pageOf(body: unknown): { customers: readonly CustomerEntry[]; nextCursor: string | null } | null {
  if (!isPlain(body) || !hasKeys(body, ['customers', 'nextCursor'])) return null;
  const { customers, nextCursor } = body;
  if (!Array.isArray(customers) || customers.length > MAX_PAGE_ROWS) return null;
  const next = nextCursor === null ? null : typeof nextCursor === 'string' && CURSOR_RE.test(nextCursor) ? nextCursor : undefined;
  if (next === undefined) return null;
  if (customers.length === 0 && next !== null) return null; // the server sets a cursor only behind a full page
  const rows: CustomerEntry[] = [];
  const seen = new Set<string>();
  for (const value of customers as unknown[]) {
    const entry = entryOf(value);
    if (entry === null || seen.has(entry.id)) return null; // a page never repeats an id
    seen.add(entry.id);
    rows.push(entry);
  }
  return { customers: Object.freeze(rows), nextCursor: next };
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly header: (name: string) => string | null;
}

export function createCustomersClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): CustomersClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** The answer's status, bounded JSON body and headers, or null when no answer arrived (network failure, timeout, abort). */
  async function exchange(path: string, init: RequestInit, signal?: AbortSignal): Promise<Answer | null> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const res = await send(path, {
        ...init,
        credentials: 'include',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      let body: unknown;
      if (JSON_TYPE_RE.test(res.headers.get('content-type') ?? '')) {
        const text = await res.text().catch(() => '');
        if (text.length <= MAX_BODY_CHARS) {
          try { body = JSON.parse(text) as unknown; } catch { body = undefined; }
        }
      }
      return { status: res.status, body, header: (name) => res.headers.get(name) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const limited = (answer: Answer): RateLimited =>
    Object.freeze({ kind: 'rate-limited', retryAfterSeconds: retryAfterSeconds(answer.header('retry-after')) });
  // A read names the session it was checked on (M7A-CUSTOMERS-P5-R1): the server answers it only under that session.
  const read = (path: string, csrf: string, signal?: AbortSignal): Promise<Answer | null> =>
    exchange(path, { method: 'GET', headers: { Accept: 'application/json', [SESSION_CSRF_HEADER]: csrf } }, signal);

  async function list(cursor: string | null, csrf: string, signal?: AbortSignal): Promise<ListResult> {
    // A cursor is the server's own `nextCursor`, verbatim; one outside its grammar is never put into a request.
    if (cursor !== null && !CURSOR_RE.test(cursor)) return Object.freeze({ kind: 'bad-cursor' });
    const answer = await read(cursor === null ? CUSTOMERS_PATH : `${CUSTOMERS_PATH}?cursor=${cursor}`, csrf, signal);
    if (answer === null) return Object.freeze({ kind: 'unavailable' });
    if (answer.status === 200) {
      const page = pageOf(answer.body);
      return Object.freeze(page === null ? { kind: 'unavailable' } : { kind: 'ok', ...page });
    }
    // The server's one answer to a cursor it cannot use (malformed, foreign, deleted); without a cursor a 400 decides nothing.
    if (answer.status === 400) return Object.freeze({ kind: cursor === null ? 'unavailable' : 'bad-cursor' });
    if (answer.status === 401) return Object.freeze({ kind: 'signed-out' });
    if (answer.status === 403) return Object.freeze({ kind: 'denied' });
    if (answer.status === 429) return limited(answer);
    return Object.freeze({ kind: 'unavailable' });
  }

  async function detail(id: string, csrf: string, signal?: AbortSignal): Promise<DetailResult> {
    if (!isCustomerId(id)) return Object.freeze({ kind: 'not-found' }); // never a path built from an unvalidated id
    const answer = await read(`${CUSTOMERS_PATH}/${id}`, csrf, signal);
    if (answer === null) return Object.freeze({ kind: 'unavailable' });
    if (answer.status === 200) {
      const customer = customerOf(answer.body);
      return Object.freeze(customer !== null && customer.id === id ? { kind: 'ok', customer } : { kind: 'unavailable' });
    }
    if (answer.status === 404) return Object.freeze({ kind: 'not-found' }); // one answer for a missing id and another store's
    if (answer.status === 401) return Object.freeze({ kind: 'signed-out' });
    if (answer.status === 403) return Object.freeze({ kind: 'denied' });
    if (answer.status === 429) return limited(answer);
    return Object.freeze({ kind: 'unavailable' });
  }

  async function profile(id: string, csrf: string, signal?: AbortSignal): Promise<ProfileResult> {
    if (!isCustomerId(id)) return Object.freeze({ kind: 'not-found' }); // never a path built from an unvalidated id
    const answer = await read(`${CUSTOMERS_PATH}/${id}/profile`, csrf, signal);
    if (answer === null) return Object.freeze({ kind: 'unavailable' });
    if (answer.status === 200) {
      const customer = profileOf(answer.body);
      return Object.freeze(customer !== null && customer.id === id ? { kind: 'ok', customer } : { kind: 'unavailable' });
    }
    if (answer.status === 404) return Object.freeze({ kind: 'not-found' }); // one answer for a missing id and another store's
    if (answer.status === 401) return Object.freeze({ kind: 'signed-out' });
    if (answer.status === 403) return Object.freeze({ kind: 'denied' });
    if (answer.status === 429) return limited(answer);
    return Object.freeze({ kind: 'unavailable' });
  }

  async function create(body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<CreateResult> {
    const answer = await exchange(CUSTOMERS_PATH, {
      method: 'POST',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        [INTENT_HEADER]: '1', [SESSION_CSRF_HEADER]: csrf, 'Idempotency-Key': idempotencyKey,
      },
      body, // the caller's exact string: a retry under the same key must send the same bytes
    }, signal);
    if (answer === null) return Object.freeze({ kind: 'unknown', responded: false });
    const { status } = answer;
    if (status === 201) {
      const customer = customerOf(answer.body);
      const location = answer.header('location'); // absent on a replay sealed before the detail route existed
      if (customer !== null && (location === null || location === `${CUSTOMERS_PATH}/${customer.id}`)) {
        return Object.freeze({ kind: 'created', customer, replayed: answer.header('idempotent-replayed') === 'true' });
      }
      return Object.freeze({ kind: 'unknown', responded: true }); // a 201 this client cannot name: only the key can say
    }
    if (status === 401) return Object.freeze({ kind: 'signed-out' });
    if (status === 403) return Object.freeze({ kind: 'denied' });
    if (status === 400 || status === 413 || status === 415) return Object.freeze({ kind: 'invalid' });
    if (status === 404) return Object.freeze({ kind: 'absent' });
    if (status === 422) return Object.freeze({ kind: 'key-reused' });
    if (status === 429) return limited(answer);
    if (status === 409 && isPlain(answer.body) && answer.body.error === 'request_in_progress') {
      return Object.freeze({ kind: 'in-progress' });
    }
    // Any other 409, a 5xx, a 200 or any other 2xx: the outcome is undecided.
    return Object.freeze({ kind: 'unknown', responded: true });
  }

  return Object.freeze({ list, detail, profile, create });
}

/** The shop's one customers client. */
export const customers: CustomersClient = createCustomersClient();

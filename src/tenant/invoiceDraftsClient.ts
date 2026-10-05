// M7B-INVOICES-P1 — the shop's client for the store-owned invoice draft routes (design D3/D4, R1, R10):
// GET /api/v1/stores (the stores the signed-in user holds exactly one usable store grant at: `{ id, tenantId, name,
// readOnly }`, at most 200, no cursor), GET /api/v1/stores/{storeId}/invoice-drafts?limit=&cursor= (one keyset page of
// draft summaries, newest first), GET /api/v1/stores/{storeId}/invoice-drafts/{id} (one draft with its ordered lines) and
// POST /api/v1/stores/{storeId}/invoice-drafts (the idempotent create of one USD draft for one server customer).
//
//   - The server is the authority for everything: which stores this user may act at, who may list, reopen or save, which
//     tenant a store belongs to, what a valid draft is and what was stored. A store id in a path is a REQUESTED target
//     only — the server proves access from the user's own store grant, never from the path. This client reports what the
//     server answered and decides nothing.
//   - An answer is untrusted: only a JSON body that matches the contract EXACTLY is a result — no extra key anywhere, every
//     id canonical, every amount a safe integer of cents, every line total and subtotal equal to its own arithmetic (done
//     in BigInt, never in floating point), the lines in position order, a createdAt in exactly the UTC microsecond form.
//     Anything else is `unavailable` (a read) or `unknown` (a create), so the shop never renders half an answer. A read's
//     refusal is one too: a 401, 403, 429, a cursor's 400 or a 404 counts only as the server's exact `{ error, requestId }`
//     with its status's one word (unauthenticated, forbidden, rate_limited, invalid_request, not_found); the same status
//     in any other body is `unavailable`, so a proxy's page never signs the shop out or clears what it shows.
//   - A create is `created` on a validated 201 ONLY: the exact body, a canonical id, a `Location` that is exactly this
//     draft's path at the store asked for, and a line count and subtotal equal to the ones the body SENT (read back from
//     the caller's own string). Refusals are told apart by their status AND `error` word: 422 customer_not_found (the
//     server's sealed answer for a missing or another tenant's customer) is not 422 idempotency_key_reused, and 409
//     write_conflict (the store is not in the tenant the body expected) is not 409 request_in_progress — each only in the
//     body shape the server answers it with (sealed `{ error }` or the chain's `{ error, requestId }`), and every other
//     refusal (400, 401, 403, 413, 415, 429) only as the chain's body with its one word. A 200, any other 2xx, a 5xx, any
//     other 409/422/404, a refusal in any other body, a 201 this client cannot name, or no answer at all is `unknown` — the
//     outcome is undecided (a 503 may follow a COMMIT whose answer was lost), and only the same key and the same bytes can
//     ask again.
//   - The body of a create is the caller's exact string (built once by `draftBody`): the server fingerprints the raw
//     bytes, so this module never re-serializes it — and never sends one the server's planner would refuse (`invalid`,
//     nothing sent).
//   - Money is USD as integer cents. A price is typed in dollars and parsed EXACTLY (`^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$`,
//     BigInt), never through a float; every unit price, line total and the subtotal must stay at or below 2^53-1 cents,
//     checked before any key exists. A description follows the customer name rule (customersClient.ts) with a 256 limit.
//     The body's exact UTF-8 length is checked against the server's 64 KiB bound (a longer body is its 413) before any key
//     exists too. These rules restate the server's (server/runtime/invoiceDrafts.ts); the server still decides.
//   - The parsers accept exactly what that route module serves and nothing it would refuse to serve: a store name null or
//     1-256 well-formed scalars, the stores in its order (name in code point order — UTF-8 byte order — unnamed last, then
//     id), version 1, no -0 anywhere, and a cursor in its one canonical spelling — the unpadded base64url of the tag byte
//     0x01 and a 16-byte draft id (23 characters: 'A', then 'Q'..'f' for the tag's low bits, and a last character whose
//     two unused bits are zero). Any other cursor is refused by the server with its 400.
//   - A store id, a draft id or a cursor that is not in its grammar is never put into a request path.
//   - Every request carries the session CSRF token the caller was just handed, in a header (the server answers a read
//     only under the session that token belongs to); a create also carries the intent header and the Idempotency-Key.
//     Nothing is put into a URL but the ids and the opaque cursor.
//   - It keeps nothing: no cache, no storage, no cookie access, no log. Requests are same-origin with credentials. No
//     method ever rejects.

import { INTENT_HEADER, JSON_TYPE_RE, REQUEST_TIMEOUT_MS, SESSION_CSRF_HEADER } from './tenantSessionClient';
import { isCustomerId, normalizePlainText, retryAfterSeconds } from './customersClient';

export const STORES_PATH = '/api/v1/stores';
/** The drafts collection of one store: only ever built from a canonical store id. */
export const draftsPathOf = (storeId: string): string => `${STORES_PATH}/${storeId}/invoice-drafts`;
/** One draft of one store: what a 201's `Location` must be exactly. */
export const draftPathOf = (storeId: string, draftId: string): string => `${draftsPathOf(storeId)}/${draftId}`;

export const DRAFT_PAGE_LIMIT = 20; // the page size the shop asks for (the server's default; its maximum is 50)
export const MAX_DRAFT_LINES = 50;
export const DRAFT_DESCRIPTION_MAX_CHARACTERS = 256;
export const MAX_STORES = 200; // the resolver's grant ceiling (R1): discovery answers every usable store, at most 200
/** 2^53-1: the largest amount of cents (and quantity) a draft may carry; checked in BigInt. */
export const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
/**
 * The create body's bound in UTF-8 bytes (invoiceDrafts.ts INVOICE_DRAFT_MAX_BODY_BYTES; more is the server's 413). A body
 * draftBody builds stays well inside it — at most 4 bytes per description scalar (JSON.stringify escapes no character the
 * description rule admits beyond `"` and `\`, 2 bytes each), about 55,000 bytes for 50 lines of 256 — so this is a
 * restatement of the server's bound, checked on the exact bytes, never a reason a valid draft is refused.
 */
export const DRAFT_BODY_MAX_BYTES = 65_536;
// A page of 50 summaries is a few KiB; a draft of 50 lines of 256 astral scalars, each escaped as two \uXXXX units, is
// about 160,000 characters.
const MAX_BODY_CHARS = 262_144;
const STORE_NAME_MAX_CHARACTERS = 256; // storeDirectory.ts STORE_NAME_MAX_CHARACTERS: a longer name is never served
// The anchor's tag byte 0x01 and its 16 id bytes, unpadded base64url in the one canonical spelling the server accepts
// (invoiceDrafts.ts decodeInvoiceDraftCursor): opaque otherwise, sent back verbatim.
const CURSOR_RE = /^A[Q-Za-f][A-Za-z0-9_-]{20}[AEIMQUYcgkosw048]$/;
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/; // UTC with microseconds (design D4)
const LONE_SURROGATE_RE = /\p{Cs}/u;
const PRICE_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/;
const QUANTITY_RE = /^[0-9]+$/;

export interface StoreEntry {
  readonly id: string;
  /** The tenant the store belongs to: what a create sends as `expectedTenant`. */
  readonly tenantId: string;
  /** The store's name, or null when it has none. */
  readonly name: string | null;
  /** The store (or its tenant or account) admits reads only: no draft can be saved there. */
  readonly readOnly: boolean;
}

export interface DraftSummary {
  readonly id: string;
  readonly customerId: string;
  readonly status: 'draft';
  readonly currency: 'USD';
  readonly lineCount: number;
  readonly subtotalCents: number;
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`, as the server wrote it (never parsed into a client timestamp). */
  readonly createdAt: string;
}

export interface DraftLine {
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

export interface DraftDetail {
  readonly id: string;
  readonly storeId: string;
  readonly customerId: string;
  readonly status: 'draft';
  readonly currency: 'USD';
  readonly version: number;
  readonly createdAt: string;
  readonly subtotalCents: number;
  readonly lines: readonly DraftLine[];
}

export interface CreatedDraft {
  readonly id: string;
  readonly status: 'draft';
  readonly currency: 'USD';
  readonly lineCount: number;
  readonly subtotalCents: number;
}

interface RateLimited { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }

export type StoresResult =
  | { readonly kind: 'ok'; readonly stores: readonly StoreEntry[] }
  | { readonly kind: 'signed-out' | 'denied' | 'unavailable' }
  | RateLimited;

export type DraftPageResult =
  | { readonly kind: 'ok'; readonly drafts: readonly DraftSummary[]; readonly nextCursor: string | null }
  | { readonly kind: 'bad-cursor' | 'signed-out' | 'denied' | 'unavailable' }
  | RateLimited;

export type DraftResult =
  | { readonly kind: 'ok'; readonly draft: DraftDetail }
  | { readonly kind: 'not-found' | 'signed-out' | 'denied' | 'unavailable' }
  | RateLimited;

export type CreateDraftResult =
  | { readonly kind: 'created'; readonly draft: CreatedDraft; readonly replayed: boolean }
  | { readonly kind: 'customer-not-found' | 'key-reused' | 'conflict' | 'in-progress' | 'denied' | 'signed-out' | 'invalid' }
  | RateLimited
  | { readonly kind: 'unknown'; readonly responded: boolean };

// ---- the shop's own checks before a create (the server restates and decides) ----

/** A description as the server would store it — trimmed, 1-256 scalars, the customer name rule — or null. */
export const normalizeDraftDescription = (raw: unknown): string | null => normalizePlainText(raw, DRAFT_DESCRIPTION_MAX_CHARACTERS);

/** A whole quantity typed as digits (trimmed), 1..2^53-1, as a BigInt; null otherwise. */
export function parseQuantity(raw: string): bigint | null {
  const text = raw.trim();
  if (!QUANTITY_RE.test(text) || text.length > 32) return null;
  const value = BigInt(text);
  return value >= 1n && value <= MAX_CENTS ? value : null;
}

/** A unit price typed in dollars (trimmed; at most two decimals; no sign, no exponent) as integer cents, ≤ 2^53-1; null otherwise. */
export function parsePriceCents(raw: string): bigint | null {
  const text = raw.trim();
  const match = PRICE_RE.exec(text);
  if (match === null || text.length > 32) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '.').slice(1).padEnd(2, '0'));
  return cents <= MAX_CENTS ? cents : null;
}

/** Integer cents as US dollars, `$1,234.56`: digit arithmetic only, never a float. */
export function formatCents(cents: number | bigint): string {
  const value = BigInt(cents);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** One line as the dialog's fields hold it. */
export interface DraftLineFields { readonly description: string; readonly quantity: string; readonly unitPrice: string }
/** What is wrong with one line (each false when that field is fine); `total` — its quantity × price exceeds 2^53-1 cents. */
export interface DraftLineErrors { readonly description: boolean; readonly quantity: boolean; readonly unitPrice: boolean; readonly total: boolean }
export type DraftBody =
  | { readonly kind: 'ok'; readonly body: string; readonly lineCount: number; readonly subtotalCents: number }
  | {
    readonly kind: 'invalid'; readonly lines: readonly DraftLineErrors[]; /** The lines' sum exceeds 2^53-1 cents. */ readonly subtotal: boolean; readonly count: boolean;
    /** The body's UTF-8 bytes exceed DRAFT_BODY_MAX_BYTES. */ readonly tooLarge: boolean;
  };

/** Whether `body`, as fetch sends it (UTF-8), is over the server's 64 KiB bound. */
export const isDraftBodyTooLarge = (body: string): boolean => new TextEncoder().encode(body).length > DRAFT_BODY_MAX_BYTES;

/** The parsed amounts of the lines, or null where a field is invalid. */
export function lineAmounts(line: DraftLineFields): { readonly quantity: bigint | null; readonly cents: bigint | null; readonly total: bigint | null } {
  const quantity = parseQuantity(line.quantity);
  const cents = parsePriceCents(line.unitPrice);
  return { quantity, cents, total: quantity !== null && cents !== null ? quantity * cents : null };
}

/**
 * The POST body of one draft, built ONCE: keys expectedTenant, customerId, currency, lines (each description, quantity,
 * unitPriceCents) in that order, the descriptions normalized, the amounts safe integers. Every line and the sum are
 * checked in BigInt before anything is built, and the built body's exact UTF-8 length against the 64 KiB bound, so no key
 * is ever minted for a body the server would refuse for size.
 */
export function draftBody(expectedTenant: string, customerId: string, lines: readonly DraftLineFields[]): DraftBody {
  const count = lines.length < 1 || lines.length > MAX_DRAFT_LINES;
  let sum = 0n;
  let bad = count || !isCustomerId(expectedTenant) || !isCustomerId(customerId);
  const errors: DraftLineErrors[] = [];
  const built: Array<{ description: string; quantity: number; unitPriceCents: number }> = [];
  for (const line of lines) {
    const description = normalizeDraftDescription(line.description);
    const { quantity, cents, total } = lineAmounts(line);
    const over = total !== null && total > MAX_CENTS;
    errors.push(Object.freeze({ description: description === null, quantity: quantity === null, unitPrice: cents === null, total: over }));
    if (description === null || quantity === null || cents === null || total === null || over) { bad = true; continue; }
    sum += total;
    built.push({ description, quantity: Number(quantity), unitPriceCents: Number(cents) });
  }
  const subtotal = !bad && sum > MAX_CENTS;
  const invalid = (tooLarge: boolean): DraftBody => Object.freeze({ kind: 'invalid', lines: Object.freeze(errors), subtotal, count, tooLarge });
  if (bad || subtotal) return invalid(false);
  const body = JSON.stringify({ expectedTenant, customerId, currency: 'USD', lines: built });
  if (isDraftBodyTooLarge(body)) return invalid(true);
  return Object.freeze({ kind: 'ok', body, lineCount: built.length, subtotalCents: Number(sum) });
}

// ---- strict answer parsers ----

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
/** A safe integer in [min, max], never -0 (the server's isWhole: `-0` is JSON it never writes). */
const isCount = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max && !Object.is(value, -0);
const isCents = (value: unknown): value is number => isCount(value, 0, Number.MAX_SAFE_INTEGER);

/** A createdAt in exactly the UTC microsecond form, naming a real instant (its millisecond prefix spells itself back). */
export function isDraftCreatedAt(value: unknown): value is string {
  if (typeof value !== 'string' || !CREATED_AT_RE.test(value)) return false;
  const millis = `${value.slice(0, 23)}Z`;
  const instant = new Date(millis);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === millis;
}

/** `{ id, tenantId, name, readOnly }` exactly — the name null or 1-256 well-formed scalars — otherwise null. */
function storeOf(value: unknown): StoreEntry | null {
  if (!isPlain(value) || !hasKeys(value, ['id', 'tenantId', 'name', 'readOnly'])) return null;
  const { id, tenantId, name, readOnly } = value;
  if (!isCustomerId(id) || !isCustomerId(tenantId) || typeof readOnly !== 'boolean') return null;
  if (name !== null && (typeof name !== 'string' || name === '' || name.length > 2 * STORE_NAME_MAX_CHARACTERS
    || LONE_SURROGATE_RE.test(name) || [...name].length > STORE_NAME_MAX_CHARACTERS)) return null;
  return Object.freeze({ id, tenantId, name: name as string | null, readOnly });
}

/** Code point order, which is UTF-8 byte order (the "C" collation): negative, zero or positive. */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
/** Strictly in the server's order (storeDirectory.ts inStoreDirectoryOrder): name, unnamed last, then id. */
const storeBefore = (a: StoreEntry, b: StoreEntry): boolean => {
  const byName = a.name === null ? (b.name === null ? 0 : 1) : b.name === null ? -1 : byCodePoint(a.name, b.name);
  return byName < 0 || (byName === 0 && a.id < b.id);
};

/** `{ stores: [...] }` exactly, at most 200, no repeated id, strictly in the server's order; otherwise null. */
function storesOf(body: unknown): readonly StoreEntry[] | null {
  if (!isPlain(body) || !hasKeys(body, ['stores']) || !Array.isArray(body.stores) || body.stores.length > MAX_STORES) return null;
  const out: StoreEntry[] = [];
  const seen = new Set<string>();
  for (const value of body.stores as unknown[]) {
    const store = storeOf(value);
    if (store === null || seen.has(store.id) || (out.length > 0 && !storeBefore(out[out.length - 1], store))) return null;
    seen.add(store.id);
    out.push(store);
  }
  return Object.freeze(out);
}

/** One summary, exactly, otherwise null. */
function summaryOf(value: unknown): DraftSummary | null {
  if (!isPlain(value) || !hasKeys(value, ['id', 'customerId', 'status', 'currency', 'lineCount', 'subtotalCents', 'createdAt'])) return null;
  const { id, customerId, status, currency, lineCount, subtotalCents, createdAt } = value;
  if (!isCustomerId(id) || !isCustomerId(customerId) || status !== 'draft' || currency !== 'USD') return null;
  if (!isCount(lineCount, 1, MAX_DRAFT_LINES) || !isCents(subtotalCents) || !isDraftCreatedAt(createdAt)) return null;
  return Object.freeze({ id, customerId, status, currency, lineCount, subtotalCents, createdAt });
}

/** Strictly newest first: (createdAt, id) descending, as the server orders the page (string order is byte order here). */
const before = (a: DraftSummary, b: DraftSummary): boolean => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

/** The continuation the server writes for a page ending at `draftId` (invoiceDrafts.ts encodeInvoiceDraftCursor). */
const cursorOfDraft = (draftId: string): string =>
  btoa(String.fromCharCode(0x01, ...(draftId.replace(/-/g, '').match(/../g) ?? []).map((pair) => parseInt(pair, 16))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * `{ drafts, nextCursor }` exactly: at most `limit`, no repeated id, newest first, never the anchor `cursor` names, and a
 * cursor only behind a full page, naming its last draft (invoiceDrafts.ts invoiceDraftPageOf and the list route).
 */
function pageOf(body: unknown, limit: number, cursor: string | null): { drafts: readonly DraftSummary[]; nextCursor: string | null } | null {
  if (!isPlain(body) || !hasKeys(body, ['drafts', 'nextCursor'])) return null;
  const { drafts, nextCursor } = body;
  if (!Array.isArray(drafts) || drafts.length > limit) return null;
  const next = nextCursor === null ? null : typeof nextCursor === 'string' && CURSOR_RE.test(nextCursor) ? nextCursor : undefined;
  if (next === undefined || (next !== null && drafts.length !== limit)) return null;
  const rows: DraftSummary[] = [];
  const seen = new Set<string>();
  for (const value of drafts as unknown[]) {
    const row = summaryOf(value);
    if (row === null || seen.has(row.id) || (rows.length > 0 && !before(rows[rows.length - 1], row))) return null;
    if (cursor !== null && cursorOfDraft(row.id) === cursor) return null; // the anchor itself: the page after it never holds it
    seen.add(row.id);
    rows.push(row);
  }
  if (next !== null && next !== cursorOfDraft(rows[rows.length - 1].id)) return null;
  return { drafts: Object.freeze(rows), nextCursor: next };
}

/** One line at `position`, exactly, its total equal to quantity × unit price (BigInt); otherwise null. */
function lineOf(value: unknown, position: number): DraftLine | null {
  if (!isPlain(value) || !hasKeys(value, ['position', 'description', 'quantity', 'unitPriceCents', 'lineTotalCents'])) return null;
  const { description, quantity, unitPriceCents, lineTotalCents } = value;
  if (value.position !== position || typeof description !== 'string' || normalizeDraftDescription(description) !== description) return null;
  if (!isCount(quantity, 1, Number.MAX_SAFE_INTEGER) || !isCents(unitPriceCents) || !isCents(lineTotalCents)) return null;
  if (BigInt(quantity) * BigInt(unitPriceCents) !== BigInt(lineTotalCents)) return null;
  return Object.freeze({ position, description, quantity, unitPriceCents, lineTotalCents });
}

/** `{ draft: { … lines } }` exactly, for the store and id asked for, the subtotal the lines' sum; otherwise null. */
function detailOf(body: unknown, storeId: string, draftId: string): DraftDetail | null {
  if (!isPlain(body) || !hasKeys(body, ['draft'])) return null;
  const value = body.draft;
  if (!isPlain(value) || !hasKeys(value, ['id', 'storeId', 'customerId', 'status', 'currency', 'version', 'createdAt', 'subtotalCents', 'lines'])) return null;
  const { id, customerId, status, currency, version, createdAt, subtotalCents, lines } = value;
  if (id !== draftId || value.storeId !== storeId || !isCustomerId(customerId) || status !== 'draft' || currency !== 'USD') return null;
  if (version !== 1 || !isDraftCreatedAt(createdAt) || !isCents(subtotalCents)) return null; // a draft is never edited: version 1
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_DRAFT_LINES) return null;
  const out: DraftLine[] = [];
  let sum = 0n;
  for (const [index, entry] of (lines as unknown[]).entries()) {
    const line = lineOf(entry, index + 1);
    if (line === null) return null;
    sum += BigInt(line.lineTotalCents);
    out.push(line);
  }
  if (sum !== BigInt(subtotalCents)) return null;
  return Object.freeze({ id: draftId, storeId, customerId, status, currency, version, createdAt, subtotalCents, lines: Object.freeze(out) });
}

/** `{ draft: { id, status, currency, lineCount, subtotalCents } }` exactly, otherwise null. */
function createdOf(body: unknown): CreatedDraft | null {
  if (!isPlain(body) || !hasKeys(body, ['draft'])) return null;
  const value = body.draft;
  if (!isPlain(value) || !hasKeys(value, ['id', 'status', 'currency', 'lineCount', 'subtotalCents'])) return null;
  const { id, status, currency, lineCount, subtotalCents } = value;
  if (!isCustomerId(id) || status !== 'draft' || currency !== 'USD' || !isCount(lineCount, 1, MAX_DRAFT_LINES) || !isCents(subtotalCents)) return null;
  return Object.freeze({ id, status, currency, lineCount, subtotalCents });
}

/**
 * What a create body SENT: its line count and its subtotal (BigInt), read from the caller's own string; null when it is
 * not a body the server's planner (invoiceDrafts.ts planInvoiceDraftCreate) would take — unreadable, over 64 KiB, not
 * exactly the four keys, a non-canonical id, not USD, not 1-50 lines of exactly description, quantity and unitPriceCents,
 * a description the rule refuses, a quantity or price that is not a safe whole number in range (-0 included), a line
 * total or the sum over 2^53-1 cents — so nothing is sent and no key is spent on a sure 400. A string holding a lone
 * surrogate is refused too, although fetch would send it as U+FFFD: those bytes would not be the string held for a retry.
 */
function sentOf(body: string): { readonly lineCount: number; readonly subtotalCents: bigint } | null {
  try {
    if (isDraftBodyTooLarge(body)) return null;
    const parsed: unknown = JSON.parse(body);
    if (!isPlain(parsed) || !hasKeys(parsed, ['expectedTenant', 'customerId', 'currency', 'lines'])) return null;
    const { expectedTenant, customerId, currency, lines } = parsed;
    if (!isCustomerId(expectedTenant) || !isCustomerId(customerId) || currency !== 'USD') return null;
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_DRAFT_LINES) return null;
    let sum = 0n;
    for (const line of lines as unknown[]) {
      if (!isPlain(line) || !hasKeys(line, ['description', 'quantity', 'unitPriceCents']) || normalizeDraftDescription(line.description) === null) return null;
      if (!isCount(line.quantity, 1, Number.MAX_SAFE_INTEGER) || !isCents(line.unitPriceCents)) return null;
      const total = BigInt(line.quantity) * BigInt(line.unitPriceCents);
      sum += total;
      if (total > MAX_CENTS || sum > MAX_CENTS) return null;
    }
    return { lineCount: lines.length, subtotalCents: sum };
  } catch {
    return null;
  }
}

/**
 * A refusal's `error` word and its shape: `sealed` — exactly `{ error }`, an answer the server recorded as the key's
 * completion and replays (idempotency.ts) — or the chain's own, exactly `{ error, requestId }` (strings); otherwise none.
 */
function refusalOf(body: unknown): { readonly error: string; readonly sealed: boolean } | undefined {
  if (!isPlain(body) || typeof body.error !== 'string') return undefined;
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === 'error') return { error: body.error, sealed: true };
  return hasKeys(body, ['error', 'requestId']) && typeof body.requestId === 'string' ? { error: body.error, sealed: false } : undefined;
}

export interface InvoiceDraftsClient {
  /** The stores this user may act at, on the session whose CSRF token is `csrf`. Never rejects. */
  listStores(csrf: string, signal?: AbortSignal): Promise<StoresResult>;
  /** One page of `storeId`'s drafts: page one (`cursor` null) or the page after a `nextCursor`. A malformed store id is `denied` and nothing is sent. Never rejects. */
  listDrafts(storeId: string, cursor: string | null, csrf: string, signal?: AbortSignal): Promise<DraftPageResult>;
  /** One draft of `storeId` by id; a malformed id is `not-found` and nothing is sent. Never rejects. */
  getDraft(storeId: string, draftId: string, csrf: string, signal?: AbortSignal): Promise<DraftResult>;
  /** One create attempt at `storeId`: `body` exactly as given, under `idempotencyKey`; a body the server would refuse is `invalid` and nothing is sent. Never rejects. */
  createDraft(storeId: string, body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<CreateDraftResult>;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly header: (name: string) => string | null;
}

export function createInvoiceDraftsClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): InvoiceDraftsClient {
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
  const read = (path: string, csrf: string, signal?: AbortSignal): Promise<Answer | null> =>
    exchange(path, { method: 'GET', headers: { Accept: 'application/json', [SESSION_CSRF_HEADER]: csrf } }, signal);
  /**
   * A read refusal decides only in the server's own envelope: exactly `{ error, requestId }` (app.ts refuse,
   * invoiceDrafts.ts refuse, sessions.ts) with the one word the server pairs with that status. The same status in any
   * other body — a proxy's HTML 401, a `{ error }` without its requestId, another word — is no answer this server gives,
   * so it is `unavailable`: never a reason to clear the stores, the choice, the drafts or the session.
   */
  const says = (answer: Answer, status: number, word: string): boolean => {
    const refused = refusalOf(answer.body);
    return answer.status === status && refused?.error === word && !refused.sealed;
  };
  /** The refusals every read shares; null for an answer the caller decides (or none of these). */
  function refusal(answer: Answer): { readonly kind: 'signed-out' | 'denied' } | RateLimited | null {
    if (says(answer, 401, 'unauthenticated')) return Object.freeze({ kind: 'signed-out' });
    if (says(answer, 403, 'forbidden')) return Object.freeze({ kind: 'denied' });
    if (says(answer, 429, 'rate_limited')) return limited(answer);
    return null;
  }

  async function listStores(csrf: string, signal?: AbortSignal): Promise<StoresResult> {
    const answer = await read(STORES_PATH, csrf, signal);
    if (answer === null) return Object.freeze({ kind: 'unavailable' });
    if (answer.status === 200) {
      const stores = storesOf(answer.body);
      return Object.freeze(stores === null ? { kind: 'unavailable' } : { kind: 'ok', stores });
    }
    return refusal(answer) ?? Object.freeze({ kind: 'unavailable' });
  }

  async function listDrafts(storeId: string, cursor: string | null, csrf: string, signal?: AbortSignal): Promise<DraftPageResult> {
    if (!isCustomerId(storeId)) return Object.freeze({ kind: 'denied' }); // the server's answer to a store it cannot name
    if (cursor !== null && !CURSOR_RE.test(cursor)) return Object.freeze({ kind: 'bad-cursor' });
    const query = `limit=${DRAFT_PAGE_LIMIT}${cursor === null ? '' : `&cursor=${cursor}`}`;
    const answer = await read(`${draftsPathOf(storeId)}?${query}`, csrf, signal);
    if (answer === null) return Object.freeze({ kind: 'unavailable' });
    if (answer.status === 200) {
      const page = pageOf(answer.body, DRAFT_PAGE_LIMIT, cursor);
      return Object.freeze(page === null ? { kind: 'unavailable' } : { kind: 'ok', ...page });
    }
    // The server's one answer to a cursor it cannot use (unknown, another store's, malformed); without a cursor it decides nothing.
    if (cursor !== null && says(answer, 400, 'invalid_request')) return Object.freeze({ kind: 'bad-cursor' });
    return refusal(answer) ?? Object.freeze({ kind: 'unavailable' });
  }

  async function getDraft(storeId: string, draftId: string, csrf: string, signal?: AbortSignal): Promise<DraftResult> {
    if (!isCustomerId(storeId) || !isCustomerId(draftId)) return Object.freeze({ kind: 'not-found' }); // never a path built from an unvalidated id
    const answer = await read(draftPathOf(storeId, draftId), csrf, signal);
    if (answer === null) return Object.freeze({ kind: 'unavailable' });
    if (answer.status === 200) {
      const draft = detailOf(answer.body, storeId, draftId);
      return Object.freeze(draft === null ? { kind: 'unavailable' } : { kind: 'ok', draft });
    }
    if (says(answer, 404, 'not_found')) return Object.freeze({ kind: 'not-found' }); // one answer for a missing id and another store's
    return refusal(answer) ?? Object.freeze({ kind: 'unavailable' });
  }

  async function createDraft(storeId: string, body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<CreateDraftResult> {
    const sent = sentOf(body);
    if (!isCustomerId(storeId) || sent === null) return Object.freeze({ kind: 'invalid' }); // nothing is sent
    const answer = await exchange(draftsPathOf(storeId), {
      method: 'POST',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        [INTENT_HEADER]: '1', [SESSION_CSRF_HEADER]: csrf, 'Idempotency-Key': idempotencyKey,
      },
      body, // the caller's exact string: a retry under the same key must send the same bytes
    }, signal);
    if (answer === null) return Object.freeze({ kind: 'unknown', responded: false });
    const { status } = answer;
    const refused = refusalOf(answer.body);
    const sealed = (word: string): boolean => refused?.error === word && refused.sealed;
    const chain = (word: string): boolean => refused?.error === word && !refused.sealed;
    if (status === 201) {
      const draft = createdOf(answer.body);
      const replay = answer.header('idempotent-replayed'); // app.ts sendRecorded: absent, or exactly "true" on a replay
      if (draft !== null && answer.header('location') === draftPathOf(storeId, draft.id) && (replay === null || replay === 'true')
        && draft.lineCount === sent.lineCount && BigInt(draft.subtotalCents) === sent.subtotalCents) {
        return Object.freeze({ kind: 'created', draft, replayed: replay === 'true' });
      }
      return Object.freeze({ kind: 'unknown', responded: true }); // a 201 this client cannot name: only the key can say
    }
    // Each word in the shape the server answers it: customer_not_found only sealed (the create's recorded 422);
    // idempotency_key_reused and request_in_progress only from the chain; write_conflict either way — the chain's 409
    // for another tenant than expectedTenant, or the sealed 409 a create records when its new id already exists. Every
    // other refusal is the chain's own (app.ts refuse, sessions.ts), with its one word for its status; the same status in
    // any other body is no answer this server gives, so it decides nothing.
    if (status === 422 && sealed('customer_not_found')) return Object.freeze({ kind: 'customer-not-found' });
    if (status === 422 && chain('idempotency_key_reused')) return Object.freeze({ kind: 'key-reused' });
    if (status === 409 && refused?.error === 'write_conflict') return Object.freeze({ kind: 'conflict' });
    if (status === 409 && chain('request_in_progress')) return Object.freeze({ kind: 'in-progress' });
    if (status === 401 && chain('unauthenticated')) return Object.freeze({ kind: 'signed-out' });
    if (status === 403 && chain('forbidden')) return Object.freeze({ kind: 'denied' });
    if ((status === 400 && chain('invalid_request')) || (status === 413 && chain('content_too_large'))
      || (status === 415 && chain('unsupported_media_type'))) return Object.freeze({ kind: 'invalid' });
    if (status === 429 && chain('rate_limited')) return limited(answer);
    // Any other 409 or 422, a refusal in a body the server never answers it with, a 404, a 5xx, a 200 or any other 2xx:
    // the outcome is undecided.
    return Object.freeze({ kind: 'unknown', responded: true });
  }

  return Object.freeze({ listStores, listDrafts, getDraft, createDraft });
}

/** The shop's one invoice drafts client. */
export const invoiceDrafts: InvoiceDraftsClient = createInvoiceDraftsClient();

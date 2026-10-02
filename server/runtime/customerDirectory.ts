// Phase 4.0 M7a — the tenant customer directory: the first tenant business route, a bounded read of the customers of
// the tenant a session is admitted to (M7A-CUSTOMERS-P1; G-IAM, G-PERSIST; docs/phase-4/10 ADR-32).
//
// GET /api/v1/customers[?limit=N][&cursor=C] — a session route of the TENANT boundary, under the established
// conventions (routes.ts): tenant business routes live under /api/v1, and the path is literal — it carries no tenant.
// The chain proves the tenant session and asks the tenant authorizer (tenantAuthorization.ts) for view_customers — the
// Customers domain at View or above (m5CanonicalPermissions.ts) — before this handler runs, so a 401, a 403 or an
// authorization outage never reaches it. The route declares `trustedContext: 'required'`: the chain refuses it unless
// the authorizer resolved the session's actor and the ONE tenant grant it decided on, and that trusted scope — never a
// path, query, header, cursor or body — is the only thing that says whose customers are read.
//
// BOUND TO THE PRESENTING SESSION (M7A-CUSTOMERS-P2). The route declares `sessionBinding: 'required'`, so the chain
// hands this handler the presenting session's store key, and the port asks the database with that key alone: the read is
// bound in the database to the presenting minted session, which derives the tenant itself — a caller holding the
// runtime's database login but no live minted session reads nothing. The key is a SQL parameter and nothing else.
// M7A-CUSTOMERS-P5-R1 (DA-138): the same declaration makes the chain require the presenting session's CSRF token in
// `X-TMPOS-Session-CSRF` on this GET, so the read is also bound to the session the CLIENT checked: a request whose cookie
// is another session's than the token names (missing, repeated or foreign token) is a 403 before the authorizer, the
// port or any cursor is asked. The detail route below declares the same.
//
// THE QUERY. Exactly two optional parameters, each at most once and nothing else: `limit`, a decimal 1-100 (default 50),
// and `cursor`, the continuation a previous page returned. Any other key, a repeat, an empty pair, an encoding, a
// non-canonical spelling or an overlong query is a 400 invalid_request, decided before the customer port is asked (the
// chain has already proved the session and decided the permission, so an unauthenticated one is a 401 first). The cursor is
// opaque to the client: 23 base64url characters encoding a tag byte and the id of the last customer of the previous
// page, accepted only in its one canonical spelling. It carries NO authority and no tenant: the routine looks its
// position up only among the admitted tenant's customers, so a cursor naming another tenant's customer — or none — is
// the same 400 as any unknown one and reveals nothing about any tenant.
//
// THE PAGE. The port asks migration 018's session-bound routine, which delegates to migration 017's, for at most `limit`
// customers after the cursor, ordered by (name, id) in byte order — a total order, so pages never overlap. The routine
// re-confirms, in the snapshot it reads, that the session's one tenant grant still holds. Its answer is untrusted: only an exactly shaped answer becomes a page —
// canonical customer ids, none repeated and none the cursor's own, names of 1-200 characters in well-formed UTF-16,
// in strictly increasing page order (so a continuation can never repeat or skip a row the answer put out of order) —
// and anything else is a bounded 503. The response is built field by field from that validated answer:
//   { customers: [{ id, name }], nextCursor }
// It carries nothing else: no tenant, store, role, grant or membership, no contact, loyalty or money field, no session
// data, no database detail. Chain-wide headers mark every response no-store.
//
// NO AUDIT RECORD. Owner decision (M7A-CUSTOMERS-P1): this read writes no durable audit event; whether a list of
// personal data is audited is recorded open for the privacy and audit design (doc 08 G-AUDIT). The request log the chain
// writes for it names the route, the status and a bounded reason — never a customer, a query value or a body.
//
// FAILURES. The routine's 'denied' (the grant stopped holding between the authorizer and the read) is the same generic
// 403 every other denial is; a continuation naming no customer of the tenant is a 400; a port that throws, overruns its
// deadline or answers out of shape is a 503 whose reason goes to the request log alone — never a cached, partial or
// synthetic page.
//
// M7A-CUSTOMERS-P4 UPDATE — THE DETAIL READ. GET /api/v1/customers/{id}: one customer by id, under the list's permission
// (view_customers), trusted context and session binding, over the same module's conventions. It is the route table's first
// template (routes.ts; the profile read below is the second): /api/v1/customers/ plus one raw segment of 1-128 characters without '/' reaches this handler only
// after the chain has proved the session and decided the permission, so an unauthenticated caller gets the chain's 401 or
// 403 whatever the segment. Then, as the list's query: any query at all, or a segment that is not a canonical lowercase
// uuid (uppercase, %-encoded, braces, anything else), is a 400 invalid_request before the port is asked. A canonical id
// makes EXACTLY ONE port call — no cache, no early answer: the runtime cannot tell another tenant's id from a missing one
// and never tries. The port asks migration 022's session-bound routine, which derives the tenant from the presenting
// session, asserts it equals the trusted scope's (a precondition, never a selector), re-decides the role's current
// Customers level and 017's rechecks on one snapshot, and reads the one row. A missing id and another tenant's id are the
// same 404 {error:'not_found', requestId} — the terminal 404's body shape — with the same headers and one log reason; a
// withdrawn authority is the list's 403; an outage or an out-of-shape answer a 503. 200 { customer: { id, name } } — the
// create's 201 body shape, the list entry's two fields, nothing else. No audit record (the list's owner decision).
//
// M7A-CUSTOMERS-P6 UPDATE — THE PROFILE READ. GET /api/v1/customers/{id}/profile: the same customer's contact record,
// under exactly the detail route's policy (view_customers, trusted context, the session binding and its CSRF witness, no
// body, no idempotency, no recent sign-in) and in exactly its order of refusals: any query 400; no tenant scope or no key
// 403; a segment before '/profile' that is not a canonical lowercase uuid 400; exactly one port call; a throw 503;
// 'denied' 403; 'not_found' the same 404 {error:'not_found', requestId} for a missing and a foreign id; out of shape 503.
// It is the route table's second template (routes.ts): the id segment followed by exactly the literal '/profile'. The port
// asks migration 023's session-bound routine, which delegates the whole decision and the point read to 022's and then
// reads that row's contacts on the same snapshot. 200 { customer: { id, name, phone, email, createdAt } }, in that key
// order: phone and email a stored value or null ("not provided"), createdAt the database's creation time as
// YYYY-MM-DDTHH:mm:ss.sssZ (UTC, toISOString's form) or null — a customer created before migration 023 has no known
// creation time, and none is invented. The answer is untrusted: a phone or email that is not already a value the create
// stores, or a creation time not in exactly that form, is a 503. The list and the detail read stay {id, name}: contacts
// are read here and nowhere else. No audit record (the list's owner decision), and no contact in any log or refusal.
//
// M7A-CUSTOMERS-P7 UPDATE — THE VERSION. The port now asks migration 024's tmpos_customer_edit.m7a_customer_profile, which
// delegates to 023's routine and reads the customer's row version on the same snapshot, and its answer carries `version`
// (a safe integer 1..2^53-1; missing or out of range is the same out-of-shape 503). The 200's JSON body is byte-identical
// to P6's; the version travels as a STRONG ETag on that 200 only — `ETag: "<version>"`, decimal, no leading zero — set
// explicitly, and the 200 is written without Express's send, so its weak body-hash ETag never replaces it and a matching
// If-None-Match (or an If-Modified-Since) never turns the 200 into a 304. No refusal carries one. The edit
// (customerUpdate.ts) sends it back as expectedVersion. No If-Match or If-None-Match is processed here, and Cache-Control
// stays no-store.
//
// M7A-CUSTOMERS-P8 UPDATE — THE NAME SEARCH. The list takes a third optional parameter, `q`, under the same rules (each key at
// most once, nothing else, no empty pair): its raw value is printable ASCII, decoded as application/x-www-form-urlencoded
// (every '+' a space, then decodeURIComponent — a malformed escape or an encoded surrogate is the 400), then trimmed. Empty
// after that (absent, `q=`, `q=+`, `q=%20`) is the unfiltered list exactly as before, its cursor included. Anything else is
// the applied search text, refused (400) when it holds a character no customer field may hold (REFUSED_CHARACTER_RE) or
// more than 200 characters (code points). `limit` and `cursor` keep their raw grammar; the whole query is bounded at 4096
// characters (the old 128 could not carry a search). A search asks the same port with `search` set; the PostgreSQL adapter
// asks migration 025's session-bound routine, which decides the list's authority exactly as 022's read does and matches
// the text anywhere in the name, case-insensitively (ICU root full uppercase of both sides), in the list's (name, id)
// order. A filtered page's continuation is a second cursor kind: tag 0x03, the last customer's id and the first 16 bytes of
// the SHA-256 of the search text's UTF-8 — 33 bytes, 44 base64url characters, canonical spelling only. It is accepted only
// with the same search text: an unfiltered cursor with a search, a filtered one without, or one made for another text is
// the same 400. Like the unfiltered cursor it carries no text, name, tenant or authority. The response shape, the policy,
// the refusals and the logging are the list's: no search text, name or query value reaches a log line or a refusal.
//
// PURE AND PORTABLE: part of the emitted runtime artifact, importing only the runtime. It holds no infrastructure; the
// port is handed to it by the composition root.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import type { TrustedScope } from './principals.js';
import { EnforcementSetupError, PATH_ID_SEGMENT, pathIdBeforeSuffixOf, pathIdOf } from './routes.js';
import type { AuthorizationRequirement, RouteContext, RouteDefinition, RouteHandler } from './routes.js';

export const CUSTOMER_DIRECTORY_PATH = '/api/v1/customers';
/** The detail read's path: the route table's first template, '/api/v1/customers/{id}'. */
export const CUSTOMER_DETAIL_PATH = `${CUSTOMER_DIRECTORY_PATH}${PATH_ID_SEGMENT}`;
/** The profile read's literal suffix after the id segment (M7A-CUSTOMERS-P6). */
export const CUSTOMER_PROFILE_SUFFIX = '/profile';
/** The profile read's path: the route table's second template, '/api/v1/customers/{id}/profile'. */
export const CUSTOMER_PROFILE_PATH = `${CUSTOMER_DETAIL_PATH}${CUSTOMER_PROFILE_SUFFIX}`;
/** The canonical tenant route permission: the Customers domain at View or above. */
export const CUSTOMER_DIRECTORY_PERMISSION = 'view_customers';
export const CUSTOMER_DIRECTORY_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: CUSTOMER_DIRECTORY_PERMISSION });
export const CUSTOMER_DIRECTORY_DEFAULT_LIMIT = 50;
export const CUSTOMER_DIRECTORY_MAX_LIMIT = 100;
/**
 * The longest name a page carries, in characters (Unicode code points) — migration 017's column limit. A longer one is
 * not a row this schema can hold, so the page is a 503 rather than an unbounded response.
 */
export const CUSTOMER_NAME_MAX_CHARACTERS = 200;

/** The longest phone and email, in Unicode scalars — migration 023's CHECKs (M7A-CUSTOMERS-P6). */
export const CUSTOMER_PHONE_MAX_CHARACTERS = 64;
export const CUSTOMER_EMAIL_MAX_CHARACTERS = 254;

/**
 * The characters no customer field may hold: C0 controls (NUL included), DEL, C1 controls, and the line and paragraph
 * separators; a lone surrogate, which is no Unicode scalar value at all; and every Bidi_Control character —
 * tenantDisplayName.ts's set, which 017's CHECK restates for the name and 023's for the contacts. The create's name rule
 * (customerCreate.ts) and the contact rules below share it.
 */
export const REFUSED_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}|\p{Bidi_Control}/u;

/** What a contact normalizer answers for a value no customer may hold: a create refuses it (400), whatever the field. */
export const CONTACT_REFUSED: unique symbol = Symbol('contact refused');
/** A contact as stored, null when not provided, or CONTACT_REFUSED. */
export type CustomerContact = string | null | typeof CONTACT_REFUSED;

/** A contact's common rule: absent (undefined, null, blank after trim) is null; any other non-string refused; else trimmed. */
function contactOf(raw: unknown, max: number, admits: (value: string) => boolean): CustomerContact {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return CONTACT_REFUSED;
  const value = raw.trim();
  if (value === '') return null;
  // Code points; with no lone surrogate (refused first), exactly the scalar values 023's char_length counts.
  if (REFUSED_CHARACTER_RE.test(value) || [...value].length > max) return CONTACT_REFUSED;
  return admits(value) ? value : CONTACT_REFUSED;
}

const ASCII_DIGIT_RE = /[0-9]/;
const WHITE_SPACE_RE = /\p{White_Space}/u;
/** Exactly one '@', with a non-empty part on each side. */
const EMAIL_SHAPE_RE = /^[^@]+@[^@]+$/u;

/**
 * The phone as stored — trimmed, 1-64 scalars, no refused character, at least one ASCII digit, kept as typed otherwise —
 * null when not provided, or CONTACT_REFUSED (M7A-CUSTOMERS-P6; migration 023's customer_phone_chk restates it).
 */
export function normalizeCustomerPhone(raw: unknown): CustomerContact {
  return contactOf(raw, CUSTOMER_PHONE_MAX_CHARACTERS, (phone) => ASCII_DIGIT_RE.test(phone));
}

/**
 * The email as stored — trimmed, 1-254 scalars, no refused or White_Space character, exactly one '@' between non-empty
 * parts, kept as typed otherwise — null when not provided, or CONTACT_REFUSED (023's customer_email_chk restates it).
 */
export function normalizeCustomerEmail(raw: unknown): CustomerContact {
  return contactOf(raw, CUSTOMER_EMAIL_MAX_CHARACTERS, (email) => !WHITE_SPACE_RE.test(email) && EMAIL_SHAPE_RE.test(email));
}

/**
 * Whether `name` could be a stored name by length and encoding: 1-200 characters and well formed (a lone surrogate
 * cannot be stored in a UTF-8 database). The column's character rules (controls, Bidi_Control, edge whitespace) are its
 * own CHECK and are not restated here.
 */
export function isStorableName(name: unknown): name is string {
  // At most two UTF-16 units per character: a cheap bound before anything is copied.
  if (typeof name !== 'string' || name.length === 0 || name.length > 2 * CUSTOMER_NAME_MAX_CHARACTERS) return false;
  // A lone surrogate encodes as U+FFFD, so it does not survive the round trip.
  if (Buffer.from(name, 'utf8').toString('utf8') !== name) return false;
  return Array.from(name).length <= CUSTOMER_NAME_MAX_CHARACTERS;
}

/**
 * Whether `entries` are in the routine's page order, strictly increasing: name in byte order (the "C" collation over
 * UTF-8), then id — a canonical lowercase uuid, whose text order is its byte order. The route checks every page it
 * serves; the PostgreSQL adapter checks every row it reads, the look-ahead row included, which the route never sees.
 */
export function inCustomerPageOrder(entries: readonly { readonly id: string; readonly name: string }[]): boolean {
  // inv: entries[0..i) is strictly increasing; term: i rises to entries.length.
  for (let i = 1; i < entries.length; i++) {
    const before = entries[i - 1];
    const after = entries[i];
    const byName = Buffer.compare(Buffer.from(before.name, 'utf8'), Buffer.from(after.name, 'utf8'));
    if (byName > 0 || (byName === 0 && before.id >= after.id)) return false;
  }
  return true;
}

/**
 * The continuation to read after, as a customer id, the page size, and the applied search text — null for the unfiltered
 * list (M7A-CUSTOMERS-P8). All already validated.
 */
export interface CustomerDirectoryQuery {
  readonly after: string | null;
  readonly limit: number;
  readonly search: string | null;
}

/** The longest search text, in characters (code points): the longest name a customer can hold (M7A-CUSTOMERS-P8). */
export const CUSTOMER_SEARCH_MAX_CHARACTERS = 200;

/**
 * Whether `value` is a search text the list applies: non-empty, already trimmed, no refused character and at most 200
 * code points. The parser's last step, and the PostgreSQL adapter's check before a statement runs.
 */
export function isCustomerSearchText(value: unknown): value is string {
  // At most two UTF-16 units per code point: a cheap bound before anything is copied.
  if (typeof value !== 'string' || value === '' || value.length > 2 * CUSTOMER_SEARCH_MAX_CHARACTERS) return false;
  return value === value.trim() && !REFUSED_CHARACTER_RE.test(value) && [...value].length <= CUSTOMER_SEARCH_MAX_CHARACTERS;
}

/** One customer as the page shows it. */
export interface CustomerDirectoryEntry {
  readonly id: string;
  readonly name: string;
}

/**
 * The port to migration 018's session-bound read (025's for a search), handed the trusted scope and the presenting session's store key
 * (RouteContext.sessionKey), a SQL parameter it never logs, echoes or stores. Its answer is untrusted input, expected to be one of
 *   { outcome: 'page', customers: CustomerDirectoryEntry[], hasMore: boolean }  — at most query.limit customers;
 *   { outcome: 'denied' }                                                      — the scope's grant no longer holds;
 *   { outcome: 'cursor_unknown' }                                              — query.after names no customer of the tenant.
 * A throw is an outage.
 */
export interface CustomerDirectoryPort {
  page(scope: TrustedScope, sessionKey: string, query: CustomerDirectoryQuery, signal: AbortSignal): unknown;
}

/** What the route is built from. */
export interface CustomerDirectoryPorts {
  readonly customers: CustomerDirectoryPort;
}

/**
 * Any uuid in PostgreSQL's canonical lowercase text form — no version or variant constraint, because migration 017's
 * customer_id column accepts every uuid. A stricter pattern would turn one stored id into a 503 for every page that
 * holds it, and a continuation encoding it could never be decoded again.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One pair of the query: a key and its raw value, split at the first '='. */
const QUERY_PAIR_RE = /^(limit|cursor|q)=(.*)$/s;
/** `limit` and `cursor` keep their strict raw grammar: no percent-encoding, at most a filtered cursor's 44 characters. */
const PLAIN_VALUE_RE = /^[A-Za-z0-9_-]{1,44}$/;
/** `q`'s raw value: printable ASCII only (what a form or percent encoder produces), possibly empty. */
const SEARCH_VALUE_RE = /^[\x21-\x7e]*$/;
const LIMIT_RE = /^[1-9][0-9]{0,2}$/;
/** 17 bytes — a tag byte and a 16-byte customer id — as unpadded base64url. */
const CURSOR_RE = /^[A-Za-z0-9_-]{23}$/;
/** 33 bytes — a tag byte, a 16-byte customer id and a 16-byte search digest — as unpadded base64url (M7A-CUSTOMERS-P8). */
const SEARCH_CURSOR_RE = /^[A-Za-z0-9_-]{44}$/;
/** Distinct from the tenant directory's, so neither route's continuation is ever read as the other's. */
const CURSOR_TAG = 0x02;
/** A filtered page's continuation: distinct from the unfiltered one, so neither kind is ever read as the other. */
const SEARCH_CURSOR_TAG = 0x03;
const SEARCH_DIGEST_BYTES = 16;
/** One bound on the whole raw query (M7A-CUSTOMERS-P8; it was 128): room for 200 percent-encoded 4-byte characters. */
const MAX_QUERY_LENGTH = 4096;
const PAGE_KEYS: readonly string[] = ['outcome', 'customers', 'hasMore'];
const ENTRY_KEYS: readonly string[] = ['id', 'name'];

const idBytesOf = (customerId: string): Buffer => Buffer.from(customerId.replace(/-/g, ''), 'hex');
/** The canonical text of 16 id bytes, or null (UUID_RE states it again). */
function idOfBytes(bytes: Buffer): string | null {
  const hex = bytes.toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_RE.test(id) ? id : null;
}
/** The first 16 bytes of the SHA-256 of the search text's UTF-8: binds a continuation to the text without carrying it. */
const searchDigestOf = (search: string): Buffer => createHash('sha256').update(search, 'utf8').digest().subarray(0, SEARCH_DIGEST_BYTES);

/** The opaque continuation for a page that ends at `customerId`. */
export function encodeCustomerCursor(customerId: string): string {
  return Buffer.concat([Buffer.from([CURSOR_TAG]), idBytesOf(customerId)]).toString('base64url');
}

/** The customer id a continuation names, or null unless it is exactly the canonical spelling of one. */
export function decodeCustomerCursor(cursor: string): string | null {
  if (!CURSOR_RE.test(cursor)) return null;
  const bytes = Buffer.from(cursor, 'base64url');
  // Canonical only: decoding ignores the unused low bits of the last character, so a re-encoding that differs means a
  // second spelling of the same bytes, which is refused rather than accepted.
  if (bytes.length !== 17 || bytes[0] !== CURSOR_TAG || bytes.toString('base64url') !== cursor) return null;
  return idOfBytes(bytes.subarray(1));
}

/** The opaque continuation for a filtered page, searching `search`, that ends at `customerId` (M7A-CUSTOMERS-P8). */
export function encodeCustomerSearchCursor(customerId: string, search: string): string {
  return Buffer.concat([Buffer.from([SEARCH_CURSOR_TAG]), idBytesOf(customerId), searchDigestOf(search)]).toString('base64url');
}

/**
 * The customer id a filtered continuation names, or null unless it is exactly the canonical spelling of one made for this
 * same `search` text.
 */
export function decodeCustomerSearchCursor(cursor: string, search: string): string | null {
  if (!SEARCH_CURSOR_RE.test(cursor)) return null;
  const bytes = Buffer.from(cursor, 'base64url');
  // 33 bytes are 44 characters with no unused bits, so the re-encoding check refuses only what the pattern let through.
  if (bytes.length !== 17 + SEARCH_DIGEST_BYTES || bytes[0] !== SEARCH_CURSOR_TAG || bytes.toString('base64url') !== cursor) return null;
  // The digest is of the client's own text, no secret: a plain comparison.
  if (!bytes.subarray(17).equals(searchDigestOf(search))) return null;
  return idOfBytes(bytes.subarray(1, 17));
}

/**
 * `q`'s raw value as the applied search text: null when it is empty after decoding and trimming (the unfiltered list), or
 * undefined for anything the contract refuses — a raw character outside printable ASCII, a malformed escape or encoded
 * surrogate, a refused character, more than 200 code points.
 */
function searchOf(raw: string): string | null | undefined {
  if (!SEARCH_VALUE_RE.test(raw)) return undefined;
  let text: string;
  try {
    text = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return undefined; // a URIError: never its message, which would carry the value
  }
  text = text.trim();
  if (text === '') return null;
  return isCustomerSearchText(text) ? text : undefined;
}

/** The request target's query as a validated CustomerDirectoryQuery, or null for anything the contract refuses. */
export function parseCustomerDirectoryQuery(target: string): CustomerDirectoryQuery | null {
  const at = target.indexOf('?');
  if (at < 0) return Object.freeze({ after: null, limit: CUSTOMER_DIRECTORY_DEFAULT_LIMIT, search: null });
  const raw = target.slice(at + 1);
  if (raw.length > MAX_QUERY_LENGTH) return null;
  let cursor: string | null = null;
  let limit: number | null = null;
  let search: string | null = null;
  const seen = new Set<string>();
  // inv: every pair before this one matched the contract once per key; term: the pairs are finite.
  for (const pair of raw.split('&')) {
    const match = QUERY_PAIR_RE.exec(pair);
    if (match === null || seen.has(match[1])) return null;
    seen.add(match[1]);
    if (match[1] === 'q') {
      const text = searchOf(match[2]);
      if (text === undefined) return null;
      search = text;
    } else if (!PLAIN_VALUE_RE.test(match[2])) {
      return null;
    } else if (match[1] === 'limit') {
      if (!LIMIT_RE.test(match[2])) return null;
      limit = Number(match[2]);
      if (limit > CUSTOMER_DIRECTORY_MAX_LIMIT) return null;
    } else {
      cursor = match[2];
    }
  }
  // The cursor is read only once the search is known: its kind, and a filtered one's text, must be this request's.
  let after: string | null = null;
  if (cursor !== null) {
    after = search === null ? decodeCustomerCursor(cursor) : decodeCustomerSearchCursor(cursor, search);
    if (after === null) return null;
  }
  return Object.freeze({ after, limit: limit ?? CUSTOMER_DIRECTORY_DEFAULT_LIMIT, search });
}

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

type PageAnswer = { readonly customers: readonly CustomerDirectoryEntry[]; readonly hasMore: boolean } | 'denied' | 'cursor_unknown';

/** The port's answer as a validated page, 'denied', 'cursor_unknown' — or null for anything out of shape. Never throws. */
export function customerDirectoryPageOf(raw: unknown, query: CustomerDirectoryQuery): PageAnswer | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied') return hasExactly(raw, ['outcome']) ? 'denied' : null;
    if (outcome === 'cursor_unknown') return hasExactly(raw, ['outcome']) && query.after !== null ? 'cursor_unknown' : null;
    if (outcome !== 'page' || !hasExactly(raw, PAGE_KEYS)) return null;
    const { customers, hasMore } = raw;
    if (!Array.isArray(customers) || typeof hasMore !== 'boolean') return null;
    // The length is read once, so the bound checked is the bound the loop runs to.
    const count = customers.length;
    if (count > query.limit) return null;
    // A next page exists only behind a full one: the port read one row more than it returned.
    if (hasMore && count !== query.limit) return null;
    const seen = new Set<string>();
    const out: CustomerDirectoryEntry[] = [];
    // inv: out holds a validated copy of each entry below i, and seen their ids; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const entry: unknown = customers[i];
      if (!isPlain(entry) || !hasExactly(entry, ENTRY_KEYS)) return null;
      // Read once each, so a value validated is the value copied.
      const { id, name } = entry;
      if (typeof id !== 'string' || !UUID_RE.test(id) || seen.has(id) || id === query.after) return null;
      if (!isStorableName(name)) return null;
      seen.add(id);
      out.push(Object.freeze({ id, name }));
    }
    if (!inCustomerPageOrder(out)) return null;
    return Object.freeze({ customers: Object.freeze(out), hasMore });
  } catch {
    return null; // a throwing getter or proxy trap is never a page
  }
}

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** The customer directory route over `ports`, for a route table; refused at construction without its port. */
export function createCustomerDirectoryRoute(ports: CustomerDirectoryPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.customers;
  if (typeof reader?.page !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // One more port call in the chain, bounded like the rest so the whole chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  const handler: RouteHandler = async (req, res, ctx) => {
    const query = parseCustomerDirectoryQuery(typeof req.url === 'string' ? req.url : '');
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'customer_directory_query_invalid');
    // The chain refused this request already unless a tenant scope was resolved; this states it again.
    const scope = ctx.trusted;
    if (scope === null || scope.scope !== 'tenant' || scope.tenant === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    // The route declares the binding, so the chain hands the key; this states it again.
    const { sessionKey } = ctx;
    if (sessionKey === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.page(scope, sessionKey, query, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('customer_directory', err));
    }
    const page = customerDirectoryPageOf(raw, query);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'customer_directory_denied');
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'customer_directory_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'customer_directory_answer_invalid');
    const last = page.customers[page.customers.length - 1];
    // A filtered page continues as a filtered cursor bound to the same text (M7A-CUSTOMERS-P8).
    const next = page.hasMore && last !== undefined
      ? (query.search === null ? encodeCustomerCursor(last.id) : encodeCustomerSearchCursor(last.id, query.search))
      : null;
    res.status(200).json({ customers: page.customers.map((c) => ({ id: c.id, name: c.name })), nextCursor: next });
  };
  const route: RouteDefinition = {
    method: 'GET',
    path: CUSTOMER_DIRECTORY_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: CUSTOMER_DIRECTORY_REQUIREMENT }),
    body: Object.freeze({ kind: 'none' }),
    idempotency: 'none',
    // A read, but one that names whose authority it reads under: the routine re-confirms that exact grant and reads
    // only its tenant, so the route needs the resolved scope, never a verified principal alone. No recent sign-in.
    trustedContext: 'required',
    recentAuth: 'none',
    // The database binds the read to the presenting minted session, so the handler is handed its store key.
    sessionBinding: 'required',
    handler,
  };
  return Object.freeze(route);
}

/**
 * The port to migration 022's session-bound detail read, handed the trusted scope, the presenting session's store key (a
 * SQL parameter it never logs, echoes or stores) and a canonical customer id. Its answer is untrusted input, expected to be
 *   { outcome: 'customer', id, name } — id exactly the one asked for;
 *   { outcome: 'not_found' }         — no customer of the session's tenant has that id (missing and foreign alike);
 *   { outcome: 'denied' }            — the authority no longer holds.
 * A throw is an outage.
 */
export interface CustomerDetailPort {
  get(scope: TrustedScope, sessionKey: string, customerId: string, signal: AbortSignal): unknown;
}

/** What the detail route is built from. */
export interface CustomerDetailPorts {
  readonly customerDetail: CustomerDetailPort;
}

const DETAIL_KEYS: readonly string[] = ['outcome', 'id', 'name'];

/** The port's answer as {id, name}, 'not_found' or 'denied' — or null for anything out of shape. Never throws. */
export function customerDetailOf(raw: unknown, customerId: string): CustomerDirectoryEntry | 'not_found' | 'denied' | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found') return hasExactly(raw, ['outcome']) ? outcome : null;
    if (outcome !== 'customer' || !hasExactly(raw, DETAIL_KEYS)) return null;
    // Read once each, so a value validated is the value copied.
    const { id, name } = raw;
    if (typeof id !== 'string' || id !== customerId || !UUID_RE.test(id) || !isStorableName(name)) return null;
    return Object.freeze({ id, name });
  } catch {
    return null; // a throwing getter or proxy trap is never a customer
  }
}

/** The customer detail route over `ports`, for a route table; refused at construction without its port. */
export function createCustomerDetailRoute(ports: CustomerDetailPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.customerDetail;
  if (typeof reader?.get !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  const handler: RouteHandler = async (req, res, ctx) => {
    // No query is part of this contract: any at all, an empty one included, is refused.
    if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'customer_detail_query_invalid');
    const scope = ctx.trusted;
    if (scope === null || scope.scope !== 'tenant' || scope.tenant === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const { sessionKey } = ctx;
    if (sessionKey === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    // The same req.path the table matched. Anything but one canonical lowercase uuid is the list's bounded 400.
    const id = pathIdOf(typeof req.path === 'string' ? req.path : '');
    if (id === null) return refuse(res, ctx, 400, 'invalid_request', 'customer_detail_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.get(scope, sessionKey, id, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('customer_detail', err));
    }
    const answer = customerDetailOf(raw, id);
    if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'customer_detail_denied');
    // Missing and foreign alike: one status, one body shape (the terminal 404's), one log reason.
    if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'customer_not_found');
    if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'customer_detail_answer_invalid');
    res.status(200).json({ customer: { id: answer.id, name: answer.name } });
  };
  const route: RouteDefinition = {
    method: 'GET',
    path: CUSTOMER_DETAIL_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: CUSTOMER_DIRECTORY_REQUIREMENT }),
    body: Object.freeze({ kind: 'none' }),
    idempotency: 'none',
    // The list's reasons: the routine re-confirms that exact grant and reads only its tenant, bound to the presenting
    // minted session. No recent sign-in.
    trustedContext: 'required',
    recentAuth: 'none',
    sessionBinding: 'required',
    handler,
  };
  return Object.freeze(route);
}

/** One customer's contact record as the profile read shows it (M7A-CUSTOMERS-P6). */
export interface CustomerProfile {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly createdAt: string | null;
  /** The customer's row version (M7A-CUSTOMERS-P7, migration 024): the profile 200's strong ETag, never a body field. */
  readonly version: number;
}

/**
 * The port to migration 024's session-bound profile read, handed exactly what the detail port is. Its answer is untrusted
 * input, expected to be
 *   { outcome: 'customer', id, name, phone, email, createdAt, version }
 *                                                             — id exactly the one asked for; phone, email a stored value
 *                                                               or null; createdAt YYYY-MM-DDTHH:mm:ss.sssZ or null;
 *                                                               version a safe integer 1..2^53-1, on the values' snapshot;
 *   { outcome: 'not_found' }                                  — missing and foreign alike;
 *   { outcome: 'denied' }                                     — the authority no longer holds.
 * A throw is an outage.
 */
export interface CustomerProfilePort {
  get(scope: TrustedScope, sessionKey: string, customerId: string, signal: AbortSignal): unknown;
}

/** What the profile route is built from. */
export interface CustomerProfilePorts {
  readonly customerProfile: CustomerProfilePort;
}

const PROFILE_KEYS: readonly string[] = ['outcome', 'id', 'name', 'phone', 'email', 'createdAt', 'version'];
/** toISOString's exact form: a four-digit year, milliseconds, UTC. */
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Whether `value` is a creation time in exactly toISOString's form — an instant that spells itself back — or null. */
export function isCustomerCreatedAt(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !CREATED_AT_RE.test(value)) return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

/** Whether `value` is a stored contact for `normalize`: null, or a string that normalizes to itself (trimmed and admitted). */
const isStoredContact = (value: unknown, normalize: (raw: unknown) => CustomerContact): value is string | null =>
  value === null || (typeof value === 'string' && normalize(value) === value);

/** The port's answer as a CustomerProfile, 'not_found' or 'denied' — or null for anything out of shape. Never throws. */
export function customerProfileOf(raw: unknown, customerId: string): CustomerProfile | 'not_found' | 'denied' | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found') return hasExactly(raw, ['outcome']) ? outcome : null;
    if (outcome !== 'customer' || !hasExactly(raw, PROFILE_KEYS)) return null;
    // Read once each, so a value validated is the value copied.
    const { id, name, phone, email, createdAt, version } = raw;
    if (typeof id !== 'string' || id !== customerId || !UUID_RE.test(id) || !isStorableName(name)) return null;
    if (!isStoredContact(phone, normalizeCustomerPhone) || !isStoredContact(email, normalizeCustomerEmail)) return null;
    if (!isCustomerCreatedAt(createdAt)) return null;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null;
    return Object.freeze({ id, name, phone, email, createdAt, version });
  } catch {
    return null; // a throwing getter or proxy trap is never a customer
  }
}

/** The customer profile route over `ports`, for a route table; refused at construction without its port. */
export function createCustomerProfileRoute(ports: CustomerProfilePorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.customerProfile;
  if (typeof reader?.get !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  // The detail handler's order of refusals, step for step; only the id's place in the path and the answer differ.
  const handler: RouteHandler = async (req, res, ctx) => {
    if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'customer_profile_query_invalid');
    const scope = ctx.trusted;
    if (scope === null || scope.scope !== 'tenant' || scope.tenant === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const { sessionKey } = ctx;
    if (sessionKey === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    // The segment before the literal suffix of the same req.path the table matched.
    const id = pathIdBeforeSuffixOf(typeof req.path === 'string' ? req.path : '', CUSTOMER_PROFILE_SUFFIX);
    if (id === null) return refuse(res, ctx, 400, 'invalid_request', 'customer_profile_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.get(scope, sessionKey, id, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('customer_profile', err));
    }
    const answer = customerProfileOf(raw, id);
    if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'customer_profile_denied');
    // Missing and foreign alike: the detail read's one 404, body shape and log reason.
    if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'customer_not_found');
    if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'customer_profile_answer_invalid');
    // The version as a strong validator (M7A-CUSTOMERS-P7), and the body exactly P6's bytes (what res.json wrote: the same
    // JSON.stringify, content type and length). Written with res.end, never res.json/res.send: Express's send would answer a
    // request whose If-None-Match matches this ETag (or whose If-Modified-Since qualifies) with a bodiless 304, and would
    // add its own weak ETag were none set. This route processes no conditional header: every 200 is the full representation.
    const bytes = Buffer.from(JSON.stringify({
      customer: { id: answer.id, name: answer.name, phone: answer.phone, email: answer.email, createdAt: answer.createdAt },
    }), 'utf8');
    res.status(200);
    res.setHeader('ETag', `"${answer.version}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(bytes.length));
    res.end(bytes);
  };
  const route: RouteDefinition = {
    method: 'GET',
    path: CUSTOMER_PROFILE_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: CUSTOMER_DIRECTORY_REQUIREMENT }),
    body: Object.freeze({ kind: 'none' }),
    idempotency: 'none',
    // The detail read's reasons, unchanged: the routine re-confirms that exact grant and reads only its tenant, bound to the
    // presenting minted session (and, by the binding, to the session the client checked). No recent sign-in.
    trustedContext: 'required',
    recentAuth: 'none',
    sessionBinding: 'required',
    handler,
  };
  return Object.freeze(route);
}

// Phase 4.0 M7b — a store's issuing settings: the seller values and the per-store tax mode an issued invoice snapshots, read
// and written by the store's owner (M7B-INVOICES-ISSUE-P1; docs/phase-4/12 §10, ADR-50; G-IAM, G-IDEMPOT, G-AUDIT;
// migration 034, schema tmpos_invoice_issue).
//
// THE TWO ROUTES, the route table's tenant templates (routes.ts), each a session route of the TENANT boundary requiring the
// owner-only tenant permission edit_issuing_settings (m5CanonicalPermissions.ts: store_owner on exactly one tenant grant,
// limitation 'none', as edit_role_levels; a store or platform grant never satisfies it):
//   GET /api/v1/issuing-settings/{id}  — the store's current settings, or that it has none (recent sign-in: none)
//   PUT /api/v1/issuing-settings/{id}  — a new version of them (a command, under a key, recent sign-in required)
// {id} is a store of the trusted tenant: a SELECTOR, never authority. The tenant is the one the owner's session is admitted
// to, derived in the database from the presenting session's key; a store that is not one of that tenant's readable stores
// (missing, another tenant's) is the 404 on the read, and on the write a store that is missing, another tenant's or not in a
// write status is the 404, rolled back.
//
// THE VALUES (§10.4; migration 034's CHECKs restate every rule PostgreSQL can represent). Each text value is trimmed, must
// hold a VISIBLE scalar, and refuses C0/C1 controls (NUL included), DEL, U+2028/U+2029, a lone surrogate and every
// Bidi_Control character — the customer name's pipeline (customerCreate.ts normalizePlainText), imported, never restated:
//   legalName 1-200 scalars; storeName 1-120 (the invoice-facing store name: versioned issuing configuration, never a store
//   rename and never public.store.store_name); taxRegistrationId JSON null (absent) or 1-64;
//   postalAddress — the whole value trimmed, then 1-8 lines split on U+000A (LF: the one control admitted, and only here),
//   each line trimmed and judged by the same pipeline at 120 scalars (so every line is non-empty and holds a visible
//   scalar); a CR anywhere is refused, never trimmed away; the stored value is the lines joined by one LF.
// The tax setting is exactly { "mode": "exclusive_rate", "rateMilliPercent": <integer 0..100000> } (thousandths of a
// percent) or exactly { "mode": "none" } ("No tax calculated": total = subtotal). There is no default mode or rate, and an
// explicit 0 rate is not 'none'. Any other key, mode or combination, a fractional, negative, -0 or out-of-range rate is the 400.
//
// THE READ. 200 { "issuingSettings": { "storeId", "version": 0, "configured": false } } for a store with none, or 200 {
// "issuingSettings": { "storeId", "version": n, "configured": true, "legalName", "storeName", "postalAddress",
// "taxRegistrationId": string|null, "tax": <tax setting> } }. Session-bound (the presenting session's CSRF token in
// X-TMPOS-Session-CSRF, even on GET): the handler refuses any query (400), states the trusted TENANT scope again (403),
// judges the id segment (400), then hands migration 034's STABLE definer read the session key, the trusted tenant (its
// expected one, a precondition) and the store id; every answer is validated again here, and anything out of shape is the
// bounded 503. No read writes an audit record. Chain-wide headers mark every answer no-store.
//
// THE WRITE. Request exactly { expectedTenant, expectedVersion, legalName, storeName, postalAddress, taxRegistrationId, tax }.
// expectedTenant — the tenant the owner's read was answered in — is a PRECONDITION: another tenant is the unsealed 409
// write_conflict, rolled back. expectedVersion is the version the read reported (0..2^53 - 2): 0 means "the store has no
// settings yet", and the first write creates version 1 and the store's invoice-number counter at 0 in the same
// transaction; another version — a first write when settings exist included — is the SEALED 409 write_conflict. Every
// accepted write is a NEW version (expectedVersion + 1) with one audit record, even when every value equals the previous
// version's: there is no no-op, so a change-away/change-back never recreates a version a stale review holds. A
// create-mode command (each write its own aggregate, type store_issuing_settings_change; the settings' version is 034's,
// never the store's aggregate version), committed by the tenant store: the lease fence, the tenant revalidation
// (edit_issuing_settings decided again, its recent-sign-in deadline on the database clock), the mutator's one call into
// tmpos_invoice_issue.m7b_issuing_settings_set (postgresInvoiceIssuing.ts, which judges that deadline once more after the
// routine's lock waits), one audit record at tenant scope naming the STORE as its subject with the reason code
// issuing_settings_tax_exclusive_rate | issuing_settings_tax_none and a fixed reason naming the new version (and, in the
// rate mode, the rate) — never seller text — NO outbox event, the sealed 200 (the read's body at expectedVersion + 1, the
// normalized values), COMMIT. The body is bounded at 8 KiB.
//
// THE CHANGE SET. Scalars and, for the postal address, ONE bounded rows field of { line } records (outbox.ts): a change-set
// string holds no control character and at most 508 UTF-16 units, so the address's LF-joined form (up to 967 scalars) can
// never be one string field; the mutator joins the lines with LF. taxRegistrationId is '' when absent (a record holds no
// null) beside hasTaxRegistrationId; taxRateMilliPercent is 0 under 'none' and is never bound then.
//
// DA-119 stays open: a live store-owner key can call 034's set routine directly and change the legal issuer or tax mode
// without an audit record (doc 12 §10.10). Retention, privacy duties and legal review stay pre-launch.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but its context and writes nothing; the read's port is handed in by the composition root.
import type { Response } from 'express';
import type { CommandContract } from './commandTransaction.js';
import { normalizePlainText } from './customerCreate.js';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import type { TrustedScope } from './principals.js';
import { COMMAND_REQUEST_INVALID, EnforcementSetupError, PATH_ID_SEGMENT, pathIdOf } from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteContext, RouteDefinition } from './routes.js';

/** The tenant template both routes share (routes.ts tenant templates): {id} is the store. */
export const ISSUING_SETTINGS_PATH = `/api/v1/issuing-settings${PATH_ID_SEGMENT}`;
/** The owner-only tenant route permission (m5CanonicalPermissions.ts). */
export const ISSUING_SETTINGS_PERMISSION = 'edit_issuing_settings';
export const ISSUING_SETTINGS_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: ISSUING_SETTINGS_PERMISSION });

/** The text bounds in Unicode scalar values (§10.4; migration 034's CHECKs). */
export const ISSUING_LEGAL_NAME_MAX_SCALARS = 200;
export const ISSUING_STORE_NAME_MAX_SCALARS = 120;
export const ISSUING_TAX_REGISTRATION_ID_MAX_SCALARS = 64;
export const ISSUING_POSTAL_ADDRESS_MAX_LINES = 8;
export const ISSUING_POSTAL_ADDRESS_LINE_MAX_SCALARS = 120;
/** The largest rate, in thousandths of a percent: 100 %. */
export const ISSUING_TAX_RATE_MAX = 100_000;
export const ISSUING_TAX_MODES: readonly string[] = Object.freeze(['exclusive_rate', 'none']);
/** The write's body bound (§10.3): 8 KiB. */
export const ISSUING_SETTINGS_MAX_BODY_BYTES = 8 * 1024;

/** A canonical lowercase uuid of any version: 034's columns accept every uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
/** A safe integer at or above `min`, never -0. */
const isWhole = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && !Object.is(v, -0);
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
/** Exactly `keys` as own enumerable keys, in any order. */
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

// ---------------------------------------------------------------------------
// The values: text, the postal address and the tax setting
// ---------------------------------------------------------------------------

/** The legal seller name as stored, or null: the customer name's pipeline at 200 scalars. */
export const normalizeLegalName = (raw: unknown): string | null => normalizePlainText(raw, ISSUING_LEGAL_NAME_MAX_SCALARS);
/** The invoice-facing store name as stored, or null: the same pipeline at 120 scalars. */
export const normalizeIssuingStoreName = (raw: unknown): string | null => normalizePlainText(raw, ISSUING_STORE_NAME_MAX_SCALARS);
/** A present tax registration id as stored, or null: the same pipeline at 64 scalars (absence is JSON null, judged by the caller). */
export const normalizeTaxRegistrationId = (raw: unknown): string | null => normalizePlainText(raw, ISSUING_TAX_REGISTRATION_ID_MAX_SCALARS);

/** The postal address's lines as stored, or null (header): 1-8 lines, each the pipeline at 120 scalars, no CR anywhere. */
export function postalAddressLinesOf(raw: unknown): readonly string[] | null {
  if (typeof raw !== 'string' || raw.includes('\r')) return null; // a CR is refused, never trimmed away
  const lines = raw.trim().split('\n');
  if (lines.length > ISSUING_POSTAL_ADDRESS_MAX_LINES) return null;
  const out: string[] = [];
  // inv: out holds each line below i, normalized; term: i rises to lines.length (at most 8).
  for (const line of lines) {
    const text = normalizePlainText(line, ISSUING_POSTAL_ADDRESS_LINE_MAX_SCALARS);
    if (text === null) return null; // an empty, invisible, over-long or refused line
    out.push(text);
  }
  return Object.freeze(out);
}

/** The postal address as stored — its lines joined by one LF — or null. */
export function normalizePostalAddress(raw: unknown): string | null {
  const lines = postalAddressLinesOf(raw);
  return lines === null ? null : lines.join('\n');
}

/** A store's tax setting (§10.4): one exclusive rate in thousandths of a percent, or no tax calculated. */
export type TaxSetting = Readonly<{ mode: 'exclusive_rate'; rateMilliPercent: number }> | Readonly<{ mode: 'none' }>;

const NO_TAX: TaxSetting = Object.freeze({ mode: 'none' });

/** `raw` as a tax setting — exactly one of the two shapes, a rate an integer 0..100000 and never -0 — or null. Never throws. */
export function taxSettingOf(raw: unknown): TaxSetting | null {
  try {
    if (!isPlain(raw)) return null;
    const { mode, rateMilliPercent } = raw; // read once each
    if (mode === 'none') return hasExactly(raw, ['mode']) ? NO_TAX : null;
    if (mode !== 'exclusive_rate' || !hasExactly(raw, ['mode', 'rateMilliPercent'])) return null;
    return isWhole(rateMilliPercent, 0) && rateMilliPercent <= ISSUING_TAX_RATE_MAX ? Object.freeze({ mode, rateMilliPercent }) : null;
  } catch {
    return null; // a throwing getter is never a setting
  }
}

/** The settings as the read and the write answer them (§10.4). */
export type IssuingSettingsView =
  | Readonly<{ storeId: string; version: 0; configured: false }>
  | Readonly<{
    storeId: string; version: number; configured: true; legalName: string; storeName: string; postalAddress: string;
    taxRegistrationId: string | null; tax: TaxSetting;
  }>;

/** The seller values every configured view, preview and issued snapshot carries, each as this module stores it. */
export interface SellerValues {
  readonly legalName: string;
  readonly storeName: string;
  readonly postalAddress: string;
  readonly taxRegistrationId: string | null;
}

/**
 * The four seller values of `v` as a frozen copy, each read ONCE and exactly as the write would store it (re-judged on the
 * way out) — or null. The values validated are the values returned.
 */
export function sellerValuesOf(v: Record<string, unknown>): SellerValues | null {
  const { legalName, storeName, postalAddress, taxRegistrationId } = v;
  if (typeof legalName !== 'string' || normalizeLegalName(legalName) !== legalName) return null;
  if (typeof storeName !== 'string' || normalizeIssuingStoreName(storeName) !== storeName) return null;
  if (typeof postalAddress !== 'string' || normalizePostalAddress(postalAddress) !== postalAddress) return null;
  const taxId = taxRegistrationId === null ? null
    : typeof taxRegistrationId === 'string' && normalizeTaxRegistrationId(taxRegistrationId) === taxRegistrationId ? taxRegistrationId : undefined;
  if (taxId === undefined) return null;
  return Object.freeze({ legalName, storeName, postalAddress, taxRegistrationId: taxId });
}

const NONE_VIEW_KEYS: readonly string[] = ['storeId', 'version', 'configured'];
const VIEW_KEYS: readonly string[] = ['storeId', 'version', 'configured', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax'];

/**
 * The port's answer as a validated view, 'denied' or 'not_found' — or null for anything out of shape: the store asked for;
 * version 0 and nothing else unconfigured, or a version 1..2^53 - 1 with every seller value servable and a tax setting.
 * Never throws.
 */
export function issuingSettingsOf(raw: unknown, storeId: string): IssuingSettingsView | 'denied' | 'not_found' | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found') return hasExactly(raw, ['outcome']) ? outcome : null;
    if (outcome !== 'settings' || !hasExactly(raw, ['outcome', 'issuingSettings'])) return null;
    const view: unknown = raw.issuingSettings;
    if (!isPlain(view)) return null;
    const { storeId: named, version, configured, tax: rawTax } = view; // read once each
    if (named !== storeId || !isUuid(storeId)) return null;
    if (configured === false) {
      return hasExactly(view, NONE_VIEW_KEYS) && version === 0 && !Object.is(version, -0) ? Object.freeze({ storeId, version: 0, configured: false }) : null;
    }
    if (configured !== true || !hasExactly(view, VIEW_KEYS) || !isWhole(version, 1)) return null;
    const seller = sellerValuesOf(view);
    const tax = taxSettingOf(rawTax);
    if (seller === null || tax === null) return null;
    return Object.freeze({ storeId, version, configured: true, ...seller, tax });
  } catch {
    return null; // a throwing getter or proxy trap is never an answer
  }
}

/** A view as its JSON body: fresh objects, the tax setting copied by mode. */
function viewBody(view: IssuingSettingsView): Record<string, unknown> {
  if (!view.configured) return { storeId: view.storeId, version: 0, configured: false };
  return {
    storeId: view.storeId, version: view.version, configured: true, legalName: view.legalName, storeName: view.storeName, postalAddress: view.postalAddress,
    taxRegistrationId: view.taxRegistrationId, tax: taxBody(view.tax),
  };
}

/** A tax setting as its JSON body. */
export const taxBody = (tax: TaxSetting): Record<string, unknown> =>
  (tax.mode === 'none' ? { mode: 'none' } : { mode: 'exclusive_rate', rateMilliPercent: tax.rateMilliPercent });

// ---------------------------------------------------------------------------
// The write: its contract, its planner and its route
// ---------------------------------------------------------------------------

const ID_FIELD = Object.freeze({ type: 'string', maxLength: 36 } as const);
/** Each change-set string in UTF-16 units: every scalar is one or two (outbox.ts). */
const textField = (scalars: number) => Object.freeze({ type: 'string', maxLength: scalars * 2 } as const);

export const ISSUING_SETTINGS_UPDATE_CONTRACT: CommandContract = Object.freeze({
  kind: 'tenant.issuing_settings.update',
  mode: 'create',
  aggregateType: 'store_issuing_settings_change',
  // The scope of the trusted context it commits under, declared (M7B-INVOICES-P1, design R4: required, never defaulted).
  contextScope: 'tenant',
  changes: Object.freeze({
    // The path's store (a selector) and the two preconditions, judged by the mutator's routine.
    storeId: ID_FIELD,
    expectedTenant: ID_FIELD,
    expectedVersion: Object.freeze({ type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER - 1 } as const),
    legalName: textField(ISSUING_LEGAL_NAME_MAX_SCALARS),
    storeName: textField(ISSUING_STORE_NAME_MAX_SCALARS),
    // The address's lines as one rows field (header: THE CHANGE SET), joined by LF by the mutator.
    postalAddress: Object.freeze({
      type: 'rows', maxRows: ISSUING_POSTAL_ADDRESS_MAX_LINES, fields: Object.freeze({ line: textField(ISSUING_POSTAL_ADDRESS_LINE_MAX_SCALARS) }),
    } as const),
    hasTaxRegistrationId: Object.freeze({ type: 'boolean' } as const),
    taxRegistrationId: textField(ISSUING_TAX_REGISTRATION_ID_MAX_SCALARS),
    taxMode: Object.freeze({ type: 'enum', values: ISSUING_TAX_MODES } as const),
    taxRateMilliPercent: Object.freeze({ type: 'integer', min: 0, max: ISSUING_TAX_RATE_MAX } as const),
  }),
  events: Object.freeze([]),
});

const BODY_KEYS: readonly string[] = ['expectedTenant', 'expectedVersion', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax'];

/** The audit annex: the tax mode's reason code and a fixed reason naming the new version and the rate — never seller text. */
export function issuingSettingsAuditOf(version: number, tax: TaxSetting): Readonly<{ reasonCode: string; reason: string }> {
  return Object.freeze(tax.mode === 'exclusive_rate'
    ? { reasonCode: 'issuing_settings_tax_exclusive_rate', reason: `Issuing settings version ${version}: exclusive tax at ${tax.rateMilliPercent} thousandths of a percent.` }
    : { reasonCode: 'issuing_settings_tax_none', reason: `Issuing settings version ${version}: no tax calculated.` });
}

/**
 * The write's plan from its context alone, or COMMAND_REQUEST_INVALID (header: THE WRITE): the runtime's new id, the path's
 * store, the preconditions and the normalized values, no event, the sealed 200 at expectedVersion + 1 and its audit annex.
 */
export function planIssuingSettingsUpdate(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  // The path's store (app.ts: a non-store template's final {id}, canonical lowercase): a selector the routine judges.
  const storeId = ctx.targetId;
  if (!isUuid(storeId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, expectedVersion, legalName: rawLegal, storeName: rawStore, postalAddress: rawAddress, taxRegistrationId: rawTaxId, tax: rawTax } = body;
  if (!isUuid(expectedTenant)) return COMMAND_REQUEST_INVALID;
  // 0..2^53 - 2, so expectedVersion + 1 is still exact and within the column's bound: a version is never wrapped or reset.
  if (!isWhole(expectedVersion, 0) || expectedVersion > Number.MAX_SAFE_INTEGER - 1) return COMMAND_REQUEST_INVALID;
  const legalName = normalizeLegalName(rawLegal);
  const storeName = normalizeIssuingStoreName(rawStore);
  const lines = postalAddressLinesOf(rawAddress);
  const taxRegistrationId = rawTaxId === null ? null : normalizeTaxRegistrationId(rawTaxId);
  const tax = taxSettingOf(rawTax);
  if (legalName === null || storeName === null || lines === null || (rawTaxId !== null && taxRegistrationId === null) || tax === null) {
    return COMMAND_REQUEST_INVALID;
  }
  const version = expectedVersion + 1;
  const view: IssuingSettingsView = {
    storeId, version, configured: true, legalName, storeName, postalAddress: lines.join('\n'), taxRegistrationId, tax,
  };
  return {
    aggregateId: ctx.newAggregateId,
    expectedVersion: null,
    changes: {
      storeId, expectedTenant, expectedVersion, legalName, storeName, postalAddress: lines.map((line) => ({ line })),
      hasTaxRegistrationId: taxRegistrationId !== null, taxRegistrationId: taxRegistrationId ?? '',
      taxMode: tax.mode, taxRateMilliPercent: tax.mode === 'exclusive_rate' ? tax.rateMilliPercent : 0,
    },
    events: [],
    response: { status: 200, body: { issuingSettings: viewBody(view) } },
    audit: issuingSettingsAuditOf(version, tax),
  };
}

// Frozen throughout: one module-level definition is shared by every importer before registration copies it.
const UPDATE_ROUTE: RouteDefinition = {
  method: 'PUT',
  path: ISSUING_SETTINGS_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: ISSUING_SETTINGS_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: ISSUING_SETTINGS_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  // The legal issuer and tax mode change only under a RESOLVED owner grant, on fresh authentication (§10.2). No session key
  // reaches a handler: the store binds it.
  trustedContext: 'required',
  recentAuth: 'required',
  command: Object.freeze({ contract: ISSUING_SETTINGS_UPDATE_CONTRACT, plan: planIssuingSettingsUpdate }),
};

/** The write route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const ISSUING_SETTINGS_UPDATE_ROUTE: RouteDefinition = Object.freeze(UPDATE_ROUTE);

// ---------------------------------------------------------------------------
// The read: its port and its route
// ---------------------------------------------------------------------------

/**
 * The port to migration 034's session-bound settings read, handed the trusted TENANT scope (its tenant is the routine's
 * expected one), the presenting session's key (a SQL parameter it never logs, echoes or stores) and the path's store id.
 * Its answer is untrusted input, expected to be { outcome: 'settings', issuingSettings: IssuingSettingsView } |
 * { outcome: 'denied' } | { outcome: 'not_found' }; a throw is an outage.
 */
export interface IssuingSettingsReadPort {
  settings(scope: TrustedScope, sessionKey: string, storeId: string, signal: AbortSignal): unknown;
}

/** What the read route is built from. */
export interface IssuingSettingsPorts {
  readonly issuingSettings: IssuingSettingsReadPort;
}

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** The store's issuing settings over `ports`; refused at construction without its port. */
export function createIssuingSettingsReadRoute(ports: IssuingSettingsPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.issuingSettings;
  if (typeof reader?.settings !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // One more port call in the chain, bounded like the rest so the whole chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) throw new EnforcementSetupError('port_deadline_invalid');
  const route: RouteDefinition = {
    method: 'GET',
    path: ISSUING_SETTINGS_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: ISSUING_SETTINGS_REQUIREMENT } as const),
    body: Object.freeze({ kind: 'none' } as const),
    idempotency: 'none',
    // The routine re-derives the owner's one tenant grant from the session and reads only that tenant's store.
    trustedContext: 'required',
    // A read: no recent sign-in (§10.3), as the role levels' read-back.
    recentAuth: 'none',
    sessionBinding: 'required',
    handler: async (req, res, ctx) => {
      // The drafts' reopen order: the query, the scope, then the id segment (one canonical lowercase uuid).
      if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'issuing_settings_query_invalid');
      const scope = ctx.trusted;
      if (scope === null || scope.scope !== 'tenant' || scope.tenant === null || ctx.sessionKey === null) {
        return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
      }
      const sessionKey = ctx.sessionKey;
      const storeId = pathIdOf(typeof req.path === 'string' ? req.path : '');
      if (storeId === null) return refuse(res, ctx, 400, 'invalid_request', 'issuing_settings_store_invalid');
      let raw: unknown;
      try {
        raw = await withDeadline(deadlineMs, (signal) => reader.settings(scope, sessionKey, storeId, signal));
      } catch (err) {
        return refuse(res, ctx, 503, 'service_unavailable', outage('issuing_settings', err));
      }
      const answer = issuingSettingsOf(raw, storeId);
      if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'issuing_settings_denied');
      // Missing, another tenant's or not readable: one status, one body shape, one reason.
      if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'issuing_settings_store_not_found');
      if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'issuing_settings_answer_invalid');
      res.status(200).json({ issuingSettings: viewBody(answer) });
    },
  };
  return Object.freeze(route);
}

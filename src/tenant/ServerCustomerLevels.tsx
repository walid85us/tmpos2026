// M7A-CUSTOMERS-P3-R2 — the shop's server-backed editor for the built-in roles' Customers levels.
// M7A-CUSTOMERS-P4 (DA-125) — every save asserts the tenant and version the owner reviewed; the server refuses a
// mismatch with nothing written, and this panel never carries a draft across a tenant or a version it did not review.
//
// This is the only part of the Employees permissions screen whose changes reach the tenant server: the three editable
// built-in roles' Customers level (store_owner is fixed Full), read from GET /api/v1/roles/levels and changed through
// PUT /api/v1/roles/levels. Custom roles and every other domain stay in the local-only grid below it.
//
//   - The server decides everything: who may read (the store owner), who may edit, the tenant, the level that stands.
//     A manager or any other role sees the server's refusal as the "denied" state; nothing here decides authority.
//   - A draft is {level, baseTenant, baseVersion}: the choice and the read it was made against. A save sends exactly
//     that tenant and version as preconditions (never as a selector). Nothing is optimistic: the row shows the server's
//     level, and a draft is marked unsaved until the server confirms it.
//   - An edit is "Saved" ONLY when a PUT answered exactly 200 with the version committed at baseVersion + 1 (a fresh
//     execution or the idempotent replay of the same key) AND the read-back that follows, for the same tenant, shows the
//     requested level at exactly that version. A read-back at a greater version says the change was acknowledged, then
//     changed elsewhere — never "Saved". Nothing else is ever "Saved": a conflict, a 409 in progress, a 5xx, an
//     unexpected body, a 401/403 or no answer at all is read back and reported as what the server now has. A 200 whose
//     read-back shows anything else is "Not confirmed". A row whose level no successful read has established since
//     (a failed read-back) shows it as the LAST KNOWN level; a conflict there offers only Discard.
//   - Conflict: a read (or a 409 write_conflict) showing a version other than a draft's baseVersion turns that draft
//     into a CONFLICT — the server's current level and the unsaved choice, with Discard (drop it) and Reapply (rebase it
//     onto the version just read; the owner must then press Save, under a new key). It is never resubmitted silently.
//   - One Idempotency-Key per attempt, and at most one PUT per Save press: nothing re-sends a PUT on its own (no timer,
//     read, focus, session renewal or Reconnect). An attempt whose outcome stays unknown is HELD explicitly (per role: its
//     key and the exact change it sent — tenant, base version, level, reason): no answer at all, a 409
//     request_in_progress, a 5xx, a body it cannot name, or — once
//     the key may already have committed (a lost attempt, a held one) — any refusal or session failure that does not say
//     what that key did. A held row keeps its draft and says "Not confirmed yet", never "Not saved"; Save re-sends the
//     same key and body (the original expectedVersion). Only an answer that decides the key (a 200, a write_conflict)
//     ends it — or the owner changing the level or the reason, which ends the confirmation at once (the draft then
//     turns into a conflict if its version moved, or an ordinary unsaved draft). A read alone never proves the save.
//   - One reducer holds the context: a generation (bumped on a tenant change) and a per-role attempt id. Every async
//     result is applied only under the generation and attempt that started it; background refreshes never move a role
//     with an attempt in flight (that role is read again once the attempt ends without its own read-back), and a read
//     that started before a later-applied read never overwrites it.
//   - A read naming another tenant than this generation's first read clears every draft, key and status, cancels
//     pending reads and unsent saves, and leaves a persistent notice (until a user switch) that the store changed and
//     no change was sent to the newly connected store. A save already sent is harmless to the new store (the server checks its asserted tenant);
//     its eventual answer is shown only as a detached notice that names no store (the panel cannot know which store it
//     reaches now — A, then B, then A again) and claims no more than the server's answer, never as the new store's save.
//   - One panel per signed-in user (keyed by UID): a user switch or sign-out mounts a fresh panel, so the first render
//     after it shows nothing of the previous user, and no answer to that user's work — detached notices included — is
//     ever applied to the next one (A, then B, then A again is three panels).
//   - Focus/visibility refreshes run one at a time, wait while a save or a sign-in confirmation is under way, and speak
//     only while no later read has started.
//   - A session that ENDS is never re-established on its own (M7A-CUSTOMERS-P6): once the session client has confirmed
//     this user's session, its expiry or revocation answers `ended` — no login, no ID token. Save then sends nothing
//     ("Not saved: your server session ended…", or a held row's "Not confirmed yet…") and offers Reconnect; a focus
//     refresh shows the signed-out state. Only the Reconnect button (server-levels-retry, while signed out or after a
//     save found the session ended) asks the client to log in again; the drafts are kept for the read that follows.
//
// M5-INVOICES-AUTH-P1 — the same panel, parameterised by a domain (DOMAIN_COPY): `domain="invoices"` (the exported
// ServerInvoiceLevels) edits the built-in roles' Invoices LEVEL through GET /api/v1/roles/levels/invoices and the shared PUT.
// Only the level is saved on the tenant server. Since M7B-INVOICES-P1 the server decides the three server-draft operations
// (save, list, reopen — server/runtime/invoiceDrafts.ts) by it, at each store, for the role of the user's store grant there;
// every other invoice is still kept in this browser and not checked by the server, and the Invoices copy says exactly that. Customers keeps its copy, DOM ids and test ids exactly;
// Invoices uses the `server-invoice-level(s)-` prefix, so both panels can sit on one screen without an id collision.
// Two panels share ONE tenant session (the shared session client). Only an explicit Reconnect (or a recent-sign-in
// confirmation) in one panel re-establishes it; that panel then announces "session renewed" and every OTHER panel on the
// same session client re-reads WITHOUT a login (`ensure` finds the live session): a stuck signed-out/unavailable panel
// adopts it, a ready one with nothing in flight refreshes (a changed tenant restarts it, clearing its drafts). Nothing
// else crosses between the panels: no draft, key, status or answer.

import { useEffect, useReducer, useRef, useState } from 'react';
import { EmailAuthProvider, GoogleAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup } from 'firebase/auth';
import { auth } from '../firebase';
import { PERMISSION_DOMAINS, PERMISSION_HIERARCHY, tenantRoles } from '../context/accessConfig';
import { checkReason, REASON_MAX, REASON_MIN } from '../backend-control-plane/console/tenantManagementClient';
import { tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import { EDITABLE_ROLE_IDS, invoiceRoleLevels, roleLevels, type EditableRoleId, type LevelChange, type PutResult, type ReadResult, type RoleLevel, type RoleLevelEntry, type RoleLevelsClient, type RoleLevelsDomain } from './roleLevelsClient';

/** The signed-in shop user's provider identity: ID tokens and a real re-authentication. */
export interface ShopIdentity {
  /** A current ID token for `uid`, or null when that user is not the one signed in here. */
  idToken(uid: string): Promise<string | null>;
  /** How this user proves a recent sign-in: their password, a Google popup, or neither available here. */
  reauthMethod(uid: string): 'password' | 'google' | null;
  /** Re-authenticate `uid` with the provider, then a freshly issued ID token; null when it did not succeed. */
  reauthenticate(uid: string, password: string | null): Promise<string | null>;
}

export const firebaseShopIdentity: ShopIdentity = Object.freeze({
  async idToken(uid: string): Promise<string | null> {
    const user = auth.currentUser;
    return user !== null && user.uid === uid ? user.getIdToken() : null;
  },
  reauthMethod(uid: string): 'password' | 'google' | null {
    const user = auth.currentUser;
    if (user === null || user.uid !== uid) return null;
    const providers = user.providerData.map((p) => p.providerId);
    return providers.includes('password') ? 'password' : providers.includes('google.com') ? 'google' : null;
  },
  async reauthenticate(uid: string, password: string | null): Promise<string | null> {
    const user = auth.currentUser;
    if (user === null || user.uid !== uid) return null;
    try {
      if (password !== null) {
        if (user.email === null) return null;
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      } else {
        await reauthenticateWithPopup(user, new GoogleAuthProvider());
      }
      return await user.getIdToken(true);
    } catch {
      return null;
    }
  },
});

const LEVEL_LABELS: Record<RoleLevel, string> = {
  none: 'None', view: 'View Only', create: 'Create', edit: 'Edit', manage: 'Manage', approve: 'Approve', full: 'Full Access',
};
const roleName = (id: string): string => tenantRoles.find((r) => r.id === id)?.name ?? id;

type Phase = 'loading' | 'ready' | 'denied' | 'unavailable' | 'signed-out';
const PHASE_LABELS: Record<Phase, string> = {
  loading: 'Loading', ready: 'Ready', denied: 'Denied', unavailable: 'Unavailable', 'signed-out': 'Signed out',
};
export const DENIED_NOTE =
  'Server-enforced Customers access can only be viewed and changed by the store owner. Changes in the table below affect this browser only.';
export const INVOICES_DENIED_NOTE =
  'The server-saved Invoices level can only be viewed and changed by the store owner. Changes in the table below affect this browser only.';
export const REFRESH_FAILED_NOTE = 'Could not refresh from the server; values may be out of date.';

/** Everything that differs between the panels: the domain, its copy, and its id prefix (Customers' ids are the original ones). */
interface DomainCopy {
  readonly domain: RoleLevelsDomain;
  readonly levels: readonly string[];
  readonly sectionId: string;
  readonly titleId: string;
  readonly title: string;
  readonly description: string;
  readonly denied: string;
  readonly sessionEnded: string;
  readonly signIn: string;
  /** The panel's DOM ids and test ids: Customers keeps `server-level(s)-…`, Invoices uses `server-invoice-level(s)-…`. */
  readonly id: (base: string) => string;
}
const levelsOf = (domain: string): readonly string[] => PERMISSION_DOMAINS.find((d) => d.id === domain)?.levels ?? [];
const DOMAIN_COPY: Record<RoleLevelsDomain, DomainCopy> = {
  customers: {
    domain: 'customers',
    levels: levelsOf('customers'),
    sectionId: 'server-customer-levels',
    titleId: 'server-customer-levels-title',
    title: 'Server-enforced Customers access',
    description: 'Stored on the store server and enforced on every customer view and create request. Covers the Customers module of the built-in roles only.',
    denied: DENIED_NOTE,
    sessionEnded: 'Your server session ended. Reconnect to see server-enforced Customers access.',
    signIn: 'Sign in with your store account to see server-enforced Customers access.',
    id: (base) => base,
  },
  invoices: {
    domain: 'invoices',
    levels: levelsOf('invoices'),
    sectionId: 'server-invoice-levels',
    titleId: 'server-invoice-levels-title',
    title: 'Server-saved Invoices level',
    description: 'Saved on the store server: only the Invoices level of the built-in roles (store owner fixed). The server uses it to decide who may save, list, open and edit server drafts at a store. Other invoices are still saved in this browser and are not checked by the server.',
    denied: INVOICES_DENIED_NOTE,
    sessionEnded: 'Your server session ended. Reconnect to see the server-saved Invoices level.',
    signIn: 'Sign in with your store account to see the server-saved Invoices level.',
    id: (base) => base.replace(/^server-level(s?)-/, 'server-invoice-level$1-'),
  },
};

// Panels on one session client tell each other when an explicit Reconnect or recent sign-in renewed it.
const renewalListeners = new WeakMap<TenantSessionClient, Set<{ readonly self: object; readonly run: () => void }>>();
function announceRenewed(session: TenantSessionClient, self: object): void {
  for (const l of [...(renewalListeners.get(session) ?? [])]) if (l.self !== self) l.run();
}
export const STORE_CHANGED_NOTICE =
  'The store server now answers for a different store. Unsent changes were cleared. No change was sent to the newly connected store.';
/** The detached notices for a save whose store connection changed while it was out: its answer, never a read-back. */
export const PREVIOUS_STORE = Object.freeze({
  acknowledged: 'A change sent before the store connection changed was acknowledged by the server; it could not be read back here.',
  notSaved: 'A change sent before the store connection changed was not saved.',
  unconfirmed: 'A change sent before the store connection changed could not be confirmed.',
});

/** A held row's line when an attempt did not say what its key did: never "Not saved" (the key may have committed). */
const CONFIRM_AGAIN = Object.freeze({
  sessionEnded: 'Not confirmed yet — your server session ended. Reconnect, then press Save again to check.',
  unreachable: 'Not confirmed yet — the store server could not be reached. Press Save again to check.',
  stepUp: 'Not confirmed yet — sign in again, then press Save again to check.',
  denied: 'Not confirmed yet — the server refused the check. Only the store owner can change these levels.',
  unmatched: 'Not confirmed yet — the server could not match the check. Press Save again to check.',
});

type Tone = 'idle' | 'saving' | 'saved' | 'confirm' | 'conflict' | 'failed' | 'stale' | 'step-up' | 'signed-out' | 'denied';
/** A row's status line and the server version it describes (null: none). */
interface RowStatus { readonly tone: Tone; readonly text: string; readonly version: number | null }
/** An unsaved choice and the read it was made against: the tenant and version its save asserts. */
interface Draft { readonly level: RoleLevel; readonly baseTenant: string; readonly baseVersion: number }
type Rows<T> = Partial<Record<EditableRoleId, T>>;
interface Attempt { readonly roleId: EditableRoleId; readonly id: number }
/** An attempt whose outcome is unknown: its key and the exact change (so the exact body) a confirmation re-sends. */
interface Held { readonly key: string; readonly change: LevelChange }

/** Everything tenant-specific, owned by one reducer and stamped with the generation it belongs to. */
interface PanelState {
  readonly gen: number;
  readonly tenant: string | null; // the tenant the first read of this generation named
  readonly appliedSeq: number; // the start order of the read last applied
  readonly roles: readonly RoleLevelEntry[];
  readonly drafts: Rows<Draft>;
  readonly reasons: Rows<string>;
  readonly statuses: Rows<RowStatus>;
  readonly attempts: Rows<number>; // the attempt in flight, per role
  readonly held: Rows<Held>; // the unresolved attempt, per role: the proof a confirmation is owed (never the tone)
  readonly unread: Rows<true>; // the role's shown level is not established by a successful read since (last known)
  readonly deferred: Rows<true>; // a newer read left this role alone while its attempt was in flight
  readonly deferrals: number; // how many reads have deferred a role (the panel re-reads once per deferral)
  readonly storeChanged: boolean; // survives a tenant restart; cleared only by a user switch
  readonly previous: readonly string[]; // detached notices about saves sent to the previous store
}

type Action =
  | { readonly type: 'reset'; readonly gen: number; readonly user: boolean }
  | { readonly type: 'read'; readonly gen: number; readonly seq: number; readonly tenant: string; readonly roles: readonly RoleLevelEntry[]; readonly attempt?: Attempt }
  | { readonly type: 'draft'; readonly gen: number; readonly roleId: EditableRoleId; readonly level: RoleLevel }
  | { readonly type: 'reason'; readonly gen: number; readonly roleId: EditableRoleId; readonly text: string }
  | { readonly type: 'discard' | 'reapply'; readonly gen: number; readonly roleId: EditableRoleId }
  | { readonly type: 'status'; readonly gen: number; readonly roleId: EditableRoleId; readonly status: RowStatus }
  | { readonly type: 'start'; readonly gen: number; readonly attempt: Attempt }
  | { readonly type: 'finish'; readonly gen: number; readonly attempt: Attempt; readonly status?: RowStatus; readonly draft?: 'keep' | 'clear'; readonly hold?: Held | null; readonly unread?: boolean }
  | { readonly type: 'previous'; readonly gen: number; readonly text: string };

const INITIAL: PanelState = Object.freeze({
  gen: 0, tenant: null, appliedSeq: 0, roles: [], drafts: {}, reasons: {}, statuses: {}, attempts: {}, held: {}, unread: {}, deferred: {}, deferrals: 0,
  storeChanged: false, previous: [],
});

const changedElsewhere = (level: RoleLevel): string => `Changed elsewhere — the server now has ${LEVEL_LABELS[level]}.`;
const conflictText = (level: RoleLevel): string => `Changed elsewhere — the server now has ${LEVEL_LABELS[level]}. Your change is not saved.`;
const without = <T,>(rows: Rows<T>, roleId: EditableRoleId): Rows<T> => {
  const out = { ...rows };
  delete out[roleId];
  return out;
};

/**
 * Apply a read to the rows it may move. A role with an attempt in flight keeps its entry and row unless this is that
 * attempt's own CONSISTENT read-back (its continuation then decides the row); it is marked deferred, to be read again
 * once the attempt ends, and "last known" until a later read succeeds — the attempt may have moved it (R3-3, R4-1). A role
 * this read moves is established (no longer "last known"). A conflict is restated from every read that moves its role,
 * so one whose level could not be read learns it, whatever version the read shows (R3-5). For every
 * other role: a draft whose baseVersion is not the version just read becomes a conflict — or is dropped when the server
 * already has its level — unless its attempt is held for the confirming replay (A2.6). A status without a draft whose version moved: a former
 * "Saved" (or other settled line) says the level changed elsewhere, an idle note is cleared; an action is left alone.
 */
function applyRead(state: PanelState, next: readonly RoleLevelEntry[], own: Attempt | undefined): PanelState {
  const moving = (id: EditableRoleId): boolean => state.attempts[id] === undefined || (own?.roleId === id && own.id === state.attempts[id]);
  let deferred = state.deferred;
  let deferrals = state.deferrals;
  let unread = state.unread;
  const roles = next.map((entry) => {
    const id = entry.roleId as EditableRoleId;
    if (!entry.editable) return entry;
    if (moving(id)) {
      deferred = without(deferred, id);
      unread = without(unread, id);
      return entry;
    }
    const shown = state.roles.find((r) => r.roleId === id) ?? entry;
    deferred = { ...deferred, [id]: true };
    deferrals += 1;
    unread = { ...unread, [id]: true }; // the attempt in flight may have moved it: no longer known to be current
    return shown;
  });
  let drafts = state.drafts;
  let statuses = state.statuses;
  for (const id of EDITABLE_ROLE_IDS) {
    const entry = roles.find((r) => r.roleId === id);
    if (entry === undefined || entry.version === null || state.attempts[id] !== undefined) continue;
    const draft = drafts[id];
    const status = statuses[id];
    if (draft !== undefined) {
      if (state.held[id] === undefined && status?.tone === 'conflict' && status.version !== entry.version) {
        statuses = { ...statuses, [id]: { tone: 'conflict', text: conflictText(entry.level), version: entry.version } };
        continue;
      }
      if (state.held[id] !== undefined || draft.baseVersion === entry.version) continue;
      if (draft.level === entry.level) {
        drafts = without(drafts, id);
        statuses = { ...statuses, [id]: { tone: 'stale', text: changedElsewhere(entry.level), version: entry.version } };
      } else if (status?.tone !== 'conflict' || status.version !== entry.version) {
        statuses = { ...statuses, [id]: { tone: 'conflict', text: conflictText(entry.level), version: entry.version } };
      }
    } else if (status !== undefined && status.version !== null && status.version !== entry.version) {
      if (status.tone === 'idle') statuses = without(statuses, id);
      else if (status.tone === 'saved' || status.tone === 'stale' || status.tone === 'failed' || status.tone === 'conflict') {
        statuses = { ...statuses, [id]: { tone: 'stale', text: changedElsewhere(entry.level), version: entry.version } };
      }
    }
  }
  return { ...state, roles, drafts, statuses, deferred, deferrals, unread };
}

function reduce(state: PanelState, action: Action): PanelState {
  if (action.type === 'reset') {
    return { ...INITIAL, gen: action.gen, storeChanged: !action.user, previous: action.user ? [] : state.previous };
  }
  if (action.gen !== state.gen) return state; // a stale callback: its context was replaced
  const entryOf = (id: EditableRoleId): RoleLevelEntry | undefined => state.roles.find((r) => r.roleId === id);
  switch (action.type) {
    case 'read': {
      if ((state.tenant !== null && action.tenant !== state.tenant) || action.seq <= state.appliedSeq) return state;
      return applyRead({ ...state, tenant: action.tenant, appliedSeq: action.seq }, action.roles, action.attempt);
    }
    case 'draft': {
      const entry = entryOf(action.roleId);
      const tone = state.statuses[action.roleId]?.tone;
      if (state.tenant === null || entry?.version == null || state.attempts[action.roleId] !== undefined || tone === 'conflict') return state;
      const held = without(state.held, action.roleId); // a changed level is a new request: a held attempt ends here
      if (action.level === entry.level) {
        return { ...state, held, drafts: without(state.drafts, action.roleId), statuses: { ...state.statuses, [action.roleId]: { tone: 'idle', text: '', version: entry.version } } };
      }
      return {
        ...state,
        held,
        drafts: { ...state.drafts, [action.roleId]: { level: action.level, baseTenant: state.tenant, baseVersion: entry.version } },
        statuses: { ...state.statuses, [action.roleId]: { tone: 'idle', text: 'Not saved yet.', version: entry.version } },
      };
    }
    case 'reason': {
      const reasons = { ...state.reasons, [action.roleId]: action.text };
      const entry = entryOf(action.roleId);
      const draft = state.drafts[action.roleId];
      if (state.held[action.roleId] === undefined || draft === undefined || entry?.version == null) return { ...state, reasons };
      // A changed reason is a new request: the held confirmation ends at once, and the draft is judged like any other.
      const status: RowStatus = draft.baseVersion !== entry.version
        ? { tone: 'conflict', text: conflictText(entry.level), version: entry.version }
        : { tone: 'idle', text: 'Not saved yet.', version: entry.version };
      return { ...state, reasons, held: without(state.held, action.roleId), statuses: { ...state.statuses, [action.roleId]: status } };
    }
    case 'discard':
    case 'reapply': {
      const entry = entryOf(action.roleId);
      const draft = state.drafts[action.roleId];
      if (state.tenant === null || entry?.version == null || draft === undefined || state.attempts[action.roleId] !== undefined) return state;
      // Reapply rebases only onto a level this panel read for this conflict — never onto a cached one (a failed read-back).
      if (action.type === 'reapply' && (state.unread[action.roleId] || state.statuses[action.roleId]?.version !== entry.version)) return state;
      if (action.type === 'discard' || draft.level === entry.level) {
        return {
          ...state,
          drafts: without(state.drafts, action.roleId),
          reasons: without(state.reasons, action.roleId),
          statuses: without(state.statuses, action.roleId),
        };
      }
      return {
        ...state,
        drafts: { ...state.drafts, [action.roleId]: { level: draft.level, baseTenant: state.tenant, baseVersion: entry.version } },
        statuses: { ...state.statuses, [action.roleId]: { tone: 'idle', text: 'Reapplied to the current server level. Not saved yet.', version: entry.version } },
      };
    }
    case 'status':
      // An attempt owns its row; a conflict stays until Discard or Reapply (a sign-in answer never unlocks it).
      if (state.attempts[action.roleId] !== undefined) return state;
      if (state.statuses[action.roleId]?.tone === 'conflict' && state.drafts[action.roleId] !== undefined) return state;
      return { ...state, statuses: { ...state.statuses, [action.roleId]: action.status } };
    case 'start': {
      const { roleId, id } = action.attempt;
      return {
        ...state,
        attempts: { ...state.attempts, [roleId]: id },
        statuses: { ...state.statuses, [roleId]: { tone: 'saving', text: 'Saving to the server…', version: entryOf(roleId)?.version ?? null } },
      };
    }
    case 'finish': {
      const { roleId, id } = action.attempt;
      if (state.attempts[roleId] !== id) return state; // not this attempt's row any more
      const clear = action.draft === 'clear';
      return {
        ...state,
        attempts: without(state.attempts, roleId),
        drafts: clear ? without(state.drafts, roleId) : state.drafts,
        reasons: clear ? without(state.reasons, roleId) : state.reasons,
        statuses: action.status === undefined ? state.statuses : { ...state.statuses, [roleId]: action.status },
        held: action.hold ? { ...state.held, [roleId]: action.hold } : clear || action.hold === null ? without(state.held, roleId) : state.held,
        unread: action.unread === undefined ? state.unread : action.unread ? { ...state.unread, [roleId]: true } : without(state.unread, roleId),
      };
    }
    case 'previous':
      return { ...state, previous: [...state.previous, action.text] };
  }
}

/**
 * What an answer to a save whose store connection changed while it was out says — and no more (A2.5). For a key that
 * may already have committed (`unresolved`: held, or its first attempt lost) only a 200 acknowledges and only a
 * write_conflict says not saved; any other answer leaves it unconfirmed (R3-1).
 */
const previousStoreText = (answer: PutResult, unresolved: boolean): string =>
  answer.kind === 'ok' ? PREVIOUS_STORE.acknowledged
    : answer.kind === 'conflict' ? PREVIOUS_STORE.notSaved
      : unresolved || answer.kind === 'unknown' || answer.kind === 'in-progress' ? PREVIOUS_STORE.unconfirmed
        : PREVIOUS_STORE.notSaved;

export interface ServerCustomerLevelsProps {
  /** Which domain's level this panel edits (default 'customers'). */
  readonly domain?: RoleLevelsDomain;
  /** The signed-in shop user's UID (the Firebase UID), or null when nobody is signed in. */
  readonly uid: string | null;
  readonly session?: TenantSessionClient;
  readonly levels?: RoleLevelsClient;
  readonly identity?: ShopIdentity;
  readonly newKey?: () => string;
}

/**
 * One panel per signed-in user: a user switch or sign-out mounts a fresh panel (keyed by UID), so its first render shows
 * nothing of the previous user, and nothing that user's work answers later ever reaches it (R2-3).
 */
export default function ServerCustomerLevels(props: ServerCustomerLevelsProps) {
  return <UserPanel key={props.uid ?? ''} {...props} />;
}

/** The Invoices LEVEL editor (M5-INVOICES-AUTH-P1): the same panel over the Invoices domain. */
export function ServerInvoiceLevels(props: Omit<ServerCustomerLevelsProps, 'domain'>) {
  return <UserPanel key={props.uid ?? ''} {...props} domain="invoices" />;
}

function UserPanel({
  uid, domain = 'customers', session = tenantSession, levels = domain === 'invoices' ? invoiceRoleLevels : roleLevels,
  identity = firebaseShopIdentity, newKey,
}: ServerCustomerLevelsProps) {
  const copy = DOMAIN_COPY[domain];
  const { id } = copy;
  const self = useRef({}).current;
  const onRenewed = useRef<() => void>(() => undefined);
  const [st, dispatch] = useReducer(reduce, INITIAL);
  const [phase, setPhase] = useState<Phase>('loading');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<EditableRoleId | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [stepUp, setStepUp] = useState<{ readonly roleId: EditableRoleId; readonly method: 'password' | 'google' | null } | null>(null);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);

  const gen = useRef(0);
  const controller = useRef<AbortController | null>(null); // this generation's reads (and unsent saves)
  const sends = useRef<AbortController | null>(null); // saves already sent: aborted only by a user switch or unmount
  const tenant = useRef<string | null>(null); // the tenant the first read of this generation named
  const readSeq = useRef(0); // the start order of reads
  const attemptSeq = useRef(0);
  const savingRef = useRef(false);
  const refreshingRef = useRef(false); // a focus/visibility refresh is in flight
  const stepUpRef = useRef(false); // a sign-in prompt is showing
  const confirmingRef = useRef(false); // a sign-in confirmation is under way
  const phaseRef = useRef<Phase>('loading');
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef<string | null>(null); // the control to focus after the next render (Discard, Reapply)
  const reread = useRef(0); // the deferral count the panel last re-read for
  phaseRef.current = phase;

  const setStatus = (roleId: EditableRoleId, tone: Tone, text: string, version: number | null): void =>
    dispatch({ type: 'status', gen: gen.current, roleId, status: { tone, text, version } });
  const promptStepUp = (next: { readonly roleId: EditableRoleId; readonly method: 'password' | 'google' | null } | null): void => {
    stepUpRef.current = next !== null;
    setStepUp(next);
  };
  const nextKey = (): string => (newKey ?? (() => crypto.randomUUID()))(); // one fresh Idempotency-Key per new attempt
  /** `reconnect` only from the Reconnect button: the one session step that may sign in again after the session ended. */
  const ensure = (who: string, reconnect = false): Promise<SessionResult> =>
    session.ensure(who, () => identity.idToken(who), reconnect ? { reconnect: true } : undefined);

  useEffect(() => {
    const id = focusNext.current;
    focusNext.current = null;
    if (id !== null) document.getElementById(id)?.focus();
  });

  // A read that arrived while a role's attempt was in flight left that role alone; once the attempt has ended without
  // its own read-back, read again (once per deferral) so that newer value is not lost (R2-6). The marker clears only
  // when a read of that role succeeds; until then the row stays "last known" (R3-3).
  useEffect(() => {
    const waiting = EDITABLE_ROLE_IDS.some((id) => st.deferred[id] === true && st.attempts[id] === undefined);
    if (!waiting || reread.current === st.deferrals || phase !== 'ready' || savingRef.current || confirmingRef.current || refreshingRef.current) return;
    reread.current = st.deferrals;
    void load('refresh');
  });

  // The sign-in prompt takes focus when it appears: the password field, or the Google button (AM7).
  useEffect(() => {
    if (stepUp === null) return;
    (stepUp.method === 'password' ? passwordRef.current : confirmRef.current)?.focus();
  }, [stepUp]);

  /**
   * A read answer for this generation: false when it named another tenant (the panel has restarted, clearing every
   * draft and key, and says the store changed). `attempt` marks a save's own read-back.
   */
  const accept = (answer: Extract<ReadResult, { kind: 'ok' }>, seq: number, attempt?: Attempt): boolean => {
    if (tenant.current === null) tenant.current = answer.tenant;
    if (answer.tenant !== tenant.current) {
      begin('tenant'); // a different tenant answered: discard everything this generation showed and start over
      return false;
    }
    dispatch({ type: 'read', gen: gen.current, seq, tenant: answer.tenant, roles: answer.roles, attempt });
    return true;
  };

  const sessionProblem = (kind: Exclude<SessionResult['kind'], 'ok'>): void => {
    if (kind === 'no-identity') {
      setPhase('signed-out');
      setNote(copy.signIn);
    } else if (kind === 'refused') {
      setPhase('signed-out');
      setNote('The store server did not accept this sign-in. Reconnect, or sign out and sign in again.');
    } else if (kind === 'ended') {
      setPhase('signed-out');
      setNote(copy.sessionEnded);
    } else {
      setPhase('unavailable');
      setNote(kind === 'rate-limited'
        ? 'Too many sign-in attempts. Wait a minute, then try again.'
        : 'The store server could not be reached. Nothing was changed.');
    }
  };

  /**
   * Read the server's levels. A refresh (focus/visibility) keeps the panel ready when it cannot reach the server, and a
   * refusal demotes the panel only when no save is in flight (AM3). One refresh runs at a time, and its outcome (the
   * values, a note, a demotion) applies only while no later read has started — an older answer arriving last is
   * dropped. An initial load or a save's read-back is never dropped that way.
   */
  async function load(mode: 'initial' | 'refresh', reconnect = false): Promise<void> {
    if (uid === null || controller.current === null) return;
    const mine = gen.current;
    const signal = controller.current.signal;
    const refresh = mode === 'refresh';
    let seq = readSeq.current; // until this load's own read starts: no later read may have started either
    const superseded = (): boolean => mine !== gen.current || (refresh && seq !== readSeq.current);
    if (refresh) refreshingRef.current = true;
    try {
      if (!refresh) setPhase('loading');
      const s = await ensure(uid, reconnect);
      if (superseded()) return;
      if (s.kind !== 'ok') {
        if (refresh && (s.kind === 'unavailable' || s.kind === 'rate-limited')) return setNote(REFRESH_FAILED_NOTE);
        if (refresh && savingRef.current) return;
        return sessionProblem(s.kind);
      }
      if (reconnect) announceRenewed(session, self); // the explicit Reconnect re-established the shared session
      seq = ++readSeq.current;
      const answer = await levels.read(signal);
      if (superseded()) return;
      if (answer.kind === 'ok') {
        if (!accept(answer, seq)) return;
        setReconnect(false);
        setNote('');
        setPhase('ready');
      } else if (refresh && answer.kind === 'unavailable') {
        setNote(REFRESH_FAILED_NOTE);
      } else if (refresh && savingRef.current) {
        // a save is in flight: its own answer decides what the row says
      } else if (answer.kind === 'denied') {
        setPhase('denied');
        setNote(copy.denied);
      } else if (answer.kind === 'signed-out') {
        setPhase('signed-out');
        setNote(copy.sessionEnded);
      } else {
        setPhase('unavailable');
        setNote('The store server could not be reached. Nothing was changed.');
      }
    } finally {
      if (refresh && mine === gen.current) refreshingRef.current = false; // a new generation has its own flag
    }
  }

  /**
   * Start a new generation: cancel pending reads and unsent saves and forget every tenant-specific value. A user switch
   * (or sign-out, or mount) also cancels saves already sent and clears every notice; a tenant restart keeps the
   * previous-store notices and adds the store-changed notice.
   */
  function begin(kind: 'user' | 'tenant'): void {
    gen.current += 1;
    controller.current?.abort();
    controller.current = new AbortController();
    if (kind === 'user' || sends.current === null) {
      sends.current?.abort();
      sends.current = new AbortController();
    }
    tenant.current = null;
    savingRef.current = false;
    refreshingRef.current = false;
    confirmingRef.current = false;
    dispatch({ type: 'reset', gen: gen.current, user: kind === 'user' });
    reread.current = 0; // the reset starts the deferral count again (R4-3)
    setSaving(null);
    setReconnect(false);
    promptStepUp(null);
    setPassword('');
    setConfirming(false);
    if (uid === null) {
      setPhase('signed-out');
      setNote(copy.signIn);
      return;
    }
    void load('initial');
  }

  // Another panel on this session client renewed the session: adopt it with no login (a stuck panel), or refresh (a ready one).
  onRenewed.current = (): void => {
    if (uid === null || controller.current === null || savingRef.current || confirmingRef.current || stepUpRef.current || refreshingRef.current) return;
    if (phaseRef.current === 'signed-out' || phaseRef.current === 'unavailable') void load('initial');
    else if (phaseRef.current === 'ready') void load('refresh');
  };
  useEffect(() => {
    const listener = { self, run: () => onRenewed.current() };
    const set = renewalListeners.get(session) ?? new Set();
    set.add(listener);
    renewalListeners.set(session, set);
    return () => { set.delete(listener); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    begin('user');
    const refresh = (): void => {
      if (document.visibilityState === 'hidden' || phaseRef.current !== 'ready') return;
      if (savingRef.current || stepUpRef.current || confirmingRef.current || refreshingRef.current) return;
      void load('refresh');
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      gen.current += 1;
      controller.current?.abort();
      sends.current?.abort();
    };
    // A panel serves one UID and one domain (see ServerCustomerLevels); the clients are fixed for the panel's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  /**
   * A read-back for this attempt: the level and version it shows for the role, why it could not be read, or null
   * (superseded). After an acknowledged save (`acked`) it moves the role only when consistent with the acknowledgement —
   * that level at that version, or any later version; otherwise it applies like a read taken during the attempt: the
   * row stays "last known" and is read again (R4-2).
   */
  async function readBack(
    attempt: Attempt, mine: number, signal: AbortSignal, acked?: { readonly level: RoleLevel; readonly version: number },
  ): Promise<{ level: RoleLevel; version: number } | { failed: 'signed-out' | 'denied' | 'unavailable' } | null> {
    const seq = ++readSeq.current;
    const back = await levels.read(signal);
    if (mine !== gen.current) return null;
    if (back.kind !== 'ok') return { failed: back.kind };
    const entry = back.roles.find((r) => r.roleId === attempt.roleId);
    const consistent = acked === undefined || (entry?.version != null
      && (entry.version > acked.version || (entry.version === acked.version && entry.level === acked.level)));
    if (!accept(back, seq, consistent ? attempt : undefined)) return null; // another tenant answered: the panel has started over
    return entry?.version == null ? { failed: 'unavailable' } : { level: entry.level, version: entry.version };
  }

  async function save(roleId: EditableRoleId): Promise<void> {
    const current = st.roles.find((r) => r.roleId === roleId);
    const draft = st.drafts[roleId];
    const pending = st.held[roleId]; // an unresolved earlier attempt: re-send exactly its key and body (A2.6)
    const reason = checkReason(st.reasons[roleId] ?? '');
    if (uid === null || controller.current === null || sends.current === null || savingRef.current || confirmingRef.current || phase !== 'ready') return;
    if (current === undefined || draft === undefined || draft.baseTenant !== tenant.current) return;
    if (pending === undefined && (st.statuses[roleId]?.tone === 'conflict' || draft.level === current.level || draft.baseVersion !== current.version)) return;
    const change: LevelChange | null = pending?.change ?? ('value' in reason
      ? { roleId, level: draft.level, reason: reason.value, expectedTenant: draft.baseTenant, expectedVersion: draft.baseVersion }
      : null);
    if (change === null) return;
    const mine = gen.current;
    const signal = controller.current.signal;
    const sent = sends.current.signal;
    const attempt: Attempt = { roleId, id: ++attemptSeq.current };
    const label = (l: RoleLevel): string => LEVEL_LABELS[l];
    const finish = (
      tone: Tone, text: string, version: number | null, keep: 'keep' | 'clear' = 'keep',
      more: { readonly hold?: Held | null; readonly unread?: boolean } = {},
    ): void => dispatch({ type: 'finish', gen: mine, attempt, status: { tone, text, version }, draft: keep, ...more });
    const replaced = (): boolean => mine !== gen.current;
    // The tenant context this save was sent from was replaced while it was out (a user switch unmounts this panel
    // instead): its answer is only ever a detached notice.
    const toPrevious = (text: string): void => dispatch({ type: 'previous', gen: gen.current, text });
    savingRef.current = true;
    setSaving(roleId);
    promptStepUp(null);
    dispatch({ type: 'start', gen: mine, attempt });
    try {
      const s = await ensure(uid);
      if (replaced()) return; // never sent: cancelled with its context
      if (s.kind !== 'ok') {
        const ended = s.kind === 'ended' || s.kind === 'refused' || s.kind === 'no-identity';
        if (ended) setReconnect(true);
        // A held attempt stays held: nothing was sent, and its key may already have committed (R2-2).
        if (pending !== undefined) return finish('confirm', ended ? CONFIRM_AGAIN.sessionEnded : CONFIRM_AGAIN.unreachable, current.version);
        if (ended) return finish('signed-out', 'Not saved: your server session ended. Reconnect, then save again.', current.version);
        return finish('failed', 'Not saved: the store server could not be reached. Try again.', current.version);
      }
      const key = pending?.key ?? nextKey();
      const still: Held = { key, change };
      const answer = await levels.put(change, key, s.csrf, sent);
      if (replaced()) return toPrevious(previousStoreText(answer, pending !== undefined));
      // No answer at all: never re-sent here. The attempt is held below; only the owner's next Save re-sends its key and bytes.
      const lost = answer.kind === 'unknown' && !answer.responded;
      // Undecided (a 409 in progress, a 5xx, a body it cannot name, silence): it may have committed, and only the same
      // key can find out. Once the key may already have committed (a lost attempt, a held one), a refusal that does not
      // reach the key's record says nothing about it either. Both stay held (R2-2); a 200 or a write_conflict decides.
      const undecided = answer.kind === 'in-progress' || answer.kind === 'unknown';
      const unsure = pending !== undefined || lost;

      if (answer.kind === 'ok') {
        const back = await readBack(attempt, mine, signal, { level: change.level, version: answer.version });
        if (back === null || replaced()) return toPrevious(PREVIOUS_STORE.acknowledged); // the store changed after this one committed
        if ('level' in back && back.version === answer.version && back.level === change.level) return finish('saved', 'Saved', back.version, 'clear');
        if ('level' in back && back.version > answer.version) {
          return finish('stale', `Your change was acknowledged, then changed elsewhere: the server now has ${label(back.level)}.`, back.version, 'clear');
        }
        // an older version, or this version with another level: the read-back does not show this save, and is not taken
        // as the current level either — the row stays "last known" until a later read (R3-4)
        if ('level' in back) return finish('failed', `Not confirmed: the server shows ${label(back.level)}.`, null, 'clear', { unread: true });
        if (back.failed === 'signed-out') setReconnect(true);
        return finish('failed', 'Not confirmed: the server answered, but the level could not be read back. Refresh before relying on it.', answer.version, 'clear', { unread: true });
      }

      if (answer.kind === 'conflict') {
        // The asserted tenant or version no longer holds: nothing was written. Show what the server has now.
        const back = await readBack(attempt, mine, signal);
        if (back === null || replaced()) return toPrevious(PREVIOUS_STORE.notSaved); // the store changed: that is what refused it
        if ('failed' in back) {
          if (back.failed === 'signed-out') setReconnect(true);
          return finish('conflict', 'Changed elsewhere — your change is not saved, and the current level could not be read back.', null, 'keep', { hold: null, unread: true });
        }
        if (back.level === change.level) { // perhaps this owner's own earlier save: say only what the server has
          return finish('stale', `Not saved by this attempt: the server already has ${label(back.level)}.`, back.version, 'clear');
        }
        return finish('conflict', conflictText(back.level), back.version, 'keep', { hold: null });
      }

      // Undecided, or a refusal after an attempt whose key may have committed: what the server now has is read back and
      // said as such — never "Saved", never "Not saved".
      let shown: number | null = current.version; // the server version a refusal's status describes
      if (undecided || unsure) {
        const back = await readBack(attempt, mine, signal);
        if (back === null || replaced()) return toPrevious(PREVIOUS_STORE.unconfirmed);
        const now = 'level' in back ? back : null;
        shown = now?.version ?? null;
        const unread = now === null;
        if ('failed' in back && back.failed === 'signed-out') setReconnect(true);
        if (undecided) {
          // A read alone never proves this save (A2.6): the draft and the key stay for the confirming replay.
          return finish('confirm', now === null
            ? 'Not confirmed yet — press Save again to check. The level could not be read back.'
            : `Not confirmed yet — press Save again to check. The server has ${label(now.level)}.`, shown, 'keep', { hold: still, unread });
        }
        if (answer.kind === 'signed-out') {
          setReconnect(true);
          return finish('confirm', CONFIRM_AGAIN.sessionEnded, shown, 'keep', { hold: still, unread });
        }
        if (answer.kind === 'step-up-required') {
          promptStepUp({ roleId, method: identity.reauthMethod(uid) });
          return finish('confirm', CONFIRM_AGAIN.stepUp, shown, 'keep', { hold: still, unread });
        }
        return finish('confirm', answer.kind === 'denied' ? CONFIRM_AGAIN.denied : CONFIRM_AGAIN.unmatched, shown, 'keep', { hold: still, unread });
      }
      if (answer.kind === 'signed-out') {
        setReconnect(true);
        return finish('signed-out', 'Not saved: your server session ended. Reconnect, then save again.', shown);
      }
      if (answer.kind === 'step-up-required') {
        promptStepUp({ roleId, method: identity.reauthMethod(uid) });
        return finish('step-up', 'Not saved: sign in again to save this change.', shown);
      }
      if (answer.kind === 'denied') {
        return finish('denied', 'Not saved: the server refused this change. Only the store owner can change these levels.', shown);
      }
      if (answer.kind === 'invalid') {
        return finish('failed', `Not saved: the server refused this change. The reason must be ${REASON_MIN}–${REASON_MAX} characters.`, shown);
      }
      return finish('failed', 'Not saved: the server could not match this attempt. Try again.', shown); // key-reused
    } finally {
      dispatch({ type: 'finish', gen: mine, attempt }); // ends the attempt if no outcome did (a superseded path)
      if (mine === gen.current) {
        savingRef.current = false;
        setSaving(null);
      }
    }
  }

  async function confirmSignIn(): Promise<void> {
    if (uid === null || stepUp === null || confirmingRef.current) return;
    const mine = gen.current;
    const { roleId, method } = stepUp;
    const shown = st.roles.find((r) => r.roleId === roleId)?.version ?? null;
    const held = st.held[roleId] !== undefined; // a held attempt is never "Not saved" (R2-2)
    const failTone: Tone = held ? 'confirm' : 'step-up';
    const secret = method === 'password' ? password : null;
    setPassword('');
    confirmingRef.current = true;
    setConfirming(true);
    try {
      let fresh: string | null;
      try {
        fresh = await identity.reauthenticate(uid, secret);
      } catch {
        fresh = null;
      }
      if (mine !== gen.current) return;
      if (fresh === null) return setStatus(roleId, failTone, `${held ? 'Not confirmed yet' : 'Not saved'}: your sign-in was not confirmed. Try again.`, shown);
      const renewed = await session.reauthenticate(uid, fresh);
      if (mine !== gen.current) return;
      if (renewed.kind !== 'ok') return setStatus(roleId, failTone, `${held ? 'Not confirmed yet' : 'Not saved'}: the store server did not confirm your sign-in. Try again.`, shown);
      promptStepUp(null);
      announceRenewed(session, self);
      setStatus(roleId, held ? 'confirm' : 'idle', `Signed in again. Press "Save to server" to ${held ? 'check' : 'save'} this change.`, shown);
    } finally {
      if (mine === gen.current) {
        confirmingRef.current = false;
        setConfirming(false);
      }
    }
  }

  const ready = phase === 'ready';
  return (
    <section
      data-testid={copy.sectionId}
      aria-labelledby={copy.titleId}
      className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-8 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <h2 id={copy.titleId} tabIndex={-1} className="text-2xl font-black text-primary tracking-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg">{copy.title}</h2>
        <span
          data-testid={id('server-levels-state')}
          data-state={phase}
          className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border bg-slate-50 text-slate-600 border-slate-200"
        >
          {PHASE_LABELS[phase]}
        </span>
      </div>
      <p className="text-slate-500 text-sm font-medium mb-4">{copy.description}</p>
      {st.storeChanged && (
        <p data-testid={id('server-levels-store-changed')} role="alert" className="text-sm font-bold text-amber-800 mb-4">{STORE_CHANGED_NOTICE}</p>
      )}
      {st.previous.length > 0 && (
        <div data-testid={id('server-levels-previous-store')} role="alert" className="text-sm font-bold text-amber-800 mb-4 space-y-1">
          {st.previous.map((text, n) => <p key={n}>{text}</p>)}
        </div>
      )}
      <p role="status" aria-live="polite" className="text-sm font-bold text-slate-600 mb-4">{note}</p>

      {(phase === 'unavailable' || phase === 'signed-out' || reconnect) && uid !== null && (
        <button
          type="button"
          data-testid={id('server-levels-retry')}
          // The button unmounts while the panel loads: focus moves to the panel's heading, never to the page body.
          onClick={() => { focusNext.current = copy.titleId; setReconnect(false); void load('initial', phase === 'signed-out' || reconnect); }}
          disabled={saving !== null}
          className="mb-4 px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50"
        >
          {phase === 'unavailable' ? 'Try again' : 'Reconnect'}
        </button>
      )}

      {ready && (
        <div className="space-y-3">
          {st.roles.map((entry) => {
            if (!entry.editable) {
              return (
                <div key={entry.roleId} data-testid={id(`server-level-row-${entry.roleId}`)} className="flex flex-wrap items-center gap-3 p-4 rounded-2xl border border-slate-100 bg-slate-50/50">
                  <span className="text-sm font-bold text-slate-700 w-40">{roleName(entry.roleId)}</span>
                  <span className="text-xs font-black text-slate-600">Full — fixed</span>
                </div>
              );
            }
            const roleId = entry.roleId as EditableRoleId;
            const draft = st.drafts[roleId];
            const chosen = draft?.level ?? entry.level; // the select shows the choice; the server level is shown apart
            const reason = st.reasons[roleId] ?? '';
            const reasonOk = 'value' in checkReason(reason);
            const options = PERMISSION_HIERARCHY.filter((l) => copy.levels.includes(l) || l === entry.level || l === chosen) as RoleLevel[];
            const status = st.statuses[roleId];
            const busy = saving !== null || confirming;
            const conflict = status?.tone === 'conflict' && draft !== undefined;
            const unread = st.unread[roleId] === true; // no successful read has established this level since (R2-5)
            const known = conflict && !unread && status.version === entry.version; // the server level this conflict was read at
            const locked = busy || conflict; // a conflict needs an explicit Discard or Reapply first
            const changed = draft !== undefined && (draft.level !== entry.level || st.held[roleId] !== undefined);
            const canSave = !locked && changed && reasonOk;
            const selectId = id(`server-level-select-${roleId}`);
            const reasonId = id(`server-level-reason-${roleId}`);
            const hintId = id(`server-level-hint-${roleId}`);
            const reasonRule = `a reason of ${REASON_MIN}–${REASON_MAX} characters`;
            const saveId = id(`server-level-save-${roleId}`);
            const hint = busy ? '' : conflict ? (known ? 'To save, discard your choice or reapply it to the current server level.'
              : 'The current server level could not be read. To continue, discard your choice.')
              : !changed && !reasonOk ? `To save, choose a new level and enter ${reasonRule}.`
              : !changed ? 'To save, choose a new level.' : !reasonOk ? `To save, enter ${reasonRule}.` : '';
            return (
              <div key={roleId} data-testid={id(`server-level-row-${roleId}`)} className="p-4 rounded-2xl border border-slate-100 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-bold text-slate-700 w-40">{roleName(roleId)}</span>
                  <span className="text-xs font-bold text-slate-600">{unread ? 'Last known level: ' : 'Server level: '}<span className="font-black">{LEVEL_LABELS[entry.level]}</span></span>
                  <span className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border bg-slate-50 text-slate-500 border-slate-200">
                    {entry.source === 'stored' ? 'Custom' : 'Default'}
                  </span>
                  {draft !== undefined && (
                    <span data-testid={id(`server-level-unsaved-${roleId}`)} className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border bg-amber-50 text-amber-800 border-amber-200">
                      Unsaved: {LEVEL_LABELS[draft.level]}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={selectId} className="text-[10px] font-black text-slate-400 uppercase tracking-widest">New level</label>
                    <select
                      id={selectId}
                      data-testid={selectId}
                      value={chosen}
                      disabled={locked}
                      onChange={(e) => {
                        const value = e.target.value as RoleLevel;
                        if (!options.includes(value)) return;
                        dispatch({ type: 'draft', gen: gen.current, roleId, level: value });
                      }}
                      className="text-xs font-bold px-3 py-2 rounded-lg border border-slate-200 bg-white disabled:opacity-50"
                    >
                      {options.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1 flex-1 min-w-[14rem]">
                    <label htmlFor={reasonId} className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reason (required, {REASON_MIN}–{REASON_MAX} characters)</label>
                    <input
                      id={reasonId}
                      data-testid={reasonId}
                      type="text"
                      value={reason}
                      disabled={locked}
                      onChange={(e) => dispatch({ type: 'reason', gen: gen.current, roleId, text: e.target.value })}
                      className="text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white disabled:opacity-50"
                    />
                  </div>
                  <button
                    type="button"
                    id={saveId}
                    data-testid={saveId}
                    disabled={!canSave}
                    aria-describedby={hintId}
                    onClick={() => { void save(roleId); }}
                    className="px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Save to server
                  </button>
                </div>
                <p id={hintId} data-testid={hintId} className="text-[11px] font-medium text-slate-500 min-h-[1rem]">{hint}</p>
                <p
                  data-testid={id(`server-level-status-${roleId}`)}
                  data-status={status?.tone ?? 'idle'}
                  aria-live="polite"
                  className="text-xs font-bold text-slate-600 min-h-[1rem]"
                >
                  {status?.text ?? ''}
                </p>
                {conflict && (
                  <div
                    role="group"
                    aria-label={`Resolve the conflict for ${roleName(roleId)}`}
                    data-testid={id(`server-level-conflict-${roleId}`)}
                    className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100"
                  >
                    <p className="w-full text-xs font-bold text-amber-900">
                      {known ? <>The server now has <span className="font-black">{LEVEL_LABELS[entry.level]}</span>.</> : 'The current server level could not be read.'} Your unsaved choice: <span className="font-black">{LEVEL_LABELS[draft.level]}</span>.
                    </p>
                    <button
                      type="button"
                      data-testid={id(`server-level-discard-${roleId}`)}
                      aria-label={`Discard my choice for ${roleName(roleId)}`}
                      disabled={busy}
                      onClick={() => {
                        focusNext.current = selectId;
                        dispatch({ type: 'discard', gen: gen.current, roleId });
                      }}
                      className="px-4 py-2 bg-white text-amber-900 border border-amber-300 text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50"
                    >
                      Discard my choice
                    </button>
                    <button
                      type="button"
                      data-testid={id(`server-level-reapply-${roleId}`)}
                      aria-label={`Reapply to the current level for ${roleName(roleId)}`}
                      disabled={busy || !known}
                      onClick={() => {
                        // Save when it can go, else what it still needs (a reason); a choice equal to the server's is dropped
                        focusNext.current = draft.level === entry.level ? selectId : reasonOk ? saveId : reasonId;
                        dispatch({ type: 'reapply', gen: gen.current, roleId });
                      }}
                      className="px-4 py-2 bg-amber-600 text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50"
                    >
                      Reapply to the current level
                    </button>
                  </div>
                )}
                {stepUp?.roleId === roleId && (
                  <div
                    role="group"
                    aria-labelledby={id(`server-level-reauth-title-${roleId}`)}
                    data-testid={id('server-level-reauth-group')}
                    className="flex flex-wrap items-end gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100"
                  >
                    <p id={id(`server-level-reauth-title-${roleId}`)} className="w-full text-xs font-black text-amber-900">Confirm your sign-in to save this change</p>
                    {stepUp.method === 'password' && (
                      <div className="flex flex-col gap-1">
                        <label htmlFor={id(`server-level-reauth-password-${roleId}`)} className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Your password</label>
                        <input
                          ref={passwordRef}
                          id={id(`server-level-reauth-password-${roleId}`)}
                          data-testid={id('server-level-reauth-password')}
                          type="password"
                          autoComplete="current-password"
                          value={password}
                          disabled={confirming}
                          onChange={(e) => setPassword(e.target.value)}
                          className="text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white"
                        />
                      </div>
                    )}
                    {stepUp.method === null ? (
                      <p className="text-xs font-bold text-amber-800">Sign out and sign in again, then save this change.</p>
                    ) : (
                      <>
                        <button
                          ref={confirmRef}
                          type="button"
                          data-testid={id('server-level-reauth-confirm')}
                          disabled={confirming || (stepUp.method === 'password' && password.length === 0)}
                          aria-describedby={id('server-level-reauth-hint')}
                          onClick={() => { void confirmSignIn(); }}
                          className="px-4 py-2 bg-amber-600 text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50"
                        >
                          {stepUp.method === 'password' ? 'Confirm sign-in' : 'Sign in with Google again'}
                        </button>
                        <p id={id('server-level-reauth-hint')} data-testid={id('server-level-reauth-hint')} className="w-full text-[11px] font-medium text-amber-800 min-h-[1rem]">
                          {stepUp.method === 'google'
                            ? 'A Google sign-in window opens.'
                            : password.length === 0 ? 'Enter your password to confirm your sign-in.' : ''}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

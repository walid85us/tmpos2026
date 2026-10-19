// M7B-INVOICES-VOID-P2 — the shop's held void attempt (docs/phase-4/13 §5 G and §12.7, ADR-51): one void of one issued
// invoice, held in memory BEFORE its POST leaves and reconciled by its key whatever dialog or section is (or is not)
// mounted when an answer comes back. The issue attempt's model (ServerInvoiceDrafts.tsx HeldIssue), in its own store.
//
//   - What is held is only what Check again and Check invoice need: the key, the exact body bytes sent, the store and the
//     invoice it was sent to (and the store's label and the invoice's number, for the card), the session token it went
//     with and two readings of the FIRST send's time — never the invoice's customer, seller, lines or amounts.
//   - One live attempt per user (`sending`, `unresolved`, `checking`): a second is refused while one is live; a settled
//     one (`voided`, `refused`) is replaced. Its own store, apart from the issue's: an issue key and a void key never meet.
//   - What a Check invoice read saw is `seen` (and `seenReason`, the reason the invoice records now): the invoice's state
//     now, never this attempt's outcome — another request, with another reason, may have voided it. It changes no state.
//     Only a sealed answer for the same key (or Dismiss, which only stops tracking it) ends an attempt; a settled one is
//     final. A Check again's step-up or 422 withdraws Check again (`retryable`) but ends nothing: the outcome is unknown.
//   - What was sent never changes after `put`: its bytes can only be cleared (never swapped under the key), its token only
//     taken by a detach, and its key, store, invoice and first-send times never move — this store refuses any other change.
//   - A sign-out, a user change or a session-token change DETACHES it (token and body gone, state kept): it can never be
//     sent again, and an answer that comes back for it afterwards changes nothing but that (settleVoid).
//   - 23 hours (CHECK_CUTOFF_MS) after the FIRST send, by the larger of the monotonic and the wall-clock time elapsed (a
//     suspended device or a moved clock never extends it), the body is scrubbed by this store's own timer, armed at `put`
//     — even with no section mounted. The timer never sends; it fires late when the browser throttles or suspends timers,
//     so the section judges `voidExpired` again before any send and scrubs on focus and visibility too. A time that is not
//     a finite number counts as past the cutoff.
//   - Memory only: no browser storage, URL, DOM or log; a page load ends it, and a hot reload disposes the old store.
//
// Import discipline (ServerInvoiceDrafts imports ServerIssuedInvoices, which holds this store): from ServerInvoiceDrafts
// only its two function declarations and its types, and no top-level read of any constant from it or ServerCustomerDirectory.
import { bindDraftHoldsToSessionEnd, holdStoreOf } from './ServerInvoiceDrafts';
import type { HoldStore } from './ServerInvoiceDrafts';
import { CHECK_CUTOFF_MS } from './ServerCustomerDirectory';
import { sessionEndsSoFar } from './tenantSessionClient';
import type { InvoiceVoidReasonCode, VoidResult } from './invoiceIssuingClient';

/** What decisively ended an attempt (state refused): a sealed or rolled-back answer for its key, or one decided before it. */
export type VoidRefusal = Exclude<VoidResult['kind'], 'voided' | 'unknown' | 'in-progress' | 'not-sent'>;

/** One void attempt, held BEFORE it leaves. Detached (a user change, a sign-out, a token change) is `csrf` null. */
export interface HeldVoid {
  readonly key: string;
  /** The exact body string sent, never rebuilt; '' once it can never be sent again (detached, past the cutoff, settled). */
  readonly body: string;
  readonly storeId: string;
  /** The store's label when it was sent: shown only while the attempt is still this session's. */
  readonly storeLabel: string;
  readonly invoiceId: string;
  /** The invoice's number, as the card names it. */
  readonly number: number;
  /** The session token it was sent with; null once detached. */
  readonly csrf: string | null;
  /** A monotonic and a wall-clock reading taken at the FIRST send: Check again never moves them. */
  readonly sentAt: number;
  readonly sentWall: number;
  readonly state: 'sending' | 'unresolved' | 'checking' | 'voided' | 'refused';
  /** What the last answer that left it unresolved met ('' for none): a Check again's never speaks for the first send. */
  readonly note: string;
  /** The refusal that ended it (state refused). */
  readonly refusal: VoidRefusal | null;
  /** What the last Check invoice read showed now (null: not read), and the reason the invoice records then — never this attempt's. */
  readonly seen: 'issued' | 'voided' | null;
  readonly seenReason: InvoiceVoidReasonCode | null;
  /**
   * Whether Check again may still send this attempt's bytes here: true at `put`, false for good once a check met a
   * step-up (a new session cannot send it) or a key the server says another request used — Check invoice and Dismiss stay.
   */
  readonly retryable: boolean;
}
export interface VoidHoldStore extends HoldStore<HeldVoid> {
  /** Clear every scrub timer and detach every attempt (token and bytes gone, state kept): a hot reload's end of this store. */
  dispose(): void;
}

const LIVE_VOID: ReadonlySet<HeldVoid['state']> = new Set(['sending', 'unresolved', 'checking']);
export const isLiveVoid = (held: HeldVoid | undefined): held is HeldVoid => held !== undefined && LIVE_VOID.has(held.state);

/** What may change after `put` (the body only to '', `retryable` only to false); everything else is what was sent. */
const MUTABLE: ReadonlySet<string> = new Set(['state', 'note', 'refusal', 'seen', 'seenReason', 'body', 'retryable']);

const elapsedOf = (held: Pick<HeldVoid, 'sentAt' | 'sentWall'>, mono: number, wall: number): number => Math.max(mono - held.sentAt, wall - held.sentWall);
/**
 * Whether 23 hours have passed since the FIRST send, by the larger of the two elapsed times (never extended); a time that
 * is not a finite number (a broken stamp or clock) counts as passed — closed, never open.
 */
export const voidExpired = (held: Pick<HeldVoid, 'sentAt' | 'sentWall'>, mono: number, wall: number): boolean => {
  const elapsed = elapsedOf(held, mono, wall);
  return !Number.isFinite(elapsed) || elapsed >= CHECK_CUTOFF_MS;
};

/**
 * A void hold store (the shared hold store, with a scrub timer per attempt): `now` monotonic and `wallNow` wall-clock
 * milliseconds, injectable as the sections' own. The timer is armed for the cutoff while the attempt has bytes to send,
 * cleared once it has none (settled, removed, detached, scrubbed); it only ever clears the body.
 */
export function createVoidHoldStore(clocks: { readonly now?: () => number; readonly wallNow?: () => number } = {}): VoidHoldStore {
  const now = clocks.now ?? (() => performance.now());
  const wallNow = clocks.wallNow ?? (() => Date.now());
  const inner = holdStoreOf<HeldVoid>(isLiveVoid);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const sync = (uid: string): void => {
    clearTimeout(timers.get(uid));
    timers.delete(uid);
    const held = inner.get(uid);
    if (held === undefined || held.body === '') return;
    const mono = now();
    const wall = wallNow();
    if (voidExpired(held, mono, wall)) return void inner.change(uid, held.key, { body: '' });
    // Early (the wall clock moved back) or on time, the firing judges again; a late one scrubs then. Never longer than the
    // cutoff itself (a stamp ahead of the clocks), so a delay never overflows into an immediate firing.
    timers.set(uid, setTimeout(() => { timers.delete(uid); sync(uid); }, Math.min(CHECK_CUTOFF_MS, CHECK_CUTOFF_MS - elapsedOf(held, mono, wall))));
  };
  return Object.freeze({
    get: inner.get,
    put(uid: string, attempt: HeldVoid): boolean {
      if (!inner.put(uid, attempt)) return false;
      sync(uid);
      return true;
    },
    change(uid: string, key: string, next: Partial<Omit<HeldVoid, 'key'>>): boolean {
      // What was sent is the put's for good: its bytes may only go (never be swapped under the key, never come back), its
      // token only through detach, its key, target and first-send times never move (the cutoff is never extended), and
      // Check again once withdrawn never comes back. No field is ever set to undefined, and no other field exists.
      const allowed = Object.entries(next).every(([field, value]) => MUTABLE.has(field) && value !== undefined
        && (field !== 'body' || value === '') && (field !== 'retryable' || value === false));
      if (!allowed) return false;
      if (!inner.change(uid, key, next)) return false;
      sync(uid);
      return true;
    },
    remove(uid: string, key: string): boolean {
      if (!inner.remove(uid, key)) return false;
      sync(uid);
      return true;
    },
    detach(uid: string): void {
      inner.detach(uid);
      sync(uid);
    },
    detachOthers(uid: string | null): void {
      inner.detachOthers(uid);
      for (const other of [...timers.keys()]) sync(other);
    },
    subscribe: inner.subscribe,
    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      inner.detachOthers(null);
    },
  });
}

/** The shop's one void hold store, detached at every sign-out as the issue's. */
export const voidHolds: VoidHoldStore = createVoidHoldStore();
const unbindVoidHolds = bindDraftHoldsToSessionEnd(voidHolds);
// A hot reload replaces this module: its listener goes with its store, and the old store keeps no timer, token or bytes.
import.meta.hot?.dispose(() => { unbindVoidHolds(); voidHolds.dispose(); });

/** The notes an answer leaves on an unresolved attempt: what that request met — never what the first send did. */
export const VOID_NOTE_TEXT = Object.freeze({
  inProgress: 'The server is still working on it. Check again in a moment.',
  answered: 'The server answered, but not with a result.',
  noAnswer: 'No answer from the server.',
  /** A Check again's 403 step_up_required (design R13): no sign-in is offered for it, since a new session cannot send it. */
  stepUp: "Your sign-in is too old to check this request again here. Signing in again starts a new session that cannot send it. Use Check invoice to see the invoice's current state.",
  denied: 'The server refused this check.',
  signedOut: 'Your server session ended, so this could not be checked.',
  rateLimited: (seconds: number) => `Too many requests. Wait ${seconds} second${seconds === 1 ? '' : 's'}.`,
  notAccepted: 'The server did not accept this check.',
  /** A Check again this client refused to send (its bytes could not go): the server heard nothing. */
  notSent: 'This check was not sent.',
  /** A Check again's 422 (unsealed): an integrity failure, never a reason to rotate the key; Check again is withdrawn. */
  keyReused: "The server reports this request key was already used for a different request. That is unexpected: the outcome of the original request is still unknown. Use Check invoice to see the invoice's current state.",
});

function voidNoteOf(answer: VoidResult): string {
  switch (answer.kind) {
    case 'in-progress': return VOID_NOTE_TEXT.inProgress;
    case 'unknown': return answer.responded ? VOID_NOTE_TEXT.answered : VOID_NOTE_TEXT.noAnswer;
    case 'step-up': return VOID_NOTE_TEXT.stepUp;
    case 'denied': return VOID_NOTE_TEXT.denied;
    case 'signed-out': return VOID_NOTE_TEXT.signedOut;
    case 'rate-limited': return VOID_NOTE_TEXT.rateLimited(answer.retryAfterSeconds);
    case 'not-sent': return VOID_NOTE_TEXT.notSent;
    case 'key-reused': return VOID_NOTE_TEXT.keyReused;
    default: return VOID_NOTE_TEXT.notAccepted;
  }
}

/** A first send's refusals decided BEFORE the key was acquired: that request ran nothing. */
const BEFORE_KEY: ReadonlySet<VoidRefusal> = new Set(['signed-out', 'rate-limited', 'step-up', 'denied']);
/** What decides a first send: every other answer but unknown and in-progress. */
const FIRST_VOID_DECIDES: ReadonlySet<VoidRefusal> = new Set(['already-void', 'version-conflict', 'tenant-conflict', 'not-found', 'key-reused', 'invalid']);
/** What decides a Check again (a key that may already have committed): only the key's sealed answers (D-VOID-5). */
const CHECK_VOID_DECIDES: ReadonlySet<VoidRefusal> = new Set(['already-void', 'version-conflict']);
/** A Check again's answers after which this attempt can no longer be checked again here (it stays unresolved). */
const CHECK_WITHDRAWN: ReadonlySet<VoidResult['kind']> = new Set(['step-up', 'key-reused']);
const refusalIn = (set: ReadonlySet<VoidRefusal>, kind: VoidResult['kind']): kind is VoidRefusal => (set as ReadonlySet<string>).has(kind);

/**
 * One void answer, settled BY KEY in the hold store. `first`: the attempt's first send (else a Check again). `sent`: the
 * session token that request went with and `sessionEndsSoFar()` read before it — when either no longer stands (another
 * token, a detach, a sign-out begun), the answer proves nothing here: the attempt is detached and nothing else changes.
 * `open`: whether the confirmation that pressed this key is still open — a first send's refusal decided before the key
 * then removes the attempt (that confirmation says it); with none open it settles refused, so the card still says it.
 * An attempt already settled (voided, refused) is final: a late or duplicate answer changes nothing.
 * A 200 voids it; a first send this client never sent (`not-sent`: the section validates before `put`, so only a defect
 * gets here) is removed, there being nothing to track; a first send's other refusals decide it (a 422 there is a fresh
 * key's: nothing ran); a Check again is decided only by the key's sealed answers (CHECK_VOID_DECIDES, D-VOID-5), and
 * every other answer — a step-up, a 422, a 403, a 401 or a 429 included — leaves it unresolved with a note about that
 * check alone, its key and bytes kept; a step-up or a 422 also withdraws Check again for good (`retryable` false).
 */
export function settleVoid(holds: VoidHoldStore, uid: string, key: string, answer: VoidResult, first: boolean, sent: { readonly csrf: string; readonly since: number }, open = false): void {
  const held = holds.get(uid);
  if (held === undefined || held.key !== key) return; // another attempt now (or none): a stale continuation changes nothing
  if (held.csrf !== sent.csrf || sent.since !== sessionEndsSoFar()) return holds.detach(uid);
  if (!isLiveVoid(held)) return; // settled is final: a late or duplicate answer never reopens it (only Dismiss ends it)
  const { kind } = answer;
  if (kind === 'voided') return void holds.change(uid, key, { state: 'voided', body: '', note: '', refusal: null });
  if (first && kind === 'not-sent') return void holds.remove(uid, key);
  if (first && refusalIn(BEFORE_KEY, kind)) {
    if (open) return void holds.remove(uid, key);
    return void holds.change(uid, key, { state: 'refused', refusal: kind, body: '', note: '' });
  }
  if (refusalIn(first ? FIRST_VOID_DECIDES : CHECK_VOID_DECIDES, kind)) return void holds.change(uid, key, { state: 'refused', refusal: kind, body: '', note: '' });
  holds.change(uid, key, !first && CHECK_WITHDRAWN.has(kind)
    ? { state: 'unresolved', note: voidNoteOf(answer), retryable: false }
    : { state: 'unresolved', note: voidNoteOf(answer) });
}

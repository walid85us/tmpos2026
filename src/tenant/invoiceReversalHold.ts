// M7B-PAYMENTS-P2C — the shop's held payment reversal: one reversal of one recorded payment of one issued invoice, held in
// memory BEFORE its POST leaves and reconciled by its key whatever dialog or section is (or is not) mounted when an answer
// comes back. The void hold's model (invoiceVoidHold.ts), in its own store, plus the payment it targets and its reason.
//
//   - What is held is only what Retry reversal and Check payment need: the key, the exact body bytes sent, the store, the
//     invoice and the payment it was sent to (the store's label, the invoice's number and the payment's amount, for the
//     card), the reason chosen, the session token it went with and two readings of the FIRST send's time.
//   - One live attempt per user (`sending`, `unresolved`, `checking`): a second is refused while one is live; a settled
//     one (`reversed`, `refused`) is replaced. Its own store: a void key, a payment key and a reversal key never meet.
//   - What a Check payment read saw is `seen`: the payment's state now, never this attempt's outcome. Only `found
//     reversed` settles it (as reversed, `attributed` false: another request may have reversed it); `not reversed as of
//     this read` and `couldn't confirm` settle nothing.
//   - What was sent never changes after `put`: its bytes can only be cleared, its token only taken by a detach, and its
//     key, store, invoice, payment, reason and first-send times never move — this store refuses any other change.
//   - A sign-out, a user change, a session-token change or a switch to another store DETACHES it (token and body gone,
//     state kept): it can never be sent again, and an answer that comes back for it afterwards changes nothing.
//   - 23 hours (CHECK_CUTOFF_MS) after the FIRST send the body is scrubbed by this store's own timer (never sends).
//   - Memory only: no browser storage, URL, DOM or log; a page load ends it, and a hot reload disposes the old store.
//
// Import discipline as invoiceVoidHold.ts: from ServerInvoiceDrafts only its two function declarations and its types.
import { bindDraftHoldsToSessionEnd, holdStoreOf } from './ServerInvoiceDrafts';
import type { HoldStore } from './ServerInvoiceDrafts';
import { CHECK_CUTOFF_MS } from './ServerCustomerDirectory';
import { sessionEndsSoFar } from './tenantSessionClient';
import type { InvoicePaymentReversalReason, ReverseResult } from './invoiceIssuingClient';

/** What decisively ended an attempt (state refused). */
export type ReversalRefusal = Exclude<ReverseResult['kind'], 'reversed' | 'unknown' | 'in-progress' | 'not-sent'>;

/** One reversal attempt, held BEFORE it leaves. Detached is `csrf` null. */
export interface HeldReversal {
  readonly key: string;
  /** The exact body string sent, never rebuilt; '' once it can never be sent again. */
  readonly body: string;
  readonly storeId: string;
  readonly storeLabel: string;
  readonly invoiceId: string;
  readonly number: number;
  readonly paymentId: string;
  readonly amountCents: number;
  readonly reasonCode: InvoicePaymentReversalReason;
  readonly csrf: string | null;
  readonly sentAt: number;
  readonly sentWall: number;
  readonly state: 'sending' | 'unresolved' | 'checking' | 'reversed' | 'refused';
  /** What the last answer that left it unresolved met ('' for none). */
  readonly note: string;
  readonly refusal: ReversalRefusal | null;
  /** State reversed: true when this key's own answer said so; false when only a Check payment read saw the reversal. */
  readonly attributed: boolean;
  /** What the last Check payment read showed (null: not read). */
  readonly seen: 'reversed' | 'not-reversed' | 'unconfirmed' | null;
  /** Whether Retry reversal may still send this attempt's bytes here (false for good once withdrawn). */
  readonly retryable: boolean;
}
export interface ReversalHoldStore extends HoldStore<HeldReversal> {
  dispose(): void;
}

const LIVE: ReadonlySet<HeldReversal['state']> = new Set(['sending', 'unresolved', 'checking']);
export const isLiveReversal = (held: HeldReversal | undefined): held is HeldReversal => held !== undefined && LIVE.has(held.state);

const MUTABLE: ReadonlySet<string> = new Set(['state', 'note', 'refusal', 'attributed', 'seen', 'body', 'retryable']);

const elapsedOf = (held: Pick<HeldReversal, 'sentAt' | 'sentWall'>, mono: number, wall: number): number => Math.max(mono - held.sentAt, wall - held.sentWall);
export const reversalExpired = (held: Pick<HeldReversal, 'sentAt' | 'sentWall'>, mono: number, wall: number): boolean => {
  const elapsed = elapsedOf(held, mono, wall);
  return !Number.isFinite(elapsed) || elapsed >= CHECK_CUTOFF_MS;
};

export function createReversalHoldStore(clocks: { readonly now?: () => number; readonly wallNow?: () => number } = {}): ReversalHoldStore {
  const now = clocks.now ?? (() => performance.now());
  const wallNow = clocks.wallNow ?? (() => Date.now());
  const inner = holdStoreOf<HeldReversal>(isLiveReversal);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const known = new Set<string>();
  // A detached attempt can never be out here again: one left `sending`/`checking` by a detach (whoever detaches, section
  // mounted or not) is `unresolved`, so its card offers Check payment and Dismiss (review F1).
  const settleDetached = (uid: string): void => {
    const held = inner.get(uid);
    if (held !== undefined && held.csrf === null && (held.state === 'sending' || held.state === 'checking')) inner.change(uid, held.key, { state: 'unresolved', note: '' });
  };
  const sync = (uid: string): void => {
    clearTimeout(timers.get(uid));
    timers.delete(uid);
    const held = inner.get(uid);
    if (held === undefined || held.body === '') return;
    const mono = now();
    const wall = wallNow();
    if (reversalExpired(held, mono, wall)) return void inner.change(uid, held.key, { body: '' });
    timers.set(uid, setTimeout(() => { timers.delete(uid); sync(uid); }, Math.min(CHECK_CUTOFF_MS, CHECK_CUTOFF_MS - elapsedOf(held, mono, wall))));
  };
  return Object.freeze({
    get: inner.get,
    put(uid: string, attempt: HeldReversal): boolean {
      if (!inner.put(uid, attempt)) return false;
      known.add(uid);
      sync(uid);
      return true;
    },
    change(uid: string, key: string, next: Partial<Omit<HeldReversal, 'key'>>): boolean {
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
      settleDetached(uid);
      sync(uid);
    },
    detachOthers(uid: string | null): void {
      inner.detachOthers(uid);
      for (const other of [...known]) {
        if (other !== uid) settleDetached(other);
        sync(other);
      }
    },
    subscribe: inner.subscribe,
    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      inner.detachOthers(null);
    },
  });
}

/** The shop's one reversal hold store, detached at every sign-out as the void's. */
export const reversalHolds: ReversalHoldStore = createReversalHoldStore();
const unbindReversalHolds = bindDraftHoldsToSessionEnd(reversalHolds);
import.meta.hot?.dispose(() => { unbindReversalHolds(); reversalHolds.dispose(); });

export const REVERSAL_NOTE_TEXT = Object.freeze({
  inProgress: 'The server is still working on it. Retry in a moment.',
  answered: 'The server answered, but not with a result.',
  noAnswer: 'No answer from the server.',
  keyReused: 'The server reports this request key was already used for a different request. The outcome of the original request is still unknown. Use Check payment.',
  /** A resend's 403 step_up_required: Retry reversal is withdrawn — a new sign-in is a new session that cannot send it. */
  stepUp: "Your sign-in is too old to retry this reversal here. Signing in again starts a new session that can't send it. Use Check payment.",
  /** A resend answered that the session ended: Retry reversal is withdrawn. */
  signedOut: "Your session ended, so this reversal can't be retried here. Use Check payment.",
  /** Any refusal of a RESEND: it never speaks for the first request. */
  retryRefused: "A refusal while retrying doesn't tell us what happened to the first request.",
});

function reversalNoteOf(answer: ReverseResult, first: boolean): string {
  if (answer.kind === 'in-progress') return REVERSAL_NOTE_TEXT.inProgress;
  if (answer.kind === 'unknown') return answer.responded ? REVERSAL_NOTE_TEXT.answered : REVERSAL_NOTE_TEXT.noAnswer;
  // The answers that withdraw Retry reversal say so and name the read-only way on (fix3 req 4).
  if (answer.kind === 'key-reused') return REVERSAL_NOTE_TEXT.keyReused;
  if (answer.kind === 'step-up') return REVERSAL_NOTE_TEXT.stepUp;
  if (answer.kind === 'signed-out') return REVERSAL_NOTE_TEXT.signedOut;
  return REVERSAL_NOTE_TEXT.retryRefused;
}

/** A first send's answers that ran nothing (decided before the key): the attempt is dropped (or refused with no dialog). */
const FIRST_NOT_RUN: ReadonlySet<string> = new Set(['step-up', 'denied', 'signed-out', 'not-found', 'tenant-conflict', 'invalid', 'rate-limited']);
/** A first send's sealed refusals: settled refused (not unresolved). */
const FIRST_DECIDES: ReadonlySet<string> = new Set(['invalid-state', 'write-conflict']);
/** A resend's answers after which Retry reversal is withdrawn for good here (read-only recovery stays). */
const RETRY_WITHDRAWN: ReadonlySet<string> = new Set(['step-up', 'signed-out', 'key-reused']);

/**
 * One reversal answer, settled BY KEY. `first`: the attempt's first send (else a Retry reversal). `sent`: the token and
 * `sessionEndsSoFar()` that request went with — when either no longer stands the attempt is detached and nothing else
 * changes. `open`: whether the confirmation that pressed this key is still open (a first send's not-run answer then
 * removes the attempt; with none open it settles refused so the card still says it). Settled is final.
 * First send: 200 reversed; invalid-state / write-conflict refused; key-reused, in-progress, unknown unresolved (key-reused
 * not retryable). Resend: only `reversed` settles; everything else leaves it unresolved (an invalid-state there needs a
 * Check payment read to say reversed), and step-up / signed-out / key-reused withdraw Retry reversal.
 */
export function settleReversal(holds: ReversalHoldStore, uid: string, key: string, answer: ReverseResult, first: boolean, sent: { readonly csrf: string; readonly since: number }, open = false): void {
  const held = holds.get(uid);
  if (held === undefined || held.key !== key) return;
  if (held.csrf !== sent.csrf || sent.since !== sessionEndsSoFar()) return holds.detach(uid);
  if (!isLiveReversal(held)) return;
  const { kind } = answer;
  if (kind === 'reversed') return void holds.change(uid, key, { state: 'reversed', attributed: true, body: '', note: '', refusal: null });
  if (first && kind === 'not-sent') return void holds.remove(uid, key);
  if (first && FIRST_NOT_RUN.has(kind)) {
    if (open) return void holds.remove(uid, key);
    return void holds.change(uid, key, { state: 'refused', refusal: kind as ReversalRefusal, body: '', note: '' });
  }
  if (first && FIRST_DECIDES.has(kind)) return void holds.change(uid, key, { state: 'refused', refusal: kind as ReversalRefusal, body: '', note: '' });
  const withdraw = (first && kind === 'key-reused') || (!first && RETRY_WITHDRAWN.has(kind));
  holds.change(uid, key, withdraw
    ? { state: 'unresolved', note: reversalNoteOf(answer, first), retryable: false }
    : { state: 'unresolved', note: reversalNoteOf(answer, first) });
}

/**
 * What a Check payment read (R7) decides: only `found reversed` settles (not attributed); the rest record what was seen.
 * `attachedAtRead`: whether the attempt was attached when the read began — one detached since is a late answer (R8): nothing.
 */
export function seeReversal(holds: ReversalHoldStore, uid: string, key: string, seen: 'reversed' | 'not-reversed' | 'unconfirmed', attachedAtRead: boolean): void {
  const held = holds.get(uid);
  if (held === undefined || held.key !== key || !isLiveReversal(held) || (attachedAtRead && held.csrf === null)) return;
  if (seen === 'reversed') return void holds.change(uid, key, { state: 'reversed', attributed: false, body: '', note: '', seen, refusal: null });
  holds.change(uid, key, held.state === 'checking' ? { state: 'unresolved', seen } : { seen });
}

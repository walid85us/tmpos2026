// M7B-PAYMENTS-P2B — the shop's held payment attempt (docs/phase-4/15 §12, D-PAY-7 A): one recording of one issued
// invoice — register, proof, record, then a deliberate settlement — held in memory BEFORE each request leaves and
// reconciled by its attempt id whatever dialog is (or is not) mounted. The void hold's model (invoiceVoidHold.ts).
//
//   - What is held is only what Check again and the attempts lookup need: the attempt id (the hold's key), the stage out
//     now with its Idempotency-Key and its exact bytes (the proof stage's "bytes" are the registration id its GET names),
//     the store, its tenant, the invoice and its number, the session token it went with, the stage's first-send times, the
//     registration id, the proof (memory only: never rendered, logged, stored or put into any text) and the amount and
//     method typed — never the invoice's customer, seller or lines.
//   - One attempt per user. A live one (not `done`, still attached) is never replaced; a detached or done one is.
//   - The token is taken only by a detach (a sign-out, a user change, a token change, a store switch): its bytes and proof
//     go with it, so it can never be sent again; the lookup and a deliberate settlement are then the only way on.
//   - 23 hours (CHECK_CUTOFF_MS) after a stage's FIRST send, by the larger of the monotonic and the wall-clock time
//     elapsed, its bytes are scrubbed by this store's own timer (never a send); the section judges it again before any send.
//   - Memory only: no browser storage, URL, DOM or log; a page load ends it, and a hot reload disposes the old store.
//
// Import discipline as invoiceVoidHold.ts: from ServerInvoiceDrafts only its two function declarations and its types.
import { bindDraftHoldsToSessionEnd, holdStoreOf } from './ServerInvoiceDrafts';
import type { HoldStore } from './ServerInvoiceDrafts';
import { CHECK_CUTOFF_MS } from './ServerCustomerDirectory';
import type { InvoicePaymentMethod, ProofResult, RecordResult, RegisterResult, SettleResult } from './invoiceIssuingClient';

export type PaymentStage = 'register' | 'proof' | 'record' | 'settle';
/**
 * `sending` (a stage out, first send or the chain's next), `checking` (a Check again out), `unresolved` (undecided: Check
 * again or the lookup), `recorded` (a payment committed; Confirm waits for a press), `lookup` (never sent again: only the
 * lookup and a settlement decide it), `done` (decided: confirmed, withdrawn, or nothing recorded).
 */
export type PaymentState = 'sending' | 'checking' | 'unresolved' | 'recorded' | 'lookup' | 'done';
/** What the attempt says now (the section words it): '' for nothing beyond its state. */
export type PaymentSay =
  | '' | 'uncertain' | 'inProgress' | 'rateLimited' | 'detached' | 'record404' | 'writeConflict' | 'amountExceeds' | 'invalidState'
  | 'denied' | 'signedOut' | 'notAccepted' | 'confirmed' | 'withdrawn';

export interface HeldPayment {
  /** The attempt id (a v4 uuid minted at the press): the hold's key for its whole life. */
  readonly key: string;
  readonly storeId: string;
  /** The store's tenant (GET /api/v1/stores), every body's expectedTenant. */
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly number: number;
  /** The session token its requests go with; null once detached. */
  readonly csrf: string | null;
  readonly stage: PaymentStage;
  /** The stage's Idempotency-Key ('' for the proof GET). */
  readonly stageKey: string;
  /** The stage's exact bytes (the proof's: the registration id); '' once it can never be sent again. */
  readonly body: string;
  /** A monotonic and a wall-clock reading at the stage's FIRST send: Check again never moves them. */
  readonly sentAt: number;
  readonly sentWall: number;
  readonly registrationId: string | null;
  /** The registration proof: memory only, never shown, logged or put into text; null once the record is decided. */
  readonly proof: string | null;
  readonly amountCents: number;
  /** The method typed; null for a settlement started from the lookup of an attempt with no payment. */
  readonly method: InvoicePaymentMethod | null;
  /** The recorded payment (its id null when a sealed already_recorded said so without naming it). */
  readonly payment: { readonly id: string | null; readonly amountCents: number; readonly method: InvoicePaymentMethod } | null;
  /** The settlement's expected version (1 withdraws, 2 confirms) while the stage is settle. */
  readonly settleVersion: 1 | 2 | null;
  readonly state: PaymentState;
  readonly say: PaymentSay;
  /** The Retry-After of a 429 that left it unresolved (seconds), for the wait text. */
  readonly retryAfter: number;
  /** Bumped when the payments page one should be read again (a recorded payment, a sealed refusal, a confirmation). */
  readonly rereads: number;
}

export interface PaymentHoldStore extends HoldStore<HeldPayment> {
  dispose(): void;
}

/** Live: not decided and still attached — never replaced by a new press. */
export const isLivePayment = (held: HeldPayment | undefined): held is HeldPayment => held !== undefined && held.state !== 'done' && held.csrf !== null;
/** Not decided (attached or not): it blocks recording at its store until it is decided (G7). */
export const isOpenPayment = (held: HeldPayment | undefined): held is HeldPayment => held !== undefined && held.state !== 'done';

/**
 * Blocking (R2 N1): undecided AND still sendable or out here — attached, and out, recorded (Confirm waits) or holding bytes.
 * A detached or byte-less one is still shown on its invoice but blocks nothing: the server's per-invoice slot decides.
 */
export const isBlockingPayment = (held: HeldPayment | undefined): held is HeldPayment => held !== undefined && held.state !== 'done' && held.csrf !== null
  && (held.state === 'sending' || held.state === 'checking' || held.state === 'recorded' || held.body !== '');
/** What never changes after `put` (the token only through detach). */
const FIXED: ReadonlySet<string> = new Set(['key', 'storeId', 'tenantId', 'invoiceId', 'number', 'amountCents', 'csrf']);

const elapsedOf = (held: Pick<HeldPayment, 'sentAt' | 'sentWall'>, mono: number, wall: number): number => Math.max(mono - held.sentAt, wall - held.sentWall);
/** 23 hours since the stage's FIRST send by the larger elapsed time; a non-finite time counts as passed. */
export const paymentExpired = (held: Pick<HeldPayment, 'sentAt' | 'sentWall'>, mono: number, wall: number): boolean => {
  const elapsed = elapsedOf(held, mono, wall);
  return !Number.isFinite(elapsed) || elapsed >= CHECK_CUTOFF_MS;
};

export function createPaymentHoldStore(clocks: { readonly now?: () => number; readonly wallNow?: () => number } = {}): PaymentHoldStore {
  const now = clocks.now ?? (() => performance.now());
  const wallNow = clocks.wallNow ?? (() => Date.now());
  const inner = holdStoreOf<HeldPayment>(isLivePayment);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const uids = new Set<string>(); // every user ever held here: a detach reaches a timer-less attempt's proof too (R1 S5)
  /** Nothing that could send it stays: the proof goes wherever the bytes went. */
  const scrubProof = (uid: string): void => {
    const held = inner.get(uid);
    if (held !== undefined && held.proof !== null && (held.csrf === null || held.body === '')) inner.change(uid, held.key, { proof: null });
  };
  const sync = (uid: string): void => {
    clearTimeout(timers.get(uid));
    timers.delete(uid);
    scrubProof(uid);
    const held = inner.get(uid);
    if (held === undefined || held.body === '') return;
    const mono = now();
    const wall = wallNow();
    if (paymentExpired(held, mono, wall)) return void inner.change(uid, held.key, { body: '', proof: null });
    timers.set(uid, setTimeout(() => { timers.delete(uid); sync(uid); }, Math.min(CHECK_CUTOFF_MS, CHECK_CUTOFF_MS - elapsedOf(held, mono, wall))));
  };
  return Object.freeze({
    get: inner.get,
    put(uid: string, attempt: HeldPayment): boolean {
      if (!inner.put(uid, attempt)) return false;
      uids.add(uid);
      sync(uid);
      return true;
    },
    change(uid: string, key: string, next: Partial<Omit<HeldPayment, 'key'>>): boolean {
      const current = inner.get(uid);
      if (current === undefined) return false;
      // A detached or expired attempt never gets bytes or a proof back; what identifies it never moves; nothing undefined.
      const merged = { sentAt: next.sentAt ?? current.sentAt, sentWall: next.sentWall ?? current.sentWall };
      const unsendable = current.csrf === null || paymentExpired(merged, now(), wallNow());
      const allowed = Object.entries(next).every(([field, value]) => !FIXED.has(field) && value !== undefined)
        && !(unsendable && ((typeof next.body === 'string' && next.body !== '') || (typeof next.proof === 'string')));
      if (!allowed || !inner.change(uid, key, next)) return false;
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
      for (const other of uids) if (other !== uid) sync(other);
    },
    subscribe: inner.subscribe,
    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      inner.detachOthers(null);
      for (const other of uids) scrubProof(other);
    },
  });
}

/** The shop's one payment hold store, detached at every sign-out as the void's. */
export const paymentHolds: PaymentHoldStore = createPaymentHoldStore();
const unbindPaymentHolds = bindDraftHoldsToSessionEnd(paymentHolds);
import.meta.hot?.dispose(() => { unbindPaymentHolds(); paymentHolds.dispose(); });

export type StageAnswer = RegisterResult | ProofResult | RecordResult | SettleResult;
/** What one stage's answer decides (CONTRACT §3.5; spec "Outcome map"). */
export type PaymentVerdict =
  | { readonly kind: 'registered'; readonly registrationId: string }
  | { readonly kind: 'proof'; readonly proof: string }
  | { readonly kind: 'recorded'; readonly payment: { readonly id: string; readonly amountCents: number; readonly method: InvoicePaymentMethod } | null }
  | { readonly kind: 'settled'; readonly state: 'withdrawn' | 'confirmed' }
  /** Decided, nothing recorded by it: nothing held any more (`reread`: page one again). */
  | { readonly kind: 'final'; readonly say: PaymentSay; readonly reread: boolean; readonly lookup?: boolean }
  /** Never sent again: the attempts lookup decides it. */
  | { readonly kind: 'lookup'; readonly say: PaymentSay; readonly reread: boolean }
  /** Undecided: kept, only Check again (same key and bytes) or the lookup. */
  | { readonly kind: 'unresolved'; readonly say: PaymentSay; readonly retryAfter: number };

function unresolvedOf(answer: StageAnswer): PaymentVerdict {
  if (answer.kind === 'in-progress') return { kind: 'unresolved', say: 'inProgress', retryAfter: 0 };
  if (answer.kind === 'rate-limited') return { kind: 'unresolved', say: 'rateLimited', retryAfter: answer.retryAfterSeconds };
  return { kind: 'unresolved', say: 'uncertain', retryAfter: 0 };
}

/**
 * One stage's answer. `first`: that stage's first send (else a Check again). Only a register's first send can be refused
 * for good before anything was written (400/401/403/413/415, a 404 or nothing sent); everywhere else those leave it
 * unresolved. A record 404 never leads to a fresh key or a resend: the lookup decides it.
 */
export function judgePayment(stage: PaymentStage, answer: StageAnswer, first: boolean): PaymentVerdict {
  const k = answer.kind;
  if (k === 'tenant-conflict') return { kind: 'lookup', say: 'detached', reread: false };
  // A 422 means these bytes can never be sent under that key again: Check again would only loop (R1 S6).
  if (k === 'key-reused') return { kind: 'lookup', say: 'detached', reread: false };
  switch (stage) {
    case 'register':
      if (answer.kind === 'registered') return { kind: 'registered', registrationId: answer.registrationId };
      if (k === 'already-recorded' || k === 'invalid-state') return { kind: 'final', say: 'invalidState', reread: true };
      // This attempt wrote nothing (another of this user's holds the slot): nothing held for it, the lookup finds the other (R1 S2).
      if (k === 'write-conflict') return { kind: 'final', say: 'writeConflict', reread: false, lookup: true };
      if (first && k === 'denied') return { kind: 'final', say: 'denied', reread: false };
      if (first && k === 'signed-out') return { kind: 'final', say: 'signedOut', reread: false };
      if (first && (k === 'invalid' || k === 'not-sent' || k === 'not-found')) return { kind: 'final', say: 'notAccepted', reread: false };
      return unresolvedOf(answer);
    case 'proof':
      if (answer.kind === 'proof') return { kind: 'proof', proof: answer.proof };
      if (k === 'not-found') return { kind: 'lookup', say: 'detached', reread: false };
      return unresolvedOf(answer);
    case 'record':
      if (answer.kind === 'recorded') return { kind: 'recorded', payment: answer.payment };
      if (k === 'already-recorded') return { kind: 'recorded', payment: null };
      if (k === 'invalid-state') return { kind: 'lookup', say: 'invalidState', reread: true };
      if (k === 'amount-exceeds') return { kind: 'lookup', say: 'amountExceeds', reread: true };
      if (k === 'write-conflict') return { kind: 'lookup', say: 'detached', reread: false }; // sealed, unreachable here: never looped (R1 S6)
      if (k === 'unmatched') return { kind: 'lookup', say: 'record404', reread: false }; // never a resend or a fresh key
      return unresolvedOf(answer);
    case 'settle':
      if (answer.kind === 'settled') return { kind: 'settled', state: answer.state };
      if (k === 'write-conflict' || k === 'not-found') return { kind: 'lookup', say: '', reread: false };
      return unresolvedOf(answer);
  }
}

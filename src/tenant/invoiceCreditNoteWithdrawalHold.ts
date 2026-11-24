// M7B-CREDITNOTES-CN-P3 — the shop's held credit-note withdrawal: one withdrawal of one active credit note of one issued
// invoice, held in memory BEFORE its POST leaves and settled by its key. The reversal hold's model (invoiceReversalHold.ts)
// without its Retry: a withdrawal is sent ONCE under ONE key, and an unsettled one is recovered by reads only.
//
//   - Held: the key, the store, the invoice and the credit note it was sent to (the invoice's number, the note's number and
//     amount, for the card), the reason chosen and the session token it went with. Never the body: nothing is sent again.
//   - One live attempt per user (`sending`, `unresolved`): a second is refused while one is live; a settled one
//     (`withdrawn`, `refused`) is replaced.
//   - An answer is used only while the token, the sign-out count AND the caller's store/invoice binding it went with all
//     stand; otherwise the attempt is DETACHED (token gone, state unresolved) and the answer changes nothing.
//   - What a Check credit note status read saw is `seen`: only `withdrawn` settles it (not attributed: another request may
//     have withdrawn it); `active` and `unconfirmed` settle nothing.
//   - Memory only: no browser storage, URL, DOM or log; a page load ends it.
import { bindDraftHoldsToSessionEnd, holdStoreOf } from './ServerInvoiceDrafts';
import type { HoldStore } from './ServerInvoiceDrafts';
import { sessionEndsSoFar } from './tenantSessionClient';
import type { InvoiceCreditNoteWithdrawalReason, WithdrawCreditNoteResult } from './invoiceIssuingClient';

/** What decisively ended an attempt (state refused). */
export type WithdrawalRefusal = Exclude<WithdrawCreditNoteResult['kind'], 'withdrawn' | 'unknown' | 'in-progress' | 'not-sent'>;

/** One withdrawal attempt, held BEFORE it leaves. Detached is `csrf` null. */
export interface HeldWithdrawal {
  readonly key: string;
  /** Always '': no Retry, so no bytes are kept (HoldBase asks for the field). */
  readonly body: string;
  readonly storeId: string;
  readonly invoiceId: string;
  readonly number: number;
  readonly creditNoteId: string;
  readonly creditNoteNumber: number;
  readonly grossCents: number;
  readonly reason: InvoiceCreditNoteWithdrawalReason;
  readonly csrf: string | null;
  readonly state: 'sending' | 'unresolved' | 'withdrawn' | 'refused';
  readonly refusal: WithdrawalRefusal | null;
  /** State withdrawn: true when this key's own answer said so; false when only a status read saw it withdrawn. */
  readonly attributed: boolean;
  /** What the last status read showed (null: not read). */
  readonly seen: 'withdrawn' | 'active' | 'unconfirmed' | null;
}
export type WithdrawalHoldStore = HoldStore<HeldWithdrawal>;

const LIVE: ReadonlySet<HeldWithdrawal['state']> = new Set(['sending', 'unresolved']);
export const isLiveWithdrawal = (held: HeldWithdrawal | undefined): held is HeldWithdrawal => held !== undefined && LIVE.has(held.state);

export function createWithdrawalHoldStore(): WithdrawalHoldStore {
  const inner = holdStoreOf<HeldWithdrawal>(isLiveWithdrawal);
  const known = new Set<string>();
  // A detached attempt is never out here again: one left `sending` is `unresolved`, so its card offers the status read.
  const settleDetached = (uid: string): void => {
    const held = inner.get(uid);
    if (held !== undefined && held.csrf === null && held.state === 'sending') inner.change(uid, held.key, { state: 'unresolved' });
  };
  return Object.freeze({
    ...inner,
    put(uid: string, attempt: HeldWithdrawal): boolean {
      if (!inner.put(uid, attempt)) return false;
      known.add(uid);
      return true;
    },
    detach(uid: string): void {
      inner.detach(uid);
      settleDetached(uid);
    },
    detachOthers(uid: string | null): void {
      inner.detachOthers(uid);
      for (const other of known) if (other !== uid) settleDetached(other);
    },
  });
}

/** The shop's one withdrawal hold store, detached at every sign-out as the reversal's. */
export const withdrawalHolds: WithdrawalHoldStore = createWithdrawalHoldStore();
const unbindWithdrawalHolds = bindDraftHoldsToSessionEnd(withdrawalHolds);
import.meta.hot?.dispose(() => { unbindWithdrawalHolds(); withdrawalHolds.detachOthers(null); });

/** A first send's answers that ran nothing (decided before the key): dropped with its confirmation open, else refused. */
const NOT_RUN: ReadonlySet<string> = new Set(['step-up', 'denied', 'signed-out', 'not-found', 'tenant-conflict', 'invalid', 'rate-limited']);
/** The sealed refusals: settled refused (invalid-state: already withdrawn). */
const DECIDES: ReadonlySet<string> = new Set(['invalid-state', 'write-conflict']);

/**
 * One withdrawal answer, settled BY KEY. `sent`: the token and `sessionEndsSoFar()` the request went with; `stands`: whether
 * the caller's store and invoice binding still holds — when any of them no longer stands the attempt is detached and the
 * answer is not used. `open`: whether the confirmation that pressed it is still open. 200 withdrawn; sealed refusals
 * refused; not-run answers dropped (open) or refused; key-reused, in-progress and unknown leave it unresolved.
 */
export function settleWithdrawal(
  holds: WithdrawalHoldStore, uid: string, key: string, answer: WithdrawCreditNoteResult, sent: { readonly csrf: string; readonly since: number }, stands: boolean, open: boolean,
): void {
  const held = holds.get(uid);
  if (held === undefined || held.key !== key) return;
  if (held.csrf !== sent.csrf || sent.since !== sessionEndsSoFar() || !stands) return holds.detach(uid);
  if (!isLiveWithdrawal(held)) return;
  const { kind } = answer;
  if (kind === 'withdrawn') return void holds.change(uid, key, { state: 'withdrawn', attributed: true, refusal: null });
  if (kind === 'not-sent' || (open && NOT_RUN.has(kind))) return void holds.remove(uid, key);
  if (NOT_RUN.has(kind) || DECIDES.has(kind)) return void holds.change(uid, key, { state: 'refused', refusal: kind as WithdrawalRefusal });
  holds.change(uid, key, { state: 'unresolved' });
}

/**
 * What a status read decides: only `withdrawn` settles (not attributed); the rest record what was seen. `attachedAtRead`:
 * whether the attempt was attached when the read began — one detached since is a late answer: nothing.
 */
export function seeWithdrawal(holds: WithdrawalHoldStore, uid: string, key: string, seen: 'withdrawn' | 'active' | 'unconfirmed', attachedAtRead: boolean): void {
  const held = holds.get(uid);
  if (held === undefined || held.key !== key || !isLiveWithdrawal(held) || (attachedAtRead && held.csrf === null)) return;
  if (seen === 'withdrawn') return void holds.change(uid, key, { state: 'withdrawn', attributed: false, seen, refusal: null });
  holds.change(uid, key, { seen });
}

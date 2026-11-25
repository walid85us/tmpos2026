// M7B-CREDITNOTES-CN-P3 — the shop's held credit-note withdrawal: one withdrawal of one active credit note of one issued
// invoice, held in memory BEFORE its POST leaves and settled by its key. The reversal hold's model (invoiceReversalHold.ts)
// without its Retry: a withdrawal is sent ONCE under ONE key, and an unsettled one is recovered by reads only.
//
//   - Held: the key, the store, the invoice and the credit note it was sent to (the invoice's number, the note's number and
//     amount, for the card), the reason chosen and the session token it went with. Never the body: nothing is sent again.
//   - One live attempt per user, store AND invoice (`sending`, `unresolved`), its slot (`withdrawalSlot`): a second on that
//     invoice is refused while one is live; a settled one (`withdrawn`, `refused`) is replaced. Attempts on other invoices
//     or stores are independent (CN-P3 R2: an unresolved one never holds back another invoice).
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
/**
 * The hold store keyed by SLOT (`withdrawalSlot`): `get`, `put`, `change`, `remove` and `detach` take a slot; `detachOthers`
 * takes a user (every slot of every other user, or all with null) and `of` lists one user's attempts.
 */
export interface WithdrawalHoldStore extends HoldStore<HeldWithdrawal> {
  /** `uid`'s attempts; the same array until the store changes (a useSyncExternalStore snapshot). */
  of(uid: string): readonly HeldWithdrawal[];
}
/** One user's one invoice of one store: where its one live attempt is held. */
export const withdrawalSlot = (uid: string, storeId: string, invoiceId: string): string => `${uid}\u0000${storeId}\u0000${invoiceId}`;
const userOf = (slot: string): string => slot.slice(0, slot.indexOf('\u0000'));

const LIVE: ReadonlySet<HeldWithdrawal['state']> = new Set(['sending', 'unresolved']);
export const isLiveWithdrawal = (held: HeldWithdrawal | undefined): held is HeldWithdrawal => held !== undefined && LIVE.has(held.state);

export function createWithdrawalHoldStore(): WithdrawalHoldStore {
  const inner = holdStoreOf<HeldWithdrawal>(isLiveWithdrawal);
  const known = new Set<string>();
  let version = 0;
  inner.subscribe(() => { version += 1; }); // first listener: every change is counted before anyone reads `of`
  const lists = new Map<string, { readonly version: number; readonly list: readonly HeldWithdrawal[] }>();
  // A detached attempt is never out here again: one left `sending` is `unresolved`, so its card offers the status read.
  const detachSlot = (slot: string): void => {
    inner.detach(slot);
    const held = inner.get(slot);
    if (held !== undefined && held.csrf === null && held.state === 'sending') inner.change(slot, held.key, { state: 'unresolved' });
  };
  return Object.freeze({
    ...inner,
    put(slot: string, attempt: HeldWithdrawal): boolean {
      known.add(slot); // before the put tells: `of` must see it
      return inner.put(slot, attempt);
    },
    detach: detachSlot,
    detachOthers(uid: string | null): void {
      for (const slot of [...known]) if (uid === null || userOf(slot) !== uid) detachSlot(slot);
    },
    of(uid: string): readonly HeldWithdrawal[] {
      const cached = lists.get(uid);
      if (cached !== undefined && cached.version === version) return cached.list;
      const list = Object.freeze([...known].filter((slot) => userOf(slot) === uid).map((slot) => inner.get(slot)).filter((h): h is HeldWithdrawal => h !== undefined));
      lists.set(uid, { version, list });
      return list;
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
  holds: WithdrawalHoldStore, slot: string, key: string, answer: WithdrawCreditNoteResult, sent: { readonly csrf: string; readonly since: number }, stands: boolean, open: boolean,
): void {
  const held = holds.get(slot);
  if (held === undefined || held.key !== key) return;
  if (held.csrf !== sent.csrf || sent.since !== sessionEndsSoFar() || !stands) return holds.detach(slot);
  if (!isLiveWithdrawal(held)) return;
  const { kind } = answer;
  if (kind === 'withdrawn') return void holds.change(slot, key, { state: 'withdrawn', attributed: true, refusal: null });
  if (kind === 'not-sent' || (open && NOT_RUN.has(kind))) return void holds.remove(slot, key);
  if (NOT_RUN.has(kind) || DECIDES.has(kind)) return void holds.change(slot, key, { state: 'refused', refusal: kind as WithdrawalRefusal });
  holds.change(slot, key, { state: 'unresolved' });
}

/**
 * What a status read decides: only `withdrawn` settles (not attributed); the rest record what was seen. `attachedAtRead`:
 * whether the attempt was attached when the read began — one detached since is a late answer: nothing.
 */
export function seeWithdrawal(holds: WithdrawalHoldStore, slot: string, key: string, seen: 'withdrawn' | 'active' | 'unconfirmed', attachedAtRead: boolean): void {
  const held = holds.get(slot);
  if (held === undefined || held.key !== key || !isLiveWithdrawal(held) || (attachedAtRead && held.csrf === null)) return;
  if (seen === 'withdrawn') return void holds.change(slot, key, { state: 'withdrawn', attributed: false, seen, refusal: null });
  holds.change(slot, key, { seen });
}

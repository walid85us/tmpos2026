// Phase 4.0 M5-GIAM-D1-P3 — the Tenant Management workspace: the platform tenant directory, a tenant's details, its
// display-name edit and its suspend/reactivate lifecycle actions, over the server's own read and commands
// (tenantManagementClient.ts). It replaces the placeholder that stood here.
//
// THE SERVER DECIDES. The list, the version every command names, who may rename or change status, whether a value is
// valid and what the tenant's status now is all come from the server. The page shows only the controls the server's
// `actions` hint allows, and that is presentation: every command is authorized again by the server, and a refusal is
// shown as a refusal. Nothing is shown as done until the server confirms it, and after every definitive answer the page
// reads the directory again. The next status is never computed here: a lifecycle action names the one transition the
// server-reported status allows, and the server decides whether it still applies.
//
// ONE KEY PER INTENT. Each change carries an Idempotency-Key held for exactly that intent. An answer the server did not
// give — a lost connection, a timeout, a server error, a request still running — keeps the key, and "Try again" sends
// the same change under it, so a change can never be applied twice; a definitive answer releases it, and the next
// attempt, even of the same change, is a new intent. A submission is ignored while another is pending.
//
// NO STORE LIFECYCLE CONTROLS (doc 08 DA-41), and nothing here reaches a legacy mock or an owner-side mutation path.

import React from 'react';
import { cx } from '../ui';
import { useConsole } from './consoleContext';
import { BUTTON_SECONDARY, FOCUS_RING, Spinner } from './ConsolePages';
import {
  DISPLAY_NAME_MAX, REASON_MAX, REASON_MIN, checkDisplayName, checkReason, createIntentKeys, isDefinitive,
} from './tenantManagementClient';
import type { CommandOutcome, TenantEntry, TenantPage, TenantStatus, TextProblem } from './tenantManagementClient';

const STATUS_LABEL: Readonly<Record<TenantStatus, string>> = {
  active: 'Active', trialing: 'Trial', overdue: 'Overdue', suspended: 'Suspended', read_only: 'Read-only', pending_activation: 'Pending activation',
};
const STATUS_TONE: Readonly<Record<TenantStatus, string>> = {
  active: 'border-emerald-700 bg-emerald-950 text-emerald-100',
  trialing: 'border-sky-700 bg-sky-950 text-sky-100',
  overdue: 'border-amber-700 bg-amber-950 text-amber-100',
  suspended: 'border-rose-700 bg-rose-950 text-rose-100',
  read_only: 'border-slate-600 bg-slate-800 text-slate-100',
  pending_activation: 'border-slate-600 bg-slate-800 text-slate-100',
};

const NAME_PROBLEM: Readonly<Record<TextProblem, string>> = {
  empty: 'Enter a display name.',
  'too-short': 'Enter a display name.',
  'too-long': `Use at most ${DISPLAY_NAME_MAX} characters.`,
  character: 'Remove control, line-break and text-direction characters.',
};
const REASON_PROBLEM: Readonly<Record<TextProblem, string>> = {
  empty: `Enter a reason of at least ${REASON_MIN} characters.`,
  'too-short': `Enter a reason of at least ${REASON_MIN} characters.`,
  'too-long': `Use at most ${REASON_MAX} characters.`,
  character: 'Remove control, line-break and text-direction characters.',
};

const UNNAMED = 'Unnamed tenant';
const nameOf = (tenant: TenantEntry): string => tenant.displayName ?? UNNAMED;
// A stored name is shown as stored, so it is isolated: a direction control in it can never reorder the text around it.
const Name = ({ tenant }: { tenant: TenantEntry }) => <bdi>{nameOf(tenant)}</bdi>;

type Feedback = { readonly tone: 'success' | 'error'; readonly text: string; readonly retry?: boolean; readonly signIn?: boolean } | null;

/** What each outcome tells the person. */
function feedbackOf(outcome: CommandOutcome, success: string): Feedback {
  switch (outcome.kind) {
    case 'applied': return { tone: 'success', text: success };
    case 'conflict': return { tone: 'error', text: 'This tenant changed after it was loaded, so nothing was saved. The current details are shown; review them and try again.' };
    case 'invalid-state': return { tone: 'error', text: 'The tenant\'s status changed, so this action no longer applies. The current status is shown.' };
    case 'not-found': return { tone: 'error', text: 'This tenant could not be found. The list has been refreshed.' };
    case 'invalid': return { tone: 'error', text: 'The server did not accept this value. Check it against the rules shown and try again.' };
    case 'forbidden': return { tone: 'error', text: 'You don\'t have permission to make this change. Nothing was changed.' };
    case 'step-up': return { tone: 'error', text: 'This change needs a recent sign-in. Sign in again, then retry. Nothing was changed.', signIn: true };
    case 'key-reused': return { tone: 'error', text: 'This change could not be completed. Nothing was changed; try again.' };
    case 'rate-limited': return { tone: 'error', text: 'Too many requests. Wait a moment, then try again.', retry: true };
    case 'uncertain': return { tone: 'error', text: 'The server did not confirm this change, so it may or may not have been saved. Try again to find out — retrying the same change is safe.', retry: true };
    default: return { tone: 'error', text: 'Your session has ended. Sign in again.' };
  }
}

function StatusBadge({ status }: { status: TenantStatus }) {
  return (
    <span className={cx('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold', STATUS_TONE[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Message({ feedback, onRetry, onSignIn, busy }: { feedback: Feedback; onRetry?: () => void; onSignIn?: () => void; busy?: boolean }) {
  if (feedback === null) return null;
  return (
    <div
      role={feedback.tone === 'error' ? 'alert' : 'status'}
      className={cx('mt-3 rounded-lg border px-3 py-2 text-sm', feedback.tone === 'error' ? 'border-rose-800 bg-rose-950 text-rose-100' : 'border-emerald-800 bg-emerald-950 text-emerald-100')}
    >
      <p>{feedback.text}</p>
      {feedback.retry && onRetry ? (
        <button type="button" onClick={onRetry} disabled={busy} className={cx('mt-2 rounded-md bg-rose-200 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-60', FOCUS_RING)}>
          Try again
        </button>
      ) : null}
      {feedback.signIn && onSignIn ? (
        <button type="button" onClick={onSignIn} className={cx('mt-2 rounded-md bg-rose-200 px-3 py-1.5 text-xs font-semibold text-slate-950', FOCUS_RING)}>
          Sign in again
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// the confirmation dialog: focus contained, Escape closes, focus returns to its trigger
// ---------------------------------------------------------------------------------------------------------------------

type StatusRequest = Parameters<ReturnType<typeof useConsole>['tenants']['changeStatus']>[0];

function LifecycleDialog({ tenant, target, initialReason, onClose, onDone }: {
  tenant: TenantEntry;
  target: 'suspended' | 'active';
  initialReason: string;
  onClose: () => void;
  onDone: (outcome: CommandOutcome, reason: string) => void;
}) {
  const { tenants } = useConsole();
  const [reason, setReason] = React.useState(initialReason);
  const [problem, setProblem] = React.useState<TextProblem | null>(null);
  const [pending, setPending] = React.useState(false);
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const keys = React.useRef(createIntentKeys()).current;
  const busy = React.useRef(false);
  const unsettled = React.useRef<StatusRequest | null>(null); // the exact change whose answer never arrived
  const dialog = React.useRef<HTMLDivElement>(null);
  const field = React.useRef<HTMLTextAreaElement>(null);
  const suspend = target === 'suspended';
  const verb = suspend ? 'Suspend tenant' : 'Reactivate tenant';

  React.useEffect(() => { field.current?.focus(); }, []);

  async function confirm(replay = false) {
    if (busy.current) return; // one attempt at a time, whatever the clicks
    let request: StatusRequest;
    if (replay && unsettled.current !== null) {
      request = unsettled.current; // "Try again": the same change, byte for byte, under the same key
    } else {
      const checked = checkReason(reason);
      if ('problem' in checked) {
        setProblem(checked.problem);
        field.current?.focus();
        return;
      }
      setProblem(null);
      request = { tenantId: tenant.tenantId, status: target, reason: checked.value, expectedVersion: tenant.version };
    }
    const key = keys.keyFor(JSON.stringify(request));
    busy.current = true;
    setPending(true);
    setFeedback(null);
    const outcome = await tenants.changeStatus(request, key).catch((): CommandOutcome => ({ kind: 'uncertain' }));
    busy.current = false;
    setPending(false);
    if (!isDefinitive(outcome)) {
      unsettled.current = request;
      setFeedback(feedbackOf(outcome, ''));
      return; // the same intent may be retried under the same key
    }
    unsettled.current = null;
    keys.settle();
    onDone(outcome, reason);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy.current) onClose();
      return;
    }
    if (event.key !== 'Tab' || dialog.current === null) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])')];
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const errorId = 'lifecycle-reason-error';
  return (
    // A press on the backdrop must not move focus out of the dialog, where Escape and Tab are handled.
    <div
      onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4 sm:items-center"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifecycle-title"
        aria-describedby="lifecycle-explanation"
        onKeyDown={onKeyDown}
        className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl"
      >
        <h2 id="lifecycle-title" className="text-lg font-semibold text-white">
          {suspend ? 'Suspend' : 'Reactivate'} <Name tenant={tenant} />?
        </h2>
        <p id="lifecycle-explanation" className="mt-2 text-sm leading-relaxed text-slate-300">
          {suspend
            ? 'Suspending takes effect immediately: every session of this tenant and its stores is refused from its next request, and no one in the tenant can sign in until it is reactivated.'
            : 'Reactivating lets this tenant\'s users and stores sign in again. It does not restore any session that ended while the tenant was suspended — everyone signs in again.'}
        </p>
        <label htmlFor="lifecycle-reason" className="mt-4 block text-sm font-semibold text-slate-100">Reason</label>
        <p id="lifecycle-reason-hint" className="text-xs text-slate-400">
          {REASON_MIN}–{REASON_MAX} characters. Recorded with this change in the audit log.
        </p>
        <textarea
          id="lifecycle-reason"
          ref={field}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          aria-invalid={problem !== null}
          aria-describedby={problem === null ? 'lifecycle-reason-hint' : `lifecycle-reason-hint ${errorId}`}
          readOnly={pending}
          className={cx('mt-2 w-full rounded-lg border bg-slate-950 px-3 py-2 text-sm text-white', problem === null ? 'border-slate-600' : 'border-rose-500', FOCUS_RING)}
        />
        {problem !== null ? <p id={errorId} className="mt-1 text-sm text-rose-200">{REASON_PROBLEM[problem]}</p> : null}
        <Message feedback={feedback} onRetry={() => void confirm(true)} busy={pending} />
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={pending} className={cx(BUTTON_SECONDARY, 'sm:w-auto')}>Cancel</button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={pending}
            aria-busy={pending}
            className={cx(
              'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-70',
              suspend ? 'bg-rose-400 text-slate-950 hover:bg-rose-300' : 'bg-emerald-400 text-slate-950 hover:bg-emerald-300',
              FOCUS_RING,
            )}
          >
            {pending ? <><Spinner /> Sending…</> : verb}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// a tenant's details: the rename form and the lifecycle action
// ---------------------------------------------------------------------------------------------------------------------

type RenameRequest = Parameters<ReturnType<typeof useConsole>['tenants']['rename']>[0];

function TenantDetails({ tenant, actions, onChanged }: {
  tenant: TenantEntry;
  actions: TenantPage['actions'];
  /** Re-read the directory after a definitive answer; `note` is announced with the result. */
  onChanged: (note?: string) => void;
}) {
  const { client, tenants } = useConsole();
  const [draft, setDraft] = React.useState(tenant.displayName ?? '');
  const [problem, setProblem] = React.useState<TextProblem | null>(null);
  const [pending, setPending] = React.useState(false);
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const [lifecycle, setLifecycle] = React.useState<Feedback>(null);
  const [dialog, setDialog] = React.useState<'suspended' | 'active' | null>(null);
  // A reason typed for a transition the server refused, offered again if the same transition is reopened.
  const [kept, setKept] = React.useState<{ readonly target: 'suspended' | 'active'; readonly reason: string } | null>(null);
  const keys = React.useRef(createIntentKeys()).current;
  const busy = React.useRef(false);
  const unsettled = React.useRef<RenameRequest | null>(null); // the exact change whose answer never arrived
  const trigger = React.useRef<HTMLButtonElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  // Focus goes back to the trigger in the commit that removes the dialog (a layout effect runs inside that commit),
  // before any later input can move it — never in a deferred frame that could land after the person has moved on.
  const [restore, setRestore] = React.useState(0);
  React.useLayoutEffect(() => {
    if (restore > 0) (trigger.current ?? document.getElementById('tenant-details-title'))?.focus();
  }, [restore]);

  async function save(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy.current) return; // one attempt at a time, whatever the clicks
    let request: RenameRequest;
    if (event === undefined && unsettled.current !== null) {
      request = unsettled.current; // "Try again": the same change, byte for byte, under the same key
    } else {
      const checked = checkDisplayName(draft);
      if ('problem' in checked) {
        setProblem(checked.problem);
        input.current?.focus();
        return;
      }
      setProblem(null);
      request = { tenantId: tenant.tenantId, displayName: checked.value, expectedVersion: tenant.version };
    }
    const key = keys.keyFor(JSON.stringify(request));
    busy.current = true;
    setPending(true);
    setFeedback(null);
    const outcome = await tenants.rename(request, key).catch((): CommandOutcome => ({ kind: 'uncertain' }));
    busy.current = false;
    setPending(false);
    if (outcome.kind === 'expired') { client.expire(); return; }
    unsettled.current = isDefinitive(outcome) ? null : request;
    if (isDefinitive(outcome)) keys.settle();
    const shown = outcome.kind === 'applied'
      ? feedbackOf(outcome, `Display name saved as “${outcome.tenant.displayName ?? request.displayName}”.`)
      : feedbackOf(outcome, ''); // the entered value is kept
    if (outcome.kind === 'applied') setDraft(outcome.tenant.displayName ?? request.displayName); // the server-confirmed value
    setFeedback(shown);
    if (isDefinitive(outcome)) onChanged(shown?.text);
  }

  function closeDialog() {
    setDialog(null);
    setRestore((n) => n + 1);
  }

  function lifecycleDone(outcome: CommandOutcome, reason: string) {
    if (outcome.kind === 'expired') { client.expire(); return; }
    const success = outcome.kind === 'applied' && outcome.tenant.status === 'suspended'
      ? 'Tenant suspended. Every tenant and store session is refused from its next request.'
      : 'Tenant reactivated. Its users can sign in again; sessions that ended during the suspension are not restored.';
    const shown = feedbackOf(outcome, success);
    setKept(outcome.kind === 'applied' || dialog === null ? null : { target: dialog, reason });
    setLifecycle(shown);
    closeDialog();
    onChanged(shown?.text);
  }

  const target: 'suspended' | 'active' | null = tenant.status === 'active' ? 'suspended' : tenant.status === 'suspended' ? 'active' : null;
  const errorId = 'display-name-error';
  return (
    <section aria-labelledby="tenant-details-title" className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
      <h2 id="tenant-details-title" tabIndex={-1} className={cx('break-words rounded text-base font-semibold text-white', FOCUS_RING)}>
        <Name tenant={tenant} />
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-slate-400">Status</dt>
        <dd><StatusBadge status={tenant.status} /></dd>
        <dt className="text-slate-400">Tenant ID</dt>
        <dd className="break-all font-mono text-xs text-slate-200">{tenant.tenantId}</dd>
        <dt className="text-slate-400">Version</dt>
        <dd className="text-slate-200">{tenant.version}</dd>
      </dl>

      {actions.editDisplayName ? (
        <form onSubmit={(event) => void save(event)} noValidate className="mt-6 border-t border-slate-800 pt-5">
          <h3 className="text-sm font-semibold text-slate-100">Display name</h3>
          <label htmlFor="display-name" className="mt-3 block text-sm font-medium text-slate-200">New display name</label>
          <p id="display-name-hint" className="text-xs text-slate-400">
            1–{DISPLAY_NAME_MAX} characters. Spaces at either end are removed.
          </p>
          <input
            id="display-name"
            ref={input}
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            readOnly={pending}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? 'display-name-hint' : `display-name-hint ${errorId}`}
            autoComplete="off"
            className={cx('mt-2 w-full rounded-lg border bg-slate-950 px-3 py-2 text-sm text-white', problem === null ? 'border-slate-600' : 'border-rose-500', FOCUS_RING)}
          />
          {problem !== null ? <p id={errorId} className="mt-1 text-sm text-rose-200">{NAME_PROBLEM[problem]}</p> : null}
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className={cx('mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-70', FOCUS_RING)}
          >
            {pending ? <><Spinner /> Saving…</> : 'Save display name'}
          </button>
          <Message feedback={feedback} onRetry={() => void save()} onSignIn={() => void client.logout()} busy={pending} />
        </form>
      ) : null}

      {actions.changeStatus ? (
        <div className="mt-6 border-t border-slate-800 pt-5">
          <h3 className="text-sm font-semibold text-slate-100">Lifecycle</h3>
          {target === null ? (
            <p className="mt-2 text-sm text-slate-300">
              Status changes here are available only for active or suspended tenants. This tenant is {STATUS_LABEL[tenant.status].toLowerCase()}.
            </p>
          ) : (
            <button
              ref={trigger}
              type="button"
              onClick={() => { setLifecycle(null); setDialog(target); }}
              className={cx(
                'mt-3 inline-flex items-center rounded-lg px-4 py-2 text-sm font-semibold',
                target === 'suspended' ? 'border border-rose-500 text-rose-100 hover:bg-rose-950' : 'border border-emerald-500 text-emerald-100 hover:bg-emerald-950',
                FOCUS_RING,
              )}
            >
              {target === 'suspended' ? 'Suspend tenant' : 'Reactivate tenant'}
            </button>
          )}
          <Message feedback={lifecycle} onSignIn={() => void client.logout()} />
        </div>
      ) : null}

      {dialog !== null ? (
        <LifecycleDialog
          tenant={tenant}
          target={dialog}
          initialReason={kept !== null && kept.target === dialog ? kept.reason : ''}
          onClose={closeDialog}
          onDone={lifecycleDone}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------------------------------------------------

type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly page: TenantPage }
  | { readonly phase: 'problem'; readonly problem: 'forbidden' | 'rate-limited' | 'unavailable' };

export default function TenantManagementPage() {
  const { client, tenants } = useConsole();
  const [cursors, setCursors] = React.useState<readonly (string | null)[]>([null]);
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' });
  const [last, setLast] = React.useState<TenantPage | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const inflight = React.useRef<AbortController | null>(null);
  const sequence = React.useRef(0);
  const alive = React.useRef(true);
  const cursor = cursors[cursors.length - 1];
  const shownCursor = React.useRef(cursor);
  shownCursor.current = cursor;

  const read = React.useCallback((at: string | null, note?: string) => {
    if (!alive.current) return; // a command that finishes after the page is gone reads nothing
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const mine = ++sequence.current;
    setLoad({ phase: 'loading' });
    setAnnouncement(note ?? 'Loading tenants…');
    void tenants.list(at, controller.signal)
      .catch(() => ({ kind: 'unavailable' as const }))
      .then((outcome) => {
        if (mine !== sequence.current || outcome.kind === 'aborted') return;
        if (outcome.kind === 'expired') { client.expire(); return; }
        if (outcome.kind === 'ok') {
          setLast(outcome.page);
          setLoad({ phase: 'ready', page: outcome.page });
          const n = outcome.page.tenants.length;
          const loaded = n === 0 ? 'No tenants to show.' : `${n} tenant${n === 1 ? '' : 's'} loaded.`;
          setAnnouncement(note === undefined ? loaded : `${note} ${loaded}`);
          return;
        }
        const problem = outcome.kind === 'forbidden' ? 'forbidden' : outcome.kind === 'rate-limited' ? 'rate-limited' : 'unavailable';
        if (problem === 'forbidden') setLast(null);
        setLoad({ phase: 'problem', problem });
        setAnnouncement(problem === 'forbidden' ? 'Tenant Management is not available to you.' : 'Tenants could not be loaded.');
      });
  }, [client, tenants]);

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  React.useEffect(() => {
    read(cursor);
    return () => { sequence.current++; inflight.current?.abort(); inflight.current = null; };
  }, [read, cursor]);
  // After a command: the page shown NOW, never the one the command started on.
  const refresh = React.useCallback((note?: string) => read(shownCursor.current, note), [read]);

  const page = load.phase === 'ready' ? load.page : load.phase === 'problem' && load.problem === 'forbidden' ? null : last;
  const loading = load.phase === 'loading';
  const current = page?.tenants.find((t) => t.tenantId === selected) ?? null;

  // Focus moves to the chosen tenant's heading in the commit that shows it (a layout effect), before any later input —
  // a deferred frame could otherwise land after a dialog has opened and take focus out of it.
  const [chosen, setChosen] = React.useState(0);
  React.useLayoutEffect(() => {
    if (chosen > 0) document.getElementById('tenant-details-title')?.focus();
  }, [chosen]);
  function choose(tenant: TenantEntry) {
    setSelected(tenant.tenantId);
    setChosen((n) => n + 1);
  }

  let body: React.ReactNode;
  if (load.phase === 'problem' && load.problem === 'forbidden') {
    body = (
      <div role="alert" className="rounded-2xl border border-slate-700 bg-slate-900 p-6 text-sm text-slate-200">
        <h2 className="text-base font-semibold text-white">Not available</h2>
        <p className="mt-2">Your account does not have access to Tenant Management.</p>
      </div>
    );
  } else if (page === null && load.phase === 'problem') {
    body = (
      <div role="alert" className="rounded-2xl border border-amber-800 bg-amber-950 p-6">
        <h2 className="text-base font-semibold text-amber-100">Tenants could not be loaded</h2>
        <p className="mt-2 text-sm text-amber-100">
          {load.problem === 'rate-limited' ? 'Too many requests. Wait a moment, then try again.' : 'The server did not answer. Nothing was changed.'}
        </p>
        <button type="button" onClick={() => read(cursor)} className={cx('mt-4 rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-200', FOCUS_RING)}>
          Try again
        </button>
      </div>
    );
  } else if (page === null) {
    body = <p className="flex items-center gap-2 text-sm text-slate-300"><Spinner /> Loading tenants…</p>;
  } else {
    body = (
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <section aria-labelledby="tenant-list-title" aria-busy={loading}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="tenant-list-title" className="text-base font-semibold text-white">Tenants</h2>
            <button type="button" onClick={() => read(cursor)} disabled={loading} className={cx(BUTTON_SECONDARY, 'sm:w-auto')}>
              {loading ? <><Spinner /> Refreshing…</> : 'Refresh'}
            </button>
          </div>
          {load.phase === 'problem' ? (
            <div role="alert" className="mt-3 rounded-lg border border-amber-800 bg-amber-950 px-3 py-2 text-sm text-amber-100">
              The list could not be refreshed; the last loaded page is shown.{' '}
              <button type="button" onClick={() => read(cursor)} className={cx('font-semibold underline', FOCUS_RING)}>Try again</button>
            </div>
          ) : null}
          {page.tenants.length === 0 ? (
            <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-300">No tenants to show.</p>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Tenants, oldest first</caption>
                <thead className="bg-slate-900 text-xs text-slate-400">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-semibold">Tenant</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-2 font-semibold"><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {page.tenants.map((tenant) => (
                    <tr key={tenant.tenantId} className={tenant.tenantId === selected ? 'bg-slate-800' : undefined}>
                      <th scope="row" className="px-4 py-3 font-medium text-white">
                        <span className={cx('break-words', tenant.displayName === null ? 'italic text-slate-300' : undefined)}><Name tenant={tenant} /></span>
                        <span className="block break-all font-mono text-[11px] font-normal text-slate-400">{tenant.tenantId}</span>
                      </th>
                      <td className="px-4 py-3"><StatusBadge status={tenant.status} /></td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => choose(tenant)}
                          aria-label={`Open details for ${nameOf(tenant)}`}
                          aria-pressed={tenant.tenantId === selected}
                          className={cx('rounded-md px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-slate-800', FOCUS_RING)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label="Tenant pages" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-slate-300">
            <button type="button" onClick={() => setCursors((c) => c.slice(0, -1))} disabled={loading || cursors.length === 1} className={cx(BUTTON_SECONDARY, 'sm:w-auto')}>
              Previous page
            </button>
            <span>Page {cursors.length}</span>
            <button type="button" onClick={() => { const next = page.nextCursor; if (next !== null) setCursors((c) => [...c, next]); }} disabled={load.phase !== 'ready' || page.nextCursor === null} className={cx(BUTTON_SECONDARY, 'sm:w-auto')}>
              Next page
            </button>
          </nav>
        </section>
        <div>
          {current === null ? (
            <p className="rounded-xl border border-dashed border-slate-700 p-5 text-sm text-slate-400">
              {selected === null ? 'Choose a tenant to see its details.' : 'That tenant is not on this page.'}
            </p>
          ) : (
            <TenantDetails key={current.tenantId} tenant={current} actions={page.actions} onChanged={refresh} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {body}
    </div>
  );
}

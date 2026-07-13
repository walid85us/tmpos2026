// Phase 3.0 M3 — DEV-only "Controlled Action" card for the Backend Control Panel.
//
// The ONLY mutating surface in the BCP shell, and it is deliberately NON-DESTRUCTIVE: its sole server effect on
// success is a single advisory audit marker. It is rendered ONLY inside the DEV-gated BCP shell (behind
// BCP_ROUTE_ENABLED). Presentation gating (effectiveRole === 'system_owner' && !isWriteBlocked) is DEFENSE ONLY —
// it disables the control for clearly-insufficient sessions and never grants authority; the SERVER is the sole
// authority (a direct insufficient request is still denied server-side). The Firebase ID token is fetched
// per-submit by the client and never displayed, logged, persisted, or placed in state. The reason text is sent
// only in the request body — never to the console, URL, analytics, or an error log.

import React from 'react';
import { cx, DeferToneBadge, LockIcon, Panel } from '../ui';
import { useAccess } from '../../context/AccessContext';
import {
  submitAcknowledgeReadinessReview,
  newIdempotencyAttempt,
  resolveAttemptKey,
  type IdempotencyAttempt,
  validateReasonForSubmit,
  describeAckResult,
  checkAcknowledgeEligibility,
  ACK_LENS_OPTIONS,
  REASON_MAX,
  type AckClientResult,
  type EligibilityClientState,
} from './bcpAcknowledgeReadinessReviewClient';

/** Presentation copy per canonical eligibility state. `showRetry` only for transient (non-authoritative) states. */
function describeEligibility(state: EligibilityClientState): { text: string; showRetry: boolean } | null {
  switch (state) {
    case 'eligible': return null; // enabled — no gating message
    case 'checking': return { text: 'Checking server authorization…', showRetry: false };
    case 'not_authorized': return { text: 'Your account is not eligible for this action.', showRetry: false };
    case 'authentication_required': return { text: 'Sign in is required.', showRetry: false };
    case 'unavailable': return { text: 'This action is currently unavailable.', showRetry: true };
    default: return { text: 'Could not verify authorization. Please retry.', showRetry: true }; // 'error'
  }
}

const TONE_CLASS: Record<'success' | 'info' | 'warning' | 'error', string> = {
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  error: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
};
// Text glyphs (never color-only): each tone is also announced by a symbol + word in the title.
const TONE_GLYPH: Record<'success' | 'info' | 'warning' | 'error', string> = {
  success: '✓', info: 'ℹ', warning: '⚠', error: '✕',
};

function SafetyBadges() {
  return (
    <div className="flex flex-wrap gap-2">
      <DeferToneBadge tone="healthy">DEV Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Advisory</DeferToneBadge>
      <DeferToneBadge tone="neutral">Non-Destructive</DeferToneBadge>
      <DeferToneBadge tone="neutral">Server-Authoritative</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Business Data</DeferToneBadge>
      <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Production Disabled</DeferToneBadge>
    </div>
  );
}

export function ControlledActionAcknowledgeCard() {
  const access = useAccess();
  // The Firestore/AccessContext role is a COARSE HINT ONLY and MUST NEVER independently enable this control — it
  // is deliberately NOT read into the enable condition. Canonical SERVER eligibility is the SOLE enabler, probed
  // on mount + on Firebase-auth / role changes (AccessContext re-renders on auth) + on manual retry. The fresh
  // Firebase ID token is fetched inside the client for the single request and never surfaced, logged, or stored.
  const [eligibilityState, setEligibilityState] = React.useState<EligibilityClientState>('checking');
  const [probeNonce, setProbeNonce] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setEligibilityState('checking');
    checkAcknowledgeEligibility()
      .then((s) => { if (active) setEligibilityState(s); })
      .catch(() => { if (active) setEligibilityState('error'); });
    return () => { active = false; };
  }, [access.effectiveRole, access.isWriteBlocked, probeNonce]);
  const serverEligible = eligibilityState === 'eligible';
  const retryEligibility = React.useCallback(() => setProbeNonce((n) => n + 1), []);

  const [open, setOpen] = React.useState(false);
  const [lensKey, setLensKey] = React.useState<string>('ALL');
  const [reason, setReason] = React.useState('');
  const [confirmed, setConfirmed] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [result, setResult] = React.useState<AckClientResult | null>(null);
  // One opaque idempotency key per OPEN-DIALOG attempt (payload-independent): minted on the first submit and
  // reused for every submit in the attempt, so an unchanged repeat → server duplicate and a changed payload →
  // server conflict. Reset to a fresh attempt on each dialog open (never after a terminal result).
  const attemptRef = React.useRef<IdempotencyAttempt>(newIdempotencyAttempt());

  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const firstFieldRef = React.useRef<HTMLSelectElement | null>(null);
  const statusRef = React.useRef<HTMLDivElement | null>(null);

  const reasonCheck = validateReasonForSubmit(reason);
  const canSubmit = serverEligible && confirmed && reasonCheck.ok && !submitting;

  const closeDialog = React.useCallback(() => {
    setOpen(false);
    setSubmitting(false);
    // Restore focus to the trigger for keyboard users.
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const openDialog = React.useCallback(() => {
    if (!serverEligible) return;
    setResult(null);
    setConfirmed(false);
    setReason('');
    setLensKey('ALL');
    attemptRef.current = newIdempotencyAttempt(); // new dialog attempt ⇒ fresh key on the next submit
    setOpen(true);
    // Initial focus is set by the open-focus effect below — AFTER the conditionally-rendered dialog
    // commits. A setTimeout(0) here could fire before the <select> mounts (firstFieldRef still null),
    // leaving focus stranded on the trigger button.
  }, [serverEligible]);

  // Move initial focus to the Readiness lens <select> on every closed → open transition, AFTER the
  // dialog is committed to the DOM so firstFieldRef is attached. Reliable React focus-lifecycle hook —
  // no arbitrary timeout; StrictMode/HMR-safe (open is false at mount, so this is a no-op then).
  React.useEffect(() => {
    if (open) firstFieldRef.current?.focus();
  }, [open]);

  const onSubmit = React.useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    // Reuse this attempt's single key for every submit (minted once). Do NOT reset it on success/duplicate —
    // an unchanged repeat must reuse it (→ server duplicate). A new key is minted only when a new dialog opens.
    const { attempt, key } = resolveAttemptKey(attemptRef.current);
    attemptRef.current = attempt;
    const r = await submitAcknowledgeReadinessReview({ lensKey, reason, idempotencyKey: key });
    setResult(r);
    setSubmitting(false);
    window.setTimeout(() => statusRef.current?.focus(), 0);
  }, [canSubmit, lensKey, reason]);

  const onDialogKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Escape') closeDialog(); };

  const display = result ? describeAckResult(result) : null;
  const eligibility = describeEligibility(eligibilityState);

  return (
    <Panel
      title="Controlled Action — DEV Only"
      subtitle="Acknowledge Readiness Review"
      right={<SafetyBadges />}
    >
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
        <span aria-hidden="true">⚠ </span>
        Advisory acknowledgement only. This does not modify business data.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          ref={triggerRef}
          type="button"
          onClick={openDialog}
          disabled={!serverEligible}
          aria-haspopup="dialog"
          aria-describedby="bcp-action-eligibility"
          className={cx(
            'rounded-lg px-4 py-2 text-sm font-semibold transition',
            serverEligible
              ? 'bg-emerald-500/90 text-slate-950 hover:bg-emerald-400'
              : 'cursor-not-allowed bg-slate-800 text-slate-500',
          )}
        >
          Acknowledge readiness review
        </button>
        {/* Canonical eligibility status (aria-live so state changes are announced). The control is enabled ONLY
            when the SERVER reports eligible; the message never exposes role/permission/parity/cap details. */}
        <div id="bcp-action-eligibility" role="status" aria-live="polite" className="flex flex-wrap items-center gap-2">
          {eligibility && (
            <span className="text-xs text-slate-400">
              {eligibilityState === 'checking' && <span aria-hidden="true">⏳ </span>}
              {eligibility.text}
              {eligibilityState !== 'checking' && (
                <span className="text-slate-500"> The server enforces this independently.</span>
              )}
            </span>
          )}
          {eligibility?.showRetry && (
            <button
              type="button"
              onClick={retryEligibility}
              className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
            >
              Retry
            </button>
          )}
        </div>
      </div>

      {open && (
        <div
          className="mt-4 rounded-xl border border-slate-700/70 bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bcp-action-dialog-title"
          aria-describedby="bcp-action-dialog-desc"
          onKeyDown={onDialogKeyDown}
        >
          <h3 id="bcp-action-dialog-title" className="text-sm font-bold text-slate-100">
            Acknowledge Readiness Review
          </h3>
          <p id="bcp-action-dialog-desc" className="mt-1 text-xs text-amber-200/90">
            Advisory acknowledgement only. This does not modify business data.
          </p>

          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="bcp-action-lens" className="block text-xs font-semibold text-slate-300">
                Readiness lens
              </label>
              <select
                id="bcp-action-lens"
                ref={firstFieldRef}
                value={lensKey}
                onChange={(e) => setLensKey(e.target.value)}
                disabled={submitting}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                {ACK_LENS_OPTIONS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="bcp-action-reason" className="block text-xs font-semibold text-slate-300">
                Reason <span className="text-slate-500">(required)</span>
              </label>
              <textarea
                id="bcp-action-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={submitting}
                maxLength={REASON_MAX}
                rows={3}
                aria-describedby="bcp-action-reason-help"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              />
              <p id="bcp-action-reason-help" className="mt-1 text-[11px] text-slate-500">
                {reason.trim().length}/{REASON_MAX}.{' '}
                {!reasonCheck.ok && reason.length > 0 ? <span className="text-amber-300">{reasonCheck.message}</span> : 'Plain text only.'}
              </p>
            </div>

            <label className="flex items-start gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span>I confirm this advisory acknowledgement of the selected readiness lens.</span>
            </label>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              className={cx(
                'rounded-lg px-4 py-2 text-sm font-semibold transition',
                canSubmit ? 'bg-emerald-500/90 text-slate-950 hover:bg-emerald-400' : 'cursor-not-allowed bg-slate-800 text-slate-500',
              )}
            >
              {submitting ? 'Submitting…' : 'Submit'}
            </button>
            <button
              type="button"
              onClick={closeDialog}
              disabled={submitting}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div
        ref={statusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="mt-4 outline-none"
      >
        {display && (
          <div className={cx('rounded-lg border px-3 py-2 text-sm', TONE_CLASS[display.tone])}>
            <span className="font-semibold">
              <span aria-hidden="true">{TONE_GLYPH[display.tone]} </span>{display.title}
            </span>
            <span className="ml-2 text-xs opacity-90">{display.detail}</span>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default ControlledActionAcknowledgeCard;

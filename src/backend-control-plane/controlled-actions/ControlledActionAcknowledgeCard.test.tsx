import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock ONLY the client network boundary + the access hint. Pure client helpers
// (reason validation, result description, lens options, idempotency) stay real.
const { checkEligibility, submitAck } = vi.hoisted(() => ({ checkEligibility: vi.fn(), submitAck: vi.fn() }));
vi.mock('../../context/AccessContext', () => ({
  useAccess: () => ({ effectiveRole: 'system_owner', isWriteBlocked: false }),
}));
vi.mock('./bcpAcknowledgeReadinessReviewClient', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    checkAcknowledgeEligibility: (...a: unknown[]) => checkEligibility(...a),
    submitAcknowledgeReadinessReview: (...a: unknown[]) => submitAck(...a),
  };
});

import { ControlledActionAcknowledgeCard } from './ControlledActionAcknowledgeCard';

const VALID_REASON = 'Reviewed the readiness lens per policy';
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  checkEligibility.mockReset();
  submitAck.mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); errSpy.mockRestore(); });

const trigger = () => screen.getByRole('button', { name: /Acknowledge readiness review/i });

async function renderEligible() {
  checkEligibility.mockResolvedValue('eligible');
  render(<ControlledActionAcknowledgeCard />);
  await waitFor(() => expect(trigger()).toBeEnabled());
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  await screen.findByRole('dialog');
}

describe('ControlledActionAcknowledgeCard — eligibility gating', () => {
  it('checking state disables the action', async () => {
    checkEligibility.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ControlledActionAcknowledgeCard />);
    expect(trigger()).toBeDisabled();
    expect(screen.getByText(/Checking server authorization/i)).toBeInTheDocument();
  });

  it('eligible enables the action', async () => {
    await renderEligible();
    expect(trigger()).toBeEnabled();
  });

  it('not_authorized disables with a non-authoritative message', async () => {
    checkEligibility.mockResolvedValue('not_authorized');
    render(<ControlledActionAcknowledgeCard />);
    await screen.findByText(/not eligible for this action/i);
    expect(trigger()).toBeDisabled();
  });

  it('authentication_required disables with sign-in wording', async () => {
    checkEligibility.mockResolvedValue('authentication_required');
    render(<ControlledActionAcknowledgeCard />);
    await screen.findByText(/Sign in is required/i);
    expect(trigger()).toBeDisabled();
  });

  it('unavailable disables with explicit unavailable wording and retry', async () => {
    checkEligibility.mockResolvedValue('unavailable');
    render(<ControlledActionAcknowledgeCard />);
    await screen.findByText(/currently unavailable/i);
    expect(trigger()).toBeDisabled();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('a probe failure surfaces a sanitized retryable error', async () => {
    checkEligibility.mockRejectedValue(new Error('RAW probe secret'));
    render(<ControlledActionAcknowledgeCard />);
    await screen.findByText(/Could not verify authorization/i);
    expect(trigger()).toBeDisabled();
    expect(document.body.textContent).not.toContain('RAW probe secret');
  });

  it('retry re-probes eligibility', async () => {
    checkEligibility.mockResolvedValue('unavailable');
    render(<ControlledActionAcknowledgeCard />);
    await screen.findByText(/currently unavailable/i);
    const calls = checkEligibility.mock.calls.length;
    await userEvent.setup().click(screen.getByRole('button', { name: /Retry/i }));
    await waitFor(() => expect(checkEligibility.mock.calls.length).toBeGreaterThan(calls));
  });
});

describe('ControlledActionAcknowledgeCard — dialog, focus & a11y', () => {
  it('dialog is closed initially and opens only when eligible', async () => {
    await renderEligible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await openDialog(userEvent.setup());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('initial focus lands on the lens selector after open', async () => {
    await renderEligible();
    await openDialog(userEvent.setup());
    await waitFor(() => expect(screen.getByLabelText('Readiness lens')).toHaveFocus());
  });

  it('lens selector contains ALL and C-01 through C-07', async () => {
    await renderEligible();
    await openDialog(userEvent.setup());
    const select = screen.getByLabelText('Readiness lens');
    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['ALL', 'C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07']);
  });

  it('warns that acknowledgement does not modify business data', async () => {
    await renderEligible();
    await openDialog(userEvent.setup());
    expect(within(screen.getByRole('dialog')).getByText(/does not modify business data/i)).toBeInTheDocument();
  });

  it('enforces reason validation and confirmation before submit', async () => {
    const user = userEvent.setup();
    await renderEligible();
    await openDialog(user);
    const submit = screen.getByRole('button', { name: /^Submit$/i });
    const reason = screen.getByLabelText(/Reason/i);
    const confirm = screen.getByRole('checkbox');
    expect(submit).toBeDisabled();                         // empty reason
    await user.type(reason, 'x');
    expect(submit).toBeDisabled();                         // too short
    await user.clear(reason);
    await user.type(reason, VALID_REASON);
    expect(submit).toBeDisabled();                         // valid reason, not confirmed
    await user.click(confirm);
    expect(submit).toBeEnabled();                          // confirmed
    await user.click(confirm);
    expect(submit).toBeDisabled();                         // unconfirmed again
  });

  it('enforces the 280-character reason maximum', async () => {
    await renderEligible();
    await openDialog(userEvent.setup());
    expect(screen.getByLabelText(/Reason/i)).toHaveAttribute('maxlength', '280');
  });

  it('Cancel closes the dialog and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    await renderEligible();
    await openDialog(user);
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('Escape closes the dialog and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    await renderEligible();
    await openDialog(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('reopening returns initial focus to the lens selector', async () => {
    const user = userEvent.setup();
    await renderEligible();
    await openDialog(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger()).toHaveFocus());
    await openDialog(user);
    await waitFor(() => expect(screen.getByLabelText('Readiness lens')).toHaveFocus());
  });
});

describe('ControlledActionAcknowledgeCard — submission & status', () => {
  async function fillValid(user: ReturnType<typeof userEvent.setup>) {
    await openDialog(user);
    await user.type(screen.getByLabelText(/Reason/i), VALID_REASON);
    await user.click(screen.getByRole('checkbox'));
  }

  it('double activation produces exactly one client submission', async () => {
    let resolveSubmit: (v: unknown) => void = () => {};
    submitAck.mockImplementation(() => new Promise((res) => { resolveSubmit = res; }));
    const user = userEvent.setup();
    await renderEligible();
    await fillValid(user);
    const submit = screen.getByRole('button', { name: /^Submit$/i });
    await user.click(submit);
    await user.click(submit); // guarded by submitting state
    expect(submitAck).toHaveBeenCalledTimes(1);
    resolveSubmit({ kind: 'success' });
  });

  it('shows a visible Submitting state (text, not color-only)', async () => {
    let resolveSubmit: (v: unknown) => void = () => {};
    submitAck.mockImplementation(() => new Promise((res) => { resolveSubmit = res; }));
    const user = userEvent.setup();
    await renderEligible();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /^Submit$/i }));
    expect(await screen.findByRole('button', { name: /Submitting/i })).toBeInTheDocument();
    resolveSubmit({ kind: 'success' });
  });

  it.each([
    ['success', { kind: 'success' }, '✓', 'Acknowledged'],
    ['duplicate', { kind: 'duplicate' }, 'ℹ', 'Already acknowledged'],
    ['conflict', { kind: 'conflict' }, '⚠', 'Conflicting request'],
    ['rate_limited', { kind: 'rate_limited', retryAfterSeconds: 30 }, '⚠', 'Too many attempts'],
    ['auth_required', { kind: 'auth_required' }, '⚠', 'Sign-in required'],
    ['unavailable', { kind: 'unavailable', retryable: true }, '⚠', 'Temporarily unavailable'],
  ])('renders the %s status as icon plus words', async (_name, result, glyph, title) => {
    submitAck.mockResolvedValue(result);
    const user = userEvent.setup();
    await renderEligible();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /^Submit$/i }));
    const status = await screen.findByText(title);
    expect(status).toBeInTheDocument();
    const region = status.closest('[role="status"]') ?? document.body;
    expect(region.textContent).toContain(glyph);
    expect(region.textContent).toContain(title);
  });

  it('does not render or log UID/email/token/internal-id/raw reason', async () => {
    submitAck.mockResolvedValue({ kind: 'success', correlationKey: 'corr-INTERNAL-999' });
    const user = userEvent.setup();
    await renderEligible();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /^Submit$/i }));
    await screen.findByText('Acknowledged');
    const status = screen.getByText('Acknowledged').closest('[role="status"]');
    expect(status?.textContent).not.toContain('corr-INTERNAL-999');
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
    expect(logged).not.toContain(VALID_REASON);
    expect(logged).not.toContain('corr-INTERNAL-999');
  });
});

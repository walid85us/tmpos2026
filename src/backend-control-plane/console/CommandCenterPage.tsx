// Phase 4.0 M4 — the Command Center: the console home. One read-only summary of the platform —
// posture, the work that needs attention, governance signals and service health — read through
// the one bounded client (commandCenterClient.ts, contract v2). It holds no authority and offers
// no action: the server decides what this session may read, the only buttons are Refresh and
// Try again, and every link opens an existing console workspace.
//
//   - It loads on mount and on an explicit refresh only: no polling, and no refetch on focus or
//     visibility. Each load aborts the one before it and an answer that is not the latest is
//     dropped, so an older response never replaces newer data. Leaving the page aborts its load.
//   - A 401 ends the session on this page (the shell returns to sign-in with the expiry notice);
//     a 403 shows one generic panel and no reason; a failed refresh keeps the last view and says so.
//   - Every label is a constant here: the view supplies only enum members, counts and instants.
//   - A section is "Out of date" when the server says so, or when the UI clock — one timer that
//     re-renders once a minute and sends nothing — finds its reading over 15 minutes old. Past
//     24 hours it is unavailable and shows no figures, as the server would then say. Ages count
//     from the server's generation instant plus the time elapsed here, so a fixed page-clock
//     offset changes neither; a clock stepped forward can only age a reading early.

import React from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../ui';
import {
  MAX_AGE_MS,
  POSTURE_KEYS,
  STALE_AFTER_MS,
  type AbsentSection,
  type AttentionArea,
  type AttentionSeverity,
  type CommandCenterOutcome,
  type CommandCenterView,
  type GovernanceSignal,
  type PostureKey,
  type ServiceKey,
  type ServiceState,
  type SignalState,
} from './commandCenterClient';
import { useConsole } from './consoleContext';
import { BUTTON_SECONDARY, FOCUS_RING, Icon, Spinner, WorkspaceDirectory } from './ConsolePages';
import { CONSOLE_MODULES, modulePath, type ConsoleModule } from './navigation';

type Sections = CommandCenterView['sections'];
type Section = Sections[keyof Sections];
type Chip = 'Unavailable' | 'Not configured' | 'Out of date';
type Problem = 'forbidden' | 'rate-limited' | 'unavailable';

const LOADING = 'Loading the Command Center…';
const FORBIDDEN = "The Command Center isn't available for this account.";
const RATE_LIMITED = 'Too many requests. Wait a moment, then refresh.';
const UNAVAILABLE = "The Command Center didn't load. Try again in a moment.";
const PARTIAL = 'Some sources are unavailable or not configured. Their sections show no figures.';
const ABSENT: Record<AbsentSection['status'], string> = {
  unavailable: 'The source did not answer.',
  not_configured: 'No source is connected.',
};

const PATH = {
  refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7',
  circle: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  info: 'M12 16v-4M12 8h.01M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  slash: 'M5.6 5.6l12.8 12.8M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  plug: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0V7zM12 16v5',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  octagon: 'M12 8v4M12 16h.01M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z',
  triangle: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};

const CHIPS: Record<Chip, { icon: string; tone: string }> = {
  Unavailable: { icon: PATH.slash, tone: 'border-amber-700 bg-amber-950 text-amber-100' },
  'Not configured': { icon: PATH.plug, tone: 'border-slate-600 bg-slate-800 text-slate-100' },
  'Out of date': { icon: PATH.clock, tone: 'border-amber-700 bg-amber-950 text-amber-100' },
};

const POSTURE_LABELS: Record<PostureKey, string> = {
  tenants: 'Tenants',
  stores: 'Stores',
  pending_approvals: 'Pending approvals',
  critical_alerts: 'Critical alerts',
};

const SEVERITY: Record<AttentionSeverity, { label: string; word: (count: number) => string; icon: string; tone: string }> = {
  critical: { label: 'Critical', word: () => 'critical', icon: PATH.octagon, tone: 'border-rose-700 bg-rose-950 text-rose-100' },
  warning: { label: 'Warning', word: (count) => (count === 1 ? 'warning' : 'warnings'), icon: PATH.triangle, tone: 'border-amber-700 bg-amber-950 text-amber-100' },
  info: { label: 'Info', word: () => 'info', icon: PATH.info, tone: 'border-sky-700 bg-sky-950 text-sky-100' },
};

/** Each attention area opens its existing console workspace (contract v2 area→workspace paths). */
const AREA_WORKSPACE: Record<AttentionArea, ConsoleModule> = {
  tenants: workspace('tenant-management'),
  provisioning: workspace('provisioning'),
  billing: workspace('billing-subscriptions'),
  security: workspace('audit-security'),
  platform: workspace('platform-settings'),
};

function workspace(slug: string): ConsoleModule {
  const found = CONSOLE_MODULES.find((module) => module.slug === slug);
  if (found === undefined) throw new Error(`no console workspace ${slug}`);
  return found;
}

const SIGNALS: Record<GovernanceSignal, { label: string; states: Record<SignalState, string> }> = {
  production_locked: { label: 'Production changes', states: { ok: 'Locked', attention: 'Unlocked', unknown: 'Unknown' } },
  approvals_enforced: { label: 'Approval policy', states: { ok: 'Enforced', attention: 'Not enforced', unknown: 'Unknown' } },
  audit_recording: { label: 'Audit trail', states: { ok: 'Recording', attention: 'Not recording', unknown: 'Unknown' } },
};
const SIGNAL_DOT: Record<SignalState, string> = { ok: 'bg-emerald-400', attention: 'bg-amber-400', unknown: 'bg-slate-500' };

const SERVICE_LABELS: Record<ServiceKey, string> = {
  auth: 'Authentication',
  pos: 'POS',
  repairs: 'Repairs',
  inventory: 'Inventory',
  identity_link: 'Identity link',
  audit: 'Audit',
  worker: 'Background jobs',
};
const SERVICE_STATES: Record<ServiceState, { label: string; dot: string }> = {
  healthy: { label: 'Healthy', dot: 'bg-emerald-400' },
  warning: { label: 'Warning', dot: 'bg-amber-400' },
  off: { label: 'Off', dot: 'bg-slate-500' },
  unknown: { label: 'Unknown', dot: 'bg-slate-700 ring-1 ring-slate-400' },
};

const STRIP = 'rounded-xl border border-amber-800 bg-amber-950 px-4 py-3 text-sm text-amber-100';

/** Local HH:MM of an ISO instant. */
function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function Time({ iso }: { iso: string }) {
  return <time dateTime={iso}>{clock(iso)}</time>;
}

/** The UI clock: re-renders once a minute while mounted so sections re-age. It never sends a request. */
function useNow(): number {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function chipOf(section: Section, now: number): Chip | null {
  if (section.status !== 'available') return section.status === 'unavailable' ? 'Unavailable' : 'Not configured';
  return section.stale || now - Date.parse(section.asOf) > STALE_AFTER_MS ? 'Out of date' : null;
}

/** A reading the UI clock ages past the server's 24 h bound is unavailable, as the server would then say. */
function aged(sections: Sections, now: number): Sections {
  const gone: AbsentSection = { status: 'unavailable' };
  const old = (section: Section): boolean => section.status === 'available' && now - Date.parse(section.asOf) > MAX_AGE_MS;
  return {
    posture: old(sections.posture) ? gone : sections.posture,
    attention: old(sections.attention) ? gone : sections.attention,
    governance: old(sections.governance) ? gone : sections.governance,
    services: old(sections.services) ? gone : sections.services,
  };
}

function StateChip({ chip }: { chip: Chip }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium', CHIPS[chip].tone)}>
      <Icon d={CHIPS[chip].icon} className="h-3.5 w-3.5" />
      {chip}
    </span>
  );
}

function DataSection({ id, title, chip, children }: { id: string; title: string; chip: Chip | null; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold text-white">
          {title}
        </h2>
        {chip !== null ? <StateChip chip={chip} /> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Absent({ status }: { status: AbsentSection['status'] }) {
  return <p className="text-sm text-slate-400">{ABSENT[status]}</p>;
}

function Summary({ section, now }: { section: Sections['posture']; now: number }) {
  const chip = chipOf(section, now);
  const values = new Map<PostureKey, number>(section.status === 'available' ? section.metrics.map((metric) => [metric.key, metric.value]) : []);
  return (
    <DataSection id="cc-summary" title="Platform summary" chip={chip}>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {POSTURE_KEYS.map((key) => {
          const value = values.get(key);
          return (
            <div key={key} className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3">
              <dt className="text-sm text-slate-400">{POSTURE_LABELS[key]}</dt>
              {/* An absent section shows its state here, never 0 and never a dash for a number. */}
              <dd className={cx('mt-1', value === undefined ? 'text-sm font-medium text-slate-300' : 'text-2xl font-bold tabular-nums text-white')}>
                {value !== undefined ? value.toLocaleString('en-US') : section.status === 'available' ? 'Not reported' : chip}
              </dd>
            </div>
          );
        })}
      </dl>
    </DataSection>
  );
}

function Attention({ section, now }: { section: Sections['attention']; now: number }) {
  let body: React.ReactNode;
  if (section.status !== 'available') body = <Absent status={section.status} />;
  else if (section.items.length === 0) body = <p className="text-sm text-slate-300">Nothing needs attention right now.</p>;
  else {
    body = (
      <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800">
        {section.items.map((item) => {
          const severity = SEVERITY[item.severity];
          const area = AREA_WORKSPACE[item.area];
          return (
            <li key={`${item.severity}-${item.area}`} className="flex flex-col gap-3 bg-slate-950 px-4 py-3 sm:flex-row sm:items-center">
              <span className={cx('inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold', severity.tone)}>
                <Icon d={severity.icon} className="h-3.5 w-3.5" />
                {severity.label}
              </span>
              <p className="min-w-0 flex-1 text-sm text-slate-200">
                <span className="font-semibold tabular-nums text-white">{item.count}</span> {severity.word(item.count)} in {area.label}
              </p>
              <Link
                to={modulePath(area)}
                className={cx('inline-flex min-h-6 items-center rounded-md text-sm font-semibold text-emerald-300 underline-offset-4 hover:underline', FOCUS_RING)}
              >
                Open {area.label}
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <DataSection id="cc-attention" title="Needs attention" chip={chipOf(section, now)}>
      {body}
    </DataSection>
  );
}

function Governance({ section, now }: { section: Sections['governance']; now: number }) {
  return (
    <DataSection id="cc-governance" title="Governance signals" chip={chipOf(section, now)}>
      {section.status !== 'available' ? (
        <Absent status={section.status} />
      ) : section.signals.length === 0 ? (
        <p className="text-sm text-slate-300">No signals reported.</p>
      ) : (
        <dl className="divide-y divide-slate-800">
          {section.signals.map(({ key, state }) => (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
              <dt className="text-sm text-slate-300">{SIGNALS[key].label}</dt>
              <dd className="inline-flex items-center gap-2 text-sm font-semibold text-white">
                <span className={cx('h-2 w-2 rounded-full', SIGNAL_DOT[state])} aria-hidden="true" />
                {SIGNALS[key].states[state]}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </DataSection>
  );
}

function Services({ section, now }: { section: Sections['services']; now: number }) {
  return (
    <DataSection id="cc-services" title="Service health" chip={chipOf(section, now)}>
      {section.status !== 'available' ? (
        <Absent status={section.status} />
      ) : section.services.length === 0 ? (
        <p className="text-sm text-slate-300">No services reported.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {section.services.map(({ key, state }) => (
            <li key={key} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
              <span className="min-w-0 text-sm text-slate-200">{SERVICE_LABELS[key]}</span>{' '}
              <span className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-white">
                <span className={cx('h-2 w-2 rounded-full', SERVICE_STATES[state].dot)} aria-hidden="true" />
                {SERVICE_STATES[state].label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DataSection>
  );
}

function Dashboard({ view, problem, now }: { view: CommandCenterView; problem: Problem | null; now: number }) {
  const { posture, attention, governance, services } = view.sections;
  const partial = Object.values(view.sections).some((section) => section.status !== 'available');
  return (
    <>
      {problem === 'unavailable' ? (
        <p className={STRIP}>
          Refresh failed — showing data from <Time iso={view.generatedAt} />
        </p>
      ) : null}
      {problem === 'rate-limited' ? <p className={STRIP}>{RATE_LIMITED}</p> : null}
      {partial ? (
        <p className="flex items-start gap-2.5 rounded-xl border border-sky-800 bg-sky-950 px-4 py-3 text-sm text-sky-100">
          <Icon d={PATH.info} className="mt-0.5 h-4 w-4 shrink-0" />
          {PARTIAL}
        </p>
      ) : null}
      <Summary section={posture} now={now} />
      <Attention section={attention} now={now} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Governance section={governance} now={now} />
        <Services section={services} now={now} />
      </div>
    </>
  );
}

function Notice({ id, title, text, tone = 'amber', children }: { id: string; title: string; text: string; tone?: 'amber' | 'slate'; children?: React.ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className={cx('rounded-2xl border p-6', tone === 'amber' ? 'border-amber-800 bg-amber-950 text-amber-100' : 'border-slate-700 bg-slate-900 text-slate-200')}
    >
      <h2 id={id} className="text-base font-semibold text-white">
        {title}
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed">{text}</p>
      {children}
    </section>
  );
}

function Skeleton() {
  const block = 'rounded-2xl border border-slate-800 bg-slate-900 motion-safe:animate-pulse';
  return (
    <div aria-hidden="true" className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {POSTURE_KEYS.map((key) => (
          <div key={key} className={cx(block, 'h-20')} />
        ))}
      </div>
      <div className={cx(block, 'h-40')} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className={cx(block, 'h-40')} />
        <div className={cx(block, 'h-40')} />
      </div>
    </div>
  );
}

interface PageState {
  readonly loading: boolean;
  /** The last view that loaded; kept when a later refresh fails. */
  readonly view: CommandCenterView | null;
  /** Why the latest load gave no view. */
  readonly problem: Problem | null;
  /** When the shown view arrived, on the wall and the monotonic clock: ageing adds only the time elapsed here to the server's clock. */
  readonly receivedAt: number;
  readonly receivedMono: number;
}

export default function CommandCenterPage() {
  const { client, commandCenter } = useConsole();
  const now = useNow();
  const [state, setState] = React.useState<PageState>({ loading: true, view: null, problem: null, receivedAt: 0, receivedMono: 0 });
  const sequence = React.useRef(0);
  const inflight = React.useRef<AbortController | null>(null);
  /** The load the administrator started (Refresh or Try again); the mount load is never one. */
  const started = React.useRef<'refresh' | 'retry' | null>(null);
  /** Where focus last entered this page, so clock-driven ageing can tell when it removed that element. */
  const lastFocus = React.useRef<Element | null>(null);

  const load = React.useCallback(() => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const mine = ++sequence.current;
    setState((current) => ({ ...current, loading: true }));
    void commandCenter
      .load(controller.signal)
      // A client that breaks its "never rejects" contract is an outage, never a page stuck busy.
      .catch((): CommandCenterOutcome => ({ kind: 'unavailable' }))
      .then((outcome) => {
      if (mine !== sequence.current || outcome.kind === 'aborted') return; // superseded: never replaces newer data
      inflight.current = null;
      if (outcome.kind === 'expired') {
        client.expire(); // RequireSession then shows sign-in with the expiry notice
      } else if (outcome.kind === 'ok') {
        setState({ loading: false, view: outcome.view, problem: null, receivedAt: Date.now(), receivedMono: performance.now() });
      } else if (outcome.kind === 'forbidden') {
        setState({ loading: false, view: null, problem: 'forbidden', receivedAt: 0, receivedMono: 0 }); // no view outlives a refusal
      } else {
        const problem = outcome.kind;
        setState((current) => ({ ...current, loading: false, problem })); // the kept view keeps its arrival time
      }
    });
  }, [client, commandCenter]);

  React.useEffect(() => {
    load();
    return () => {
      sequence.current++;
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [load]);

  // When a load the administrator started settles, focus never falls to <body>: if the focused
  // element went away (an attention link the new view dropped), it moves to the page heading
  // (ConsoleShell's h1). "Try again" disappears once it recovers, so that also moves to the
  // heading; a retry that fails again stays on its button, and a live element keeps its focus.
  React.useEffect(() => {
    if (state.loading || started.current === null) return;
    const retry = started.current === 'retry';
    started.current = null;
    const focused = document.activeElement;
    const lost = focused === null || focused === document.body || !focused.isConnected;
    const recovered = retry && (state.view !== null || state.problem !== 'unavailable');
    if (lost || recovered) document.getElementById('page-title')?.focus();
  }, [state]);

  // The UI clock can age a section out and remove what was focused (an attention link). Focus then
  // moves to the page heading, never to <body>; nothing moves when focus is elsewhere or was never here.
  React.useEffect(() => {
    const element = lastFocus.current;
    if (element === null || element.isConnected) return;
    lastFocus.current = null;
    if (document.activeElement === null || document.activeElement === document.body) document.getElementById('page-title')?.focus();
  }); // after every commit: the monotonic reading moves between ticks, so any render can age content out

  // A click while a load runs is ignored: the buttons stay focusable (aria-disabled, never disabled).
  const start = (kind: 'refresh' | 'retry'): void => {
    if (inflight.current !== null) return;
    started.current = kind;
    load();
  };
  const refresh = (): void => start('refresh');
  const tryAgain = (): void => start('retry');

  const { loading, view: loaded, problem, receivedAt, receivedMono } = state;
  // Ageing runs on the server's clock: its generation instant plus the time elapsed here since the
  // answer arrived, so a fixed page-clock offset changes nothing. Elapsed time is the larger of the
  // wall and the monotonic reading: a wall clock set back cannot hold it below the monotonic reading,
  // a monotonic clock paused by sleep cannot hold it back, and a clock stepped forward ages early.
  const elapsed = Math.max(0, now - receivedAt, performance.now() - receivedMono);
  const serverNow = loaded === null ? now : Date.parse(loaded.generatedAt) + elapsed;
  // What is shown: the loaded view, re-aged by the UI clock.
  const view = loaded === null ? null : { ...loaded, sections: aged(loaded.sections, serverNow) };
  const available = view === null ? 0 : Object.values(view.sections).filter((section) => section.status === 'available').length;
  let message = '';
  if (loading) message = LOADING;
  else if (problem === 'forbidden') message = FORBIDDEN;
  else if (problem === 'rate-limited') message = RATE_LIMITED;
  else if (problem === 'unavailable') message = view !== null ? `Refresh failed — showing data from ${clock(view.generatedAt)}` : UNAVAILABLE;
  else if (view !== null) message = `Command Center updated at ${clock(view.generatedAt)}`;

  let content: React.ReactNode;
  if (problem === 'forbidden') content = <Notice id="cc-forbidden" title="Not available" text={FORBIDDEN} tone="slate" />;
  else if (view !== null) content = <Dashboard view={view} problem={problem} now={serverNow} />;
  else if (problem === 'rate-limited') content = <Notice id="cc-rate-limited" title="Please wait" text={RATE_LIMITED} />;
  else if (problem === 'unavailable') {
    content = (
      <Notice id="cc-unavailable" title="Command Center unavailable" text={UNAVAILABLE}>
        <button
          type="button"
          onClick={tryAgain}
          aria-busy={loading}
          aria-disabled={loading}
          className={cx(
            'mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-200 aria-disabled:cursor-wait',
            FOCUS_RING,
          )}
        >
          {loading ? <Spinner /> : null}
          Try again
        </button>
      </Notice>
    );
  } else content = <Skeleton />;

  return (
    <div
      className="space-y-6"
      onFocus={(event) => {
        lastFocus.current = event.target;
      }}
    >
      <div role="status" className="sr-only">
        {message}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-300">
          {view !== null ? (
            <>
              <p>
                Updated <Time iso={view.generatedAt} />
              </p>
              <p>{available} of 4 sources available</p>
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={refresh}
          aria-busy={loading}
          aria-disabled={loading}
          className={cx(BUTTON_SECONDARY, 'sm:w-auto aria-disabled:cursor-wait')}
        >
          {loading ? <Spinner /> : <Icon d={PATH.refresh} className="h-4 w-4" />}
          Refresh
        </button>
      </div>
      {content}
      <WorkspaceDirectory />
    </div>
  );
}

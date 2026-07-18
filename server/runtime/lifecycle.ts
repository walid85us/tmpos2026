// Phase 4.0 M3 — graceful shutdown / lifecycle coordinator.
//
// Fully injectable so it can be tested WITHOUT terminating the test runner: the
// process (signal source), server, exit, and force-timer are all dependencies.
// A reusable module never calls process.exit directly — the thin entry injects
// a real `exit`. SIGTERM/SIGINT drain gracefully (exit 0); uncaughtException,
// unhandledRejection, cleanup failure, and a forced-timeout are fatal (exit !=0).
import { emitLog } from './logging.js';
import type { LogSink } from './logging.js';

export interface ClosableServer {
  close(cb: (err?: Error) => void): void;
  listening?: boolean;
}

export interface SignalSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ReadinessGate {
  setUnavailable(): void;
}

export interface LifecycleDeps {
  server: ClosableServer | null;
  readiness: ReadinessGate;
  hooks?: Array<() => void | Promise<void>>;
  proc: SignalSource;
  exit: (code: number) => void;
  log?: LogSink;
  forceTimeoutMs?: number;
  setTimer?: (ms: number, cb: () => void) => { unref?(): void };
  clearTimer?: (handle: unknown) => void;
}

export interface Lifecycle {
  install(): void;
  shutdown(reason: string, code: number): Promise<void>;
}

function closeServer(server: ClosableServer | null): Promise<void> {
  if (server === null) return Promise.resolve();
  // A not-yet-listening server has nothing to drain, and closing it would error;
  // treat that as an already-clean shutdown (e.g. a signal during startup).
  if (server.listening === false) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function runHooks(hooks: Array<() => void | Promise<void>>): Promise<void> {
  for (const hook of hooks) await hook();
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const forceMs = deps.forceTimeoutMs ?? 10000;
  // The force timer stays REFERENCED during shutdown: it is the only handle that
  // must keep the event loop alive, so a cleanup hook that hangs after the server
  // has closed still hits the deadline instead of the process exiting 0.
  const setTimer = deps.setTimer ?? ((ms, cb) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); });
  const log = (event: string, reason: string): void =>
    emitLog(reason.startsWith('fatal') ? 'error' : 'info', { event, reason }, deps.log);

  let started = false;
  let exited = false;
  // Highest exit code any caller has requested. A fatal event (nonzero) that races
  // an in-progress graceful shutdown escalates the final code; a graceful (0) call
  // never de-escalates a fatal one.
  let pendingCode = 0;
  const doExit = (code: number): void => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  async function shutdown(reason: string, code: number): Promise<void> {
    pendingCode = Math.max(pendingCode, code);
    if (started) {
      // The first call owns the drain sequence; a later fatal event only escalates.
      if (code !== 0) log('shutdown_escalated', reason);
      return;
    }
    started = true;
    log('shutdown_begin', reason);

    // Stop advertising readiness BEFORE draining, so a load balancer can turn away.
    deps.readiness.setUnavailable();

    // Forced-shutdown deadline: if draining/cleanup hangs, exit non-zero anyway.
    const timer = setTimer(forceMs, () => {
      log('shutdown_forced', 'fatal_forced_timeout');
      doExit(1);
    });

    try {
      await closeServer(deps.server); // stop accepting new connections; drain
      await runHooks(deps.hooks ?? []);
    } catch {
      pendingCode = Math.max(pendingCode, 1);
      log('shutdown_cleanup_failed', 'fatal_cleanup_failed');
    }

    if (exited) return; // the force-timer already exited
    clearTimer(timer);
    log('shutdown_complete', reason);
    doExit(pendingCode);
  }

  function install(): void {
    deps.proc.on('SIGTERM', () => { void shutdown('signal_sigterm', 0); });
    deps.proc.on('SIGINT', () => { void shutdown('signal_sigint', 0); });
    deps.proc.on('uncaughtException', () => { void shutdown('fatal_uncaught_exception', 1); });
    deps.proc.on('unhandledRejection', () => { void shutdown('fatal_unhandled_rejection', 1); });
  }

  return { install, shutdown };
}

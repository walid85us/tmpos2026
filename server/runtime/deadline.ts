// Phase 4.0 M4 — bounded port calls.
//
// Every call the runtime makes into a replaceable port — identity verification, admission,
// authorization, session storage, rate limiting and readiness probes — runs under one deadline.
// The call is handed an AbortSignal that aborts when the deadline passes, so an adapter that can
// cancel stops its work; the runtime stops waiting either way. The returned promise settles
// exactly once — with the call's own outcome, or with DeadlineExceeded — and its timer is cleared
// on every path. A late outcome is discarded without an unhandled rejection, and the runtime adds
// no listener to the signal. An adapter's own abort listener must not throw: Node reports a
// throwing EventTarget listener as an uncaught exception.

/** The default bound on one port call; app.ts caps it so the longest chain fits the socket timeout. */
export const PORT_DEADLINE_MS = 3_000;

/** A port call that outlived its deadline. Carries no adapter detail. */
export class DeadlineExceeded extends Error {
  constructor() {
    super('port deadline exceeded');
    this.name = 'DeadlineExceeded';
  }
}

/** Run `call` under a deadline of `ms` milliseconds, handing it the signal that cancels it. */
export function withDeadline<T>(ms: number, call: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DeadlineExceeded());
      controller.abort();
    }, ms);
    // A synchronous throw rejects this inner promise too, so every outcome takes the same path.
    new Promise<T>((settle) => settle(call(controller.signal))).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** A failed port call's bounded reason: `<port>_timeout` at the deadline, `<port>_unavailable` otherwise. */
export function outage<P extends string>(port: P, err: unknown): `${P}_timeout` | `${P}_unavailable` {
  let timedOut = false;
  try {
    timedOut = err instanceof DeadlineExceeded;
  } catch {
    // A hostile rejection value (a Proxy whose prototype trap throws) is an outage, never a throw here.
  }
  return timedOut ? `${port}_timeout` : `${port}_unavailable`;
}

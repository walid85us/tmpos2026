// Phase 4.0 M3 — thin production entry.
//
// The only place permitted to bind a socket and to actually exit the process.
// Order: validate configuration, construct the runtime, bind the HTTP server,
// install lifecycle handlers, emit a bounded startup event. Importing this
// module is side-effect free — it binds only when executed as the entry point.
//
// Response-boundary contract (F6, owner-dispositioned):
//   - APPLICATION layer: once Node has parsed a valid request and Express receives
//     it, EVERY response (health, readiness, unknown route, unsupported method,
//     malformed JSON, oversized body, centralized error) uses the bounded
//     application JSON envelope with baseline security headers — no HTML, stack,
//     identifier, config detail, or secret.
//   - TRANSPORT/PARSER layer: a malformed/incomplete request that Node rejects
//     BEFORE Express receives a valid request uses Node's bounded transport
//     response (fixed 4xx status line, socket closed, no echo of bytes). Proven
//     bounded/non-leaking/non-crashing by the raw-socket suite; no fragile custom
//     socket code is added.
//   - HSTS is intentionally NOT set here: it is a deployment-boundary control that
//     belongs with the TLS-termination/proxy contract in a later M3 staging slice.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createApp, createReadinessState, createBoundedServer } from './app.js';
import { createLifecycle } from './lifecycle.js';
import { emitLog } from './logging.js';

function main(): void {
  const result = loadConfig(process.env);
  if (!result.ok || !result.config) {
    // Field names + reason codes only; never an environment value.
    emitLog('error', {
      event: 'startup_config_invalid',
      reason: result.errors.map((e) => `${e.field}:${e.code}`).join(','),
    });
    process.exit(1); // returns `never` — narrows result.config below
  }
  const config = result.config;

  const readiness = createReadinessState();
  const app = createApp({ readiness, trustProxy: config.trustProxy });
  // Bounded request handling: explicit finite header-size/timeout/count limits
  // (see HTTP_SERVER_LIMITS) instead of Node defaults.
  const server = createBoundedServer(app);

  const lifecycle = createLifecycle({
    server,
    readiness,
    proc: process,
    exit: (code) => { process.exit(code); },
    forceTimeoutMs: 10000,
  });
  // Install signal + fatal-event handlers BEFORE binding, so a signal or an async
  // fault during the startup window is drained gracefully rather than terminated
  // by Node's default handler.
  lifecycle.install();

  server.on('error', () => {
    emitLog('error', { event: 'startup_listen_failed', reason: 'fatal_listen_error' });
    process.exit(1);
  });

  server.listen(config.port, () => {
    readiness.setReady();
    emitLog('info', { event: 'startup_ready' });
  });
}

// Bind only when executed directly; a plain import must not open a port. Compare
// canonical real paths so a symlinked launch path still matches (argv[1] may be a
// symlink while import.meta.url is already realpath-resolved) rather than silently
// no-op to a non-binding exit.
const invoked = process.argv[1];
let isEntry = false;
if (invoked !== undefined) {
  try {
    isEntry = import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    isEntry = false;
  }
}
if (isEntry) main();

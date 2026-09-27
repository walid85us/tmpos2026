// Phase 4.0 M6-ENTRY-P1 — the deployable production entry: the one module that assembles the production composition roots,
// proves every startup precondition, and only then binds the listener (docs/phase-4/02 §2.1, 08 G-CPLOGIN, 10 ADR-27).
//
// STARTUP, IN THIS ORDER. Every step is bounded, and no listener exists until the last one:
//    1. configuration — every value this entry needs, judged purely (validateEntryConfig): no network, no listener, no client.
//       A refusal names each field and a bounded code, never a value. Beside the values it needs, it refuses what must be
//       absent: the driver TLS override, the identity emulator host, the TLS verification switch, a widened trust store
//       (NODE_EXTRA_CA_CERTS, or NODE_OPTIONS selecting --use-openssl-ca) and the owner credentials
//       (SUPABASE_DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
//    2. the database client — the transaction root composes its kernel over the classified APP_DATABASE_URL through the
//       construction's constructor (production: verified TLS against DATABASE_CA_CERT) with every port over it, inert: nothing
//       connects yet, and the URL and its credential never leave the client;
//    3. connect — one trivial statement within STARTUP_STEP_DEADLINE_MS: the endpoint answers over verified TLS as the login;
//    4. the runtime login — its standing against the approved runtime boundary (postgresStartupPreflight.ts): no superuser,
//       BYPASSRLS, CREATEROLE, CREATEDB or replication; exactly the two migration privilege roles, by no other path; nothing
//       owned; no privilege beyond the migrations' and the ledger read;
//    5. the migration ledger — exactly 001–018, clean, checksums pinned. Nothing is applied, rolled back or repaired;
//    6. the composition — the session root (the administrative boundary alone), the request limits, the durable ports and
//       the route table, validated by the runtime itself; the served inventory must equal SHIPPING_ROUTES exactly;
//    7. dependency probes — the idempotency store and the command-transaction port answer their read-only probes;
//    8. the limiter key — migration 014 registers RATE_LIMIT_KEY's fingerprint when the store has none, atomically, and
//       compares it otherwise: a mismatch, a read-only store or an unanswerable probe refuses. Registration therefore happens
//       here, before any request can reach the store. It never replaces a fingerprint: recovery and rotation stay DA-53's;
//    9. readiness — the durable session store reads, the administrative admission answers its probe, and the composed
//       limiter is ready;
//   10. listen — only now. Readiness turns ready once the listener is bound.
// Any refusal logs one or more `startup_refused` lines, each carrying the category (with its bounded codes, split across
// lines at the log's field cap — never configuration content, a driver or provider message, or an address), ends the
// kernel and exits nonzero; no listener was ever opened. There is no degraded
// mode, no in-memory fallback, no automatic migration and no replacement of the limiter's fingerprint.
//
// WHAT IT SERVES. SHIPPING_ROUTES and nothing else: the two operational probes, the administrative boundary's login,
// current-session and logout, the tenant directory read and the two tenant commands — then the bounded 404. No tenant or
// store route (the tenant boundary is served by the separate tenant executable, server/entry/tenantMain.ts, never here),
// no DEV, witness, diagnostic, bootstrap or migration route. Only the administrative host is served: every request but the
// probes must name SESSION_ADMIN_ORIGINS's one authority in Host, or it gets that same bounded 404 before the limiter is
// asked (app.ts `hosts`). X-Forwarded-Host is never read, so the real edge must route the administrative hostname to this
// entry alone and pass its Host through unaltered or reject any other (docs/phase-4/08 DA-9 — not proven here).
//
// AFTER STARTUP. Nothing terminates the process for a dependency outage: /health stays alive and prompt, /readiness answers
// 503 while any composed store is unavailable, and protected traffic fails closed with a bounded 503 (app.ts) — no local
// allowance, no memory fallback, no replay once the store returns.
//
// SHUTDOWN (lifecycle.ts, installed before step 1 so a signal during startup is drained, never killed): readiness turns
// unavailable; startup is aborted, so a signal during preflight binds nothing; the listener stops accepting and in-flight
// requests drain — each bounded by the port deadlines; the kernel ends within RETIRED_POOL_GRACE_S; the process exits 0.
// SHUTDOWN_FORCE_TIMEOUT_MS after the signal it exits 1 whatever still hangs. Repeated signals are one shutdown.
//
// THE CONSTRUCTION BOUNDARY. The configuration is the process environment; the construction is code. PRODUCTION_CONSTRUCTION
// is the only one the executable (main.ts) passes: the verified-TLS client over the classified endpoint, the Firebase Admin
// SDK behind the Firebase adapter, and the configured PORT on every interface. A disposable-database harness passes its own
// — a client over its cluster, a synthetic provider token verifier, a loopback ephemeral port — and nothing in the
// configuration can select one; no testkit or fake is reachable from this file. The construction boundary, the configuration
// both entries share, the step bound and the refusal lines are entryStartup.ts's (M7A-CUSTOMERS-P2), shared with the tenant
// entry; this process refuses the tenant's minting key (TENANT_SESSION_ISSUER_KEY) and never holds it.
import { createHash, randomBytes } from 'node:crypto';
import { createApp, createBoundedServer, createReadinessState } from '../runtime/app.js';
import { loadConfig } from '../runtime/config.js';
import { parseKeyMaterial, sameKeyMaterial } from '../runtime/keyMaterial.js';
import { createLifecycle } from '../runtime/lifecycle.js';
import { emitLog } from '../runtime/logging.js';
import { parseRateLimitKey } from '../runtime/rateLimit.js';
import { EnforcementSetupError } from '../runtime/routes.js';
import { TENANT_DISPLAY_NAME_EVENTS } from '../runtime/tenantDisplayName.js';
import { TENANT_STATUS_EVENTS } from '../runtime/tenantStatus.js';
import { ProductionCompositionError, composeProductionSessions } from '../composition/productionSessions.js';
import type { ProductionSessions } from '../composition/productionSessions.js';
import { TransactionCompositionError, composeProductionTransactions } from '../composition/productionTransactions.js';
import type { ProductionTransactions } from '../composition/productionTransactions.js';
import {
  SHUTDOWN_FORCE_TIMEOUT_MS, bounded, canonicalRoutes, present, refusalLines, validateCommonEntryConfig,
} from './entryStartup.js';
import type { BoundAddress, BoundServer, EntryConfigError, EntryOptions, EntryResult, ServedRoute, StartupFailure } from './entryStartup.js';

/** The exact shipping inventory: nothing else is ever served, and startup refuses if the composed table differs. */
export const SHIPPING_ROUTES: readonly ServedRoute[] = Object.freeze([
  { method: 'GET', path: '/health', access: 'public', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/readiness', access: 'public', body: 'none', idempotency: 'none' },
  { method: 'POST', path: '/admin/v1/session/login', access: 'login', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/admin/v1/session', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'POST', path: '/admin/v1/session/logout', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/admin/v1/tenants', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'PATCH', path: '/admin/v1/tenants/display-name', access: 'session', body: 'json', idempotency: 'required' },
  { method: 'PATCH', path: '/admin/v1/tenants/status', access: 'session', body: 'json', idempotency: 'required' },
].map((route) => Object.freeze(route)));

/** The event contracts the shipping commands enqueue (outbox.ts), validated by the runtime against each command's contract. */
const PRODUCTION_EVENTS = Object.freeze([...TENANT_DISPLAY_NAME_EVENTS, ...TENANT_STATUS_EVENTS]);

/**
 * Every configuration refusal, each as a field and a bounded code — [] when the configuration is complete. Pure: it reads
 * only the named keys of `env`, contacts nothing and constructs no client, listener or provider app. The shared judgments
 * (entryStartup.ts), then this entry's own: the command secret, and never the tenant's minting key.
 */
export function validateEntryConfig(env: Readonly<Record<string, string | undefined>>): EntryConfigError[] {
  const errors = validateCommonEntryConfig(env);
  // The command secret: well formed, and never the limiter's key.
  const limiterKey = present(env.RATE_LIMIT_KEY) ? parseRateLimitKey(env.RATE_LIMIT_KEY) : null;
  const idempotencyKey = present(env.IDEMPOTENCY_KEY) ? parseKeyMaterial(env.IDEMPOTENCY_KEY) : null;
  if (!present(env.IDEMPOTENCY_KEY)) errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_missing' });
  else if (idempotencyKey === null) errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_invalid' });
  else if (limiterKey !== null && sameKeyMaterial(idempotencyKey, limiterKey)) errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_shared' });
  // The tenant entry's minting secret never sits in this process: holding it would let the administrative process mint
  // tenant sessions (docs/phase-4/08 DA-101). Refused whatever its value, which is never read.
  if (present(env.TENANT_SESSION_ISSUER_KEY)) errors.push({ field: 'TENANT_SESSION_ISSUER_KEY', code: 'tenant_issuer_key_present' });
  return errors;
}

/** Whether a served table is exactly SHIPPING_ROUTES — every route, attribute for attribute, and nothing else. */
export const servesExactlyShippingRoutes = (routes: readonly ServedRoute[]): boolean =>
  canonicalRoutes(routes) === canonicalRoutes(SHIPPING_ROUTES);

/**
 * Start the production entry: compose, preflight, and bind only once every precondition holds. A refusal logs its category,
 * ends the kernel and exits nonzero through the lifecycle; a signal during startup drains and exits without binding. The
 * answer says which, for a caller that can observe it (a harness; production has exited by then). It rejects only when the
 * lifecycle itself cannot be installed on `proc` — before anything is composed — and main.ts exits 1 then.
 */
export async function startProductionEntry(options: EntryOptions): Promise<EntryResult> {
  const { env, construction, proc, exit, log } = options;
  const readiness = createReadinessState();
  // Aborted by the lifecycle's first hook: a signal during startup abandons the step in flight and binds nothing.
  const startup = new AbortController();
  let server: BoundServer | null = null;
  let transactions: ProductionTransactions | null = null;
  let routes: readonly ServedRoute[] = Object.freeze([]);
  const listener = {
    close(done: (err?: Error) => void): void {
      if (server === null) done();
      else server.close(done);
    },
    get listening(): boolean {
      return server !== null && server.listening;
    },
  };
  const lifecycle = createLifecycle({
    server: listener,
    readiness,
    proc,
    exit,
    log,
    forceTimeoutMs: options.forceTimeoutMs ?? SHUTDOWN_FORCE_TIMEOUT_MS,
    hooks: [
      () => { startup.abort(); },
      async () => { if (transactions !== null) await transactions.close(); },
    ],
  });
  // Before anything else: a signal or an async fault during startup drains through the same path as one after it.
  lifecycle.install();

  const interrupted = (): EntryResult => {
    emitLog('info', { event: 'startup_interrupted' }, log);
    return Object.freeze({ outcome: 'interrupted', failure: null, reasons: Object.freeze([]), address: null, routes });
  };
  const refuse = async (failure: StartupFailure, reasons: readonly string[] = []): Promise<EntryResult> => {
    if (startup.signal.aborted) return interrupted(); // a signal already owns the shutdown
    for (const reason of refusalLines(failure, reasons)) emitLog('error', { event: 'startup_refused', reason }, log);
    await lifecycle.shutdown('fatal_startup_refused', 1);
    return Object.freeze({ outcome: 'refused', failure, reasons: Object.freeze([...reasons]), address: null, routes });
  };

  try {
    if (typeof construction?.databaseClient !== 'function' || typeof construction.listen !== 'function') {
      return await refuse('startup_failed', ['construction_invalid']);
    }

    // 1. Configuration.
    const configErrors = validateEntryConfig(env);
    if (configErrors.length > 0) return await refuse('config_invalid', configErrors.map((e) => `${e.field}:${e.code}`));
    const port = (loadConfig(env).config as { port: number }).port;
    const adminHost = new URL(env.SESSION_ADMIN_ORIGINS as string).host;

    // 2. The database client and every port over it: constructed, not connected.
    try {
      transactions = composeProductionTransactions(env, construction.databaseClient);
    } catch (err) {
      if (!(err instanceof TransactionCompositionError)) throw err;
      return await refuse(err.blockers.includes('database_tls_invalid') ? 'database_tls_invalid' : 'composition_refused', err.blockers);
    }
    const tx = transactions;
    if (tx === null || tx.preflight === null) return await refuse('composition_refused', ['transaction_boundary_missing']);
    const preflight = tx.preflight;

    // 3. Connect.
    try {
      await bounded(startup.signal, (signal) => preflight.connect(signal));
    } catch {
      return await refuse('database_unavailable');
    }

    // 4. The runtime login.
    let loginViolations: readonly string[];
    try {
      loginViolations = await bounded(startup.signal, (signal) => preflight.runtimeLogin(signal));
    } catch {
      return await refuse('database_unavailable', ['runtime_login_unanswered']);
    }
    if (loginViolations.length > 0) return await refuse('database_login_unsafe', loginViolations);

    // 5. The migration ledger.
    let ledgerViolations: readonly string[];
    try {
      ledgerViolations = await bounded(startup.signal, (signal) => preflight.migrationLedger(signal));
    } catch {
      return await refuse('database_unavailable', ['migration_ledger_unanswered']);
    }
    if (ledgerViolations.length > 0) return await refuse('migration_state_invalid', ledgerViolations);

    // 6. The composition: the administrative session boundary, its limits and the route table.
    let sessions: ProductionSessions;
    try {
      sessions = composeProductionSessions(env, {
        store: tx.sessionStore, tenantAdmission: tx.tenantAdmission, platformAdmission: tx.platformAdmission, rateLimiter: tx.rateLimiter,
      }, { audiences: ['admin'], tokenVerifier: construction.tokenVerifier });
    } catch (err) {
      if (!(err instanceof ProductionCompositionError)) throw err;
      return await refuse('composition_refused', err.blockers);
    }
    let app: ReturnType<typeof createApp>;
    try {
      app = createApp({
        readiness,
        log,
        routes: tx.routes,
        limits: sessions.limits,
        idempotency: tx.idempotency,
        transactions: tx.transactions,
        events: PRODUCTION_EVENTS,
        sessions: sessions.sessions,
        hsts: true,
        hosts: [adminHost],
      });
    } catch (err) {
      if (!(err instanceof EnforcementSetupError)) throw err;
      return await refuse('composition_refused', [err.code]);
    }
    routes = Object.freeze([...(app.locals.routes as readonly ServedRoute[])]);
    if (!servesExactlyShippingRoutes(routes)) return await refuse('route_inventory_mismatch');

    // 7. The command boundary's stores answer their read-only probes.
    const unready: string[] = [];
    const probe = async (name: string, check: (signal: AbortSignal) => unknown): Promise<void> => {
      const ok = await bounded(startup.signal, async (signal) => (await check(signal)) === true).catch(() => false);
      if (!ok) unready.push(name);
    };
    await probe('idempotency_store', (signal) => tx.idempotency.store.probe(signal));
    await probe('command_transactions', (signal) => tx.transactions.port.probe(signal));
    if (unready.length > 0) return await refuse('dependency_unready', unready);

    // 8. The limiter key: registered when the store has none, compared otherwise — before any request can race it.
    let keyStatus: string;
    try {
      keyStatus = await bounded(startup.signal, (signal) => preflight.rateLimitKey(sessions.limits.keySecret, signal));
    } catch {
      return await refuse('rate_limit_store_unavailable');
    }
    if (keyStatus === 'key_mismatch') return await refuse('rate_limit_key_mismatch');
    if (keyStatus === 'store_read_only') return await refuse('rate_limit_store_read_only');
    if (keyStatus === 'consume_unavailable') return await refuse('rate_limit_store_unavailable', ['consume_unavailable']);
    if (keyStatus !== 'ready') return await refuse('rate_limit_probe_malformed');

    // 9. Readiness of what protected traffic needs: a session read, the administrative admission, the composed limiter.
    const adminAdmission = sessions.sessions.admin?.admission;
    // A random digest in the store's own key shape names no session: the one answer that is not a fault is none.
    const absentKey = createHash('sha256').update(randomBytes(32)).digest('base64url');
    await probe('session_store', async (signal) => (await tx.sessionStore.get(absentKey, signal)) === undefined);
    await probe('admin_admission', (signal) => (typeof adminAdmission?.probe === 'function' ? adminAdmission.probe(signal) : false));
    await probe('rate_limiter', (signal) => sessions.limits.limiter.probe(signal));
    if (unready.length > 0) return await refuse('dependency_unready', unready);

    // 10. Listen — only now, and bounded like every step. A socket that binds after startup gave up on this step (a signal
    // or the deadline) is closed the moment it binds, so nothing listens once startup has stopped.
    if (startup.signal.aborted) return interrupted();
    const target = construction.listen(port);
    const bound = createBoundedServer(app, { hsts: true });
    server = bound;
    let abandoned = false;
    const binding = new Promise<BoundAddress | null>((resolve) => {
      const onError = (): void => resolve(null);
      bound.once('error', onError);
      bound.listen({ port: target.port, host: target.host }, () => {
        bound.off('error', onError);
        const at = bound.address() as BoundAddress;
        if (abandoned || startup.signal.aborted) bound.close();
        resolve(at);
      });
    });
    let address: BoundAddress | null;
    try {
      address = await bounded(startup.signal, () => binding);
    } catch {
      abandoned = true;
      if (bound.listening) bound.close(); // bound between the step ending and this line
      return startup.signal.aborted ? interrupted() : await refuse('listen_failed', ['listen_timeout']);
    }
    if (address === null) {
      server = null;
      return await refuse('listen_failed');
    }
    if (startup.signal.aborted) {
      // The signal arrived while the socket was binding: the lifecycle found nothing listening, so it is closed here.
      await new Promise<void>((resolve) => { bound.close(() => resolve()); });
      return interrupted();
    }
    readiness.setReady();
    emitLog('info', { event: 'startup_ready' }, log);
    return Object.freeze({ outcome: 'listening', failure: null, reasons: Object.freeze([]), address, routes });
  } catch {
    // A defect, never a verdict: its text is not logged, since it may carry what the refusals above never do.
    return refuse('startup_failed');
  }
}

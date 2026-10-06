// M7A-CUSTOMERS-P2 — the deployable tenant entry: the one module that assembles the tenant composition, proves every
// startup precondition, and only then binds the listener (docs/phase-4/10 ADR-33 decision 8, ADR-27; 08 G-CPLOGIN, G-IAM).
// It is its own executable (tenantMain.ts, compiled by tsconfig.server.tenant.json): which boundary a process serves is
// decided by which executable runs, never by configuration, and this one ships no administrative route, mutator or entry.
//
// STARTUP, IN THIS ORDER. Every database step and the bind are bounded (entryStartup.ts), and no listener exists until the last:
//    1. configuration — the judgments both entries share (validateCommonEntryConfig), then this entry's own, purely:
//       SESSION_TENANT_ORIGINS, exactly one canonical https origin on a host distinct from SESSION_ADMIN_ORIGINS's (which is
//       required here for that comparison); TENANT_SESSION_ISSUER_KEY, the minting secret (transactionKernel.ts
//       parseTenantIssuerKey: present, canonical, never RATE_LIMIT_KEY, not weak); and IDEMPOTENCY_KEY, this process's own
//       command secret (M7A-CUSTOMERS-P3): present, canonical, never RATE_LIMIT_KEY or the issuer key. A refusal names each
//       field and a bounded code, never a value;
//    2. the database client — the tenant transaction root composes the kernel over the classified APP_DATABASE_URL through
//       the construction's constructor, with every port over it, inert: nothing connects yet;
//    3. connect;
//    4. the runtime login — the same approved boundary the administrative entry judges;
//    5. the migration ledger — exactly 001–028, clean, checksums pinned (each of 020-028 moves with its build);
//    6. parameter logging — no setting the login's sessions run with would log a bound parameter, and a session store key
//       is one (postgresStartupPreflight.ts evaluateParameterLogging);
//    7. the composition — the session root (the tenant boundary alone, its route authorizer over the owner's durable role
//       edits), the request limits, the durable ports, the tenant store's idempotency and command ports, the ONE event
//       contract this entry composes (M7B-INVOICES-P1: invoice_draft.created v1, the draft save's — invoiceDrafts.ts
//       INVOICE_DRAFT_EVENTS, and nothing else) and the route table, validated by the runtime itself; the served inventory
//       must equal TENANT_SHIPPING_ROUTES exactly;
//    8. the issuer key — the database must hold this process's key: its fingerprint alone is sent, and only `match` passes.
//       Before the limiter's step, so a wrong key refuses before 014's fingerprint is registered;
//    9. the limiter key — as the administrative entry's: registered when the store has none, compared otherwise. Both
//       processes hold the same RATE_LIMIT_KEY, since 014 keeps one fingerprint per database;
//   10. readiness — the session store reads, the session mint answers its probe (018's refusal of all-null arguments,
//       before it reads or writes anything), the tenant admission answers its probe, the limiter is ready, the
//       customer reads answer their probe (the directory's routine, then the detail's — M7A-CUSTOMERS-P4 — then the
//       profile's — M7A-CUSTOMERS-P6, over 024's versioned routine since -P7 — then the search's — -P8 — then the store
//       directory's — M7B-INVOICES-P1, 027's — then the invoice drafts' two reads — M7B-INVOICES-P1, 028's — each refusing an
//       absent key), and the idempotency store and the command port answer
//       theirs (006's probe);
//   11. listen — only now. Readiness turns ready once the listener is bound.
// Any refusal logs one or more `startup_refused` lines of bounded codes, ends the kernel and exits nonzero; no listener was
// ever opened. There is no degraded mode, no in-memory fallback, no automatic migration and no key installation.
//
// WHAT IT SERVES. TENANT_SHIPPING_ROUTES and nothing else: the two operational probes, the tenant boundary's login,
// current-session and logout, GET /api/v1/customers over the production customer directory, — M7A-CUSTOMERS-P3 —
// POST /api/v1/customers, the customer create, and — M7A-CUSTOMERS-P3-R1 — PUT /api/v1/roles/levels, an owner's durable
// edit of a built-in role's Customers level, each idempotent and committed through the tenant store; — M7A-CUSTOMERS-P3-R2 —
// GET /api/v1/roles/levels, the owner's read-back of those levels beside their catalog defaults; — M7A-CUSTOMERS-P4 —
// GET /api/v1/customers/{id}, one customer by id (the route table's first template: /api/v1/customers/ plus one segment,
// judged after authentication); — M7A-CUSTOMERS-P6 — GET /api/v1/customers/{id}/profile, that customer's phone, email and
// creation time (the second template: the same segment, then exactly '/profile'), and POST /api/v1/customers taking the
// optional contacts; — M7A-CUSTOMERS-P7 — PATCH /api/v1/customers/{id}, a versioned edit of that customer's name and
// contacts (the third template and the first templated command: the same segment, judged after authentication, bound into
// the idempotency fingerprint), idempotent and committed through the tenant store; the profile read now carries the
// customer's version as its strong ETag; — M5-INVOICES-AUTH-P1 — GET /api/v1/roles/levels/invoices, the owner's read-back of
// the built-in roles' Invoices levels (the PUT above now also accepts domain 'invoices'; since M7B-INVOICES-P1 the draft
// routes below decide on that level); — M7B-INVOICES-P1 — GET /api/v1/stores, the stores the session's actor may act at (exactly one usable
// store-scope grant each), derived by migration 027's routine from the session key alone: the route table's one closed
// authorization-free business route, bound to the session and its CSRF token; and the three STORE-scope invoice draft
// routes (invoiceDrafts.ts, migration 028): POST /api/v1/stores/{storeId}/invoice-drafts, a draft saved at that store —
// idempotent, committed through the tenant store with its audit record, its one outbox event and its completion — and
// GET /api/v1/stores/{storeId}/invoice-drafts[/{id}], the store's drafts and one draft, read-only; — M7B-INVOICES-P1-R2 — a
// fourth, GET /api/v1/stores/{storeId}/invoice-drafts/eligibility, whether a save would be authorized at that store now,
// decided under the save's own requirement and writing no business row (like every authorized read, a 200 refreshes the
// session's lastSeenAt and each request spends the request limit); each authorized only
// through the actor's own store grant at exactly that store — then the bounded 404.
// No administrative route, no other store-scoped route, no DEV, witness, diagnostic, bootstrap or migration route. Only the tenant host is
// served: every request but the probes must name SESSION_TENANT_ORIGINS's one authority in Host, or it gets that bounded
// 404 before the limiter is asked (app.ts `hosts`). X-Forwarded-Host is never read, so the real edge must route the tenant
// hostname to this entry alone and pass its Host through unaltered (docs/phase-4/08 DA-107 — not proven here).
//
// AFTER STARTUP. /health stays alive; /readiness answers 503 while any dependency fails — the limiter, the tenant
// admission, the issuer key (deleted or rotated: 503 until a restart with the right key), the customer reads, the
// session store, the session mint, the idempotency store, the command port and the parameter-logging judgment, each
// shared per PROBE_REUSE_MS — and protected
// traffic fails closed with a bounded 503. Nothing terminates the process for a dependency outage.
//
// SHUTDOWN, and THE CONSTRUCTION BOUNDARY, exactly as the administrative entry's (productionEntry.ts): the lifecycle is
// installed first, and PRODUCTION_CONSTRUCTION is the only construction the executable passes. No testkit or fake is
// reachable from this file.
import { createHash, randomBytes } from 'node:crypto';
import { createApp, createBoundedServer, createReadinessState } from '../runtime/app.js';
import { loadConfig } from '../runtime/config.js';
import { createLifecycle } from '../runtime/lifecycle.js';
import { emitLog } from '../runtime/logging.js';
import { parseKeyMaterial, sameKeyMaterial } from '../runtime/keyMaterial.js';
import { normalizeOrigin } from '../runtime/requestSecurity.js';
import { EnforcementSetupError } from '../runtime/routes.js';
import { sharesHost } from '../runtime/sessions.js';
import { ProductionCompositionError, composeProductionSessions } from '../composition/productionSessions.js';
import type { ProductionSessions } from '../composition/productionSessions.js';
import { TransactionCompositionError, parseTenantIssuerKey } from '../composition/transactionKernel.js';
import type { ReadTransactions } from '../composition/transactionKernel.js';
import { composeTenantTransactions } from '../composition/tenantTransactions.js';
import { INVOICE_DRAFT_EVENTS } from '../runtime/invoiceDrafts.js';
import {
  SHUTDOWN_FORCE_TIMEOUT_MS, bounded, canonicalRoutes, present, refusalLines, servableHost, validateCommonEntryConfig,
} from './entryStartup.js';
import type { BoundAddress, BoundServer, EntryConfigError, EntryOptions, EntryResult, ServedRoute, StartupFailure } from './entryStartup.js';

/** The exact tenant shipping inventory: nothing else is ever served, and startup refuses if the composed table differs. */
export const TENANT_SHIPPING_ROUTES: readonly ServedRoute[] = Object.freeze([
  { method: 'GET', path: '/health', access: 'public', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/readiness', access: 'public', body: 'none', idempotency: 'none' },
  { method: 'POST', path: '/api/v1/session/login', access: 'login', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/api/v1/session', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'POST', path: '/api/v1/session/logout', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/api/v1/customers', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/api/v1/customers/{id}', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/api/v1/customers/{id}/profile', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'POST', path: '/api/v1/customers', access: 'session', body: 'json', idempotency: 'required' },
  { method: 'PATCH', path: '/api/v1/customers/{id}', access: 'session', body: 'json', idempotency: 'required' },
  { method: 'GET', path: '/api/v1/roles/levels', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/api/v1/roles/levels/invoices', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'PUT', path: '/api/v1/roles/levels', access: 'session', body: 'json', idempotency: 'required' },
  { method: 'GET', path: '/api/v1/stores', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/api/v1/stores/{storeId}/invoice-drafts', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/api/v1/stores/{storeId}/invoice-drafts/{id}', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'GET', path: '/api/v1/stores/{storeId}/invoice-drafts/eligibility', access: 'session', body: 'none', idempotency: 'none' },
  { method: 'POST', path: '/api/v1/stores/{storeId}/invoice-drafts', access: 'session', body: 'json', idempotency: 'required' },
].map((route) => Object.freeze(route)));

/**
 * Every configuration refusal, each as a field and a bounded code — [] when the configuration is complete. Pure: it reads
 * only the named keys of `env`, contacts nothing and constructs no client, listener or provider app.
 */
export function validateTenantEntryConfig(env: Readonly<Record<string, string | undefined>>): EntryConfigError[] {
  const errors = validateCommonEntryConfig(env);
  // The tenant origin: exactly one exact canonical https origin — the host this listener serves and the one origin its
  // unsafe requests may come from — on a host the administrative origin does not name (port ignored, sessions.ts).
  const tenant = env.SESSION_TENANT_ORIGINS;
  if (!present(tenant)) errors.push({ field: 'SESSION_TENANT_ORIGINS', code: 'session_tenant_origin_missing' });
  else if (tenant.includes(',')) errors.push({ field: 'SESSION_TENANT_ORIGINS', code: 'session_tenant_origin_not_single' });
  else if (normalizeOrigin(tenant) !== tenant || !tenant.startsWith('https://') || !servableHost(new URL(tenant).host)) {
    errors.push({ field: 'SESSION_TENANT_ORIGINS', code: 'session_tenant_origin_invalid' });
  } else if (!errors.some((e) => e.field === 'SESSION_ADMIN_ORIGINS') && sharesHost([tenant], [env.SESSION_ADMIN_ORIGINS as string])) {
    errors.push({ field: 'SESSION_TENANT_ORIGINS', code: 'session_tenant_origin_shares_admin_host' });
  }
  // The minting secret, judged as the transaction root judges it.
  const issuerKey = parseTenantIssuerKey(env);
  if (typeof issuerKey === 'string') errors.push({ field: 'TENANT_SESSION_ISSUER_KEY', code: issuerKey });
  // This process's own command secret (M7A-CUSTOMERS-P3): well formed, and never the limiter's key or the minting key.
  // Whether it equals the administrative process's IDEMPOTENCY_KEY cannot be judged here (an owner custody item, DA-101).
  const limiterKey = present(env.RATE_LIMIT_KEY) ? parseKeyMaterial(env.RATE_LIMIT_KEY) : null;
  const idempotencyKey = present(env.IDEMPOTENCY_KEY) ? parseKeyMaterial(env.IDEMPOTENCY_KEY) : null;
  if (!present(env.IDEMPOTENCY_KEY)) errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_missing' });
  else if (idempotencyKey === null) errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_invalid' });
  else if ((limiterKey !== null && sameKeyMaterial(idempotencyKey, limiterKey)) || (typeof issuerKey !== 'string' && sameKeyMaterial(idempotencyKey, issuerKey))) {
    errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_shared' });
  }
  return errors;
}

/** Whether a served table is exactly TENANT_SHIPPING_ROUTES — every route, attribute for attribute, and nothing else. */
export const servesExactlyTenantRoutes = (routes: readonly ServedRoute[]): boolean =>
  canonicalRoutes(routes) === canonicalRoutes(TENANT_SHIPPING_ROUTES);

// ponytail: the lifecycle, refusal and listen scaffolding below mirrors startProductionEntry's rather than sharing it —
// sharing means restructuring the administrative entry, whose text the quality census pins. Both are locked by mirrored
// tests (signal during preflight, listen timeout); extract one startup runner when a third entry appears.
/**
 * Start the tenant entry: compose, preflight, and bind only once every precondition holds. A refusal logs its category,
 * ends the kernel and exits nonzero through the lifecycle; a signal during startup drains and exits without binding. The
 * answer says which, for a caller that can observe it (a harness; production has exited by then). It rejects only when the
 * lifecycle itself cannot be installed on `proc` — before anything is composed — and tenantMain.ts exits 1 then.
 */
export async function startTenantEntry(options: EntryOptions): Promise<EntryResult> {
  const { env, construction, proc, exit, log } = options;
  const readiness = createReadinessState();
  // Aborted by the lifecycle's first hook: a signal during startup abandons the step in flight and binds nothing.
  const startup = new AbortController();
  let server: BoundServer | null = null;
  let transactions: ReadTransactions | null = null;
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
    const configErrors = validateTenantEntryConfig(env);
    if (configErrors.length > 0) return await refuse('config_invalid', configErrors.map((e) => `${e.field}:${e.code}`));
    const port = (loadConfig(env).config as { port: number }).port;
    const tenantHost = new URL(env.SESSION_TENANT_ORIGINS as string).host;

    // 2. The database client and every port over it: constructed, not connected.
    try {
      transactions = composeTenantTransactions(env, construction.databaseClient);
    } catch (err) {
      if (!(err instanceof TransactionCompositionError)) throw err;
      return await refuse(err.blockers.includes('database_tls_invalid') ? 'database_tls_invalid' : 'composition_refused', err.blockers);
    }
    const tx = transactions;
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

    // 6. Parameter logging.
    let loggingViolations: readonly string[];
    try {
      loggingViolations = await bounded(startup.signal, (signal) => preflight.parameterLogging(signal));
    } catch {
      return await refuse('database_unavailable', ['parameter_logging_unanswered']);
    }
    if (loggingViolations.length > 0) return await refuse('database_logging_unsafe', loggingViolations);

    // 7. The composition: the tenant session boundary, its limits and the route table.
    let sessions: ProductionSessions;
    try {
      sessions = composeProductionSessions(env, {
        store: tx.sessionStore, tenantAdmission: tx.tenantAdmission, rateLimiter: tx.rateLimiter, tenantReads: tx.tenantReads,
        roleLevels: tx.roleLevels,
      }, { audiences: ['tenant'], tokenVerifier: construction.tokenVerifier });
    } catch (err) {
      if (!(err instanceof ProductionCompositionError)) throw err;
      return await refuse('composition_refused', err.blockers);
    }
    // A random digest in the store's own key shape names no session: the one answer that is not a fault is none.
    const absentKey = createHash('sha256').update(randomBytes(32)).digest('base64url');
    let app: ReturnType<typeof createApp>;
    try {
      app = createApp({
        readiness,
        log,
        routes: tx.routes,
        idempotency: tx.idempotency,
        transactions: tx.transactions,
        // The one event contract the tenant runtime composes (M7B-INVOICES-P1): the draft save's invoice_draft.created.
        events: INVOICE_DRAFT_EVENTS,
        limits: sessions.limits,
        sessions: sessions.sessions,
        hsts: true,
        hosts: [tenantHost],
        dependencyChecks: [
          async (signal) => (await tx.issuerKey(signal)) === 'match',
          (signal) => tx.readsProbe(signal),
          async (signal) => (await tx.sessionStore.get(absentKey, signal)) === undefined,
          (signal) => tx.mintProbe(signal),
          async (signal) => (await preflight.parameterLogging(signal)).length === 0,
        ],
      });
    } catch (err) {
      if (!(err instanceof EnforcementSetupError)) throw err;
      return await refuse('composition_refused', [err.code]);
    }
    routes = Object.freeze([...(app.locals.routes as readonly ServedRoute[])]);
    if (!servesExactlyTenantRoutes(routes)) return await refuse('route_inventory_mismatch');

    // 8. The issuer key: the database holds exactly this process's key. Only its fingerprint is sent.
    let keyAnswer: string;
    try {
      keyAnswer = await bounded(startup.signal, (signal) => tx.issuerKey(signal));
    } catch {
      return await refuse('database_unavailable', ['issuer_key_unanswered']);
    }
    if (keyAnswer === 'absent') return await refuse('tenant_issuer_key_absent');
    if (keyAnswer === 'mismatch') return await refuse('tenant_issuer_key_mismatch');
    if (keyAnswer !== 'match') return await refuse('tenant_issuer_key_probe_malformed');

    // 9. The limiter key: registered when the store has none, compared otherwise — before any request can race it.
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

    // 10. Readiness of what protected traffic needs: a session read, the mint, the tenant admission, the limiter, the customer
    //     read, and the tenant store's two ports.
    const unready: string[] = [];
    const probe = async (name: string, check: (signal: AbortSignal) => unknown): Promise<void> => {
      const ok = await bounded(startup.signal, async (signal) => (await check(signal)) === true).catch(() => false);
      if (!ok) unready.push(name);
    };
    const tenantAdmission = sessions.sessions.tenant?.admission;
    await probe('session_store', async (signal) => (await tx.sessionStore.get(absentKey, signal)) === undefined);
    await probe('session_mint', (signal) => tx.mintProbe(signal));
    await probe('tenant_admission', (signal) => (typeof tenantAdmission?.probe === 'function' ? tenantAdmission.probe(signal) : false));
    await probe('rate_limiter', (signal) => sessions.limits.limiter.probe(signal));
    await probe('customer_directory', (signal) => tx.readsProbe(signal));
    await probe('idempotency_store', (signal) => tx.idempotency?.store.probe(signal));
    await probe('command_transactions', (signal) => tx.transactions?.port.probe(signal));
    if (unready.length > 0) return await refuse('dependency_unready', unready);

    // 11. Listen — only now, and bounded like every step. A socket that binds after startup gave up on this step (a signal
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

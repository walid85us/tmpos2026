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
//    5. the migration ledger — exactly 001–015, clean, checksums pinned. Nothing is applied, rolled back or repaired;
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
// store route (the tenant boundary is not composed), no DEV, witness, diagnostic, bootstrap or migration route. Only the
// administrative host is served: every request but the probes must name SESSION_ADMIN_ORIGINS's one authority in Host, or
// it gets that same bounded 404 before the limiter is asked (app.ts `hosts`). X-Forwarded-Host is never read, so the real
// edge must route the administrative hostname to this entry alone and pass its Host through unaltered or reject any other
// (docs/phase-4/08 DA-9 — not proven here).
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
// configuration can select one; no testkit or fake is reachable from this file.
import { createHash, randomBytes } from 'node:crypto';
import { createApp, createBoundedServer, createReadinessState, parseServedHosts } from '../runtime/app.js';
import { parseTrustedProxies } from '../runtime/clientAddress.js';
import { loadConfig } from '../runtime/config.js';
import { parseKeyMaterial, sameKeyMaterial } from '../runtime/keyMaterial.js';
import { createLifecycle } from '../runtime/lifecycle.js';
import type { SignalSource } from '../runtime/lifecycle.js';
import { emitLog } from '../runtime/logging.js';
import type { LogSink } from '../runtime/logging.js';
import { parseRateLimitKey } from '../runtime/rateLimit.js';
import { normalizeOrigin } from '../runtime/requestSecurity.js';
import { EnforcementSetupError } from '../runtime/routes.js';
import { TENANT_DISPLAY_NAME_EVENTS } from '../runtime/tenantDisplayName.js';
import { TENANT_STATUS_EVENTS } from '../runtime/tenantStatus.js';
import { APP_DATABASE_URL_VAR, DATABASE_CA_CERT_VAR, SUPABASE_DATABASE_URL_VAR } from '../platform-identity/config.js';
import { classifyRuntimeDatabaseUrl } from '../platform-identity/databaseEndpoint.js';
import type { RuntimeDatabaseEndpoint } from '../platform-identity/databaseEndpoint.js';
import { DRIVER_TLS_ENV_VAR, assertCaCertificates, createRuntimeStoreClient } from '../platform-identity/db.js';
import { IdentityCompositionError, createRuntimeIdentityVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import type { FirebaseIdTokenVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import { ProductionCompositionError, composeProductionSessions } from '../composition/productionSessions.js';
import type { ProductionSessions } from '../composition/productionSessions.js';
import { TransactionCompositionError, composeProductionTransactions } from '../composition/productionTransactions.js';
import type { ProductionTransactions } from '../composition/productionTransactions.js';
import type { SupervisedPgClient } from '../persistence/supervisedPgClient.js';

// The listener and its bound address, typed through the runtime that owns the network modules (only server/runtime
// imports them).
type BoundServer = ReturnType<typeof createBoundedServer>;
type BoundAddress = Exclude<ReturnType<BoundServer['address']>, string | null>;

/** Each bounded startup step's deadline: above the driver's 10 s connect timeout, far below any orchestrator's start budget. */
export const STARTUP_STEP_DEADLINE_MS = 15_000;
/** The existing forced-shutdown deadline (lifecycle.ts): past it the process exits 1 whatever still hangs. */
export const SHUTDOWN_FORCE_TIMEOUT_MS = 10_000;

/** Why startup refused, as an operator reads it. Each carries bounded codes only. */
export type StartupFailure =
  | 'config_invalid'
  | 'database_tls_invalid'
  | 'database_unavailable'
  | 'database_login_unsafe'
  | 'migration_state_invalid'
  | 'composition_refused'
  | 'route_inventory_mismatch'
  | 'dependency_unready'
  | 'rate_limit_key_mismatch'
  | 'rate_limit_store_read_only'
  | 'rate_limit_store_unavailable'
  | 'rate_limit_probe_malformed'
  | 'listen_failed'
  | 'startup_failed';

/** One served route, as the runtime inventories it (app.locals.routes). */
export interface ServedRoute {
  readonly method: string;
  readonly path: string;
  readonly access: string;
  readonly body: string;
  readonly idempotency: string;
}

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
 * What the entry takes from outside its configuration: the process's external dependencies, never policy. Production's is
 * PRODUCTION_CONSTRUCTION; a disposable-database harness supplies its own. Nothing in the configuration selects one.
 */
export interface EntryConstruction {
  /** The kernel over the classified APP_DATABASE_URL endpoint. */
  readonly databaseClient: (endpoint: RuntimeDatabaseEndpoint) => SupervisedPgClient;
  /** The identity provider's token verification behind the Firebase adapter; the Firebase Admin SDK's when absent. */
  readonly tokenVerifier?: FirebaseIdTokenVerifier;
  /** Where to bind, given the configured PORT. */
  readonly listen: (port: number) => { readonly port: number; readonly host?: string };
}

/** The production construction: verified TLS over the sealed endpoint, the Firebase Admin SDK, PORT on every interface. */
export const PRODUCTION_CONSTRUCTION: EntryConstruction = Object.freeze({
  databaseClient: createRuntimeStoreClient,
  listen: (port: number) => Object.freeze({ port }),
});

export interface EntryOptions {
  /** The configuration: the process environment in production. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly construction: EntryConstruction;
  /** The signal source the lifecycle installs its handlers on: the process in production. */
  readonly proc: SignalSource;
  /** Ends the process: process.exit in production. Called at most once. */
  readonly exit: (code: number) => void;
  readonly log?: LogSink;
  /** The forced-shutdown deadline; SHUTDOWN_FORCE_TIMEOUT_MS unless a test shortens it. */
  readonly forceTimeoutMs?: number;
}

/** How startup ended. One interface, read by `outcome` (this repository compiles non-strict as well). */
export interface EntryResult {
  readonly outcome: 'listening' | 'refused' | 'interrupted';
  /** The refusal's category, when refused. */
  readonly failure: StartupFailure | null;
  /** The refusal's bounded codes. */
  readonly reasons: readonly string[];
  /** The bound address, when listening. */
  readonly address: BoundAddress | null;
  /** The served inventory, once composed. */
  readonly routes: readonly ServedRoute[];
}

/** One configuration refusal: the field and a bounded code, never the value. */
export interface EntryConfigError {
  readonly field: string;
  readonly code: string;
}

const present = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Whether the runtime's host allowlist accepts this authority — the same judgment createApp makes of `hosts`. */
const servableHost = (host: string): boolean => {
  try {
    parseServedHosts([host]);
    return true;
  } catch (err) {
    if (!(err instanceof EnforcementSetupError)) throw err;
    return false;
  }
};

/** Verifies nothing: handed to the adapter only to run its configuration check, and never asked to verify. */
const CONFIGURATION_ONLY: FirebaseIdTokenVerifier = Object.freeze({
  verify: (): Promise<never> => Promise.reject(new Error('configuration check only')),
});

/**
 * Whether NODE_OPTIONS selects OpenSSL's trust store. Node reads it as whitespace-separated flags, drops double quotes
 * and backslash escapes anywhere in them, treats `_` in a flag name as `-`, and enables a boolean flag given any `=value`
 * (even `=false`). So every quote and backslash is removed first (single quotes too, erring toward refusal), and each
 * token's name before `=` is compared in that normal form; `--no-use-openssl-ca` and longer names do not match.
 */
const nodeOptionsUseOpensslCa = (options: string): boolean =>
  options
    .replace(/["'\\]/g, '')
    .replace(/_/g, '-')
    .split(/\s+/)
    .some((token) => token.split('=', 1)[0] === '--use-openssl-ca');

/**
 * Every configuration refusal, each as a field and a bounded code — [] when the configuration is complete. Pure: it reads
 * only the named keys of `env`, contacts nothing and constructs no client, listener or provider app.
 */
export function validateEntryConfig(env: Readonly<Record<string, string | undefined>>): EntryConfigError[] {
  const errors: EntryConfigError[] = [];
  // NODE_ENV, PORT and the DEV action flags that must never be armed in production (config.ts).
  const base = loadConfig(env);
  errors.push(...base.errors);
  if (base.config !== undefined && !base.config.isProduction) errors.push({ field: 'NODE_ENV', code: 'env_not_production' });

  // The runtime database: the classified endpoint, its trust anchor, and no driver-level transport override.
  const endpoint = classifyRuntimeDatabaseUrl(env[APP_DATABASE_URL_VAR]);
  if (typeof endpoint === 'string') errors.push({ field: APP_DATABASE_URL_VAR, code: endpoint });
  const ca = env[DATABASE_CA_CERT_VAR];
  if (!present(ca) || ca.trim() === '') errors.push({ field: DATABASE_CA_CERT_VAR, code: 'database_ca_missing' });
  else {
    try {
      assertCaCertificates(ca.trim());
    } catch {
      errors.push({ field: DATABASE_CA_CERT_VAR, code: 'database_ca_invalid' });
    }
  }
  if (present(env[DRIVER_TLS_ENV_VAR])) errors.push({ field: DRIVER_TLS_ENV_VAR, code: 'driver_tls_override_forbidden' });

  // The two keyed-hash secrets: each well formed, and never the same key.
  const limiterKey = present(env.RATE_LIMIT_KEY) ? parseRateLimitKey(env.RATE_LIMIT_KEY) : null;
  if (!present(env.RATE_LIMIT_KEY)) errors.push({ field: 'RATE_LIMIT_KEY', code: 'rate_limit_key_missing' });
  else if (limiterKey === null) errors.push({ field: 'RATE_LIMIT_KEY', code: 'rate_limit_key_invalid' });
  const idempotencyKey = present(env.IDEMPOTENCY_KEY) ? parseKeyMaterial(env.IDEMPOTENCY_KEY) : null;
  if (!present(env.IDEMPOTENCY_KEY)) errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_missing' });
  else if (idempotencyKey === null) errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_invalid' });
  else if (limiterKey !== null && sameKeyMaterial(idempotencyKey, limiterKey)) errors.push({ field: 'IDEMPOTENCY_KEY', code: 'idempotency_key_shared' });

  // The trusted proxies: production always sits behind them, so `none` is refused like an absent list.
  const proxies = env.TRUSTED_PROXY_CIDRS;
  if (!present(proxies) || proxies === 'none') errors.push({ field: 'TRUSTED_PROXY_CIDRS', code: 'trusted_proxies_missing' });
  else {
    try {
      parseTrustedProxies(proxies.split(','));
    } catch (err) {
      if (!(err instanceof EnforcementSetupError)) throw err;
      errors.push({ field: 'TRUSTED_PROXY_CIDRS', code: 'trusted_proxies_invalid' });
    }
  }

  // The administrative origin: exactly one exact canonical https origin — the host the listener serves and the one origin
  // its unsafe requests may come from. No wildcard, no list, nothing normalized on the operator's behalf.
  const admin = env.SESSION_ADMIN_ORIGINS;
  if (!present(admin)) errors.push({ field: 'SESSION_ADMIN_ORIGINS', code: 'session_admin_origin_missing' });
  else if (admin.includes(',')) errors.push({ field: 'SESSION_ADMIN_ORIGINS', code: 'session_admin_origin_not_single' });
  else if (normalizeOrigin(admin) !== admin || !admin.startsWith('https://') || !servableHost(new URL(admin).host)) {
    errors.push({ field: 'SESSION_ADMIN_ORIGINS', code: 'session_admin_origin_invalid' });
  }

  // The identity provider: the Firebase adapter's own configuration check, verifying nothing and building no provider app.
  try {
    createRuntimeIdentityVerifier(env, { verifier: CONFIGURATION_ONLY });
  } catch (err) {
    if (!(err instanceof IdentityCompositionError)) throw err;
    errors.push({ field: 'FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON', code: 'identity_verifier_unconfigured' });
  }
  // Process-wide switches the Firebase Admin SDK and Node's TLS read from the environment themselves, past every check
  // above: the emulator host makes the SDK accept unsigned tokens, and the TLS switch stops it verifying the provider's
  // certificates. Production sets neither.
  if (present(env.FIREBASE_AUTH_EMULATOR_HOST)) errors.push({ field: 'FIREBASE_AUTH_EMULATOR_HOST', code: 'identity_emulator_forbidden' });
  if (present(env.NODE_TLS_REJECT_UNAUTHORIZED)) errors.push({ field: 'NODE_TLS_REJECT_UNAUTHORIZED', code: 'tls_verification_override_forbidden' });
  // The trust store those provider calls verify against: extra roots, or OpenSSL's own store (and with it SSL_CERT_FILE /
  // SSL_CERT_DIR, which matter only then). The database is unaffected — its client passes an explicit `ca`.
  if (present(env.NODE_EXTRA_CA_CERTS)) errors.push({ field: 'NODE_EXTRA_CA_CERTS', code: 'tls_trust_store_override_forbidden' });
  if (present(env.NODE_OPTIONS) && nodeOptionsUseOpensslCa(env.NODE_OPTIONS)) {
    errors.push({ field: 'NODE_OPTIONS', code: 'tls_trust_store_override_forbidden' });
  }

  // The owner/migration principal (bypasses RLS) and the provider's service-role key: the process holds the runtime login
  // alone, and the least-privilege preflight judges APP_DATABASE_URL only — so neither may sit beside it.
  for (const field of [SUPABASE_DATABASE_URL_VAR, 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (present(env[field])) errors.push({ field, code: 'owner_credential_forbidden' });
  }
  return errors;
}

/** The composed table in a canonical order, for comparison with SHIPPING_ROUTES. */
const canonicalRoutes = (routes: readonly ServedRoute[]): string =>
  JSON.stringify(routes.map((r) => [r.method, r.path, r.access, r.body, r.idempotency])
    .sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`)));

/** Whether a served table is exactly SHIPPING_ROUTES — every route, attribute for attribute, and nothing else. */
export const servesExactlyShippingRoutes = (routes: readonly ServedRoute[]): boolean =>
  canonicalRoutes(routes) === canonicalRoutes(SHIPPING_ROUTES);

/** The log's cap on one field (logging.ts MAX_VALUE_LEN): a refusal's codes are split across lines rather than cut. */
const REFUSAL_LINE_MAX = 200;

/** `category` or `category:code,code,...`, as many lines as the codes need, none longer than the log keeps. */
function refusalLines(failure: StartupFailure, reasons: readonly string[]): string[] {
  const lines: string[] = [];
  let line: string = failure;
  let separator = ':';
  for (const code of reasons) {
    if (line.length + separator.length + code.length > REFUSAL_LINE_MAX && separator === ',') {
      lines.push(line);
      line = failure;
      separator = ':';
    }
    line += separator + code;
    separator = ',';
  }
  lines.push(line);
  return lines;
}

/** A startup step abandoned: its deadline passed, or a signal asked the process to stop. Carries nothing. */
class StepAbandoned extends Error {}

/** `work` bounded by STARTUP_STEP_DEADLINE_MS and by `stop`; it answers the moment either ends, whatever `work` does. */
async function bounded<T>(stop: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const step = new AbortController();
  const abandon = (): void => step.abort();
  const timer = setTimeout(abandon, STARTUP_STEP_DEADLINE_MS);
  const abandoned = new Promise<never>((_resolve, reject) => {
    step.signal.addEventListener('abort', () => reject(new StepAbandoned()), { once: true });
  });
  abandoned.catch(() => undefined); // raced below or never needed: never an unhandled rejection
  stop.addEventListener('abort', abandon, { once: true });
  try {
    if (stop.aborted) throw new StepAbandoned();
    return await Promise.race([Promise.resolve().then(() => work(step.signal)), abandoned]);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', abandon);
  }
}

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

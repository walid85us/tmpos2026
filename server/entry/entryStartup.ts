// M7A-CUSTOMERS-P2 — what the two deployable entries share: the administrative entry (productionEntry.ts) and the tenant
// entry (tenantEntry.ts) each start through these, so neither judges its common configuration, bounds a startup step,
// words a refusal or compares a served table differently from the other.
//
// Moved here unchanged from productionEntry.ts (M6-ENTRY-P1), where every rule below was specified: the configuration both
// entries need (validateCommonEntryConfig), the construction boundary and PRODUCTION_CONSTRUCTION, the step deadline and
// its bound, the refusal lines and the served-table comparison. It names no route, audience, session boundary or transaction
// root: each entry composes its own, so neither executable ships the other's. Importing it opens nothing and reads no
// configuration.
import { parseServedHosts } from '../runtime/app.js';
import type { createBoundedServer } from '../runtime/app.js';
import { parseTrustedProxies } from '../runtime/clientAddress.js';
import { loadConfig } from '../runtime/config.js';
import type { SignalSource } from '../runtime/lifecycle.js';
import type { LogSink } from '../runtime/logging.js';
import { parseRateLimitKey } from '../runtime/rateLimit.js';
import { normalizeOrigin } from '../runtime/requestSecurity.js';
import { EnforcementSetupError } from '../runtime/routes.js';
import { APP_DATABASE_URL_VAR, DATABASE_CA_CERT_VAR, SUPABASE_DATABASE_URL_VAR } from '../platform-identity/config.js';
import { classifyRuntimeDatabaseUrl } from '../platform-identity/databaseEndpoint.js';
import type { RuntimeDatabaseEndpoint } from '../platform-identity/databaseEndpoint.js';
import { DRIVER_TLS_ENV_VAR, assertCaCertificates, createRuntimeStoreClient } from '../platform-identity/db.js';
import { IdentityCompositionError, createRuntimeIdentityVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import type { FirebaseIdTokenVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import type { SupervisedPgClient } from '../persistence/supervisedPgClient.js';

// The listener and its bound address, typed through the runtime that owns the network modules (only server/runtime
// imports them).
export type BoundServer = ReturnType<typeof createBoundedServer>;
export type BoundAddress = Exclude<ReturnType<BoundServer['address']>, string | null>;

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
  /** The tenant entry alone: a setting would log a bound parameter (postgresStartupPreflight.ts evaluateParameterLogging). */
  | 'database_logging_unsafe'
  | 'composition_refused'
  | 'route_inventory_mismatch'
  /** The tenant entry alone: the database holds no issuer key, another one, or answers the probe out of shape. */
  | 'tenant_issuer_key_absent'
  | 'tenant_issuer_key_mismatch'
  | 'tenant_issuer_key_probe_malformed'
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

/**
 * What an entry takes from outside its configuration: the process's external dependencies, never policy. Production's is
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

export const present = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Whether the runtime's host allowlist accepts this authority — the same judgment createApp makes of `hosts`. */
export const servableHost = (host: string): boolean => {
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
 * Every configuration refusal both entries share, each as a field and a bounded code — [] when that part is complete. Pure:
 * it reads only the named keys of `env`, contacts nothing and constructs no client, listener or provider app. Each entry
 * adds its own: the administrative entry its command secret and the refusal of the tenant's minting key, the tenant entry
 * its origin and its minting key.
 */
export function validateCommonEntryConfig(env: Readonly<Record<string, string | undefined>>): EntryConfigError[] {
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

  // The limiter's keyed-hash secret, well formed. Every process serving the same database holds the same one: migration 014
  // keeps one fingerprint per database.
  if (!present(env.RATE_LIMIT_KEY)) errors.push({ field: 'RATE_LIMIT_KEY', code: 'rate_limit_key_missing' });
  else if (parseRateLimitKey(env.RATE_LIMIT_KEY) === null) errors.push({ field: 'RATE_LIMIT_KEY', code: 'rate_limit_key_invalid' });

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

  // The administrative origin: exactly one exact canonical https origin — the host the administrative listener serves and
  // the one origin its unsafe requests may come from, and the host the tenant listener's must differ from. No wildcard, no
  // list, nothing normalized on the operator's behalf.
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

/** A composed table in a canonical order, for comparison with an entry's shipping inventory. */
export const canonicalRoutes = (routes: readonly ServedRoute[]): string =>
  JSON.stringify(routes.map((r) => [r.method, r.path, r.access, r.body, r.idempotency])
    .sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`)));

/** The log's cap on one field (logging.ts MAX_VALUE_LEN): a refusal's codes are split across lines rather than cut. */
const REFUSAL_LINE_MAX = 200;

/** `category` or `category:code,code,...`, as many lines as the codes need, none longer than the log keeps. */
export function refusalLines(failure: StartupFailure, reasons: readonly string[]): string[] {
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
export async function bounded<T>(stop: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

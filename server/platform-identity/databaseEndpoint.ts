// Phase 4.0 M6-PG-P7-R1 — the runtime database endpoint: which APP_DATABASE_URL values the M6 store may connect through.
//
// Why a classification at all. The store's transaction kernel resets each connection's session (DISCARD ALL) before another
// transaction may use it (server/persistence/supervisedPgClient.ts; docs/phase-4/08 DA-21). That reset is sound only while one
// application connection stays one backend session — a direct PostgreSQL connection, or a SESSION-mode pooler. Behind a
// TRANSACTION-mode pooler a connection is lent a backend per transaction, so the reset, and the next transaction, could reach a
// different backend from the one the previous transaction left its session state on. The endpoint is therefore decided here,
// from the URL text alone, before any client exists: nothing below resolves a name, opens a socket, starts TLS or sends SQL.
//
// Which grammar. Not a new reading of a connection string: the repository's governed endpoint rules are the managed endpoint
// validator's in server/platform-identity/migrationExecutor.ts (assertManagedDevDsn), which classifies a host WHOLE and EXACTLY
// as the provider's documented direct database host or its shared session pooler, refuses a `db.`-claiming host that is not
// the exact direct form, admits only port 5432 (6543 is the transaction pooler, shared and dedicated alike) and refuses a
// query parameter that declares pooling. That file is frozen with the managed migration-005 path and is migration authority,
// which runtime composition may not import, so its rules are restated here, once, for the runtime — and
// databaseEndpoint.test.ts binds the two: every pattern's text equal, and both validators agreeing over one corpus.
//
// Stricter where the runtime needs it. There is no project-url corroboration (that is the migration boundary's), so the URL
// must be consistent with itself: a pooler username must carry the project reference in the provider's `<role>.<ref>` form —
// taken as configured, never built from a reference — and a direct host's reference must agree with a username that carries
// one. And the URL may carry no query parameter or fragment at all: transport and session options are the repository's, and
// a parameter the driver never receives would only mislead.
//
// What leaves. A refusal is one of three bounded codes, never the URL or any part of it. An accepted URL becomes a frozen
// handle naming only its endpoint family; the routing values and the credential are sealed in a module-private map and read
// once, by the database-client boundary (db.ts), which hands them to the driver as explicit options — so the driver never
// parses the string either, and the validator and the driver cannot disagree about where the connection goes.

/** Why APP_DATABASE_URL is refused. Bounded: never the URL, a username, a host, a reference, a query value or a password. */
export type RuntimeDatabaseRefusal = 'app_database_url_missing' | 'app_database_url_invalid' | 'app_database_endpoint_unsupported';

/** A classified runtime endpoint. Carries NO credential and NO routing value — only the endpoint family. */
export interface RuntimeDatabaseEndpoint {
  readonly kind: 'runtime_database_endpoint';
  readonly family: 'direct' | 'session_pooler';
}

/** The sealed connection authority of a classified endpoint: every value that decides where, as whom and to which database. */
export interface RuntimeDatabaseTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** Held once, never described, never logged. */
  readonly password: string;
  /** The URL without its credentials, for the shared transport policy's downgrade check only — never a routing input. */
  readonly tlsPolicySource: string;
}

/** A canonical ASCII DNS label: alphanumeric at both ends, hyphens only inside (migrationExecutor.ts DNS_LABEL). */
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** The provider project reference (migrationExecutor.ts PROJECT_REF). */
const PROJECT_REF = '[a-z0-9]{16,}';

/** The governed endpoint grammar, restated from migrationExecutor.ts; databaseEndpoint.test.ts proves each text equal. */
export const ENDPOINT_GRAMMAR = Object.freeze({
  DNS_LABEL,
  PROJECT_REF,
  /** The shared session pooler host: exactly one label before `pooler.supabase.com`. */
  POOLER_HOST: new RegExp(`^${DNS_LABEL}\\.pooler\\.supabase\\.com$`, 'i'),
  /** The direct database host, matched whole: `db.<ref>.supabase.co`. */
  DB_HOST_REF: new RegExp(`^db\\.(${PROJECT_REF})\\.supabase\\.co$`, 'i'),
  /** A first label `db` claims the direct host: anything else so named is refused, never read as a pooler. */
  DB_HOST_CLAIM: /^db\./i,
  /** The pooler username, `<role>.<ref>`. */
  USER_REF: new RegExp(`^[a-z0-9_]+\\.(${PROJECT_REF})$`, 'i'),
  /** A role name: no empty value (the driver would fall back to an ambient one) and no NUL (startup-parameter injection). */
  ROLE: /^[a-z0-9_][a-z0-9_.-]{0,62}$/i,
  /** The one port a session-mode endpoint listens on; 6543 is the transaction pooler. */
  SESSION_PORTS: Object.freeze(['5432']),
  /** Query parameters that declare pooling, each with the values that do. */
  POOL_PARAMS: Object.freeze([
    Object.freeze(['pgbouncer', (v: string): boolean => v !== 'false'] as const),
    Object.freeze(['pool_mode', (v: string): boolean => v !== 'session'] as const),
  ]),
});

/** A database name the runtime addresses: one identifier-shaped segment, never empty (the driver would default one). */
const DATABASE_NAME = /^[a-z0-9_][a-z0-9_$-]{0,62}$/i;
/** Query parameters that would choose where a connection goes (libpq's), refused as an endpoint rather than as noise. */
const ROUTING_PARAMS: ReadonlySet<string> = new Set(['host', 'hostaddr', 'port']);

const TARGETS = new WeakMap<RuntimeDatabaseEndpoint, RuntimeDatabaseTarget>();

/**
 * Classify APP_DATABASE_URL's value: a handle for a direct or session-pooler endpoint on port 5432, or why it is refused.
 * Pure: reads nothing but its argument and contacts nothing.
 */
export function classifyRuntimeDatabaseUrl(raw: unknown): RuntimeDatabaseEndpoint | RuntimeDatabaseRefusal {
  if (raw === undefined || raw === null || raw === '') return 'app_database_url_missing';
  // Judged as written, never as a URL parser would normalise it: a space or control character anywhere — a tab inside the host,
  // a trailing newline — is refused rather than silently stripped.
  if (typeof raw !== 'string' || /[\x00-\x20\x7f]/.test(raw)) return 'app_database_url_invalid';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'app_database_url_invalid';
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return 'app_database_url_invalid';

  // The endpoint first, so no later check can mask where the connection would go.
  const { POOLER_HOST, DB_HOST_REF, DB_HOST_CLAIM, USER_REF, ROLE, SESSION_PORTS, POOL_PARAMS } = ENDPOINT_GRAMMAR;
  const host = url.hostname.toLowerCase();
  if (DB_HOST_CLAIM.test(host) && !DB_HOST_REF.test(host)) return 'app_database_endpoint_unsupported';
  const family = DB_HOST_REF.test(host) ? 'direct' : POOLER_HOST.test(host) ? 'session_pooler' : null;
  if (family === null) return 'app_database_endpoint_unsupported';
  const port = url.port === '' ? '5432' : url.port;
  if (!SESSION_PORTS.includes(port)) return 'app_database_endpoint_unsupported';
  for (const [key, value] of url.searchParams) {
    if (ROUTING_PARAMS.has(key)) return 'app_database_endpoint_unsupported';
    if (POOL_PARAMS.some(([param, isPooled]) => param === key && isPooled(value))) return 'app_database_endpoint_unsupported';
  }
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(raw)) return 'app_database_url_invalid';
  // The authority exactly as written: one `@` — with two, URL parsers disagree about where the credential ends and the host
  // begins — then the classified host with no port or the literal `:5432`, never `:05432` or an empty `:`, which a URL parser
  // would normalise to the same endpoint.
  const authority = raw.slice(raw.indexOf('//') + 2).split('/')[0].split('@');
  const hostPort = authority.length === 2 ? authority[1].toLowerCase() : null;
  if (hostPort !== host && hostPort !== `${host}:5432`) return 'app_database_url_invalid';

  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return 'app_database_url_invalid';
  }
  if (!ROLE.test(user) || password === '' || password.includes('\0') || !DATABASE_NAME.test(database)) return 'app_database_url_invalid';

  // One URL, one project: the pooler routes by the username's reference, the direct host carries its own.
  const userRef = USER_REF.exec(user)?.[1].toLowerCase() ?? null;
  if (family === 'session_pooler' && userRef === null) return 'app_database_url_invalid';
  const hostRef = DB_HOST_REF.exec(host)?.[1].toLowerCase() ?? null;
  if (userRef !== null && hostRef !== null && userRef !== hostRef) return 'app_database_url_invalid';

  const policy = new URL(raw);
  policy.username = '';
  policy.password = '';
  const endpoint: RuntimeDatabaseEndpoint = Object.freeze({ kind: 'runtime_database_endpoint' as const, family });
  TARGETS.set(endpoint, Object.freeze({ host, port: Number(port), database, user, password, tlsPolicySource: policy.toString() }));
  return endpoint;
}

/**
 * The sealed target of a classified endpoint. For the database-client boundary (db.ts) alone, which hands it to the driver;
 * never a description, and never logged. A handle this module did not classify is refused.
 */
export function sealedRuntimeTarget(endpoint: RuntimeDatabaseEndpoint): RuntimeDatabaseTarget {
  const target = TARGETS.get(endpoint);
  if (target === undefined) throw new TypeError('runtime database endpoint invalid');
  return target;
}

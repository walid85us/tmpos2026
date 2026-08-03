// Phase 1.5 M1 — Platform Identity: server-side-only Postgres connection helper.
// Phase 4.0 M3 S2 — database principal separation + transaction-local tenant/store context.
//
// SECURITY:
//   - Server-side only. NEVER imported by `src/` (client). No connection string is ever
//     logged, returned, or placed in an error message; errors name the VARIABLE only.
//   - TWO principals, two variables, no fallback between them:
//       * getDb()        SUPABASE_DATABASE_URL — the migration/admin principal. It
//                        authenticates as the table OWNER, which BYPASSES Row-Level Security.
//                        Every existing DEV/admin caller uses this and is unchanged by S2.
//       * getRuntimeDb() APP_DATABASE_URL — the tenant-runtime principal. A non-owner role
//                        bound by the migration-005 policies. NO caller uses it yet: S2 builds
//                        the seam, the cutover is a later milestone, and that is precisely why
//                        gate G-DBROLE remains open.
//     A missing APP_DATABASE_URL must NEVER quietly resolve to the owner URL — that would run
//     the tenant request path with RLS bypassed, which is the exact failure S2 exists to make
//     impossible.
//
// Both clients are created lazily (on first use), so importing this module — or running the
// isolated API with the feature flag OFF — opens no connection and requires no secret.

import postgres from 'postgres';
import {
  getRequiredServerConfig,
  getRuntimePrincipalConfig,
  getDatabaseCaConfig,
  SUPABASE_DATABASE_URL_VAR,
  APP_DATABASE_URL_VAR,
  DATABASE_CA_CERT_VAR,
} from './config';

type Sql = ReturnType<typeof postgres>;

/**
 * Server-side bounds, sent as startup parameters and enforced by PostgreSQL itself.
 *
 * A client-side timeout only stops THIS process waiting; it sends no cancel request, and the
 * server does not notice a departed client while it is blocked. Without these, one runaway
 * statement or one abandoned transaction holds its locks until the backend is killed by hand.
 * Both principals carry the same bounds: the admin path is no more entitled to hold a lock
 * forever than the runtime path is.
 */
export const DB_SESSION_BOUNDS = Object.freeze({
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 15_000,
});

/**
 * The transaction-local settings the migration-005 policies read. Exported so the context
 * writer, the context reader, and the tests all name them once.
 */
export const CONTEXT_SETTINGS = Object.freeze({
  scopeType: 'app.scope_type',
  tenantId: 'app.tenant_id',
  storeId: 'app.store_id',
});

export type ScopeType = 'platform' | 'tenant' | 'store';

/** The `{scope_type, tenant_id, store_id?}` contract, mirroring the database scope shape. */
export interface TenantContext {
  scopeType: ScopeType;
  tenantId?: string | null;
  storeId?: string | null;
}

/** The tagged-template shape a postgres.js transaction handle presents. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** Anything that can open a transaction and hand back a tagged-template handle. */
export interface TransactionCapable {
  begin(fn: (tx: SqlTag) => Promise<unknown>): Promise<unknown>;
}

// --- transport policy (Phase 4.0 M3 S4.1a) ----------------------------------
//
// The previous policy was `ssl: 'require'`. In the installed driver that string does NOT mean
// "verified TLS": postgres.js maps 'require' | 'allow' | 'prefer' to rejectUnauthorized:false,
// so the connection was encrypted and then accepted ANY certificate. That defeats a passive
// eavesdropper and nothing else — an active attacker who can answer for the endpoint (DNS,
// routing, a hijacked pooler address) presents any certificate at all, the client accepts it,
// and the very first packet after the handshake carries the database password.
//
// The policy below is therefore an explicit TLS options OBJECT, never a string: a pinned CA,
// chain verification ON, and hostname verification left to Node's default `checkServerIdentity`
// — which is why nothing here sets that field. It is resolved BEFORE the driver is called, so a
// configuration that cannot be verified produces no client at all rather than an unverified one.

/**
 * The environment variable the driver consults as a fallback for the `ssl` option.
 *
 * postgres.js resolves each option as `explicit ?? url query ?? env['PG' + KEY] ?? default`, so
 * a value here can select transport security from entirely outside the repository. The explicit
 * object below already outranks it, but silently outranking an operator who believes they have
 * configured TLS is its own failure: the refusal is what makes the conflict visible.
 */
export const DRIVER_TLS_ENV_VAR = 'PGSSL';

/** DSN query keys the installed driver resolves into its `ssl` option. Verified against 3.4.9. */
const TLS_URL_KEYS = Object.freeze(['ssl', 'sslmode']);

/**
 * Values that select a weaker transport in the installed driver.
 *
 * 'disable' and 'false' resolve to PLAINTEXT; 'require', 'allow' and 'prefer' resolve to TLS
 * with certificate verification switched off. Exactly these five — the set is the driver's, not
 * a guess, and it is matched case-insensitively because the driver does not normalise case.
 */
const TLS_DOWNGRADE_VALUES = Object.freeze(['require', 'allow', 'prefer', 'disable', 'false']);

/** The repository-owned TLS options. `rejectUnauthorized` is `true` by type, not by convention. */
export interface DatabaseTlsOptions {
  readonly ca: string;
  readonly rejectUnauthorized: true;
}

/**
 * One complete PEM CERTIFICATE block, capturing its body.
 *
 * DELIBERATELY STRUCTURAL, NOT A FULL X.509 PARSE. Parsing every certificate with
 * `crypto.X509Certificate` would be stronger, but it needs a genuine certificate as the
 * success-path fixture and this slice may not generate certificate material. What matters is
 * that the security property does not rest on this check: a structurally-valid-but-bogus CA was
 * measured against a real TLS handshake, and Node loads ZERO trust anchors from it — the
 * handshake then FAILS ("self-signed certificate") with no fallback to the bundled root store.
 * So this is not what stands between an attacker and the connection; it exists to refuse the two
 * shapes an operator actually produces — an empty block from a truncated copy-paste, and a file
 * path or non-PEM blob pasted where PEM was expected — HERE, with a bounded message, instead of
 * hours later as an opaque driver-level TLS error. A real parse is a follow-up, not a gap.
 */
const PEM_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_END = '-----END CERTIFICATE-----';
/** The base64 alphabet with optional padding. An empty body is not certificate material. */
const PEM_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * True when `ca` holds at least one PEM CERTIFICATE block with a well-formed base64 body.
 *
 * Scanned with indexOf rather than a regex ON PURPOSE. The obvious pattern —
 * `/BEGIN([\s\S]*?)END/g` — is QUADRATIC on input that repeats BEGIN without ever supplying END:
 * every BEGIN restarts a lazy scan that runs to the end of the string. Measured on this build,
 * 200/400/800 repeats cost 0.6/2.7/9.9 ms — doubling the input roughly quadrupled the time. The
 * value is operator-supplied and read once, so this is a self-inflicted startup stall rather than
 * a remote hazard, but a linear scan costs nothing and removes the shape entirely.
 */
function hasPemCertificate(ca: string): boolean {
  let from = 0;
  for (;;) {
    const begin = ca.indexOf(PEM_BEGIN, from);
    if (begin === -1) return false;
    const bodyStart = begin + PEM_BEGIN.length;
    const end = ca.indexOf(PEM_END, bodyStart);
    if (end === -1) return false; // a BEGIN with no closing END is a truncated paste
    const body = ca.slice(bodyStart, end).replace(/\s+/g, '');
    // Length %4 is a property of every real base64 body; requiring it rejects the truncated
    // bodies that a delimiter-only check would wave through.
    if (body.length > 0 && body.length % 4 === 0 && PEM_BODY.test(body)) return true;
    from = end + PEM_END.length;
  }
}

/**
 * A bounded refusal. It names the configuration CATEGORY at fault and never its value — no DSN,
 * no password, no certificate body — because these messages reach logs and operator terminals.
 */
function tlsRefusal(reason: string): Error {
  return new Error(`refusing to open a database connection: ${reason}`);
}

/**
 * Resolve the verified-TLS options for `rawUrl`, or throw before any client can be built.
 *
 * Order matters and is deliberate: the two configuration-level checks run BEFORE the URL is even
 * parsed, so a refusal is never pre-empted by the driver's own `Invalid URL`. Nothing here
 * mutates or deletes an environment variable — a process-wide edit would be invisible to every
 * other consumer in the process and would "fix" the symptom by hiding it.
 */
export function resolveDatabaseTls(rawUrl: string): DatabaseTlsOptions {
  // 1. An explicit trust anchor. Falling back to the platform trust store here would succeed in
  //    most environments, which is precisely what makes it dangerous: a private CA that was
  //    never configured would go unnoticed until an endpoint changed hands.
  const configured = getDatabaseCaConfig();
  if (!configured) {
    throw tlsRefusal(`${DATABASE_CA_CERT_VAR} is not configured, and no default trust store may stand in for it`);
  }
  if (!hasPemCertificate(configured.ca)) {
    throw tlsRefusal(`${DATABASE_CA_CERT_VAR} does not contain PEM certificate material`);
  }

  // 2. The driver's environment fallback.
  // `!== ''` and NOT `.trim() !== ''`: the driver resolves this fallback as `env[KEY] || default`,
  // so the empty string alone falls through to the default while a whitespace-only value is
  // TRUTHY and really does become `options.ssl` (measured: PGSSL="   " resolves to ssl:"   ").
  // Trimming here would permit exactly the values the driver would honour.
  const ambient = process.env[DRIVER_TLS_ENV_VAR];
  if (typeof ambient === 'string' && ambient !== '') {
    throw tlsRefusal(`${DRIVER_TLS_ENV_VAR} must not select transport security — this repository owns that decision`);
  }

  // 3. The DSN's own TLS inputs.
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // The unparsable value is a connection string and is NOT echoed.
    throw tlsRefusal(`${SUPABASE_DATABASE_URL_VAR}/${APP_DATABASE_URL_VAR} is not a parsable URL`);
  }
  for (const key of TLS_URL_KEYS) {
    for (const value of url.searchParams.getAll(key)) {
      if (TLS_DOWNGRADE_VALUES.includes(value.trim().toLowerCase())) {
        // The KEY is one of two fixed literals; the VALUE is operator input and stays out.
        throw tlsRefusal(`the database URL selects a weaker transport through '${key}'`);
      }
    }
  }

  // A fresh object per call, frozen: the two principals must never share one options object, and
  // the resolved policy must not be editable through `client.options.ssl` after the fact — the
  // driver connects lazily, so there is a real window between construction and the handshake.
  return Object.freeze({ ca: configured.ca, rejectUnauthorized: true });
}

/**
 * Shared client options — everything EXCEPT transport.
 *
 * Transport is resolved separately, at each construction site, by resolveDatabaseTls(). Keeping
 * it out of here is what lets the disposable-PostgreSQL lanes reuse these options for a
 * task-owned socket or a plaintext loopback service while supplying their own `ssl: false` at
 * the call site. Folding the policy in would fail those lanes closed for want of a CA that their
 * endpoints could never present — and the alternative, inferring plaintext from the endpoint
 * shape, is exactly the heuristic this slice exists to remove: postgres.js resolves the endpoint
 * from the `host` OPTION, so `postgres:///db?host=/run/pg` only LOOKS like a Unix socket and
 * actually dials localhost over TCP, and a pooler sidecar on 127.0.0.1 still carries credentials
 * over a socket someone else can bind.
 *
 * `prepare: false` is required by a transaction-mode pooler.
 */
function clientOptions(max: number) {
  return {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: { ...DB_SESSION_BOUNDS },
  };
}

/** Request paths need more concurrency than the admin path's 3. */
const RUNTIME_POOL_MAX = 10;

/**
 * The runtime principal's non-transport options, for a caller that supplies its own transport.
 *
 * getRuntimeDb() addresses an endpoint by URL, which cannot name a Unix socket — postgres.js
 * derives the socket path from the `host` OPTION, and silently ignores a `?host=` query
 * parameter. The disposable-PostgreSQL proof therefore builds its own client, and takes the
 * runtime principal's configuration from HERE rather than restating it: a copied constant would
 * drift from the real one and the proof would quietly stop proving anything.
 *
 * `rawUrl` is accepted and unused so this stays a drop-in for those call sites.
 */
export function runtimeClientOptions(_rawUrl: string) {
  return clientOptions(RUNTIME_POOL_MAX);
}

let adminSql: Sql | null = null;
let runtimeSql: Sql | null = null;

/**
 * The MIGRATION/ADMIN client, created on first use. Throws a non-sensitive error if
 * SUPABASE_DATABASE_URL is not configured — the message contains the variable NAME only.
 */
export function getDb(): Sql {
  if (adminSql) return adminSql;
  const cfg = getRequiredServerConfig();
  if (!cfg) {
    throw new Error(`${SUPABASE_DATABASE_URL_VAR} is not configured (server-side secret missing).`);
  }
  // Resolved FIRST: an unverifiable configuration must produce no client, not an unverified one.
  const ssl = resolveDatabaseTls(cfg.databaseUrl);
  adminSql = postgres(cfg.databaseUrl, { ...clientOptions(3), ssl });
  return adminSql;
}

/**
 * The TENANT-RUNTIME client, created on first use. Throws when APP_DATABASE_URL is absent —
 * naming that variable and nothing else. It does NOT consult SUPABASE_DATABASE_URL, and the
 * error deliberately mentions no alternative, so neither the code nor an operator reading the
 * message is nudged towards the privileged URL.
 */
export function getRuntimeDb(): Sql {
  if (runtimeSql) return runtimeSql;
  const cfg = getRuntimePrincipalConfig();
  if (!cfg) {
    throw new Error(`${APP_DATABASE_URL_VAR} is not configured (runtime-principal secret missing).`);
  }
  const ssl = resolveDatabaseTls(cfg.databaseUrl);
  runtimeSql = postgres(cfg.databaseUrl, { ...runtimeClientOptions(cfg.databaseUrl), ssl });
  return runtimeSql;
}

/** Closes the shared admin client (used by scripts and graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (adminSql) {
    const s = adminSql;
    adminSql = null;
    await s.end({ timeout: 5 });
  }
}

/** Closes the shared runtime client. */
export async function closeRuntimeDb(): Promise<void> {
  if (runtimeSql) {
    const s = runtimeSql;
    runtimeSql = null;
    await s.end({ timeout: 5 });
  }
}

/**
 * Reject a context that could not be represented in the database.
 *
 * This mirrors user_membership_scope_consistency_chk (002) and audit_event_scope_consistency_chk
 * (005): platform carries neither id, tenant carries a tenant only, store carries both. Checked
 * BEFORE the transaction opens, so a malformed context can never leave a half-installed session.
 */
export function assertTenantContext(ctx: TenantContext): void {
  const tenant = ctx.tenantId ?? null;
  const store = ctx.storeId ?? null;
  const ok =
    (ctx.scopeType === 'platform' && tenant === null && store === null)
    || (ctx.scopeType === 'tenant' && tenant !== null && store === null)
    || (ctx.scopeType === 'store' && tenant !== null && store !== null);
  if (!ok) {
    // Scope ids are opaque uuids, not secrets, but there is no reason to echo them either.
    throw new Error(`invalid tenant context for scope '${String(ctx.scopeType)}'`);
  }
}

/**
 * Run `fn` inside ONE transaction with the tenant/store context installed transaction-locally.
 *
 * `set_config(name, value, true)` — the trailing `true` is `is_local`, so PostgreSQL discards
 * the setting when the transaction ends, on COMMIT and on ROLLBACK alike. That is the whole
 * mechanism: there is no cleanup step to forget, and a connection returned to the pool cannot
 * carry a previous borrower's tenant into the next request. A session-level `SET` would have
 * exactly that defect, which is why this module issues none.
 *
 * An absent scope id is written as the empty string rather than skipped — skipping it would
 * leave whatever an earlier statement in this transaction had set, and the policies map the
 * empty string to NULL, which denies.
 */
export async function withTenantContext<T>(
  db: TransactionCapable,
  ctx: TenantContext,
  fn: (tx: SqlTag) => Promise<T>,
): Promise<T> {
  assertTenantContext(ctx);
  return db.begin(async (tx) => {
    await tx`select set_config(${CONTEXT_SETTINGS.scopeType}, ${ctx.scopeType}, true)`;
    await tx`select set_config(${CONTEXT_SETTINGS.tenantId}, ${ctx.tenantId ?? ''}, true)`;
    await tx`select set_config(${CONTEXT_SETTINGS.storeId}, ${ctx.storeId ?? ''}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Read the context currently installed on `tx`, or null when there is none.
 *
 * Missing-safe in both directions, exactly as the policy predicates are: `current_setting(name,
 * true)` returns NULL instead of raising when the setting was never set, and `nullif(..., '')`
 * turns the absent-scope sentinel back into NULL.
 */
export async function readTenantContext(tx: SqlTag): Promise<TenantContext | null> {
  const rows = await tx`select
      nullif(current_setting(${CONTEXT_SETTINGS.scopeType}, true), '') as scope_type,
      nullif(current_setting(${CONTEXT_SETTINGS.tenantId}, true), '') as tenant_id,
      nullif(current_setting(${CONTEXT_SETTINGS.storeId}, true), '') as store_id`;
  const row = rows[0] as { scope_type: string | null; tenant_id: string | null; store_id: string | null } | undefined;
  if (!row || row.scope_type === null) return null;
  return {
    scopeType: row.scope_type as ScopeType,
    tenantId: row.tenant_id,
    storeId: row.store_id,
  };
}

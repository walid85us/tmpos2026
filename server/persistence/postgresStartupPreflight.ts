// Phase 4.0 M6-ENTRY-P1 — the deployable entry's database preflight: read-only questions the production entry asks the
// database, as the runtime login it will serve with, before it binds a listener (server/entry/productionEntry.ts).
//
// Four questions here, each one bounded read-only transaction on the transaction root's own kernel — never a write, never
// DDL, never a repair — and a fifth in the limiter adapter:
//   connect          — one trivial statement: the kernel reached the server through the transport its client was built with.
//                      The production client verifies TLS against DATABASE_CA_CERT (platform-identity/db.ts); the driver
//                      never falls back to plaintext when handed verified-TLS options, so a certificate it cannot verify, a
//                      server that refuses TLS, a refused credential and an unreachable endpoint all fail this question;
//   runtime login    — the connected login's standing, judged against the approved runtime boundary below;
//   migration ledger — public.schema_migrations exactly at REQUIRED_MIGRATIONS: 001–032, every row finished and clean, every
//                      checksum the one pinned here, nothing missing, nothing else;
//   parameter logging — (the tenant entry only, M7A-CUSTOMERS-P2) the settings the login's sessions run with would log no
//                      bound parameter — a session store key is one — through the setting-driven paths it can read:
//                      evaluateParameterLogging below. Not an error DETAIL, and nothing the login cannot read
//                      (shared_preload_libraries): those stay deployment checks (docs/phase-4/08 DA-102, DA-105);
//   rate-limit key   — postgresRateLimiter.ts probeRateLimitKey: migration 014 registers the key fingerprint when none is,
//                      and compares it otherwise. It never replaces one.
// Each answer is a list of bounded codes — never a role name, an object name, a ledger value or a driver message — and an
// empty list means the answer is safe. A question the database cannot answer throws; the entry reads that as unavailable.
//
// THE APPROVED RUNTIME BOUNDARY (the source of truth is migrations 005–032; docs/phase-4/08 G-DBROLE):
//   - the login: LOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION, NOBYPASSRLS; its session runs as itself (no role
//     switch, however a role default might ask for one); it owns nothing; its one direct privilege is SELECT on
//     public.schema_migrations, without grant option — the read the ledger question needs. No migration grants it: G-DBROLE
//     provisioning does, beside the two memberships;
//   - its memberships: exactly tmpos_app and tmpos_audit_writer (migration 005), each inherited and neither with ADMIN OPTION.
//     Those two are members of nothing — not even of each other — so the login reaches no other role, and no membership
//     option, by any path. Every membership is followed whatever its options: one granted WITH INHERIT FALSE, SET TRUE
//     reaches a role's privileges through SET ROLE, which the has_*_privilege functions do not report (doc 08 G-DBROLE), so
//     an unexpected one is refused however it is granted;
//   - those two roles: NOLOGIN and without any attribute above, each carrying migration 005's exact ownership marker, owning
//     nothing, and holding exactly the privileges and policy targets migrations 005–032 give them (APPROVED_ROLE_GRANTS), no
//     more and no fewer — a grant added beside the migrations is a privilege the runtime was never approved for. A policy
//     line carries its command, whether it is permissive, and whether its table still enforces row security, so a disabled
//     table or a widened command no longer matches;
//   - nothing in any other database of the cluster names the login or those roles;
//   - PUBLIC — which every login holds — has no privilege on a relation or column of the application's schemas (public and
//     tmpos_*), cannot execute a SECURITY DEFINER routine there, and is named by no policy there;
//   - no CREATE or TEMPORARY on the database and no CREATE on any schema, by any path, PUBLIC's included.
// Ownership and privilege mentions of a role are read from pg_shdepend, which records every object a role owns or is named
// in the ACL or a policy of, whatever the object's kind. PUBLIC is not a role and has no pg_shdepend rows, so its grants are
// read from the ACLs themselves. Membership options are read through to_jsonb so the same statement runs on a server without
// PostgreSQL 16's per-grant inherit option, where the member's own INHERIT attribute decides. The kernel runs every
// transaction with search_path pg_catalog, pg_temp, and every catalog name below is qualified besides.
// NOT RE-READ HERE: a policy's predicate, and PUBLIC's standing outside the application's schemas. The predicates are the
// ones migrations 005–032 created, proven at apply by the ledger checksums; a later change to one in place is schema drift
// this startup does not detect (docs/phase-4/08 G-DBROLE).
//
// PINNED, DELIBERATELY. REQUIRED_MIGRATIONS and APPROVED_ROLE_GRANTS change only with a new migration, in the same change;
// postgresStartupPreflight.test.ts binds the checksums to the migration files, and the disposable-database suite binds the
// grants to what the migrations produce. Importing this file connects to nothing and reads no configuration.
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/** A preflight statement reads catalogs and one small table: generous for a startup question, far below the step deadline. */
export const PREFLIGHT_BOUNDS: TransactionBounds = Object.freeze({ lock: '1000ms', statement: '5000ms', idle: '5000ms' });

/** The migration chain this entry is built against, with each up file's SHA-256 as the migration engine records it. */
export const REQUIRED_MIGRATIONS: readonly { readonly version: string; readonly checksum: string }[] = Object.freeze([
  { version: '001', checksum: 'f763a39943c519d8779afd354bac44ae4d8a0e26b36abcb2b8b19d27e8b1f305' },
  { version: '002', checksum: '98fa4c30e8bd97c57ef9e754aa9073556e749a0815a653a6e1cbb395895cf2e4' },
  { version: '003', checksum: '03757459a1774ea10494c5ffeeaa6950866ee6952c5e85fce9c6fbe49d3eed94' },
  { version: '004', checksum: 'a1cc9dad8092fe510c7745b92281d88617ab20af616e0e1942bfe808341d7bc6' },
  { version: '005', checksum: 'a4a61385beedf98194fb427bcd528704b068d7ca2947a9713d7a1a1c87157bda' },
  { version: '006', checksum: '091933e19559d1d109580dd86cd381ada12398fbe1a93b011ac97e15c23dc68c' },
  { version: '007', checksum: 'a3a9aa98b299cd343e35df6b9048ea1468f5b11668e7ea6996045cb514f7bcbe' },
  { version: '008', checksum: 'cfaa5724bd4b9bb1681f6a8633a282aa8dd3ea3ed3d3cf9a89a8e28d33a51d5e' },
  { version: '009', checksum: '032842618ee71ca1e523502a75d9824ea5c922236e03670defb99f0e0764b54c' },
  { version: '010', checksum: 'a3a2f41107df582826c20001a91edff569507582e1d90df6c339778b2fb8748b' },
  { version: '011', checksum: 'b3944f909c4298f700746784cd52385c5410acd3a15ad39f0a7138d5d6911c7d' },
  { version: '012', checksum: '6e71d4d5223576b86bd6acc46ed429bbcff64390d69a6d3980a3bc9baf3efce6' },
  { version: '013', checksum: 'c6df3d2e3559270243a52477c8acc9b8d7cca71c576acc00caf8d267a5151f7a' },
  { version: '014', checksum: '48ff3e4bc2b3d4c6ee3cc2c54e4111d8647669d349d1449b249303a9dcc4cf62' },
  { version: '015', checksum: 'a3b1514ee65703d29b3becf78ef338e8966eb0ee12550ecd5e1f19d357154f4e' },
  { version: '016', checksum: 'e5633336da5376a747d05aabac21b73ca9ebcf4743a9436081c58322ac07e9be' },
  { version: '017', checksum: '1fea57a1c4bdba7efdb5da0f34893879a6b8aa741c1f117b2dcf63259f85d66d' },
  { version: '018', checksum: 'e57c72b77e90bd6348e70c42912f073348c90a40e59e75e95c0b6689adc746cf' },
  { version: '019', checksum: '1d260ca4cc98fe3ee6df18403da16db4a21712c064d3c911b195980a0496e0e2' },
  { version: '020', checksum: '0a289ad4dcefdb4a5a260aed7a2121d93e23c5efe4f3550eb9fdc39094d9acfe' },
  { version: '021', checksum: '139a63b193e7c17c0b6770766eee6c3e70ba8b7bd0e65937cf3d7d05bd7b7876' },
  { version: '022', checksum: '0782d04f32e489611ab5e04e592fc7ded6d2a8cfd8b3ba0f824f5bae4dbc59e4' },
  { version: '023', checksum: '0e81bc627a681e0d999e24f04262a3fd8780c3736f80b170ac73ac6b13ca9a04' },
  { version: '024', checksum: '04272c40e863a82d9a1f71980da00e38494cd30df1ee90ae90cf02aad6fa35fb' },
  { version: '025', checksum: '85bb78a1332515bf2019f39b131b23f79f9c31ddc36f0be90ccc96ed896b08bd' },
  { version: '026', checksum: '62b1c69e16cf190bcd2ffe38a436dacb27d5de4c857adeb1b76b13207d2bdf5b' },
  { version: '027', checksum: 'ca06d7a01dded533155bf90a7f2e7414ac8364b5c704691a8f879a8b7babe487' },
  { version: '028', checksum: 'fa8f86eb0ccdf8b96d59b8664c76af2f72bd42dea1f3d393adc3a18f52f1afd0' },
  { version: '029', checksum: '34a4073fb494fe2ac8d81e2ca8b706b56ece70ea29073f88f1787f194ce780b2' },
  { version: '030', checksum: 'bf6d1f9b35e0b752ea04d02b462e23567ad1bed4a41cdefb149b6692aa9a5985' },
  { version: '031', checksum: '42eefc95795c296e75420ebca94bfc38c6bdb78f602f73f092f1aba2995041a6' },
  { version: '032', checksum: 'a4b29e3a1dcac8a2395dc995e8548eb1b85a730975e2ce87057d482c5926f76a' },
].map((m) => Object.freeze(m)));

/** The privilege roles migration 005 creates, each with the exact ownership marker it comments the role with. */
export const RUNTIME_PRIVILEGE_ROLES: Readonly<Record<string, string>> = Object.freeze({
  tmpos_app: 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:tenant-runtime',
  tmpos_audit_writer: 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:audit-append',
});

/** The login's one direct privilege, as a grant line (grantee omitted): SELECT on the ledger, without grant option. */
export const LEDGER_READ_GRANT = 'a|table|public.schema_migrations|SELECT';

/**
 * Every object whose ACL or policy names a privilege role after migrations 001–032, as `role|kind|type|identity|privileges`:
 * kind `a` is an ACL entry (the privileges it holds there, `+grant` marking a grant option), kind `r` a policy naming it
 * (its command, PERMISSIVE or RESTRICTIVE, and ROW SECURITY while its table enforces it).
 */
export const APPROVED_ROLE_GRANTS: readonly string[] = Object.freeze([
  'tmpos_app|a|function|tmpos_admission.m5_admit_platform_session(pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_command.m5_revalidate_platform_authority(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_command.m5_tenant_display_name_update_v2(pg_catalog.uuid,bigint,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_command.m5_tenant_status_change(pg_catalog.uuid,bigint,pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_customer_contact.m7a_contact_create(pg_catalog.text,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_customer_detail.m7a_customer_get(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid)|EXECUTE',
  'tmpos_app|a|function|tmpos_customer_edit.m7a_customer_profile(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid)|EXECUTE',
  'tmpos_app|a|function|tmpos_customer_edit.m7a_customer_update(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,bigint,pg_catalog.text,boolean,pg_catalog.text,boolean,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_customer_search.m7a_customer_search(pg_catalog.text,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,integer)|EXECUTE',
  'tmpos_app|a|function|tmpos_directory.m5_tenant_directory_page(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,integer)|EXECUTE',
  'tmpos_app|a|function|tmpos_identity.m5_resolve_principal(pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_identity.m5_revalidate_principal_context(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_command_enqueue(pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.text,pg_catalog.uuid,bigint,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.jsonb)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_command_fence(pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_idempotency_acquire(pg_catalog.text,pg_catalog.text,pg_catalog.text,bigint,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_idempotency_complete(pg_catalog.text,pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_outbox_acknowledge(pg_catalog.uuid,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_outbox_claim(pg_catalog.text,integer,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_outbox_dead_letter(pg_catalog.uuid,pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_outbox_retry(pg_catalog.uuid,pg_catalog.text,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_internal.m6_store_probe()|EXECUTE',
  'tmpos_app|a|function|tmpos_invoice_draft.m7b_invoice_draft_get(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)|EXECUTE',
  'tmpos_app|a|function|tmpos_invoice_draft.m7b_invoice_draft_page(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,integer)|EXECUTE',
  'tmpos_app|a|function|tmpos_invoice_edit.m7b_invoice_draft_create_v3(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.jsonb,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_invoice_edit.m7b_invoice_draft_update_v2(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,bigint,pg_catalog.uuid,pg_catalog.jsonb,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_mint.m7a_issuer_key_check(pg_catalog.bytea)|EXECUTE',
  'tmpos_app|a|function|tmpos_mint.m7a_session_create(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,bigint,bigint,bigint,bigint,bigint,pg_catalog.bytea)|EXECUTE',
  'tmpos_app|a|function|tmpos_rate_limit.m6_rate_limit_consume(pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text,integer,integer,integer)|EXECUTE',
  'tmpos_app|a|function|tmpos_rate_limit.m6_rate_limit_probe(pg_catalog.bytea)|EXECUTE',
  'tmpos_app|a|function|tmpos_rate_limit.m6_rate_limit_reclaim()|EXECUTE',
  'tmpos_app|a|function|tmpos_role.m7a_customer_page_v3(pg_catalog.text,pg_catalog.uuid,integer)|EXECUTE',
  'tmpos_app|a|function|tmpos_role.m7a_role_levels(pg_catalog.uuid,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_role_edit.m7a_role_level_set_v2(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_role_edit.m7a_role_level_states(pg_catalog.uuid)|EXECUTE',
  'tmpos_app|a|function|tmpos_role_invoice.m7a_invoice_role_level_set(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_role_invoice.m7a_invoice_role_level_states(pg_catalog.uuid)|EXECUTE',
  'tmpos_app|a|function|tmpos_session.m5_admit_tenant_session(pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_session.m5_admit_tenant_session_v2(pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_session.m5_hold_tenant_standing(pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_session.m5_session_get(pg_catalog.text,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_session.m5_session_revoke(pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_session.m5_session_revoke_principal(pg_catalog.text,pg_catalog.text)|EXECUTE',
  'tmpos_app|a|function|tmpos_session.m5_session_touch(pg_catalog.text,pg_catalog.text,bigint)|EXECUTE',
  'tmpos_app|a|function|tmpos_store_access.m7b_store_directory(pg_catalog.text)|EXECUTE',
  'tmpos_app|a|schema|public|USAGE',
  'tmpos_app|a|schema|tmpos_admission|USAGE',
  'tmpos_app|a|schema|tmpos_command|USAGE',
  'tmpos_app|a|schema|tmpos_customer|USAGE',
  'tmpos_app|a|schema|tmpos_customer_contact|USAGE',
  'tmpos_app|a|schema|tmpos_customer_detail|USAGE',
  'tmpos_app|a|schema|tmpos_customer_edit|USAGE',
  'tmpos_app|a|schema|tmpos_customer_search|USAGE',
  'tmpos_app|a|schema|tmpos_directory|USAGE',
  'tmpos_app|a|schema|tmpos_identity|USAGE',
  'tmpos_app|a|schema|tmpos_internal|USAGE',
  'tmpos_app|a|schema|tmpos_invoice_draft|USAGE',
  'tmpos_app|a|schema|tmpos_invoice_edit|USAGE',
  'tmpos_app|a|schema|tmpos_mint|USAGE',
  'tmpos_app|a|schema|tmpos_rate_limit|USAGE',
  'tmpos_app|a|schema|tmpos_role|USAGE',
  'tmpos_app|a|schema|tmpos_role_edit|USAGE',
  'tmpos_app|a|schema|tmpos_role_invoice|USAGE',
  'tmpos_app|a|schema|tmpos_session|USAGE',
  'tmpos_app|a|schema|tmpos_store_access|USAGE',
  'tmpos_app|a|table|public.store|INSERT,SELECT',
  'tmpos_app|a|table|public.tenant|SELECT',
  'tmpos_app|a|table|public.tenant_feature_entitlement|SELECT',
  'tmpos_app|a|table|public.user_membership|SELECT',
  'tmpos_app|a|table column|public.store.store_name|UPDATE',
  'tmpos_app|a|table column|public.tenant.legal_name|UPDATE',
  'tmpos_app|r|policy|tmpos_app_entitlement_scope on public.tenant_feature_entitlement|ALL,PERMISSIVE,ROW SECURITY',
  'tmpos_app|r|policy|tmpos_app_membership_scope on public.user_membership|ALL,PERMISSIVE,ROW SECURITY',
  'tmpos_app|r|policy|tmpos_app_store_scope on public.store|ALL,PERMISSIVE,ROW SECURITY',
  'tmpos_app|r|policy|tmpos_app_tenant_scope on public.tenant|ALL,PERMISSIVE,ROW SECURITY',
  'tmpos_audit_writer|a|schema|public|USAGE',
  'tmpos_audit_writer|a|table|public.audit_event|INSERT',
  'tmpos_audit_writer|r|policy|tmpos_audit_writer_append on public.audit_event|INSERT,PERMISSIVE,ROW SECURITY',
]);

/** Why the connected login is outside the approved runtime boundary. Bounded: never a role, object or privilege name. */
export type RuntimeLoginViolation =
  | 'login_unknown'
  | 'login_cannot_login'
  | 'login_superuser'
  | 'login_createrole'
  | 'login_createdb'
  | 'login_replication'
  | 'login_bypassrls'
  | 'login_role_switched'
  | 'login_owns_objects'
  | 'login_privilege_unexpected'
  | 'login_ledger_read_missing'
  | 'membership_missing'
  | 'membership_unexpected'
  | 'membership_admin_option'
  | 'membership_not_inherited'
  | 'role_attribute_unsafe'
  | 'role_marker_invalid'
  | 'role_membership_unexpected'
  | 'role_owns_objects'
  | 'role_privilege_unexpected'
  | 'role_privilege_missing'
  | 'foreign_database_dependency'
  | 'public_privilege_unexpected'
  | 'database_create_privilege'
  | 'database_temporary_privilege'
  | 'schema_create_privilege';

/** Why the migration ledger is not exactly the required chain. Bounded: never a version, checksum or other ledger value. */
export type LedgerViolation =
  | 'migration_ledger_missing'
  | 'migration_ledger_unreadable'
  | 'migration_ledger_malformed'
  | 'migration_missing'
  | 'migration_not_contiguous'
  | 'migration_unknown'
  | 'migration_dirty'
  | 'migration_checksum_mismatch';

/** Which setting would put a bound parameter in the server log. Bounded: a setting's name, never its value. */
export type ParameterLoggingViolation =
  | 'log_setting_unreadable'
  | 'log_parameter_max_length_on_error'
  | 'log_statement'
  | 'log_min_duration_statement'
  | 'log_min_duration_sample'
  | 'log_transaction_sample_rate'
  | 'debug_print_plan'
  | 'auto_explain_parameters'
  | 'pgaudit_parameters';

/**
 * The settings the login's sessions run with, each as current_setting(name, true) renders it (units included: '64B',
 * '250ms'). A core setting is always a string; null for a module's setting means the module is not loaded for them.
 */
export interface ParameterLoggingFacts {
  readonly onError: unknown;
  readonly maxLength: unknown;
  readonly statement: unknown;
  readonly minDuration: unknown;
  readonly minSample: unknown;
  readonly sampleRate: unknown;
  readonly printPlan: unknown;
  readonly aeMinDuration: unknown;
  readonly pgaParameter: unknown;
  /** Read, never judged: object auditing logs parameters whatever it says (evaluateParameterLogging). */
  readonly pgaLog: unknown;
}

/** The login's own row, as pg_roles reports it, and whether the session runs as that login. */
export interface LoginFacts {
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly createRole: boolean;
  readonly createDb: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly inherit: boolean;
  readonly ownRole: boolean;
}

/** One membership edge from the login: the role it is a member of, and that grant's options (null: the server has no per-grant inherit option). */
export interface MembershipFacts {
  readonly role: string;
  readonly adminOption: boolean;
  readonly inheritOption: boolean | null;
}

/** A role the login reaches through any chain of memberships. */
export interface ReachedRoleFacts {
  readonly role: string;
  readonly canLogin: boolean;
  readonly unsafeAttribute: boolean;
  readonly marker: string | null;
}

/** Everything the runtime-login judgment reads, gathered in one transaction. */
export interface RuntimeLoginFacts {
  readonly login: LoginFacts | null;
  readonly memberships: readonly MembershipFacts[];
  readonly reached: readonly ReachedRoleFacts[];
  /** Objects the login owns; objects any reached role owns. */
  readonly loginOwned: number;
  readonly rolesOwned: number;
  /** Memberships held by a reached role — each one a further path, or an option, the login gains. */
  readonly roleMemberships: number;
  /** Dependencies on the login or a reached role recorded in another database of the cluster. */
  readonly foreignDependencies: number;
  /** PUBLIC's grants in the application's schemas: relation and column privileges, executable SECURITY DEFINER routines, policies. */
  readonly publicExposure: number;
  /** The login's own ACL and policy mentions, as `kind|type|identity|privileges`. */
  readonly loginGrants: readonly string[];
  /** Every reached role's ACL and policy mentions, as `role|kind|type|identity|privileges`. */
  readonly roleGrants: readonly string[];
  readonly databaseCreate: boolean;
  readonly databaseTemporary: boolean;
  /** Schemas the login may CREATE in, temporary schemas aside. */
  readonly schemaCreate: number;
}

/** One ledger row, typed as read; anything else is malformed. */
export interface LedgerRowFacts {
  readonly version: unknown;
  readonly checksum: unknown;
  readonly dirty: unknown;
  readonly finished: unknown;
}

/** What the ledger question read: whether the relation exists, whether the login may read it, and its rows when it may. */
export interface LedgerFacts {
  readonly present: boolean;
  readonly readable: boolean;
  readonly rows: readonly LedgerRowFacts[];
}

const sortedUnique = <T extends string>(codes: Iterable<T>): T[] => [...new Set(codes)].sort();

/** The approved-boundary judgment: [] when the login is safe, else every violation found. Pure. */
export function evaluateRuntimeLogin(facts: RuntimeLoginFacts): RuntimeLoginViolation[] {
  const found = new Set<RuntimeLoginViolation>();
  const { login } = facts;
  if (login === null) return ['login_unknown'];
  if (!login.canLogin) found.add('login_cannot_login');
  if (login.superuser) found.add('login_superuser');
  if (login.createRole) found.add('login_createrole');
  if (login.createDb) found.add('login_createdb');
  if (login.replication) found.add('login_replication');
  if (login.bypassRls) found.add('login_bypassrls');
  if (!login.ownRole) found.add('login_role_switched');
  if (facts.loginOwned !== 0) found.add('login_owns_objects');
  if (facts.loginGrants.some((grant) => grant !== LEDGER_READ_GRANT)) found.add('login_privilege_unexpected');
  if (!facts.loginGrants.includes(LEDGER_READ_GRANT)) found.add('login_ledger_read_missing');

  const approved = Object.keys(RUNTIME_PRIVILEGE_ROLES);
  const direct = new Set(facts.memberships.map((m) => m.role));
  if (approved.some((role) => !direct.has(role))) found.add('membership_missing');
  // A direct membership outside the two, or any role reached beyond them through a further membership: unexpected
  // however it was granted.
  if (facts.memberships.some((m) => !approved.includes(m.role))) found.add('membership_unexpected');
  if (facts.reached.some((r) => !approved.includes(r.role))) found.add('membership_unexpected');
  for (const membership of facts.memberships) {
    if (membership.adminOption) found.add('membership_admin_option');
    // PostgreSQL 16+ records inheritance per grant; before it, the member's own INHERIT attribute decides.
    const inherited = membership.inheritOption ?? login.inherit;
    if (approved.includes(membership.role) && !inherited) found.add('membership_not_inherited');
  }
  for (const role of facts.reached) {
    if (role.canLogin || role.unsafeAttribute) found.add('role_attribute_unsafe');
    if (approved.includes(role.role) && role.marker !== RUNTIME_PRIVILEGE_ROLES[role.role]) found.add('role_marker_invalid');
  }
  if (facts.rolesOwned !== 0) found.add('role_owns_objects');
  if (facts.roleMemberships !== 0) found.add('role_membership_unexpected');
  if (facts.foreignDependencies !== 0) found.add('foreign_database_dependency');
  if (facts.publicExposure !== 0) found.add('public_privilege_unexpected');

  const expected = new Set(APPROVED_ROLE_GRANTS);
  const actual = new Set(facts.roleGrants);
  if ([...actual].some((grant) => !expected.has(grant))) found.add('role_privilege_unexpected');
  // Only a role actually reached can show a grant missing; a role not reached at all is already membership_missing.
  const reachedNames = new Set(facts.reached.map((r) => r.role));
  if ([...expected].some((grant) => reachedNames.has(grant.slice(0, grant.indexOf('|'))) && !actual.has(grant))) {
    found.add('role_privilege_missing');
  }

  if (facts.databaseCreate) found.add('database_create_privilege');
  if (facts.databaseTemporary) found.add('database_temporary_privilege');
  if (facts.schemaCreate !== 0) found.add('schema_create_privilege');
  return sortedUnique(found);
}

const CHECKSUM_RE = /^[0-9a-f]{64}$/;

/** The ledger judgment: [] when the ledger is exactly REQUIRED_MIGRATIONS, clean and finished; else every violation found. Pure. */
export function evaluateMigrationLedger(facts: LedgerFacts): LedgerViolation[] {
  if (!facts.present) return ['migration_ledger_missing'];
  if (!facts.readable) return ['migration_ledger_unreadable'];
  const found = new Set<LedgerViolation>();
  const required = new Map(REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]));
  const recorded = new Set<string>();
  for (const { version, checksum, dirty, finished } of facts.rows) {
    if (typeof version !== 'string' || typeof checksum !== 'string' || typeof dirty !== 'boolean' || typeof finished !== 'boolean') {
      found.add('migration_ledger_malformed');
      continue;
    }
    if (!required.has(version)) {
      found.add('migration_unknown');
      continue;
    }
    if (recorded.has(version)) found.add('migration_ledger_malformed'); // one row per version: the key no longer holds
    recorded.add(version);
    if (dirty || !finished) found.add('migration_dirty');
    if (!CHECKSUM_RE.test(checksum) || checksum !== required.get(version)) found.add('migration_checksum_mismatch');
  }
  // A required version absent below the newest required one recorded is a gap in the chain; absent above it, the chain
  // stops short. Every required version is three digits, so the text order is the numeric order.
  const newest = [...recorded].sort().at(-1) ?? '';
  for (const { version } of REQUIRED_MIGRATIONS) {
    if (!recorded.has(version)) found.add(version < newest ? 'migration_not_contiguous' : 'migration_missing');
  }
  return sortedUnique(found);
}

/**
 * The parameter-logging judgment: [] when no setting read would log a bound parameter; else every setting that would. Pure.
 *   - on an error: log_parameter_max_length_on_error must be 0;
 *   - with a logged statement: log_parameter_max_length 0, or no statement logged — log_statement none or ddl, and no
 *     duration or sampled logging;
 *   - debug_print_plan off: a plan folds a parameter's value into its text;
 *   - auto_explain, when loaded, logs no plan (log_min_duration -1), for the same reason — its parameter length does not
 *     govern the plan text;
 *   - pgaudit, when loaded, logs no parameter at all (log_parameter off), whatever pgaudit.log says: object auditing
 *     through pgaudit.role logs statements, those inside routines included, with their parameters, independently of
 *     pgaudit.log (the chair's R-A').
 */
export function evaluateParameterLogging(facts: ParameterLoggingFacts): ParameterLoggingViolation[] {
  const { onError, maxLength, statement, minDuration, minSample, sampleRate, printPlan, aeMinDuration, pgaParameter } = facts;
  // Every core setting exists from PostgreSQL 13: one not answered as text is a server this judgment cannot read.
  if ([onError, maxLength, statement, minDuration, minSample, sampleRate, printPlan].some((v) => typeof v !== 'string')) return ['log_setting_unreadable'];
  const found: ParameterLoggingViolation[] = [];
  if (onError !== '0') found.push('log_parameter_max_length_on_error');
  if (maxLength !== '0') {
    if (statement !== 'none' && statement !== 'ddl') found.push('log_statement');
    if (minDuration !== '-1') found.push('log_min_duration_statement');
    if (minSample !== '-1') found.push('log_min_duration_sample');
    if (sampleRate !== '0') found.push('log_transaction_sample_rate');
  }
  if (printPlan !== 'off') found.push('debug_print_plan');
  if (aeMinDuration !== null && aeMinDuration !== '-1') found.push('auto_explain_parameters');
  if (pgaParameter !== null && pgaParameter !== 'off') found.push('pgaudit_parameters');
  return sortedUnique(found);
}

/** The preflight questions over one kernel. Each throws when the database cannot answer. */
export interface StartupPreflight {
  /** One trivial statement: the connection opened, through the client's own transport. */
  connect(signal: AbortSignal): Promise<void>;
  /** [] when the connected login is inside the approved runtime boundary; otherwise every violation. */
  runtimeLogin(signal: AbortSignal): Promise<RuntimeLoginViolation[]>;
  /** [] when the ledger is exactly the required chain; otherwise every violation. */
  migrationLedger(signal: AbortSignal): Promise<LedgerViolation[]>;
  /** [] when the login's sessions would log no bound parameter; otherwise every setting that would. */
  parameterLogging(signal: AbortSignal): Promise<ParameterLoggingViolation[]>;
}

type Row = Readonly<Record<string, unknown>>;
/** A fixed word: nothing of the database's answer is carried in it. */
const invalidAnswer = (): Error => new Error('preflight_answer_invalid');
const rowsOf = (rows: unknown): readonly Row[] => {
  if (!Array.isArray(rows) || rows.some((row) => typeof row !== 'object' || row === null)) throw invalidAnswer();
  return rows as Row[];
};
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw invalidAnswer();
  return v;
};
const count = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw invalidAnswer();
  return v;
};
const text = (v: unknown): string => {
  if (typeof v !== 'string') throw invalidAnswer();
  return v;
};

async function readRuntimeLogin(sql: PgTransactionScope): Promise<RuntimeLoginFacts> {
  const [login] = rowsOf(await sql`select r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      r.rolbypassrls, r.rolinherit, current_user = session_user as own_role
    from pg_catalog.pg_roles r where r.rolname = session_user`);
  const memberships = rowsOf(await sql`select g.rolname::text as role, m.admin_option,
      pg_catalog.to_jsonb(m) operator(pg_catalog.->>) 'inherit_option' as inherit_option
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles g on g.oid = m.roleid
    join pg_catalog.pg_roles l on l.oid = m.member
    where l.rolname = session_user`);
  // Every statement below walks the same graph: the roles the login reaches through any chain of memberships, whatever
  // each grant's options; `union` ends the walk. A statement is one frozen template, so the walk is spelled out in each.
  const reached = rowsOf(await sql`with recursive reached(oid) as (
      select m.roleid from pg_catalog.pg_auth_members m join pg_catalog.pg_roles l on l.oid = m.member where l.rolname = session_user
      union
      select m.roleid from pg_catalog.pg_auth_members m join reached r on m.member = r.oid
    )
    select g.rolname::text as role, g.rolcanlogin,
      (g.rolsuper or g.rolcreaterole or g.rolcreatedb or g.rolreplication or g.rolbypassrls) as unsafe_attribute,
      pg_catalog.shobj_description(g.oid, 'pg_authid') as marker
    from reached r join pg_catalog.pg_roles g on g.oid = r.oid`);
  // Ownership of any object, in this database or cluster-wide, by the login and by every role it reaches; the memberships
  // those roles hold; and anything another database of the cluster records against any of them (pg_shdepend is shared,
  // so those rows are visible here even though their objects are not).
  const [counts] = rowsOf(await sql`with recursive reached(oid) as (
      select m.roleid from pg_catalog.pg_auth_members m join pg_catalog.pg_roles l on l.oid = m.member where l.rolname = session_user
      union
      select m.roleid from pg_catalog.pg_auth_members m join reached r on m.member = r.oid
    ), here(dbid) as (
      select 0::pg_catalog.oid union all select b.oid from pg_catalog.pg_database b where b.datname = pg_catalog.current_database()
    )
    select
      (select pg_catalog.count(*)::int from pg_catalog.pg_shdepend d
        where d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and d.deptype = 'o' and d.dbid in (select dbid from here)
          and d.refobjid = (select l.oid from pg_catalog.pg_roles l where l.rolname = session_user)) as login_owned,
      (select pg_catalog.count(*)::int from pg_catalog.pg_shdepend d
        where d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and d.deptype = 'o' and d.dbid in (select dbid from here)
          and d.refobjid in (select r.oid from reached r)) as roles_owned,
      (select pg_catalog.count(*)::int from pg_catalog.pg_auth_members m where m.member in (select r.oid from reached r)) as role_memberships,
      (select pg_catalog.count(*)::int from pg_catalog.pg_shdepend d
        where d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and d.dbid not in (select dbid from here)
          and (d.refobjid in (select r.oid from reached r)
            or d.refobjid = (select l.oid from pg_catalog.pg_roles l where l.rolname = session_user))) as foreign_dependencies`);
  // Every ACL entry (kind a) and policy (kind r) naming the login or a reached role, with the privileges that entry holds.
  const grants = rowsOf(await sql`with recursive reached(oid) as (
      select m.roleid from pg_catalog.pg_auth_members m join pg_catalog.pg_roles l on l.oid = m.member where l.rolname = session_user
      union
      select m.roleid from pg_catalog.pg_auth_members m join reached r on m.member = r.oid
    ), named(oid, is_login) as (
      select l.oid, true from pg_catalog.pg_roles l where l.rolname = session_user
      union all
      select r.oid, false from reached r
    ), here(dbid) as (
      select 0::pg_catalog.oid union all select b.oid from pg_catalog.pg_database b where b.datname = pg_catalog.current_database()
    )
    select n.is_login, g.rolname::text as role, d.deptype::text as kind, (o).type as type, (o).identity as identity,
      case d.classid
        when 'pg_catalog.pg_class'::pg_catalog.regclass then (
          select pg_catalog.string_agg(x.privilege_type || case when x.is_grantable then '+grant' else '' end, ',' order by x.privilege_type)
          from pg_catalog.aclexplode(case when d.objsubid = 0
            then (select c.relacl from pg_catalog.pg_class c where c.oid = d.objid)
            else (select a.attacl from pg_catalog.pg_attribute a where a.attrelid = d.objid and a.attnum = d.objsubid) end) x
          where x.grantee = d.refobjid)
        when 'pg_catalog.pg_proc'::pg_catalog.regclass then (
          select pg_catalog.string_agg(x.privilege_type || case when x.is_grantable then '+grant' else '' end, ',' order by x.privilege_type)
          from pg_catalog.aclexplode((select p.proacl from pg_catalog.pg_proc p where p.oid = d.objid)) x where x.grantee = d.refobjid)
        when 'pg_catalog.pg_namespace'::pg_catalog.regclass then (
          select pg_catalog.string_agg(x.privilege_type || case when x.is_grantable then '+grant' else '' end, ',' order by x.privilege_type)
          from pg_catalog.aclexplode((select s.nspacl from pg_catalog.pg_namespace s where s.oid = d.objid)) x where x.grantee = d.refobjid)
        when 'pg_catalog.pg_database'::pg_catalog.regclass then (
          select pg_catalog.string_agg(x.privilege_type || case when x.is_grantable then '+grant' else '' end, ',' order by x.privilege_type)
          from pg_catalog.aclexplode((select b.datacl from pg_catalog.pg_database b where b.oid = d.objid)) x where x.grantee = d.refobjid)
        when 'pg_catalog.pg_policy'::pg_catalog.regclass then (
          select case p.polcmd when '*' then 'ALL' when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' end
            || case when p.polpermissive then ',PERMISSIVE' else ',RESTRICTIVE' end
            || case when c.relrowsecurity then ',ROW SECURITY' else '' end
          from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid where p.oid = d.objid)
        else null end as privileges
    from pg_catalog.pg_shdepend d
    join named n on n.oid = d.refobjid
    join pg_catalog.pg_roles g on g.oid = d.refobjid
    cross join lateral pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid) o
    where d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and d.deptype in ('a', 'r') and d.dbid in (select dbid from here)`);
  const [database] = rowsOf(await sql`select
      pg_catalog.has_database_privilege(session_user, pg_catalog.current_database(), 'CREATE') as database_create,
      pg_catalog.has_database_privilege(session_user, pg_catalog.current_database(), 'TEMPORARY') as database_temporary,
      (select pg_catalog.count(*)::int from pg_catalog.pg_namespace s
        where s.nspname operator(pg_catalog.!~) '^pg_(toast_)?temp_'
          and pg_catalog.has_schema_privilege(session_user, s.oid, 'CREATE')) as schema_create`);
  // PUBLIC (grantee 0) in the application's schemas. A routine's null ACL is the default, which lets PUBLIC execute it; a
  // SECURITY INVOKER routine runs with the caller's own privileges, so only a definer one is counted.
  const [exposure] = rowsOf(await sql`with app(oid) as (
      select s.oid from pg_catalog.pg_namespace s where s.nspname operator(pg_catalog.~) '^(public$|tmpos_)'
    )
    select
      (select pg_catalog.count(*)::int from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(c.relacl) x
        where c.relnamespace in (select a.oid from app a) and x.grantee = 0)
      + (select pg_catalog.count(*)::int from pg_catalog.pg_attribute t join pg_catalog.pg_class c on c.oid = t.attrelid
          cross join lateral pg_catalog.aclexplode(t.attacl) x where c.relnamespace in (select a.oid from app a) and x.grantee = 0)
      + (select pg_catalog.count(*)::int from pg_catalog.pg_proc p where p.pronamespace in (select a.oid from app a) and p.prosecdef
          and (p.proacl is null or exists (select 1 from pg_catalog.aclexplode(p.proacl) x where x.grantee = 0)))
      + (select pg_catalog.count(*)::int from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
          where c.relnamespace in (select a.oid from app a) and 0 = any (p.polroles)) as public_exposure`);

  const line = (row: Row): string =>
    `${text(row.kind)}|${text(row.type)}|${text(row.identity)}|${row.privileges === null ? '' : text(row.privileges)}`;
  return {
    login: login === undefined ? null : {
      canLogin: bool(login.rolcanlogin), superuser: bool(login.rolsuper), createRole: bool(login.rolcreaterole),
      createDb: bool(login.rolcreatedb), replication: bool(login.rolreplication), bypassRls: bool(login.rolbypassrls),
      inherit: bool(login.rolinherit), ownRole: bool(login.own_role),
    },
    memberships: memberships.map((m) => ({
      role: text(m.role), adminOption: bool(m.admin_option),
      inheritOption: m.inherit_option === null ? null : text(m.inherit_option) === 'true',
    })),
    reached: reached.map((r) => ({
      role: text(r.role), canLogin: bool(r.rolcanlogin), unsafeAttribute: bool(r.unsafe_attribute),
      marker: r.marker === null ? null : text(r.marker),
    })),
    loginOwned: count(counts?.login_owned),
    rolesOwned: count(counts?.roles_owned),
    roleMemberships: count(counts?.role_memberships),
    foreignDependencies: count(counts?.foreign_dependencies),
    publicExposure: count(exposure?.public_exposure),
    loginGrants: grants.filter((g) => bool(g.is_login)).map(line),
    roleGrants: grants.filter((g) => !bool(g.is_login)).map((g) => `${text(g.role)}|${line(g)}`),
    databaseCreate: bool(database?.database_create),
    databaseTemporary: bool(database?.database_temporary),
    schemaCreate: count(database?.schema_create),
  };
}

async function readLedger(sql: PgTransactionScope): Promise<LedgerFacts> {
  // The oid form of has_table_privilege answers null, never an error, for a relation that does not exist.
  const [access] = rowsOf(await sql`select pg_catalog.to_regclass('public.schema_migrations') is not null as present,
      coalesce(pg_catalog.has_table_privilege(pg_catalog.to_regclass('public.schema_migrations'), 'SELECT'), false) as readable`);
  const present = bool(access?.present);
  const readable = bool(access?.readable);
  if (!present || !readable) return { present, readable, rows: [] };
  const rows = rowsOf(await sql`select version, checksum, dirty, finished_at is not null as finished from public.schema_migrations`);
  return { present, readable, rows: rows.map((r) => ({ version: r.version, checksum: r.checksum, dirty: r.dirty, finished: r.finished })) };
}

async function readParameterLogging(sql: PgTransactionScope): Promise<ParameterLoggingFacts> {
  // The kernel resets every session before reuse and sets no log setting, so one read answers for all of its sessions.
  const [row] = rowsOf(await sql`select pg_catalog.current_setting('log_parameter_max_length_on_error', true) as on_error,
      pg_catalog.current_setting('log_parameter_max_length', true) as max_length,
      pg_catalog.current_setting('log_statement', true) as statement,
      pg_catalog.current_setting('log_min_duration_statement', true) as min_duration,
      pg_catalog.current_setting('log_min_duration_sample', true) as min_sample,
      pg_catalog.current_setting('log_transaction_sample_rate', true) as sample_rate,
      pg_catalog.current_setting('debug_print_plan', true) as print_plan,
      pg_catalog.current_setting('auto_explain.log_min_duration', true) as ae_min_duration,
      pg_catalog.current_setting('pgaudit.log_parameter', true) as pga_parameter,
      pg_catalog.current_setting('pgaudit.log', true) as pga_log`);
  if (row === undefined) throw invalidAnswer();
  return {
    onError: row.on_error, maxLength: row.max_length, statement: row.statement, minDuration: row.min_duration,
    minSample: row.min_sample, sampleRate: row.sample_rate, printPlan: row.print_plan, aeMinDuration: row.ae_min_duration,
    pgaParameter: row.pga_parameter, pgaLog: row.pga_log,
  };
}

/** The preflight over the kernel the transaction root built. Constructs nothing and opens nothing until asked. */
export function createPostgresStartupPreflight(deps: { readonly client: SupervisedPgClient }): StartupPreflight {
  const { client } = deps;
  return Object.freeze({
    async connect(signal: AbortSignal): Promise<void> {
      const [row] = rowsOf(await client.transaction(signal, PREFLIGHT_BOUNDS, (sql) => sql`select 1 as connected`));
      if (row?.connected !== 1) throw invalidAnswer();
    },
    async runtimeLogin(signal: AbortSignal): Promise<RuntimeLoginViolation[]> {
      return evaluateRuntimeLogin(await client.transaction(signal, PREFLIGHT_BOUNDS, readRuntimeLogin));
    },
    async migrationLedger(signal: AbortSignal): Promise<LedgerViolation[]> {
      return evaluateMigrationLedger(await client.transaction(signal, PREFLIGHT_BOUNDS, readLedger));
    },
    async parameterLogging(signal: AbortSignal): Promise<ParameterLoggingViolation[]> {
      return evaluateParameterLogging(await client.transaction(signal, PREFLIGHT_BOUNDS, readParameterLogging));
    },
  });
}

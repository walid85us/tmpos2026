-- Phase 4.0 M7a — tenant customer creation: one write, bound in the database to a minted tenant session, its standing held
-- until COMMIT, and the canonical Customers-Create role set (M7A-CUSTOMERS-P3; G-IAM, G-DBROLE, DA-83; docs/phase-4/10 ADR-34)
-- Migration: 019_m7a_customer_create (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE ROUTINE, TWO GRANTS, NO TABLE, NO ROLE, NO TRIGGER, NO TYPE. This file creates schema
--     tmpos_customer_write and in it the one routine POST /api/v1/customers writes through,
--     m7a_customer_create(session key, customer id, name). It grants tmpos_app USAGE on the schema and EXECUTE on the
--     routine and nothing else to anyone. It alters nothing earlier migrations created, and no ACL on anything they
--     created: 001-018 stay byte for byte as committed (the migration-files contract's pinned checksums prove that; section
--     4's check (h) checks 017's and 018's surfaces by count and exact signature only, not by definition).
--   - WHY A NEW SCHEMA. 017's and 018's reason: older rollbacks drop their schemas WITHOUT CASCADE, and older files and
--     suites assert exact inventories (017: tmpos_customer holds one routine; 018: tmpos_mint five, pinned again by
--     tests/db/tenantSessionMint.integration.test.mjs). A schema this file owns outright leaves each of them as it was.
--   - THE RUNTIME ROLE STILL CANNOT WRITE THE TABLE. tmpos_app gains no privilege on tmpos_customer.customer (017 section
--     3). The only way a customer row is created is this routine, and its ONLY authority argument is the session key:
--     the SHA-256 of a tenant session's identifier (server/runtime/sessions.ts digestOf), the same value the runtime hands
--     018's m7a_customer_page_v2. There is no tenant, actor, membership, role or version parameter to forge. Everything is
--     derived inside, as the routine's owner, exactly as 018's read derives it:
--       * a session row of audience 'tenant' with a mint-ledger row (018), live on the database clock read after every
--         lock below was granted, with the ledger's own expiry, minted under the issuer key installed now;
--       * 016's admission answer for its principal, 'resolved', whose SHA-256 is the standing digest recorded at mint;
--       * EXACTLY ONE tenant-scope grant in that answer (a store grant never qualifies; two are ambiguous).
--   - A WRITE, SO A NARROWER GATE THAN THE READ'S. 017/018 admit read-limited 'overdue' and 'read_only'. This routine
--     admits only an account status and a tenant status in ('active', 'trialing') — the positive set, so a status this
--     file does not know refuses — and only a grant whose role holds the canonical Customers domain at Create or above.
--   - THE ROLE SET IS A RESTATEMENT, PINNED. The catalog decides Customers >= Create (server/platform-identity/
--     m5CanonicalPermissions.ts create_customers, over permissionCatalog.ts's role defaults). 003's CHECK limits a tenant
--     or store grant's role_id to four durable roles (store_owner, manager, technician, sales_staff), and the catalog
--     gives store_owner full, manager full, sales_staff create, technician view. So the SQL set {store_owner, manager,
--     sales_staff} is the catalog's answer for every role a grant can hold, and a parity test pins it against
--     materializeTenantPermissions(role, {}, false).customers >= 'create' for every TENANT_ROLE_IDS entry. Custom roles
--     are not durable (doc 08 DA-85); when one becomes durable this set must be replaced, not extended by hand.
--   - THE HOLD (ADR-31) IS TAKEN HERE, NOT ASSUMED. The runtime's tenant revalidator takes 016's hold and the session row
--     earlier in the same transaction; this routine takes both again (already held: no wait) so it linearizes on its own
--     when called outside that path. Order: first an unlocked pre-check, which refuses, taking no row lock, a key whose
--     session is not live on the database clock or was minted under another issuer key; then 016's
--     m5_hold_tenant_standing (account FOR UPDATE; links, grants, tenants, stores FOR SHARE) -> the session row and its
--     mint-ledger row FOR SHARE -> the issuer key row FOR SHARE -> the database clock -> every check, each in a
--     statement whose READ COMMITTED snapshot is taken after those locks were granted -> the INSERT. A revocation,
--     suspension, grant change, logout or key rotation committed before a lock is seen and refuses; one attempted after
--     waits for this transaction's COMMIT. The ordering requires READ COMMITTED (the kernel sets no other level); under
--     any other the routine raises rather than decide on a snapshot older than its locks, so a database whose default
--     isolation is not READ COMMITTED refuses every create (a deployment condition, doc 08). The same order is the
--     revalidator's (fence -> 016 hold -> session row), and public.tenant is locked before the customer table, the order
--     017's rollback takes them.
--   - ANSWERS. One row (o_tenant_id, o_actor_id, o_membership_id) — the tenant the customer was created in, the actor
--     (016's actor_id: the app-owned internal_user_id the runtime's trusted context calls its actor) and the one tenant
--     grant's membership id, which the runtime must compare with its trusted context's tenant, actor and membershipId,
--     rolling back on any difference (the application's obligation: no check in this file can make it) — or NO row: the
--     key names no live minted tenant session, the issuer key moved, the standing moved, the hold found no principal, the
--     account or tenant status is not a write status, the principal holds other than exactly one tenant grant, or that
--     grant's role is outside the set. Nothing is written for a
--     refusal, and every refusal is the same empty answer. It RAISES, writing nothing: 'invalid_parameter_value' for a
--     null or malformed argument (the runtime never sends one; a fault, never read as a revocation); 'check_violation'
--     for a name 017's CHECK refuses; 'unique_violation' for a customer id already taken; 'object_not_in_prerequisite_state'
--     outside READ COMMITTED; 'no_data_found' when the INSERT wrote no row (a BEFORE INSERT trigger returning NULL, which
--     only the table's owner can install); and whatever 016's hold or read raises.
--     Constraint errors are caught and raised again with FIXED messages, so no name and no well-formed id reaches a DETAIL
--     line in the server log (018's reason); the CHECK itself stays the one definition of the character rules. A string
--     that is not a uuid never enters the routine: the caller's ::uuid cast refuses it first, with PostgreSQL's own
--     message, which quotes the text (the runtime sends only randomUUID output).
--   - WHAT IT DOES NOT DO. It writes no audit record, no outbox event and no idempotency completion: the runtime's command
--     transaction must append those in the same transaction; this file cannot see whether it does. It judges no idle
--     timeout, only the session's expiry. It enforces the runtime's stricter name rule (no invisible-only name) nowhere: 017's CHECK is the
--     database's floor. It chooses no customer id: the caller sends any version-4 UUID (the runtime's randomUUID).
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). Every write below is made with no audit record,
--     no idempotency record, no idle timeout and no name rule beyond 017's CHECK, in whatever tenant the key's session
--     holds:
--       * a holder of tmpos_app plus a live minted session key (a stolen cookie digest, a compromised tenant process)
--         creates customers in that session's tenant, with ids it chooses, until expiry, logout, revocation or a standing
--         change — the write analogue of 018's residual;
--       * every reader of tmpos_mint.issuer_key (a dump, a backup, a replica) who also holds tmpos_app can mint a tenant
--         session for any principal (018: the database checks only the key holder's HMAC, never an identity provider),
--         and so create customers in ANY tenant some principal holds a Create-capable tenant grant on;
--       * the tenant process holds the runtime role and the issuer key together (018): its compromise mints and writes for
--         anyone who can sign in to it;
--       * the server grants a durable role its catalog default: a role an owner narrowed in the client (doc 08 DA-85, e.g.
--         sales_staff to View) still creates through this routine;
--       * the customer primary key is global (017), so a holder of tmpos_app plus a live Create-capable key learns from
--         'unique_violation' whether a uuid it chooses exists in ANY tenant; random 122-bit ids limit this to confirming
--         ids it already knows;
--       * after the pre-check, any live key minted under the installed issuer key — whatever its role or statuses (a
--         technician's, a read_only or overdue tenant's) — takes 016's hold, its session and ledger rows and the issuer
--         key row before refusing; a holder of tmpos_app can keep that transaction open as long as it likes (the
--         database ends no transaction at session expiry, and the holder can set its own
--         idle_in_transaction_session_timeout). While it stays open it delays that principal's logins and commands,
--         standing and grant changes (the account row FOR UPDATE); 010's status command on, and any update of,
--         every tenant and store that principal's grants name (FOR SHARE); touches, logout and revocation of the held
--         session row (not of the principal's other sessions); every
--         issuer-key rotation; and, once a held ledger row is a day past its expiry, 018's prune in every tenant
--         login, so every tenant login fails until that transaction ends — the same class as that holder exhausting
--         connections (G-DBROLE, doc 08 DA-82/DA-115);
--       * a database log that captures bind parameters exposes session keys and customer names: keeping parameters out
--         of the log is a deployment condition (G-DBROLE, G-PRIVACY);
--       * the rollback order is not enforced by the database: a PL/pgSQL body records no dependency, so 016's, 017's or
--         018's rollback run while this file is applied succeeds, and this routine then RAISES on the missing object —
--         failing closed, writing nothing — until the chain is whole again.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; the routine pins its search_path to pg_catalog then pg_temp
--     and runs with row_security off, so were row security ever FORCEd on a table it reads or writes it fails (503)
--     instead of silently refusing every create.
--
-- Reversible via 019_m7a_customer_create.down.sql, which removes exactly what this file created. It does not refuse while
-- customers exist: they live in 017's table, which this file neither created nor alters, and 017's own rollback keeps
-- refusing while any exists. Roll 019 back before 016-018 (see the down file).
--
-- Assumes 001-018 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-019 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 018 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_mint.m7a_customer_page_v2(text, uuid, integer)') is null then
    raise exception 'migration 019 refused: migration 018 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime privilege role this file grants to.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 019 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_customer_write') is not null then
    raise exception 'migration 019 refused: schema tmpos_customer_write already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The routine calls 016's hold and admission read as its owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')) then
    raise exception 'migration 019 refused: the applying principal cannot execute 016''s hold and admission read, which the definer below calls'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads and writes only what its OWNER may (017's argument). Were the applying principal
  -- neither the owner of the session table, the mint ledger, the issuer key and the customer table nor a role inheriting
  -- that owner's privileges — or row security FORCEd on one — the routine would find no session and refuse every create,
  -- or fail on its INSERT.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_customer.customer'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 019 refused: the applying principal neither owns nor inherits the owner of tmpos_session.session, tmpos_mint.tenant_session, tmpos_mint.issuer_key and tmpos_customer.customer, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- Ownership normally carries every privilege the routine uses; each is stated, because an owner can revoke its own:
  -- SELECT on the three tables it reads, UPDATE on the same three, whose rows it locks (FOR SHARE requires it), INSERT on
  -- the customer table. Checked one at a time: has_table_privilege answers true when ANY privilege of a list is held.
  if not (pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'INSERT')) then
    raise exception 'migration 019 refused: the applying principal lacks SELECT or UPDATE on the session table, the mint ledger or the issuer key, or INSERT on tmpos_customer.customer, so the definer below could not create a customer'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_customer_write;

comment on schema tmpos_customer_write is
  'Phase 4.0 M7a (migration 019): tenant customer creation — the one routine a minted tenant session creates a customer through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_customer_write from public, anon, authenticated;
grant usage on schema tmpos_customer_write to tmpos_app;

-- =============================================================================
-- 3) The create
-- =============================================================================
create function tmpos_customer_write.m7a_customer_create(p_session_key text, p_customer_id uuid, p_name text)
returns table (
  o_tenant_id     uuid,
  o_actor_id      uuid,
  o_membership_id uuid
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (016's hold): each statement below takes a fresh READ COMMITTED snapshot, so every check after
-- the hold reads the rows as they stand once its locks were granted. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_now        bigint;
  v_provider   text;
  v_uid        text;
  v_expires    bigint;
  v_minted_expires bigint;
  v_minted_issuer  bytea;
  v_session    record;
  v_issuer     bytea;
  v_admission  record;
  v_grants     jsonb;
  v_tenant     uuid;
  v_membership uuid;
begin
  -- 0. The arguments, before any state is read. The key is 011's shape; the id a version-4 UUID (the runtime's
  --    randomUUID; 017: ids must not be enumerable); the name within the CHECK's length. The character rules are the
  --    CHECK's own, judged at the INSERT.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_customer_id is null
     or p_customer_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_name is null then
    raise exception 'migration 019 create: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.char_length(p_name) not between 1 and 200 then
    raise exception 'migration 019 create: the name is not one the customer table admits'
      using errcode = 'check_violation';
  end if;
  -- The hold-then-re-read below is sound only where each statement takes a new snapshot (017's rollback reason).
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 019 create: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The principal the key names: a tenant session with a ledger row, both rows' expiries and the issuer digest it was
  --    minted under. Unlocked — it names whom to hold and what the pre-check below judges. A key naming nothing takes no
  --    row lock at all.
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return;
  end if;
  --    The pre-check, still unlocked and before any row lock: a key whose session is not live on the database clock now
  --    (step 5's expression), or that was minted under an issuer key other than the one installed now, is refused here
  --    holding no row lock (only the plain reads' table-level ACCESS SHARE, which no row write waits on), so a caller
  --    that keeps its transaction open after it delays, through this routine, no logout, key rotation or login. It adds
  --    no race. It only refuses, each refusal decided on rows committed when this call read them, as step 1's own is.
  --    No routine updates a ledger row or either expiry, a ledger row is removed only by 018's prune a day past its
  --    expiry, and while one exists no other can be minted under its key; so, an owner's direct write aside, an expired
  --    session cannot become live (step 3 requires the two expiries equal) and a key's minted digest never changes. A
  --    key it passes is judged again under the locks: step 3 re-reads both expiries, step 4 locks the key row and
  --    compares the digest again, step 5 reads the clock after every wait.
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return;
  end if;

  -- 2. 016's hold: the account FOR UPDATE, then its links, grants, tenants and stores FOR SHARE, until COMMIT.
  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return;
  end if;

  -- 3. The session row and its mint-ledger row, both held FOR SHARE until COMMIT, for the same principal, with the
  --    ledger's own expiry. A delete or change of either committed before the lock refuses here (no row, or the values
  --    as they now stand decide); one attempted after waits for this transaction (a logout or revocation deletes the
  --    session row; 018's mint prunes a ledger row a day past its expiry).
  select s.expires_at, m.standing_digest, m.issuer_digest, m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant'
     and s.auth_provider = v_provider
     and s.auth_provider_uid = v_uid
     for share of s, m;
  if not found or v_session.expires_at is distinct from v_session.minted_expires_at then
    return;
  end if;

  -- 4. Minted under the key installed now, its row held FOR SHARE until COMMIT, so a rotation or removal committed first
  --    refuses here and one attempted later waits. No key installed refuses every create.
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return;
  end if;

  -- 5. Live, on the database clock read now — after every lock wait above, not when the calling statement began — so a
  --    session that expired while this routine waited refuses.
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return;
  end if;

  -- 6. The standing, re-read under the hold, is the one minted (018's digest, byte for byte), and the account's status is
  --    a write status. STRICT: 016 answers exactly one row, and a fault raises.
  select r.outcome, r.actor_id, r.account_status, r.memberships,
         pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
    into strict v_admission
    from tmpos_session.m5_admit_tenant_session_v2(v_provider, v_uid) r;
  if v_admission.outcome is distinct from 'resolved'
     or v_admission.digest is distinct from v_session.standing_digest
     or v_admission.actor_id is null
     or v_admission.account_status is null
     or v_admission.account_status not in ('active', 'trialing') then
    return;
  end if;

  -- 7. Exactly one tenant-scope grant (the authorizer's rule), on a tenant whose status is a write status, whose role
  --    holds Customers >= Create. The role set restates the catalog for 003's four durable roles; a parity test pins it.
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'tenant';
  if v_grants is null
     or pg_catalog.jsonb_array_length(v_grants) <> 1
     or (v_grants -> 0 ->> 'tenantId') is null
     or (v_grants -> 0 ->> 'membershipId') is null
     or (v_grants -> 0 ->> 'tenantStatus') is null
     or (v_grants -> 0 ->> 'tenantStatus') not in ('active', 'trialing')
     or (v_grants -> 0 ->> 'roleId') is null
     or (v_grants -> 0 ->> 'roleId') not in ('store_owner', 'manager', 'sales_staff') then
    return;
  end if;
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;

  -- 8. The row, in the derived tenant and no other. 017's CHECK and primary key decide; their errors are raised again
  --    with fixed text, so neither the name nor the (well-formed) id reaches a DETAIL line.
  begin
    insert into tmpos_customer.customer (customer_id, tenant_id, name)
    values (p_customer_id, v_tenant, p_name);
    -- A row an owner's trigger suppressed is not a created customer: raise (not caught below), so the caller rolls back.
    if not found then
      raise exception 'migration 019 create: the customer row was not written'
        using errcode = 'no_data_found';
    end if;
  exception
    when check_violation then
      raise exception 'migration 019 create: the name is not one the customer table admits'
        using errcode = 'check_violation';
    when unique_violation then
      raise exception 'migration 019 create: the customer id is already taken'
        using errcode = 'unique_violation';
  end;

  return query select v_tenant, v_admission.actor_id, v_membership;
end
$$;

comment on function tmpos_customer_write.m7a_customer_create(text, uuid, text) is
  'Phase 4.0 M7a (migration 019): creates one customer for a key naming a ledger-minted, live (database clock, read after its lock waits), tenant session minted under the installed issuer key, after taking 016''s hold, the session row and its mint-ledger row, and the issuer key row, whose principal''s standing digest is unchanged, whose account and tenant status are active or trialing, and who holds exactly one tenant grant with a role holding Customers >= Create (store_owner, manager, sales_staff). Answers the derived tenant id, actor id and membership id, or no row (nothing written). Raises invalid_parameter_value, check_violation, unique_violation or no_data_found (the insert wrote no row) with fixed messages, object_not_in_prerequisite_state outside READ COMMITTED, and whatever 016''s hold or read raises.';

-- =============================================================================
-- 4) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so the default is removed explicitly before the one
-- intended grant is issued.
revoke all on function tmpos_customer_write.m7a_customer_create(text, uuid, text) from public, anon, authenticated;
grant execute on function tmpos_customer_write.m7a_customer_create(text, uuid, text) to tmpos_app;

-- The postcondition, proven rather than asserted, in 017's and 018's form. This file refuses to finish unless, now:
--   (a) the schema holds exactly this routine, and no relation, standalone type or trigger;
--   (b) the routine is plpgsql, SECURITY DEFINER, VOLATILE, pinned to the search path above and run with row_security
--       off, and it and the schema are owned by the applying principal;
--   (c) the routine carries no grant beyond its owner's and a non-grantable EXECUTE to tmpos_app;
--   (d) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (e) tmpos_app CAN execute the routine and use the schema; tmpos_audit_writer, anon and authenticated CANNOT execute
--       it by any path: PUBLIC, an inherited role, or a role reachable only through SET ROLE;
--   (f) none of the runtime roles is a MEMBER of the owner of the schema, the routine, or a table the routine's authority
--       and write rest on (the session table, the mint ledger, the issuer key, the customer table) — a membership can hand
--       a role everything the owner holds, inherited or through SET ROLE, which no ACL shows, so any is refused, whatever
--       its options;
--   (g) neither a runtime role nor any role it is a member of (so SET ROLE reaches nothing either) HOLDS a privilege on any
--       of those four tables, no column grant exists on one, and each is still under row level security, not forced — the
--       write stays reachable only through the routine, and the session it trusts cannot be forged beside it;
--   (h) 017's and 018's surfaces by count and exact signature, not by definition: tmpos_customer holds exactly 017's page
--       routine and customer table, tmpos_mint exactly 018's five routines; tmpos_app executes 018's three routines and
--       neither 011's create nor 017's page;
--   (i) tmpos_app and tmpos_audit_writer are members of NOTHING (no pg_auth_members row names either as the member),
--       whatever the options — the claim the startup preflight makes of them at every start;
--   (j) anon and authenticated reach neither tmpos_app nor tmpos_audit_writer by any membership (MEMBER: inherited or
--       not, SET or not); their reach to the owners is (f)'s.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)): a NULL ACL is PostgreSQL's default (for a routine,
-- EXECUTE to PUBLIC), and aclexplode(NULL) yields nothing. A role reachable through a membership is followed whatever the
-- membership's options (the startup preflight's rule): the has_*_privilege functions report only inherited privileges.
-- MEMBER is deliberately wider than what a membership confers: one granted with neither INHERIT nor SET is refused too.
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee. The runtime LOGIN is not among the
-- roles named here: its own memberships (exactly tmpos_app and tmpos_audit_writer) and the two roles' grants are enforced
-- at every start by the startup preflight (server/persistence/postgresStartupPreflight.ts, APPROVED_ROLE_GRANTS). A role
-- no runtime role reaches is examined only by (g)'s column check, which refuses a column grant to anyone.
do $$
declare
  v_bad text;
  v_me  oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  -- (a)
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_write'::regnamespace) <> 1
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_customer_write'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t where t.typnamespace = 'tmpos_customer_write'::regnamespace) then
    raise exception 'migration 019 refused: schema tmpos_customer_write does not hold exactly the one routine this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (
       select 1
         from pg_catalog.pg_proc p
         join pg_catalog.pg_language l on l.oid = p.prolang
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where p.oid = 'tmpos_customer_write.m7a_customer_create(text, uuid, text)'::regprocedure
          and l.lanname = 'plpgsql'
          and p.prosecdef
          and p.provolatile = 'v'
          and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
          and p.proowner = v_me
          and n.nspowner = v_me) then
    raise exception 'migration 019 refused: the create routine is not a plpgsql SECURITY DEFINER VOLATILE routine pinned to pg_catalog, pg_temp with row_security off, owned with its schema by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_customer_write'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 019 refused: an unexpected direct grant remains on the create routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_customer_write'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 019 refused: schema tmpos_customer_write carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_write.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_write'::regnamespace, 'USAGE') then
    raise exception 'migration 019 refused: tmpos_app does not hold EXECUTE on the create routine and USAGE on schema tmpos_customer_write'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid,
           'tmpos_customer_write.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 019 refused: % can execute the create routine', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_customer_write'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_write'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c
       where c.oid in ('tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                       'tmpos_mint.issuer_key'::regclass, 'tmpos_customer.customer'::regclass)
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 019 refused: % is a member of the owner of schema tmpos_customer_write, its routine, or a table it rests on', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct INSERT into every customer table';
  end if;

  -- (g) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(distinct r.rolname::text || ' on ' || t.oid::regclass::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join (values ('tmpos_session.session'::regclass), ('tmpos_mint.tenant_session'::regclass),
                       ('tmpos_mint.issuer_key'::regclass), ('tmpos_customer.customer'::regclass)) as t(oid)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_table_privilege(x.oid, t.oid,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 019 refused: % holds an effective privilege on a table the create rests on', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a, pg_catalog.aclexplode(a.attacl) g
              where a.attrelid in ('tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                                   'tmpos_mint.issuer_key'::regclass, 'tmpos_customer.customer'::regclass)
                and a.attnum > 0 and not a.attisdropped) then
    raise exception 'migration 019 refused: a column grant exists on a table the create rests on'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_customer.customer'::regclass)
                and (not c.relrowsecurity or c.relforcerowsecurity)) then
    raise exception 'migration 019 refused: row level security is not enabled (unforced) on a table the create rests on'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (h)
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer'::regnamespace) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_customer'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c')) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_mint'::regnamespace) <> 5
     or pg_catalog.to_regclass('tmpos_customer.customer') is null
     or pg_catalog.to_regprocedure('tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.hmac_sha256(bytea, bytea)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.mint_message(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.m7a_customer_page_v2(text, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.m7a_issuer_key_check(bytea)') is null then
    raise exception 'migration 019 refused: schema tmpos_customer or tmpos_mint does not hold what 017 and 018 left'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_mint.m7a_issuer_key_check(bytea)'::regprocedure, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app',
          'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)'::regprocedure, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app',
          'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 019 refused: tmpos_app''s EXECUTE on 011''s create, 017''s page or 018''s routines is not what 018 left'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (i)
  select pg_catalog.string_agg(pg_catalog.format('%s in %s', m.member::regrole, m.roleid::regrole), ', '
                               order by m.member, m.roleid) into v_bad
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles r on r.oid = m.member
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer']::name[]);
  if v_bad is not null then
    raise exception 'migration 019 refused: tmpos_app and tmpos_audit_writer must be members of nothing (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (j)
  select pg_catalog.string_agg(pg_catalog.format('%s in %s', r.rolname, t.rolname), ', ' order by r.rolname, t.rolname)
    into v_bad
    from pg_catalog.pg_roles r
    cross join pg_catalog.pg_roles t
   where r.rolname = any (array['anon', 'authenticated']::name[])
     and t.rolname = any (array['tmpos_app', 'tmpos_audit_writer']::name[])
     and pg_catalog.pg_has_role(r.oid, t.oid, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 019 refused: anon and authenticated must reach neither tmpos_app nor tmpos_audit_writer by membership (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

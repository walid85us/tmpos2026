-- Phase 4.0 M7a — the tenant session mint: a tenant session exists only when the holder of a key the runtime role cannot
-- read proves it, and the customer read is bound in the database to such a session (M7A-CUSTOMERS-P2; DA-83, G-IAM,
-- G-DBROLE; docs/phase-4/10 ADR-33)
-- Migration: 018_m7a_tenant_session_mint (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, TWO TABLES, ONE INDEX, TWO HELPERS, THREE GRANTED ROUTINES, TWO REVOKED GRANTS, NO ROLE, NO
--     TRIGGER. This file creates schema tmpos_mint; the issuer key table tmpos_mint.issuer_key (one row at most); the mint
--     ledger tmpos_mint.tenant_session and its expiry index; the helpers hmac_sha256 and mint_message, granted to nobody;
--     and the three routines tmpos_app may execute: m7a_session_create (every session create, both audiences),
--     m7a_customer_page_v2 (the customer read, bound to a minted session) and m7a_issuer_key_check (the startup probe).
--     It revokes tmpos_app's EXECUTE on 011's m5_session_create and on 017's m7a_customer_page: with them the runtime role
--     alone could create a session for anyone and list any tenant's customers from a tuple it builds (doc 08 DA-83).
--     Those two ACL changes are its only effect on objects earlier migrations created: migrations 005-017 are untouched,
--     byte for byte.
--   - WHY A NEW SCHEMA. 017's reason: older rollbacks drop their schemas WITHOUT CASCADE and older files assert exact
--     routine inventories (016's rollback requires tmpos_session to hold exactly six routines). A schema this file owns
--     outright leaves every existing rollback exactly as correct as it was.
--   - THE KEY NEVER APPEARS IN A MIGRATION. The tenant-serving process holds TENANT_SESSION_ISSUER_KEY, 32 to 64 bytes;
--     the database owner installs the same bytes in tmpos_mint.issuer_key, out of band and by a bound parameter, in a
--     session whose statement and parameter logging does not capture it (ADR-33). tmpos_app holds no privilege on either
--     table. No routine that reads the key returns its bytes, a digest of it or material reusable as a proof: of the
--     key they answer only bounded outcomes, the key check's 'match', 'mismatch', 'absent' or 'invalid', the mint's
--     'refused' and the read's 'denied'. The two helpers read no table and are granted to nobody.
--   - A TENANT SESSION EXISTS ONLY IF THE KEY HOLDER MINTED IT. For audience 'tenant', m7a_session_create requires a
--     32-byte HMAC-SHA256, under the installed key, of all eleven values the row is created with (mint_message: a
--     versioned prefix and eleven netstrings in fixed order). It records in the ledger the session key, the SHA-256 of
--     016's admission answer for the principal (its standing, as the database computes it), the SHA-256 of the key it
--     was minted under and the expiry, and only then creates the row through 011's create. The admin branch takes no
--     proof and is 011's create verbatim (DA-37). BOTH branches first check every argument against 011's table CHECKs:
--     a mismatch answers 'invalid' and writes nothing, so no caller value can reach a constraint violation's DETAIL,
--     which the server log records.
--   - THE CUSTOMER READ TAKES ONE AUTHORITY ARGUMENT: THE SESSION KEY. m7a_customer_page_v2 reads only for a session row
--     that has a ledger row, is of audience 'tenant', is live on the database clock with the ledger's own expiry, was
--     minted under the key installed now, and whose principal's live standing digest is the one minted. It then derives
--     the actor, its security version and its one tenant grant from 016's answer, inside the database, and calls 017's
--     page as its owner, so 017's re-check, keyset, cursor rule and answers run unchanged. The session key is the SHA-256
--     of the cookie's identifier (server/runtime/sessions.ts digestOf): no routine returns it and tmpos_app cannot
--     select it.
--   - ROTATION AND REMOVAL END READS. The read compares the ledger's key digest with the key installed now: replacing
--     the key ends every older session's reads, and deleting it ends all of them, with no purge step.
--   - A REPLAY LEDGER THAT NEVER CASCADES. A ledger row has no foreign key and outlives its session until a day after its
--     expiry, so a mint captured from a log cannot re-create a session that ended: a session row of either audience
--     under the key, or a ledger row, answers 'conflict' and nothing is written.
--   - THE DATABASE CLOCK, IN EXACTLY TWO ROUTINES. 011 takes every instant as a parameter (011, NO CLOCK OF ITS OWN), but
--     here the caller holding the runtime role would choose that instant. So the mint bounds created_at to 60 s ahead of
--     statement_timestamp() and prunes the ledger by it, and the read judges expiry by it, with no grace. A skew fails
--     closed: a read refused up to the skew before expiry, or every mint 'invalid' while the runtime's clock runs more
--     than 60 s ahead of the database's.
--   - NO SECRET, NO EXTENSION, NO DYNAMIC SQL, NO TEMPORARY OBJECT. The HMAC is built from core pg_catalog functions
--     (sha256, get_byte, set_byte, decode, repeat), so where pgcrypto lives is irrelevant. Every statement is fixed text,
--     every value a parameter, every relation and routine schema-qualified, and every routine pins its search_path to
--     pg_catalog then pg_temp.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). DA-83 is CONTAINED AGAINST THE RUNTIME CREDENTIAL
--     ALONE, NOT CLOSED:
--       * the tenant process holds the role and the key together, so its compromise mints and reads for anyone;
--       * the owner, a superuser and every reader of tmpos_mint.issuer_key (a dump, a backup, a replica) can mint;
--       * the database verifies that the key holder minted, never that an identity provider authenticated anyone;
--       * admin minting stays unproven (DA-37): tmpos_app can still create an admin session row of its choosing;
--       * a stolen session key plus tmpos_app reads that session's tenant until expiry, revocation or a standing change,
--         past the idle timeout and view_customers, which only the runtime judges;
--       * 007's resolver, the admission reads and 005's self-set RLS context still disclose identity and membership data,
--         and any tenant's tenant, store and entitlement rows, to tmpos_app (DA-29, DA-97), and still drive 012's
--         directory and the 009/010 commands;
--       * a database log that captures bind parameters exposes session keys and proofs, and a proof whose login rolled
--         back stays usable until its expiry: keeping parameters out of the log is a deployment condition (G-DBROLE);
--       * the standing digest depends on PostgreSQL's record and jsonb rendering: a change there denies every minted read
--         until its user signs in again.
--
-- Reversible via 018_m7a_tenant_session_mint.down.sql, which refuses while the key or the ledger holds a row and otherwise
-- removes exactly what this file created and gives tmpos_app back the two grants this file revokes. Runtime code built
-- for this file cannot create a session of either audience without it: code and database roll back together.
--
-- Assumes 001-017 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-018 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 017 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)') is null then
    raise exception 'migration 018 refused: migration 017 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime privilege role this file grants to.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 018 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_mint') is not null then
    raise exception 'migration 018 refused: schema tmpos_mint already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The definers below call 011's create, 016's admission read and 017's page as their owner, the principal applying
  -- this file, whose grants no longer include tmpos_app's once section 8 runs.
  if not (pg_catalog.has_function_privilege(current_user,
            'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user,
            'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)', 'EXECUTE')) then
    raise exception 'migration 018 refused: the applying principal cannot execute 011''s create, 016''s admission read and 017''s page, which the definers below call'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER read answers only what its OWNER may see (017's argument). Were the applying principal not the
  -- session table's owner, or row security FORCEd on it, the read would find no session row: every listing would answer
  -- 'denied', a silent wrong answer rather than a failure.
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid = 'tmpos_session.session'::regclass
                and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 018 refused: the applying principal does not own tmpos_session.session without forced row security, so a definer read could not see its rows'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_mint;

comment on schema tmpos_mint is
  'Phase 4.0 M7a (migration 018): the tenant session mint — the issuer key, the mint ledger, and the three routines through which the runtime creates sessions and reads customers. Owned by this migration; tmpos_app holds USAGE and EXECUTE on three routines only.';

revoke all on schema tmpos_mint from public, anon, authenticated;
grant usage on schema tmpos_mint to tmpos_app;

-- =============================================================================
-- 3) The issuer key and the mint ledger
-- =============================================================================
-- THE KEY: one row at most (the key is the singleton's), 32 to 64 bytes, the lengths the runtime's key parser accepts
-- (server/runtime/keyMaterial.ts). A key of at most 64 bytes fits one SHA-256 block, so the HMAC below never hashes it
-- first. Written only by the owner, directly: the CHECKs are all the validation an install routine would do, and a
-- routine would be one more EXECUTE to withhold.
create table tmpos_mint.issuer_key (
  singleton boolean not null default true
            constraint issuer_key_pkey primary key
            constraint issuer_key_singleton_chk check (singleton),
  key       bytea   not null
            constraint issuer_key_length_chk check (pg_catalog.octet_length(key) between 32 and 64)
);

comment on table tmpos_mint.issuer_key is
  'Phase 4.0 M7a (migration 018): the tenant session issuer key — at most one row, 32-64 bytes, installed and rotated by the owner out of band, never by a migration. No runtime role holds a privilege on it.';

-- THE LEDGER: one row per minted tenant session. NO foreign key, deliberately: a row that died with its session would
-- let a captured mint re-create a session that ended. A row lives until a day after its expiry (the mint prunes it),
-- and holds the digest of the minter's standing and of the key it was minted under, which the read compares.
create table tmpos_mint.tenant_session (
  session_key     text   not null
                  constraint tenant_session_pkey primary key
                  constraint tenant_session_key_chk check (session_key ~ '^[\x21-\x7e]{1,128}$'),
  standing_digest bytea  not null
                  constraint tenant_session_standing_digest_chk check (pg_catalog.octet_length(standing_digest) = 32),
  issuer_digest   bytea  not null
                  constraint tenant_session_issuer_digest_chk check (pg_catalog.octet_length(issuer_digest) = 32),
  expires_at      bigint not null
                  constraint tenant_session_expires_at_chk check (expires_at between 1 and 9007199254740991)
);

comment on table tmpos_mint.tenant_session is
  'Phase 4.0 M7a (migration 018): the mint ledger — one row per minted tenant session (its key, the SHA-256 of its standing and of its issuer key, its expiry), with no foreign key, pruned a day after expiry. No runtime role holds a privilege on it.';

-- The prune's range scan.
create index tenant_session_expiry_idx on tmpos_mint.tenant_session (expires_at);

-- RLS, enabled with NO policy, not forced (011's posture): no role that is not the owner sees a row even if a later
-- migration grants it one by mistake. The routines run as the owner, whom it does not restrict.
alter table tmpos_mint.issuer_key enable row level security;
alter table tmpos_mint.tenant_session enable row level security;
revoke all on table tmpos_mint.issuer_key, tmpos_mint.tenant_session from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 4) The helpers (granted to nobody; not definers)
-- =============================================================================
-- HMAC-SHA256 (RFC 2104) from core functions only. The key is zero-padded to the 64-byte block and XORed into the inner
-- (0x36) and outer (0x5c) pads; a longer key is refused rather than hashed first, because the key table never holds one.
create function tmpos_mint.hmac_sha256(p_key bytea, p_message bytea)
returns bytea
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
  v_key   bytea;
  v_inner bytea := pg_catalog.decode(pg_catalog.repeat('36', 64), 'hex');
  v_outer bytea := pg_catalog.decode(pg_catalog.repeat('5c', 64), 'hex');
  i       integer;
begin
  if pg_catalog.octet_length(p_key) > 64 then
    raise exception 'hmac_sha256: a key longer than the 64-byte block is not accepted'
      using errcode = 'invalid_parameter_value';
  end if;
  v_key := p_key || pg_catalog.decode(pg_catalog.repeat('00', 64 - pg_catalog.octet_length(p_key)), 'hex');
  for i in 0..63 loop
    v_inner := pg_catalog.set_byte(v_inner, i, pg_catalog.get_byte(v_key, i) # 54);
    v_outer := pg_catalog.set_byte(v_outer, i, pg_catalog.get_byte(v_key, i) # 92);
  end loop;
  return pg_catalog.sha256(v_outer || pg_catalog.sha256(v_inner || p_message));
end
$$;

comment on function tmpos_mint.hmac_sha256(bytea, bytea) is
  'Phase 4.0 M7a (migration 018): HMAC-SHA256 from core functions; a key longer than 64 bytes is refused. Granted to nobody.';

-- THE MINT MESSAGE. UTF-8 'tmpos-tenant-session-mint:v1', then each of the eleven values in this order as a netstring —
-- its UTF-8 byte length in decimal, ':', its bytes, ',' — so no value can contain a separator and the encoding is
-- unambiguous. A missing authenticated_at is the empty string; every number is the canonical decimal of a safe integer,
-- which the runtime's String(n) writes identically. NULL when any other value is NULL. The runtime computes the same
-- bytes (server/persistence/postgresSessionStore.ts tenantMintProof).
create function tmpos_mint.mint_message(
  p_session_key       text,
  p_audience          text,
  p_auth_provider     text,
  p_auth_provider_uid text,
  p_principal_key     text,
  p_security_version  text,
  p_authenticated_at  bigint,
  p_created_at        bigint,
  p_last_seen_at      bigint,
  p_validated_at      bigint,
  p_expires_at        bigint)
returns bytea
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_message bytea := pg_catalog.convert_to('tmpos-tenant-session-mint:v1', 'UTF8');
  v_field   text;
  v_bytes   bytea;
begin
  foreach v_field in array array[p_session_key, p_audience, p_auth_provider, p_auth_provider_uid, p_principal_key,
      p_security_version, coalesce(p_authenticated_at::text, ''), p_created_at::text, p_last_seen_at::text,
      p_validated_at::text, p_expires_at::text] loop
    if v_field is null then
      return null;
    end if;
    v_bytes := pg_catalog.convert_to(v_field, 'UTF8');
    v_message := v_message || pg_catalog.convert_to(pg_catalog.octet_length(v_bytes)::text || ':', 'UTF8') || v_bytes || '\x2c'::bytea;
  end loop;
  return v_message;
end
$$;

comment on function tmpos_mint.mint_message(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint) is
  'Phase 4.0 M7a (migration 018): the canonical tenant mint message — a versioned prefix and eleven netstrings in fixed order. Granted to nobody.';

-- =============================================================================
-- 5) The mint: every session create, both audiences
-- =============================================================================
-- ANSWERS. 'created'; 'conflict' (the key names a session row of either audience, or a ledger row: nothing is written);
-- 'invalid' (an argument 011's table would refuse, a proof where none belongs or none where one must be, a tenant
-- lifetime over eight hours, or a creation more than 60 s ahead of the database clock); 'refused' (no key installed, or
-- the proof is not the key's). It RAISES only when 016's read raises, or when another transaction creates the same key
-- between the ledger insert and 011's create — a same-key race that rolls the ledger row back with it.
--
-- WHAT IT DOES NOT REQUIRE. An admission of 'resolved', a creation near now, or an expiry still ahead: the port's
-- conformance records (a synthetic provider, stamped years ago) mint, and read nothing. A standing that changed between
-- the runtime's check and this mint widens nothing: the read compares the live standing with the one recorded here.
--
-- ORDER, AND WHY. The arguments first, so nothing reaches a CHECK; the proof before any read of state, so a caller
-- without the key learns nothing about sessions or principals; the session table before the ledger, so a key whose
-- ledger row was pruned is 'conflict' rather than a raise after the ledger insert. Digests are compared, not the proof
-- itself, so the comparison's time says nothing about how much of a guess was right.
create function tmpos_mint.m7a_session_create(
  p_session_key       text,
  p_audience          text,
  p_auth_provider     text,
  p_auth_provider_uid text,
  p_principal_key     text,
  p_security_version  text,
  p_authenticated_at  bigint,
  p_created_at        bigint,
  p_last_seen_at      bigint,
  p_validated_at      bigint,
  p_expires_at        bigint,
  p_proof             bytea)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_now      bigint := pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp()) * 1000)::bigint;
  v_message  bytea;
  v_key      bytea;
  v_standing bytea;
begin
  -- 1. Every argument of either audience against 011's table CHECKs (011 section 3), each NULL test first.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_audience is null or p_audience not in ('tenant', 'admin')
     or p_auth_provider is null or p_auth_provider !~ '^[a-z][a-z0-9_-]{0,31}$'
     or p_auth_provider_uid is null or pg_catalog.length(p_auth_provider_uid) not between 1 and 128
     or p_principal_key is null or p_principal_key !~ '^[\x21-\x7e]{1,128}$'
     or p_security_version is null or p_security_version !~ '^[\x21-\x7e]{1,128}$'
     or (p_authenticated_at is not null and p_authenticated_at not between 1 and 9007199254740991)
     or p_created_at is null or p_created_at not between 1 and 9007199254740991
     or p_last_seen_at is null or p_last_seen_at not between 1 and 9007199254740991
     or p_validated_at is null or p_validated_at not between 1 and 9007199254740991
     or p_expires_at is null or p_expires_at not between 1 and 9007199254740991
     or p_last_seen_at < p_created_at or p_validated_at < p_created_at
     or p_expires_at <= p_created_at then
    return 'invalid';
  end if;

  -- The admin branch: no proof, then 011's create exactly as it answers (DA-37).
  if p_audience = 'admin' then
    if p_proof is not null then
      return 'invalid';
    end if;
    return tmpos_session.m5_session_create(p_session_key, p_audience, p_auth_provider, p_auth_provider_uid, p_principal_key,
      p_security_version, p_authenticated_at, p_created_at, p_last_seen_at, p_validated_at, p_expires_at);
  end if;

  -- 2. The tenant bounds: a 32-byte proof, at most the tenant lifetime (sessions.ts SESSION_TTL.tenant, eight hours),
  --    and a creation no more than 60 s ahead of the database clock.
  if p_proof is null or pg_catalog.octet_length(p_proof) <> 32
     or p_expires_at - p_created_at > 28800000
     or p_created_at > v_now + 60000 then
    return 'invalid';
  end if;
  v_message := tmpos_mint.mint_message(p_session_key, p_audience, p_auth_provider, p_auth_provider_uid, p_principal_key,
    p_security_version, p_authenticated_at, p_created_at, p_last_seen_at, p_validated_at, p_expires_at);
  if v_message is null then
    return 'invalid';
  end if;

  -- 3. The proof, before any state is read.
  select k.key into v_key from tmpos_mint.issuer_key k where k.singleton;
  if v_key is null
     or pg_catalog.sha256(tmpos_mint.hmac_sha256(v_key, v_message)) is distinct from pg_catalog.sha256(p_proof) then
    return 'refused';
  end if;

  -- 4. The standing, as 016 answers it for this principal now. STRICT: 016 answers exactly one row, and a fault raises.
  select pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) into strict v_standing
    from tmpos_session.m5_admit_tenant_session_v2(p_auth_provider, p_auth_provider_uid) r;

  -- 5. A key that names any session row, of either audience, minted or not, is taken.
  if exists (select 1 from tmpos_session.session s where s.session_key = p_session_key) then
    return 'conflict';
  end if;

  -- 6. Ledger rows a day past their expiry (011's grace), then 7. this session's, never over an existing one.
  delete from tmpos_mint.tenant_session m where m.expires_at <= v_now - 86400000;
  insert into tmpos_mint.tenant_session (session_key, standing_digest, issuer_digest, expires_at)
  values (p_session_key, v_standing, pg_catalog.sha256(v_key), p_expires_at)
  on conflict (session_key) do nothing;
  if not found then
    return 'conflict';
  end if;

  -- 8. The row itself. Anything but 'created' is a same-key race: raise, and the ledger row goes with the transaction.
  if tmpos_session.m5_session_create(p_session_key, p_audience, p_auth_provider, p_auth_provider_uid, p_principal_key,
       p_security_version, p_authenticated_at, p_created_at, p_last_seen_at, p_validated_at, p_expires_at)
     is distinct from 'created' then
    raise exception 'migration 018 mint: the session key was taken concurrently'
      using errcode = 'unique_violation';
  end if;
  return 'created';
end
$$;

comment on function tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea) is
  'Phase 4.0 M7a (migration 018): every session create. Checks every argument against 011''s table first (''invalid''). Admin: no proof, then 011''s create. Tenant: at most eight hours, created at most 60 s ahead of the database clock, an HMAC-SHA256 proof under the installed issuer key (''refused''), then a ledger row with the standing and issuer digests and 011''s create; a taken key is ''conflict''.';

-- =============================================================================
-- 6) The session-bound customer page
-- =============================================================================
-- ANSWERS 017's columns and answers, so the runtime's reading of them is unchanged, plus:
--   * ('invalid', null, null, null) — a key that is not 011's shape;
--   * ('denied', null, null, null) — no minted, live, tenant session under the key, or its minting key or its
--     principal's standing has moved since, or the principal holds other than exactly one tenant grant.
-- Only the key is an authority argument. The continuation and the limit go to 017, which checks them.
create function tmpos_mint.m7a_customer_page_v2(p_session_key text, p_after_customer_id uuid, p_limit integer)
returns table (
  o_outcome     text,
  o_tenant_id   uuid,
  o_customer_id uuid,
  o_name        text
)
language plpgsql
-- STABLE IS LOAD-BEARING (016's and 017's reason): the session, the ledger, the key, 016's answer and 017's page are
-- separate statements, and a STABLE function runs every one of them on the calling query's snapshot.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_now       bigint := pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp()) * 1000)::bigint;
  v_session   record;
  v_issuer    bytea;
  v_admission record;
  v_grants    jsonb;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$' then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 1. A minted tenant session, live on the database clock, with the ledger's own expiry.
  select s.audience, s.auth_provider, s.auth_provider_uid, s.expires_at, m.standing_digest, m.issuer_digest,
         m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key;
  if not found
     or v_session.audience is distinct from 'tenant'
     or v_session.expires_at is distinct from v_session.minted_expires_at
     or v_now >= v_session.expires_at then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 2. Minted under the key installed now. No key installed denies every read.
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 3. The principal's standing is the one minted. STRICT: 016 answers exactly one row, and a fault raises.
  select r.outcome, r.actor_id, r.security_version, r.memberships,
         pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
    into strict v_admission
    from tmpos_session.m5_admit_tenant_session_v2(v_session.auth_provider, v_session.auth_provider_uid) r;
  if v_admission.outcome is distinct from 'resolved' or v_admission.digest is distinct from v_session.standing_digest then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 4. Exactly one tenant-scope grant: none is unauthorized, two are ambiguous (the authorizer's own rule).
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'tenant';
  if v_grants is null or pg_catalog.jsonb_array_length(v_grants) <> 1 then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 5. 017's page, as this routine's owner, for the authority derived here and nothing the caller named.
  return query
    select p.o_outcome, p.o_tenant_id, p.o_customer_id, p.o_name
      from tmpos_customer.m7a_customer_page(v_admission.actor_id, v_admission.security_version,
             (v_grants -> 0 ->> 'membershipId')::uuid, v_grants -> 0 ->> 'roleId', (v_grants -> 0 ->> 'tenantId')::uuid,
             p_after_customer_id, p_limit) p;
end
$$;

comment on function tmpos_mint.m7a_customer_page_v2(text, uuid, integer) is
  'Phase 4.0 M7a (migration 018): the tenant customer directory bound to a minted session — for a key naming a ledger-minted, live (database clock), tenant session minted under the installed issuer key whose principal''s standing digest is unchanged and who holds exactly one tenant grant, 017''s page for the authority derived from 016''s answer. ''denied'' otherwise; ''invalid'' for a malformed key. Read-only.';

-- =============================================================================
-- 7) The issuer-key check
-- =============================================================================
-- The runtime proves at startup that it holds the installed key without either side revealing it: it sends
-- HMAC-SHA256(key, 'tmpos-tenant-issuer-key-fingerprint:v1') (014's construction for its own key) and learns only
-- 'match', 'mismatch', 'absent' (no key installed) or 'invalid' (not 32 bytes).
create function tmpos_mint.m7a_issuer_key_check(p_fingerprint bytea)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_key bytea;
begin
  if p_fingerprint is null or pg_catalog.octet_length(p_fingerprint) <> 32 then
    return 'invalid';
  end if;
  select k.key into v_key from tmpos_mint.issuer_key k where k.singleton;
  if v_key is null then
    return 'absent';
  end if;
  if pg_catalog.sha256(tmpos_mint.hmac_sha256(v_key, pg_catalog.convert_to('tmpos-tenant-issuer-key-fingerprint:v1', 'UTF8')))
     is distinct from pg_catalog.sha256(p_fingerprint) then
    return 'mismatch';
  end if;
  return 'match';
end
$$;

comment on function tmpos_mint.m7a_issuer_key_check(bytea) is
  'Phase 4.0 M7a (migration 018): whether a 32-byte fingerprint is HMAC-SHA256(installed key, ''tmpos-tenant-issuer-key-fingerprint:v1''): match, mismatch, absent or invalid. Returns only that bounded outcome: never key bytes, a digest of the key or reusable key material.';

-- =============================================================================
-- 8) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so the default is removed explicitly from every
-- routine before the three intended grants are issued.
revoke all on function tmpos_mint.hmac_sha256(bytea, bytea) from public, anon, authenticated;
revoke all on function tmpos_mint.mint_message(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea) from public, anon, authenticated;
revoke all on function tmpos_mint.m7a_customer_page_v2(text, uuid, integer) from public, anon, authenticated;
revoke all on function tmpos_mint.m7a_issuer_key_check(bytea) from public, anon, authenticated;

grant execute on function tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea) to tmpos_app;
grant execute on function tmpos_mint.m7a_customer_page_v2(text, uuid, integer) to tmpos_app;
grant execute on function tmpos_mint.m7a_issuer_key_check(bytea) to tmpos_app;

-- The two unproven paths (011 section 6 and 017 section 5 granted them).
revoke execute on function tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint) from tmpos_app;
revoke execute on function tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer) from tmpos_app;

-- The postcondition, proven rather than asserted, in 017's form. This file refuses to finish unless, at this moment:
--   (a) the schema holds exactly the five routines, the two tables and their three indexes this file creates, and no
--       view, sequence, standalone type or trigger;
--   (b) the three granted routines are SECURITY DEFINER — the mint VOLATILE, the page and the key check STABLE — pinned
--       to the search path above, the page also run with row_security off; the helpers are IMMUTABLE, pinned, and not
--       definers;
--   (c) both tables are under row level security, not forced, with no policy, no grant beyond their owner's and no
--       column grant;
--   (d) the routines carry no grant beyond their owner's and a non-grantable EXECUTE to tmpos_app on exactly the three;
--   (e) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (f) tmpos_app CAN execute the three and use the schema, and CANNOT execute 011's create, 017's page or a helper, by
--       any path;
--   (g) none of the runtime roles is a MEMBER of the owner of the schema, a table or a routine — membership, even without
--       inheritance, hands a role everything the owner holds (through SET ROLE), which no ACL shows;
--   (h) none of the runtime roles HOLDS a privilege on either table by any path — PUBLIC, an inherited role, or a
--       predefined role such as pg_read_all_data — which the ACL checks cannot see (011's effective-privilege check).
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)): a NULL ACL is PostgreSQL's default (for a routine,
-- EXECUTE to PUBLIC), and aclexplode(NULL) yields nothing.
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee: a later DDL statement outside
-- these migrations could add an object or a grant. The startup preflight re-reads the runtime roles' grants
-- (server/persistence/postgresStartupPreflight.ts APPROVED_ROLE_GRANTS).
do $$
declare
  v_bad text;
begin
  -- (a)
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_mint'::regnamespace) <> 5
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_mint'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c')) <> 2
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_mint'::regnamespace and c.relkind in ('i', 'I')) <> 3
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_mint'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_class c on c.oid = g.tgrelid
                 where c.relnamespace = 'tmpos_mint'::regnamespace) then
    raise exception 'migration 018 refused: schema tmpos_mint does not hold exactly the five routines, two tables and three indexes this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)'::regprocedure
                    and p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=pg_catalog, pg_temp'])
     or not exists (select 1 from pg_catalog.pg_proc p
                     where p.oid = 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)'::regprocedure
                       and p.prosecdef and p.provolatile = 's'
                       and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off'])
     or not exists (select 1 from pg_catalog.pg_proc p
                     where p.oid = 'tmpos_mint.m7a_issuer_key_check(bytea)'::regprocedure
                       and p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=pg_catalog, pg_temp'])
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in ('tmpos_mint.hmac_sha256(bytea, bytea)'::regprocedure,
                                 'tmpos_mint.mint_message(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)'::regprocedure)
                   and (p.prosecdef or p.provolatile <> 'i' or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp'])) then
    raise exception 'migration 018 refused: a routine in tmpos_mint does not carry the security, volatility and settings this file gives it'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('tmpos_mint.issuer_key'::regclass, 'tmpos_mint.tenant_session'::regclass)
                and (not c.relrowsecurity or c.relforcerowsecurity))
     or exists (select 1 from pg_catalog.pg_policy p
                 where p.polrelid in ('tmpos_mint.issuer_key'::regclass, 'tmpos_mint.tenant_session'::regclass)) then
    raise exception 'migration 018 refused: row level security is not enabled (unforced) on a tmpos_mint table, or a policy exists on one'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', c.relname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_class c,
         pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
   where c.oid in ('tmpos_mint.issuer_key'::regclass, 'tmpos_mint.tenant_session'::regclass)
     and g.grantee <> c.relowner;
  if v_bad is not null then
    raise exception 'migration 018 refused: an unexpected grant remains on a tmpos_mint table (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid in ('tmpos_mint.issuer_key'::regclass, 'tmpos_mint.tenant_session'::regclass)
                and a.attacl is not null) then
    raise exception 'migration 018 refused: a column grant exists on a tmpos_mint table'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_mint'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable
              and p.proname in ('m7a_session_create', 'm7a_customer_page_v2', 'm7a_issuer_key_check'));
  if v_bad is not null then
    raise exception 'migration 018 refused: an unexpected direct grant remains on a tmpos_mint routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_mint'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 018 refused: schema tmpos_mint carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_mint.m7a_issuer_key_check(bytea)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_mint'::regnamespace, 'USAGE') then
    raise exception 'migration 018 refused: tmpos_app does not hold EXECUTE on the three routines and USAGE on schema tmpos_mint'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.has_function_privilege('tmpos_app',
       'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)'::regprocedure, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app',
       'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app', 'tmpos_mint.hmac_sha256(bytea, bytea)'::regprocedure, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app',
       'tmpos_mint.mint_message(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 018 refused: tmpos_app can still execute 011''s create, 017''s page or a helper'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_mint'
      union
      select c.relowner from pg_catalog.pg_class c where c.relnamespace = 'tmpos_mint'::regnamespace
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_mint'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 018 refused: % is a member of the owner of schema tmpos_mint, a table or a routine in it', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including the issuer key and every ledger row';
  end if;

  -- (h) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(r.rolname::text || ' on ' || t.oid::regclass::text, ', ' order by r.rolname, t.oid) into v_bad
    from pg_catalog.pg_roles r
    cross join (values ('tmpos_mint.issuer_key'::regclass), ('tmpos_mint.tenant_session'::regclass)) as t(oid)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_table_privilege(r.oid, t.oid,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 018 refused: % holds an effective privilege on a tmpos_mint table', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

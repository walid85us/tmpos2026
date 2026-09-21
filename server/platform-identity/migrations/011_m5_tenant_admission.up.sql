-- Phase 4.0 M5 — the tenant admission boundary: the durable session record and the one read that
-- decides whether a session may continue (M5-GIAM-D1-P2-R1; G-IAM, GAP-13, DA-32; docs/phase-4/04 §2, §5)
-- Migration: 011_m5_tenant_admission (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE TABLE, SIX ROUTINES, NO NEW ROLE. This file creates schema tmpos_session, the
--     durable session table the existing session-store contract requires (server/runtime/sessions.ts
--     SessionStore; docs/phase-4/03 §2 #18), the five fixed operations that are the ONLY way the runtime
--     reaches it, and one read that answers the tenant boundary's admission question. It creates no role,
--     no role membership and no type, and it alters nothing that 001-010 created. Migrations 005, 006,
--     007, 008, 009 and 010 are untouched, byte for byte.
--   - WHY A NEW SCHEMA AND NOT AN EXISTING ONE. 007's rollback drops tmpos_identity WITHOUT CASCADE and
--     008's drops tmpos_command the same way, while 010's rollback asserts the exact routine inventory of
--     tmpos_command. A routine added to either schema would make an older rollback fail or an assertion
--     false. A schema this file owns outright is the only placement that leaves every existing rollback
--     exactly as correct as it was.
--   - THE RUNTIME NEVER TOUCHES THE TABLE. tmpos_app receives USAGE on the schema and EXECUTE on the six
--     routines, and NO privilege of any kind on tmpos_session.session — not select, not insert, not
--     update, not delete, not a column privilege. Every read and every write goes through a fixed
--     operation that enforces the invariants the runtime's contract states: `update` changes an existing
--     row only and never recreates a revoked one, `revoke_principal` ends exactly one principal's sessions
--     in exactly one audience, and an expired record is never returned. A direct write that could bypass
--     those invariants is not narrowed here — it is never granted. Section 6 proves that rather than
--     asserting it: it refuses to finish while any direct grant beyond those exists.
--   - WHAT ADMISSION READS, AND WHAT IT REFUSES TO INVENT. m5_admit_tenant_session answers for a
--     provider reference the authentication boundary has already verified, and for nothing else. It takes
--     no tenant, no store, no role and no version from its caller: it calls 007's resolution routine —
--     the single definition of which grants an actor holds — and adds, to each grant that names a tenant,
--     that tenant's CURRENT public.tenant.access_version (migration 010). It invents nothing; where a
--     tenant-scoped grant has no readable access version it RAISES — an outage the adapter reports and
--     the boundary fails closed on, revoking nothing — rather than admitting a session with an unknown
--     witness or reporting a refusal, which the boundary would act on by ending every session held.
--   - WHY THE ACCESS VERSION IS NEEDED AT ALL, given that 007 already hides a suspended tenant's grants.
--     007's routine filters out every membership whose tenant is 'suspended' or 'pending_activation', so
--     SUSPENSION alone already changes the answer. What it cannot express is REACTIVATION: once the tenant
--     is active again the grant returns, and the answer becomes byte-identical to the one it gave before
--     the suspension. A session that was idle across the whole episode would then be admitted again on the
--     old witness — the exact revival migration 010's access version exists to prevent. Because that
--     version moves by one on suspension AND by one on reactivation, and never returns to a value it has
--     held, the answer after reactivation differs from the answer before the suspension, and the idle
--     session is refused and must be admitted anew.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO TRIGGER. Every statement is fixed
--     text, every value a parameter, every relation and routine schema-qualified, and every routine pins
--     its search_path to pg_catalog then pg_temp.
--   - NO CLOCK OF ITS OWN. Every routine that judges time is handed the instant as a parameter, in epoch
--     milliseconds, by the one caller that owns the runtime's clock. A routine that read the database
--     clock instead would answer differently from the runtime reading the same record, and the two
--     expiry judgements must agree.
--
-- Reversible via 011_m5_tenant_admission.down.sql, which REFUSES while any session row remains, expired or
-- not — rolling back destroys the only record of who is signed in, and that is not done silently — and
-- otherwise removes exactly the objects this file created, checking that what 007-010 own is still present.
--
-- Assumes 001-010 are applied. A future managed apply targets the complete contiguous chain through the
-- newest committed migration — now 001-011 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- 007's resolution routine is the sole definition of an actor's grants; this file adds to its answer
  -- and never restates it, so its absence is a refusal rather than a reimplementation.
  if pg_catalog.to_regprocedure('tmpos_identity.m5_resolve_principal(text, text)') is null then
    raise exception 'migration 011 refused: migration 007 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 010's access version is the witness this boundary admits against.
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.tenant'::regclass
                    and a.attname = 'access_version' and not a.attisdropped) then
    raise exception 'migration 011 refused: migration 010 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime privilege role this file grants to.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 011 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- A SECURITY DEFINER read of public.tenant answers only what its OWNER may see. Migration 005
  -- deliberately does not FORCE row level security, so the owner reads every row — but only if the
  -- principal applying this file is in fact that owner. Were it not, the routine below would find no
  -- access version for a tenant grant 007 resolved, and every tenant admission would fail as an outage
  -- (section 5 raises rather than refusing). That failure is caught here, once, rather than discovered
  -- after deployment.
  if not pg_catalog.pg_has_role(current_user,
                                (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.tenant'::regclass),
                                'USAGE') then
    raise exception 'migration 011 refused: the applying principal does not own public.tenant, so a definer read could not see its rows'
      using errcode = 'insufficient_privilege';
  end if;
  -- FORCEd row security hides the rows from their OWNER too, and it would hide them from 007's resolver
  -- as well as from this file's routine. 007 then drops every tenant and store grant, the admission
  -- answers a principal with no grant, and the boundary REVOKES every session that principal holds —
  -- a refusal, not the outage section 5 raises. So it is refused here, as migration 010 refuses it for
  -- its own definer. A FORCE added after this apply is not caught by any apply-time check (doc 08 DA-40).
  if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = 'public.tenant'::regclass) then
    raise exception 'migration 011 refused: public.tenant forces row level security on its owner, so a definer read would see none of its rows'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_session;

comment on schema tmpos_session is
  'Phase 4.0 M5 (migration 011): the tenant/admin session boundary — the durable session record and the fixed operations that are the only way the runtime reaches it. Owned by this migration; tmpos_app holds USAGE and EXECUTE only, and no privilege on the table.';

revoke all on schema tmpos_session from public, anon, authenticated;
grant usage on schema tmpos_session to tmpos_app;

-- =============================================================================
-- 3) The session record
-- =============================================================================
-- KEYED BY A DIGEST, NEVER BY THE IDENTIFIER. In the composed runtime, session_key is the SHA-256 of
-- the session identifier in base64url (server/runtime/sessions.ts digestOf) and principal_key the
-- digest of the provider reference (principalKeyOf), so a reader of this table — a backup, a replica,
-- a support query — holds nothing that can be presented as a cookie, and no provider UID is indexed.
--
-- WHY THE COLUMNS BOUND RATHER THAN MATCH THAT SHAPE. The port those digests satisfy
-- (server/runtime/sessions.ts SessionStore) declares both keys OPAQUE: it says what the store must do
-- with a key, never what a key looks like, and its conformance suite exercises a store with short
-- synthetic keys. A CHECK asserting 43 base64url characters would encode the CALLER's invariant in the
-- storage layer, and the durable store would then refuse records the contract it implements calls
-- valid. What storage must bound, it bounds: a printable, space-free, length-limited value.
--
-- EVERY TIME IS EPOCH MILLISECONDS, supplied by the runtime. The column type is bigint and the CHECKs
-- bound it to the runtime's safe-integer range, so a value that could not round-trip through the
-- runtime's number type is refused by the database rather than silently truncated on the way back.
create table tmpos_session.session (
  session_key       text   primary key
                    constraint session_key_shape_chk check (session_key ~ '^[\x21-\x7e]{1,128}$'),
  audience          text   not null
                    constraint session_audience_chk check (audience in ('tenant', 'admin')),
  -- The provider token's own shape (access.ts PROVIDER_RE), not a list of the providers that exist
  -- today: which providers may authenticate is the identity boundary's decision, not the store's.
  auth_provider     text   not null
                    constraint session_auth_provider_chk check (auth_provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  -- The identity provider's UID bound (access.ts MAX_UID_LENGTH), counted in code points: a value of
  -- at most 128 UTF-16 code units is at most 128 code points, so a UID the runtime accepts fits.
  auth_provider_uid text   not null
                    constraint session_auth_provider_uid_chk check (pg_catalog.length(auth_provider_uid) between 1 and 128),
  principal_key     text   not null
                    constraint session_principal_key_shape_chk check (principal_key ~ '^[\x21-\x7e]{1,128}$'),
  security_version  text   not null
                    constraint session_security_version_chk check (security_version ~ '^[\x21-\x7e]{1,128}$'),
  authenticated_at  bigint
                    constraint session_authenticated_at_chk check (authenticated_at is null or authenticated_at between 1 and 9007199254740991),
  created_at        bigint not null
                    constraint session_created_at_chk check (created_at between 1 and 9007199254740991),
  last_seen_at      bigint not null
                    constraint session_last_seen_at_chk check (last_seen_at between 1 and 9007199254740991),
  validated_at      bigint not null
                    constraint session_validated_at_chk check (validated_at between 1 and 9007199254740991),
  expires_at        bigint not null
                    constraint session_expires_at_chk check (expires_at between 1 and 9007199254740991),
  -- The two stamps never precede the record's own creation: the runtime's reader refuses such a record
  -- (sessions.ts liveSession), and the store must not be able to produce one.
  constraint session_stamps_chk check (last_seen_at >= created_at and validated_at >= created_at),
  constraint session_lifetime_chk check (expires_at > created_at)
);

comment on table tmpos_session.session is
  'Phase 4.0 M5 (migration 011): one row per live session, keyed by the SHA-256 digest of the session identifier — never the identifier itself. Reached only through the five fixed operations in this schema; tmpos_app holds no privilege on this table.';

-- The one index the operations need: revoking a principal ends its sessions in ONE audience, so the
-- lookup is by the pair. The primary key serves every other access.
create index session_principal_idx on tmpos_session.session (audience, principal_key);

-- Nothing beyond the owner may touch the table. Stated rather than assumed: 005 revokes the default
-- privileges that would otherwise reach new tables in public, but this schema is new and its own.
revoke all on table tmpos_session.session from public, anon, authenticated;

-- RLS, enabled with NO policy — the posture 006 gives its own tables, for the same reason. Section 6
-- already refuses to finish while any role holds a privilege here, so today this changes nothing; it
-- is the second layer for the day a later migration grants one by mistake. The five operations below
-- run as the owner, whom RLS does not restrict (it is not forced), so they are unaffected.
alter table tmpos_session.session enable row level security;

-- =============================================================================
-- 4) The five fixed session-store operations
-- =============================================================================
-- Together these are the SessionStore contract (server/runtime/memorySessionStore.testkit.ts
-- assertSessionStoreContract) expressed where it cannot be bypassed.

-- CREATE. One row, or none. A key that already exists is 'conflict' and nothing is written: a session
-- identifier is 32 random bytes, so a collision means something is wrong with the source of randomness,
-- and overwriting the existing session would hand one principal's record to another's identifier.
--
-- It also deletes this principal's OWN LONG-expired rows in this audience first. That bounds each
-- RETURNING principal's rows at the only moment a principal is known to be present, without a scan and
-- without a read doing a write. It does not bound the table: the expired rows of a principal who never
-- signs in again stay until a global sweep removes them, and that sweep belongs to an operational job
-- this migration does not create (doc 08 DA-37). Until one exists they also keep the rollback refusing.
--
-- WHY A DAY'S GRACE AND NOT `expires_at <= p_created_at`. The instant is the CALLER's, and instances
-- sharing this store need not agree on the time. A login arriving from an instance whose clock has
-- jumped forward would otherwise delete that principal's sessions on every OTHER instance — sessions
-- with real time left — as a side effect of signing in. A day is far beyond any skew a cluster
-- tolerates and far below the rate at which rows would accumulate, so the bound holds and the
-- destructive direction is closed. Nothing depends on a row being pruned promptly: a read never
-- returns an expired record, so an unpruned row is invisible until it is removed.
create function tmpos_session.m5_session_create(
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
  p_expires_at        bigint
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  delete from tmpos_session.session s
   where s.audience = p_audience
     and s.principal_key = p_principal_key
     and s.expires_at <= p_created_at - 86400000;  -- one day behind the caller's clock

  insert into tmpos_session.session (
    session_key, audience, auth_provider, auth_provider_uid, principal_key,
    security_version, authenticated_at, created_at, last_seen_at, validated_at, expires_at)
  values (
    p_session_key, p_audience, p_auth_provider, p_auth_provider_uid, p_principal_key,
    p_security_version, p_authenticated_at, p_created_at, p_last_seen_at, p_validated_at, p_expires_at)
  on conflict (session_key) do nothing;

  if not found then
    return 'conflict';
  end if;
  return 'created';
end
$$;

comment on function tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint) is
  'Phase 4.0 M5: writes one session record, or ''conflict'' when its key is already taken; never overwrites. Prunes the same principal''s rows in the same audience that expired more than a day before the caller''s instant.';

-- GET. The live record, or no row at all. An expired record is not returned and is not deleted here:
-- a read that wrote would turn every authenticated request into a write, and the runtime's own reader
-- refuses an expired record independently (sessions.ts liveSession), so nothing depends on the deletion.
--
-- The column names are the runtime's own field names, so the adapter hands the record to the reader
-- without renaming anything — a rename is a place a field could be dropped or crossed.
create function tmpos_session.m5_session_get(p_session_key text, p_now bigint)
returns table (
  audience          text,
  "authProvider"    text,
  "authProviderUid" text,
  "principalKey"    text,
  "securityVersion" text,
  "authenticatedAt" bigint,
  "createdAt"       bigint,
  "lastSeenAt"      bigint,
  "validatedAt"     bigint
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select s.audience, s.auth_provider, s.auth_provider_uid, s.principal_key,
         s.security_version, s.authenticated_at, s.created_at, s.last_seen_at, s.validated_at
    from tmpos_session.session s
   where s.session_key = p_session_key
     and s.expires_at > p_now;
$$;

comment on function tmpos_session.m5_session_get(text, bigint) is
  'Phase 4.0 M5: one live session record, or no row. An expired record is never returned. Column names are the runtime''s own field names.';

-- TOUCH. Slides exactly one stamp on an EXISTING row, and can create nothing: the update matches a row
-- or it does not. The field is named by a closed word, never by an identifier the caller composes, and a
-- stamp is written AS GIVEN: monotonicity belongs to the runtime, which already clamps it
-- (sessions.ts refresh takes `Math.max(now, lastSeenAt)`), and a greatest() here would silently
-- diverge from the port's contract — an update that reported success while changing nothing.
create function tmpos_session.m5_session_touch(p_session_key text, p_field text, p_value bigint)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- `p_field is null` first: `null not in (...)` is NULL, not true, so without it a null field would
  -- fall through, match the row, change nothing and answer 'updated'.
  if p_field is null or p_field not in ('lastSeenAt', 'validatedAt') or p_value is null then
    return 'invalid';
  end if;

  -- The value AS GIVEN, not greatest(stored, given). The port says an update "changes" the named field
  -- (sessions.ts SessionUpdate) and its reference store overwrites unconditionally; a store that
  -- silently kept a larger stored value would answer a later read with something its caller never
  -- wrote, and would differ from the reference for the same call. Monotonicity is the RUNTIME's
  -- concern and it already enforces it (sessions.ts refresh passes Math.max(now, lastSeenAt)), so
  -- doing it again here buys nothing and costs the contract.
  update tmpos_session.session s
     set last_seen_at = case when p_field = 'lastSeenAt' then p_value else s.last_seen_at end,
         validated_at = case when p_field = 'validatedAt' then p_value else s.validated_at end
   where s.session_key = p_session_key;

  if not found then
    return 'absent';
  end if;
  return 'updated';
end
$$;

comment on function tmpos_session.m5_session_touch(text, text, bigint) is
  'Phase 4.0 M5: slides one named stamp on an existing session; never creates a row. The value is written as given — the runtime owns monotonicity. ''absent'' when no such session exists.';

-- REVOKE. Final and idempotent: the session is gone afterwards whether or not it was there before, so a
-- caller cannot learn from the answer whether a key named a live session.
create function tmpos_session.m5_session_revoke(p_session_key text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  delete from tmpos_session.session s where s.session_key = p_session_key;
  return 'revoked';
end
$$;

comment on function tmpos_session.m5_session_revoke(text) is
  'Phase 4.0 M5: ends one session. Final and idempotent; the answer does not reveal whether the key named a live session.';

-- REVOKE PRINCIPAL. Every session of ONE principal in ONE audience, and nothing else — the other
-- audience's sessions and every other principal's are untouched.
create function tmpos_session.m5_session_revoke_principal(p_audience text, p_principal_key text)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_ended integer;
begin
  delete from tmpos_session.session s
   where s.audience = p_audience
     and s.principal_key = p_principal_key;
  get diagnostics v_ended = row_count;
  return v_ended;
end
$$;

comment on function tmpos_session.m5_session_revoke_principal(text, text) is
  'Phase 4.0 M5: ends every session of one principal in one audience and nothing else; answers how many ended.';

-- =============================================================================
-- 5) The tenant admission read
-- =============================================================================
-- ONE ROW OUT, in exactly the shape 007's resolution routine answers with, plus one field on each
-- membership: 'tenantAccessVersion', the tenant's current access version as decimal text (the runtime
-- compares it for equality and never parses it). A grant at platform scope names no tenant and carries
-- an explicit null there, so the key is present on every membership and the caller's exact-keys check
-- holds for all of them.
--
-- IT DECIDES NO AUTHORITY. Holding EXECUTE on this routine is not permission to act as anyone: it
-- answers what the database already says about a provider reference the authentication boundary
-- verified, and the runtime decides what that permits.
--
-- FAIL CLOSED. Every refusal is the same single row, so no caller learns whether a provider reference,
-- an actor, a tenant or a grant exists. A tenant-scoped grant whose tenant has no readable access
-- version admits nothing: a session admitted against an unknown witness could never be revoked by
-- moving that witness, which is the one guarantee this boundary exists to provide. It is not answered
-- as a refusal either — it RAISES (see below), because a refusal would revoke every session the
-- principal holds and this is a fault in the database, not a fact about the principal.
create function tmpos_session.m5_admit_tenant_session(p_auth_provider text, p_auth_provider_uid text)
returns table (
  outcome          text,
  actor_id         uuid,
  account_status   text,
  limitation       text,
  security_version text,
  memberships      jsonb
)
language plpgsql
-- STABLE IS LOAD-BEARING, NOT DECORATION. This routine runs TWO statements — 007's resolution, then the
-- access-version join — and they must agree. A VOLATILE plpgsql function takes a NEW snapshot for each
-- statement, so a suspension committing between them would show statement 1 a still-active membership
-- and statement 2 the already-moved access version: one request would be authorized against a tenant
-- that was suspended microseconds earlier. A STABLE function uses the CALLING QUERY's snapshot for
-- every statement it runs, so both reads see one instant and the pair is consistent. Do not relax it.
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_resolved record;
  v_memberships jsonb;
  v_unwitnessed integer;
begin
  -- STRICT, and it matters which way this fails. 007 answers exactly one row; if it ever answered none,
  -- a plain SELECT INTO would leave v_resolved all-NULL, `outcome is distinct from 'resolved'` would be
  -- true, and this routine would answer REFUSED — which the boundary reads as "this principal may hold
  -- no session here" and acts on by revoking EVERY session that principal holds. A broken routine must
  -- not mass-revoke anyone. STRICT raises instead, the caller's transaction fails, and the adapter
  -- reports the outage it is (fail closed, nothing revoked).
  select r.outcome, r.actor_id, r.account_status, r.limitation, r.security_version, r.memberships
    into strict v_resolved
    from tmpos_identity.m5_resolve_principal(p_auth_provider, p_auth_provider_uid) r;

  if v_resolved.outcome is distinct from 'resolved' then
    return query select 'refused'::text, null::uuid, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  -- Each membership as 007 wrote it, with the witness added. Ordered by membership id AS A UUID, which
  -- is exactly how 007 orders its own array (`order by g.membership_id`, a uuid column), so one
  -- unchanged state always produces one unchanged answer — the caller digests this array, and an
  -- unstable order would move the digest without anything having changed.
  --
  -- THE CAST IS LOAD-BEARING. `->>` yields text, and ordering text is COLLATION-dependent: a database
  -- whose collation treats the hyphens in a UUID as ignorable sorts these differently from the uuid
  -- type, and a collation change under an operating-system or ICU upgrade would reorder them again.
  -- Either would move every witness at once and sign every user out, for no change in anyone's
  -- standing. Ordering by the uuid is byte order, which no collation can move.
  select coalesce(
           pg_catalog.jsonb_agg(
             m.entry operator(pg_catalog.||) pg_catalog.jsonb_build_object(
               'tenantAccessVersion',
               case when m.entry operator(pg_catalog.->>) 'tenantId' is null then null
                    else (select t.access_version::text
                            from public.tenant t
                           where t.tenant_id = (m.entry operator(pg_catalog.->>) 'tenantId')::uuid)
               end)
             order by (m.entry operator(pg_catalog.->>) 'membershipId')::uuid),
           '[]'::jsonb)
    into v_memberships
    from pg_catalog.jsonb_array_elements(v_resolved.memberships) as m(entry);

  select pg_catalog.count(*)::integer
    into v_unwitnessed
    from pg_catalog.jsonb_array_elements(v_memberships) as x(entry)
   where x.entry operator(pg_catalog.->>) 'tenantId' is not null
     and x.entry operator(pg_catalog.->>) 'tenantAccessVersion' is null;

  -- A TENANT GRANT WITH NO WITNESS IS A FAULT, NOT A VERDICT — and the difference is the whole
  -- estate. 007 resolved this grant against a tenant row in this same snapshot, so the only way the
  -- access version is missing is that THIS routine sees less of public.tenant than 007's does: its
  -- owner lost membership in public.tenant's owner, or the objects were recreated under another owner.
  -- Answering 'refused' would tell the boundary that the principal may hold no session here, and the
  -- boundary acts on that by deleting every session it holds — so a privilege drift would sign every
  -- tenant user out of every device at once and refuse every new login until someone repaired the
  -- database. RAISING makes the caller's transaction fail, the adapter report the outage it is, and
  -- the boundary revoke nothing. Same reasoning as the INTO STRICT above.
  --
  -- WHAT IT DOES NOT COVER. A drift that hides the rows from 007's resolver TOO — FORCEd row security
  -- on public.tenant, which hides them from both owners — never reaches this line: 007 drops the grant
  -- first, and the answer is a principal with no grant, which the boundary refuses and revokes.
  -- Section 1 refuses to apply over that state; a FORCE added afterwards is recorded in doc 08 DA-40.
  if v_unwitnessed > 0 then
    raise exception 'migration 011 admission failed: % tenant grant(s) carry no access version, which means this routine cannot read public.tenant', v_unwitnessed
      using errcode = 'insufficient_privilege',
            hint = 'check that this routine''s owner still has privileges of public.tenant''s owner, as the owner of 007''s resolver does';
  end if;

  return query select 'resolved'::text, v_resolved.actor_id, v_resolved.account_status,
                      v_resolved.limitation, v_resolved.security_version, v_memberships;
end
$$;

comment on function tmpos_session.m5_admit_tenant_session(text, text) is
  'Phase 4.0 M5: the tenant boundary''s admission read — 007''s resolved principal with each membership''s current tenant access version (migration 010) attached. One row, every refusal identical; it raises instead when it cannot read a tenant''s access version or 007 answers other than one row, so a fault is never a refusal. Read-only, takes no lock, returns no provider reference, and decides no authority.';

-- =============================================================================
-- 6) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default. Every routine above therefore has
-- that default removed explicitly before the one intended grant is issued; an `IN SCHEMA` revoke would
-- not do, because it would also silently cover a routine this file did not create.
revoke all on function tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function tmpos_session.m5_session_get(text, bigint) from public, anon, authenticated;
revoke all on function tmpos_session.m5_session_touch(text, text, bigint) from public, anon, authenticated;
revoke all on function tmpos_session.m5_session_revoke(text) from public, anon, authenticated;
revoke all on function tmpos_session.m5_session_revoke_principal(text, text) from public, anon, authenticated;
revoke all on function tmpos_session.m5_admit_tenant_session(text, text) from public, anon, authenticated;

grant execute on function tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint) to tmpos_app;
grant execute on function tmpos_session.m5_session_get(text, bigint) to tmpos_app;
grant execute on function tmpos_session.m5_session_touch(text, text, bigint) to tmpos_app;
grant execute on function tmpos_session.m5_session_revoke(text) to tmpos_app;
grant execute on function tmpos_session.m5_session_revoke_principal(text, text) to tmpos_app;
grant execute on function tmpos_session.m5_admit_tenant_session(text, text) to tmpos_app;

-- The postcondition, proven rather than asserted. This file refuses to finish unless, at this moment:
--   * the session table carries NO direct grant to any role but its owner — so the runtime cannot read,
--     write or delete a session except through the operations above;
--   * every routine in this schema carries no direct grant beyond the owner's own and EXECUTE to
--     tmpos_app — a wider grantee, or a grant of anything else, is a widening this file did not intend;
--   * the schema itself grants nothing beyond USAGE to tmpos_app.
-- aclexplode() is used rather than reading the ACL as text because it breaks every grant out as its own
-- row — a direct grant, a PUBLIC grant, and the grant option each one carries — so none of them can hide
-- inside a formatted string. A NULL ACL means PostgreSQL's built-in default (for a routine, EXECUTE to
-- PUBLIC), and aclexplode(NULL) yields nothing, so each object ACL is read through
-- coalesce(acl, acldefault(kind, owner)), as migrations 006-010 do. It is applied to all FOUR places a
-- privilege on these objects can live: the table's relacl, its columns' attacl (a column grant lives
-- there and NOT in relacl, so checking relacl alone would miss `grant select (session_key) on ... to`),
-- the routines' proacl and the schema's nspacl. The grant option is asserted false everywhere, because
-- a grantee holding it could widen its own reach without any further migration.
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee: a later DDL
-- statement outside these migrations could add an object to this schema or a grant to these. That is
-- inherent to a migration-time check and is named rather than implied.
do $$
declare
  v_owner oid;
  v_bad text;
begin
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'tmpos_session.session'::regclass;

  -- The table itself, AND every column of it: a column privilege lives in pg_attribute.attacl, which
  -- relacl does not mention, so a check of relacl alone would declare a column-granted table clean.
  select pg_catalog.string_agg(x.detail, ', ')
    into v_bad
    from (
      select pg_catalog.format('table %s:%s', g.grantee::regrole::text, g.privilege_type) as detail
        from pg_catalog.pg_class c,
             pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
       where c.oid = 'tmpos_session.session'::regclass
         and g.grantee <> v_owner
      union all
      select pg_catalog.format('column %s %s:%s', a.attname, g.grantee::regrole::text, g.privilege_type)
        from pg_catalog.pg_attribute a,
             pg_catalog.aclexplode(a.attacl) g
       where a.attrelid = 'tmpos_session.session'::regclass
         and not a.attisdropped
         and g.grantee <> v_owner
    ) x;
  if v_bad is not null then
    raise exception 'migration 011 refused: tmpos_session.session carries a direct grant (%), but the runtime must reach it only through the fixed operations', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_session'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 011 refused: an unexpected direct grant remains on a routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_session'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 011 refused: schema tmpos_session carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Exactly the six routines this file creates, and nothing else, live in the schema.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_session'::regnamespace) <> 6 then
    raise exception 'migration 011 refused: schema tmpos_session does not hold exactly the six routines this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- MEMBERSHIP, WHICH AN ACL CANNOT SHOW. Every check above excludes the owner, and ACL introspection
  -- is blind to role membership: a role that is a MEMBER of the owning role holds everything the owner
  -- holds on this table — including the right to read and write it directly, and an RLS bypass, since
  -- PostgreSQL judges "am I the owner" by membership. So a role could reach this table with an empty
  -- ACL and every assertion above would still pass. Migration 010 makes exactly this check for its own
  -- schema; 011 makes it for this one. The four roles are the ones these migrations own; who the
  -- runtime LOGIN is, and what it is a member of, stays role topology verified live (gate G-DBROLE).
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_session'
      union
      select c.relowner from pg_catalog.pg_class c where c.oid = 'tmpos_session.session'::regclass
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 011 refused: % is a member of an owner this schema or its table depends on', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct read and write of every session row';
  end if;

  -- EFFECTIVE privilege, which sees every path at once — a direct grant, a grant to PUBLIC, one
  -- inherited through a role, and a predefined role such as pg_read_all_data or pg_write_all_data,
  -- none of which an ACL on this table would show. The ACL checks above prove no grant was WRITTEN;
  -- this proves none is HELD, which is the property that actually matters. The same four roles as the
  -- membership check, because a runtime login holds tmpos_audit_writer as well as tmpos_app; and
  -- MAINTAIN too on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it
  -- on 16.
  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_table_privilege(r.oid, 'tmpos_session.session'::regclass,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 011 refused: % holds an effective privilege on tmpos_session.session', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

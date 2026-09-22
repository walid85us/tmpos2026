-- Phase 4.0 M6 — the distributed rate-limit store: the shared buckets every runtime instance counts requests in, and
-- the fingerprint of the key their pseudonyms are made with (M6-RATE-P2; G-IDEMPOT, G-UNAUTH, G-CPLOGIN;
-- docs/phase-4/10 ADR-26)
-- Migration: 014_m6_distributed_rate_limit (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, TWO TABLES, FOUR ROUTINES, NO NEW ROLE. This file creates schema tmpos_rate_limit, the bucket
--     table, the one-row key-fingerprint table, the consume, probe and reclaim routines the runtime calls, and the key
--     check the consume and the probe share. It creates no role, no role membership, no type, no trigger and no
--     sequence, and changes nothing an earlier migration created: migrations 001-013 are untouched, byte for byte.
--   - WHAT IT IMPLEMENTS. The DistributedRateLimiter port (server/runtime/rateLimit.ts), whose contract every adapter
--     meets and whose conformance suite (rateLimiter.testkit.ts) runs against this store unchanged. A bucket is
--     (namespace, dimension, key, limit, window): a changed policy starts fresh buckets instead of reinterpreting old
--     counts, so one policy's limit or window can never contaminate another's. Its window opens at the first consume
--     of an absent or expired bucket and lasts the window exactly; no consume extends it. A consume of `cost` is
--     allowed iff the bucket's count plus the cost stays within the limit: it adds the cost and answers what remains.
--     Otherwise it changes neither the count nor the expiry and answers the time left in the window, in whole
--     milliseconds, 1..window. Every time is the DATABASE's clock (clock_timestamp(), read after an existing bucket is
--     locked, just before an absent one is created, or after the unlocked read that decides a refusal), so instances
--     whose own clocks disagree still share one window. A creation that waits behind a concurrent one that then rolls
--     back opens its window at its own reading, early by at most that wait, which its 300 ms statement bound caps.
--   - ATOMIC ACROSS INSTANCES. A consume locks its bucket row (FOR NO KEY UPDATE) before it reads the count, so two
--     consumes of one bucket — from one instance or from many — serialize on that row and each sees the other's
--     cost. An absent bucket is created by an INSERT that loses cleanly to a concurrent one (ON CONFLICT DO NOTHING
--     waits for the winner, then the loser locks the winner's row), so two first consumes cannot both open a window.
--     This relies on READ COMMITTED, the runtime kernel's isolation: each statement of the routine sees what
--     committed before it began. Under a stricter isolation level the same races raise a serialization failure, which
--     the adapter answers as unavailable — closed, never open. One case takes no lock: a consume the committed state
--     already refuses — a live window whose count plus the cost exceeds the limit — is answered from an unlocked read
--     and writes nothing. Inside a window the count only grows, and neither a reopen nor a reclaim can replace the
--     window before it expires, so that refusal stands however the read interleaves with other consumes; a flood of
--     refused consumes then costs no transaction ID, no WAL and no wait on the row. That argument assumes the database
--     clock does not step backwards: if it does, a refusal can rarely be decided on a window a concurrent consume has
--     just reopened — a 429 where an allowance was due, never an allowance where a limit was.
--   - WHAT IS STORED. The pseudonymous limiter key (43 base64url characters: HMAC-SHA256 under the deployment's
--     RATE_LIMIT_KEY), the namespace, dimension and policy, the count and the window. Never a client address, a
--     provider UID or account identifier, a token, a cookie, a header or any part of a request, and never
--     RATE_LIMIT_KEY itself: the key reaches this database only as a keyed fingerprint (next point), and the
--     pseudonyms cannot be reversed without it.
--   - KEY SKEW. Every instance must key pseudonyms with the same RATE_LIMIT_KEY, or one client becomes a different
--     bucket on each instance and every limit multiplies. So the store holds the key's FINGERPRINT —
--     HMAC-SHA256(RATE_LIMIT_KEY, 'tmpos-rate-limit-key-fingerprint:v1'), a constant used for nothing else, 32 bytes
--     that reveal nothing usable of the key — in a table of exactly one row. The first consume or probe on a store
--     without one registers its own, atomically (the same INSERT race as a bucket's); every later consume or probe
--     that reaches the key check must present the same fingerprint, and a different one is answered 'key_mismatch'
--     before any bucket is read — a consume the adapter turns into unavailable, a probe into not ready. Nothing here
--     erases or replaces the fingerprint: no routine writes it again, the runtime holds no privilege on its table, and
--     it leaves the store only through this migration's rollback or the owner's manual recovery (ADR-26). Rotating
--     RATE_LIMIT_KEY therefore needs an explicitly designed, coordinated procedure; this file provides none, and
--     deliberately no reset.
--   - STORAGE GROWTH. An expired bucket is reused in place by the next consume of it, and reclaimed otherwise — by
--     m6_rate_limit_reclaim, never by the consume: each call deletes at most FOUR buckets that expired before its clock
--     reading, oldest first, through the expiry index, skipping every row another transaction holds (FOR UPDATE SKIP
--     LOCKED), so it never waits, never touches a live window, and leaves a bucket some consume is reopening to that
--     consume. The adapter owes one call for each consume that opened a window — the only kind that can add a row —
--     and makes them one at a time per instance, each in a transaction of its own under bounds (50 ms each for a lock
--     wait, a statement and idle) well inside the consume's 200 ms lock wait: a consume of an expired bucket a reclaim
--     holds at that moment waits for the reclaim's short transaction and then opens a fresh window, and a reclaim that
--     fails or times out changes no consume's answer. The next owed call runs only after one that deleted a full four;
--     one that deletes fewer, or fails, ends what is owed. So each window opened is matched by up to four reclaimed
--     while a backlog remains and reclaims succeed — during a burst of new clients windows can open faster than one
--     reclaim at a time clears them, and with no traffic the backlog stays until the next window opens. The probe never
--     reclaims. There is no timer, no sweep and no worker.
--   - THE RUNTIME NEVER TOUCHES A TABLE. tmpos_app receives USAGE on the schema and EXECUTE on the consume, probe and
--     reclaim routines only; nothing on either table, any column or the key check. Section 6 proves it.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified, and every routine pins its search_path to pg_catalog
--     then pg_temp.
--
-- Reversible via 014_m6_distributed_rate_limit.down.sql, which REFUSES while any bucket is still inside its window —
-- dropping a live bucket would hand its client a fresh allowance — and otherwise removes exactly what this file created,
-- the registered fingerprint with it.
--
-- Assumes 001-013 are applied. A future managed apply targets the complete contiguous chain through the newest
-- committed migration — now 001-014 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 013 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_admission.m5_admit_platform_session(text, text)') is null then
    raise exception 'migration 014 refused: migration 013 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime role this file grants to (005).
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 014 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_rate_limit;

comment on schema tmpos_rate_limit is
  'Phase 4.0 M6 (migration 014): the distributed rate-limit store — shared fixed-window buckets keyed by pseudonymous limiter keys, and the fingerprint of the key those pseudonyms are made with. Owned by this migration; tmpos_app holds USAGE and EXECUTE on the consume, probe and reclaim routines only, and no privilege on either table.';

revoke all on schema tmpos_rate_limit from public, anon, authenticated;
grant usage on schema tmpos_rate_limit to tmpos_app;

-- =============================================================================
-- 3) The tables
-- =============================================================================
-- One row per bucket. The primary key is the whole bucket identity, so a bucket of one policy is never another's.
-- `consumed` is at least 1: a bucket exists only once a consume has succeeded in it. Updates mostly change
-- `consumed` alone, which no index covers; the fill factor leaves room on each page for those updates to stay there.
create table tmpos_rate_limit.bucket (
  namespace    text        not null
               constraint bucket_namespace_chk check (namespace in ('runtime', 'tenant', 'admin', 'tenant-login', 'admin-login')),
  dimension    text        not null
               constraint bucket_dimension_chk check (dimension in ('client', 'account', 'tenant', 'store')),
  limiter_key  text        not null
               constraint bucket_limiter_key_chk check (pg_catalog.octet_length(limiter_key) = 43 and limiter_key !~ '[^A-Za-z0-9_-]'),
  limit_count  integer     not null
               constraint bucket_limit_chk check (limit_count between 1 and 1000000),
  window_ms    integer     not null
               constraint bucket_window_chk check (window_ms between 1000 and 3600000),
  consumed     integer     not null,
  window_start timestamptz not null,
  expires_at   timestamptz not null,
  constraint bucket_pkey primary key (namespace, dimension, limiter_key, limit_count, window_ms),
  constraint bucket_consumed_chk check (consumed between 1 and limit_count),
  constraint bucket_expiry_chk check (expires_at = window_start + window_ms * interval '1 millisecond')
) with (fillfactor = 70);

create index bucket_expires_at_idx on tmpos_rate_limit.bucket (expires_at);

comment on table tmpos_rate_limit.bucket is
  'Phase 4.0 M6 (migration 014): one fixed-window rate-limit bucket per (namespace, dimension, pseudonymous limiter key, limit, window). Holds no client address, account identifier, token, cookie or request data. Read and written only by m6_rate_limit_consume and m6_rate_limit_reclaim, which deletes only expired rows; tmpos_app holds no privilege on it.';

-- Exactly one row once a consume or probe has reached the key check: the fingerprint of the RATE_LIMIT_KEY every
-- instance must share.
create table tmpos_rate_limit.key_fingerprint (
  singleton     boolean     not null default true
                constraint key_fingerprint_pkey primary key
                constraint key_fingerprint_singleton_chk check (singleton),
  fingerprint   bytea       not null
                constraint key_fingerprint_length_chk check (pg_catalog.octet_length(fingerprint) = 32),
  registered_at timestamptz not null default pg_catalog.clock_timestamp()
);

comment on table tmpos_rate_limit.key_fingerprint is
  'Phase 4.0 M6 (migration 014): the one registered fingerprint of RATE_LIMIT_KEY — HMAC-SHA256(key, ''tmpos-rate-limit-key-fingerprint:v1''), never the key. Registered by the first consume or probe; never updated or deleted by any routine; removed only by this migration''s rollback or the owner''s manual recovery (ADR-26). tmpos_app holds no privilege on it.';

revoke all on table tmpos_rate_limit.bucket from public, anon, authenticated;
revoke all on table tmpos_rate_limit.key_fingerprint from public, anon, authenticated;

-- Defence in depth: with no policy, row level security admits no row to anyone but the owner, whose routines are
-- the only way in.
alter table tmpos_rate_limit.bucket enable row level security;
alter table tmpos_rate_limit.key_fingerprint enable row level security;

-- =============================================================================
-- 4) The key check: one definition, shared by the consume and the probe
-- =============================================================================
-- SECURITY INVOKER and granted to nobody: it runs only inside the consume and the probe below, as their owner. Anyone else
-- calling it would hold no privilege on the table it reads.
create function tmpos_rate_limit.m6_rate_limit_key_admits(p_key_fingerprint bytea)
returns boolean
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_registered bytea;
begin
  if p_key_fingerprint is null or pg_catalog.octet_length(p_key_fingerprint) <> 32 then
    raise exception 'rate-limit key check refused: a key fingerprint is exactly 32 bytes'
      using errcode = 'invalid_parameter_value';
  end if;

  select f.fingerprint into v_registered from tmpos_rate_limit.key_fingerprint f where f.singleton;
  if not found then
    -- The first caller registers its fingerprint. Two first callers race on the one row: the loser's INSERT waits for
    -- the winner's transaction, then does nothing, and the loser compares against what the winner registered — a
    -- fresh statement, so it sees it. If the winner rolled back instead, the loser's INSERT registers its own.
    insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint)
    values (true, p_key_fingerprint)
    on conflict on constraint key_fingerprint_pkey do nothing;
    select f.fingerprint into strict v_registered from tmpos_rate_limit.key_fingerprint f where f.singleton;
  end if;

  return v_registered = p_key_fingerprint;
end
$$;

comment on function tmpos_rate_limit.m6_rate_limit_key_admits(bytea) is
  'Phase 4.0 M6 (migration 014): whether a caller''s RATE_LIMIT_KEY fingerprint is the registered one, registering it when none is. Never replaces a registered fingerprint. Called only by m6_rate_limit_consume and m6_rate_limit_probe; granted to nobody.';

-- =============================================================================
-- 5) The consume, the probe and the reclaim
-- =============================================================================
create function tmpos_rate_limit.m6_rate_limit_consume(
  p_key_fingerprint bytea,
  p_namespace       text,
  p_dimension       text,
  p_limiter_key     text,
  p_limit           integer,
  p_window_ms       integer,
  p_cost            integer
)
returns table (outcome text, remaining integer, retry_after_ms integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_window   interval;
  v_locked   boolean := false;
  v_consumed integer;
  v_expires  timestamptz;
  v_now      timestamptz;
  v_outcome  text;
  v_left     integer;
  v_wait     integer;
begin
  -- The port's bounds (rateLimit.ts RATE_LIMIT_BOUNDS), and a pseudonymous key, or nothing is counted.
  if p_namespace is null or p_namespace not in ('runtime', 'tenant', 'admin', 'tenant-login', 'admin-login')
     or p_dimension is null or p_dimension not in ('client', 'account', 'tenant', 'store')
     or p_limiter_key is null or pg_catalog.octet_length(p_limiter_key) <> 43 or p_limiter_key ~ '[^A-Za-z0-9_-]'
     or p_limit is null or p_limit not between 1 and 1000000
     or p_window_ms is null or p_window_ms not between 1000 and 3600000
     or p_cost is null or p_cost not between 1 and p_limit then
    raise exception 'rate-limit consume refused: the request is outside the limiter contract'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A caller keyed with another RATE_LIMIT_KEY counts nothing, and reads no bucket.
  if not tmpos_rate_limit.m6_rate_limit_key_admits(p_key_fingerprint) then
    return query select 'key_mismatch'::text, null::integer, null::integer;
    return;
  end if;

  v_window := p_window_ms * interval '1 millisecond';

  -- A consume the committed state already refuses is answered without the row lock, and writes nothing (header,
  -- ATOMIC ACROSS INSTANCES): the window read is live at the clock reading taken after it, and until it expires its
  -- count can only grow and nothing can replace it — on a clock that does not step backwards; if it does, the error is a
  -- refusal, never an allowance.
  select b.consumed, b.expires_at
    into v_consumed, v_expires
    from tmpos_rate_limit.bucket b
   where b.namespace = p_namespace and b.dimension = p_dimension and b.limiter_key = p_limiter_key
     and b.limit_count = p_limit and b.window_ms = p_window_ms;
  if found then
    v_now := pg_catalog.clock_timestamp();
    if v_expires > v_now and v_consumed + p_cost > p_limit then
      return query select 'limited'::text, null::integer,
        least(greatest(pg_catalog.ceil(extract(epoch from v_expires - v_now) * 1000), 1), p_window_ms)::integer;
      return;
    end if;
  end if;

  -- The bucket, locked; or, when there is none, created by this consume. A lost creation race is followed by
  -- locking the winner's row; a bucket reclaimed while this waited for its lock is simply absent, and created
  -- afresh. Three rounds cannot all be lost to ordinary traffic; if they are, nothing was counted.
  for v_attempt in 1 .. 3 loop
    select b.consumed, b.expires_at
      into v_consumed, v_expires
      from tmpos_rate_limit.bucket b
     where b.namespace = p_namespace and b.dimension = p_dimension and b.limiter_key = p_limiter_key
       and b.limit_count = p_limit and b.window_ms = p_window_ms
       for no key update of b;
    if found then
      v_locked := true;
      exit;
    end if;

    v_now := pg_catalog.clock_timestamp();
    insert into tmpos_rate_limit.bucket
      (namespace, dimension, limiter_key, limit_count, window_ms, consumed, window_start, expires_at)
    values (p_namespace, p_dimension, p_limiter_key, p_limit, p_window_ms, p_cost, v_now, v_now + v_window)
    on conflict on constraint bucket_pkey do nothing;
    if found then
      -- The first consume of the bucket opens its window.
      v_outcome := 'allowed';
      v_left := p_limit - p_cost;
      exit;
    end if;
  end loop;

  if v_outcome is null then
    if not v_locked then
      raise exception 'rate-limit consume refused: the bucket could not be locked'
        using errcode = 'serialization_failure';
    end if;

    -- Read after the lock is held, so no consume that committed before it is missed.
    v_now := pg_catalog.clock_timestamp();
    if v_expires <= v_now then
      -- The window has passed: this consume opens the next one, in place.
      update tmpos_rate_limit.bucket b
         set consumed = p_cost, window_start = v_now, expires_at = v_now + v_window
       where b.namespace = p_namespace and b.dimension = p_dimension and b.limiter_key = p_limiter_key
         and b.limit_count = p_limit and b.window_ms = p_window_ms;
      if not found then
        -- The row is locked and nothing here skips it; an update that changed no row would be an allowance counted
        -- nowhere, so it refuses instead.
        raise exception 'rate-limit consume refused: the bucket could not be updated'
          using errcode = 'serialization_failure';
      end if;
      v_outcome := 'allowed';
      v_left := p_limit - p_cost;
    elsif v_consumed + p_cost > p_limit then
      -- Refused: neither the count nor the expiry changes. The wait is what is left of the window, in exact numeric
      -- arithmetic (a floating-point epoch would round some whole milliseconds up), never less than one millisecond
      -- and — should the database clock ever step backwards — never more than the window.
      v_outcome := 'limited';
      v_wait := least(greatest(pg_catalog.ceil(extract(epoch from v_expires - v_now) * 1000), 1), p_window_ms)::integer;
    else
      update tmpos_rate_limit.bucket b
         set consumed = v_consumed + p_cost
       where b.namespace = p_namespace and b.dimension = p_dimension and b.limiter_key = p_limiter_key
         and b.limit_count = p_limit and b.window_ms = p_window_ms;
      if not found then
        raise exception 'rate-limit consume refused: the bucket could not be updated'
          using errcode = 'serialization_failure';
      end if;
      v_outcome := 'allowed';
      v_left := p_limit - (v_consumed + p_cost);
    end if;
  end if;

  if v_outcome = 'allowed' then
    return query select 'allowed'::text, v_left, null::integer;
  else
    return query select 'limited'::text, null::integer, v_wait;
  end if;
end
$$;

comment on function tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer) is
  'Phase 4.0 M6 (migration 014): one atomic fixed-window consume. One row: (''allowed'', remaining, null), (''limited'', null, retry-after ms on the database clock) or (''key_mismatch'', null, null). A refused consume changes nothing; a request outside the limiter contract raises. Reclaims nothing: m6_rate_limit_reclaim does.';

create function tmpos_rate_limit.m6_rate_limit_probe(p_key_fingerprint bytea)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Ready means the runtime could consume: the store accepts writes, the login running this may execute the consume
  -- routine, and its key is the registered one. No bucket is read, written or reclaimed. (Once a fingerprint is
  -- registered the rest of this routine only reads, so a read-only session or a standby would otherwise look ready
  -- while every consume failed.)
  if pg_catalog.pg_is_in_recovery() or pg_catalog.current_setting('transaction_read_only') <> 'off' then
    return query select 'store_read_only'::text;
    return;
  end if;
  if not pg_catalog.has_function_privilege(session_user,
       'tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer)', 'EXECUTE') then
    return query select 'consume_unavailable'::text;
    return;
  end if;
  if not tmpos_rate_limit.m6_rate_limit_key_admits(p_key_fingerprint) then
    return query select 'key_mismatch'::text;
    return;
  end if;
  return query select 'ready'::text;
end
$$;

comment on function tmpos_rate_limit.m6_rate_limit_probe(bytea) is
  'Phase 4.0 M6 (migration 014): readiness. One row: ''ready'' when the store accepts writes, the session''s login may execute m6_rate_limit_consume and the caller''s key fingerprint is the registered one (registering it when none is); ''store_read_only'', ''consume_unavailable'' or ''key_mismatch'' otherwise. Touches no bucket.';

-- Reclaim: its own routine, called by the adapter in a transaction of its own (header, STORAGE GROWTH) — never by the
-- consume and never by the probe. At most four buckets that expired before this call's clock reading, oldest first,
-- through the expiry index; a row another transaction holds is skipped, never waited on, so a bucket a consume is
-- reopening stays that consume's. Each is deleted by its primary key — never by a plan that could scan the table — and
-- the expiry test is repeated on the row as locked. It takes no argument — no key — and can remove nothing inside its
-- window. A caller holding tmpos_app's credential but not RATE_LIMIT_KEY can at most leave a call's transaction open,
-- holding up to four expired rows so that the next consume of those buckets waits out its lock bound and is refused —
-- less than that credential allows in any case, by holding connections.
create function tmpos_rate_limit.m6_rate_limit_reclaim()
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_now     timestamptz := pg_catalog.clock_timestamp();
  v_expired record;
  v_deleted integer := 0;
begin
  for v_expired in
    select e.namespace, e.dimension, e.limiter_key, e.limit_count, e.window_ms
      from tmpos_rate_limit.bucket e
     where e.expires_at <= v_now
     order by e.expires_at
     limit 4
       for update of e skip locked
  loop
    delete from tmpos_rate_limit.bucket d
     where d.namespace = v_expired.namespace and d.dimension = v_expired.dimension
       and d.limiter_key = v_expired.limiter_key and d.limit_count = v_expired.limit_count
       and d.window_ms = v_expired.window_ms and d.expires_at <= v_now;
    if found then
      v_deleted := v_deleted + 1;
    end if;
  end loop;
  return v_deleted;
end
$$;

comment on function tmpos_rate_limit.m6_rate_limit_reclaim() is
  'Phase 4.0 M6 (migration 014): deletes at most four buckets whose window closed before this call, oldest first, skipping any row another transaction holds; answers how many it deleted. Never waits on a lock and never touches a live window.';

revoke all on function tmpos_rate_limit.m6_rate_limit_key_admits(bytea) from public, anon, authenticated, tmpos_app;
revoke all on function tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function tmpos_rate_limit.m6_rate_limit_probe(bytea) from public, anon, authenticated;
revoke all on function tmpos_rate_limit.m6_rate_limit_reclaim() from public, anon, authenticated;
grant execute on function tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer) to tmpos_app;
grant execute on function tmpos_rate_limit.m6_rate_limit_probe(bytea) to tmpos_app;
grant execute on function tmpos_rate_limit.m6_rate_limit_reclaim() to tmpos_app;

-- =============================================================================
-- 6) Postconditions: the objects, their owner and every privilege on them, fail-closed
-- =============================================================================
do $$
declare
  v_owner oid;
  v_bad text;
  v_roles name[] := array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[];
begin
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_rate_limit';

  -- Exactly the four routines, each this schema owner's, each as declared: the consume, probe and reclaim SECURITY
  -- DEFINER, the key check SECURITY INVOKER, all VOLATILE, all with the pinned search path.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_rate_limit'::regnamespace) <> 4 then
    raise exception 'migration 014 refused: schema tmpos_rate_limit does not hold exactly the four routines this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_rate_limit'::regnamespace
     and (
          p.proname not in ('m6_rate_limit_key_admits', 'm6_rate_limit_consume', 'm6_rate_limit_probe', 'm6_rate_limit_reclaim')
       or p.proowner <> v_owner
       or p.prosecdef is distinct from (p.proname <> 'm6_rate_limit_key_admits')
       or p.provolatile <> 'v'
       or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
     );
  if v_bad is not null then
    raise exception 'migration 014 refused: a routine does not match its declaration (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Routine grants: tmpos_app may EXECUTE the consume, the probe and the reclaim, without grant option, and nothing else
  -- is granted.
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_rate_limit'::regnamespace
     and g.grantee <> p.proowner
     and not (p.proname in ('m6_rate_limit_consume', 'm6_rate_limit_probe', 'm6_rate_limit_reclaim')
              and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 014 refused: an unexpected direct grant remains on a routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'only tmpos_app may hold EXECUTE, only on the consume, the probe and the reclaim, and never WITH GRANT OPTION';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app',
       'tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_rate_limit.m6_rate_limit_probe(bytea)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_rate_limit.m6_rate_limit_reclaim()', 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app', 'tmpos_rate_limit.m6_rate_limit_key_admits(bytea)', 'EXECUTE') then
    raise exception 'migration 014 refused: tmpos_app''s effective EXECUTE is not exactly the consume, the probe and the reclaim'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- No other runtime-facing role may reach a routine at all — not by a grant, and not by membership in tmpos_app: one
  -- that could call the probe or the consume first could register a fingerprint of its choosing.
  select pg_catalog.string_agg(pg_catalog.format('%s on %s', r.rolname, p.proname), ', ' order by r.rolname, p.proname) into v_bad
    from pg_catalog.pg_roles r, pg_catalog.pg_proc p
   where r.rolname = any (v_roles) and r.rolname <> 'tmpos_app'
     and p.pronamespace = 'tmpos_rate_limit'::regnamespace
     and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 014 refused: a runtime-facing role other than tmpos_app can execute a rate-limit routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'no role but tmpos_app''s own members may call the limiter; check memberships in tmpos_app';
  end if;
  -- No runtime-facing role may be a member of tmpos_app at all, however the membership is granted: a NOINHERIT member
  -- holds no effective EXECUTE above yet may SET ROLE tmpos_app, and membership is refused outright rather than judged
  -- by its INHERIT and SET options.
  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.rolname = any (v_roles) and r.rolname <> 'tmpos_app'
     and pg_catalog.pg_has_role(r.oid, 'tmpos_app'::regrole, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 014 refused: % is a member of tmpos_app, and no runtime-facing role may be', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Table and column grants: none to anyone but the owner.
  select pg_catalog.string_agg(x.detail, ', ')
    into v_bad
    from (
      select pg_catalog.format('table %s %s:%s', c.relname, g.grantee::regrole::text, g.privilege_type) as detail
        from pg_catalog.pg_class c,
             pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
       where c.oid in ('tmpos_rate_limit.bucket'::regclass, 'tmpos_rate_limit.key_fingerprint'::regclass)
         and g.grantee <> c.relowner
      union all
      select pg_catalog.format('column %s.%s %s:%s', c.relname, a.attname, g.grantee::regrole::text, g.privilege_type)
        from pg_catalog.pg_class c
        join pg_catalog.pg_attribute a on a.attrelid = c.oid,
             pg_catalog.aclexplode(a.attacl) g
       where c.oid in ('tmpos_rate_limit.bucket'::regclass, 'tmpos_rate_limit.key_fingerprint'::regclass)
         and not a.attisdropped
         and g.grantee <> c.relowner
    ) x;
  if v_bad is not null then
    raise exception 'migration 014 refused: a rate-limit table carries a direct grant (%), but only the routines may read or write it', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s on %s', r.rolname, t.rel::text), ', ' order by r.rolname, t.rel::text) into v_bad
    from pg_catalog.pg_roles r
    cross join (values ('tmpos_rate_limit.bucket'::regclass), ('tmpos_rate_limit.key_fingerprint'::regclass)) t(rel)
   where r.rolname = any (v_roles)
     and pg_catalog.has_table_privilege(r.oid, t.rel,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 014 refused: an effective table privilege exists (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Schema grants: tmpos_app's USAGE, without grant option, and nothing else.
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_rate_limit'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 014 refused: schema tmpos_rate_limit carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- One owner for everything, and no runtime-facing role a member of it: membership would hand that role a direct
  -- write of every bucket and of the fingerprint.
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('tmpos_rate_limit.bucket'::regclass, 'tmpos_rate_limit.key_fingerprint'::regclass,
                              'tmpos_rate_limit.bucket_expires_at_idx'::regclass)
                and c.relowner <> v_owner) then
    raise exception 'migration 014 refused: a rate-limit table or index is not owned by the schema owner'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.rolname = any (v_roles)
     and pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 014 refused: % is a member of the owner of the rate-limit schema', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every bucket and of the key fingerprint';
  end if;

  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'tmpos_rate_limit.bucket'::regclass)
     or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'tmpos_rate_limit.key_fingerprint'::regclass) then
    raise exception 'migration 014 refused: row level security is not enabled on both rate-limit tables'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

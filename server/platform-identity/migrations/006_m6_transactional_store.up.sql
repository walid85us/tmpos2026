-- Phase 4.0 M6 — PostgreSQL transactional store for the idempotency, command-transaction and
-- outbox ports (G-IDEMPOT, G-AUDIT; docs/phase-4/10 ADR-17)
-- Migration: 006_m6_transactional_store (UP)
--
-- SCOPE / TRUTH (binding):
--   - SCHEMA FOR THREE PORTS ONLY: server/runtime/idempotency.ts (DurableIdempotencyStore),
--     server/runtime/commandTransaction.ts (CommandTransactionPort) and server/runtime/outbox.ts
--     (OutboxDeliveryStore), served by server/persistence/postgresTransactionalStore.ts. No business
--     table lives here: a command's aggregate is written by the source-defined mutator of its kind,
--     against the table that mutator names.
--   - ITS OWN INTERNAL SCHEMA, tmpos_internal. Every object this file creates lives there and none in
--     public, the schema a platform's data API exposes. The schema belongs to the principal that applies
--     this file, never to the runtime login, and only tmpos_app is granted USAGE on it. audit_event stays
--     in public: it is 002's, and the store only appends to it.
--   - MIGRATION FILE ONLY. Nothing here is applied automatically. It has been applied only to
--     disposable test databases — never to a managed, persistent, production or application database.
--     Migration 005 is itself unexecuted there, and while this file is pending the managed apply of 005
--     refuses by design (the exact-[005] plan gate in scripts/supabase-migrate.ts): sequencing the two is
--     a separate, unmade decision.
--   - NO ROLE IS CREATED, ALTERED OR DROPPED. The runtime reaches the store only through the NOLOGIN
--     privilege role migration 005 owns (tmpos_app). The audit record of a committed command is
--     appended through the existing writer into audit_event as tmpos_audit_writer (INSERT only): there
--     is no second audit table.
--   - THE RUNTIME ROLE HOLDS NO TABLE. tmpos_app may use the schema and execute the lifecycle routines
--     of section 3c, nothing else: no SELECT, INSERT, UPDATE or DELETE on either table and no EXECUTE on
--     the clock. Every lifecycle change is a routine's, decided on the store's clock and bound to the
--     lease or claim token its caller presents, which the runtime role cannot read.
--   - NO TENANT ISOLATION CLAIM. Records are keyed by keyed digests of the principal and the client's
--     key, never by tenant; tenant/store isolation needs M5's server-derived context. RLS is enabled on
--     both tables with no policy: defense in depth against a stray grant, not isolation between tenants.
--   - DIRECT GRANTS, NOT ROLE TOPOLOGY. Section 6 proves the direct object grants, the routines'
--     attributes and that no role this project names is a member of the owner. It does not see every
--     path of effective privilege through membership, or the ownership or superuser bypass; the runtime
--     login's memberships and attributes are verified live under G-DBROLE (docs/phase-4/08).
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION. Times are timestamptz on the store's own clock.
--
-- Reversible via 006_m6_transactional_store.down.sql, which refuses while the store holds work it
-- would destroy (an undelivered event or an idempotency record still within its retention).
--
-- Assumes the roles `anon` and `authenticated` exist, as 002, 004 and 005 already do, and that 005 has
-- created tmpos_app and tmpos_audit_writer.

-- =============================================================================
-- 0) This transaction's search path, and the internal schema
-- =============================================================================
-- The applier's search_path is never relied on. Every relation below is schema-qualified, and SET LOCAL
-- pins operator and function resolution to pg_catalog until this transaction ends, so an operator or
-- function that an earlier schema of the applier's path defines answers neither a constraint below nor
-- section 6's check.
set local search_path = pg_catalog, pg_temp;

create schema tmpos_internal;

comment on schema tmpos_internal is
  'Phase 4.0 M6: the transactional store (migration 006). Internal: USAGE to tmpos_app alone, owned by the migration principal.';

-- =============================================================================
-- 1) The store's clock
-- =============================================================================
-- Every expiry, retention and due-time decision reads THIS function, once per decision and only after
-- the row it decides about is locked, so one clock serves every instance and no instance's host clock is
-- ever consulted. Millisecond resolution, so the ports' millisecond arithmetic (a lease of 60 000 ms, a
-- retry due in 5 000 ms) is exact at every boundary.
-- Deliberately NOT now(): now() is the transaction's START, which a statement that waited on a lock
-- would read stale. The stamps a command carries (audit_event.occurred_at and each event's
-- occurred_at) ARE the transaction start — one timestamp for the whole commit — and are never an
-- input to a decision. Only the routines below and the guard call it; the runtime role cannot.
create function tmpos_internal.m6_store_clock()
returns timestamptz
language sql
volatile
set search_path = pg_catalog, pg_temp
as $$ select pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()) $$;

comment on function tmpos_internal.m6_store_clock() is
  'Phase 4.0 M6: the transactional store''s clock — clock_timestamp() at millisecond resolution. Every expiry, retention and due-time decision reads it after locking the row it decides about.';

-- =============================================================================
-- 2) idempotency_record — one row per operation scope
-- =============================================================================
-- scope, fingerprint and lease are 43-character base64url strings (32-byte keyed digests and a
-- 32-byte random fencing token); the raw client key, principal and body never reach this table.
-- A row is IN PROGRESS while response is null and COMPLETED once the sealed response is stored: an
-- opaque base64url string of at most 45 094 characters (MAX_SEALED_LENGTH), kept byte for byte.
-- A row past expires_at is absent to the ports and is overwritten in place by the next acquisition.
-- Both times are finite and before the year 10 000: an acquisition reads them back as epoch
-- milliseconds, and a value outside that range would fail every read of that row.
create table tmpos_internal.idempotency_record (
  scope            text        not null,
  fingerprint      text        not null,
  lease            text        not null,
  lease_expires_at timestamptz not null,
  expires_at       timestamptz not null,
  response         text,
  constraint idempotency_record_pkey primary key (scope),
  constraint idempotency_record_scope_chk check (scope ~ '^[A-Za-z0-9_-]{43}$'),
  constraint idempotency_record_fingerprint_chk check (fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  constraint idempotency_record_lease_chk check (lease ~ '^[A-Za-z0-9_-]{43}$'),
  constraint idempotency_record_expiry_chk check (
    pg_catalog.isfinite(lease_expires_at) and pg_catalog.isfinite(expires_at)
    and expires_at < timestamptz '10000-01-01 00:00:00+00' and lease_expires_at <= expires_at
  ),
  constraint idempotency_record_response_chk check (
    response is null
    or (pg_catalog.length(response) between 1 and 45094 and response ~ '^[A-Za-z0-9_-]+$')
  )
);

comment on table tmpos_internal.idempotency_record is
  'Phase 4.0 M6: durable idempotency records (DurableIdempotencyStore). Keyed digests and a fencing token only — no raw key, principal, request or body. RLS enabled, no policy; reached only through the lifecycle routines.';
comment on column tmpos_internal.idempotency_record.response is
  'The sealed response (AES-256-GCM under a subkey of IDEMPOTENCY_KEY, bound to scope and fingerprint): opaque to the store. Null while in progress.';

-- Retention: a later purge pass finds the records past their retention by this index.
create index idx_idempotency_record_expires_at on tmpos_internal.idempotency_record (expires_at);

-- =============================================================================
-- 3) outbox_event — one row per event, its immutable envelope and its delivery state
-- =============================================================================
-- The envelope columns (event_id … occurred_at) are written once, by the committing transaction, and the
-- guard (section 3b) refuses a rewrite by anyone. Delivery state is the rest:
--   pending   — due at due_at; never claimed, or retried;
--   claimed   — held under claim_token until claim_expires_at, then reclaimable;
--   delivered — terminal;
--   dead      — terminal, with its closed reason.
-- The state constraint makes every other combination unstorable, and the guard allows only the delivery
-- transitions. Due and expiry times are finite: an event never due, or a claim that never expires, would be
-- held forever and block the reverse migration. occurred_at is bounded to a range every delivery can carry: at
-- or after the first readable millisecond, and before the year 10 000. Every claim hands it back as epoch
-- milliseconds, and the envelope contract takes that integer only in [1, 2^53-1]. The two ends fail differently.
-- An infinity raises 0A000 in the conversion itself, so one such row would fail every claim batch that selects
-- it, not only its own delivery; a finite time past roughly the year 287 396 converts but leaves the safe range,
-- and the call answers unavailable; at or below the epoch it converts and stays in range, but the envelope is
-- refused and the event is dead-lettered as invalid instead of delivered. The lower bound is exact — one
-- millisecond past the epoch is the first value that reads back as 1, and it is written as a plain literal so
-- the check stays immutable and adds no operator to the pinned search path. The upper bound is conservative,
-- far below where the read actually breaks, because a readable calendar limit is the easier rule to keep.
-- attempt counts claims. The delivery policy — at most 20 claims (OUTBOX_DELIVERY_POLICY.maxAttempts) — is
-- the claim routine's (section 3c), fixed in its body: it never claims an event that has had 20, and
-- dead-letters an expired claim at 20 (attempts_exhausted) instead of reclaiming it. The 1 000 below is a
-- storage-integrity ceiling only, never that policy.
create table tmpos_internal.outbox_event (
  event_id          uuid        not null,
  event_type        text        not null,
  event_version     integer     not null,
  aggregate_type    text        not null,
  aggregate_id      uuid        not null,
  aggregate_version bigint      not null,
  tenant_digest     text,
  store_digest      text,
  actor_digest      text,
  correlation_id    uuid        not null,
  payload           jsonb       not null,
  occurred_at       timestamptz not null,
  status            text        not null,
  attempt           integer     not null,
  due_at            timestamptz not null,
  claim_token       text,
  claim_expires_at  timestamptz,
  dead_reason       text,
  constraint outbox_event_pkey primary key (event_id),
  constraint outbox_event_type_chk check (
    pg_catalog.length(event_type) <= 64 and event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
  ),
  constraint outbox_event_version_chk check (event_version between 1 and 1000),
  constraint outbox_event_aggregate_type_chk check (aggregate_type ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint outbox_event_aggregate_version_chk check (aggregate_version between 1 and 9007199254740991),
  constraint outbox_event_digest_chk check (
    (tenant_digest is null or tenant_digest ~ '^[A-Za-z0-9_-]{43}$')
    and (store_digest is null or store_digest ~ '^[A-Za-z0-9_-]{43}$')
    and (actor_digest is null or actor_digest ~ '^[A-Za-z0-9_-]{43}$')
  ),
  constraint outbox_event_payload_chk check (
    pg_catalog.jsonb_typeof(payload) = 'object' and pg_catalog.octet_length(payload::text) <= 5120
  ),
  constraint outbox_event_status_chk check (status in ('pending', 'claimed', 'delivered', 'dead')),
  constraint outbox_event_attempt_chk check (attempt between 0 and 1000),
  constraint outbox_event_time_chk check (
    pg_catalog.isfinite(due_at) and (claim_expires_at is null or pg_catalog.isfinite(claim_expires_at))
    and occurred_at >= timestamptz '1970-01-01 00:00:00.001+00'
    and occurred_at < timestamptz '10000-01-01 00:00:00+00'
  ),
  constraint outbox_event_claim_token_chk check (claim_token is null or claim_token ~ '^[A-Za-z0-9_-]{43}$'),
  constraint outbox_event_dead_reason_chk check (
    dead_reason is null or dead_reason in ('attempts_exhausted', 'envelope_invalid')
  ),
  constraint outbox_event_state_chk check (
    (status = 'pending' and claim_token is null and claim_expires_at is null and dead_reason is null)
    or (status = 'claimed' and claim_token is not null and claim_expires_at is not null
        and dead_reason is null and attempt >= 1)
    or (status = 'delivered' and claim_token is null and claim_expires_at is null
        and dead_reason is null and attempt >= 1)
    or (status = 'dead' and claim_token is null and claim_expires_at is null
        and dead_reason is not null and attempt >= 1)
  )
);

comment on table tmpos_internal.outbox_event is
  'Phase 4.0 M6: the transactional outbox (OutboxDeliveryStore). Events are inserted only by the committing command transaction; the envelope is immutable and the delivery transitions are enforced by a trigger. No raw key, identity, token, cookie, body, SQL or connection material has a column. RLS enabled, no policy; reached only through the lifecycle routines.';
comment on column tmpos_internal.outbox_event.occurred_at is
  'The committing transaction''s start time — the same timestamp as the command''s audit_event.occurred_at. Never a cursor and never an input to a decision.';
comment on column tmpos_internal.outbox_event.attempt is
  'Claims so far. A storage-integrity ceiling of 1 000; the delivery policy (20) is fixed in the claim routine.';

-- Due-event claims, then expired claims: each claim walks one of these in (time, event_id) order.
create index idx_outbox_event_pending_due on tmpos_internal.outbox_event (due_at, event_id) where status = 'pending';
create index idx_outbox_event_claimed_expiry on tmpos_internal.outbox_event (claim_expires_at, event_id) where status = 'claimed';

-- =============================================================================
-- 3b) The delivery state machine, enforced by the table
-- =============================================================================
-- Every insert and update of outbox_event, by any role that writes it (a routine of section 3c, the owner),
-- passes this guard after the constraints above:
--   insert  — only as pending, never attempted (attempt 0);
--   pending — to claimed, once due by the store's clock, the attempt counted (+1);
--   claimed — to claimed again once its claim has expired by the store's clock (a reclaim), under a token
--             that is not the expired claim's, the attempt counted (+1); or to pending (a retry), delivered
--             or dead, the attempt unchanged;
--   delivered, dead — terminal: no update at all;
-- and no update rewrites the envelope. Anything else is refused with one fixed message — no row value, no
-- detail or hint; PostgreSQL's own CONTEXT line names only this function — which the adapter reads as a
-- failed statement ('unavailable'): nothing commits. Fixed SQL with a pinned search path; it reads no table,
-- only the store's clock, and runs with its caller's own privileges. The trigger is ENABLE ALWAYS, so
-- session_replication_role = replica does not skip it: only disabling or dropping it — the table's owner or a
-- superuser — bypasses it. It does not know the delivery policy's number: the claim routine does.
create function tmpos_internal.outbox_event_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' and new.attempt = 0 then
      return null;
    end if;
  elsif (new.event_id, new.event_type, new.event_version, new.aggregate_type, new.aggregate_id, new.aggregate_version,
         new.tenant_digest, new.store_digest, new.actor_digest, new.correlation_id, new.payload, new.occurred_at)
        is distinct from
        (old.event_id, old.event_type, old.event_version, old.aggregate_type, old.aggregate_id, old.aggregate_version,
         old.tenant_digest, old.store_digest, old.actor_digest, old.correlation_id, old.payload, old.occurred_at) then
    null; -- the envelope is immutable: refused below
  elsif old.status = 'pending' then
    if new.status = 'claimed' and new.attempt = old.attempt + 1 and old.due_at <= tmpos_internal.m6_store_clock() then
      return null;
    end if;
  elsif old.status = 'claimed' then
    if (new.status = 'claimed' and new.attempt = old.attempt + 1 and new.claim_token is distinct from old.claim_token
        and old.claim_expires_at <= tmpos_internal.m6_store_clock())
       or (new.status in ('pending', 'delivered', 'dead') and new.attempt = old.attempt) then
      return null;
    end if;
  end if;
  raise exception 'outbox event transition refused' using errcode = 'check_violation';
end
$$;

comment on function tmpos_internal.outbox_event_transition_guard() is
  'Phase 4.0 M6: the outbox delivery state machine. Inserts only as pending at attempt 0; pending to claimed once due; claimed to claimed once expired and under a new token, or to pending, delivered or dead; a claim counts one attempt, nothing else changes it; the envelope never changes; delivered and dead are terminal.';

create trigger outbox_event_transition_guard
  after insert or update on tmpos_internal.outbox_event
  for each row execute function tmpos_internal.outbox_event_transition_guard();

alter table tmpos_internal.outbox_event enable always trigger outbox_event_transition_guard;

-- =============================================================================
-- 3c) The lifecycle routines — the runtime role's only way to either table
-- =============================================================================
-- tmpos_app holds no privilege on either table (section 4). Every read and every change it needs is one of
-- the routines below, each SECURITY DEFINER and owned, like the tables, by the principal applying this file —
-- which is why each one is held to the same rules:
--   * fixed SQL: no dynamic statement, and no caller-selected relation, column, identifier or fragment — a
--     caller supplies values only, each validated before any row is read, and every relation and function is
--     named with its schema under a search path pinned to pg_catalog, then pg_temp;
--   * one decision per lock: the row is locked first, then the store's clock is read, then the decision made;
--   * bound to what the caller holds: a record's response and lease change only under the lease the caller
--     presents, an event's settlement only under the claim token it presents — neither of which the runtime
--     role can read;
--   * a malformed argument (22023) or an unreadable clock (55000) raises one fixed message carrying no value,
--     which the adapter reads as a failed statement: nothing commits;
--   * a refusal says only what the port contract says — never whether a row exists, whose lease or token
--     holds it, or what it stores beyond a replay to the request that recorded it;
--   * EXECUTE is revoked from PUBLIC and granted to tmpos_app alone (section 4), and section 6 refuses to
--     finish unless each is SECURITY DEFINER, owned by the schema's owner and pinned to that search path.
-- The bounds are the ports': a lease of 1 ms to 24 h, a retention of that lease to 7 days, a claim of 1 ms to
-- 1 h over at most 32 events, a retry delay of 1 ms to 15 min, and at most 20 claims of any event.

-- DurableIdempotencyStore.acquire. Absent, or past its retention: recorded afresh under the caller's
-- fingerprint, lease and terms ('acquired'). Otherwise, in this order: another fingerprint → 'conflict';
-- completed → 'replay' with the stored response; an unexpired lease → 'in_progress'; an expired one → the
-- caller's lease replaces it and the retention restarts ('reclaimed'). A refusal changes nothing.
create function tmpos_internal.m6_idempotency_acquire(
  p_scope text, p_fingerprint text, p_lease text, p_lease_ms bigint, p_retention_ms bigint,
  out o_outcome text, out o_response text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row tmpos_internal.idempotency_record%rowtype;
  v_now timestamptz;
begin
  if p_scope is null or p_scope !~ '^[A-Za-z0-9_-]{43}$'
     or p_fingerprint is null or p_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
     or p_lease is null or p_lease !~ '^[A-Za-z0-9_-]{43}$'
     or p_lease_ms is null or p_lease_ms < 1 or p_lease_ms > 86400000
     or p_retention_ms is null or p_retention_ms < p_lease_ms or p_retention_ms > 604800000 then
    raise exception 'transactional store routine refused its arguments' using errcode = 'invalid_parameter_value';
  end if;
  -- inv: each pass either locks the scope's row or records it; term: two passes at most — a second only after a
  -- concurrent caller recorded the scope first, whose committed row that pass then locks.
  for pass in 1..2 loop
    select r.* into v_row from tmpos_internal.idempotency_record r where r.scope = p_scope for update;
    if not found then
      -- Recorded first with placeholder terms, long past, so the clock is read only after any wait on a concurrent
      -- recording; the terms are then set below, as for a record past its retention.
      insert into tmpos_internal.idempotency_record (scope, fingerprint, lease, lease_expires_at, expires_at)
        values (p_scope, p_fingerprint, p_lease, 'epoch', 'epoch')
        on conflict (scope) do nothing;
      if not found then
        continue;
      end if;
      v_row.expires_at := 'epoch';
    end if;
    v_now := tmpos_internal.m6_store_clock();
    if v_now is null then
      raise exception 'transactional store routine could not read its clock' using errcode = 'object_not_in_prerequisite_state';
    end if;
    if v_now >= v_row.expires_at then
      update tmpos_internal.idempotency_record r
         set fingerprint = p_fingerprint, lease = p_lease, response = null,
             lease_expires_at = v_now + p_lease_ms * interval '1 millisecond',
             expires_at = v_now + p_retention_ms * interval '1 millisecond'
       where r.scope = p_scope;
      o_outcome := 'acquired';
      return;
    end if;
    if v_row.fingerprint <> p_fingerprint then
      o_outcome := 'conflict';
      return;
    end if;
    if v_row.response is not null then
      o_outcome := 'replay';
      o_response := v_row.response;
      return;
    end if;
    if v_now < v_row.lease_expires_at then
      o_outcome := 'in_progress';
      return;
    end if;
    update tmpos_internal.idempotency_record r
       set lease = p_lease,
           lease_expires_at = v_now + p_lease_ms * interval '1 millisecond',
           expires_at = v_now + p_retention_ms * interval '1 millisecond'
     where r.scope = p_scope;
    o_outcome := 'reclaimed';
    return;
  end loop;
  raise exception 'transactional store routine could not record the scope' using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- DurableIdempotencyStore.complete, and a command's completion: the sealed response is stored iff the record
-- is within its retention, still in progress and held under exactly the caller's lease ('completed'); an
-- expired lease nobody has reclaimed still completes. Otherwise 'lease_lost', changing nothing. Completion
-- extends no retention. A command's fence judged retention once already; judging it again here means a command
-- whose transaction outlived its record's retention commits nothing, rather than a completion no request could
-- ever replay (the next one finds the record absent).
create function tmpos_internal.m6_idempotency_complete(p_scope text, p_lease text, p_response text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row tmpos_internal.idempotency_record%rowtype;
  v_now timestamptz;
begin
  if p_scope is null or p_scope !~ '^[A-Za-z0-9_-]{43}$'
     or p_lease is null or p_lease !~ '^[A-Za-z0-9_-]{43}$'
     or p_response is null or pg_catalog.length(p_response) < 1 or pg_catalog.length(p_response) > 45094
     or p_response !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'transactional store routine refused its arguments' using errcode = 'invalid_parameter_value';
  end if;
  select r.* into v_row from tmpos_internal.idempotency_record r where r.scope = p_scope for update;
  if not found then
    return 'lease_lost';
  end if;
  v_now := tmpos_internal.m6_store_clock();
  if v_now is null then
    raise exception 'transactional store routine could not read its clock' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_now >= v_row.expires_at or v_row.response is not null or v_row.lease <> p_lease then
    return 'lease_lost';
  end if;
  update tmpos_internal.idempotency_record r set response = p_response where r.scope = p_scope;
  return 'completed';
end
$$;

-- A command's fence, before any business state: the record is locked for the rest of the transaction, and true
-- iff it is within its retention, in progress and held under exactly the caller's lease.
create function tmpos_internal.m6_command_fence(p_scope text, p_lease text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row tmpos_internal.idempotency_record%rowtype;
  v_now timestamptz;
begin
  if p_scope is null or p_scope !~ '^[A-Za-z0-9_-]{43}$' or p_lease is null or p_lease !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'transactional store routine refused its arguments' using errcode = 'invalid_parameter_value';
  end if;
  select r.* into v_row from tmpos_internal.idempotency_record r where r.scope = p_scope for update;
  if not found then
    return false;
  end if;
  v_now := tmpos_internal.m6_store_clock();
  if v_now is null then
    raise exception 'transactional store routine could not read its clock' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_row.response is null and v_row.lease = p_lease and v_now < v_row.expires_at;
end
$$;

-- A command's event: pending, never attempted, due now by the store's clock and stamped with the transaction's
-- start — only while the caller's fence still holds, retention included (it raises otherwise). True once inserted; false when the event ID
-- is not new, which the adapter treats as a fault.
create function tmpos_internal.m6_command_enqueue(
  p_scope text, p_lease text, p_event_id uuid, p_event_type text, p_event_version integer, p_aggregate_type text,
  p_aggregate_id uuid, p_aggregate_version bigint, p_tenant_digest text, p_store_digest text, p_actor_digest text,
  p_correlation_id uuid, p_payload jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_now timestamptz;
begin
  if not tmpos_internal.m6_command_fence(p_scope, p_lease) then
    raise exception 'transactional store routine refused: the lease is not held' using errcode = 'object_not_in_prerequisite_state';
  end if;
  v_now := tmpos_internal.m6_store_clock();
  if v_now is null then
    raise exception 'transactional store routine could not read its clock' using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Every envelope value is checked by the table's own constraints, and a null by its NOT NULL.
  insert into tmpos_internal.outbox_event (event_id, event_type, event_version, aggregate_type, aggregate_id, aggregate_version,
      tenant_digest, store_digest, actor_digest, correlation_id, payload, occurred_at, status, attempt, due_at)
    values (p_event_id, p_event_type, p_event_version, p_aggregate_type, p_aggregate_id, p_aggregate_version,
      p_tenant_digest, p_store_digest, p_actor_digest, p_correlation_id, p_payload, pg_catalog.now(), 'pending', 0, v_now)
    on conflict (event_id) do nothing;
  return found;
end
$$;

-- OutboxDeliveryStore.claim, in ONE statement over one clock reading: the earliest due pending events and the
-- earliest expired claims — each walked in its own index's order and locked with SKIP LOCKED, so concurrent
-- claims never wait on or share a row — merged into (eligibility time, event ID) order and claimed under the
-- caller's token until now + claimMs, each attempt counted. An expired claim is never reclaimed under the token
-- that held it. An expired claim that has already had 20 attempts is dead-lettered (attempts_exhausted),
-- unpublished, instead of being handed out a 21st time; 20 is fixed here, and no argument changes it. A row a
-- branch locked beyond the merged limit stays as it was, and its lock ends at COMMIT. Always at least one row:
-- how many spent claims were dead-lettered, beside each event claimed (none: one row of nulls beside it).
create function tmpos_internal.m6_outbox_claim(p_token text, p_limit integer, p_claim_ms bigint)
returns table (
  o_spent integer, o_event_id uuid, o_attempt integer, o_eligible_at timestamptz, o_event_type text, o_event_version integer,
  o_aggregate_type text, o_aggregate_id uuid, o_aggregate_version text, o_tenant_digest text, o_store_digest text,
  o_actor_digest text, o_correlation_id uuid, o_payload jsonb, o_occurred_at text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_now timestamptz;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' or p_limit is null or p_limit < 1 or p_limit > 32
     or p_claim_ms is null or p_claim_ms < 1 or p_claim_ms > 3600000 then
    raise exception 'transactional store routine refused its arguments' using errcode = 'invalid_parameter_value';
  end if;
  v_now := tmpos_internal.m6_store_clock();
  if v_now is null then
    raise exception 'transactional store routine could not read its clock' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return query
    with due as materialized (
      select e.event_id, e.due_at as eligible_at
        from tmpos_internal.outbox_event e
       where e.status = 'pending' and e.due_at <= v_now and e.attempt < 20
       order by e.due_at, e.event_id
       limit p_limit
       for update of e skip locked
    ),
    expired as materialized (
      select e.event_id, e.claim_expires_at as eligible_at
        from tmpos_internal.outbox_event e
       where e.status = 'claimed' and e.claim_expires_at <= v_now and e.attempt < 20 and e.claim_token <> p_token
       order by e.claim_expires_at, e.event_id
       limit p_limit
       for update of e skip locked
    ),
    spent as materialized (
      select e.event_id
        from tmpos_internal.outbox_event e
       where e.status = 'claimed' and e.claim_expires_at <= v_now and e.attempt >= 20
       order by e.claim_expires_at, e.event_id
       limit p_limit
       for update of e skip locked
    ),
    exhausted as (
      update tmpos_internal.outbox_event o
         set status = 'dead', claim_token = null, claim_expires_at = null, dead_reason = 'attempts_exhausted'
        from spent
       where o.event_id = spent.event_id
      returning o.event_id
    ),
    eligible as (
      select d.event_id, d.eligible_at from due d
      union all
      select x.event_id, x.eligible_at from expired x
      order by 2, 1
      limit p_limit
    ),
    claimed as (
      update tmpos_internal.outbox_event o
         set status = 'claimed', attempt = o.attempt + 1, claim_token = p_token,
             claim_expires_at = v_now + p_claim_ms * interval '1 millisecond'
        from eligible
       where o.event_id = eligible.event_id
      returning o.event_id, o.attempt, eligible.eligible_at, o.event_type, o.event_version, o.aggregate_type, o.aggregate_id,
        o.aggregate_version::text, o.tenant_digest, o.store_digest, o.actor_digest, o.correlation_id, o.payload,
        pg_catalog.floor(extract(epoch from o.occurred_at) * 1000)::bigint::text
    )
    select s.spent, c.*
      from (select pg_catalog.count(*)::integer as spent from exhausted) s
      left join claimed c on true
     order by c.eligible_at, c.event_id;
end
$$;

-- OutboxDeliveryStore.acknowledge: delivered, for good, iff the event is claimed under exactly the caller's token
-- (an expired claim nobody has reclaimed still settles). Otherwise 'claim_lost', changing nothing.
create function tmpos_internal.m6_outbox_acknowledge(p_event_id uuid, p_token text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_token text;
begin
  if p_event_id is null or p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'transactional store routine refused its arguments' using errcode = 'invalid_parameter_value';
  end if;
  select e.status, e.claim_token into v_status, v_token from tmpos_internal.outbox_event e where e.event_id = p_event_id for update;
  if not found or v_status <> 'claimed' or v_token <> p_token then
    return 'claim_lost';
  end if;
  update tmpos_internal.outbox_event o set status = 'delivered', claim_token = null, claim_expires_at = null
   where o.event_id = p_event_id;
  return 'acknowledged';
end
$$;

-- OutboxDeliveryStore.retry: pending again, due at now + delay, iff held under exactly the caller's token
-- ('scheduled'). An event that has spent its 20 attempts is never pending again ('exhausted', changing nothing):
-- once its claim expires the next claim dead-letters it.
create function tmpos_internal.m6_outbox_retry(p_event_id uuid, p_token text, p_delay_ms bigint)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_token text;
  v_attempt integer;
  v_now timestamptz;
begin
  if p_event_id is null or p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$'
     or p_delay_ms is null or p_delay_ms < 1 or p_delay_ms > 900000 then
    raise exception 'transactional store routine refused its arguments' using errcode = 'invalid_parameter_value';
  end if;
  select e.status, e.claim_token, e.attempt into v_status, v_token, v_attempt
    from tmpos_internal.outbox_event e where e.event_id = p_event_id for update;
  if not found or v_status <> 'claimed' or v_token <> p_token then
    return 'claim_lost';
  end if;
  if v_attempt >= 20 then
    return 'exhausted';
  end if;
  v_now := tmpos_internal.m6_store_clock();
  if v_now is null then
    raise exception 'transactional store routine could not read its clock' using errcode = 'object_not_in_prerequisite_state';
  end if;
  update tmpos_internal.outbox_event o
     set status = 'pending', claim_token = null, claim_expires_at = null, due_at = v_now + p_delay_ms * interval '1 millisecond'
   where o.event_id = p_event_id;
  return 'scheduled';
end
$$;

-- OutboxDeliveryStore.deadLetter: dead, for good, with its closed reason, iff held under exactly the caller's
-- token ('dead_lettered'). Otherwise 'claim_lost', changing nothing.
create function tmpos_internal.m6_outbox_dead_letter(p_event_id uuid, p_token text, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_token text;
begin
  if p_event_id is null or p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$'
     or p_reason is null or p_reason not in ('attempts_exhausted', 'envelope_invalid') then
    raise exception 'transactional store routine refused its arguments' using errcode = 'invalid_parameter_value';
  end if;
  select e.status, e.claim_token into v_status, v_token from tmpos_internal.outbox_event e where e.event_id = p_event_id for update;
  if not found or v_status <> 'claimed' or v_token <> p_token then
    return 'claim_lost';
  end if;
  update tmpos_internal.outbox_event o
     set status = 'dead', claim_token = null, claim_expires_at = null, dead_reason = p_reason
   where o.event_id = p_event_id;
  return 'dead_lettered';
end
$$;

-- Every port's readiness probe: true while both tables and the clock answer. It reads no row.
create function tmpos_internal.m6_store_probe()
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform 1 from tmpos_internal.idempotency_record r where false;
  perform 1 from tmpos_internal.outbox_event e where false;
  return tmpos_internal.m6_store_clock() is not null;
end
$$;

-- =============================================================================
-- 4) Privileges — the schema and the routines to the runtime role, nothing else
-- =============================================================================
-- Explicit revokes first, whatever the default privileges of the applying principal are; section 6 then
-- refuses to finish while any direct grant beyond the ones below remains. No role but the owner holds any
-- privilege on either table, on the clock or on the guard — a trigger runs the guard without one, and a
-- routine calls the clock as its owner. No DELETE or TRUNCATE exists for anyone but the owner: an expired
-- record is overwritten in place, and a delivered or dead event is kept (a purge pass is a later, separately
-- reviewed step).
revoke all on schema tmpos_internal from public, anon, authenticated;
grant usage on schema tmpos_internal to tmpos_app;

revoke all on table tmpos_internal.idempotency_record from public, anon, authenticated, tmpos_app;
revoke all on table tmpos_internal.outbox_event from public, anon, authenticated, tmpos_app;
revoke all on function tmpos_internal.m6_store_clock() from public, anon, authenticated, tmpos_app;
revoke all on function tmpos_internal.outbox_event_transition_guard() from public, anon, authenticated, tmpos_app;

revoke all on function tmpos_internal.m6_idempotency_acquire(text, text, text, bigint, bigint) from public, anon, authenticated;
revoke all on function tmpos_internal.m6_idempotency_complete(text, text, text) from public, anon, authenticated;
revoke all on function tmpos_internal.m6_command_fence(text, text) from public, anon, authenticated;
revoke all on function tmpos_internal.m6_command_enqueue(text, text, uuid, text, integer, text, uuid, bigint, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function tmpos_internal.m6_outbox_claim(text, integer, bigint) from public, anon, authenticated;
revoke all on function tmpos_internal.m6_outbox_acknowledge(uuid, text) from public, anon, authenticated;
revoke all on function tmpos_internal.m6_outbox_retry(uuid, text, bigint) from public, anon, authenticated;
revoke all on function tmpos_internal.m6_outbox_dead_letter(uuid, text, text) from public, anon, authenticated;
revoke all on function tmpos_internal.m6_store_probe() from public, anon, authenticated;

grant execute on function tmpos_internal.m6_idempotency_acquire(text, text, text, bigint, bigint) to tmpos_app;
grant execute on function tmpos_internal.m6_idempotency_complete(text, text, text) to tmpos_app;
grant execute on function tmpos_internal.m6_command_fence(text, text) to tmpos_app;
grant execute on function tmpos_internal.m6_command_enqueue(text, text, uuid, text, integer, text, uuid, bigint, text, text, text, uuid, jsonb)
  to tmpos_app;
grant execute on function tmpos_internal.m6_outbox_claim(text, integer, bigint) to tmpos_app;
grant execute on function tmpos_internal.m6_outbox_acknowledge(uuid, text) to tmpos_app;
grant execute on function tmpos_internal.m6_outbox_retry(uuid, text, bigint) to tmpos_app;
grant execute on function tmpos_internal.m6_outbox_dead_letter(uuid, text, text) to tmpos_app;
grant execute on function tmpos_internal.m6_store_probe() to tmpos_app;

-- =============================================================================
-- 5) Row-Level Security — enabled, with no policy
-- =============================================================================
-- Both tables carry RLS and no policy, so a role a stray grant ever reaches still sees and changes no row. The
-- routines run as the owner, whom RLS does not restrict (it is not forced).
alter table tmpos_internal.idempotency_record enable row level security;
alter table tmpos_internal.outbox_event enable row level security;

-- =============================================================================
-- 6) Verify — the direct grants are the owner's and section 4's, and the routines are what section 3c says
-- =============================================================================
-- The revokes above name the roles this project knows; a platform's default privileges can add others. This
-- refuses to finish while:
--   * the ACL of the schema, of any relation in it, of one of their columns or of any function in it carries a
--     DIRECT OBJECT GRANT to any role but the owner, other than tmpos_app's USAGE on the schema and EXECUTE on the
--     nine routines — or grants tmpos_app either with the right to grant it on;
--   * a function in the schema is not exactly one of the eleven this file creates, is owned by anyone but the
--     schema's owner, is not pinned to pg_catalog, then pg_temp, or differs from section 3c in SECURITY DEFINER
--     (every routine is; the clock and the guard are not);
--   * tmpos_app, tmpos_audit_writer, anon or authenticated is a member of that owner, directly or not — which
--     would hand it everything the owner holds without a grant of its own.
-- An ACL never set is read as its built-in default, so a function nobody revoked from PUBLIC is caught too. Every
-- comparison is between exact types (oid with oid, text with text, text[] with text[]), so no operator placed in
-- a schema on the applying session's path can outrank pg_catalog's own.
-- What it does not see, by design: every other path of EFFECTIVE PRIVILEGE THROUGH MEMBERSHIP (a member of
-- tmpos_app reaches the routines without a grant of its own), the OWNERSHIP OR SUPERUSER BYPASS (the owner and a
-- superuser pass every privilege check and bypass RLS), who the runtime login is, and any grant made after it ran.
-- Those are role topology, verified live against the runtime login under G-DBROLE (docs/phase-4/08). Nothing
-- here widens or narrows access: it only refuses.
do $$
declare
  schema_oid oid := 'tmpos_internal'::regnamespace::oid;
  schema_owner oid := (select n.nspowner from pg_catalog.pg_namespace n where n.oid = 'tmpos_internal'::regnamespace::oid);
  routines oid[] := array[
    'tmpos_internal.m6_idempotency_acquire(text, text, text, bigint, bigint)'::regprocedure::oid,
    'tmpos_internal.m6_idempotency_complete(text, text, text)'::regprocedure::oid,
    'tmpos_internal.m6_command_fence(text, text)'::regprocedure::oid,
    'tmpos_internal.m6_command_enqueue(text, text, uuid, text, integer, text, uuid, bigint, text, text, text, uuid, jsonb)'::regprocedure::oid,
    'tmpos_internal.m6_outbox_claim(text, integer, bigint)'::regprocedure::oid,
    'tmpos_internal.m6_outbox_acknowledge(uuid, text)'::regprocedure::oid,
    'tmpos_internal.m6_outbox_retry(uuid, text, bigint)'::regprocedure::oid,
    'tmpos_internal.m6_outbox_dead_letter(uuid, text, text)'::regprocedure::oid,
    'tmpos_internal.m6_store_probe()'::regprocedure::oid];
  helpers oid[] := array[
    'tmpos_internal.m6_store_clock()'::regprocedure::oid,
    'tmpos_internal.outbox_event_transition_guard()'::regprocedure::oid];
  stray text;
  loose text;
  member text;
begin
  with objects (kind, oid, name, owner, acl) as (
    select 'schema', n.oid, n.nspname::text, n.nspowner, coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
      from pg_catalog.pg_namespace n
     where n.oid = schema_oid
    union all
    select 'relation', c.oid, c.oid::regclass::text, c.relowner, coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
      from pg_catalog.pg_class c
     where c.relnamespace = schema_oid
    union all
    select 'column', c.oid, c.oid::regclass::text || '.' || a.attname::text, c.relowner, a.attacl
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
     where c.relnamespace = schema_oid and a.attnum > 0::int2 and not a.attisdropped
    union all
    select 'function', p.oid, p.oid::regprocedure::text, p.proowner, coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      from pg_catalog.pg_proc p
     where p.pronamespace = schema_oid
  )
  select pg_catalog.string_agg(x.privilege_type || ' on ' || o.name || ' to '
           || case when x.grantee = 0::oid then 'PUBLIC' else x.grantee::regrole::text end, '; ')
    into stray
    from objects o, pg_catalog.aclexplode(o.acl) x
   where x.grantee <> o.owner
     and not (x.grantee = 'tmpos_app'::regrole::oid and not x.is_grantable and (
           (o.kind = 'schema' and x.privilege_type = 'USAGE')
        or (o.kind = 'function' and x.privilege_type = 'EXECUTE' and o.oid = any (routines))));
  if stray is not null then
    raise exception 'migration 006 refused: an object of the transactional store carries a direct grant beyond the owner''s and tmpos_app''s own'
      using errcode = 'object_not_in_prerequisite_state',
            detail = stray,
            hint = 'revoke it, or the default privilege that created it, then apply again; this migration never widens access';
  end if;

  select pg_catalog.string_agg(p.oid::regprocedure::text, '; ')
    into loose
    from pg_catalog.pg_proc p
   where p.pronamespace = schema_oid
     and not (p.proowner = schema_owner
              and p.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
              and ((p.oid = any (routines) and p.prosecdef) or (p.oid = any (helpers) and not p.prosecdef)));
  if loose is not null then
    raise exception 'migration 006 refused: a function of the transactional store is not one this migration defines as it defines it'
      using errcode = 'object_not_in_prerequisite_state',
            detail = loose,
            hint = 'remove or correct it, then apply again';
  end if;

  select pg_catalog.string_agg(r.rolname::text, '; ')
    into member
    from pg_catalog.pg_roles r
   where r.rolname in ('tmpos_app'::name, 'tmpos_audit_writer'::name, 'anon'::name, 'authenticated'::name)
     and pg_catalog.pg_has_role(r.oid, schema_owner, 'MEMBER');
  if member is not null then
    raise exception 'migration 006 refused: a role of this project is a member of the transactional store''s owner'
      using errcode = 'object_not_in_prerequisite_state',
            detail = member,
            hint = 'apply as a principal none of these roles is a member of';
  end if;
end
$$;

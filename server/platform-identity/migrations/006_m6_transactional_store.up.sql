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
--   - MIGRATION FILE ONLY. Nothing here is applied automatically. It has been applied only to
--     disposable test databases — never to a managed, persistent, production or application database.
--     Migration 005 is itself unexecuted there, and while this file is pending the managed apply of 005
--     refuses by design (the exact-[005] plan gate in scripts/supabase-migrate.ts): sequencing the two is
--     a separate, unmade decision.
--   - NO ROLE IS CREATED, ALTERED OR DROPPED. The runtime reaches these tables only through the NOLOGIN
--     privilege role migration 005 owns (tmpos_app). The audit record of a committed command is
--     appended through the existing writer into audit_event as tmpos_audit_writer (INSERT only): there
--     is no second audit table.
--   - NO TENANT OR RLS ISOLATION CLAIM. Records are keyed by keyed digests of the principal and the
--     client's key, never by tenant; tenant/store isolation needs M5's server-derived context. The
--     policies below admit the runtime role to every row ON PURPOSE and admit no other role: defense
--     in depth against a stray grant, not isolation between tenants.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION. Times are timestamptz on the store's own clock.
--
-- Reversible via 006_m6_transactional_store.down.sql, which refuses while the store holds work it
-- would destroy (an undelivered event or an idempotency record still within its retention).
--
-- Assumes the roles `anon` and `authenticated` exist, as 002, 004 and 005 already do, and that 005 has
-- created tmpos_app.

-- =============================================================================
-- 1) The store's clock
-- =============================================================================
-- Every expiry, retention and due-time decision the adapter makes reads THIS function, once per
-- decision and only after the row it decides about is locked, so one clock serves every instance and
-- no instance's host clock is ever consulted. Millisecond resolution, so the ports' millisecond
-- arithmetic (a lease of 60 000 ms, a retry due in 5 000 ms) is exact at every boundary.
-- Deliberately NOT now(): now() is the transaction's START, which a statement that waited on a lock
-- would read stale. The stamps a command carries (audit_event.occurred_at and each event's
-- occurred_at) ARE the transaction start — one timestamp for the whole commit — and are never an
-- input to a decision.
create function public.m6_store_clock()
returns timestamptz
language sql
volatile
set search_path = pg_catalog, pg_temp
as $$ select pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()) $$;

comment on function public.m6_store_clock() is
  'Phase 4.0 M6: the transactional store''s clock — clock_timestamp() at millisecond resolution. Every expiry, retention and due-time decision reads it after locking the row it decides about.';

-- =============================================================================
-- 2) idempotency_record — one row per operation scope
-- =============================================================================
-- scope, fingerprint and lease are 43-character base64url strings (32-byte keyed digests and a
-- 32-byte random fencing token); the raw client key, principal and body never reach this table.
-- A row is IN PROGRESS while response is null and COMPLETED once the sealed response is stored: an
-- opaque base64url string of at most 45 094 characters (MAX_SEALED_LENGTH), kept byte for byte.
-- A row past expires_at is absent to the ports and is overwritten in place by the next acquisition.
create table public.idempotency_record (
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
  constraint idempotency_record_expiry_chk check (lease_expires_at <= expires_at),
  constraint idempotency_record_response_chk check (
    response is null
    or (pg_catalog.length(response) between 1 and 45094 and response ~ '^[A-Za-z0-9_-]+$')
  )
);

comment on table public.idempotency_record is
  'Phase 4.0 M6: durable idempotency records (DurableIdempotencyStore). Keyed digests and a fencing token only — no raw key, principal, request or body. RLS enabled; tmpos_app only.';
comment on column public.idempotency_record.response is
  'The sealed response (AES-256-GCM under a subkey of IDEMPOTENCY_KEY, bound to scope and fingerprint): opaque to the store. Null while in progress.';

-- Retention: a later purge pass finds the records past their retention by this index.
create index idx_idempotency_record_expires_at on public.idempotency_record (expires_at);

-- =============================================================================
-- 3) outbox_event — one row per event, its immutable envelope and its delivery state
-- =============================================================================
-- The envelope columns (event_id … occurred_at) are written once, by the committing transaction, and
-- the runtime role holds no UPDATE on any of them (section 4). Delivery state is the rest:
--   pending   — due at due_at; never claimed, or retried;
--   claimed   — held under claim_token until claim_expires_at, then reclaimable;
--   delivered — terminal: no statement of the adapter moves it again;
--   dead      — terminal, with its closed reason. The table keeps each state consistent; it does not stop other
--               SQL run as the runtime role from moving a delivered or dead row back (docs/phase-4/08 DA-16).
-- The state constraint makes every other combination unstorable. attempt counts claims; claims stop
-- at the bound (the adapter never claims an event at 1 000 attempts), so a claim cannot fail on it.
create table public.outbox_event (
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

comment on table public.outbox_event is
  'Phase 4.0 M6: the transactional outbox (OutboxDeliveryStore). Events are inserted only by the committing command transaction; the envelope columns are immutable to the runtime role. No raw key, identity, token, cookie, body, SQL or connection material has a column. RLS enabled; tmpos_app only.';
comment on column public.outbox_event.occurred_at is
  'The committing transaction''s start time — the same timestamp as the command''s audit_event.occurred_at. Never a cursor and never an input to a decision.';

-- Due-event claims, then expired claims: each claim walks one of these in (time, event_id) order.
create index idx_outbox_event_pending_due on public.outbox_event (due_at, event_id) where status = 'pending';
create index idx_outbox_event_claimed_expiry on public.outbox_event (claim_expires_at, event_id) where status = 'claimed';

-- =============================================================================
-- 4) Privileges — the runtime role only, and only what the ports need
-- =============================================================================
-- Explicit revokes first, whatever the default privileges of the applying principal are; section 6 then
-- refuses to finish while any other role holds a privilege here.
-- UPDATE is COLUMN-SCOPED on both tables, and that is load-bearing:
--   * idempotency_record — never the scope, the row's identity;
--   * outbox_event — the delivery-state columns only, so a committed envelope can never be rewritten
--     through the runtime role, whatever a future statement tries.
-- No DELETE and no TRUNCATE anywhere: an expired record is overwritten in place, and a delivered or
-- dead event is kept (a purge pass is a later, separately reviewed step).
revoke all on function public.m6_store_clock() from public, anon, authenticated;
grant execute on function public.m6_store_clock() to tmpos_app;

revoke all on table public.idempotency_record from public, anon, authenticated;
grant select, insert on table public.idempotency_record to tmpos_app;
grant update (fingerprint, lease, lease_expires_at, expires_at, response) on table public.idempotency_record to tmpos_app;

revoke all on table public.outbox_event from public, anon, authenticated;
grant select, insert on table public.outbox_event to tmpos_app;
grant update (status, attempt, due_at, claim_token, claim_expires_at, dead_reason) on table public.outbox_event to tmpos_app;

-- =============================================================================
-- 5) Row-Level Security — enabled, and open to the runtime role alone
-- =============================================================================
-- Every public table carries RLS. A role without a policy here sees and writes nothing even if a grant
-- reaches it by mistake. USING (true) is the honest predicate until M5 (see the header).
alter table public.idempotency_record enable row level security;
alter table public.outbox_event enable row level security;

create policy tmpos_app_idempotency_record_access on public.idempotency_record
  for all
  to tmpos_app
  using (true)
  with check (true);

create policy tmpos_app_outbox_event_access on public.outbox_event
  for all
  to tmpos_app
  using (true)
  with check (true);

-- =============================================================================
-- 6) Verify — tmpos_app is the only grantee, whatever the applier's defaults added
-- =============================================================================
-- The revokes above name the roles this project knows; a platform's default privileges can add others (a
-- service role, say). This refuses to finish while any role but the owner holds a privilege on either table,
-- on one of their columns or on the clock — and while tmpos_app holds more than section 4 grants it, or holds
-- anything with the right to grant it on. Nothing
-- here widens or narrows access: it only refuses.
do $$
declare
  stray text;
begin
  with objects (kind, name, owner, acl, relname, attname) as (
    select 'table', c.oid::regclass::text, c.relowner, c.relacl, c.relname::text, null::text
      from pg_catalog.pg_class c
     where c.oid in ('public.idempotency_record'::regclass, 'public.outbox_event'::regclass)
    union all
    select 'column', c.oid::regclass::text || '.' || a.attname, c.relowner, a.attacl, c.relname::text, a.attname::text
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
     where a.attrelid in ('public.idempotency_record'::regclass, 'public.outbox_event'::regclass)
       and a.attnum > 0 and not a.attisdropped
    union all
    select 'function', p.oid::regprocedure::text, p.proowner, p.proacl, null::text, null::text
      from pg_catalog.pg_proc p
     where p.oid = 'public.m6_store_clock()'::regprocedure
  )
  select pg_catalog.string_agg(x.privilege_type || ' on ' || o.name || ' to '
           || case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end, '; ')
    into stray
    from objects o, pg_catalog.aclexplode(o.acl) x
   where x.grantee <> o.owner
     and not (x.grantee = 'tmpos_app'::regrole::oid and not x.is_grantable and (
           (o.kind = 'table' and x.privilege_type in ('SELECT', 'INSERT'))
        or (o.kind = 'column' and x.privilege_type = 'UPDATE' and (o.relname, o.attname) in (
              ('idempotency_record', 'fingerprint'), ('idempotency_record', 'lease'), ('idempotency_record', 'lease_expires_at'),
              ('idempotency_record', 'expires_at'), ('idempotency_record', 'response'),
              ('outbox_event', 'status'), ('outbox_event', 'attempt'), ('outbox_event', 'due_at'), ('outbox_event', 'claim_token'),
              ('outbox_event', 'claim_expires_at'), ('outbox_event', 'dead_reason')))
        or (o.kind = 'function' and x.privilege_type = 'EXECUTE')));
  if stray is not null then
    raise exception 'migration 006 refused: a role other than tmpos_app holds a privilege on the transactional store'
      using errcode = 'object_not_in_prerequisite_state',
            detail = stray,
            hint = 'remove the default privileges that granted it, then apply again; this migration never widens access';
  end if;
end
$$;

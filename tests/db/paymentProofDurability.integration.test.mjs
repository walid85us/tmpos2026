// M7B-PAYMENTS-P2 PRQ-1 — the durability gate, proved on PostgreSQL primitives BEFORE any feature code.
//
// The proof issuer reads the committed registration first, THEN samples L := pg_current_wal_insert_lsn(). That sample
// is the START of the next record: when the last record ended exactly on a WAL page, it sits past the page header.
// The approved correction converts L to end-of-record form ONLY at an exact first usable byte — a segment's first
// usable byte (subtract the long page header) checked first, then a page's (subtract the short page header) — and
// keeps the strict comparison flush >= L_end. No tolerance range. The header sizes are those of the verified build:
// MAXALIGN(20) = 24 and MAXALIGN(36) = 40 at max_data_alignment 8; any other alignment fails closed.
//
// Run: tsx scripts/run-db-tests.mjs tests/db/paymentProofDurability.integration.test.mjs
//
// Two disposable, crash-durable single primaries (fsync, full_page_writes and the default synchronous_commit on): one
// at the default 16 MB WAL segment, one at 64 MB. The registering connection alone turns synchronous_commit off, as a
// permitted direct SQL caller may. pg_walinspect (a contrib extension, superuser in this throwaway cluster) reads the
// commit records back. wal_writer_delay is raised only inside the cases that must observe an unflushed commit, and
// reset after them.
//
// PDG-09..14 then take the SAME two clusters through migration 037's REAL routines (only after PDG-01..08, which so ran with
// no migration WAL): 001-037 by the trusted executor, the runtime's own non-owner login, a fixture built through the routines,
// autovacuum then off. PDG-10..12 land a real registration's COMMIT exactly on a page boundary, a segment boundary and (64 MB)
// a 16 MB-aligned ordinary page, and the real proof routine issues within its budget. PDG-13 and PDG-14 exercise decision
// D-R4-1 (037 :63-64: crash durability for a single primary with fsync on) against a PROCESS crash only: a proof is issued,
// then at once `pg_ctl -m immediate` (no shutdown checkpoint; the OS page cache survives) and a restart of the same data
// directory; the server's redo pass covers the registration's COMMIT, the registration is back and the pre-crash proof
// records exactly one payment. PDG-13 refuses first while ONLY that COMMIT is unflushed (a negative control); PDG-14 crashes
// right after a proof issued through the page-boundary conversion. Durability against power loss is NOT exercised here: it
// rests on fsync on and PostgreSQL's flush contract. Proofs, keys and session keys are compared as booleans, never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, installTestPaymentProofKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { REQUIRED_MIGRATIONS } from '../../server/persistence/postgresStartupPreflight.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const S = 'prq1_gate';
const BUDGET_MS = 1000;
const SHORT = 24n; // SizeOfXLogShortPHD on the verified build
const LONG = 40n; // SizeOfXLogLongPHD on the verified build
const MB16 = 16n * 1024n * 1024n;

const big = (lsn) => {
  const [hi, lo] = String(lsn).split('/');
  return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
};
const lsn = (n) => `${(n >> 32n).toString(16).toUpperCase()}/${(n & 0xffffffffn).toString(16).toUpperCase()}`;

/** One durable cluster with its three connections, the throwaway schema and the two issuance checks. */
async function openCluster(label, opts) {
  const target = resolveDisposableTarget(label, { durable: true, ...opts });
  const mk = () => testClient(target, { max: 1, onnotice: () => {} });
  const c = { target, owner: mk(), registrar: mk(), issuer: mk() };
  const { owner } = c;
  await owner.unsafe(`drop schema if exists ${S} cascade`);
  await owner.unsafe(`create schema ${S}`);
  await owner.unsafe('create extension if not exists pg_walinspect');
  // A LOGGED table (the default); autovacuum off for it so an idle measurement is not disturbed by vacuum WAL.
  await owner.unsafe(`create table ${S}.registration (id uuid primary key, registered_xact xid8 not null)
                      with (autovacuum_enabled = false)`);
  await owner.unsafe(`create table ${S}.side (n integer) with (autovacuum_enabled = false)`);
  // Shared prefix: read the committed row of another transaction, then (only then) sample L.
  const prologue = `
      select r.registered_xact into v_xact from ${S}.registration r where r.id = p_id;
      if not found or v_xact is not distinct from pg_catalog.pg_current_xact_id_if_assigned() then
        o_issued := false; o_waited_ms := 0; return;
      end if;`;
  const waitLoop = (goal) => `
      loop
        o_flush := pg_catalog.pg_current_wal_flush_lsn();
        o_waited_ms := (extract(epoch from pg_catalog.clock_timestamp() - v_start) * 1000)::integer;
        exit when o_flush >= ${goal} or o_waited_ms >= p_budget_ms;
        perform pg_catalog.pg_sleep(0.02);
      end loop;
      o_issued := o_flush >= ${goal};`;
  // The ORIGINAL strict rule (the PDG-04 reproduction): no end-of-record conversion.
  await owner.unsafe(`
    create function ${S}.issue_raw(p_id uuid, p_budget_ms integer,
      out o_issued boolean, out o_l pg_lsn, out o_flush pg_lsn, out o_waited_ms integer)
    language plpgsql volatile set search_path = pg_catalog, pg_temp as $f$
    declare v_xact xid8; v_start timestamptz := pg_catalog.clock_timestamp();
    begin ${prologue}
      o_l := pg_catalog.pg_current_wal_insert_lsn(); ${waitLoop('o_l')}
    end $f$`);
  // The CORRECTED rule, as migration 037's proof routine implements it.
  await owner.unsafe(`
    create function ${S}.issue(p_id uuid, p_budget_ms integer,
      out o_issued boolean, out o_l pg_lsn, out o_l_end pg_lsn, out o_flush pg_lsn, out o_waited_ms integer)
    language plpgsql volatile set search_path = pg_catalog, pg_temp as $f$
    declare v_xact xid8; v_start timestamptz := pg_catalog.clock_timestamp();
            v_align integer; v_block numeric; v_segment numeric; v_offset numeric;
    begin ${prologue}
      select c.max_data_alignment, c.wal_block_size, c.bytes_per_wal_segment
        into v_align, v_block, v_segment from pg_catalog.pg_control_init() c;
      if v_align is distinct from 8 then
        raise exception 'unverified WAL page header layout' using errcode = '55000';
      end if;
      o_l := pg_catalog.pg_current_wal_insert_lsn();
      v_offset := o_l - '0/0'::pg_lsn;
      if v_offset % v_segment = 40 then o_l_end := o_l - 40::numeric;
      elsif v_offset % v_block = 24 then o_l_end := o_l - 24::numeric;
      else o_l_end := o_l;
      end if; ${waitLoop('o_l_end')}
    end $f$`);
  await c.registrar`set synchronous_commit = off`;
  const [{ blk, seg, align }] = await owner`select wal_block_size::bigint as blk, bytes_per_wal_segment::bigint as seg,
                                                   max_data_alignment as align from pg_catalog.pg_control_init()`;
  c.blk = BigInt(blk); c.seg = BigInt(seg); c.align = align;
  c.ubp = c.blk - SHORT; // usable bytes in a page
  c.ubs = (c.seg / c.blk) * c.ubp - (LONG - SHORT); // usable bytes in a segment
  c.end = async () => {
    try { await owner`alter system reset wal_writer_delay`; await owner`select pg_catalog.pg_reload_conf()`; } catch { /* closing */ }
    try { await owner.unsafe(`drop schema if exists ${S} cascade`); } finally {
      await Promise.allSettled([c.owner.end(), c.registrar.end(), c.issuer.end(), ...Object.values(c.app ?? {}).map((p) => p.end())]);
    }
  };
  return c;
}

// PostgreSQL's own XLogRecPtrToBytePos (xlog.c), for test-side WAL arithmetic only.
function bytePos(c, ptr) {
  const segs = ptr / c.seg, off = ptr % c.seg, pages = off / c.blk, inPage = off % c.blk;
  if (pages === 0n) return segs * c.ubs + (off > 0n ? off - LONG : 0n);
  return segs * c.ubs + (c.blk - LONG) + (pages - 1n) * c.ubp + (inPage > 0n ? inPage - SHORT : 0n);
}

const insertLsn = async (sql) => big((await sql`select pg_catalog.pg_current_wal_insert_lsn() as l`)[0].l);
const filler = (sql, bytes) => sql`select pg_catalog.pg_logical_emit_message(false, 'prq1-fill', ${'x'.repeat(bytes)})`;

/**
 * The landing transaction of the gate's own registration (one row of the throwaway table) on the registrar. PDG-09..12 pass
 * another: the REAL register routine as the runtime login (appLander). `room` is what the write itself may add before the pad.
 */
const gateLander = (c) => ({
  db: c.registrar, begin: (fn) => c.registrar.begin(fn), tail: c.tail, room: 800n,
  write: async (sql) => {
    const id = randomUUID();
    await sql`insert into ${sql(S)}.registration (id, registered_xact) values (${id}, pg_catalog.pg_current_xact_id())`;
    return id;
  },
  release: async () => {},
});

/** Learn the exact sizes of the landing transaction's tail: the pad message M(p) and the commit record C. */
async function calibrate(c, { db, begin, write, release } = gateLander(c)) {
  const m = new Map(); const commits = [];
  for (let p = 256; p <= 272; p++) {
    let x, y, w;
    await begin(async (sql) => {
      w = await write(sql);
      x = await insertLsn(sql);
      await sql`select pg_catalog.pg_logical_emit_message(true, 'prq1-pad', ${'x'.repeat(p)})`;
      y = await insertLsn(sql);
    });
    const z = await insertLsn(db);
    await release(w);
    m.set(p, bytePos(c, y) - bytePos(c, x));
    commits.push(bytePos(c, z) - bytePos(c, y));
  }
  // The exact-fit pad: the size jumps by 8 right after it, so M(pStar + 8k) = M(pStar) + 8k.
  let pStar = null;
  for (let p = 256; p < 272; p++) if (m.get(p + 1) - m.get(p) === 8n) { pStar = p; break; }
  assert.ok(pStar !== null, 'message size phase found');
  commits.sort((a, b) => Number(a - b));
  return { pStar, mStar: m.get(pStar), commit: commits[commits.length >> 1] };
}

/**
 * Land a registration whose COMMIT record ENDS exactly at `target` (an end-of-record LSN), with the commit as the last
 * record. Returns what the lander's write answered (the registration) and the insert position right after the commit.
 */
async function landRegistration(c, target, { db, begin, tail, room, write } = gateLander(c)) {
  const want = bytePos(c, target);
  for (let attempt = 0; attempt < 120; attempt++) {
    const distance = want - bytePos(c, await insertLsn(db));
    const slack = tail.mStar + tail.commit + room;
    if (distance < slack) throw new Error(`target ${lsn(target)} already passed`);
    if (distance > slack + 4096n) {
      const chunk = distance - slack - 2048n;
      await filler(db, Number(chunk > 8n * 1024n * 1024n ? 8n * 1024n * 1024n : chunk));
      continue;
    }
    let id;
    try {
      await begin(async (sql) => {
        id = await write(sql);
        const need = want - bytePos(c, await insertLsn(sql)) - tail.commit;
        if (need < tail.mStar || (need - tail.mStar) % 8n !== 0n) throw new Error('retry');
        await sql`select pg_catalog.pg_logical_emit_message(true, 'prq1-pad', ${'x'.repeat(Number(BigInt(tail.pStar) + need - tail.mStar))})`;
      });
    } catch (e) {
      if (e.message === 'retry') continue;
      throw e;
    }
    const after = await insertLsn(db);
    if (bytePos(c, after) === want) return { id, after };
    throw new Error(`landing missed: wanted ${lsn(target)}, insert now ${lsn(after)}`);
  }
  throw new Error('landing did not converge');
}

/** The registration's own COMMIT record, read back from WAL (call once it is flushed). */
async function commitRecord(c, endLsn) {
  const rows = await c.owner`select start_lsn, end_lsn from public.pg_get_wal_records_info(${lsn(endLsn - 16384n)}::pg_lsn, ${lsn(endLsn)}::pg_lsn)
                             where resource_manager = 'Transaction' and record_type = 'COMMIT' order by end_lsn desc limit 1`;
  return rows[0];
}

/** Where the next record actually starts after a boundary: proves the header size on this build. */
async function nextRecordStart(c, from) {
  await filler(c.owner, 8);
  await c.owner`insert into ${c.owner(S)}.side values (1)`; // synchronous: flushes the filler
  const rows = await c.owner`select start_lsn from public.pg_get_wal_records_info(${lsn(from)}::pg_lsn, pg_catalog.pg_current_wal_flush_lsn())
                             order by start_lsn limit 1`;
  return big(rows[0].start_lsn);
}

const nextPageBoundary = (c, from, ahead = 6000n) => {
  let p = ((from + ahead) / c.blk + 1n) * c.blk;
  if (p % c.seg === 0n) p += c.blk; // an ordinary page, not a segment start
  return p;
};
const nextSegmentStart = (c, from, ahead = 6000n) => ((from + ahead) / c.seg + 1n) * c.seg;
/** The next 16 MB-aligned position that is NOT a segment start of this cluster (an ordinary page at 64 MB). */
const next16MbOrdinaryPage = (c, from, ahead = 6000n) => {
  let q = ((from + ahead) / MB16 + 1n) * MB16;
  while (q % c.seg === 0n) q += MB16;
  return q;
};

const setWalWriterDelay = async (c, value) => {
  if (value === null) await c.owner`alter system reset wal_writer_delay`;
  else await c.owner`alter system set wal_writer_delay = '10s'`;
  await c.owner`select pg_catalog.pg_reload_conf()`;
  await new Promise((r) => setTimeout(r, 300));
};

let c16;
let c64;

test.before(async () => {
  c16 = await openCluster('PDG', {});
  c64 = await openCluster('PDG64', { walSegmentMb: 64 });
  c16.tail = await calibrate(c16);
  c64.tail = await calibrate(c64);
});

test.after(async () => {
  await Promise.allSettled([c16?.end(), c64?.end()]);
});

test('PDG-01 durable single primaries, logged registration table, verified WAL layout and units', async () => {
  for (const [c, segMb] of [[c16, 16n], [c64, 64n]]) {
    const rows = await c.owner`select name, setting, unit from pg_catalog.pg_settings
                               where name in ('fsync', 'full_page_writes', 'synchronous_commit', 'wal_level', 'wal_block_size', 'wal_segment_size')`;
    const s = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(s.fsync.setting, 'on');
    assert.equal(s.full_page_writes.setting, 'on');
    assert.equal(s.synchronous_commit.setting, 'on', 'the cluster default; only the registering connection turns it off');
    assert.notEqual(s.wal_level.setting, 'minimal');
    // Units: wal_segment_size is reported in bytes ('B'); wal_block_size carries no unit and is bytes.
    assert.equal(s.wal_segment_size.unit, 'B');
    assert.equal(s.wal_block_size.unit, null);
    assert.equal(BigInt(s.wal_segment_size.setting), c.seg, 'pg_settings agrees with pg_control_init');
    assert.equal(BigInt(s.wal_block_size.setting), c.blk);
    assert.equal(c.seg, segMb * 1024n * 1024n);
    assert.equal(c.align, 8, 'the verified layout: max_data_alignment 8');
    const [{ persistence, recovery }] = await c.owner`select cl.relpersistence as persistence, pg_catalog.pg_is_in_recovery() as recovery
                                                      from pg_catalog.pg_class cl where cl.oid = ${`${S}.registration`}::regclass`;
    assert.equal(persistence, 'p');
    assert.equal(recovery, false);
    const [v] = await c.owner`select pg_catalog.current_setting('server_version_num')::int as num, pg_catalog.current_setting('listen_addresses') as listen,
                                     pg_catalog.current_setting('wal_sync_method') as sync, pg_catalog.current_setting('data_checksums') as sums`;
    assert.ok(v.num >= 160000 && v.num < 170000, `PostgreSQL 16.x (server_version_num ${v.num})`);
    assert.equal(v.listen, '', 'socket only: no TCP listener');
    console.log(`PDG-01/${segMb}MB: server_version_num ${v.num}, wal_sync_method ${v.sync}, data_checksums ${v.sums}`);
    assert.equal((await c.registrar`select current_setting('synchronous_commit') as sc`)[0].sc, 'off');
    // Raw page headers: the segment's first page has the long header (XLP_LONG_HEADER) naming this cluster's segment
    // and block sizes; the second page has a short header.
    const [{ f }] = await c.owner`select pg_catalog.pg_walfile_name(pg_catalog.pg_current_wal_insert_lsn()) as f`;
    const p0 = Buffer.from((await c.owner`select pg_catalog.pg_read_binary_file(${`pg_wal/${f}`}, 0, 40) as b`)[0].b);
    const p1 = Buffer.from((await c.owner`select pg_catalog.pg_read_binary_file(${`pg_wal/${f}`}, ${Number(c.blk)}, 24) as b`)[0].b);
    assert.equal(p0.readUInt16LE(2) & 0x0002, 0x0002, 'long header flag on the segment start page');
    assert.equal(BigInt(p0.readUInt32LE(32)), c.seg);
    assert.equal(BigInt(p0.readUInt32LE(36)), c.blk);
    assert.equal(p1.readUInt16LE(2) & 0x0002, 0, 'short header on an ordinary page');
  }
});

test('PDG-02 a registration visible before its flush gets no proof; the strict check issues only once flush >= L_end', async () => {
  const c = c16;
  let caught = null;
  for (let i = 0; i < 200 && caught === null; i++) {
    const id = randomUUID();
    await c.registrar`insert into ${c.registrar(S)}.registration (id, registered_xact) values (${id}, pg_catalog.pg_current_xact_id())`;
    const [o] = await c.issuer`select * from ${c.issuer(S)}.issue(${id}::uuid, 0)`;
    assert.ok(o.o_l !== null, 'the committed registration is visible to the second connection');
    assert.equal(o.o_issued, big(o.o_flush) >= big(o.o_l_end), 'issued exactly when flush >= L_end');
    if (!o.o_issued) caught = { id, ...o };
  }
  assert.ok(caught !== null, 'a visible-but-unflushed registration was observed');
  const [later] = await c.issuer`select * from ${c.issuer(S)}.issue(${caught.id}::uuid, ${BUDGET_MS})`;
  assert.equal(later.o_issued, true, JSON.stringify(later));
  assert.ok(big(later.o_flush) >= big(later.o_l_end));
});

test('PDG-03 on an idle primary, normal issuance completes inside the bounded budget every time', async () => {
  const c = c16;
  const waits = [];
  for (let i = 0; i < 40; i++) {
    const id = randomUUID();
    await c.registrar`insert into ${c.registrar(S)}.registration (id, registered_xact) values (${id}, pg_catalog.pg_current_xact_id())`;
    const [o] = await c.issuer`select * from ${c.issuer(S)}.issue(${id}::uuid, ${BUDGET_MS})`;
    assert.equal(o.o_issued, true, `attempt ${i}: ${JSON.stringify(o)}`);
    waits.push(o.o_waited_ms);
  }
  waits.sort((a, b) => a - b);
  console.log(`PDG-03 waits ms: max=${waits[waits.length - 1]} median=${waits[waits.length >> 1]}`);
});

/** Thrown when unrelated background WAL lands inside a measured window; the case retries on a fresh target. */
class UnrelatedWal extends Error {}
async function onFreshTarget(tag, makeTarget, run) {
  for (let i = 0; i < 4; i++) {
    try { return await run(await makeTarget()); } catch (e) {
      if (e instanceof UnrelatedWal || /landing missed|already passed/.test(e.message)) {
        console.log(`${tag}: retrying on a fresh target (${e.message})`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${tag}: unrelated WAL interfered on every attempt`);
}
async function land(c, target, expectedInsert, lander) {
  const r = await landRegistration(c, target, lander);
  if (r.after !== expectedInsert) throw new UnrelatedWal(`insert ${lsn(r.after)} after landing`);
  return r;
}

/** A boundary case: the commit ends exactly on `target`; the corrected check issues, the original does not. */
async function boundaryCase(c, makeTarget, header, tag) {
  await onFreshTarget(tag, makeTarget, async (target) => {
    const { id } = await land(c, target, target + header);
    const [fixed] = await c.issuer`select * from ${c.issuer(S)}.issue(${id}::uuid, ${BUDGET_MS})`;
    if (big(fixed.o_l) !== target + header) throw new UnrelatedWal(`L ${fixed.o_l} sampled after unrelated WAL`);
    assert.equal(big(fixed.o_l_end), target, `${tag}: L converted to the end of the commit record`);
    assert.equal(fixed.o_issued, true, `${tag}: corrected strict check completes inside the budget: ${JSON.stringify(fixed)}`);
    assert.ok(big(fixed.o_flush) < big(fixed.o_l), `${tag}: issued on the commit's own flush, not rescued by later WAL`);
    // The original rule, preserved: with no unrelated WAL it cannot complete.
    const [raw] = await c.issuer`select * from ${c.issuer(S)}.issue_raw(${id}::uuid, ${BUDGET_MS})`;
    const rescued = (await insertLsn(c.issuer)) !== target + header;
    console.log(`${tag}: L=${fixed.o_l} L_end=${fixed.o_l_end} flush=${fixed.o_flush} corrected=${fixed.o_issued} in ${fixed.o_waited_ms}ms; original=${raw.o_issued} after ${raw.o_waited_ms}ms${rescued ? ' (unrelated WAL arrived)' : ''}`);
    if (!rescued) assert.equal(raw.o_issued, false, `${tag}: the original strict rule did not complete`);
    // The normalized position is the observed end of the registration's own COMMIT record.
    assert.equal(big((await commitRecord(c, target)).end_lsn), target, `${tag}: commit record ends at L_end`);
    // And the next record really starts after a header of exactly that size.
    assert.equal(await nextRecordStart(c, target), target + header, `${tag}: the next record starts ${header} bytes in`);
  });
}

/** A past-the-header case: the commit ends `target`, inside real payload; L stays unchanged and must be flushed. */
async function payloadCase(c, makeTarget, tag, extra = () => {}) {
  await onFreshTarget(tag, makeTarget, async (target) => {
    const { id, after } = await land(c, target, target);
    extra(after);
    const [o] = await c.issuer`select * from ${c.issuer(S)}.issue(${id}::uuid, 0)`;
    if (big(o.o_l) !== target) throw new UnrelatedWal(`L ${o.o_l} sampled after unrelated WAL`);
    assert.equal(big(o.o_l_end), target, `${tag}: unchanged`);
    assert.equal(o.o_issued, false, `${tag}: refused while unflushed: ${JSON.stringify(o)}`);
    assert.ok(big(o.o_flush) < target, `${tag}: flush below the commit end`);
    await c.owner`insert into ${c.owner(S)}.side values (3)`; // an unrelated synchronous commit flushes past it
    const [later] = await c.issuer`select * from ${c.issuer(S)}.issue(${id}::uuid, ${BUDGET_MS})`;
    assert.equal(later.o_issued, true, tag);
    assert.equal(big((await commitRecord(c, target)).end_lsn), target, `${tag}: real payload ends at the target`);
    console.log(`${tag}: L=L_end=${o.o_l_end} refused at flush ${o.o_flush}; issued after flush ${later.o_flush}`);
  });
}

test('PDG-04 short-header page boundary on an idle primary: original rule reproduced, corrected rule completes', async () => {
  for (const c of [c16, c64]) {
    await boundaryCase(c, async () => nextPageBoundary(c, await insertLsn(c.registrar)), SHORT, `PDG-04/${c.seg >> 20n}MB`);
  }
});

test('PDG-05 long-header segment boundary: the segment case is checked first and converts by the long header', async () => {
  for (const c of [c16, c64]) {
    await boundaryCase(c, async () => nextSegmentStart(c, await insertLsn(c.registrar)), LONG, `PDG-05/${c.seg >> 20n}MB`);
  }
});

test('PDG-06 64 MB cluster: a 16 MB-aligned page is an ordinary page; a hard-coded default would be unsafe there', async () => {
  const c = c64;
  // (a) The commit ends ON a 16 MB-aligned ordinary page boundary: the short header applies.
  await boundaryCase(c, async () => next16MbOrdinaryPage(c, await insertLsn(c.registrar)), SHORT, 'PDG-06a');
  // (b) The commit ends 40 bytes into such a page: 16 bytes of real record payload after the short header.
  const hardCoded16 = (l) => (l % MB16 === 40n ? l - 40n : l % 8192n === 24n ? l - 24n : l);
  await setWalWriterDelay(c, '10s');
  try {
    await payloadCase(c, async () => next16MbOrdinaryPage(c, await insertLsn(c.registrar)) + 40n, 'PDG-06b', (after) => {
      assert.equal(hardCoded16(after), after - 40n, 'a hard-coded 16 MB segment would place the target before the commit end');
    });
  } finally { await setWalWriterDelay(c, null); }
});

test('PDG-07 positions just past the first usable byte stay unchanged and are refused while unflushed', async () => {
  const c = c16;
  await setWalWriterDelay(c, '10s');
  try {
    // Real record payload 8, 16 and 24 bytes past a short header, and 8 bytes past a long header.
    for (const [tag, offset] of [['page+32', 32n], ['page+40', 40n], ['page+48', 48n]]) {
      await payloadCase(c, async () => nextPageBoundary(c, await insertLsn(c.registrar)) + offset, `PDG-07 ${tag}`);
    }
    await payloadCase(c, async () => nextSegmentStart(c, await insertLsn(c.registrar)) + 48n, 'PDG-07 segment+48');
  } finally { await setWalWriterDelay(c, null); }
});

test('PDG-08 unrelated WAL ahead of the commit: bounded refusal, then issuance only once the sampled target is flushed', async () => {
  const c = c16;
  const id = randomUUID();
  await c.registrar`insert into ${c.registrar(S)}.registration (id, registered_xact) values (${id}, pg_catalog.pg_current_xact_id())`;
  const [before] = await c.owner`select xmin::text as xmin, registered_xact::text as x from ${c.owner(S)}.registration where id = ${id}`;
  let refused;
  // An unrelated transaction still in progress has inserted WAL after the registration commit. Nothing asks the WAL
  // writer to flush it until that transaction ends.
  await c.owner.begin(async (sql) => {
    await sql`insert into ${sql(S)}.side values (5)`;
    [refused] = await c.issuer`select * from ${c.issuer(S)}.issue(${id}::uuid, ${BUDGET_MS})`;
  });
  console.log(`PDG-08: L_end=${refused.o_l_end} flush=${refused.o_flush} issued=${refused.o_issued} after ${refused.o_waited_ms}ms`);
  assert.equal(refused.o_issued, false, 'refused: the sampled target is not flushed within the budget');
  assert.ok(refused.o_waited_ms >= BUDGET_MS && refused.o_waited_ms < BUDGET_MS + 500, 'the refusal is bounded');
  const [unchanged] = await c.owner`select xmin::text as xmin, registered_xact::text as x from ${c.owner(S)}.registration where id = ${id}`;
  assert.deepEqual(unchanged, before, 'the refusal did not alter the registration');
  // The unrelated transaction committed (synchronously): the retried, same-session proof request now issues.
  const [later] = await c.issuer`select * from ${c.issuer(S)}.issue(${id}::uuid, ${BUDGET_MS})`;
  assert.equal(later.o_issued, true);
  assert.ok(big(later.o_flush) >= big(later.o_l_end));
  assert.ok(big(later.o_l_end) >= big(refused.o_l_end), 'the retry sampled its own target');
});

// ===========================================================================
// PDG-09..13: migration 037's REAL routines on the same two clusters, then a crash.
// ===========================================================================
// 001-037 by the trusted executor, the runtime login with tmpos_app and tmpos_audit_writer, both keys installed by the owner
// and a fixture made as the IRR suite makes it (tests/db/invoicePaymentRegistrationRoutine.integration.test.mjs): the
// tenant, store, customer, identities and memberships synthetic; sessions, settings, invoices and every payment row only
// through the routines.
const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'pdg-migrator', runtimeRef: 'pdg-runtime' };
const LOCK_KEY = 529_638;
const NS = 'tmpos_invoice_payment';
const APP_LOGIN = 'tmpos_pdg_app';
const SUFFIX = randomUUID().slice(0, 8);
const MB = 1024n * 1024n;
const AHEAD = 60_000n; // a real registration's own WAL (full-page images included) needs room before its target
const LINES = [{ description: 'Screen replacement', quantity: 1, unitPriceCents: 12_999 }, { description: 'Labour', quantity: 2, unitPriceCents: 4_500 }];
const TOTAL = 12_999 + 2 * 4_500;

// Secret-safe output, the IRR suite's rule: node:test prints a failing assertion's actual/expected and a thrown error's detail,
// so proofs, keys, session keys and digests are compared as booleans with fixed text, and a database error from a call that
// binds one is reduced to a validated SQLSTATE.
const isSqlState = (code) => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code);
function sealDbError(label, e) {
  let code; // read ONCE (a getter could answer differently twice), then only that validated value is printed
  try { code = e?.code; } catch { code = undefined; }
  if (isSqlState(code)) return new Error(`${label}: SQLSTATE ${code}`);
  const bare = e instanceof Error && !(e instanceof AggregateError)
    && e.cause === undefined && e.detail === undefined && e.hint === undefined && e.where === undefined;
  if (bare) return e;
  const name = typeof e?.constructor?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.constructor.name) ? e.constructor.name : 'unknown';
  return new Error(`${label}: failed (${name})`);
}
const redactProof = (rows) => rows.map((r) => (r.o_proof === null || r.o_proof === undefined ? r : { ...r, o_proof: '<present>' }));
const PRF_COLS = ['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_registration_id', 'o_attempt_id', 'o_proof'];
const NO_PRF = (word) => [Object.fromEntries([['o_outcome', word], ...PRF_COLS.map((k) => [k, null])])];

// The mint and proof constructions, computed here independently of the database.
const netstring = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from(`${b.length}:`), b, Buffer.from(',')]); };
const mintMessage = (key, r, expiresAt) => Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion,
    r.authenticatedAt === null ? '' : r.authenticatedAt, r.createdAt, r.lastSeenAt, r.validatedAt, expiresAt].map((v) => netstring(String(v)))]);
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
const uuidBytes = (u) => Buffer.from(u.replace(/-/g, ''), 'hex');
const int8 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
/** HMAC-SHA-256 over 037's fixed-width message for registration `r` of the store owner's session. */
const expectedProof = (c, f, r) => createHmac('sha256', c.pk.key).update(Buffer.concat([
  Buffer.from('tmpos-m7b-payment-registration-proof:v1', 'utf8'), Buffer.from([0]),
  ...[r.registration, f.boss.id, f.tenant, f.store, r.invoice, r.attempt].map(uuidBytes),
  createHash('sha256').update(Buffer.from(f.kBoss, 'utf8')).digest(), int8(c.pk.generation)])).digest('hex');

async function trustedApply(c) {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(c.target.dsn));
  try {
    return await runTrustedApply({ fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: () => new Date().toISOString(), deadlineMs: 300_000 });
  } finally {
    await handle.dispose();
  }
}

async function actor(c, label, m) {
  const uid = `pdg-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await c.owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await c.owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  const [{ membership_id: membership }] = await c.owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${id}, ${m.tenant}, ${m.store}, ${m.scope}, ${m.role}, 'active') returning membership_id`;
  return { id, uid, membership, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
async function mint(c, who) {
  const key = newKey();
  const at = Date.now();
  const r = { audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
    securityVersion: 't2:pdg', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at };
  const expiresAt = at + 8 * 3_600_000;
  const mac = createHmac('sha256', c.mintKey).update(mintMessage(key, r, expiresAt)).digest();
  const [{ outcome }] = await c.app.runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint, ${mac}::bytea) as outcome`
    .catch((e) => { throw sealDbError('PDG mint', e); });
  assert.equal(outcome, 'created', 'a tenant session');
  return key;
}
/** One tenant and store, a customer, the store's owner (who registers, proves and records) and a tenant owner (settings). */
async function fixture(c) {
  const { owner } = c;
  const [{ tenant_id: tenant }] = await owner`insert into tenant (display_name, status) values (${`pdg-${SUFFIX}`}, 'active') returning tenant_id`;
  const [{ store_id: store }] = await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`pdg-a ${SUFFIX}`}, 'active') returning store_id`;
  const customer = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${customer}, ${tenant}, ${`PDG ${SUFFIX}`})`;
  const boss = await actor(c, 'owner', { scope: 'store', tenant, store, role: 'store_owner' });
  const own = await actor(c, 'tenant-owner', { scope: 'tenant', tenant, store: null, role: 'store_owner' });
  const f = { tenant, store, customer, boss, kBoss: await mint(c, boss), kOwn: await mint(c, own) };
  const [row] = await c.app.runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_issuing_settings_set($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
    [f.kOwn, store, tenant, '0', 'PDG Legal Name LLC', 'PDG Store', '1 Main St\nSpringfield', 'TAX-PDG-1', 'exclusive_rate', 8875]).catch((e) => { throw sealDbError('PDG settings', e); });
  assert.equal(row.o_outcome, 'applied', 'the store\'s issuing settings');
  return f;
}
/** A fresh issued invoice: a free registration slot. */
async function issueOne(c, f) {
  const draft = randomUUID();
  const invoice = randomUUID();
  const [d] = await c.app.runtime.unsafe(`select o_outcome from tmpos_invoice_edit.m7b_invoice_draft_create_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [f.kBoss, f.store, draft, f.tenant, f.customer, JSON.stringify(LINES), String(TOTAL)]).catch((e) => { throw sealDbError('PDG draft save', e); });
  assert.equal(d.o_outcome, 'applied', 'the draft saved');
  const [i] = await c.app.runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_invoice_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [f.kBoss, f.store, draft, f.tenant, '1', '1', '1', invoice]).catch((e) => { throw sealDbError('PDG issue', e); });
  assert.equal(i.o_outcome, 'applied', 'the draft issued');
  return invoice;
}

// The runtime login's calls, bound as a production adapter binds them; a failure reports a fixed label and its SQLSTATE only.
const sealed = (label, q) => (async () => (await q).map((x) => ({ ...x })))().catch((e) => { throw sealDbError(label, e); });
const registerCall = (db, f, r) => sealed('PDG register', db.unsafe(`select * from ${NS}.m7b_invoice_payment_register($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid)`,
  [f.kBoss, f.store, r.invoice, f.tenant, r.registration, r.attempt, randomUUID()]));
const proofCall = (db, f, r, wait) => sealed('PDG proof', db.unsafe(`select * from ${NS}.m7b_invoice_payment_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
  [f.kBoss, f.store, r.invoice, f.tenant, r.registration, wait]));
const recordCall = (db, f, r, proof, payment, amount) => sealed('PDG record', db.unsafe(`select * from ${NS}.m7b_invoice_payment_record_v2($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`,
  [f.kBoss, f.store, r.invoice, f.tenant, payment, r.registration, r.attempt, String(amount), 'cash', proof, randomUUID()]));
const settleCall = (db, f, r, version) => sealed('PDG settle', db.unsafe(`select * from ${NS}.m7b_invoice_payment_settle($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::uuid)`,
  [f.kBoss, f.store, r.invoice, f.tenant, r.attempt, String(version), randomUUID()]));

/** The proof row: outcome 'proof' with its ids, and the proof equal to the independent HMAC — a boolean, never the value. */
function provenProof(c, f, r, rows, tag) {
  assert.equal(rows.length, 1, `${tag}: one proof row`);
  const { o_proof: got, ...rest } = rows[0];
  assert.deepEqual(rest, { o_outcome: 'proof', o_tenant_id: f.tenant, o_store_id: f.store, o_invoice_id: r.invoice,
    o_registration_id: r.registration, o_attempt_id: r.attempt }, `${tag}: the proof row (proof withheld)`);
  assert.ok(got === expectedProof(c, f, r), `${tag}: the proof equals the independent HMAC (values withheld)`);
  return got;
}

/**
 * The landing transaction on the REAL register routine: the runtime login's registrar (synchronous_commit off, a permitted
 * direct caller), its own transaction. The write answers the registration with its top-level xid; a calibration registration
 * is withdrawn (settled at version 1) to free the invoice's slot.
 */
const appLander = (c, f, invoice) => ({
  db: c.app.registrar, tail: c.appTail, room: 12_000n,
  // A COMMIT-time error is sealed too; the 'retry' marker and an AssertionError pass through unchanged.
  begin: (fn) => c.app.registrar.begin(fn).catch((e) => { throw sealDbError('PDG landing registration', e); }),
  write: async (sql) => {
    const r = { invoice, registration: randomUUID(), attempt: randomUUID() };
    assert.equal((await registerCall(sql, f, r))[0]?.o_outcome, 'applied', 'registered by the real routine');
    r.xid = (await sql`select pg_catalog.pg_current_xact_id()::text as x`)[0].x;
    return r;
  },
  release: async (r) => assert.equal((await settleCall(c.app.runtime, f, r, 1))[0]?.o_outcome, 'applied', 'the calibration registration withdrawn'),
});

const flushLsn = async (sql) => big((await sql`select pg_catalog.pg_current_wal_flush_lsn() as l`)[0].l);
/** One transaction's COMMIT record, read back from FLUSHED WAL with pg_walinspect: { start, end } or null. */
async function commitOf(c, xid, from, to) {
  const rows = await c.owner`select start_lsn, end_lsn from public.pg_get_wal_records_info(${lsn(from)}::pg_lsn, ${lsn(to)}::pg_lsn)
                             where resource_manager = 'Transaction' and record_type = 'COMMIT' and xid = pg_catalog.xid(${xid}::xid8)`;
  assert.ok(rows.length <= 1, 'one COMMIT record per transaction');
  return rows.length === 0 ? null : { start: big(rows[0].start_lsn), end: big(rows[0].end_lsn) };
}
/**
 * One transaction's WAL from FLUSHED WAL: its COMMIT { start, end } and the end of every OTHER record of it or of its
 * subtransactions (the register routine writes inside an exception block; the COMMIT record names those subxacts).
 */
async function xactWal(c, xid, from, to) {
  const rows = await c.owner`select w.start_lsn, w.end_lsn, w.xid::text as xid, pg_catalog.xid(${xid}::xid8)::text as top,
        (w.resource_manager = 'Transaction' and w.record_type = 'COMMIT') as is_commit,
        case when w.resource_manager = 'Transaction' and w.record_type = 'COMMIT' then w.description end as d
      from public.pg_get_wal_records_info(${lsn(from)}::pg_lsn, ${lsn(to)}::pg_lsn) w`;
  const commits = rows.filter((x) => x.is_commit && x.xid === x.top);
  assert.ok(commits.length <= 1, 'one COMMIT record per transaction');
  if (commits.length === 0) return null;
  const subs = /subxacts:((?: \d+)+)/.exec(commits[0].d)?.[1].trim().split(' ') ?? [];
  const mine = new Set([commits[0].top, ...subs]);
  const start = big(commits[0].start_lsn);
  return { start, end: big(commits[0].end_lsn), subxacts: subs.length,
    others: rows.filter((x) => !x.is_commit && mine.has(x.xid)).map((x) => big(x.end_lsn)),
    // Every record that starts before the COMMIT, of any transaction (aborted subtransactions and unrelated WAL included).
    lastBefore: rows.filter((x) => big(x.start_lsn) < start).reduce((a, x) => (big(x.end_lsn) > a ? big(x.end_lsn) : a), 0n) };
}

/** PDG-10..14 need PDG-09's setup; without it they fail with this fixed text instead of a TypeError. */
const appReady = (c, tag) => assert.ok(c?.ready === true, `${tag}: PDG-09's setup (migrations, runtime login, keys, fixture) did not complete on this cluster`);

/** Migrations 001-037, the runtime login and its three connections, both keys, the fixture and the real register tail. */
async function openApp(c, tag) {
  const { owner } = c;
  assert.equal(c.target.source, 'harness', `${tag}: migrations go only on a cluster this suite started`);
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${c.target.database}" from public`);
  await owner.unsafe(`revoke temporary on database "${c.target.database}" from public`);
  const report = await trustedApply(c).catch((e) => { throw sealDbError(`${tag} trusted apply`, e); });
  assert.equal(report.outcome, 'complete', `${tag}: 001-037 by the trusted executor`);
  const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
  const exact = ledger.length === REQUIRED_MIGRATIONS.length
    && ledger.every((row, i) => row.version === REQUIRED_MIGRATIONS[i].version && row.checksum === REQUIRED_MIGRATIONS[i].checksum);
  assert.ok(exact && ledger.at(-1)?.version === '037', `${tag}: the ledger is exactly REQUIRED_MIGRATIONS through 037 (${ledger.length} rows; checksums withheld)`);
  // Autovacuum and autoanalyze of the migrated tables would add background WAL inside the measured windows.
  await owner`alter system set autovacuum = off`;
  await owner`select pg_catalog.pg_reload_conf()`;
  await new Promise((r) => setTimeout(r, 300));
  // Off starts no new worker; one already running still writes WAL, so wait it out (bounded; landings retry beyond that).
  for (let i = 0; ; i++) {
    const [{ n }] = await owner`select count(*)::int as n from pg_catalog.pg_stat_activity where backend_type = 'autovacuum worker'`;
    if (n === 0) break;
    if (i === 99) { console.log(`${tag}: an autovacuum worker still runs after 10 s; the landings' retries absorb its WAL`); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  await owner.unsafe(`create role ${APP_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${APP_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${APP_LOGIN}`);
  const mk = (max) => testClient(c.target, { user: APP_LOGIN, max, onnotice: () => {} });
  c.app = { runtime: mk(2), registrar: mk(1), issuer: mk(1) };
  await c.app.registrar`set synchronous_commit = off`;
  c.mintKey = await installTestIssuerKey(owner);
  const proofKey = randomBytes(32);
  assert.equal(await installTestPaymentProofKey(owner, proofKey), true, `${tag}: a payment proof key installed`);
  const [probe] = await c.app.runtime`select * from tmpos_invoice_payment.m7b_payment_proof_key_probe()`;
  assert.equal(probe.o_present, true, `${tag}: the probe sees the key`);
  c.pk = { key: proofKey, generation: BigInt(probe.o_generation) };
  c.fx = await fixture(c);
  c.appTail = await calibrate(c, appLander(c, c.fx, await issueOne(c, c.fx)));
  c.ready = true;
}

test('PDG-09 migrations 001-037 by the trusted executor on both clusters, the runtime login, keys and fixture; still PostgreSQL 16 durable single primaries at 16 and 64 MB', async () => {
  for (const [c, segMb] of [[c16, 16n], [c64, 64n]]) {
    const tag = `PDG-09/${segMb}MB`;
    await openApp(c, tag);
    const [s] = await c.owner`select pg_catalog.current_setting('server_version_num')::int as num, pg_catalog.pg_is_in_recovery() as recovery,
        (select setting from pg_catalog.pg_settings where name = 'wal_segment_size')::bigint as seg_setting,
        (select bytes_per_wal_segment from pg_catalog.pg_control_init())::bigint as seg_control,
        pg_catalog.current_setting('fsync') as fsync, pg_catalog.current_setting('full_page_writes') as fpw,
        pg_catalog.current_setting('synchronous_commit') as sc, pg_catalog.current_setting('wal_level') as wal_level,
        pg_catalog.current_setting('autovacuum') as autovacuum, pg_catalog.current_setting('synchronous_standby_names') as standbys,
        (select count(*) from pg_catalog.pg_stat_replication)::int as senders`;
    assert.ok(s.num >= 160000 && s.num < 170000, `${tag}: PostgreSQL 16.x (server_version_num ${s.num})`);
    assert.equal(s.recovery, false, `${tag}: a primary, not in recovery`);
    assert.equal(BigInt(s.seg_setting), segMb * MB, `${tag}: pg_settings wal_segment_size`);
    assert.equal(BigInt(s.seg_control), segMb * MB, `${tag}: pg_control_init().bytes_per_wal_segment`);
    assert.deepEqual([s.fsync, s.fpw, s.sc], ['on', 'on', 'on'], `${tag}: fsync, full_page_writes and the cluster's synchronous_commit on`);
    assert.notEqual(s.wal_level, 'minimal', `${tag}: wal_level`);
    assert.deepEqual([s.senders, s.standbys], [0, ''], `${tag}: a SINGLE primary: no WAL sender, no synchronous standby named`);
    assert.equal(s.autovacuum, 'off', `${tag}: autovacuum off after the migrations`);
    const [app] = await c.app.registrar`select current_user::text as u, pg_catalog.current_setting('synchronous_commit') as sc,
        (select rolsuper from pg_catalog.pg_roles where rolname = current_user) as su`;
    assert.deepEqual({ ...app }, { u: APP_LOGIN, sc: 'off', su: false }, `${tag}: the registrar is the runtime login, not a superuser, synchronous_commit off`);
    console.log(`${tag}: ledger 001-037; real register tail: pad ${c.appTail.pStar} B -> ${c.appTail.mStar} B, COMMIT ${c.appTail.commit} B`);
  }
});

/** A REAL registration whose COMMIT record ends exactly on `target`; the REAL proof routine issues within its budget. */
async function appBoundaryCase(c, makeTarget, header, tag) {
  appReady(c, tag);
  const f = c.fx;
  await onFreshTarget(tag, async () => {
    const invoice = await issueOne(c, f); // a fresh invoice per attempt: a missed landing keeps its slot
    return { invoice, target: await makeTarget() };
  }, async ({ invoice, target }) => {
    const { id: r } = await land(c, target, target + header, appLander(c, f, invoice));
    const t0 = Date.now();
    const rows = await proofCall(c.app.issuer, f, r, BUDGET_MS);
    const took = Date.now() - t0;
    const after = await insertLsn(c.owner);
    const flush = await flushLsn(c.owner);
    if (after !== target + header) throw new UnrelatedWal(`insert ${lsn(after)} after the proof`);
    provenProof(c, f, r, rows, tag);
    assert.ok(took < BUDGET_MS + 500, `${tag}: issued within the budget (${took} ms)`);
    assert.ok(flush >= target && flush < target + header, `${tag}: issued on the commit's own flush ${lsn(flush)}, below the raw L ${lsn(target + header)}`);
    const rec = await commitOf(c, r.xid, target - 16384n, target);
    assert.ok(rec !== null && rec.end === target, `${tag}: pg_walinspect: the registration's COMMIT ends exactly at ${lsn(target)}`);
    console.log(`${tag}: COMMIT ${lsn(rec.start)}..${lsn(rec.end)} on the boundary, raw L ${lsn(target + header)}, flush ${lsn(flush)}; outcome proof in ${took} ms`);
  });
}

test('PDG-10 REAL routines, short-header page boundary on both sizes: the register commit ends exactly on an ordinary page, the proof issues within its budget', async () => {
  for (const c of [c16, c64]) {
    await appBoundaryCase(c, async () => nextPageBoundary(c, await insertLsn(c.app.registrar), AHEAD), SHORT, `PDG-10/${c.seg >> 20n}MB page`);
  }
});

test('PDG-11 REAL routines, long-header segment boundary on both sizes: the register commit ends exactly at a segment start, the proof issues within its budget', async () => {
  for (const c of [c16, c64]) {
    await appBoundaryCase(c, async () => nextSegmentStart(c, await insertLsn(c.app.registrar), AHEAD), LONG, `PDG-11/${c.seg >> 20n}MB segment`);
  }
});

test('PDG-12 REAL routines, 64 MB cluster: the register commit ends on a 16 MB-aligned ordinary page, the proof issues within its budget', async () => {
  await appBoundaryCase(c64, async () => next16MbOrdinaryPage(c64, await insertLsn(c64.app.registrar), AHEAD), SHORT, 'PDG-12/64MB 16MB-aligned page');
});

const STATE = ['server_version_num', 'fsync', 'full_page_writes', 'synchronous_commit', 'synchronous_standby_names', 'wal_level',
  'wal_segment_size', 'wal_block_size', 'wal_sync_method', 'data_checksums', 'wal_log_hints', 'listen_addresses', 'wal_writer_delay',
  'autovacuum', 'lc_messages', 'max_connections'];
async function clusterState(c) {
  const rows = await c.owner`select name, setting from pg_catalog.pg_settings where name = any(${STATE}::text[])`;
  const [s] = await c.owner`select pg_catalog.pg_postmaster_start_time() as started, pg_catalog.pg_is_in_recovery() as recovery,
      (select count(*) from pg_catalog.pg_stat_replication)::int as senders`;
  return { settings: { ...Object.fromEntries(rows.map((x) => [x.name, x.setting])), senders: s.senders }, started: s.started.getTime(), recovery: s.recovery };
}
/** After the crash a pool's old connection is closed; its next query reconnects. A harmless probe, bounded retries. */
async function reconnect(sql, label) {
  for (let i = 0; ; i++) {
    try { await sql`select 1`; return; } catch (e) {
      if (i === 20) throw sealDbError(label, e);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
const lastLsnIn = (text, re) => { const all = [...text.matchAll(re)]; return all.length === 0 ? null : big(all[all.length - 1][1]); };
/** The end-of-recovery checkpoint recycles every segment before its own: keep what follows in the current one (S stays readable). */
async function keepInSegment(c) {
  const left = c.seg - ((await insertLsn(c.owner)) % c.seg);
  if (left < 4n * MB) await filler(c.owner, Number(left));
}
const crashable = (c, tag) => assert.equal(typeof c.target.cluster?.crashRestart, 'function', `${tag}: a cluster this suite started and can crash`);
const registrarAsync = async (c, tag) => assert.equal((await c.app.registrar`select pg_catalog.current_setting('synchronous_commit') as s`)[0].s, 'off',
  `${tag}: the registrar commits with synchronous_commit off`);

/**
 * The proof, then AT ONCE a PROCESS crash, and what must hold after it (PDG-13 and PDG-14). Nothing runs on any connection
 * between the proof routine's answer and the crash. `pg_ctl -m immediate` stops the server with no shutdown checkpoint; the
 * OS page cache survives, so this shows the server's own redo pass covered the COMMIT (redo starts <= S <= redo done) and the
 * registration is back afterwards. It does NOT exercise power loss: that rests on fsync on and PostgreSQL's flush contract.
 * Then the pre-crash proof, in its ORIGINAL scope (session, actor, tenant, store, invoice, registration, attempt), records
 * exactly one payment as the runtime login.
 */
async function proveThenCrash(c, r, commit, tag) {
  const f = c.fx;
  const { start, end } = commit;
  const pre = await clusterState(c);
  assert.equal(pre.settings.lc_messages, 'C', `${tag}: lc_messages C, so the recovery lines parsed below are English`);
  const t0 = Date.now();
  const rows = await proofCall(c.app.issuer, f, r, BUDGET_MS);
  const took = Date.now() - t0;
  const { log } = await c.target.cluster.crashRestart(); // AT ONCE: no statement on any connection since the proof returned
  const proof = provenProof(c, f, r, rows, `${tag} pre-crash proof`);
  for (const [sql, who] of [[c.owner, 'owner'], [c.app.runtime, 'runtime'], [c.app.registrar, 'registrar']]) await reconnect(sql, `${tag} ${who} after the crash`);
  await c.app.registrar`set synchronous_commit = off`; // a session setting does not survive the crash
  const post = await clusterState(c);
  assert.ok(post.started > pre.started, `${tag}: pg_postmaster_start_time advanced`);
  assert.equal(post.recovery, false, `${tag}: a primary again, not in recovery`);
  assert.deepEqual(post.settings, pre.settings, `${tag}: settings and the absence of any WAL sender unchanged by the restart`);
  assert.ok(log.includes('database system was not properly shut down; automatic recovery in progress'), `${tag}: the server log shows automatic crash recovery (log withheld)`);
  const redoStart = lastLsnIn(log, /redo starts at ([0-9A-F]+\/[0-9A-F]+)/g);
  const redoDone = lastLsnIn(log, /redo done at ([0-9A-F]+\/[0-9A-F]+)/g);
  assert.ok(redoStart !== null && redoDone !== null, `${tag}: the log names where redo started and ended (log withheld)`);
  assert.ok(redoStart <= start, `${tag}: redo started at ${lsn(redoStart)}, at or before the COMMIT start ${lsn(start)}`);
  assert.ok(redoDone >= start, `${tag}: redo done at ${lsn(redoDone)}, at or after the COMMIT start ${lsn(start)}`);
  const [{ st }] = await c.owner`select pg_catalog.pg_xact_status(${r.xid}::xid8) as st`;
  assert.equal(st, 'committed', `${tag}: the registering transaction is committed after recovery`);
  const again = await commitOf(c, r.xid, start, end);
  assert.ok(again !== null && again.start === start && again.end === end, `${tag}: pg_walinspect still finds the COMMIT at ${lsn(start)}..${lsn(end)}`);
  const reg = await c.owner`select registered_xact::text as x, payment_id from tmpos_invoice_payment.invoice_payment_registration where registration_id = ${r.registration}`;
  assert.ok(reg.length === 1 && reg[0].x === r.xid && reg[0].payment_id === null, `${tag}: the registration row is back, open, of that transaction`);
  const [{ n }] = await c.owner`select count(*)::int as n from public.audit_event where subject_invoice_payment_registration_id = ${r.registration}`;
  assert.equal(n, 1, `${tag}: its registration audit record is back`);
  const counts = async () => ({ ...(await c.owner`select (select count(*) from tmpos_invoice_payment.invoice_payment)::int as payments,
      (select count(*) from public.audit_event)::int as audits`)[0] });
  const was = await counts();
  const payment = randomUUID();
  const recorded = await recordCall(c.app.runtime, f, r, proof, payment, 5000);
  assert.equal(recorded.length, 1, `${tag}: one record row`);
  const { o_audit_event_id: event, ...rest } = recorded[0];
  assert.deepEqual(rest, { o_outcome: 'applied', o_tenant_id: f.tenant, o_store_id: f.store, o_actor_id: f.boss.id, o_membership_id: f.boss.membership,
    o_payment_id: payment, o_invoice_id: r.invoice }, `${tag}: record v2 with the pre-crash proof applied`);
  const now = await counts();
  assert.equal(now.payments, was.payments + 1, `${tag}: exactly ONE payment row`);
  assert.equal(now.audits, was.audits + 1, `${tag}: exactly ONE audit row`);
  const pays = await c.owner`select payment_id, attempt_id, amount_cents::text as amount, recorded_by from tmpos_invoice_payment.invoice_payment where invoice_id = ${r.invoice}`;
  assert.deepEqual(pays.map((x) => ({ ...x })), [{ payment_id: payment, attempt_id: r.attempt, amount: '5000', recorded_by: f.boss.id }], `${tag}: the invoice's one payment`);
  const audits = await c.owner`select a.event_id, a.action_id, a.subject_invoice_payment_registration_id as reg from public.audit_event a
      where a.subject_invoice_payment_id in (select p.payment_id from tmpos_invoice_payment.invoice_payment p where p.invoice_id = ${r.invoice})`;
  assert.deepEqual(audits.map((x) => ({ ...x })), [{ event_id: event, action_id: 'store.invoice_payment.record', reg: r.registration }], `${tag}: the invoice's one payment audit entry`);
  return { took, redoStart, redoDone };
}

/**
 * D-R4-1 with a NEGATIVE CONTROL, on one cluster: a registration (real routine, runtime login, synchronous_commit off, its own
 * transaction) whose every record but its COMMIT is flushed by an unrelated synchronous commit made inside it (F_mid); the
 * proof routine refuses (wait 0) while the flush is at most the COMMIT's START, so it gates on the COMMIT itself, not on an
 * earlier registration record. Then the COMMIT is flushed and confirmed independently (pg_current_wal_flush_lsn and
 * pg_walinspect), not yet covered by a checkpoint, and proveThenCrash runs.
 */
async function crashCase(c, tag) {
  appReady(c, tag);
  crashable(c, tag);
  const f = c.fx;
  await registrarAsync(c, tag);
  for (let round = 0; round < 4; round++) {
    const invoice = await issueOne(c, f);
    await keepInSegment(c);
    await c.owner`checkpoint`; // recovery then starts just before the registration
    await filler(c.owner, 8); // xid-less WAL only the WAL writer flushes: it leaves hibernation before the delay is raised
    const r = { invoice, registration: randomUUID(), attempt: randomUUID() };
    let before, fMid, afterCommit, refusal, flushAfterRefusal, insertAfterRefusal;
    await setWalWriterDelay(c, '10s');
    try {
      before = await insertLsn(c.app.registrar);
      await c.app.registrar.begin(async (sql) => {
        assert.equal((await registerCall(sql, f, r))[0]?.o_outcome, 'applied', `${tag}: registered by the real routine`);
        r.xid = (await sql`select pg_catalog.pg_current_xact_id()::text as x`)[0].x;
        // The control: an unrelated SYNCHRONOUS commit flushes every record the registration has written so far.
        await c.owner`select pg_catalog.pg_logical_emit_message(true, 'prq1-mid', 'x')`;
        fMid = await flushLsn(c.owner);
      }).catch((e) => { throw sealDbError(`${tag} registration`, e); });
      afterCommit = await insertLsn(c.app.registrar);
      refusal = await proofCall(c.app.issuer, f, r, 0);
      flushAfterRefusal = await flushLsn(c.owner); // read AFTER the answer: the flush was at most this when it was given
      insertAfterRefusal = await insertLsn(c.owner); // and no record was written after the COMMIT if this is its end
    } finally {
      await setWalWriterDelay(c, null);
    }
    await c.owner`select pg_catalog.pg_logical_emit_message(true, 'prq1-flush', 'x')`; // an unrelated synchronous commit
    const flushed = await flushLsn(c.owner);
    const wal = await xactWal(c, r.xid, before, flushed);
    assert.ok(wal !== null, `${tag}: pg_walinspect finds the registration's COMMIT in flushed WAL`);
    const { start, end } = wal;
    assert.ok(flushed >= end && end <= afterCommit, `${tag}: flush ${lsn(flushed)} >= COMMIT end ${lsn(end)}, the registrar's last record ending by ${lsn(afterCommit)}`);
    if (refusal[0]?.o_outcome === 'proof') {
      assert.ok(flushAfterRefusal >= end, `${tag}: a proof was issued while the flush ${lsn(flushAfterRefusal)} was below the COMMIT end ${lsn(end)}`);
      console.log(`${tag}: round ${round}: the COMMIT was flushed before a refusal could be observed; retrying on a fresh invoice`);
      continue;
    }
    assert.deepEqual(redactProof(refusal), NO_PRF('not_durable'), `${tag}: the real proof routine refuses (wait 0)`);
    // No byte of the COMMIT flushed: flush <= S. (The control's own synchronous commit flushes exactly to its record's end, and
    // the COMMIT is the next record, so F_mid = S when nothing else wrote WAL in between.)
    if (flushAfterRefusal > start) {
      console.log(`${tag}: round ${round}: the flush ${lsn(flushAfterRefusal)} passed the COMMIT start ${lsn(start)} before it was read; retrying on a fresh invoice`);
      continue;
    }
    // The COMMIT is the FIRST unflushed record: every record before it since the transaction began (its own, aborted
    // subtransactions' and unrelated ones) ends by F_mid, and the flush stayed at or below S.
    if (wal.lastBefore > fMid) {
      console.log(`${tag}: round ${round}: WAL ending ${lsn(wal.lastBefore)} landed between F_mid ${lsn(fMid)} and the COMMIT; retrying on a fresh invoice`);
      continue;
    }
    // The refusal is at flush EXACTLY S (F_mid <= flush <= S), so no gate at or before the COMMIT start can explain it. When a
    // page header lies between F_mid and S (the COMMIT begins a page), a gate on S would also refuse: take another round.
    if (fMid !== start) {
      console.log(`${tag}: round ${round}: F_mid ${lsn(fMid)} is not the COMMIT start ${lsn(start)} (a page header between); retrying on a fresh invoice`);
      continue;
    }
    // Nothing after the COMMIT through the refusal: the COMMIT was the ONLY unflushed WAL when the routine answered. (A COMMIT
    // ending exactly on a page boundary also retries: the insert position then skips the next page header. Conservative.)
    if (insertAfterRefusal !== end) {
      console.log(`${tag}: round ${round}: WAL past the COMMIT end ${lsn(end)} (insert ${lsn(insertAfterRefusal)}) by the refusal; retrying on a fresh invoice`);
      continue;
    }
    assert.ok(wal.others.length > 0, `${tag}: the transaction wrote records before its COMMIT`);
    const [{ redo }] = await c.owner`select redo_lsn as redo from pg_catalog.pg_control_checkpoint()`;
    if (big(redo) >= start) {
      console.log(`${tag}: round ${round}: a checkpoint (redo ${redo}) passed the COMMIT start ${lsn(start)}; retrying on a fresh invoice`);
      continue;
    }
    const { took, redoStart, redoDone } = await proveThenCrash(c, r, wal, tag);
    console.log(`${tag}: F_mid ${lsn(fMid)} (every record before the COMMIT ends by it: ${wal.others.length} of the transaction, ${wal.subxacts} subxact(s)); `
      + `COMMIT S=${lsn(start)} E=${lsn(end)}; refused (not_durable, wait 0) at flush ${lsn(flushAfterRefusal)} <= S; flushed ${lsn(flushed)}; `
      + `checkpoint redo ${redo}; outcome proof in ${took} ms, then the process crash; redo starts ${lsn(redoStart)}, done ${lsn(redoDone)}; `
      + `xact committed; record v2 applied (payments +1, audits +1)${round > 0 ? ` after ${round} retried round(s)` : ''}`);
    return;
  }
  assert.fail(`${tag}: no round observed a refusal with only the registration's COMMIT unflushed, ahead of the last checkpoint`);
}

test('PDG-13 PROCESS CRASH on both sizes (D-R4-1): refused while ONLY the registration COMMIT was unflushed (negative control), proved once flushed, pg_ctl -m immediate at once; the redo pass covers the COMMIT and the pre-crash proof records exactly one payment (power loss not exercised)', async () => {
  for (const c of [c16, c64]) await crashCase(c, `PDG-13/${c.seg >> 20n}MB`);
});

/**
 * The page-boundary conversion under a process crash, on one cluster: a REAL registration whose COMMIT ends exactly on an
 * ordinary page boundary (no segment variant: the end-of-recovery checkpoint would recycle S's segment), after a checkpoint.
 * No statement forces the flush (the WAL writer, or a process writing out a buffer stamped with the COMMIT's LSN, makes it);
 * read-only polling waits for it. With the insert
 * position at E + 24 and the flush in [E, E + 24), the proof can issue only through L_end = L - 24; proveThenCrash runs. After
 * recovery the first record past the COMMIT must be the end-of-recovery checkpoint at E + 24: nothing else was flushed in
 * front of the proof, so it sampled L = E + 24 (an unflushed record could not have let it issue).
 */
async function boundaryCrashCase(c, tag) {
  appReady(c, tag);
  crashable(c, tag);
  const f = c.fx;
  await registrarAsync(c, tag);
  await keepInSegment(c);
  await c.owner`checkpoint`; // the landing's full-page images follow it; a fresh target absorbs an overshoot
  await onFreshTarget(tag, async () => {
    const invoice = await issueOne(c, f);
    await keepInSegment(c);
    return { invoice, target: nextPageBoundary(c, await insertLsn(c.app.registrar), AHEAD) };
  }, async ({ invoice, target }) => {
    const { id: r } = await land(c, target, target + SHORT, appLander(c, f, invoice));
    let flush = await flushLsn(c.owner);
    for (const t0 = Date.now(); flush < target && Date.now() - t0 < 5000; flush = await flushLsn(c.owner)) await new Promise((res) => setTimeout(res, 20));
    const insert = await insertLsn(c.owner);
    if (insert !== target + SHORT) throw new UnrelatedWal(`insert ${lsn(insert)} before the proof`);
    assert.ok(flush >= target && flush < target + SHORT, `${tag}: flushed to ${lsn(flush)} with no statement forcing it: the COMMIT end ${lsn(target)}, not the raw L ${lsn(target + SHORT)}`);
    const commit = await commitOf(c, r.xid, target - 16384n, target);
    assert.ok(commit !== null && commit.end === target, `${tag}: pg_walinspect: the registration's COMMIT ends exactly at ${lsn(target)}`);
    const [{ redo }] = await c.owner`select redo_lsn as redo from pg_catalog.pg_control_checkpoint()`;
    if (big(redo) >= commit.start) throw new UnrelatedWal(`a checkpoint (redo ${redo}) passed the COMMIT start`);
    const { took, redoStart, redoDone } = await proveThenCrash(c, r, commit, tag);
    const [next] = await c.owner`select start_lsn, record_type as rt from public.pg_get_wal_records_info(${lsn(target)}::pg_lsn, pg_catalog.pg_current_wal_flush_lsn())
                                 order by start_lsn limit 1`;
    if (!(next !== undefined && big(next.start_lsn) === target + SHORT && next.rt === 'CHECKPOINT_SHUTDOWN')) {
      throw new UnrelatedWal(`${next?.rt ?? 'no record'} at ${next?.start_lsn ?? '-'} after the COMMIT: the proof may not have used the conversion`);
    }
    console.log(`${tag}: COMMIT S=${lsn(commit.start)} E=${lsn(target)} on the page boundary; flush at proof ${lsn(flush)} (insert ${lsn(insert)}); `
      + `checkpoint redo ${redo}; outcome proof in ${took} ms through L - 24, then the process crash; redo starts ${lsn(redoStart)}, done ${lsn(redoDone)}; `
      + `next record the end-of-recovery checkpoint at ${next.start_lsn}; xact committed; record v2 applied (payments +1, audits +1)`);
  });
}

test('PDG-14 PROCESS CRASH at the page-boundary conversion on both sizes: the register COMMIT ends on an ordinary page, flushed with no statement forcing it, the proof issues through L - 24, pg_ctl -m immediate at once; the redo pass covers the COMMIT and the pre-crash proof records exactly one payment (power loss not exercised)', async () => {
  for (const c of [c16, c64]) await boundaryCrashCase(c, `PDG-14/${c.seg >> 20n}MB`);
});

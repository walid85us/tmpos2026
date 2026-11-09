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
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';

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
  const c = { owner: mk(), registrar: mk(), issuer: mk() };
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
      await Promise.allSettled([c.owner.end(), c.registrar.end(), c.issuer.end()]);
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

/** Learn the exact sizes of the landing transaction's tail: the pad message M(p) and the commit record C. */
async function calibrate(c) {
  const m = new Map(); const commits = [];
  for (let p = 256; p <= 272; p++) {
    let x, y;
    await c.registrar.begin(async (sql) => {
      await sql`insert into ${sql(S)}.registration (id, registered_xact) values (${randomUUID()}, pg_catalog.pg_current_xact_id())`;
      x = await insertLsn(sql);
      await sql`select pg_catalog.pg_logical_emit_message(true, 'prq1-pad', ${'x'.repeat(p)})`;
      y = await insertLsn(sql);
    });
    const z = await insertLsn(c.registrar);
    m.set(p, bytePos(c, y) - bytePos(c, x));
    commits.push(bytePos(c, z) - bytePos(c, y));
  }
  // The exact-fit pad: the size jumps by 8 right after it, so M(pStar + 8k) = M(pStar) + 8k.
  let pStar = null;
  for (let p = 256; p < 272; p++) if (m.get(p + 1) - m.get(p) === 8n) { pStar = p; break; }
  assert.ok(pStar !== null, 'message size phase found');
  commits.sort((a, b) => Number(a - b));
  c.tail = { pStar, mStar: m.get(pStar), commit: commits[commits.length >> 1] };
}

/**
 * Land a registration whose COMMIT record ENDS exactly at `target` (an end-of-record LSN), with the commit as the last
 * record. Returns the registration id and the registrar's insert position right after the commit.
 */
async function landRegistration(c, target) {
  const want = bytePos(c, target);
  for (let attempt = 0; attempt < 120; attempt++) {
    const distance = want - bytePos(c, await insertLsn(c.registrar));
    const slack = c.tail.mStar + c.tail.commit + 800n;
    if (distance < slack) throw new Error(`target ${lsn(target)} already passed`);
    if (distance > slack + 4096n) {
      const chunk = distance - slack - 2048n;
      await filler(c.registrar, Number(chunk > 8n * 1024n * 1024n ? 8n * 1024n * 1024n : chunk));
      continue;
    }
    const id = randomUUID();
    try {
      await c.registrar.begin(async (sql) => {
        await sql`insert into ${sql(S)}.registration (id, registered_xact) values (${id}, pg_catalog.pg_current_xact_id())`;
        const need = want - bytePos(c, await insertLsn(sql)) - c.tail.commit;
        if (need < c.tail.mStar || (need - c.tail.mStar) % 8n !== 0n) throw new Error('retry');
        await sql`select pg_catalog.pg_logical_emit_message(true, 'prq1-pad', ${'x'.repeat(Number(BigInt(c.tail.pStar) + need - c.tail.mStar))})`;
      });
    } catch (e) {
      if (e.message === 'retry') continue;
      throw e;
    }
    const after = await insertLsn(c.registrar);
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
const nextSegmentStart = (c, from) => ((from + 6000n) / c.seg + 1n) * c.seg;
/** The next 16 MB-aligned position that is NOT a segment start of this cluster (an ordinary page at 64 MB). */
const next16MbOrdinaryPage = (c, from) => {
  let q = ((from + 6000n) / MB16 + 1n) * MB16;
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
  await calibrate(c16);
  await calibrate(c64);
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
async function land(c, target, expectedInsert) {
  const r = await landRegistration(c, target);
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

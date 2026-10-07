'use strict';
// spec: PHUB-S-026
// Bộ chạy NGẪU NHIÊN cho phía GIAO TIN RA (hộp thư đi: webhook, Kafka...), PHUB-D-026. Sink giả lúc tốt lúc hỏng (ném lỗi, hoặc đã nhận rồi mới báo lỗi
// "mất xác nhận"), thời gian trôi, gửi lại thủ công, và (PostgreSQL) khởi động lại giữa chừng. Cuối chuỗi cho sink khỏe lại rồi kiểm:
//  - không mất tin: mỗi sự kiện có đúng một bản giao cho mỗi tuyến khớp (kể cả sự kiện phát lại cùng mã bị bỏ qua), với mã bản giao đúng quy ước;
//  - sống: mọi bản giao cuối cùng là delivered hoặc dead, không còn pending;
//  - ít nhất một lần: bản delivered đã đến sink ít nhất một lần, và KHÔNG được gửi lại sau khi sink đã xác nhận thành công;
//  - thứ tự: với sink có thứ tự, các bản cùng (tuyến, key) đến sink theo thứ tự tạo (bản đã gửi lại thủ công được miễn);
//  - phạm vi: sự kiện của cửa hàng nào chỉ đi tuyến khớp cửa hàng đó và loại sự kiện đó.
const assert = require('node:assert/strict');
const { EventOutbox, eventId } = require('../../src/events');
const { MemoryStore } = require('../../src/store');
const { createClock } = require('./fake-adapter');

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const TYPES = ['payment.paid', 'payment.closed', 'refund.updated', 'anomaly.opened'];
const SHOPS = ['s1', 's2', undefined];

async function runDelivery(seed, { steps = 80, db = null } = {}) {
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const clock = createClock();
  const mode = { ord: 'ok', unord: 'ok' }; // ok | fail | lostAck | flaky
  const received = { ord: [], unord: [] }; // {id, key, seq, outcome}
  const okIds = { ord: new Set(), unord: new Set() };
  const resentAfterOk = [];
  let curStep = -1; // bước hiện tại, để chẩn đoán
  const mkSink = (name, ordered) => ({
    kind: name, ordered, validate() {},
    async deliver(d) {
      const m = mode[name];
      const decide = m === 'flaky' ? pick(['ok', 'fail', 'lostAck']) : m;
      if (okIds[name].has(d.id)) resentAfterOk.push(`${name}:${d.id} bước ${curStep + 1}, status=${d.status}, attempts=${d.attempts}, retried=${retried.has(d.id)}`);
      received[name].push({ id: d.id, key: d.key, seq: d.seq, outcome: decide });
      if (decide === 'fail') throw new Error('sink hỏng');
      if (decide === 'lostAck') throw new Error('mất xác nhận');
      okIds[name].add(d.id);
      return {};
    },
  });
  const sinks = { ord: mkSink('ord', true), unord: mkSink('unord', false) };
  const routes = [
    { id: 'r1', sink: 'ord', types: '*', shops: '*' },
    { id: 'r2', sink: 'unord', types: ['payment.*'], shops: ['s1'] },
  ];
  const cfg = { routes, maxAttempts: 4, backoffSeconds: [1, 2], concurrency: 3 };
  let store = db ? await db.open() : new MemoryStore();
  let outbox = new EventOutbox({ store, clock, sinks, config: cfg });
  const emitted = []; // {type, objectId, version, shop, id}
  const retried = new Set();
  const log = [];
  let versionSeq = 0;
  let restarts = 0;
  let sinceRestart = 0; // chỉ số trong emitted của sự kiện đầu tiên sau lần khởi động lại gần nhất
  const keys = ['pay_1', 'pay_2', 'pay_3'];

  const emit = () => {
    const type = pick(TYPES);
    const objectId = pick(keys);
    // Phát lại cùng mã chỉ bị bỏ qua nếu bản giao còn trong bộ nhớ: sau khởi động lại thì không (giới hạn đã biết, PHUB-D-026), nên chỉ phát lại sự kiện từ sau lần khởi động lại gần nhất.
    const replayable = emitted.slice(sinceRestart);
    const dup = replayable.length && chance(0.1);
    const ref = dup ? pick(replayable) : { type, objectId, version: `v${++versionSeq}`, shop: pick(SHOPS) };
    const w = outbox.emit(ref.type, ref.objectId, ref.version, { paymentId: ref.objectId, x: 1 }, ref.shop);
    log.push(`emit ${ref.type} ${ref.objectId} ${ref.version} shop=${ref.shop}${dup ? ' (phát lại)' : ''}`);
    if (!dup) emitted.push({ ...ref, id: eventId(ref.type, ref.objectId, ref.version) });
    void w;
  };
  function chance(p) { return rand() < p; }

  const listAll = async () => store.listWebhooks({ limit: 1000000 });

  for (let i = 0; i < steps; i += 1) {
    curStep = i;
    const roll = rand();
    try {
      if (roll < 0.35) { for (let k = 0, n = 1 + Math.floor(rand() * 3); k < n; k += 1) emit(); }
      else if (roll < 0.60) { log.push('deliverDue'); await outbox.deliverDue(); }
      else if (roll < 0.75) { const s = pick([1, 2, 5, 30, 200]); log.push(`advance ${s}`); clock.advance(s); }
      else if (roll < 0.85) { const m = pick(['ok', 'fail', 'lostAck', 'flaky']); const which = pick(['ord', 'unord']); log.push(`sink ${which} -> ${m}`); mode[which] = m; }
      else if (roll < 0.92) {
        const dead = (await listAll()).filter((w) => w.status === 'dead');
        if (dead.length) { const w = pick(dead); log.push(`retry ${w.id}`); retried.add(w.id); await outbox.retry(w.id); }
      } else if (db) {
        log.push('RESTART');
        if (store.persist) await store.persist(); await store.close();
        store = await db.open();
        outbox = new EventOutbox({ store, clock, sinks, config: cfg });
        restarts += 1;
        sinceRestart = emitted.length;
      }
    } catch (err) { err.message = `seed=${seed} bước ${i + 1}: ${err.message}\n  ${log.slice(-8).join('\n  ')}`; throw err; }
  }

  // sink khỏe lại; chạy tới khi hết việc
  mode.ord = 'ok'; mode.unord = 'ok';
  if (store.persist) await store.persist();
  for (let round = 0; round < 400; round += 1) {
    const pending = (await listAll()).filter((w) => w.status === 'pending');
    if (!pending.length) break;
    clock.advance(10);
    await outbox.deliverDue();
  }
  if (store.persist) await store.persist();

  try {
    const all = await listAll();
    const byId = new Map(all.map((w) => [w.id, w]));
    // phạm vi và không mất tin
    const expectIds = new Set();
    for (const ev of emitted) {
      const sid = ev.shop || 'default';
      expectIds.add(`${ev.id}~r1`);
      if (ev.type.startsWith('payment.') && sid === 's1') expectIds.add(`${ev.id}~r2`);
    }
    for (const id of expectIds) assert.ok(byId.has(id), `MẤT TIN: không có bản giao ${id}`);
    for (const w of all) assert.ok(expectIds.has(w.id), `bản giao thừa ${w.id} (route ${w.route}, shop ${w.shopId})`);
    assert.equal(all.length, expectIds.size, 'số bản giao');
    // sống
    for (const w of all) assert.ok(['delivered', 'dead'].includes(w.status), `bản giao ${w.id} còn ${w.status}`);
    // ít nhất một lần, không gửi lại sau khi đã xác nhận
    for (const w of all) {
      const sinkName = w.route === 'r1' ? 'ord' : 'unord';
      const got = received[sinkName].filter((r) => r.id === w.id);
      if (w.status === 'delivered') assert.ok(got.some((r) => r.outcome === 'ok' || r.outcome === 'flaky'), `bản ${w.id} delivered mà sink chưa từng nhận thành công`);
    }
    assert.deepEqual(resentAfterOk, [], 'gửi lại sau khi sink đã xác nhận thành công');
    // thứ tự với sink có thứ tự: theo (key) lần nhận THÀNH CÔNG đầu tiên của mỗi bản giao phải tăng theo seq (bản gửi lại thủ công được miễn)
    const firstOk = new Map();
    received.ord.forEach((r, idx) => { if (r.outcome === 'ok' && !firstOk.has(r.id)) firstOk.set(r.id, idx); });
    const perKey = new Map();
    for (const [id, idx] of firstOk) { const w = byId.get(id); if (!w || retried.has(id)) continue; if (!perKey.has(w.key)) perKey.set(w.key, []); perKey.get(w.key).push({ id, idx, seq: w.ord != null ? w.ord : w.seq }); }
    for (const [key, list] of perKey) {
      list.sort((x, y) => x.idx - y.idx);
      for (let k = 1; k < list.length; k += 1) assert.ok(list[k].seq > list[k - 1].seq, `SAI THỨ TỰ key ${key}: ${list[k].id} (seq ${list[k].seq}) đến sau ${list[k - 1].id} (seq ${list[k - 1].seq}) dù tạo trước`);
    }
  } catch (err) { err.message = `seed=${seed}: ${err.message}\n  ${log.slice(-14).join('\n  ')}`; throw err; }
  finally { if (db) { await store.close().catch(() => {}); await db.cleanup(); } }
  return { restarts, events: emitted.length };
}

module.exports = { runDelivery };

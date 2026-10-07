'use strict';
// spec: PHUB-S-026
// Bộ chạy kịch bản NGẪU NHIÊN có kiểm bất biến về tiền (PHUB-D-019, PHUB-D-026), dùng chung cho kho bộ nhớ và PostgreSQL.
// Mỗi seed sinh một chuỗi việc (khách trả, trả hai lần, cổng báo trùng/sai tiền/trễ/chữ ký sai, đối soát, thử lại, failover, hoàn tiền,
// tiền bị đảo, xử lý anomaly, thời gian trôi) rồi sau MỖI bước kiểm các điều không bao giờ được sai.
// Chế độ persistent (PostgreSQL) thêm hai việc: KHỞI ĐỘNG LẠI Hub trên cùng cơ sở dữ liệu và ĐẨY bộ nhớ nóng ra (evict) rồi nạp lại theo yêu cầu,
// nên các bất biến còn kiểm độ trung thực của lưu và nạp: trạng thái cuối không đổi, id không trùng, payment.paid không nhân đôi, tiền vẫn được ghi nhận.
const assert = require('node:assert/strict');
const { PaymentHub, HubError } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('./fake-adapter');

const LIVE = ['CREATED', 'AWAITING', 'UNKNOWN'];

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * @param {number} seed
 * @param {{steps?:number, db?:{open:()=>Promise<object>, cleanup:()=>Promise<void>}}} o db có thì chạy trên PostgreSQL và có khởi động lại, evict
 * @returns {Promise<{restarts:number, evictions:number}>}
 */
async function runSeed(seed, { steps = 90, db = null } = {}) {
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const chance = (p) => rand() < p;
  const clock = createClock();
  const a = createFakeAdapter('a', { caps: { refundAsync: chance(0.5), cancellable: chance(0.5) } });
  const b = createFakeAdapter('b', { caps: { refundable: pick(['api', 'manual']), hardExpiry: pick(['unknown', { minutes: 15 }]) } });
  const adapters = { a, b };
  let n = 0;
  const newRef = (p) => `${p}${++n}`;
  const config = { gateways: [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120], maxAgeSeconds: 3600 }, paymentTtlSeconds: 900, failover: { enabled: true, maxAttempts: 4 } };

  const emitted = []; // mọi sự kiện lõi đã phát, qua mọi lần khởi động lại
  let hub = null;
  const mkHub = async () => {
    const h = new PaymentHub({ adapters, clock, newRef, store: db ? await db.open() : undefined, config });
    const raw = h.events.emit.bind(h.events);
    h.events.emit = (type, id, ...rest) => { emitted.push({ type, id }); return raw(type, id, ...rest); };
    return h;
  };
  hub = await mkHub();

  const log = [];
  const paymentIds = [];
  const known = []; // mọi attempt từng tạo: {id, ref, gateway, amount, paymentId}; không phụ thuộc bộ nhớ của Hub
  const usedIds = new Set();
  const evidence = []; // tiền Hub đã được báo hợp lệ: phải được ghi nhận đâu đó
  const lastPayment = new Map();
  const lastAttempt = new Map();
  const charges = new Map(); // attemptRef -> các khoản thu thật ở cổng
  let txnSeq = 0;
  let restarts = 0;
  let evictions = 0;
  const fresh = () => `T${seed}-${++txnSeq}`;

  const noteAttempt = (at) => {
    assert.ok(!usedIds.has(at.id) || known.some((k) => k.id === at.id), `id attempt trùng ${at.id}`);
    usedIds.add(at.id);
    if (!known.some((k) => k.id === at.id)) known.push({ id: at.id, ref: at.ref, gateway: at.gateway, amount: at.amount, paymentId: at.paymentId });
  };
  const cb = (gw, body, source = 'ipn') => hub.handleCallback(gw, { channel: source === 'return' ? 'return' : 'ipn', method: 'GET', query: {}, body: { ...body, source }, headers: {} });
  const assertHubError = (e) => { if (!(e instanceof HubError)) throw e; };
  const snapshot = async (k) => { await hub.store.hydrateByRef(k.gateway, k.ref); return JSON.stringify([hub.store.getPayment(k.paymentId), hub.store.findAttemptByRef(k.gateway, k.ref)]); };

  async function step() {
    const roll = rand();
    if (db && roll < 0.04) { // khởi động lại Hub trên cùng cơ sở dữ liệu
      log.push('RESTART');
      await hub.store.persist();
      await hub.store.close();
      hub = await mkHub();
      restarts += 1;
      return;
    }
    if (db && roll < 0.08) { // đẩy bộ nhớ nóng ra: các thao tác sau phải nạp lại theo yêu cầu
      log.push('EVICT');
      await hub.store.persist();
      evictions += hub.store.evictIdle(0, Date.now() + 3600e3);
      return;
    }
    const r2 = rand();
    if (r2 < 0.10 || !known.length) {
      const amount = pick([1, 50000, 100000, 100000, 2500000]);
      log.push(`create amount=${amount}`);
      try { const r = await hub.createPayment({ orderId: `O${seed}-${paymentIds.length}`, amount, returnUrl: 'https://shop/r' }); paymentIds.push(r.payment.id); noteAttempt(r.attempt); } catch (e) { assertHubError(e); }
      return;
    }
    const any = pick(known);
    if (r2 < 0.17) {
      const pid = pick(paymentIds);
      log.push(`createAttempt ${pid}`);
      try { const r = await hub.createAttempt(pid, { reason: pick(['customer_retry', 'failover']), cancelLive: chance(0.3) }); noteAttempt(r.attempt); } catch (e) { assertHubError(e); }
      return;
    }
    if (r2 < 0.45) { // khách trả: một khoản thu thật ở cổng, rồi thông báo về (có thể trùng, sai tiền, hỏng chữ ký, hoặc mất)
      const gw = any.gateway;
      const ch = charges.get(any.ref) || [];
      let c;
      if (ch.length && chance(0.7)) c = pick(ch); else { c = { txn: fresh(), amount: chance(0.85) ? any.amount : pick([any.amount - 1, any.amount + 1, Math.floor(any.amount / 2) || 1]) }; ch.push(c); charges.set(any.ref, ch); }
      const type = gw === 'a' ? 'succeeded' : 'received'; // mỗi cổng báo tiền theo một kiểu nhất quán (redirect hoặc chuyển khoản)
      const body = { ref: any.ref, type, amount: c.amount, txn: c.txn };
      for (let k = 0, deliveries = pick([0, 1, 1, 1, 2, 3]); k < deliveries; k += 1) {
        const bad = chance(0.08);
        const source = pick(['ipn', 'ipn', 'ipn', 'return']); // một khoản thu thật được báo qua IPN; kênh truy vấn đi qua đối soát
        const before = bad ? await snapshot(any) : null;
        log.push(`deliver ${type} ${any.ref} ${gw} amount=${c.amount} txn=${c.txn} src=${source}${bad ? ' BADSIG' : ''}`);
        const r = await cb(gw, bad ? { ...body, valid: false } : body, source);
        if (bad) { assert.equal(r.outcome, 'invalid_signature'); assert.equal(await snapshot(any), before, 'chữ ký sai không được đổi gì'); }
        else if (source !== 'return' && !['error', 'retry_later'].includes(r.outcome)) evidence.push({ gw, ref: any.ref, txn: c.txn, amount: c.amount, type, source });
        if (!bad && r.outcome === 'amount_mismatch') { await hub.store.hydrateByRef(gw, any.ref); assert.notEqual(hub.store.findAttemptByRef(gw, any.ref).gatewayTxnId, c.txn, 'sai số tiền không được thành giao dịch ghi nhận'); }
      }
      return;
    }
    if (r2 < 0.58) { // thông báo kết quả không phải tiền vào
      const type = pick(['failed', 'cancelled', 'expired', 'pending']);
      log.push(`deliver ${type} ${any.ref}`);
      await cb(any.gateway, { ref: any.ref, type, amount: any.amount, txn: fresh() }, pick(['ipn', 'query']));
      return;
    }
    if (r2 < 0.63) { // tiền bị cổng đảo lại
      const ch = charges.get(any.ref);
      if (!ch || !ch.length) return;
      const c = pick(ch);
      const part = chance(0.5) ? c.amount : Math.max(1, Math.floor(c.amount / 2));
      log.push(`deliver reversed ${any.ref} ${part}`);
      await cb(any.gateway, { ref: any.ref, type: 'reversed', amount: part, txn: `rev-${c.txn}` }, 'ipn');
      return;
    }
    if (r2 < 0.70) { // tiền không rõ chủ
      log.push('deliver unmatched');
      const txn = fresh();
      const r = await cb(pick(['a', 'b']), { unmatched: true, amount: pick([1000, 50000]), txn, content: 'x' }, 'ipn');
      if (r.outcome === 'ok') evidence.push({ gw: null, txn, unmatched: true });
      return;
    }
    if (r2 < 0.80) { // đối soát: đặt kết quả hỏi cổng rồi cho thời gian trôi
      for (const x of hub.store.liveAttempts()) {
        if (!chance(0.6)) continue;
        const ch = charges.get(x.ref);
        const c = ch && ch.length ? ch[ch.length - 1] : null;
        if (c && chance(0.7)) adapters[x.gateway].queryResults.set(x.ref, { gateway: x.gateway, attemptRef: x.ref, type: 'succeeded', amount: c.amount, gatewayTxnId: c.txn, occurredAt: 1, source: 'query' });
        else if (chance(0.5)) adapters[x.gateway].queryResults.set(x.ref, { gateway: x.gateway, attemptRef: x.ref, type: pick(['pending', 'failed', 'expired']), amount: x.amount, occurredAt: 1, source: 'query' });
      }
      const sec = pick([30, 61, 130, 400, 1000]);
      log.push(`advance ${sec} + reconcile`);
      clock.advance(sec);
      await hub.reconcile();
      return;
    }
    if (r2 < 0.92) { // hoàn tiền
      for (const g of [a, b]) { g.refundStatus = pick(['processing', 'succeeded', 'failed']); g.queryRefundStatus = pick(['processing', 'succeeded', 'failed']); }
      const amount = chance(0.4) ? undefined : pick([1, 1000, Math.floor(any.amount / 2) || 1, any.amount, any.amount + 1]);
      log.push(`refund ${any.id} amount=${amount}`);
      try {
        await hub.refund({ attemptId: any.id, amount });
        const at = hub.store.getAttempt(any.id);
        const sum = hub.store.refundsOfAttempt(any.id).filter((x) => x.status !== 'FAILED').reduce((s, x) => s + x.amount, 0);
        const held = hub.store.anomaliesOfAttempt(any.id).filter((x) => ['late_success', 'duplicate_charge'].includes(x.type));
        const bound = (at.status === 'SUCCEEDED' ? (at.receivedTotal || at.amount) : Math.max(0, ...held.map((x) => x.amount))) - (at.reversedTotal || 0);
        assert.ok(sum <= bound, `hoàn ${sum} vượt số đã thu còn lại ${bound}`);
      } catch (e) { assertHubError(e); }
      return;
    }
    // xử lý anomaly
    const open = await hub.findAnomalies({ status: 'open' });
    if (!open.length) { clock.advance(10); return; }
    const an = pick(open);
    const action = an.type === 'funds_reversed' ? 'ignore' : pick(['ignore', 'refund', 'apply']);
    log.push(`resolve ${an.type} ${action}`);
    try { await hub.resolveAnomaly(an.id, { action, note: 'n', force: chance(0.3) }); } catch (e) { assertHubError(e); }
  }

  function checkInvariants() {
    for (const p of hub.store.payments.values()) {
      const prev = lastPayment.get(p.id);
      if (prev && prev !== 'OPEN') assert.equal(p.status, prev, `payment ${p.id} đổi ${prev} -> ${p.status}`);
      lastPayment.set(p.id, p.status);
      if (p.status === 'PAID') {
        const pa = hub.store.getAttempt(p.paidByAttempt);
        assert.ok(pa, 'PAID phải có attempt nhận tiền');
        assert.ok(pa.status === 'SUCCEEDED' || hub.store.anomalies.some((x) => x.status === 'applied' && x.attemptId === pa.id), `payment ${p.id} PAID bởi attempt ${pa.status} mà không có anomaly applied`);
      }
      const k = emitted.filter((e) => e.type === 'payment.paid' && e.id === p.id).length;
      assert.equal(k, p.status === 'PAID' ? 1 : 0, `payment ${p.id} (${p.status}) có ${k} sự kiện payment.paid`);
    }
    for (const x of hub.store.attempts.values()) {
      const prev = lastAttempt.get(x.id);
      if (prev && !LIVE.includes(prev)) assert.equal(x.status, prev, `attempt ${x.id} đổi ${prev} -> ${x.status}`);
      lastAttempt.set(x.id, x.status);
    }
  }

  // Cuối chuỗi: mọi payment đã thấy còn nguyên trạng thái cuối khi nạp lại từ kho, và mọi khoản tiền được báo đều được ghi nhận đâu đó.
  async function finalChecks() {
    for (const pid of paymentIds) {
      await hub.store.hydratePayment(pid);
      const p = hub.store.getPayment(pid);
      assert.ok(p, `payment ${pid} biến mất`);
      const prev = lastPayment.get(pid);
      if (prev && prev !== 'OPEN') assert.equal(p.status, prev, `payment ${pid} nạp lại là ${p.status}, đã thấy ${prev}`);
      assert.equal(emitted.filter((e) => e.type === 'payment.paid' && e.id === pid).length, p.status === 'PAID' ? 1 : 0, `payment.paid của ${pid} (${p.status})`);
    }
    const anomalies = await hub.findAnomalies({ limit: 1000000 });
    for (const e of evidence) {
      if (e.unmatched) { assert.ok(anomalies.some((x) => x.type === 'unmatched_funds' && x.gatewayTxnId === e.txn), `tiền chưa rõ chủ ${e.txn} biến mất`); continue; }
      await hub.store.hydrateByRef(e.gw, e.ref);
      const at = hub.store.findAttemptByRef(e.gw, e.ref);
      assert.ok(at, `attempt ${e.ref} biến mất`);
      const ok = at.gatewayTxnId === e.txn || (at.receipts || []).some((r) => r.txn === e.txn) || anomalies.some((x) => x.gatewayTxnId === e.txn && (x.attemptId === at.id || x.attemptRef === e.ref));
      // Giới hạn đã biết (PHUB-D-019): attempt đã SUCCEEDED qua kênh khác thì mã giao dịch khác không đủ để kết luận đó là khoản thu thêm.
      const crossChannel = e.type === 'succeeded' && at.status === 'SUCCEEDED' && at.txnBySource && !(e.source in at.txnBySource);
      if (!ok && crossChannel) continue;
      assert.ok(ok, `KHOẢN TIỀN KHÔNG ĐƯỢC GHI NHẬN: ${e.type} ${e.txn} ${e.amount} VND trên ${e.ref} (attempt ${at.status}, giao dịch ghi nhận=${at.gatewayTxnId})`);
    }
  }

  try {
    for (let i = 0; i < steps; i += 1) {
      try { await step(); checkInvariants(); } catch (err) { err.message = `seed=${seed} bước ${i + 1}: ${err.message}\n  ${log.slice(-8).join('\n  ')}`; throw err; }
    }
    try { await finalChecks(); } catch (err) { err.message = `seed=${seed}: ${err.message}\n  ${log.slice(-12).join('\n  ')}`; throw err; }
  } finally {
    if (db) { await hub.store.close().catch(() => {}); await db.cleanup(); }
  }
  return { restarts, evictions };
}

module.exports = { runSeed };

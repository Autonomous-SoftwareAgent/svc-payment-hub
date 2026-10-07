'use strict';
// spec: PHUB-S-028
// Bộ chạy NGẪU NHIÊN với SIMULATOR THẬT của các cổng chuyển hướng (VNPay, MoMo, OnePAY) và adapter thật (PHUB-D-028). Khác bộ dùng adapter giả ở chỗ
// simulator là "sự thật nền": nó biết cổng đã thu tiền của giao dịch nào. Nên có hai bất biến mạnh:
//   - TIỀN KHÔNG VÔ HÌNH: mọi giao dịch simulator đã thu tiền, sau khi mọi điều khiển lỗi được tắt và đối soát đủ lâu, phải được Hub ghi nhận
//     (attempt SUCCEEDED, hoặc anomaly trên attempt đó, hoặc attempt được gắn cờ người vận hành);
//   - KHÔNG BÁO THU KHỐNG: attempt Hub ghi SUCCEEDED thì simulator phải đã thu thật.
// Việc sinh ngẫu nhiên: khách trả thành công, thất bại, hủy (kể cả trên attempt Hub đã đóng), IPN mất/trùng/sai số tiền, thời gian trôi và đối soát,
// thử lại, failover, hoàn tiền; chế độ PostgreSQL thêm khởi động lại Hub giữa chừng.
const assert = require('node:assert/strict');
const { HubError } = require('../../src/hub');
const { createWorld, order } = require('./world');

const LIVE = ['CREATED', 'AWAITING', 'UNKNOWN'];
const CLOSE_RECHECK_LAST = 86400; // mốc hỏi lại cuối (giây kể từ lúc đóng): tiền về sau mốc này mà IPN mất là giới hạn đã biết (PHUB-D-027)

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Sự thật nền của từng simulator: danh sách {ref, amount (VND)} mà cổng đã thu tiền.
async function paidAtGateway(id, driver) {
  const j = await (await fetch(`${driver.sim.url}/sim/transactions`)).json();
  const list = j.transactions || [];
  if (id === 'momo') return list.filter((t) => t.status === 'success').map((t) => ({ ref: t.orderId, amount: t.amount }));
  if (id === 'vnpay') return list.filter((t) => t.status === 'paid').map((t) => ({ ref: t.txnRef, amount: t.amount }));
  if (id === 'onepay') return list.filter((t) => t.status === 'paid').map((t) => ({ ref: t.merchTxnRef, amount: t.amount / 100 }));
  throw new Error(`chưa có sự thật nền cho ${id}`);
}

/**
 * @param {number} seed
 * @param {{gateways:string[], steps?:number, db?:object}} o
 * @returns {Promise<{restarts:number, paidAtGateway:number}>}
 */
async function runSimSeed(seed, { gateways, steps = 50, db = null }) {
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const chance = (p) => rand() < p;
  const w = await createWorld(gateways, { reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 300, 1800], maxAgeSeconds: 86400 }, failover: { enabled: true, maxAttempts: 4 } }, db ? { db } : {});
  const log = [];
  const emitted = [];
  const wrap = () => { const raw = w.hub.events.emit.bind(w.hub.events); w.hub.events.emit = (type, id, ...rest) => { emitted.push({ type, id }); return raw(type, id, ...rest); }; };
  wrap();
  const paymentIds = [];
  const known = []; // {id, ref, gateway, amount, paymentId}
  const lastPaySuccessAt = new Map(); // ref -> thời điểm (đồng hồ Hub) lần cuối ta bảo simulator "khách trả thành công"
  const lastPayment = new Map();
  const lastAttempt = new Map();
  let restarts = 0;
  let orderSeq = 0;

  const noteAttempt = (at) => { if (!known.some((k) => k.id === at.id)) known.push({ id: at.id, ref: at.ref, gateway: at.gateway, amount: at.amount, paymentId: at.paymentId }); };
  const assertHubError = (e) => { if (!(e instanceof HubError)) throw e; };
  const driverOf = (k) => w.drivers[k.gateway];

  async function step() {
    const roll = rand();
    if (db && roll < 0.04) { log.push('RESTART'); await w.hub.store.persist(); await w.restart(); wrap(); restarts += 1; return; }
    if (roll < 0.14 || !known.length) {
      const amount = pick([50000, 100000, 150000]);
      log.push(`create ${amount}`);
      try {
        const r = await w.hub.createPayment(order({ orderId: `S${seed}-${++orderSeq}`, amount }));
        paymentIds.push(r.payment.id); noteAttempt(r.attempt);
        if (chance(0.8)) await driverOf(r.attempt).land(r.attempt);
      } catch (e) { assertHubError(e); }
      return;
    }
    const k = pick(known);
    if (roll < 0.22) {
      const pid = pick(paymentIds);
      log.push(`createAttempt ${pid}`);
      try { const r = await w.hub.createAttempt(pid, { reason: pick(['customer_retry', 'failover']) }); noteAttempt(r.attempt); if (chance(0.8)) await driverOf(r.attempt).land(r.attempt); } catch (e) { assertHubError(e); }
      return;
    }
    if (roll < 0.50) { // khách trả (kể cả trên attempt Hub đã đóng)
      const outcome = pick(['success', 'success', 'success', 'failed', 'cancel']);
      log.push(`pay ${k.ref} ${k.gateway} ${outcome}`);
      if (outcome === 'success') lastPaySuccessAt.set(k.ref, w.clock.now());
      try { await driverOf(k).pay({ ref: k.ref, amount: k.amount }, outcome); } catch { /* simulator có thể từ chối (hóa đơn đóng): không phải lỗi của Hub */ }
      return;
    }
    if (roll < 0.62) { // điều khiển lỗi toàn cục của simulator
      const g = pick(gateways);
      const ctl = pick([{ ipn_drop: true }, { ipn_drop: false }, { ipn_duplicate: true }, { ipn_duplicate: false }, { ipn_wrong_amount: true }, { ipn_wrong_amount: false }]);
      log.push(`control ${g} ${JSON.stringify(ctl)}`);
      await w.drivers[g].control(ctl);
      return;
    }
    if (roll < 0.82) {
      const sec = pick([30, 120, 700, 2000, 5000, 20000]);
      log.push(`advance ${sec} + reconcile`);
      await w.advance(sec);
      await w.hub.reconcile();
      return;
    }
    if (roll < 0.92) {
      log.push(`refund ${k.id}`);
      try {
        await w.hub.refund({ attemptId: k.id });
        const at = w.hub.store.getAttempt(k.id);
        const sum = w.hub.store.refundsOfAttempt(k.id).filter((x) => x.status !== 'FAILED').reduce((s, x) => s + x.amount, 0);
        assert.ok(sum <= (at.receivedTotal || at.amount) - (at.reversedTotal || 0) || at.status !== 'SUCCEEDED', `hoàn ${sum} vượt số đã thu`);
      } catch (e) { assertHubError(e); }
      return;
    }
    const open = await w.hub.findAnomalies({ status: 'open' });
    if (!open.length) { await w.advance(10); return; }
    const an = pick(open);
    log.push(`resolve ${an.type} ignore`);
    try { await w.hub.resolveAnomaly(an.id, { action: 'ignore', note: 'n' }); } catch (e) { assertHubError(e); }
  }

  function checkInvariants() {
    for (const p of w.hub.store.payments.values()) {
      const prev = lastPayment.get(p.id);
      if (prev && prev !== 'OPEN') assert.equal(p.status, prev, `payment ${p.id} đổi ${prev} -> ${p.status}`);
      lastPayment.set(p.id, p.status);
      const n = emitted.filter((e) => e.type === 'payment.paid' && e.id === p.id).length;
      assert.equal(n, p.status === 'PAID' ? 1 : 0, `payment ${p.id} (${p.status}) có ${n} sự kiện payment.paid`);
    }
    for (const a of w.hub.store.attempts.values()) {
      const prev = lastAttempt.get(a.id);
      if (prev && !LIVE.includes(prev)) assert.equal(a.status, prev, `attempt ${a.id} đổi ${prev} -> ${a.status}`);
      lastAttempt.set(a.id, a.status);
    }
  }

  const result = { restarts: 0, paidAtGateway: 0 };
  try {
    for (let i = 0; i < steps; i += 1) {
      try { await step(); checkInvariants(); } catch (err) { err.message = `seed=${seed} (${gateways.join('+')}) bước ${i + 1}: ${err.message}\n  ${log.slice(-8).join('\n  ')}`; throw err; }
    }
    // Tắt mọi lỗi, rồi cho thời gian trôi qua các mốc đối soát và hỏi lại (24 giờ) để Hub có cơ hội biết hết.
    for (const g of gateways) await w.drivers[g].control({ ipn_drop: false, ipn_duplicate: false, ipn_wrong_amount: false });
    for (const sec of [3000, 3000, 3000, 90000, 3000, 90000]) { await w.advance(sec); await w.hub.reconcile(); }
    const truth = new Map();
    for (const g of gateways) for (const t of await paidAtGateway(g, w.drivers[g])) truth.set(`${g}|${t.ref}`, t);
    result.paidAtGateway = truth.size;
    const anomalies = await w.hub.findAnomalies({ limit: 1000000 });
    // 1. tiền không vô hình
    for (const [key, t] of truth) {
      const [g, ref] = key.split('|');
      await w.hub.store.hydrateByRef(g, ref);
      const at = w.hub.store.findAttemptByRef(g, ref);
      if (!at) continue; // simulator có giao dịch mà Hub chưa tạo: không xảy ra vì ref do Hub sinh
      const recorded = at.status === 'SUCCEEDED' || anomalies.some((x) => x.attemptId === at.id) || at.needsOperator;
      // Giới hạn đã biết (PHUB-D-027): attempt đã đóng, khách trả sau mốc hỏi lại cuối và IPN mất.
      const lateBeyond = !LIVE.includes(at.status) && at.status !== 'SUCCEEDED' && at.finalizedAt != null && (lastPaySuccessAt.get(ref) || 0) > at.finalizedAt + CLOSE_RECHECK_LAST * 1000;
      if (!recorded && !lateBeyond) assert.fail(`TIỀN VÔ HÌNH: ${g} đã thu ${t.amount} VND của ${ref} (attempt ${at.status}) mà Hub không có SUCCEEDED, anomaly hay cờ người vận hành`);
    }
    // 2. không báo thu khống
    for (const k of known) {
      await w.hub.store.hydrateAttempt(k.id);
      const at = w.hub.store.getAttempt(k.id);
      if (at && at.status === 'SUCCEEDED') assert.ok(truth.has(`${k.gateway}|${k.ref}`), `BÁO THU KHỐNG: Hub ghi ${k.ref} SUCCEEDED nhưng ${k.gateway} chưa thu`);
    }
    // 3. payment PAID thì attempt trả tiền phải là SUCCEEDED
    for (const pid of paymentIds) {
      await w.hub.store.hydratePayment(pid);
      const p = w.hub.store.getPayment(pid);
      if (p && p.status === 'PAID') assert.ok(w.hub.store.getAttempt(p.paidByAttempt), `payment ${pid} PAID mà không có attempt trả tiền`);
    }
    result.restarts = restarts;
  } catch (err) {
    if (!/seed=/.test(err.message)) err.message = `seed=${seed} (${gateways.join('+')}): ${err.message}\n  ${log.slice(-10).join('\n  ')}`;
    throw err;
  } finally { await w.close(); if (db) await db.cleanup(); }
  return result;
}

module.exports = { runSimSeed };

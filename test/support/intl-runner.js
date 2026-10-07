'use strict';
// spec: PHUB-S-028
// spec: STRP-S-003
// spec: PYPL-S-003
// Bộ chạy NGẪU NHIÊN với simulator thật và adapter thật của các cổng quốc tế (Stripe, PayPal; P-011 nhóm 3). Giống sim-runner.js nhưng mỗi cổng có điều khiển riêng
// (webhook trùng, đảo thứ tự, mất, giữ lại rồi giao; thẻ hỏng; giữ tiền rồi thu/nhả; PayPal: capture PENDING, hoàn bất đồng bộ, chữ ký sai). Simulator là sự thật nền:
//   - TIỀN KHÔNG VÔ HÌNH: tiền simulator đã thu (hoặc đang giữ) thì sau khi tắt lỗi và đối soát đủ lâu, Hub phải có SUCCEEDED/AUTHORIZED,
//     hoặc anomaly trên attempt đó, hoặc cờ người vận hành;
//   - KHÔNG BÁO THU KHỐNG: attempt Hub ghi SUCCEEDED thì simulator phải đã thu thật.
// Riêng PayPal: khách duyệt mà return lẫn webhook đều mất thì KHÔNG ai thu (thất bại an toàn), nên không có tiền để mất.
// CHỈ chạy với simulator: chưa kiểm cổng thật.
const assert = require('node:assert/strict');
const { HubError } = require('../../src/hub');
const { createWorld, order } = require('./world');

const LIVE = ['CREATED', 'AWAITING', 'UNKNOWN', 'AUTHORIZED'];

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const STRIPE_DROP = ['payment_intent.succeeded', 'charge.succeeded', 'checkout.session.completed', 'payment_intent.amount_capturable_updated'];
const PAYPAL_DROP = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.AUTHORIZATION.CREATED'];

// Từng cổng: cách trả, bộ điều khiển lỗi, và sự thật nền từ /sim/state.
const GATEWAYS = {
  stripe: {
    outcomes: ['success', 'success', 'success', 'decline', 'cancel'],
    hasState: (at) => !!(at && at.state && at.state.cs),
    controls: () => [
      { dup_webhooks: 2 }, { dup_webhooks: 0 }, { reverse_events: true }, { reverse_events: false },
      { drop_types: STRIPE_DROP }, { drop_types: [] }, { hold_webhooks: true }, { hold_webhooks: false },
    ],
    // [{ref, kind:'paid'|'held'}]
    truth: (s) => {
      const sessionOf = new Map(s.sessions.map((x) => [x.id, x]));
      return s.intents.filter((p) => ['succeeded', 'requires_capture'].includes(p.status)).map((p) => ({ ref: (sessionOf.get(p.session) || {}).client_reference_id, kind: p.status === 'succeeded' ? 'paid' : 'held' }));
    },
    paidRefs: (s) => {
      const sessionOf = new Map(s.sessions.map((x) => [x.id, x]));
      return new Set(s.intents.filter((p) => p.status === 'succeeded').map((p) => (sessionOf.get(p.session) || {}).client_reference_id));
    },
    finish: async (d) => { await d.control({ dup_webhooks: 0, reverse_events: false, drop_types: [], hold_webhooks: false }); await d.post('/sim/webhook/flush', {}); },
  },
  paypal: {
    outcomes: ['success', 'success', 'approve_only', 'decline', 'cancel'],
    hasState: (at) => !!(at && at.state && at.state.order),
    controls: () => [
      { dup_webhooks: 2 }, { dup_webhooks: 0 }, { reverse_events: true }, { reverse_events: false },
      { drop_types: PAYPAL_DROP }, { drop_types: [] }, { hold_webhooks: true }, { hold_webhooks: false },
      { bad_signature: true }, { bad_signature: false }, { capture_pending: true }, { capture_pending: false }, { refund_mode: 'async' }, { refund_mode: 'sync' },
    ],
    truth: (s) => {
      const refOf = new Map(s.orders.map((o) => [o.id, o.custom_id]));
      const caps = s.captures.filter((c) => ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(c.status)).map((c) => ({ ref: refOf.get(c.order), kind: 'paid' }));
      const held = s.auths.filter((a) => a.status === 'CREATED').map((a) => ({ ref: refOf.get(a.order), kind: 'held' }));
      return [...caps, ...held];
    },
    paidRefs: (s) => {
      const refOf = new Map(s.orders.map((o) => [o.id, o.custom_id]));
      return new Set(s.captures.filter((c) => ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(c.status)).map((c) => refOf.get(c.order)));
    },
    // tắt lỗi, hoàn tất mọi capture và hoàn tiền đang chờ, giao nốt webhook
    finish: async (d) => {
      await d.control({ dup_webhooks: 0, reverse_events: false, drop_types: [], hold_webhooks: false, bad_signature: false, capture_pending: false, refund_mode: 'sync' });
      const s = await (await fetch(`${d.sim.url}/sim/state`)).json();
      for (const c of s.captures.filter((x) => x.status === 'PENDING')) await d.post('/sim/capture/resolve', { id: c.id, outcome: 'completed' });
      for (const r of s.refunds.filter((x) => x.status === 'PENDING')) await d.post('/sim/refund/resolve', { id: r.id, outcome: 'completed' });
      await d.post('/sim/webhook/flush', {});
    },
  },
};

/**
 * @param {'stripe'|'paypal'} gateway
 * @param {number} seed
 * @param {{steps?:number, product?:string}} o product 'auth' = giữ tiền rồi thu sau
 * @returns {Promise<{paidAtGateway:number}>}
 */
async function runIntlSeed(gateway, seed, { steps = 40, product } = {}) {
  const G = GATEWAYS[gateway];
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const chance = (p) => rand() < p;
  const w = await createWorld([gateway], { failover: { enabled: true, maxAttempts: 4 } }, { [gateway]: product ? { adapter: { product } } : {} });
  const d = w.drivers[gateway];
  const log = [];
  const emitted = [];
  const raw = w.hub.events.emit.bind(w.hub.events);
  w.hub.events.emit = (type, id, ...rest) => { emitted.push({ type, id }); return raw(type, id, ...rest); };
  const paymentIds = [];
  const known = []; // {id, ref, amount, paymentId}
  const lastAttempt = new Map();
  let orderSeq = 0;
  const noteAttempt = (at) => { if (!known.some((k) => k.id === at.id)) known.push({ id: at.id, ref: at.ref, amount: at.amount, paymentId: at.paymentId }); };
  const assertHubError = (e) => { if (!(e instanceof HubError)) throw e; };

  async function step() {
    const roll = rand();
    if (roll < 0.14 || !known.length) {
      const amount = pick([1999, 2500, 5000]);
      log.push(`create ${amount}`);
      try {
        const r = await w.hub.createPayment(order({ orderId: `X${seed}-${++orderSeq}`, amount, currency: 'USD' }));
        paymentIds.push(r.payment.id); noteAttempt(r.attempt);
      } catch (e) { assertHubError(e); }
      return;
    }
    const k = pick(known);
    if (roll < 0.22) {
      const pid = pick(paymentIds);
      log.push(`createAttempt ${pid}`);
      try { const r = await w.hub.createAttempt(pid, { reason: pick(['customer_retry', 'failover']) }); noteAttempt(r.attempt); } catch (e) { assertHubError(e); }
      return;
    }
    if (roll < 0.50) { // khách trả (kể cả trên attempt Hub đã đóng)
      const outcome = pick(G.outcomes);
      const at = w.hub.store.getAttempt(k.id);
      log.push(`pay ${k.ref} ${outcome}`);
      if (G.hasState(at)) { try { await d.pay(at, outcome); } catch { /* simulator có thể từ chối (phiên đóng) */ } }
      return;
    }
    if (roll < 0.64) { // điều khiển lỗi của simulator
      const ctl = pick(G.controls());
      log.push(`control ${JSON.stringify(ctl)}`);
      await d.control(ctl);
      if (ctl.hold_webhooks === false) await d.post('/sim/webhook/flush', { reverse: chance(0.5) });
      return;
    }
    if (roll < 0.84) {
      const sec = pick([30, 120, 700, 2000, 5000, 20000]);
      log.push(`advance ${sec} + reconcile`);
      await w.advance(sec);
      await w.hub.reconcile();
      return;
    }
    if (roll < 0.92) {
      log.push(`refund-or-capture ${k.id}`);
      try {
        const at = w.hub.store.getAttempt(k.id);
        if (at.status === 'AUTHORIZED') await w.hub.capturePayment({ paymentId: k.paymentId }); else await w.hub.refund({ attemptId: k.id });
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
      const n = emitted.filter((e) => e.type === 'payment.paid' && e.id === p.id).length;
      assert.equal(n, p.status === 'PAID' ? 1 : 0, `payment ${p.id} (${p.status}) có ${n} sự kiện payment.paid`);
    }
    for (const a of w.hub.store.attempts.values()) {
      const prev = lastAttempt.get(a.id);
      if (prev && !LIVE.includes(prev)) assert.equal(a.status, prev, `attempt ${a.id} đổi ${prev} -> ${a.status}`);
      lastAttempt.set(a.id, a.status);
    }
  }

  const result = { paidAtGateway: 0 };
  try {
    for (let i = 0; i < steps; i += 1) {
      try { await step(); checkInvariants(); } catch (err) { err.message = `seed=${seed} (${gateway}${product ? ':' + product : ''}) bước ${i + 1}: ${err.message}\n  ${log.slice(-8).join('\n  ')}`; throw err; }
    }
    // Tắt mọi lỗi, giao nốt webhook giữ lại, rồi cho thời gian trôi qua các mốc đối soát.
    await G.finish(d);
    for (const sec of [3000, 3000, 3000, 90000, 3000, 90000]) { await w.advance(sec); await w.hub.reconcile(); }
    const state = await (await fetch(`${d.sim.url}/sim/state`)).json();
    const anomalies = await w.hub.findAnomalies({ limit: 1000000 });
    const truth = G.truth(state);
    result.paidAtGateway = truth.length;
    if (process.env.INTL_DEBUG) { // chẩn đoán: mỗi khoản tiền ở cổng ứng với attempt và anomaly nào của Hub
      for (const t of truth) {
        const at = w.hub.store.findAttemptByRef(gateway, t.ref);
        console.log(`  [${gateway} seed ${seed}] ${t.kind} ${t.ref}: attempt=${at && at.status} needsOperator=${!!(at && at.needsOperator)} anomalies=${anomalies.filter((x) => at && x.attemptId === at.id).map((x) => x.type).join(',') || '-'}`);
      }
    }
    // 1. tiền không vô hình
    for (const t of truth) {
      await w.hub.store.hydrateByRef(gateway, t.ref);
      const at = w.hub.store.findAttemptByRef(gateway, t.ref);
      if (!at) continue;
      // Chặt hơn sim-runner: cờ needsOperator đơn lẻ (lưới an toàn khi attempt kẹt quá maxAge) KHÔNG đủ; Hub phải thật sự biết tiền (trạng thái hoặc anomaly gắn attempt).
      const recorded = ['SUCCEEDED', 'AUTHORIZED'].includes(at.status) || anomalies.some((x) => x.attemptId === at.id);
      if (!recorded) assert.fail(`TIỀN VÔ HÌNH: ${gateway} đã ${t.kind === 'paid' ? 'thu' : 'giữ'} tiền của ${t.ref} (attempt ${at.status}, needsOperator=${!!at.needsOperator}) mà Hub không có SUCCEEDED/AUTHORIZED hay anomaly gắn attempt`);
    }
    // 2. không báo thu khống
    const paid = G.paidRefs(state);
    for (const k of known) {
      await w.hub.store.hydrateAttempt(k.id);
      const at = w.hub.store.getAttempt(k.id);
      if (at && at.status === 'SUCCEEDED') assert.ok(paid.has(k.ref), `BÁO THU KHỐNG: Hub ghi ${k.ref} SUCCEEDED nhưng ${gateway} chưa thu`);
    }
  } catch (err) {
    if (!/seed=/.test(err.message)) err.message = `seed=${seed} (${gateway}): ${err.message}\n  ${log.slice(-10).join('\n  ')}`;
    throw err;
  } finally { await w.close(); }
  return result;
}

module.exports = { runIntlSeed };

'use strict';
// spec: PHUB-S-009
// Đo tải lõi Hub + PostgreSQL thật với adapter giả (không tính độ trễ cổng thật).
// Chạy: HUB_TEST_DATABASE_URL=postgres://... node tools/bench/load.js [tổng số payment] [song song]
// Mục đích: biết thông lượng và độ trễ khi số giao dịch lưu trong Hub tăng dần (nút thắt nằm ở đâu).
const crypto = require('node:crypto');
const { PaymentHub } = require('../../src/hub');
const { PostgresStore } = require('../../src/store-postgres');
const { createFakeAdapter } = require('../../test/support/fake-adapter');

const URL = process.env.HUB_TEST_DATABASE_URL;
if (!URL) { console.error('đặt HUB_TEST_DATABASE_URL'); process.exit(1); }
const TOTAL = Number(process.argv[2] || 5000);
const CONC = Number(process.argv[3] || 20);

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

async function main() {
  const schema = `bench_${crypto.randomBytes(4).toString('hex')}`;
  const store = await PostgresStore.open(URL, { schema });
  const a = createFakeAdapter('gw1');
  const hub = new PaymentHub({ adapters: { gw1: a }, store, config: { gateways: [{ id: 'gw1', priority: 1 }] } });
  const steps = [];
  // BENCH_EVICT=1: đẩy giao dịch đã đóng ra khỏi bộ nhớ như bộ lập lịch của Hub (nhàn rỗi quá 1 giây)
  const evictTimer = process.env.BENCH_EVICT ? setInterval(() => store.evictIdle(1000), 500) : null;
  let done = 0;
  const errors = {};
  const lat = { create: [], cb: [] };
  const t0 = Date.now();
  let next = 0;
  let lastT = t0; let lastN = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= TOTAL) return;
      const s1 = process.hrtime.bigint();
      let r;
      try { r = await hub.createPayment({ orderId: `O${i}`, amount: 10000 + (i % 50), returnUrl: 'https://shop.test/r' }); } catch (e) { errors[e.code || e.message] = (errors[e.code || e.message] || 0) + 1; done += 1; continue; }
      lat.create.push(Number(process.hrtime.bigint() - s1) / 1e6);
      const s2 = process.hrtime.bigint();
      await hub.handleCallback('gw1', { channel: 'ipn', body: { ref: r.attempt.ref, type: 'succeeded', amount: 10000 + (i % 50), txn: `T${i}` } });
      lat.cb.push(Number(process.hrtime.bigint() - s2) / 1e6);
      done += 1;
      if (done % Math.max(1, Math.floor(TOTAL / 5)) === 0) {
        const now = Date.now();
        steps.push({ payments: done, opsPerSec: Math.round(((done - lastN) * 2) / ((now - lastT) / 1000)) });
        lastT = now; lastN = done;
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const secs = (Date.now() - t0) / 1000;
  const r0 = Date.now();
  await hub.reconcile();
  const reconMs = Date.now() - r0;
  console.log(JSON.stringify({
    total: TOTAL, concurrency: CONC, seconds: +secs.toFixed(1), paymentsPerSec: +(TOTAL / secs).toFixed(1),
    createMs: { p50: +pct(lat.create, 0.5).toFixed(1), p99: +pct(lat.create, 0.99).toFixed(1) },
    callbackMs: { p50: +pct(lat.cb, 0.5).toFixed(1), p99: +pct(lat.cb, 0.99).toFixed(1) },
    reconcileMsWhenAllFinished: reconMs,
    throughputByPhase: steps,
    errors,
    inMemoryPayments: store.payments.size,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    heapMBAfterGc: global.gc ? (global.gc(), Math.round(process.memoryUsage().heapUsed / 1048576)) : 'chạy với --expose-gc để đo',
  }, null, 1));
  if (evictTimer) clearInterval(evictTimer);
  await store.close();
  await PostgresStore.dropSchema(URL, schema);
}
main().catch((e) => { console.error(e); process.exit(1); });

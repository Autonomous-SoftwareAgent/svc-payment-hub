'use strict';
// spec: PHUB-S-016
// Đo tải qua HTTP thật (PHUB-D-016): server HTTP của Hub + PostgreSQL thật + adapter giả không trễ; máy khách dùng kết nối giữ sống
// và đo độ trễ từ phía khách (gồm HTTP, phân tích JSON). Mỗi payment = POST /payments rồi POST /ipn/{cổng}.
// Chạy: HUB_TEST_DATABASE_URL=postgres://... node --expose-gc tools/bench/http-load.js [tổng số payment] [song song]
// BENCH_EVICT=1 đẩy giao dịch đã đóng ra khỏi bộ nhớ như bộ lập lịch của Hub.
const crypto = require('node:crypto');
const { PaymentHub } = require('../../src/hub');
const { PostgresStore } = require('../../src/store-postgres');
const { createHubServer } = require('../../src/server');
const { createFakeAdapter } = require('../../test/support/fake-adapter');

const URL_PG = process.env.HUB_TEST_DATABASE_URL;
if (!URL_PG) { console.error('đặt HUB_TEST_DATABASE_URL'); process.exit(1); }
const TOTAL = Number(process.argv[2] || 5000);
const CONC = Number(process.argv[3] || 50);
const TOKEN = 'bench-token-not-real-000001';
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

async function main() {
  const schema = `hbench_${crypto.randomBytes(4).toString('hex')}`;
  const store = await PostgresStore.open(URL_PG, { schema });
  const hub = new PaymentHub({ adapters: { gw1: createFakeAdapter('gw1') }, store, config: { gateways: [{ id: 'gw1' }] } });
  const api = createHubServer({ hub, apiToken: TOKEN, log: () => {}, accessLog: false, limits: { maxInFlight: 100000, ratePerSecond: 1e9, burst: 1e9 } });
  const { url } = await api.listen(0);
  const evict = process.env.BENCH_EVICT ? setInterval(() => store.evictIdle(1000), 500) : null;
  const lat = { create: [], ipn: [] };
  const errors = {};
  let next = 0;
  const t0 = Date.now();
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= TOTAL) return;
      const amount = 10000 + (i % 50);
      let s1 = process.hrtime.bigint();
      let r;
      try {
        r = await fetch(`${url}/payments`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ orderId: `O${i}`, amount, returnUrl: 'https://shop.test/r' }) });
      } catch (e) { const k = (e.cause && (e.cause.code || e.cause.message)) || e.message; errors[k] = (errors[k] || 0) + 1; continue; }
      const j = await r.json();
      lat.create.push(Number(process.hrtime.bigint() - s1) / 1e6);
      if (r.status !== 201) { errors[`create ${r.status}`] = (errors[`create ${r.status}`] || 0) + 1; continue; }
      s1 = process.hrtime.bigint();
      try {
        const c = await fetch(`${url}/ipn/gw1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: j.attempt.ref, type: 'succeeded', amount, txn: `T${i}` }) });
        await c.text();
        if (c.status !== 200) errors[`ipn ${c.status}`] = (errors[`ipn ${c.status}`] || 0) + 1;
      } catch (e) { const k = (e.cause && (e.cause.code || e.cause.message)) || e.message; errors[k] = (errors[k] || 0) + 1; }
      lat.ipn.push(Number(process.hrtime.bigint() - s1) / 1e6);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const secs = (Date.now() - t0) / 1000;
  const round = (x) => +x.toFixed(1);
  console.log(JSON.stringify({
    total: TOTAL, concurrency: CONC, seconds: round(secs), paymentsPerSec: round(TOTAL / secs), httpRequestsPerSec: round((lat.create.length + lat.ipn.length) / secs),
    clientCreateMs: { p50: round(pct(lat.create, 0.5)), p99: round(pct(lat.create, 0.99)) },
    clientIpnMs: { p50: round(pct(lat.ipn, 0.5)), p99: round(pct(lat.ipn, 0.99)) },
    errors, inMemoryPayments: store.payments.size,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    heapMBAfterGc: global.gc ? (global.gc(), Math.round(process.memoryUsage().heapUsed / 1048576)) : 'chạy với --expose-gc để đo',
  }, null, 1));
  if (evict) clearInterval(evict);
  await api.close();
  await store.close();
  await PostgresStore.dropSchema(URL_PG, schema);
}
main().catch((e) => { console.error(e); process.exit(1); });

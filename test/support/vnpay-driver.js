'use strict';
// spec: VNPS-S-001
// Driver VNPay cho test tích hợp (cùng giao diện với driver MoMo/OnePAY trong world.js).
const { startSimulator } = require('../../tools/sim/vnpay/server.js');
const { createVnpayAdapter } = require('../../src/adapters/vnpay');

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// opts.adapter: cấu hình thêm cho adapter (ví dụ failCodeMap)
async function vnpayDriver(hubBase, opts = {}) {
  const cfg = { tmnCode: 'TESTTMN1', hashSecret: 'test-hash-secret-not-a-real-key' };
  const sim = await startSimulator({ ...cfg, ipnUrl: `${hubBase}/ipn/vnpay` });
  const adapter = createVnpayAdapter({ ...cfg, baseUrl: sim.url, ...(opts.adapter || {}) }, { fetch: globalThis.fetch, clock: sim.clock });
  return {
    id: 'vnpay',
    adapter,
    sim,
    land: async (a) => { await fetch(a.url, { redirect: 'manual' }); }, // khách mở trang: simulator ghi nhận đơn
    pay: (a, outcome) => post(`${sim.url}/sim/pay`, { txnRef: a.ref, outcome: outcome === 'failed' ? 'insufficient' : outcome }),
    // Simulator VNPay hiểu ipn_duplicate là số bản gửi tổng cộng (>= 2); driver đổi true thành 2.
    control: (settings, a) => {
      const s = { ...settings };
      if (s.ipn_duplicate === true) s.ipn_duplicate = 2;
      return post(`${sim.url}/sim/control`, a ? { scope: 'txn', txnRef: a.ref, ...s } : s);
    },
    advance: (sec) => post(`${sim.url}/sim/clock/advance`, { seconds: sec }),
    close: () => sim.close(),
  };
}

module.exports = { vnpayDriver };

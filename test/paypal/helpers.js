'use strict';
// spec: PYPL-S-001
const http = require('node:http');
const { startSimulator } = require('../../tools/sim/paypal/server.js');
const { createPaypalAdapter } = require('../../src/adapters/paypal/index.js');

// Nhận webhook do simulator gửi; trả 2xx (đổi được qua rcv.status).
async function startReceiver() {
  const received = [];
  const rcv = { received, status: 200 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      received.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(rcv.status); res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  rcv.url = `http://127.0.0.1:${server.address().port}/ipn/paypal`;
  rcv.close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };
  return rcv;
}

async function setup(opts = {}) {
  const rcv = await startReceiver();
  const sim = await startSimulator({ webhookUrl: rcv.url, controls: opts.controls });
  const adapter = createPaypalAdapter(
    {
      clientId: sim.config.clientId, clientSecret: sim.config.clientSecret, webhookId: sim.config.webhookId, baseUrl: sim.url, returnBaseUrl: 'http://hub.test',
      certHosts: ['127.0.0.1'], certUrlAllowHttp: true, timeoutMs: opts.timeoutMs || 1500, currencies: ['USD', 'EUR', 'JPY', 'GBP'], ...(opts.adapter || {}),
    },
    { fetch: globalThis.fetch, clock: sim.clock },
  );
  const post = async (path, body) => {
    const r = await fetch(sim.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const t = {
    rcv, sim, adapter, post,
    control: (c) => post('/sim/control', c),
    advance: (seconds) => post('/sim/clock/advance', { seconds }),
    state: async () => (await fetch(`${sim.url}/sim/state`)).json(),
    create: (attemptRef, o = {}) => adapter.createPayment({ attemptRef, amount: 1999, currency: 'USD', orderInfo: 'Test', returnUrl: 'http://shop.test/return', ...o }),
    // khách duyệt trên trang PayPal; trả {redirect, query} của địa chỉ quay về
    async approve(created, outcome = 'approve') {
      const r = await post('/sim/pay', { order: created.state.order, outcome });
      const u = new URL(r.json.redirect);
      return { ...r, query: Object.fromEntries(u.searchParams) };
    },
    // trình duyệt quay về Hub: Hub đưa query cho adapter (kênh return)
    back: (query) => adapter.parseCallback({ channel: 'return', method: 'GET', query, body: {}, headers: {} }),
    parse: (d, headers) => adapter.parseCallback({ channel: 'ipn', method: 'POST', query: {}, body: d.raw, rawBody: d.raw, headers: headers || d.headers }),
    async events() { // mọi webhook đã nhận, dịch ra sự kiện chuẩn (bỏ qua cái adapter bỏ qua)
      const out = [];
      for (const d of rcv.received) { const r = await t.parse(d); if (r.valid && r.event) out.push(r.event); }
      return out;
    },
    types: () => rcv.received.map((d) => JSON.parse(d.raw).event_type),
    order: async (id) => (await fetch(`${sim.url}/sim/state`).then((r) => r.json())).orders.find((o) => o.id === id),
    async teardown() { await sim.close(); await rcv.close(); },
  };
  return t;
}

module.exports = { setup, startReceiver };

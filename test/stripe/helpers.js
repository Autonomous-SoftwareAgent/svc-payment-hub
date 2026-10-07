'use strict';
// spec: STRP-S-001
const http = require('node:http');
const { startSimulator } = require('../../tools/sim/stripe/server.js');
const { createStripeAdapter } = require('../../src/adapters/stripe/index.js');

const CREDS = { secretKey: 'sk_test_do_not_use_0000', webhookSecret: 'whsec_test_secret_do_not_use' };

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
  rcv.url = `http://127.0.0.1:${server.address().port}/ipn/stripe`;
  rcv.close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };
  return rcv;
}

async function setup(opts = {}) {
  const rcv = await startReceiver();
  const sim = await startSimulator({ ...CREDS, webhookUrl: rcv.url, controls: opts.controls });
  const adapter = createStripeAdapter(
    { ...CREDS, baseUrl: sim.url, timeoutMs: opts.timeoutMs || 1500, currencies: ['USD', 'EUR', 'JPY', 'VND', 'ISK'], ...(opts.adapter || {}) },
    { fetch: globalThis.fetch, clock: sim.clock },
  );
  const post = async (path, body) => {
    const r = await fetch(sim.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json() };
  };
  const t = {
    rcv, sim, adapter,
    post,
    pay: (session, outcome = 'success', extra = {}) => post('/sim/pay', { session, outcome, ...extra }),
    control: (c) => post('/sim/control', c),
    advance: (seconds) => post('/sim/clock/advance', { seconds }),
    state: async () => (await fetch(`${sim.url}/sim/state`)).json(),
    create: (attemptRef, o = {}) => adapter.createPayment({ attemptRef, amount: 1999, currency: 'USD', orderInfo: 'Test', returnUrl: 'http://shop.test/return', ...o }),
    // dịch một lần giao thành kết quả của adapter, đúng như server HTTP của Hub làm
    parse: (d, headers) => adapter.parseCallback({ channel: 'ipn', method: 'POST', query: {}, body: d.raw, rawBody: d.raw, headers: headers || { 'stripe-signature': d.headers['stripe-signature'] } }),
    async events() { // mọi webhook đã nhận, dịch ra sự kiện chuẩn (bỏ qua cái adapter bỏ qua)
      const out = [];
      for (const d of rcv.received) { const r = await t.parse(d); if (r.valid && r.event) out.push(r.event); }
      return out;
    },
    types: () => rcv.received.map((d) => JSON.parse(d.raw).type),
    csOf: (created) => created.state.cs,
    async teardown() { await sim.close(); await rcv.close(); },
  };
  return t;
}

module.exports = { CREDS, setup, startReceiver };

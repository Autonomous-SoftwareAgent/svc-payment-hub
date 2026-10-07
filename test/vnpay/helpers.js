'use strict';
// spec: VNPS-S-001
// Ha tang test: simulator (dong ho ao dong bang) + server nho nhan IPN + adapter.
const http = require('node:http');
const { startSimulator } = require('../../tools/sim/vnpay/server.js');
const { createVnpayAdapter } = require('../../src/adapters/vnpay');

const TMN = 'TESTTMN1';
const SECRET = 'test-hash-secret-not-a-real-key';
const START = Date.UTC(2026, 9, 2, 3, 0, 0); // 10:00 GMT+7

// respond(req, n) -> {status, body}; mac dinh: dung adapter parse, ack ok lan dau, duplicate lan sau
async function startHarness({ simOpts = {}, respond } = {}) {
  const received = [];
  let adapter;
  const seen = new Set();
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const r = { method: req.method, query: Object.fromEntries(url.searchParams), body: Buffer.concat(chunks).toString('utf8'), headers: req.headers };
      received.push(r);
      let out;
      if (respond) out = respond(r, received.length);
      else {
        const cb = adapter.parseCallback({ channel: 'ipn', method: r.method, query: r.query, body: r.body, headers: r.headers });
        let outcome = 'invalid_signature';
        if (cb.valid) { outcome = seen.has(cb.event.attemptRef) ? 'duplicate' : 'ok'; seen.add(cb.event.attemptRef); }
        out = cb.ack(outcome);
      }
      res.writeHead(out.status || 200, { 'content-type': out.contentType || 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const ipnUrl = `http://127.0.0.1:${receiver.address().port}/ipn`;
  const sim = await startSimulator({ tmnCode: TMN, hashSecret: SECRET, ipnUrl, clock: { startAt: START, frozen: true }, ...simOpts });
  adapter = createVnpayAdapter({ tmnCode: TMN, hashSecret: SECRET, baseUrl: sim.url }, { fetch, clock: sim.clock });
  const api = {
    sim, adapter, received, ipnUrl,
    post: async (path, body) => { const r = await fetch(sim.url + path, { method: 'POST', body: JSON.stringify(body || {}) }); return r.json(); },
    get: async (path) => (await fetch(sim.url + path)).json(),
    // tao URL va mo trang thanh toan de simulator ghi nhan don
    async create(ref, extra = {}) {
      const r = await adapter.createPayment({ attemptRef: ref, amount: 100000, orderInfo: 'Don hang ' + ref, returnUrl: 'http://localhost:9/return', ...extra });
      if (r.status === 'redirect') await fetch(r.url, { redirect: 'manual' });
      return r;
    },
    txn: async (ref) => (await api.get('/sim/transactions?txnRef=' + ref)).transactions[0],
    async close() { await sim.close(); receiver.closeAllConnections(); await new Promise((r) => receiver.close(r)); },
  };
  return api;
}
module.exports = { startHarness, TMN, SECRET, START };

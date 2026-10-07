'use strict';
// spec: OPAY-S-001
const http = require('node:http');
const { startSimulator } = require('../../tools/sim/onepay/server.js');
const { createOnepayAdapter } = require('../../src/adapters/onepay/index.js');

const KEY = '00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF'; // hex giả
const CFG = { merchant: 'TESTSIM', accessCode: 'SIMCODE1', hashKeyHex: KEY, queryUser: 'u', queryPassword: 'p' };

// "Server của merchant": nhận IPN GET, đưa vào adapter.parseCallback, ack theo outcome do test chọn.
function startMerchant(adapter, { outcome = 'ok' } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const query = Object.fromEntries(url.searchParams);
    const result = adapter.parseCallback({ channel: 'ipn', method: 'GET', query, body: '', headers: {} });
    const out = typeof outcome === 'function' ? outcome(result, received.length) : outcome;
    received.push({ query, result });
    const a = result.ack(out);
    res.writeHead(a.status, { 'content-type': a.contentType });
    res.end(a.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({
      received,
      url: `http://127.0.0.1:${port}/ipn`,
      close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
    });
  }));
}

async function setup(simOpts = {}, merchantOpts = {}, cfgOver = {}) {
  const sim = await startSimulator({ merchant: CFG.merchant, accessCode: CFG.accessCode, hashKeyHex: KEY, ...simOpts });
  const adapter = createOnepayAdapter({ ...CFG, baseUrl: sim.url, ...cfgOver }, { clock: sim.clock });
  const merchant = await startMerchant(adapter, merchantOpts);
  sim.state.ipnUrl = merchant.url;
  return { sim, adapter, merchant, close: async () => { await merchant.close(); await sim.close(); } };
}

const post = (sim, path, body) => fetch(sim.url + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

// Gọi URL do adapter dựng như trình duyệt, không theo redirect.
async function open(url) {
  const r = await fetch(url, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location') };
}

async function create(adapter, over = {}) {
  const p = { attemptRef: 'ATT-0001', amount: 150000, orderInfo: 'Order 1', returnUrl: 'http://localhost/return', ...over };
  const r = await adapter.createPayment(p);
  return { p, r };
}

// Tạo invoice trên simulator (mở URL như khách).
async function createAndOpen(adapter, over) {
  const c = await create(adapter, over);
  const o = await open(c.r.url);
  return { ...c, location: o.location };
}

module.exports = { KEY, CFG, setup, post, open, create, createAndOpen, startMerchant };

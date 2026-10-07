'use strict';
// spec: MOMO-S-001
const http = require('node:http');
const crypto = require('node:crypto');
const { startSimulator } = require('../../tools/sim/momo/server.js');
const { createMomoAdapter } = require('../../src/adapters/momo/index.js');

const CREDS = { partnerCode: 'MOMOTEST01', accessKey: 'test-access-key', secretKey: 'test-secret-key-do-not-use' };

// Server nhận IPN trong test; status trả về cấu hình được (mặc định 204 như MoMo mong đợi).
async function startIpnReceiver() {
  const received = [];
  const rcv = { received, status: 204 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body; try { body = JSON.parse(text); } catch { body = text; }
      received.push({ method: req.method, headers: req.headers, body });
      res.writeHead(rcv.status); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  rcv.url = `http://127.0.0.1:${server.address().port}/ipn`;
  rcv.close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };
  return rcv;
}

async function setup() {
  const ipn = await startIpnReceiver();
  const sim = await startSimulator({ ...CREDS, ipnUrl: undefined });
  const adapter = createMomoAdapter(
    { ...CREDS, baseUrl: sim.url, ipnUrl: ipn.url, redirectUrl: 'http://127.0.0.1/return', timeoutMs: 2000 },
    { fetch: globalThis.fetch, clock: { now: () => 1700000000000 } },
  );
  const call = async (method, path, body) => {
    const r = await fetch(sim.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  return {
    ipn, sim, adapter, call,
    pay: (orderId, outcome) => call('POST', '/sim/pay', { orderId, outcome }),
    control: (c) => call('POST', '/sim/control', c),
    create: (attemptRef, amount = 150000) => adapter.createPayment({ attemptRef, amount, orderInfo: 'Test', returnUrl: 'http://127.0.0.1/return' }),
    async teardown() { await sim.close(); await ipn.close(); },
  };
}

const hmac = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

module.exports = { CREDS, setup, startIpnReceiver, hmac };

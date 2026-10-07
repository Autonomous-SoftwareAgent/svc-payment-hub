'use strict';
// spec: SEPY-S-007
// spec: SEPY-S-001
// spec: SEPY-S-004
// spec: SEPY-S-005
const http = require('node:http');
const crypto = require('node:crypto');
const { startSimulator } = require('../../tools/sim/sepay/server.js');
const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');

// Toàn bộ là chuỗi giả cho test
const CREDS = {
  accountNumber: '0123456789', bankName: 'MBBank', accountName: 'CONG TY BSN TEST', codePrefix: 'BSN',
  apiKey: 'test-api-key-not-real', hmacSecret: 'test-hmac-secret-not-real', apiToken: 'test-api-token-not-real',
};

// Server nhận webhook trong test: đưa qua adapter.parseCallback như Hub sẽ làm.
// rcv.mode: 'ok' (ack đúng) | 'wrong_body' (200 + {"status":"ok"}) | 'fail' (500) | function(req)->ack
async function startReceiver(adapter) {
  const rcv = { requests: [], events: [], results: [], errors: [], mode: 'ok', failFirst: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const isJson = String(req.headers['content-type'] || '').includes('json');
      let body = rawBody;
      if (isJson) { try { body = JSON.parse(rawBody); } catch { body = rawBody; } }
      rcv.requests.push({ headers: req.headers, rawBody });
      let result;
      try {
        result = await adapter.parseCallback({ channel: 'ipn', method: req.method, query: {}, body, rawBody, headers: req.headers });
      } catch (err) { // adapter ném lỗi (ví dụ chưa tra được VA): Hub trả 500 để cổng gửi lại
        rcv.errors.push(err.message);
        res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error'); return;
      }
      rcv.results.push(result);
      let ack;
      if (typeof rcv.mode === 'function') ack = rcv.mode(result);
      else if (!result.valid) ack = result.ack('invalid_signature');
      else if (result.retryLater) { rcv.errors.push(result.reason); ack = result.ack('error'); } // như Hub: retryLater -> ack lỗi, cổng gửi lại
      else if (rcv.failFirst > 0) { rcv.failFirst -= 1; ack = result.ack('error'); }
      else if (rcv.mode === 'fail') ack = result.ack('error');
      else if (rcv.mode === 'wrong_body') ack = { status: 200, body: '{"status":"ok"}', contentType: 'application/json' };
      else {
        if (result.event) rcv.events.push(result.event);
        ack = result.ack('ok');
      }
      res.writeHead(ack.status, { 'content-type': ack.contentType }); res.end(ack.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  rcv.url = `http://127.0.0.1:${server.address().port}/webhook`;
  rcv.close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };
  return rcv;
}

// authMode áp cho cả adapter và simulator; controls là điều khiển ban đầu của simulator
async function setup({ authMode = 'hmac', controls = {}, adapterConfig = {} } = {}) {
  const sim = await startSimulator({ ...CREDS, authMode, controls: { api_rate_limit: 1000, ...controls } });
  const adapter = createSepayAdapter({
    ...CREDS, authMode, apiBaseUrl: `${sim.url}/v2`, qrBaseUrl: `${sim.url}/img`, timeoutMs: 3000, ...adapterConfig,
  }, { fetch: globalThis.fetch, clock: sim.clock });
  const rcv = await startReceiver(adapter);
  sim.setWebhookUrl(rcv.url);
  const call = async (method, path, body) => {
    const r = await fetch(sim.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  return {
    sim, adapter, rcv, call,
    transfer: (content, amount = 150000, extra = {}) => call('POST', '/sim/transfer', { content, amount, ...extra }).then((r) => r.json.transaction),
    control: (ctl) => call('POST', '/sim/control', ctl),
    advance: (seconds) => call('POST', '/sim/clock/advance', { seconds }),
    async teardown() { await sim.close(); await rcv.close(); },
  };
}

// Như setup nhưng bật thêm sản phẩm B (vaBank) và/hoặc C (pg) trong cùng một adapter (SEPY-D-006).
// adapterConfig.va / adapterConfig.pg ghi đè mặc định; simOpts truyền thẳng cho simulator.
async function setupProducts({ authMode = 'hmac', controls = {}, adapterConfig = {}, vaBank, pg = false, simOpts = {}, ipnAuth } = {}) {
  const sim = await startSimulator({
    ...CREDS, authMode, vaBank, apiToken: CREDS.apiToken, pgMerchantId: 'MERCHANT_TEST', pgSecretKey: 'test-pg-secret-not-real',
    ...(ipnAuth ? { pgIpnAuth: ipnAuth } : {}), controls: { api_rate_limit: 1000, ...controls }, ...simOpts,
  });
  const cfg = {
    ...CREDS, authMode, apiBaseUrl: `${sim.url}/v2`, qrBaseUrl: `${sim.url}/img`, timeoutMs: 3000, ...adapterConfig,
  };
  if (vaBank) {
    cfg.va = {
      bankAccountId: sim.config.bankAccountId, ...(vaBank === 'Vietcombank' ? { tid: sim.config.vcbTid, orderCodeMaxLength: 15 } : {}),
      ...(vaBank === 'Sacombank' ? { vaPrefix: sim.config.vaPrefix } : {}), ...(adapterConfig.va || {}),
    };
  }
  if (pg) {
    cfg.pg = {
      merchantId: 'MERCHANT_TEST', secretKey: 'test-pg-secret-not-real', checkoutUrl: `${sim.url}/v1/checkout/init`, apiBaseUrl: `${sim.url}/v1`,
      returnBaseUrl: 'https://hub.example.test/return/sepay', ...(ipnAuth ? { ipnAuth } : {}), ...(adapterConfig.pg || {}),
    };
  }
  const adapter = createSepayAdapter(cfg, { fetch: globalThis.fetch, clock: sim.clock });
  const rcv = await startReceiver(adapter);
  sim.setWebhookUrl(rcv.url);
  const call = async (method, path, body) => {
    const r = await fetch(sim.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return {
    sim, adapter, rcv, call, cfg,
    newAdapter: (extra = {}) => createSepayAdapter({ ...cfg, ...extra }, { fetch: globalThis.fetch, clock: sim.clock }), // cùng cấu hình, bộ nhớ đệm trống (như sau khi khởi động lại)
    control: (ctl) => call('POST', '/sim/control', ctl),
    advance: (seconds) => call('POST', '/sim/clock/advance', { seconds }),
    // Tạo đơn VA qua adapter, trả về kết quả createPayment
    va: (attemptRef, amount = 150000, extra = {}) => adapter.createPayment({ product: 'va-order', attemptRef, amount, orderInfo: 'x', returnUrl: 'http://x', ...extra }),
    toVa: (res, amount, extra = {}) => call('POST', '/sim/transfer', { va: res.instructions.accountNumber, amount, ...extra }),
    async teardown() { await sim.close(); await rcv.close(); },
  };
}

const hmacHex = (secret, ts, raw) => crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');

module.exports = { CREDS, setup, setupProducts, startReceiver, hmacHex };

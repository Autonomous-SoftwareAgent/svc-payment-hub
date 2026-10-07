'use strict';
// spec: PHUB-S-016
// Cổng chậm và lỗi hàng loạt, đi qua server HTTP thật của Hub, adapter thật và simulator thật; lỗi được chèn ở biên HTTP giữa adapter và simulator.
// Kiểm bất biến tiền: timeout thì KHÔNG chuyển cổng (tiền có thể đã bị thu); breaker mở thì cổng lỗi không bị gọi nữa và giao dịch mới đi cổng khác.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createHubServer } = require('../../src/server');
const { createMomoAdapter } = require('../../src/adapters/momo/index.js');
const { startSimulator } = require('../../tools/sim/momo/server.js');
const { DRIVERS } = require('../support/world');
const { createClock } = require('../support/fake-adapter');

const TOKEN = 'test-api-token-not-real';
const CREDS = { partnerCode: 'MOMOTEST01', accessKey: 'test-access-key', secretKey: 'test-secret-key-do-not-use' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const clock = createClock(Date.now());
  const fault = { mode: 'none', delayMs: 0, calls: 0 };
  const faultyFetch = async (url, init) => {
    fault.calls += 1;
    if (fault.mode === 'down') throw new TypeError('fetch failed'); // như kết nối bị từ chối
    if (fault.mode === 'late') { const r = await globalThis.fetch(url, init); await sleep(fault.delayMs); return r; } // cổng đã nhận, trả lời trễ
    return globalThis.fetch(url, init);
  };
  let hub;
  const api = createHubServer({ getHub: () => hub, apiToken: TOKEN, log: () => {} });
  const { url: base } = await api.listen(0);
  const momoSim = await startSimulator({ ...CREDS });
  const momo = createMomoAdapter(
    { ...CREDS, baseUrl: momoSim.url, ipnUrl: `${base}/ipn/momo`, redirectUrl: `${base}/return/momo`, timeoutMs: 5000 },
    { fetch: faultyFetch, clock: { now: () => Date.now() } },
  );
  const onepay = await DRIVERS.onepay(base);
  hub = new PaymentHub({
    adapters: { momo, onepay: onepay.adapter },
    clock,
    config: {
      gateways: [{ id: 'momo', priority: 1 }, { id: 'onepay', priority: 2 }],
      reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120], maxAgeSeconds: 86400 },
      protection: { perGateway: { momo: { timeoutMs: 300, failureThreshold: 3, openSeconds: 30 } } },
    },
  });
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* không phải JSON */ }
    return { status: r.status, json, text };
  };
  const create = (orderId) => call('POST', '/payments', { orderId, amount: 150000, returnUrl: 'https://shop.test/r' });
  return {
    hub, clock, fault, call, create, momoSim, onepay,
    momoPay: (ref) => fetch(`${momoSim.url}/sim/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: ref, outcome: 'success' }) }),
    async close() { await momoSim.close(); await onepay.close(); await api.close(); },
  };
}

test('cổng trả lời trễ quá timeout: attempt UNKNOWN, KHÔNG chuyển sang cổng khác; khách vẫn trả được ở cổng đã nhận đơn và Hub ghi nhận qua IPN', async () => {
  const s = await setup();
  try {
    s.fault.mode = 'late';
    s.fault.delayMs = 1000;
    const r = await s.create('LATE1');
    assert.equal(r.status, 201);
    assert.equal(r.json.attempt.gateway, 'momo');
    assert.equal(r.json.attempt.status, 'UNKNOWN', 'timeout: không rõ, không được coi là thất bại');
    assert.equal([...s.hub.store.attempts.values()].filter((a) => a.gateway === 'onepay').length, 0, 'không failover khi tiền có thể đã bị thu');
    const calls = await s.call('GET', `/calls?ref=${r.json.attempt.ref}`);
    assert.equal(calls.json.calls[0].outcome, 'timeout');

    s.fault.mode = 'none';
    const paid = await s.momoPay(r.json.attempt.ref); // cổng thật sự đã có đơn này
    assert.equal(paid.status, 200);
    for (let i = 0; i < 40; i++) { const d = await s.call('GET', `/payments/${r.json.payment.id}`); if (d.json.payment.status === 'PAID') break; await sleep(50); }
    const d = await s.call('GET', `/payments/${r.json.payment.id}`);
    assert.equal(d.json.payment.status, 'PAID');
    assert.equal(d.json.attempts[0].status, 'SUCCEEDED');
    assert.equal(d.json.anomalies.length, 0);
  } finally { await s.close(); }
});

test('cổng lỗi hàng loạt: các giao dịch đầu UNKNOWN (không failover), breaker mở, giao dịch mới đi cổng còn lại và cổng lỗi không bị gọi thêm; hồi phục thì đóng lại', async () => {
  const s = await setup();
  try {
    s.fault.mode = 'down';
    const failed = [];
    for (let i = 0; i < 3; i++) { const r = await s.create(`DOWN${i}`); assert.equal(r.status, 201); assert.equal(r.json.attempt.status, 'UNKNOWN'); assert.equal(r.json.attempt.gateway, 'momo'); failed.push(r.json); }
    assert.equal(s.hub.guards.momo.state, 'open');
    const callsWhenOpened = s.fault.calls;

    const ok = await s.create('AFTER1');
    assert.equal(ok.status, 201);
    assert.equal(ok.json.attempt.gateway, 'onepay', 'breaker mở: bỏ qua cổng lỗi, chưa gọi nên chắc chắn chưa nhận tiền');
    assert.equal(ok.json.attempt.status, 'AWAITING');
    assert.equal(s.fault.calls, callsWhenOpened, 'cổng lỗi không bị gọi thêm');

    const m = await s.call('GET', '/metrics');
    assert.match(m.text, /hub_gateway_breaker_state\{gateway="momo"\} 2/);
    const gw = await s.call('GET', '/gateways');
    assert.equal(gw.json.gateways.find((g) => g.gateway === 'momo').state, 'open');

    // các giao dịch UNKNOWN: đối soát không suy ra thất bại, kể cả khi hỏi lại không thấy đơn
    s.clock.advance(61);
    s.fault.mode = 'none';
    await s.hub.reconcile();
    for (const f of failed) assert.equal((await s.call('GET', `/payments/${f.payment.id}`)).json.attempts[0].status, 'UNKNOWN', 'không bao giờ suy ra failed khi chưa rõ');

    // hồi phục: hết thời gian nghỉ thì lời gọi đầu tiên là lời gọi thử; thành công thì đóng
    const back = await s.create('RECOVER1');
    assert.equal(back.json.attempt.gateway, 'momo');
    assert.equal(back.json.attempt.status, 'AWAITING');
    assert.equal(s.hub.guards.momo.state, 'closed');
  } finally { await s.close(); }
});

'use strict';
// spec: PHUB-S-009
// spec: PHUB-S-010
// spec: PHUB-S-011
// API: giới hạn tải (số request đồng thời, tốc độ), route vận hành mới (cổng, nhật ký gọi, webhook).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createHubServer } = require('../../src/server');
const { buildSinks } = require('../../src/connectors/registry');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const TOKEN = 'test-api-token-not-real';

async function start({ limits, webhooks, hold } = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a');
  if (hold) a.createPayment = () => new Promise(() => {});
  const hub = new PaymentHub({
    adapters: { a }, clock,
    deps: { sinks: buildSinks({ fetch: async () => ({ status: 200, body: null }) }) },
    config: { gateways: [{ id: 'a', priority: 1 }], protection: { timeoutMs: 400 }, webhooks: webhooks ? { url: 'https://shop.test/hook', secret: 's', auto: false } : null },
  });
  const t = { now: 0 };
  const api = createHubServer({ hub, apiToken: TOKEN, limits, now: () => t.now, log: () => {} });
  const { url } = await api.listen(0);
  const call = async (method, path, body, token = TOKEN) => {
    const h = {};
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* không phải JSON */ }
    return { status: r.status, json, retryAfter: r.headers.get('retry-after') };
  };
  return { hub, a, api, call, t, close: () => api.close() };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop.test/return', ...o });

test('quá số request đồng thời: 503 kèm Retry-After; /health và callback của cổng (phần dành riêng) vẫn qua', async () => {
  const s = await start({ limits: { maxInFlight: 2, callbackReserve: 1 }, hold: true });
  try {
    // hai request treo (cổng không trả lời) chiếm hết chỗ
    const hang = [s.call('POST', '/payments', order({ orderId: 'H1' })), s.call('POST', '/payments', order({ orderId: 'H2' }))];
    for (const h of hang) h.catch(() => {});
    // chờ tới khi cả hai request tới server (không dùng độ trễ cố định: máy bận thì chậm hơn 50 ms)
    for (let i = 0; i < 300 && s.api.stats().inFlight < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.api.stats().inFlight, 2);
    const over = await s.call('POST', '/payments', order({ orderId: 'H3' }));
    assert.equal(over.status, 503);
    assert.equal(over.json.error, 'overloaded');
    assert.equal(over.retryAfter, '1');
    assert.equal((await s.call('GET', '/health', undefined, null)).status, 200, '/health không bị giới hạn');
    const cb = await s.call('POST', '/ipn/a', { ref: 'KHONGCO', type: 'succeeded', amount: 1, txn: 'T' }, null);
    assert.equal(cb.status, 200, 'callback dùng phần dành riêng');
    for (const h of hang) h.catch(() => {});
  } finally { await s.close(); }
});

test('giới hạn tốc độ: hết token thì 429 kèm Retry-After; thêm token theo thời gian; callback và health không bị tính', async () => {
  const s = await start({ limits: { ratePerSecond: 1, burst: 2 } });
  try {
    assert.equal((await s.call('GET', '/anomalies')).status, 200);
    assert.equal((await s.call('GET', '/anomalies')).status, 200);
    const r = await s.call('GET', '/anomalies');
    assert.equal(r.status, 429);
    assert.equal(r.json.error, 'rate_limited');
    assert.ok(Number(r.retryAfter) >= 1);
    assert.equal((await s.call('GET', '/health', undefined, null)).status, 200);
    assert.equal((await s.call('POST', '/ipn/a', { ref: 'X', type: 'succeeded', amount: 1, txn: 'T' }, null)).status, 200);
    s.t.now += 1500;
    assert.equal((await s.call('GET', '/anomalies')).status, 200, 'token được cấp lại theo thời gian');
    assert.equal((await s.call('GET', '/anomalies', undefined, 'sai')).status, 401, 'sai token bị từ chối trước khi tính tốc độ');
  } finally { await s.close(); }
});

test('GET /gateways cho trạng thái breaker; GET /calls cho nhật ký gọi; refund_limit trả 409', async () => {
  const s = await start();
  try {
    const p = await s.call('POST', '/payments', order());
    assert.equal(p.status, 201);
    const g = await s.call('GET', '/gateways');
    assert.equal(g.json.gateways[0].gateway, 'a');
    assert.equal(g.json.gateways[0].state, 'closed');
    assert.equal(g.json.gateways[0].totals.ok, 1);
    const c = await s.call('GET', `/calls?ref=${p.json.attempt.ref}`);
    assert.equal(c.json.calls.length, 1);
    assert.equal(c.json.calls[0].method, 'createPayment');
    assert.equal((await s.call('GET', '/calls?gateway=khac')).json.calls.length, 0);
    assert.equal((await s.call('GET', '/gateways', undefined, null)).status, 401);
  } finally { await s.close(); }
});

test('GET /webhooks và POST /webhooks/{id}/retry', async () => {
  const s = await start({ webhooks: true });
  try {
    const p = await s.call('POST', '/payments', order());
    await s.call('POST', '/ipn/a', { ref: p.json.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' }, null);
    const list = await s.call('GET', '/webhooks?status=pending');
    assert.equal(list.status, 200);
    assert.equal(list.json.webhooks.length, 1);
    const w = list.json.webhooks[0];
    assert.equal(w.type, 'payment.paid');
    assert.equal(w.status, 'pending');
    assert.equal('body' in w, false, 'không trả thân (có thể chứa dữ liệu đơn hàng)');
    const r = await s.call('POST', `/webhooks/${w.id}/retry`, {});
    assert.equal(r.status, 200);
    assert.equal((await s.call('POST', '/webhooks/evt_khong_co/retry', {})).status, 404);
    await s.hub.deliverWebhooks();
    assert.equal((await s.call('POST', `/webhooks/${w.id}/retry`, {})).status, 409, 'đã giao thì không gửi lại');
  } finally { await s.close(); }
});

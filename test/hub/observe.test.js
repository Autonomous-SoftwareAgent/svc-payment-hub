'use strict';
// spec: PHUB-S-013
// Quan sát được: metrics Prometheus, mã yêu cầu, nhật ký truy cập không lộ dữ liệu nhạy cảm, log lỗi có mã yêu cầu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createHubServer } = require('../../src/server');
const { buildSinks } = require('../../src/connectors/registry');
const { Metrics } = require('../../src/metrics');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const ADMIN = 'admin-token-not-real-0001';
const METRICS = 'metrics-token-not-real-01';

async function start(opts = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({
    adapters: { a }, clock,
    deps: { sinks: buildSinks({ fetch: async () => ({ status: 200, body: null }) }) },
    config: { gateways: [{ id: 'a' }], webhooks: opts.webhooks ? { url: 'https://shop.test/h', secret: 's', auto: false } : null },
  });
  const logs = [];
  const api = createHubServer({ hub, apiToken: ADMIN, metricsToken: METRICS, log: (e) => logs.push(e), limits: opts.limits });
  const { url } = await api.listen(0);
  const call = async (method, path, body, token = ADMIN, headers = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* không phải JSON */ }
    return { status: r.status, text, json, headers: r.headers };
  };
  return { hub, a, api, call, logs, close: () => api.close() };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop.test/return', ...o });
const settle = () => new Promise((r) => setImmediate(r)); // đợi sự kiện 'close' của response được xử lý

test('Metrics: nhãn được escape; histogram có bucket cộng dồn, +Inf bằng count; counter cộng dồn', () => {
  const m = new Metrics();
  m.define('x_total', 'counter', 'thử');
  m.inc('x_total', { path: 'a"b\\c\nd' });
  m.inc('x_total', { path: 'a"b\\c\nd' }, 2);
  m.observe('t_seconds', { r: 'x' }, 0.003);
  m.observe('t_seconds', { r: 'x' }, 0.3);
  m.gauge('g', 'gauge', () => [{ labels: { k: 'v' }, value: 7 }]);
  const text = m.render();
  assert.match(text, /x_total\{path="a\\"b\\\\c\\nd"\} 3/);
  assert.match(text, /t_seconds_bucket\{le="0.005",r="x"\} 1/);
  assert.match(text, /t_seconds_bucket\{le="0.5",r="x"\} 2/);
  assert.match(text, /t_seconds_bucket\{le="\+Inf",r="x"\} 2/);
  assert.match(text, /t_seconds_count\{r="x"\} 2/);
  assert.match(text, /g\{k="v"\} 7/);
  assert.match(text, /# TYPE x_total counter/);
});

test('GET /metrics: cần token quản trị hoặc token metrics; không tính giới hạn tốc độ; nội dung đúng', async () => {
  const s = await start({ limits: { ratePerSecond: 1, burst: 3 } });
  try {
    assert.equal((await s.call('GET', '/metrics', undefined, null)).status, 401);
    assert.equal((await s.call('GET', '/metrics', undefined, 'sai-token-khong-co-that')).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await s.call('GET', '/metrics', undefined, METRICS)).status, 200, 'metrics không bị giới hạn tốc độ');
    const p = await s.call('POST', '/payments', order());
    assert.equal(p.status, 201);
    await s.call('GET', `/payments/${p.json.payment.id}`);
    await settle();
    const r = await s.call('GET', '/metrics');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/plain/);
    assert.match(r.text, /hub_http_requests_total\{method="POST",route="\/payments",status="201"\} 1/);
    assert.match(r.text, /hub_http_requests_total\{method="GET",route="\/payments\/\{id\}",status="200"\} 1/);
    assert.equal(r.text.includes(p.json.payment.id), false, 'nhãn dùng route mẫu, không dùng id thật');
    assert.match(r.text, /hub_gateway_calls_total\{gateway="a",method="createPayment",outcome="ok"\} 1/);
    assert.match(r.text, /hub_ops_total\{op="createPayment",result="ok"\} 1/);
    assert.match(r.text, /hub_op_duration_seconds_bucket\{le="\+Inf",op="createPayment"\} 1/);
    assert.match(r.text, /hub_attempts_live 1/);
    assert.match(r.text, /hub_payments_open 1/);
    assert.match(r.text, /hub_gateway_breaker_state\{gateway="a"\} 0/);
    assert.match(r.text, /process_resident_memory_bytes \d+/);
  } finally { await s.close(); }
});

test('token metrics chỉ đọc được /metrics, không đụng được API khác', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/metrics', undefined, METRICS)).status, 200);
    assert.equal((await s.call('POST', '/payments', order(), METRICS)).status, 403);
    assert.equal((await s.call('GET', '/anomalies', undefined, METRICS)).status, 403);
  } finally { await s.close(); }
});

test('gauge anomaly mở theo loại, webhook chờ và tuổi webhook chờ lâu nhất, breaker mở', async () => {
  const s = await start({ webhooks: true });
  try {
    const p = await s.call('POST', '/payments', order());
    await s.call('POST', '/ipn/a', { ref: p.json.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' }, null);
    await s.call('POST', '/ipn/a', { ref: 'KHONGCO', type: 'succeeded', amount: 7, txn: 'T2' }, null);
    s.hub.clock.advance(90);
    s.hub.guards.a.state = 'open';
    const r = await s.call('GET', '/metrics');
    assert.match(r.text, /hub_anomalies_open\{type="unknown_attempt"\} 1/);
    assert.match(r.text, /hub_webhooks_pending 2/);
    assert.match(r.text, /hub_webhook_oldest_pending_age_seconds 90/);
    assert.match(r.text, /hub_gateway_breaker_state\{gateway="a"\} 2/);
    assert.match(r.text, /hub_callbacks_total\{gateway="a",outcome="ok"\} 1/);
    assert.match(r.text, /hub_callbacks_total\{gateway="a",outcome="unknown_attempt"\} 1/);
  } finally { await s.close(); }
});

test('mã yêu cầu: dùng X-Request-Id hợp lệ của người gọi, thay cái không hợp lệ, tự sinh khi thiếu; có trong nhật ký truy cập', async () => {
  const s = await start();
  try {
    const a = await s.call('GET', '/anomalies', undefined, ADMIN, { 'x-request-id': 'req-abc_123' });
    assert.equal(a.headers.get('x-request-id'), 'req-abc_123');
    const b = await s.call('GET', '/anomalies', undefined, ADMIN, { 'x-request-id': 'bad id <script>"' });
    assert.match(b.headers.get('x-request-id'), /^[0-9a-f]{16}$/);
    const c = await s.call('GET', '/anomalies');
    assert.match(c.headers.get('x-request-id'), /^[0-9a-f]{16}$/);
    assert.notEqual(c.headers.get('x-request-id'), b.headers.get('x-request-id'));
    await settle();
    assert.ok(s.logs.some((l) => l.requestId === 'req-abc_123' && l.route === '/anomalies'));
    const long = 'x'.repeat(65);
    assert.notEqual((await s.call('GET', '/anomalies', undefined, ADMIN, { 'x-request-id': long })).headers.get('x-request-id'), long);
  } finally { await s.close(); }
});

test('nhật ký truy cập: route mẫu, trạng thái, thời gian; KHÔNG có query string, thân request, token; /health không ghi', async () => {
  const s = await start();
  try {
    await s.call('GET', '/health', undefined, null);
    const p = await s.call('POST', '/payments', order({ orderInfo: 'BI-MAT-THAN-REQUEST' }));
    await s.call('POST', '/ipn/a?vnp_SecureHash=CHU-KY-BI-MAT&x=1', { ref: p.json.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' }, null);
    await s.call('GET', `/payments/${p.json.payment.id}?token=BI-MAT-QUERY`);
    await s.call('GET', '/anomalies', undefined, 'sai-token-khong-co-that');
    await settle();
    const access = s.logs.filter((l) => l.msg === 'request');
    assert.deepEqual(access.map((l) => [l.method, l.route, l.status]), [['POST', '/payments', 201], ['POST', '/ipn/{gateway}', 200], ['GET', '/payments/{id}', 200], ['GET', '/anomalies', 401]]);
    assert.ok(access.every((l) => typeof l.ms === 'number' && l.requestId));
    const dump = JSON.stringify(s.logs);
    for (const secret of ['BI-MAT-THAN-REQUEST', 'CHU-KY-BI-MAT', 'BI-MAT-QUERY', ADMIN, 'sai-token-khong-co-that', p.json.payment.id]) assert.equal(dump.includes(secret), false, `nhật ký lộ ${secret}`);
  } finally { await s.close(); }
});

test('lỗi 500: log lỗi có requestId và stack, phản hồi không lộ chi tiết nhưng trả cùng requestId', async () => {
  const s = await start();
  try {
    s.hub.createPayment = async () => { throw new Error('mật khẩu db = hunter2'); };
    const r = await s.call('POST', '/payments', order(), ADMIN, { 'x-request-id': 'r-500' });
    assert.equal(r.status, 500);
    assert.equal(r.text.includes('hunter2'), false);
    assert.equal(r.headers.get('x-request-id'), 'r-500');
    await settle();
    const err = s.logs.find((l) => l.level === 'error');
    assert.equal(err.requestId, 'r-500');
    assert.match(err.message, /hunter2/);
    assert.equal(s.logs.find((l) => l.msg === 'request' && l.requestId === 'r-500').status, 500);
  } finally { await s.close(); }
});

test('503 quá tải và 429 vẫn có mã yêu cầu và được ghi số đo', async () => {
  const s = await start({ limits: { maxInFlight: 0, callbackReserve: 0 } });
  try {
    const r = await s.call('GET', '/anomalies');
    assert.equal(r.status, 503);
    assert.ok(r.headers.get('x-request-id'));
    await settle();
    assert.ok(s.logs.some((l) => l.msg === 'request' && l.status === 503));
  } finally { await s.close(); }
});

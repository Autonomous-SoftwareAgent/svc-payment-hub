'use strict';
// spec: PHUB-S-008
// API HTTP của Hub: xác thực, idempotent theo orderId, ánh xạ lỗi, callback của cổng, return chỉ hiển thị, vận hành.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createHubServer } = require('../../src/server');
const { buildHub, interpolate } = require('../../src/main');
const { MemoryStore } = require('../../src/store');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const TOKEN = 'test-api-token-not-real';

async function start(opts = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a', { caps: opts.caps });
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a },
    clock,
    newRef: (p) => `${p}${++n}`,
    config: { gateways: [{ id: 'a', priority: 1 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 3600 }, paymentTtlSeconds: 1800 },
  });
  const api = createHubServer({ hub, apiToken: TOKEN, maxBodyBytes: opts.maxBodyBytes, log: () => {} });
  const { url } = await api.listen(0);
  const call = async (method, path, body, { token = TOKEN, raw, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) h['content-type'] = h['content-type'] || 'application/json';
    const r = await fetch(url + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* không phải JSON */ }
    return { status: r.status, json, text, location: r.headers.get('location') };
  };
  return { hub, a, clock, api, url, call, close: () => api.close() };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop.test/return', ...o });
const ipn = (s, body) => s.call('POST', '/ipn/a', body, { token: null });

test('xác thực: API cửa hàng/vận hành cần token; /health và callback của cổng thì không', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/health', undefined, { token: null })).status, 200);
    for (const [m, p, b] of [['POST', '/payments', order()], ['GET', '/payments/pay_1'], ['GET', '/anomalies'], ['POST', '/reconcile', {}], ['POST', '/refunds', {}]]) {
      assert.equal((await s.call(m, p, b, { token: null })).status, 401, `${m} ${p} không token`);
      assert.equal((await s.call(m, p, b, { token: 'sai' })).status, 401, `${m} ${p} sai token`);
    }
    const p = await s.call('POST', '/payments', order());
    assert.equal(p.status, 201);
  } finally { await s.close(); }
});

test('server từ chối khởi động khi không có apiToken', () => {
  assert.throws(() => createHubServer({ hub: {}, apiToken: '' }), /apiToken/);
});

test('POST /payments: 201 kèm attempt; gọi lại cùng orderId trả 200 cùng payment, không tạo attempt mới', async () => {
  const s = await start();
  try {
    const r1 = await s.call('POST', '/payments', order());
    assert.equal(r1.status, 201);
    assert.equal(r1.json.payment.status, 'OPEN');
    assert.equal(r1.json.attempt.status, 'AWAITING');
    assert.match(r1.json.attempt.url, /^https:\/\/fake\.test\/a\//);
    const r2 = await s.call('POST', '/payments', order());
    assert.equal(r2.status, 200);
    assert.equal(r2.json.existing, true);
    assert.equal(r2.json.payment.id, r1.json.payment.id);
    assert.equal(r2.json.attempt.id, r1.json.attempt.id);
    assert.equal(s.hub.store.attempts.size, 1);
    const r3 = await s.call('POST', '/payments', order({ amount: 5000 }));
    assert.equal(r3.status, 409);
    assert.equal(r3.json.error, 'order_conflict');
  } finally { await s.close(); }
});

test('POST /payments sau khi payment cũ đã CLOSED thì tạo payment mới', async () => {
  const s = await start();
  try {
    const r1 = await s.call('POST', '/payments', order());
    s.hub.store.getPayment(r1.json.payment.id).status = 'CLOSED';
    const r2 = await s.call('POST', '/payments', order());
    assert.equal(r2.status, 201);
    assert.notEqual(r2.json.payment.id, r1.json.payment.id);
  } finally { await s.close(); }
});

test('đầu vào sai: 400 (thiếu trường, số tiền lẻ, JSON hỏng); route lạ: 404', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('POST', '/payments', order({ amount: 10.5 }))).status, 400);
    assert.equal((await s.call('POST', '/payments', { orderId: 'X' })).status, 400);
    const bad = await s.call('POST', '/payments', undefined, { raw: '{không phải json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_json');
    assert.equal((await s.call('GET', '/khong-co')).status, 404);
  } finally { await s.close(); }
});

test('thân request quá lớn: 413 và không tạo gì', async () => {
  const s = await start({ maxBodyBytes: 2000 });
  try {
    const big = await s.call('POST', '/payments', order({ orderInfo: 'x'.repeat(5000) }));
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'payload_too_large');
    assert.equal(s.hub.store.payments.size, 0);
    assert.equal((await s.call('GET', '/health', undefined, { token: null })).status, 200, 'server vẫn phục vụ tiếp');
  } finally { await s.close(); }
});

test('GET /payments/{id}: 200 đủ thông tin, không lộ dữ liệu thô; id lạ 404', async () => {
  const s = await start();
  try {
    const r1 = await s.call('POST', '/payments', order());
    const g = await s.call('GET', `/payments/${r1.json.payment.id}`);
    assert.equal(g.status, 200);
    assert.equal(g.json.attempts.length, 1);
    assert.ok(!('raw' in g.json.attempts[0]));
    assert.equal(JSON.stringify(g.json).includes('raw'), false);
    assert.equal((await s.call('GET', '/payments/khong-co')).status, 404);
  } finally { await s.close(); }
});

test('IPN qua HTTP: thành công đưa payment sang PAID; trùng trả ack duplicate; chữ ký sai không đổi gì; cổng lạ 404', async () => {
  const s = await start();
  try {
    const r1 = await s.call('POST', '/payments', order());
    const ref = r1.json.attempt.ref;
    const ok = await ipn(s, { ref, type: 'succeeded', amount: 100000, txn: 'T1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, 'ok');
    assert.equal((await s.call('GET', `/payments/${r1.json.payment.id}`)).json.payment.status, 'PAID');
    assert.equal((await ipn(s, { ref, type: 'succeeded', amount: 100000, txn: 'T1' })).text, 'duplicate');
    assert.equal((await ipn(s, { valid: false })).status, 400);
    const unk = await s.call('POST', '/ipn/khong-co', {}, { token: null });
    assert.equal(unk.status, 404);
  } finally { await s.close(); }
});

test('return: chỉ hiển thị. Hub không đổi trạng thái và chuyển về returnUrl kèm trạng thái do Hub ghi nhận', async () => {
  const s = await start();
  try {
    const r1 = await s.call('POST', '/payments', order());
    const ref = r1.json.attempt.ref;
    const ret = await s.call('POST', '/return/a', { ref, type: 'succeeded', amount: 100000, txn: 'T1' }, { token: null });
    assert.equal(ret.status, 302);
    const loc = new URL(ret.location);
    assert.equal(loc.origin + loc.pathname, 'https://shop.test/return');
    assert.equal(loc.searchParams.get('paymentId'), r1.json.payment.id);
    assert.equal(loc.searchParams.get('status'), 'OPEN', 'cổng khẳng định thành công nhưng Hub chưa ghi nhận');
    assert.equal((await s.call('GET', `/payments/${r1.json.payment.id}`)).json.payment.status, 'OPEN');
    const unknown = await s.call('POST', '/return/a', { ref: 'nope', type: 'succeeded', amount: 1, txn: 'X' }, { token: null });
    assert.equal(unknown.status, 404);
  } finally { await s.close(); }
});

test('attempts: còn attempt có thể nhận tiền thì 409; sau khi FAILED thì 201', async () => {
  const s = await start();
  try {
    const r1 = await s.call('POST', '/payments', order());
    const pid = r1.json.payment.id;
    const busy = await s.call('POST', `/payments/${pid}/attempts`, { reason: 'customer_retry' });
    assert.equal(busy.status, 409);
    assert.equal(busy.json.error, 'attempt_still_live');
    await ipn(s, { ref: r1.json.attempt.ref, type: 'failed', amount: 100000, txn: 'F1' });
    const again = await s.call('POST', `/payments/${pid}/attempts`, { reason: 'customer_retry' });
    assert.equal(again.status, 201);
    assert.notEqual(again.json.attempt.ref, r1.json.attempt.ref);
  } finally { await s.close(); }
});

test('hoàn tiền qua HTTP: tạo, số tiền quá mức 422, hoàn thủ công cần xác nhận /done', async () => {
  const s = await start({ caps: { refundable: 'manual' } });
  try {
    const r1 = await s.call('POST', '/payments', order());
    await ipn(s, { ref: r1.json.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
    const attemptId = r1.json.attempt.id;
    assert.equal((await s.call('POST', '/refunds', { attemptId, amount: 999999 })).status, 422);
    assert.equal((await s.call('POST', '/refunds', { attemptId: 'khong-co' })).status, 404);
    const rf = await s.call('POST', '/refunds', { attemptId, amount: 40000, reason: 'khách đổi ý' });
    assert.equal(rf.status, 201);
    assert.equal(rf.json.status, 'MANUAL_REQUIRED');
    const done = await s.call('POST', `/refunds/${rf.json.id}/done`, {});
    assert.equal(done.status, 200);
    assert.equal(done.json.status, 'SUCCEEDED');
    assert.equal((await s.call('POST', `/refunds/${rf.json.id}/done`, {})).status, 409);
  } finally { await s.close(); }
});

test('anomaly qua HTTP: liệt kê, hoàn tiền cần cổng xác nhận (409 not_confirmed), force kèm ghi chú thì được', async () => {
  const s = await start();
  try {
    const r1 = await s.call('POST', '/payments', order());
    const ref = r1.json.attempt.ref;
    await ipn(s, { ref, type: 'failed', amount: 100000, txn: 'F1' });
    await ipn(s, { ref, type: 'succeeded', amount: 100000, txn: 'T1' }); // tiền về muộn
    const list = await s.call('GET', '/anomalies?type=late_success&status=open');
    assert.equal(list.json.anomalies.length, 1);
    const id = list.json.anomalies[0].id;
    const refused = await s.call('POST', `/anomalies/${id}/resolve`, { action: 'refund' });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'not_confirmed');
    const forced = await s.call('POST', `/anomalies/${id}/resolve`, { action: 'refund', force: true, note: 'đã kiểm tra sao kê' });
    assert.equal(forced.status, 200);
    assert.equal(forced.json.status, 'refunding');
    assert.equal((await s.call('GET', '/anomalies?status=open')).json.anomalies.length, 0);
  } finally { await s.close(); }
});

test('POST /reconcile chạy đối soát và trả số lượng đã hỏi', async () => {
  const s = await start();
  try {
    const r1 = await s.call('POST', '/payments', order());
    s.a.queryResults.set(r1.json.attempt.ref, { gateway: 'a', attemptRef: r1.json.attempt.ref, type: 'succeeded', amount: 100000, gatewayTxnId: 'TQ', occurredAt: 1, source: 'query' });
    s.clock.advance(61);
    const rc = await s.call('POST', '/reconcile', {});
    assert.equal(rc.status, 200);
    assert.equal(rc.json.queried, 1);
    assert.equal((await s.call('GET', `/payments/${r1.json.payment.id}`)).json.payment.status, 'PAID');
  } finally { await s.close(); }
});

test('lỗi bất ngờ: 500 internal_error, không lộ chi tiết', async () => {
  const s = await start();
  try {
    s.hub.createPayment = async () => { throw new Error('mật khẩu db = hunter2'); };
    const r = await s.call('POST', '/payments', order());
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'internal_error');
    assert.equal(r.text.includes('hunter2'), false);
  } finally { await s.close(); }
});

// ---------- khởi động từ cấu hình ----------
const cfg = () => ({
  port: 0, publicBaseUrl: '${PUB}', apiToken: '${TOK}', databaseUrl: '${DB_URL}',
  hub: { gateways: [{ id: 'momo', priority: 1 }, { id: 'sepay', priority: 2, enabled: false }] },
  adapters: {
    momo: { partnerCode: '${MOMO_P}', accessKey: 'a', secretKey: '${MOMO_S}', baseUrl: 'http://127.0.0.1:1' },
    sepay: { accountNumber: '${SEPAY_ACC}', apiKey: 'k' },
  },
});

test('cấu hình: ${BIẾN} được thay; thiếu biến thì không khởi động và nêu rõ tên biến', async () => {
  assert.equal(interpolate({ a: ['${X}'] }, { X: 'v' }).a[0], 'v');
  assert.throws(() => interpolate({ a: '${KHONG_CO}' }, {}), /KHONG_CO/);
  await assert.rejects(buildHub(cfg(), { PUB: 'https://hub.test', TOK: 't', DB_URL: 'postgres://x', MOMO_P: 'p' }, { store: new MemoryStore() }), /MOMO_S/);
});

test('cấu hình: cổng tắt không cần biến môi trường; thiếu databaseUrl thì không khởi động', async () => {
  const env = { PUB: 'https://hub.test/', TOK: 't', DB_URL: 'postgres://x', MOMO_P: 'p', MOMO_S: 's' }; // không có SEPAY_ACC
  const { hub, config } = await buildHub(cfg(), env, { store: new MemoryStore() });
  assert.deepEqual(Object.keys(hub.adapters), ['momo']);
  assert.equal(config.apiToken, 't');
  const noDb = cfg();
  delete noDb.databaseUrl;
  await assert.rejects(buildHub(noDb, env), /databaseUrl/);
});

test('cấu hình: cổng không hỗ trợ bị từ chối', async () => {
  const c = cfg();
  c.hub.gateways.push({ id: 'khong-ho-tro', priority: 9 });
  await assert.rejects(buildHub(c, { PUB: 'x', TOK: 't', DB_URL: 'postgres://x', MOMO_P: 'p', MOMO_S: 's' }, { store: new MemoryStore() }), /không hỗ trợ/);
});

test('cấu hình: webhooks, protection, refund, reconcile theo cổng đi từ tệp cấu hình vào Hub; cấu hình routing sai thì không khởi động', async () => {
  const env = { PUB: 'https://hub.test', TOK: 't', DB_URL: 'postgres://x', MOMO_P: 'p', MOMO_S: 's', HOOK_URL: 'https://shop.test/hook', HOOK_SECRET: 'whsec' };
  const c = cfg();
  c.hub.webhooks = { url: '${HOOK_URL}', secret: '${HOOK_SECRET}', maxAttempts: 4 };
  c.hub.protection = { failureThreshold: 3, perGateway: { momo: { timeoutMs: 9000 } } };
  c.hub.refund = { maxPerAttempt: 3 };
  c.hub.reconcile = { concurrency: 7, perGateway: { momo: { firstAfterSeconds: 9 } } };
  const { hub } = await buildHub(c, env, { store: new MemoryStore() });
  assert.equal(hub.events.enabled, true);
  assert.equal(hub.events.cfg.url, 'https://shop.test/hook');
  assert.equal(hub.events.cfg.maxAttempts, 4);
  assert.equal(hub.guards.momo.cfg.failureThreshold, 3);
  assert.equal(hub.guards.momo.cfg.timeoutMs, 9000);
  assert.equal(hub.config.refund.maxPerAttempt, 3);
  assert.equal(hub._rc('momo').firstAfterSeconds, 9);
  assert.equal(hub.config.reconcile.concurrency, 7);
  const bad = cfg();
  bad.hub.reconcile = { perGateway: { khong_co: {} } };
  await assert.rejects(buildHub(bad, env, { store: new MemoryStore() }), /không tồn tại/);
});

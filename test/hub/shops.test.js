'use strict';
// spec: PHUB-S-015
// Nhiều cửa hàng: định danh theo token, cô lập dữ liệu, idempotency theo (cửa hàng, orderId), webhook riêng, xoay vòng token.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PaymentHub } = require('../../src/hub');
const { createHubServer } = require('../../src/server');
const { buildSinks } = require('../../src/connectors/registry');
const { buildHub, interpolate } = require('../../src/main');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

const ADMIN = 'admin-token-not-real-0001';
const ADMIN_OLD = 'admin-token-old-not-real1';
const TA = 'shop-a-token-not-real-0001';
const TB = 'shop-b-token-not-real-0001';
const SECRET_A = 'whsec-a-not-real';
const SECRET_B = 'whsec-b-not-real';
const SECRET_DEFAULT = 'whsec-default-not-real';

async function start({ store, webhooks, apiToken = ADMIN } = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a');
  const sent = [];
  const hookFetch = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return { status: 200, body: null }; };
  const hub = new PaymentHub({
    adapters: { a }, clock, store, deps: { sinks: buildSinks({ fetch: hookFetch }) },
    config: { gateways: [{ id: 'a' }], webhooks: webhooks === undefined ? { auto: false, shops: { sa: { url: 'https://a.test/hook', secret: SECRET_A }, sb: { url: 'https://b.test/hook', secret: SECRET_B } } } : webhooks },
  });
  const api = createHubServer({ hub, apiToken, shops: [{ id: 'sa', apiToken: TA }, { id: 'sb', apiToken: TB }], log: () => {} });
  const { url } = await api.listen(0);
  const call = async (method, path, body, token = ADMIN) => {
    const h = {};
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* không phải JSON */ }
    return { status: r.status, json, text };
  };
  return { hub, a, api, call, sent, clock, close: () => api.close() };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop.test/return', ...o });
const ipn = (s, attempt, type = 'succeeded', extra = {}) => s.call('POST', '/ipn/a', { ref: attempt.ref, type, amount: attempt.amount, txn: 'T1', ...extra }, null);

test('shopId lấy từ token, không từ thân request; cùng orderId ở hai cửa hàng là hai payment độc lập; idempotent trong từng cửa hàng', async () => {
  const s = await start();
  try {
    const a1 = await s.call('POST', '/payments', order({ shopId: 'sb' }), TA); // cố giả danh cửa hàng khác
    assert.equal(a1.status, 201);
    assert.equal(a1.json.payment.shopId, 'sa', 'thân bị bỏ qua, lấy theo token');
    const b1 = await s.call('POST', '/payments', order(), TB);
    assert.equal(b1.status, 201);
    assert.notEqual(b1.json.payment.id, a1.json.payment.id);
    assert.equal(b1.json.payment.shopId, 'sb');
    const a2 = await s.call('POST', '/payments', order(), TA);
    assert.equal(a2.status, 200);
    assert.equal(a2.json.payment.id, a1.json.payment.id, 'idempotent trong cửa hàng');
    const conflict = await s.call('POST', '/payments', order({ amount: 5 }), TA);
    assert.equal(conflict.status, 409, 'khác số tiền cùng đơn cùng cửa hàng: xung đột');
    const bOther = await s.call('POST', '/payments', order({ amount: 5 }), TB);
    assert.equal(bOther.status, 409);
    const admin = await s.call('POST', '/payments', order({ orderId: 'AD', shopId: 'sa' }));
    assert.equal(admin.json.payment.shopId, 'sa', 'quản trị chỉ định cửa hàng qua thân');
    assert.equal((await s.call('POST', '/payments', order({ orderId: 'AD2' }))).json.payment.shopId, 'default');
    assert.equal((await s.call('POST', '/payments', order({ orderId: 'X', shopId: 'Bậy bạ' }))).status, 400);
  } finally { await s.close(); }
});

test('cô lập: cửa hàng khác thấy 404 (không lộ sự tồn tại) trên payment, attempt, hoàn tiền; quản trị thấy hết', async () => {
  const s = await start();
  try {
    const p = (await s.call('POST', '/payments', order(), TA)).json;
    await ipn(s, p.attempt);
    assert.equal((await s.call('GET', `/payments/${p.payment.id}`, undefined, TA)).status, 200);
    assert.equal((await s.call('GET', `/payments/${p.payment.id}`, undefined, TB)).status, 404);
    assert.equal((await s.call('GET', `/payments/${p.payment.id}`)).status, 200);
    assert.equal((await s.call('POST', `/payments/${p.payment.id}/attempts`, {}, TB)).status, 404);
    assert.equal((await s.call('POST', '/refunds', { attemptId: p.attempt.id }, TB)).status, 404);
    assert.equal((await s.call('POST', '/refunds', { attemptId: 'att_khong_co' }, TB)).status, 404, 'không tồn tại cũng 404, giống của người khác');
    const r = await s.call('POST', '/refunds', { attemptId: p.attempt.id, amount: 1000 }, TA);
    assert.equal(r.status, 201);
    assert.equal((await s.call('POST', '/refunds', { attemptId: p.attempt.id, amount: 1000 })).status, 201, 'quản trị hoàn được mọi cửa hàng');
  } finally { await s.close(); }
});

test('route vận hành chỉ cho token quản trị: token cửa hàng bị 403', async () => {
  const s = await start();
  try {
    const p = (await s.call('POST', '/payments', order(), TA)).json;
    for (const [m, path, body] of [['GET', '/anomalies'], ['POST', '/reconcile', {}], ['GET', '/gateways'], ['GET', '/calls'], ['GET', '/metrics'], ['POST', '/anomalies/an_1/resolve', { action: 'ignore' }], ['POST', '/refunds/ref_1/done', {}]]) {
      assert.equal((await s.call(m, path, body, TA)).status, 403, `${m} ${path}`);
    }
    assert.equal((await s.call('GET', '/anomalies')).status, 200);
    assert.ok(p);
  } finally { await s.close(); }
});

test('webhook riêng từng cửa hàng: đúng URL, đúng secret (ký kiểm độc lập); cửa hàng không có endpoint thì không nhận; danh sách và gửi lại bị cô lập', async () => {
  const s = await start();
  try {
    const pa = (await s.call('POST', '/payments', order(), TA)).json;
    const pb = (await s.call('POST', '/payments', order(), TB)).json;
    const pd = (await s.call('POST', '/payments', order({ orderId: 'D' }))).json; // cửa hàng default: không có endpoint
    await ipn(s, pa.attempt, 'succeeded', { txn: 'TA' });
    await ipn(s, pb.attempt, 'succeeded', { txn: 'TB' });
    await ipn(s, pd.attempt, 'succeeded', { txn: 'TD' });
    await s.hub.deliverWebhooks();
    assert.equal(s.sent.length, 2, 'cửa hàng default không có endpoint nên không có webhook');
    const toA = s.sent.find((x) => x.url === 'https://a.test/hook');
    const toB = s.sent.find((x) => x.url === 'https://b.test/hook');
    assert.equal(toA.body.data.paymentId, pa.payment.id);
    assert.equal(toB.body.data.paymentId, pb.payment.id);
    const check = (r, secret) => {
      const h = r.init.headers;
      return h['x-hub-signature'] === crypto.createHmac('sha256', secret).update(`${h['x-hub-timestamp']}.${r.init.body}`).digest('hex');
    };
    assert.equal(check(toA, SECRET_A), true);
    assert.equal(check(toA, SECRET_B), false, 'không ký bằng secret của cửa hàng khác');
    assert.equal(check(toB, SECRET_B), true);

    const la = await s.call('GET', '/webhooks', undefined, TA);
    assert.deepEqual(la.json.webhooks.map((w) => w.shopId), ['sa']);
    const lb = await s.call('GET', '/webhooks', undefined, TB);
    assert.deepEqual(lb.json.webhooks.map((w) => w.shopId), ['sb']);
    assert.equal((await s.call('GET', '/webhooks')).json.webhooks.length, 2);
    assert.equal((await s.call('GET', '/webhooks?shopId=sa')).json.webhooks.length, 1);
    const wid = la.json.webhooks[0].id;
    assert.equal((await s.call('POST', `/webhooks/${wid}/retry`, {}, TB)).status, 404);
  } finally { await s.close(); }
});

test('sự kiện không gắn payment (tiền chưa rõ chủ) đi tới endpoint mặc định nếu có, nếu không thì không gửi', async () => {
  const withDefault = await start({ webhooks: { auto: false, url: 'https://def.test/hook', secret: SECRET_DEFAULT, shops: { sa: { url: 'https://a.test/hook', secret: SECRET_A } } } });
  try {
    await withDefault.call('POST', '/ipn/a', { ref: 'KHONGCO', type: 'succeeded', amount: 9, txn: 'U1' }, null);
    await withDefault.hub.deliverWebhooks();
    assert.deepEqual(withDefault.sent.map((x) => [x.url, x.body.type]), [['https://def.test/hook', 'anomaly.opened']]);
    const h = withDefault.sent[0].init.headers;
    assert.equal(h['x-hub-signature'], crypto.createHmac('sha256', SECRET_DEFAULT).update(`${h['x-hub-timestamp']}.${withDefault.sent[0].init.body}`).digest('hex'));
  } finally { await withDefault.close(); }
  const noDefault = await start();
  try {
    await noDefault.call('POST', '/ipn/a', { ref: 'KHONGCO', type: 'succeeded', amount: 9, txn: 'U1' }, null);
    await noDefault.hub.deliverWebhooks();
    assert.equal(noDefault.sent.length, 0);
  } finally { await noDefault.close(); }
});

test('xoay vòng token: nhiều token quản trị (và nhiều token cho một cửa hàng) cùng hợp lệ', async () => {
  const s = await start({ apiToken: [ADMIN, ADMIN_OLD] });
  try {
    assert.equal((await s.call('GET', '/anomalies', undefined, ADMIN)).status, 200);
    assert.equal((await s.call('GET', '/anomalies', undefined, ADMIN_OLD)).status, 200);
    assert.equal((await s.call('GET', '/anomalies', undefined, 'token-da-bi-thu-hoi-0001')).status, 401);
  } finally { await s.close(); }
  const hub = new PaymentHub({ adapters: { a: createFakeAdapter('a') }, clock: createClock(), config: { gateways: [{ id: 'a' }] } });
  const api = createHubServer({ hub, apiToken: ADMIN, shops: [{ id: 'sa', apiToken: [TA, 'shop-a-token-moi-not-real1'] }], log: () => {} });
  const { url } = await api.listen(0);
  try {
    for (const t of [TA, 'shop-a-token-moi-not-real1']) {
      const r = await fetch(`${url}/payments`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(order({ orderId: t.slice(-6) })) });
      assert.equal(r.status, 201);
    }
  } finally { await api.close(); }
});

test('cấu hình token: trùng nhau, token cửa hàng quá ngắn, id cửa hàng sai đều bị từ chối khi khởi động', () => {
  const hub = {};
  assert.throws(() => createHubServer({ hub, apiToken: ADMIN, shops: [{ id: 'sa', apiToken: ADMIN }] }), /trùng/);
  assert.throws(() => createHubServer({ hub, apiToken: ADMIN, shops: [{ id: 'sa', apiToken: TA }, { id: 'sb', apiToken: TA }] }), /trùng/);
  assert.throws(() => createHubServer({ hub, apiToken: ADMIN, shops: [{ id: 'sa', apiToken: 'ngan' }] }), /16 ký tự/);
  assert.throws(() => createHubServer({ hub, apiToken: ADMIN, shops: [{ id: 'Sa Sa', apiToken: TA }] }), /id không hợp lệ/);
  assert.throws(() => createHubServer({ hub, apiToken: ADMIN, metricsToken: ADMIN }), /trùng/);
});

test('Hub (PostgreSQL): khóa đơn theo (cửa hàng, orderId) kể cả khi payment đã được đẩy ra khỏi bộ nhớ', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const store = await db.open();
    const s = await start({ store });
    try {
      const a1 = (await s.call('POST', '/payments', order(), TA)).json;
      await ipn(s, a1.attempt);
      await store.persist();
      store.evictIdle(0, Date.now() + 1000);
      assert.equal(store.payments.size, 0);
      const b1 = await s.call('POST', '/payments', order(), TB); // cùng orderId, cửa hàng khác: payment mới, không trả của A
      assert.equal(b1.status, 201);
      assert.notEqual(b1.json.payment.id, a1.payment.id);
      const a2 = await s.call('POST', '/payments', order(), TA); // cửa hàng A: trả lại payment cũ đã đẩy ra
      assert.equal(a2.status, 200);
      assert.equal(a2.json.payment.id, a1.payment.id);
      assert.equal((await s.call('GET', `/payments/${a1.payment.id}`, undefined, TB)).status, 404, 'cô lập giữ nguyên với payment nạp lại từ DB');
    } finally { await s.close(); }
  } finally { await db.cleanup(); }
});

test('cấu hình: shops và endpoint webhook từng cửa hàng đi từ tệp cấu hình; ${VAR:-} rỗng thì tắt webhook; trùng id thì lỗi', async () => {
  assert.equal(interpolate({ a: '${X:-}' }, {}).a, '');
  assert.equal(interpolate({ a: '${X:-mặc định}' }, {}).a, 'mặc định');
  assert.equal(interpolate({ a: '${X:-mặc định}' }, { X: 'giá trị' }).a, 'giá trị');
  assert.throws(() => interpolate({ a: '${X}' }, {}), /thiếu biến môi trường X/);
  const base = () => ({
    port: 0, publicBaseUrl: 'https://hub.test', apiToken: '${TOK}', databaseUrl: 'postgres://x',
    hub: { gateways: [{ id: 'momo' }], webhooks: { url: '${HOOK_URL:-}', secret: '${HOOK_SECRET:-}' } },
    adapters: { momo: { partnerCode: 'p', accessKey: 'a', secretKey: 's', baseUrl: 'http://127.0.0.1:1' } },
    shops: [
      { id: 'sa', apiToken: '${TA}', webhooks: { url: 'https://a.test/h', secret: 'sa-secret' } },
      { id: 'sb', apiToken: '${TB}' },
    ],
  });
  const { MemoryStore } = require('../../src/store');
  const env = { TOK: ADMIN, TA, TB };
  const { hub, config } = await buildHub(base(), env, { store: new MemoryStore() });
  assert.equal(hub.events.enabled, true);
  assert.equal(hub.events.endpointFor('sa').url, 'https://a.test/h');
  assert.equal(hub.events.endpointFor('sb'), null, 'cửa hàng không khai báo webhook thì không nhận');
  assert.equal(hub.events.endpointFor('default'), null, 'URL mặc định rỗng');
  assert.deepEqual(config.shops.map((x) => x.id), ['sa', 'sb']);

  const none = base();
  none.shops = [];
  const r = await buildHub(none, env, { store: new MemoryStore() });
  assert.equal(r.hub.events.enabled, false, 'không endpoint nào: webhook tắt');

  const dup = base();
  dup.shops.push({ id: 'sa', apiToken: '${TB}' });
  await assert.rejects(buildHub(dup, env, { store: new MemoryStore() }), /trùng id/);
});

'use strict';
// spec: PHUB-S-017
// Hợp đồng API (PHUB-D-017): OpenAPI sinh từ danh mục KHÔNG được nói dối. Chạy mọi thao tác qua HTTP thật rồi kiểm từng phản hồi và
// từng sự kiện phát ra theo đúng schema trong tài liệu OpenAPI; kiểm quyền theo danh mục; tệp sinh sẵn không được lệch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PaymentHub } = require('../../src/hub');
const { createHubServer } = require('../../src/server');
const { createApp } = require('../../src/app/app');
const { operations } = require('../../src/app/operations');
const { schemas, eventTypes } = require('../../src/app/schemas');
const { buildOpenApi } = require('../../src/app/openapi');
const { validate } = require('../../src/app/schema');
const { buildSinks } = require('../../src/connectors/registry');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const ADMIN = 'admin-token-not-real-0001';
const SHOP = 'shop-a-token-not-real-0001';
const doc = buildOpenApi({ operations, schemas, eventTypes, version: require('../../package.json').version });
const defs = doc.components.schemas;

async function start() {
  const clock = createClock();
  const a = createFakeAdapter('a', { caps: { refundable: 'manual' } });
  const captured = [];
  const errors = [];
  const rec = { kind: 'rec', ordered: false, validate() {}, async deliver(d) { captured.push(JSON.parse(d.body)); return {}; } };
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a }, clock, newRef: (p) => `${p}${++n}`,
    deps: { sinks: { ...buildSinks({}), rec } },
    config: { gateways: [{ id: 'a' }], paymentTtlSeconds: 600, reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 3600 }, events: { routes: [{ id: 'rec', sink: 'rec', types: '*' }] } },
  });
  const api = createHubServer({ hub, apiToken: ADMIN, shops: [{ id: 'sa', apiToken: SHOP }], log: (e) => { if (e.level === 'error') errors.push(e.message); }, checkOutput: true });
  const { url } = await api.listen(0);
  const call = async (method, p, body, token = ADMIN) => {
    const h = {};
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(url + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* không phải JSON */ }
    return { status: r.status, json, text };
  };
  return { hub, a, clock, captured, errors, call, close: () => api.close() };
}

// Kiểm một phản hồi theo tài liệu: mã trạng thái phải được khai báo và thân phải đúng schema của mã đó.
function conforms(method, template, res) {
  const op = doc.paths[template][method.toLowerCase()];
  const spec = op.responses[String(res.status)];
  assert.ok(spec, `${method} ${template}: mã ${res.status} không được khai báo (có: ${Object.keys(op.responses).join(', ')})`);
  const schema = spec.content && spec.content['application/json'] && spec.content['application/json'].schema;
  if (schema) assert.deepEqual(validate(schema, res.json, defs), [], `${method} ${template} -> ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`);
  return res;
}

test('OpenAPI hợp lệ về cấu trúc: mọi $ref tìm được, operationId không trùng, mọi thao tác có đường dẫn, webhooks khớp danh mục sự kiện', () => {
  const refs = [];
  JSON.stringify(doc, (k, v) => { if (k === '$ref') refs.push(v); return v; });
  assert.ok(refs.length > 10);
  for (const r of refs) assert.ok(defs[r.replace('#/components/schemas/', '')], `$ref không tồn tại: ${r}`);
  const ids = [];
  for (const [p, item] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(item)) { ids.push(op.operationId); assert.ok(op.operationId && op.summary, `${m} ${p} thiếu operationId/summary`); }
  assert.equal(new Set(ids).size, ids.length, 'operationId trùng');
  for (const [name, op] of Object.entries(operations)) assert.ok(ids.includes(name) || !op.bindings, `thao tác ${name} không có trong paths`);
  assert.deepEqual(Object.keys(doc.webhooks).sort(), Object.keys(eventTypes).sort());
  assert.equal(doc.openapi, '3.1.0');
  for (const t of Object.values(eventTypes)) assert.ok(defs[t.data], `thiếu schema dữ liệu sự kiện ${t.data}`);
});

test('tệp docs/_generated/openapi.json khớp tài liệu sinh từ code (chạy `node tools/openapi.js` để cập nhật)', () => {
  const file = path.join(__dirname, '..', '..', 'docs', '_generated', 'openapi.json');
  assert.ok(fs.existsSync(file), 'chưa có docs/_generated/openapi.json: chạy node tools/openapi.js');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(JSON.stringify(doc)));
});

test('mọi đường dẫn trong OpenAPI có route thật, và GET /openapi.json trả đúng tài liệu (cần token)', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/openapi.json', undefined, null)).status, 401);
    const got = await s.call('GET', '/openapi.json');
    assert.equal(got.status, 200);
    assert.deepEqual(got.json, JSON.parse(JSON.stringify(doc)));
    for (const [tpl, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        const url = tpl.replace(/\{[A-Za-z]+\}/g, 'x');
        const r = await s.call(method.toUpperCase(), url, method === 'post' ? {} : undefined);
        assert.notEqual(r.json && r.json.message, 'route không tồn tại', `${method} ${tpl} có trong OpenAPI nhưng không có route`);
      }
    }
  } finally { await s.close(); }
});

test('chạy mọi thao tác qua HTTP: phản hồi (thành công và lỗi) đều đúng schema; sự kiện phát ra đều đúng schema', async () => {
  const s = await start();
  try {
    // cửa hàng tạo thanh toán: 201, gọi lại 200
    const created = conforms('POST', '/payments', await s.call('POST', '/payments', { orderId: 'O1', amount: 100000, returnUrl: 'https://shop.test/r' }, SHOP));
    assert.equal(created.status, 201);
    assert.equal(conforms('POST', '/payments', await s.call('POST', '/payments', { orderId: 'O1', amount: 100000, returnUrl: 'https://shop.test/r' }, SHOP)).status, 200);
    conforms('POST', '/payments', await s.call('POST', '/payments', { orderId: 'O1', amount: 5, returnUrl: 'https://shop.test/r' }, SHOP)); // 409 order_conflict
    conforms('POST', '/payments', await s.call('POST', '/payments', { orderId: 'O2', amount: 'abc', returnUrl: 'x' }, SHOP)); // 400
    const pid = created.json.payment.id;
    conforms('GET', '/payments/{paymentId}', await s.call('GET', `/payments/${pid}`, undefined, SHOP));
    conforms('GET', '/payments/{paymentId}', await s.call('GET', '/payments/khong-co', undefined, SHOP)); // 404
    conforms('POST', '/payments/{paymentId}/attempts', await s.call('POST', `/payments/${pid}/attempts`, {}, SHOP)); // 409 còn attempt đang mở
    const ref = created.json.attempt.ref;
    await s.call('POST', '/ipn/a', { ref, type: 'failed', amount: 100000, txn: 'F1' }, null);
    assert.equal(conforms('POST', '/payments/{paymentId}/attempts', await s.call('POST', `/payments/${pid}/attempts`, { reason: 'customer_retry' }, SHOP)).status, 201);
    // tiền về muộn trên attempt đã fail -> anomaly
    await s.call('POST', '/ipn/a', { ref, type: 'succeeded', amount: 100000, txn: 'T1' }, null);
    const list = conforms('GET', '/anomalies', await s.call('GET', '/anomalies?status=open'));
    assert.ok(list.json.anomalies.length >= 1);
    conforms('POST', '/anomalies/{anomalyId}/resolve', await s.call('POST', `/anomalies/${list.json.anomalies[0].id}/resolve`, { action: 'refund' })); // 409 not_confirmed
    conforms('POST', '/anomalies/{anomalyId}/resolve', await s.call('POST', `/anomalies/${list.json.anomalies[0].id}/resolve`, { action: 'refund', force: true, note: 'đã kiểm tra' }));
    // thanh toán thành công và hoàn tiền
    const c2 = await s.call('POST', '/payments', { orderId: 'O3', amount: 70000, returnUrl: 'https://shop.test/r' }, SHOP);
    await s.call('POST', '/ipn/a', { ref: c2.json.attempt.ref, type: 'succeeded', amount: 70000, txn: 'T3' }, null);
    const rf = conforms('POST', '/refunds', await s.call('POST', '/refunds', { attemptId: c2.json.attempt.id, amount: 1000 }, SHOP));
    assert.equal(rf.status, 201);
    conforms('POST', '/refunds', await s.call('POST', '/refunds', { attemptId: 'khong-co' }, SHOP)); // 404
    conforms('POST', '/refunds/{refundId}/done', await s.call('POST', `/refunds/${rf.json.id}/done`, {}));
    conforms('POST', '/refunds/{refundId}/done', await s.call('POST', `/refunds/${rf.json.id}/done`, {})); // 409
    // vận hành
    conforms('POST', '/reconcile', await s.call('POST', '/reconcile', {}));
    conforms('GET', '/gateways', await s.call('GET', '/gateways'));
    conforms('GET', '/calls', await s.call('GET', '/calls?limit=5'));
    await s.hub.deliverWebhooks();
    const hooks = conforms('GET', '/webhooks', await s.call('GET', '/webhooks?status=delivered&limit=50'));
    assert.ok(hooks.json.webhooks.length >= 2);
    conforms('GET', '/webhooks', await s.call('GET', '/webhooks', undefined, SHOP));
    conforms('POST', '/webhooks/{webhookId}/retry', await s.call('POST', `/webhooks/${hooks.json.webhooks[0].id}/retry`, {})); // 409 đã giao
    conforms('POST', '/webhooks/{webhookId}/retry', await s.call('POST', '/webhooks/khong-co/retry', {}, SHOP)); // 404

    // sự kiện: mọi bản ghi đúng phong bì Event và đúng schema dữ liệu của loại; có đủ các loại nghiệp vụ chính
    await s.hub.deliverWebhooks();
    assert.ok(s.captured.length >= 4);
    for (const ev of s.captured) {
      assert.deepEqual(validate({ $ref: 'Event' }, ev, defs), [], JSON.stringify(ev));
      assert.ok(eventTypes[ev.type], `loại sự kiện chưa khai báo trong danh mục: ${ev.type}`);
      assert.deepEqual(validate({ $ref: eventTypes[ev.type].data }, ev.data, defs), [], `${ev.type}: ${JSON.stringify(ev.data)}`);
    }
    const types = new Set(s.captured.map((e) => e.type));
    for (const t of ['payment.paid', 'refund.updated', 'anomaly.opened']) assert.ok(types.has(t), `thiếu sự kiện ${t}`);
    assert.deepEqual(s.errors, [], 'máy chủ không được ghi lỗi 500 nào (checkOutput bật nên lệch schema sẽ hiện ở đây)');
  } finally { await s.close(); }
});

test('kiểm quyền do danh mục quyết định: thao tác chỉ-quản-trị trả 403 cho token cửa hàng, 401 khi không token; lệnh sai schema trả 400 kèm đường dẫn trường', async () => {
  const s = await start();
  try {
    for (const [name, op] of Object.entries(operations)) {
      const b = op.bindings.http;
      const url = b.path.replace(/\{[A-Za-z]+\}/g, 'x');
      const body = b.method === 'POST' ? {} : undefined;
      assert.equal((await s.call(b.method, url, body, null)).status, 401, `${name} không token`);
      if (!op.roles.includes('shop')) assert.equal((await s.call(b.method, url, body, SHOP)).status, 403, `${name} chỉ quản trị`);
    }
    const bad = await s.call('POST', '/payments', { orderId: '', amount: 1.5, returnUrl: 5 }, SHOP);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_input');
    assert.match(bad.json.message, /\$\.(orderId|amount|returnUrl)/);
  } finally { await s.close(); }
});

test('app.execute là cổng vào chuẩn: thao tác lạ, vai trò lạ, đầu vào sai đều có mã lỗi ổn định, không cần HTTP', async () => {
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({ adapters: { a }, config: { gateways: [{ id: 'a' }] }, deps: { sinks: buildSinks({}) } });
  const app = createApp({ hub, checkOutput: true });
  await assert.rejects(app.execute('khongCo', {}, { role: 'admin' }), { code: 'unknown_operation' });
  await assert.rejects(app.execute('createPayment', {}, null), { code: 'forbidden' });
  await assert.rejects(app.execute('createPayment', {}, { role: 'metrics' }), { code: 'forbidden' });
  await assert.rejects(app.execute('createPayment', { orderId: 'O', amount: 0, returnUrl: 'u' }, { role: 'admin' }), { code: 'invalid_input' });
  const ok = await app.execute('createPayment', { orderId: 'O', amount: 10, returnUrl: 'u', shopId: 'ignored' }, { role: 'shop', id: 'sa' });
  assert.equal(ok.payment.shopId, 'sa', 'token cửa hàng không bao giờ đổi được shopId');
  const cmp = await app.execute('createPayment', { orderId: 'O', amount: 10, returnUrl: 'u', shopId: 'sb' }, { role: 'admin' });
  assert.equal(cmp.payment.shopId, 'sb', 'quản trị chỉ định cửa hàng qua đầu vào');
});

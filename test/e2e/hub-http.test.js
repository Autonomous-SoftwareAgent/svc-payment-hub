'use strict';
// spec: PHUB-S-008
// Đầu-cuối qua API HTTP công khai của Hub: cửa hàng gọi POST /payments, cổng (simulator) gọi IPN về Hub,
// cửa hàng hỏi lại GET /payments/{id}. Không gọi thẳng vào đối tượng Hub.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld } = require('../support/world');

const TOKEN = 'test-api-token-not-real';
const shop = (w) => async (method, path, body) => {
  const r = await fetch(w.base + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};
const order = (o = {}) => ({ orderId: `ORD${Math.random().toString(36).slice(2, 8)}`, amount: 150000, returnUrl: 'https://shop.test/return', ...o });

test('[http][momo] cửa hàng tạo thanh toán, khách trả, IPN về Hub, cửa hàng thấy PAID; tạo lại cùng đơn không thu thêm', async () => {
  const w = await createWorld(['momo']);
  try {
    const api = shop(w);
    const o = order();
    const created = await api('POST', '/payments', o);
    assert.equal(created.status, 201);
    assert.equal(created.json.attempt.gateway, 'momo');
    assert.ok(created.json.attempt.url, 'có payUrl cho khách');
    const again = await api('POST', '/payments', o);
    assert.equal(again.status, 200);
    assert.equal(again.json.attempt.id, created.json.attempt.id);

    await w.drivers.momo.pay({ ref: created.json.attempt.ref }, 'success'); // khách trả; MoMo gọi IPN về /ipn/momo
    const got = await api('GET', `/payments/${created.json.payment.id}`);
    assert.equal(got.json.payment.status, 'PAID');
    assert.equal(got.json.attempts[0].status, 'SUCCEEDED');
    assert.equal(got.json.anomalies.length, 0);
    assert.equal((await api('GET', '/anomalies')).json.anomalies.length, 0);
  } finally { await w.close(); }
});

test('[http][sepay] cửa hàng nhận hướng dẫn chuyển khoản, khách chuyển thiếu rồi bù, webhook ký HMAC về Hub, PAID', async () => {
  const w = await createWorld(['sepay']);
  try {
    const api = shop(w);
    const created = await api('POST', '/payments', order());
    const att = created.json.attempt;
    assert.equal(att.url, null);
    assert.match(att.instructions.transferContent, /^DH[A-Z0-9]+$/);
    await w.drivers.sepay.transfer({ instructions: att.instructions, amount: att.amount }, { amount: 100000 });
    let got = await api('GET', `/payments/${created.json.payment.id}`);
    assert.equal(got.json.payment.status, 'OPEN');
    assert.equal(got.json.anomalies[0].type, 'underpaid');
    await w.drivers.sepay.transfer({ instructions: att.instructions, amount: att.amount }, { amount: 50000 });
    got = await api('GET', `/payments/${created.json.payment.id}`);
    assert.equal(got.json.payment.status, 'PAID');
    assert.equal(got.json.attempts[0].receivedTotal, 150000);
  } finally { await w.close(); }
});

test('[http] không có token thì cửa hàng không tạo được thanh toán; callback của cổng vẫn vào được', async () => {
  const w = await createWorld(['momo']);
  try {
    const r = await fetch(`${w.base}/payments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order()) });
    assert.equal(r.status, 401);
    assert.equal(w.hub.store.payments.size, 0);
    const health = await fetch(`${w.base}/health`);
    assert.equal(health.status, 200);
  } finally { await w.close(); }
});

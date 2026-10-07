'use strict';
// spec: STRP-S-001
// spec: STRP-S-002
// spec: STRP-S-003
// Kịch bản đối kháng với simulator Stripe: webhook trùng, đảo thứ tự, ký sai hoặc lệch giờ, 500 sau khi đã xử lý, timeout, 429, 409, truy vấn lỗi,
// sự kiện lạ. Điều cần giữ: mất phản hồi KHÔNG bao giờ thành thất bại, chữ ký sai không đổi gì, tiền không bị đếm hai lần ở tầng adapter.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, CREDS } = require('./helpers');

const signed = (t, raw, secret = CREDS.webhookSecret, now = t.sim.clock.now()) => {
  const ts = Math.floor(now / 1000);
  return { raw, headers: { 'stripe-signature': `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}` } };
};
const evt = (type, object) => JSON.stringify({ id: 'evt_x', object: 'event', type, created: 1790000000, data: { object } });

test('webhook trùng (giao thêm hai lần): adapter cho ra các sự kiện GIỐNG HỆT nhau (Hub chống trùng theo cổng, mã, giao dịch, loại, nguồn)', async () => {
  const t = await setup({ controls: { dup_webhooks: 2 } });
  try {
    const c = await t.create('BSNdup00001');
    await t.pay(c.state.cs);
    const evs = (await t.events()).filter((e) => e.type === 'succeeded');
    assert.equal(evs.length, 3);
    const key = (e) => [e.gateway, e.attemptRef, e.gatewayTxnId, e.type, e.source, e.amount].join('|');
    assert.equal(new Set(evs.map(key)).size, 1);
  } finally { await t.teardown(); }
});

test('webhook đảo thứ tự và giao muộn: mỗi sự kiện tự đủ thông tin, không phụ thuộc thứ tự; authorized và succeeded cùng một mã pi_', async () => {
  const t = await setup({ controls: { reverse_events: true, hold_webhooks: true } });
  try {
    const c = await t.create('BSNord00001', { product: 'auth' });
    await t.pay(c.state.cs);
    const h = await t.adapter.capture({ attemptRef: 'BSNord00001', amount: 1999, currency: 'USD', gatewayTxnId: (await t.adapter.query({ attemptRef: 'BSNord00001', amount: 1999, state: c.state })).gatewayTxnId, idempotencyKey: 'a:capture' });
    assert.equal(h.status, 'captured');
    assert.equal(t.rcv.received.length, 0, 'webhook đang được giữ');
    await t.post('/sim/webhook/flush', { reverse: true }); // giao theo thứ tự ngược với lúc phát sinh
    const evs = await t.events();
    const types = evs.map((e) => e.type);
    assert.ok(types.includes('authorized') && types.includes('succeeded'));
    assert.ok(types.indexOf('succeeded') < types.indexOf('authorized'), 'giao ngược: succeeded đến TRƯỚC authorized');
    assert.equal(new Set(evs.map((e) => e.gatewayTxnId)).size, 1, 'authorized và succeeded cùng mã giao dịch: lõi nhận ra đảo thứ tự (PHUB-D-038)');
  } finally { await t.teardown(); }
});

test('webhook không giao (mất): kênh truy vấn vẫn thấy sự thật; webhook bị giữ rồi giao muộn vẫn được chấp nhận trong dung sai', async () => {
  const t = await setup({ controls: { drop_types: ['payment_intent.succeeded'] } });
  try {
    const c = await t.create('BSNdrop0001');
    await t.pay(c.state.cs);
    assert.deepEqual(await t.events(), [], 'webhook succeeded đã mất');
    assert.equal((await t.adapter.query({ attemptRef: 'BSNdrop0001', amount: 1999, state: c.state })).type, 'succeeded', 'truy vấn là kênh chắc');
  } finally { await t.teardown(); }
  const late = await setup({ controls: { hold_webhooks: true } });
  try {
    const c = await late.create('BSNlate0001');
    await late.pay(c.state.cs);
    late.sim.clock.advance(200); // trong dung sai 300 giây, tính từ lúc ký
    await late.post('/sim/webhook/flush', {});
    assert.equal((await late.events()).filter((e) => e.type === 'succeeded').length, 1);
  } finally { await late.teardown(); }
});

test('chữ ký sai hoặc lệch giờ: valid=false, không có sự kiện, ack 400', async () => {
  for (const [name, controls] of [['secret sai', { sign_with: 'whsec_khac' }], ['lệch giờ 400 giây', { timestamp_skew_seconds: 400 }], ['lệch giờ -400 giây', { timestamp_skew_seconds: -400 }]]) {
    const t = await setup({ controls });
    try {
      const c = await t.create('BSNsig00001');
      await t.pay(c.state.cs);
      assert.ok(t.rcv.received.length >= 2, name);
      for (const d of t.rcv.received) {
        const r = await t.parse(d);
        assert.equal(r.valid, false, name);
        assert.equal(r.event, undefined);
        assert.equal(r.ack('invalid_signature').status, 400);
      }
    } finally { await t.teardown(); }
  }
});

test('ack: unknown_attempt và amount_mismatch trả 200 (Hub đã giữ bằng chứng), lỗi trả 500 để Stripe giao lại', async () => {
  const t = await setup();
  try {
    const r = await t.parse(signed(t, evt('ping', {})));
    for (const o of ['ok', 'duplicate', 'unknown_attempt', 'amount_mismatch']) assert.equal(r.ack(o).status, 200, o);
    assert.equal(r.ack('error').status, 500);
    assert.equal(r.ack('invalid_signature').status, 400);
  } finally { await t.teardown(); }
});

test('sự kiện hợp lệ nhưng không phải việc của Hub được bỏ qua: sự kiện lạ, thiếu data.object, PaymentIntent không có attemptRef, amount_capturable_updated khi chưa requires_capture', async () => {
  const t = await setup();
  try {
    const cases = [
      evt('customer.created', { id: 'cus_1' }),
      JSON.stringify({ id: 'evt_y', type: 'payment_intent.succeeded' }),
      evt('payment_intent.succeeded', { id: 'pi_other', status: 'succeeded', amount_received: 1000, currency: 'usd', metadata: {} }),
      evt('payment_intent.amount_capturable_updated', { id: 'pi_x', status: 'processing', amount_capturable: 0, currency: 'usd', metadata: { attemptRef: 'BSNx' } }),
      evt('checkout.session.completed', { id: 'cs_1', client_reference_id: 'BSNx', payment_status: 'paid', amount_total: 1000, currency: 'usd' }),
      evt('charge.dispute.funds_withdrawn', { id: 'du_1' }),
    ];
    for (const raw of cases) {
      const r = await t.parse(signed(t, raw));
      assert.equal(r.valid, true);
      assert.equal(r.event, undefined, raw.slice(0, 60));
      assert.equal(r.retryLater, undefined);
    }
  } finally { await t.teardown(); }
});

test('số tiền không đổi được sang đơn vị của Hub (ISK không phải bội của 100): retryLater, không đoán', async () => {
  const t = await setup();
  try {
    const raw = evt('payment_intent.succeeded', { id: 'pi_isk', status: 'succeeded', amount_received: 12345, currency: 'isk', metadata: { attemptRef: 'BSNisk0001' } });
    const r = await t.parse(signed(t, raw));
    assert.equal(r.valid, true);
    assert.equal(r.retryLater, true);
    assert.equal(r.event, undefined);
  } finally { await t.teardown(); }
});

test('tạo phiên mất phản hồi: 500 sau khi đã xử lý, 500 trước, timeout, 409 đang chạy đều là UNKNOWN (không phải rejected); gửi lại cùng khóa chỉ nhận lại 500 đã lưu', async () => {
  const t = await setup({ timeoutMs: 400 });
  try {
    await t.control({ inject: [{ match: 'POST /v1/checkout/sessions', mode: 'status500_after', times: 1 }] });
    assert.deepEqual(await t.create('BSNunk00001'), { status: 'unknown' });
    assert.equal((await t.state()).sessions.length, 1, 'phiên ĐÃ được tạo dù khách nhận 500');
    assert.deepEqual(await t.create('BSNunk00001'), { status: 'unknown' }, 'POST lại cùng khóa chỉ nhận lại kết quả 500 đã lưu');
    assert.equal((await t.state()).sessions.length, 1, 'không tạo thêm phiên');
    for (const mode of ['status500_before', 'timeout_after', 'status409']) {
      await t.control({ inject: [{ match: 'POST /v1/checkout/sessions', mode, times: 1 }] });
      assert.deepEqual(await t.create(`BSNunk${mode.length}`), { status: 'unknown' }, mode);
    }
  } finally { await t.teardown(); }
});

test('query: không có state (tạo mất phản hồi) là unknown; phiên không tồn tại là not_found; 500 hoặc timeout là unknown; không bao giờ suy ra thất bại', async () => {
  const t = await setup({ timeoutMs: 400 });
  try {
    assert.deepEqual(await t.adapter.query({ attemptRef: 'BSNq0000001', amount: 1999 }), { state: 'unknown' });
    assert.deepEqual(await t.adapter.query({ attemptRef: 'BSNq0000001', amount: 1999, state: { cs: 'cs_test_khongco' } }), { state: 'not_found' });
    const c = await t.create('BSNq0000002');
    for (const mode of ['status500_before', 'timeout_after', 'status429']) {
      await t.control({ inject: [{ match: 'GET /v1/checkout/sessions/', mode, times: 1 }] });
      assert.deepEqual(await t.adapter.query({ attemptRef: 'BSNq0000002', amount: 1999, state: c.state }), { state: 'unknown' }, mode);
    }
    assert.equal((await t.adapter.query({ attemptRef: 'BSNq0000002', amount: 1999, state: c.state })).type, 'pending');
  } finally { await t.teardown(); }
});

test('capture và void: timeout hoặc 500 sau khi đã xử lý là unknown, truy vấn thấy sự thật; 429 là lỗi chưa gửi (notSent, rate_limited); 409 là unknown', async () => {
  const t = await setup({ timeoutMs: 400 });
  try {
    const c = await t.create('BSNcap00001', { product: 'auth' });
    await t.pay(c.state.cs);
    const pi = (await t.adapter.query({ attemptRef: 'BSNcap00001', amount: 1999, state: c.state })).gatewayTxnId;
    const op = (kind, key) => ({ attemptRef: 'BSNcap00001', amount: 1999, currency: 'USD', gatewayTxnId: pi, idempotencyKey: key || `att:${kind}` });
    for (const mode of ['status429', 'status429_lock']) {
      await t.control({ inject: [{ match: '/capture', mode, times: 1 }] });
      await assert.rejects(t.adapter.capture(op('capture')), (e) => e.notSent === true && e.code === 'rate_limited', mode);
    }
    await t.control({ inject: [{ match: '/capture', mode: 'status409', times: 1 }] });
    assert.deepEqual(await t.adapter.capture(op('capture')), { status: 'unknown' });
    await t.control({ inject: [{ match: '/capture', mode: 'timeout_after', times: 1 }] });
    assert.deepEqual(await t.adapter.capture(op('capture')), { status: 'unknown' }, 'timeout sau khi đã thu: KHÔNG phải thất bại');
    assert.equal((await t.adapter.query({ attemptRef: 'BSNcap00001', amount: 1999, state: c.state })).type, 'succeeded', 'thật ra đã thu');
    await t.control({ inject: [{ match: '/cancel', mode: 'status500_before', times: 1 }] });
    assert.equal((await t.adapter.void(op('void'))).status, 'unknown');
  } finally { await t.teardown(); }
});

test('hoàn: 429 là chưa gửi (notSent); khóa sai là failed (cấu hình), không phải unknown', async () => {
  const t = await setup();
  try {
    const c = await t.create('BSNrf000001');
    await t.pay(c.state.cs);
    const pi = (await t.adapter.query({ attemptRef: 'BSNrf000001', amount: 1999, state: c.state })).gatewayTxnId;
    await t.control({ inject: [{ match: 'POST /v1/refunds', mode: 'status429', times: 1 }] });
    await assert.rejects(t.adapter.refund({ attemptRef: 'BSNrf000001', refundRef: 'RFrl000001', amount: 100, currency: 'USD', gatewayTxnId: pi, state: c.state }), (e) => e.notSent === true);
    const { createStripeAdapter } = require('../../src/adapters/stripe/index.js');
    const bad = createStripeAdapter({ secretKey: 'sk_test_sai', webhookSecret: 'x', baseUrl: t.sim.url, currencies: ['USD'] }, { clock: t.sim.clock });
    assert.deepEqual(await bad.refund({ attemptRef: 'BSNrf000001', refundRef: 'RFbad00001', amount: 100, currency: 'USD', gatewayTxnId: pi }), { status: 'failed' });
  } finally { await t.teardown(); }
});

test('cấu hình: configWarnings nêu khóa test, loại tiền chưa kiểm, sản phẩm auth; cấu hình sai bị từ chối lúc dựng', () => {
  const { adapter, createStripeAdapter } = require('../../src/adapters/stripe/index.js');
  const w = adapter.configWarnings({ secretKey: 'sk_test_x', currencies: ['USD', 'UGX', 'KWD'], product: 'auth' }).join('\n');
  assert.match(w, /khóa test/);
  assert.match(w, /UGX, KWD chưa kiểm/);
  assert.match(w, /maxAgeSeconds/);
  assert.deepEqual(adapter.configWarnings({ secretKey: 'sk_live_x' }), []);
  const base = { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' };
  assert.throws(() => createStripeAdapter({ ...base, product: 'lạ' }), /product không hợp lệ/);
  assert.throws(() => createStripeAdapter({ ...base, currencies: ['XYZ'] }), /currencies/);
  assert.throws(() => createStripeAdapter({ ...base, sessionExpiresMinutes: 10 }), /sessionExpiresMinutes/);
  assert.throws(() => createStripeAdapter({ ...base, sessionExpiresMinutes: 1440 }), /sessionExpiresMinutes/);
});

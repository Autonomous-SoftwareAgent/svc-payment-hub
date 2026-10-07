'use strict';
// spec: STRP-S-001
// spec: STRP-S-002
// Vòng đời thu ngay (sản phẩm charge) của adapter Stripe với simulator: tạo phiên, khách trả, webhook và truy vấn cùng ra một sự thật,
// khách trả hỏng không phải thất bại, hết hạn phiên, hủy bằng expire, và tiền theo đơn vị nhỏ nhất. Chỉ chạy với simulator: chưa kiểm Stripe thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { toStripeAmount, fromStripeAmount, encodeForm, PRODUCTS } = require('../../src/adapters/stripe/index.js');
const { assertEvent, assertAdapterShape } = require('../../src/contract');

test('tiền: JPY và VND truyền thẳng, ISK và UGX nhân 100, tiền ba chữ số phải là bội của 10; chiều ngược lại không đoán', () => {
  assert.deepEqual(toStripeAmount(1999, 'USD'), { amount: 1999 });
  assert.deepEqual(toStripeAmount(500, 'JPY'), { amount: 500 });
  assert.deepEqual(toStripeAmount(150000, 'VND'), { amount: 150000 });
  assert.deepEqual(toStripeAmount(5, 'ISK'), { amount: 500 }); // 5 ISK = 500 (documented)
  assert.deepEqual(toStripeAmount(1230, 'KWD'), { amount: 1230 });
  assert.match(toStripeAmount(1231, 'KWD').error, /bội của 10/);
  for (const bad of [0, -1, 1.5, '10', NaN, 2 ** 60]) assert.ok(toStripeAmount(bad, 'USD').error, String(bad));
  assert.equal(fromStripeAmount(500, 'ISK'), 5);
  assert.equal(fromStripeAmount(550, 'ISK'), null); // không phải bội của 100: không đoán
  assert.equal(fromStripeAmount(1999, 'USD'), 1999);
  assert.equal(fromStripeAmount(1.5, 'USD'), null);
});

test('form-encode lồng nhau kiểu Stripe: khóa dạng a[b][0][c], bỏ undefined và null', () => {
  const s = encodeForm({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'usd' } }], metadata: { a: 'x y', b: undefined, c: null }, flag: true }).join('&');
  assert.equal(s, 'mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd&metadata%5Ba%5D=x%20y&flag=true');
});

test('khả năng: hai sản phẩm (thu ngay, giữ rồi thu), loại tiền và phương án khai báo, adapter đúng hình dạng hợp đồng', async () => {
  const t = await setup();
  try {
    assert.equal(assertAdapterShape(t.adapter), true);
    const charge = t.adapter.capabilities('charge');
    const auth = t.adapter.capabilities('auth');
    assert.deepEqual(charge.operations, PRODUCTS.charge.operations);
    assert.deepEqual(auth.operations, ['authorize', 'capture', 'void', 'refund', 'inquire']);
    assert.equal(charge.partialCapture, false);
    assert.equal(auth.partialCapture, true);
    assert.deepEqual(charge.methods, ['card_international']);
    assert.ok(charge.currencies.includes('USD') && charge.currencies.includes('VND'));
    assert.deepEqual(t.adapter.capabilities('khong-co').operations, []); // sản phẩm lạ: không khai gì
    assert.deepEqual(t.adapter.capabilities('default').operations, charge.operations);
    assert.equal(typeof charge.hardExpiry.minutes, 'number');
  } finally { await t.teardown(); }
});

test('tạo phiên: gửi đúng form (client_reference_id, metadata ở cả phiên và PaymentIntent, hạn, giá), khóa idempotency, phiên bản API; trả nextAction redirect và state', async () => {
  const t = await setup();
  try {
    const before = Math.floor(t.sim.clock.now() / 1000);
    const r = await t.create('BSNaaa111', { amount: 1999, currency: 'USD', extra: { locale: 'en', customerEmail: 'a@b.test' } });
    assert.equal(r.status, 'next_action');
    assert.equal(r.nextAction.type, 'redirect');
    assert.match(r.nextAction.url, /\/pay\/cs_test_/);
    assert.match(r.state.cs, /^cs_test_/);
    assert.ok(r.expiresAt > t.sim.clock.now());
    const req = (await t.state()).requests[0];
    assert.equal(req.key, 'BSNaaa111:create');
    assert.equal(req.version, '2026-09-30.endive');
    const b = req.body;
    assert.equal(b.mode, 'payment');
    assert.equal(b.client_reference_id, 'BSNaaa111');
    assert.equal(b.metadata.attemptRef, 'BSNaaa111');
    assert.equal(b.payment_intent_data.metadata.attemptRef, 'BSNaaa111');
    assert.equal(b.payment_intent_data.capture_method, undefined); // charge: không giữ tiền
    assert.equal(b.line_items[0].price_data.currency, 'usd');
    assert.equal(b.line_items[0].price_data.unit_amount, '1999');
    assert.equal(b.locale, 'en');
    assert.equal(b.customer_email, 'a@b.test');
    const exp = Number(b.expires_at);
    assert.ok(exp - before >= 31 * 60 && exp - before <= 24 * 3600, 'hạn nằm trong khoảng Stripe cho phép (30 phút đến 24 giờ)');
    const auth = await t.create('BSNaaa222', { product: 'auth' });
    assert.equal(auth.status, 'next_action');
    assert.equal((await t.state()).requests[1].body.payment_intent_data.capture_method, 'manual');
  } finally { await t.teardown(); }
});

test('tạo phiên bị từ chối rõ ràng: khóa sai (401), tham số sai (400), 429; loại tiền chưa bật, số tiền sai, sản phẩm lạ chưa gọi mạng', async () => {
  const t = await setup();
  try {
    const bad = await setup({ adapter: { secretKey: 'sk_test_sai' } });
    const r401 = await bad.create('BSNbad001');
    assert.equal(r401.status, 'rejected');
    assert.equal(r401.failCode, 'invalid_request');
    assert.match(r401.reason, /401/);
    await bad.teardown();

    const small = await t.create('BSNsmall1', { amount: 20, currency: 'USD' }); // dưới mức tối thiểu của simulator (50 cent)
    assert.equal(small.status, 'rejected');
    assert.equal(small.failCode, 'invalid_request');
    assert.equal(small.gatewayCode, 'amount_too_small');

    await t.control({ inject: [{ match: 'POST /v1/checkout/sessions', mode: 'status429', times: 1 }] });
    const rl = await t.create('BSNrate001');
    assert.equal(rl.status, 'rejected');
    assert.equal(rl.failCode, 'rate_limited');

    const n = (await t.state()).requests.length;
    for (const [o, re] of [[{ currency: 'GBP' }, /GBP chưa được bật/], [{ amount: 1.5 }, /số nguyên/], [{ product: 'lạ' }, /sản phẩm không hợp lệ/], [{ returnUrl: '' }, /thiếu returnUrl/]]) {
      const x = await t.create('BSNlocal01', o);
      assert.equal(x.status, 'rejected');
      assert.match(x.reason, re);
    }
    assert.equal((await t.state()).requests.length, n, 'các từ chối cục bộ không gọi mạng');
  } finally { await t.teardown(); }
});

test('thu ngay: khách trả, webhook cho đúng một sự kiện succeeded (session.completed bị bỏ qua), truy vấn ra cùng mã giao dịch pi_', async () => {
  const t = await setup();
  try {
    const c = await t.create('BSNpay0001', { amount: 1999 });
    assert.equal((await t.adapter.query({ attemptRef: 'BSNpay0001', amount: 1999, state: c.state })).type, 'pending');
    const paid = await t.pay(c.state.cs);
    assert.equal(paid.json.status, 'paid');
    assert.deepEqual(t.types(), ['checkout.session.completed', 'payment_intent.succeeded', 'charge.succeeded']);
    const evs = await t.events();
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.type, 'succeeded');
    assert.equal(e.attemptRef, 'BSNpay0001');
    assert.equal(e.amount, 1999);
    assert.equal(e.currency, 'USD');
    assert.equal(e.source, 'ipn');
    assert.match(e.gatewayTxnId, /^pi_/);
    assert.equal(assertEvent(e), true);
    const q = await t.adapter.query({ attemptRef: 'BSNpay0001', amount: 1999, state: c.state });
    assert.equal(q.type, 'succeeded');
    assert.equal(q.gatewayTxnId, e.gatewayTxnId, 'webhook và truy vấn cùng một mã giao dịch');
    assert.equal(q.amount, 1999);
    assert.equal(q.source, 'query');
  } finally { await t.teardown(); }
});

test('khách trả hỏng không phải thất bại: phiên vẫn mở, payment_failed bị bỏ qua, truy vấn vẫn pending, khách thử lại được', async () => {
  const t = await setup();
  try {
    const c = await t.create('BSNdecl001');
    const d = await t.pay(c.state.cs, 'decline', { decline_code: 'insufficient_funds' });
    assert.equal(d.json.status, 'declined');
    assert.deepEqual(t.types(), ['payment_intent.payment_failed']);
    assert.deepEqual(await t.events(), [], 'adapter không coi payment_failed là thất bại của attempt');
    const q = await t.adapter.query({ attemptRef: 'BSNdecl001', amount: 1999, state: c.state });
    assert.equal(q.type, 'pending');
    assert.equal((await t.pay(c.state.cs, 'success')).json.status, 'paid');
    assert.equal((await t.events()).length, 1);
    // khách bấm hủy ở trang Stripe: không đổi gì
    const c2 = await t.create('BSNcanc001');
    await t.pay(c2.state.cs, 'cancel');
    assert.equal((await t.adapter.query({ attemptRef: 'BSNcanc001', amount: 1999, state: c2.state })).type, 'pending');
  } finally { await t.teardown(); }
});

test('hết hạn phiên: webhook session.expired thành sự kiện expired, truy vấn cũng expired, khách không trả được nữa', async () => {
  const t = await setup();
  try {
    const c = await t.create('BSNexp00001');
    const adv = await t.advance(24 * 3600);
    assert.equal(adv.json.events, 1);
    assert.deepEqual(t.types(), ['checkout.session.expired']);
    const e = (await t.events())[0];
    assert.equal(e.type, 'expired');
    assert.equal(e.failCode, 'expired');
    assert.equal(e.amount, 1999);
    assert.equal(e.attemptRef, 'BSNexp00001');
    const q = await t.adapter.query({ attemptRef: 'BSNexp00001', amount: 1999, state: c.state });
    assert.equal(q.type, 'expired');
    assert.equal((await t.pay(c.state.cs)).status, 409);
  } finally { await t.teardown(); }
});

test('hủy bằng expire: phiên mở thì hủy được, đã hết hạn coi là hủy được (lặp lại an toàn), đã trả thì không hủy được; không có state thì không hủy', async () => {
  const t = await setup();
  try {
    const a = await t.create('BSNcxl00001');
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNcxl00001', state: a.state }), { cancelled: true });
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNcxl00001', state: a.state }), { cancelled: true });
    assert.equal((await t.adapter.query({ attemptRef: 'BSNcxl00001', amount: 1999, state: a.state })).type, 'expired');
    const b = await t.create('BSNcxl00002');
    await t.pay(b.state.cs);
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNcxl00002', state: b.state }), { cancelled: false });
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNcxl00003', state: undefined }), { cancelled: false });
  } finally { await t.teardown(); }
});

test('tiền theo đơn vị nhỏ nhất qua simulator: JPY truyền thẳng, ISK nhân 100 khi gửi và chia lại khi nhận, VND zero-decimal', async () => {
  const t = await setup();
  try {
    const jpy = await t.create('BSNjpy00001', { amount: 500, currency: 'JPY' });
    const vnd = await t.create('BSNvnd00001', { amount: 150000, currency: 'VND' });
    const isk = await t.create('BSNisk00001', { amount: 1000, currency: 'ISK' });
    const reqs = (await t.state()).requests;
    assert.equal(reqs[0].body.line_items[0].price_data.unit_amount, '500');
    assert.equal(reqs[1].body.line_items[0].price_data.unit_amount, '150000');
    assert.equal(reqs[2].body.line_items[0].price_data.unit_amount, '100000'); // 1000 ISK = 100000 trong API
    for (const [c, ref, amount, cur] of [[jpy, 'BSNjpy00001', 500, 'JPY'], [vnd, 'BSNvnd00001', 150000, 'VND'], [isk, 'BSNisk00001', 1000, 'ISK']]) {
      await t.pay(c.state.cs);
      const q = await t.adapter.query({ attemptRef: ref, amount, state: c.state });
      assert.equal(q.type, 'succeeded', cur);
      assert.equal(q.amount, amount, `${cur}: số tiền về lại đúng đơn vị của Hub`);
      assert.equal(q.currency, cur);
    }
    const evs = await t.events();
    assert.deepEqual(evs.map((e) => [e.currency, e.amount]), [['JPY', 500], ['VND', 150000], ['ISK', 1000]]);
  } finally { await t.teardown(); }
});

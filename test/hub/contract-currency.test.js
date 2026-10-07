'use strict';
// spec: PHUB-S-033
// Ngôn ngữ chung mở rộng cho cổng quốc tế (PHUB-D-016): tiền kèm mã ISO 4217, mã thất bại mới, khả năng có kiểu.
// Bốn adapter hiện có không đổi hành vi: adapter không khai loại tiền thì chỉ nhận VND, không bao giờ đoán.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const contract = require('../../src/contract');
const routing = require('../../src/routing');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const { FAIL_CODES, isRetriable, CURRENCY_EXPONENT, assertAdapterShape, assertEvent } = contract;
const fake = (id, caps) => createFakeAdapter(id, { caps });
const hubOf = (adapters, gateways, extra = {}) => new PaymentHub({ adapters, clock: createClock(), config: { gateways, ...extra } });
const order = (o = {}) => ({ orderId: `O${Math.random().toString(36).slice(2, 8)}`, amount: 100000, returnUrl: 'https://s/r', ...o });
const cb = (id, hub, body) => hub.handleCallback(id, { channel: 'ipn', method: 'POST', query: {}, headers: {}, body });

test('bảng số lẻ ISO 4217: VND và JPY không lẻ, USD hai chữ số, KWD ba chữ số', () => {
  assert.equal(CURRENCY_EXPONENT.VND, 0);
  assert.equal(CURRENCY_EXPONENT.JPY, 0);
  assert.equal(CURRENCY_EXPONENT.USD, 2);
  assert.equal(CURRENCY_EXPONENT.KWD, 3);
  assert.equal(CURRENCY_EXPONENT.XYZ, undefined); // loại tiền lạ không có số mũ mặc định
});

test('mã thất bại mới có trong bảng chuẩn; chỉ gateway_error và rate_limited là thử lại được', () => {
  for (const c of ['authentication_required', 'fraud', 'rate_limited']) assert.ok(FAIL_CODES.includes(c), c);
  assert.deepEqual(FAIL_CODES.filter(isRetriable).sort(), ['gateway_error', 'rate_limited']);
  assert.equal(isRetriable('unknown'), false); // chưa rõ không bao giờ được coi là thử lại an toàn
  assert.equal(isRetriable('declined'), false);
});

test('khả năng mới được kiểm khi khai: loại tiền lạ, nước sai dạng, thao tác lạ, kiểu sai đều bị từ chối', () => {
  const ok = fake('a', { currencies: ['VND', 'USD'], regions: ['VN', '*'], operations: ['purchase', 'refund', 'inquire'], partialRefund: true, partialCapture: false, threeDs: true, amountLimits: { min: 1, max: 1000 } });
  assert.equal(assertAdapterShape(ok), true);
  const bad = (caps, re) => assert.throws(() => assertAdapterShape(fake('b', caps)), re);
  bad({ currencies: ['XYZ'] }, /currencies/);
  bad({ currencies: 'VND' }, /currencies/);
  bad({ regions: ['vn'] }, /regions/);
  bad({ operations: ['steal'] }, /operations/);
  bad({ partialRefund: 'yes' }, /partialRefund/);
  bad({ amountLimits: { min: 1.5 } }, /amountLimits/);
  assert.equal(assertAdapterShape(fake('c', {})), true); // vắng hết thì vẫn hợp lệ (adapter cũ)
});

test('sự kiện có currency: loại lạ bị từ chối; vắng là hợp lệ', () => {
  const base = { gateway: 'a', attemptRef: 'R', type: 'succeeded', amount: 5, occurredAt: 0, source: 'ipn' };
  assert.equal(assertEvent(base), true);
  assert.equal(assertEvent({ ...base, currency: 'USD' }), true);
  assert.throws(() => assertEvent({ ...base, currency: 'XYZ' }), /currency không hợp lệ/);
});

test('routing: payment không nói loại tiền là VND; adapter không khai thì chỉ nhận VND (không đoán)', async () => {
  const old = fake('old', {}); // adapter cũ
  const usd = fake('usd', { currencies: ['USD'] });
  const hub = hubOf({ old, usd }, [{ id: 'old', priority: 1 }, { id: 'usd', priority: 2 }]);
  assert.equal((await hub.createPayment(order())).attempt.gateway, 'old');
  const r = await hub.createPayment(order({ currency: 'USD', amount: 1999 }));
  assert.equal(r.attempt.gateway, 'usd'); // cổng cũ có ưu tiên cao hơn nhưng không khai USD nên bị bỏ qua
  assert.equal(r.payment.currency, 'USD');
  assert.equal(usd.created[0].currency, 'USD');
  assert.equal(usd.created[0].amount, 1999);
});

test('routing: không cổng nào nhận loại tiền đó thì không có cổng; cấu hình hub.gateways[].currencies ghi đè khai báo', async () => {
  const old = fake('old', {});
  const hub = hubOf({ old }, [{ id: 'old' }]);
  await assert.rejects(hub.createPayment(order({ currency: 'USD', amount: 100 })), (e) => e.code === 'no_gateway_available');
  const hub2 = hubOf({ old }, [{ id: 'old', currencies: ['VND', 'USD'] }]);
  assert.equal((await hub2.createPayment(order({ currency: 'USD', amount: 100 }))).attempt.gateway, 'old');
  assert.throws(() => routing.validateGateways([{ id: 'old', currencies: ['XYZ'] }], { old }), /currencies/);
});

test('tạo payment: loại tiền lạ bị từ chối; số tiền phải là số nguyên đơn vị nhỏ nhất; cùng đơn khác loại tiền là xung đột', async () => {
  const a = fake('a', { currencies: ['VND', 'USD'] });
  const hub = hubOf({ a }, [{ id: 'a' }]);
  await assert.rejects(hub.createPayment(order({ currency: 'XYZ' })), (e) => e.code === 'invalid_input' && /currency/.test(e.message));
  await assert.rejects(hub.createPayment(order({ currency: 'USD', amount: 19.99 })), (e) => e.code === 'invalid_input' && /đơn vị nhỏ nhất của USD/.test(e.message));
  await assert.rejects(hub.createPayment(order({ amount: 1.5 })), (e) => e.code === 'invalid_input' && /số nguyên VND/.test(e.message)); // lời nhắn cũ cho VND giữ nguyên
  const o = order({ amount: 1000 });
  await hub.createPayment(o);
  await assert.rejects(hub.createPayment({ ...o, currency: 'USD' }), (e) => e.code === 'order_conflict');
  assert.equal((await hub.createPayment(o)).existing, true); // gọi lại đúng như cũ vẫn idempotent
});

test('thông báo thành công khác loại tiền của payment: amount_mismatch, không đổi trạng thái', async () => {
  const a = fake('a', { currencies: ['USD'] });
  const hub = hubOf({ a }, [{ id: 'a' }]);
  const { payment, attempt } = await hub.createPayment(order({ currency: 'USD', amount: 1999 }));
  const r = await cb('a', hub, { ref: attempt.ref, type: 'succeeded', amount: 1999, txn: 'T1', currency: 'VND' });
  assert.equal(r.outcome, 'amount_mismatch');
  assert.equal(payment.status, 'OPEN');
  const ok = await cb('a', hub, { ref: attempt.ref, type: 'succeeded', amount: 1999, txn: 'T1', currency: 'USD' });
  assert.equal(ok.outcome, 'ok');
  assert.equal(payment.status, 'PAID');
});

test('bốn adapter nội địa khai VND và nước VN; Stripe và PayPal khai loại tiền quốc tế, nước không giới hạn (PayPal không nhận VND), và không adapter nào khai loại tiền mà lõi không biết', () => {
  const { discover } = require('../../src/adapters/registry');
  const { CURRENCY_EXPONENT } = require('../../src/contract');
  const mods = [...discover().values()];
  assert.ok(mods.length >= 6);
  const cfgFor = (id) => (id === 'sepay' ? { accountNumber: '1', bankName: 'B' } : id === 'stripe' ? { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' } : id === 'paypal' ? { clientId: 'c', clientSecret: 's', webhookId: 'w' } : { tmnCode: 't', hashSecret: 's', partnerCode: 'p', accessKey: 'a', secretKey: 's', merchant: 'm', accessCode: 'c', hashKeyHex: '00', queryUser: 'u', queryPassword: 'p', ipnUrl: 'https://x/ipn' });
  for (const m of mods) {
    const a = m.create(cfgFor(m.id), { fetch: async () => { throw new Error('no net'); }, publicBaseUrl: 'https://x' });
    const caps = a.capabilities();
    assert.ok(caps.currencies.every((c) => Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, c)), m.id);
    if (m.id === 'stripe') {
      assert.ok(caps.currencies.includes('USD') && caps.currencies.includes('VND'));
      assert.deepEqual(caps.regions, ['*']);
    } else if (m.id === 'paypal') {
      assert.ok(caps.currencies.includes('USD'));
      assert.equal(caps.currencies.includes('VND'), false, 'PayPal không hỗ trợ VND');
      assert.deepEqual(caps.regions, ['*']);
    } else {
      assert.deepEqual(caps.currencies, ['VND'], m.id);
      assert.deepEqual(caps.regions, ['VN'], m.id);
    }
  }
});

// ---- extra: tham số riêng của cổng, đi qua một cửa có khai báo (PHUB-D-016) ----
test('extraSchema được kiểm khi khai: kiểu lạ bị từ chối', () => {
  assert.equal(assertAdapterShape(fake('a', { extraSchema: { locale: 'string', retries: 'number', test: 'boolean' } })), true);
  assert.throws(() => assertAdapterShape(fake('b', { extraSchema: { x: 'object' } })), /extraSchema/);
  assert.throws(() => assertAdapterShape(fake('b', { extraSchema: ['x'] })), /extraSchema/);
});

test('extra: chỉ phần của cổng được chọn đến adapter; lõi lưu nhưng không đọc giá trị', async () => {
  const a = fake('a', { extraSchema: { locale: 'string' } });
  const b = fake('b', { extraSchema: { brand: 'string' }, currencies: ['VND'] });
  const hub = hubOf({ a, b }, [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }]);
  const r = await hub.createPayment(order({ extra: { a: { locale: 'vi' }, b: { brand: 'BSN' } } }));
  assert.equal(r.attempt.gateway, 'a');
  assert.deepEqual(a.created[0].extra, { locale: 'vi' }); // phần của b không rò sang a
  const r2 = await hub.createPayment(order());
  assert.equal('extra' in a.created[1], false); // không khai thì adapter không nhận trường extra
  assert.equal(r2.payment.extra, null);
});

test('extra: cổng lạ, khóa lạ, sai kiểu, adapter không khai schema đều bị từ chối ngay, không bỏ qua im lặng', async () => {
  const a = fake('a', { extraSchema: { locale: 'string', retries: 'number' } });
  const c = fake('c', {}); // không khai extraSchema: không nhận extra nào
  const hub = hubOf({ a, c }, [{ id: 'a', priority: 1 }, { id: 'c', priority: 2 }]);
  const bad = (extra, re) => assert.rejects(hub.createPayment(order({ extra })), (e) => e.code === 'invalid_input' && re.test(e.message));
  await bad({ zzz: { x: 1 } }, /không có cổng này/);
  await bad({ a: { locael: 'vi' } }, /khóa "locael" không nằm trong extraSchema/); // gõ sai tên khóa
  await bad({ a: { locale: 5 } }, /phải là string/);
  await bad({ a: { retries: NaN } }, /phải là number/);
  await bad({ c: { anything: 1 } }, /không nằm trong extraSchema/);
  await bad(['a'], /extra phải là đối tượng/);
  await bad({ a: 'vi' }, /phải là đối tượng/);
  assert.equal(a.created.length, 0); // bị từ chối trước khi tạo giao dịch ở cổng
});

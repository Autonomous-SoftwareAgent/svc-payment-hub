'use strict';
// spec: PHUB-S-029
// Routing là module riêng (src/routing.js) và chọn theo phương án thanh toán chuẩn (PHUB-D-029): cửa hàng nói "tôi cần ví" hoặc "thẻ quốc tế",
// routing chỉ chọn cổng phục vụ phương án đó, không cần biết tên cổng; operator chỉnh phương án mỗi mục bằng cấu hình.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { METHODS, assertAdapterShape } = require('../../src/contract');
const routing = require('../../src/routing');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { createApp } = require('../../src/app/app');
const { operations } = require('../../src/app/operations');

const fake = (id, methods, extra = {}) => createFakeAdapter(id, { caps: methods === undefined ? {} : { methods }, ...extra });
const hubOf = (adapters, gateways, extra = {}) => new PaymentHub({ adapters, clock: createClock(), config: { gateways, ...extra } });
const order = (o = {}) => ({ orderId: `O${Math.random().toString(36).slice(2, 8)}`, amount: 100000, returnUrl: 'https://s/r', ...o });

test('chọn theo phương án: ví đi cổng ví, thẻ nội địa và QR đi cổng khác, phương án không cổng nào phục vụ thì không có cổng', async () => {
  const a = fake('a', ['wallet']);
  const b = fake('b', ['card_domestic', 'qr']);
  const hub = hubOf({ a, b }, [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }]);
  assert.equal((await hub.createPayment(order({ method: 'wallet' }))).attempt.gateway, 'a');
  assert.equal((await hub.createPayment(order({ method: 'card_domestic' }))).attempt.gateway, 'b');
  assert.equal((await hub.createPayment(order({ method: 'qr' }))).attempt.gateway, 'b');
  await assert.rejects(hub.createPayment(order({ method: 'bank_transfer' })), (e) => e.code === 'no_gateway_available');
  // payment lưu phương án đã yêu cầu
  const { payment } = await hub.createPayment(order({ method: 'wallet' }));
  assert.equal(payment.method, 'wallet');
});

test('không đòi phương án thì routing giữ nguyên như cũ (theo ưu tiên), kể cả adapter không khai phương án', async () => {
  const a = fake('a', undefined); // adapter cũ, không khai methods
  const b = fake('b', ['wallet']);
  const hub = hubOf({ a, b }, [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }]);
  const r = await hub.createPayment(order());
  assert.equal(r.attempt.gateway, 'a');
  assert.equal(r.payment.method, null);
  // đòi phương án thì adapter không khai không đủ điều kiện
  assert.equal((await hub.createPayment(order({ method: 'wallet' }))).attempt.gateway, 'b');
});

test('cấu hình hub.gateways[].methods ghi đè khai báo của adapter (operator chỉnh, không sửa code)', async () => {
  const a = fake('a', ['wallet']);
  const b = fake('b', ['wallet']);
  // a bị khai là chỉ phục vụ thẻ quốc tế; b giữ ví
  const hub = hubOf({ a, b }, [{ id: 'a', priority: 1, methods: ['card_international'] }, { id: 'b', priority: 2 }]);
  assert.equal((await hub.createPayment(order({ method: 'wallet' }))).attempt.gateway, 'b', 'a bị ghi đè nên không còn phục vụ ví');
  assert.equal((await hub.createPayment(order({ method: 'card_international' }))).attempt.gateway, 'a');
  // methods rỗng: mục không nhận payment nào có đòi phương án
  const hub2 = hubOf({ a, b }, [{ id: 'a', priority: 1, methods: [] }, { id: 'b', priority: 2, methods: ['wallet'] }]);
  assert.equal((await hub2.createPayment(order({ method: 'wallet' }))).attempt.gateway, 'b');
});

test('cùng một cổng nhiều mục adapterProduct: mỗi sản phẩm một phương án, phương án chọn đúng sản phẩm (kiểu OnePAY nội địa và quốc tế)', async () => {
  const op = createFakeAdapter('op');
  op.capabilities = (product) => ({ hardExpiry: 'unknown', cancellable: false, queryable: true, refundable: 'manual', refundAsync: true, createCanTimeout: false, methods: product === 'INTL' ? ['card_international'] : ['card_domestic'] });
  const hub = hubOf({ op }, [{ id: 'op', adapterProduct: 'DOM', priority: 1 }, { id: 'op', adapterProduct: 'INTL', priority: 2 }]);
  const dom = await hub.createPayment(order({ method: 'card_domestic' }));
  assert.equal(dom.attempt.product, 'DOM');
  const intl = await hub.createPayment(order({ method: 'card_international' }));
  assert.equal(intl.attempt.product, 'INTL', 'chọn đúng sản phẩm của adapter theo phương án');
  assert.deepEqual(op.created.map((c) => c.product), ['DOM', 'INTL']);
});

test('failover giữ nguyên phương án đã yêu cầu: chỉ chuyển sang cổng khác cũng phục vụ phương án đó', async () => {
  const a = fake('a', ['wallet']);
  const b = fake('b', ['card_domestic']);
  const c = fake('c', ['wallet']);
  const hub = hubOf({ a, b, c }, [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }, { id: 'c', priority: 3 }], { failover: { enabled: true, maxAttempts: 4 } });
  const { payment, attempt } = await hub.createPayment(order({ method: 'wallet' }));
  assert.equal(attempt.gateway, 'a');
  await hub.handleCallback('a', { channel: 'ipn', method: 'GET', query: {}, body: { ref: attempt.ref, type: 'failed', amount: attempt.amount, txn: 'F', source: 'ipn' }, headers: {} });
  const next = await hub.createAttempt(payment.id, { reason: 'failover' });
  assert.equal(next.attempt.gateway, 'c', 'b không phục vụ ví nên bị bỏ qua dù ưu tiên cao hơn c');
});

test('phương án sai bị từ chối ở cả ba chỗ: yêu cầu tạo, cấu hình routing, và khai báo năng lực của adapter', () => {
  const a = fake('a', ['wallet']);
  const hub = hubOf({ a }, [{ id: 'a' }]);
  return Promise.all([
    assert.rejects(hub.createPayment(order({ method: 'tien-mat' })), (e) => e.code === 'invalid_input' && /method phải là một trong/.test(e.message)),
  ]).then(() => {
    assert.throws(() => hubOf({ a }, [{ id: 'a', methods: ['tien-mat'] }]), /a\.methods phải là danh sách trong/);
    assert.throws(() => hubOf({ a }, [{ id: 'a', methods: 'wallet' }]), /a\.methods phải là danh sách/);
    const bad = createFakeAdapter('bad', { caps: { methods: ['tien-mat'] } });
    assert.throws(() => assertAdapterShape(bad), /capabilities\.methods phải là danh sách trong/);
    assert.throws(() => new PaymentHub({ adapters: { bad }, config: { gateways: [{ id: 'bad' }] } }), /capabilities\.methods/);
    assert.doesNotThrow(() => assertAdapterShape(fake('ok', [])));
  });
});

test('module routing độc lập: hàm thuần trên cấu hình và khai báo năng lực, không cần Hub', () => {
  const adapters = { x: { capabilities: () => ({ methods: ['qr'] }) }, y: { capabilities: () => ({ methods: ['wallet'] }) } };
  const gateways = [{ id: 'y', priority: 2 }, { id: 'x', priority: 1 }, { id: 'z', priority: 0 }]; // z không có adapter
  const pay = (o) => ({ product: 'default', amount: 1000, ...o });
  const keys = (list) => list.map(routing.routeKey);
  assert.deepEqual(keys(routing.candidates({ gateways, adapters, payment: pay({}), exclude: [], isAvailable: () => true })), ['x', 'y']);
  assert.deepEqual(keys(routing.candidates({ gateways, adapters, payment: pay({ method: 'wallet' }), exclude: [], isAvailable: () => true })), ['y']);
  assert.deepEqual(keys(routing.candidates({ gateways, adapters, payment: pay({}), exclude: ['x'], isAvailable: () => true })), ['y'], 'ưu tiên mục chưa thử');
  assert.deepEqual(keys(routing.candidates({ gateways, adapters, payment: pay({}), exclude: [], isAvailable: (id) => id !== 'x' })), ['y'], 'bỏ qua cổng đang mở breaker');
  assert.deepEqual(routing.methodsOf({ id: 'x' }, { x: { capabilities: () => { throw new Error('product lạ'); } } }, pay({})), [], 'adapter không biết product: không phục vụ phương án nào');
  assert.deepEqual(routing.methodsOf({ id: 'x', methods: ['qr'] }, {}, pay({})), ['qr'], 'cấu hình thắng, không cần adapter');
});

test('thao tác createPayment nhận method trong danh mục chuẩn, trả lại trong payment, và từ chối giá trị lạ; danh sách khớp contract.METHODS', async () => {
  const hub = hubOf({ a: fake('a', ['wallet']) }, [{ id: 'a' }]);
  const app = createApp({ hub });
  const admin = { role: 'admin' };
  const ok = await app.execute('createPayment', { orderId: 'OP1', amount: 100000, returnUrl: 'https://s/r', method: 'wallet' }, admin);
  assert.equal(ok.payment.method, 'wallet');
  await assert.rejects(app.execute('createPayment', { orderId: 'OP2', amount: 100000, returnUrl: 'https://s/r', method: 'tien-mat' }, admin), (e) => e.code === 'invalid_input');
  assert.deepEqual(operations.createPayment.input.properties.method.enum, METHODS, 'danh sách ở app/ phải khớp contract.METHODS');
});

test('bốn adapter thật khai báo phương án hợp lệ cho từng sản phẩm, đúng như tài liệu thiết kế', () => {
  const { createVnpayAdapter } = require('../../src/adapters/vnpay');
  const { createMomoAdapter } = require('../../src/adapters/momo');
  const { createOnepayAdapter } = require('../../src/adapters/onepay');
  const { createSepayAdapter } = require('../../src/adapters/sepay');
  const vn = createVnpayAdapter({ tmnCode: 'T', hashSecret: 'S' });
  const mo = createMomoAdapter({ partnerCode: 'P', accessKey: 'a', secretKey: 's' });
  const op = createOnepayAdapter({ merchant: 'M', accessCode: 'A', hashKeyHex: '00112233445566778899AABBCCDDEEFF', queryUser: 'u', queryPassword: 'p' });
  const sp = createSepayAdapter({ accountNumber: '1', bankName: 'B', va: { bankAccountId: 'x' }, pg: { merchantId: 'm', secretKey: 's' } });
  for (const adapter of [vn, mo, op, sp]) assertAdapterShape(adapter);
  assert.deepEqual(vn.capabilities().methods, ['card_domestic', 'qr']);
  assert.deepEqual(mo.capabilities().methods, ['wallet']);
  assert.deepEqual(op.capabilities('DOMESTIC').methods, ['card_domestic']);
  assert.deepEqual(op.capabilities('INTERNATIONAL').methods, ['card_international']);
  assert.deepEqual(op.capabilities('QR').methods, ['qr']);
  assert.deepEqual(op.capabilities('khong-co').methods, [], 'sản phẩm lạ: không khai');
  assert.deepEqual(sp.capabilities('qr-static').methods, ['bank_transfer']);
  assert.deepEqual(sp.capabilities('va-order').methods, ['virtual_account']);
  assert.deepEqual(sp.capabilities('gateway').methods, ['card_international', 'qr', 'bank_transfer']);
});

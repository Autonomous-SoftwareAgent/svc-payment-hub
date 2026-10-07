'use strict';
// spec: SEPY-S-006
// Một adapter, ba sản phẩm chọn theo product (SEPY-D-006): bật theo cấu hình, định tuyến callback theo hình dạng, đối soát chung.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertAdapterShape, assertEvent } = require('../../src/contract.js');
const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
const { setupProducts, CREDS } = require('./helpers.js');

const pgCfg = { merchantId: 'M1', secretKey: 'S1' };
const vaCfg = { bankAccountId: 'ba-1' };

test('bật sản phẩm theo cấu hình; default dùng defaultProduct; product chưa cấu hình bị từ chối khi tạo', async () => {
  const onlyA = createSepayAdapter({ ...CREDS, authMode: 'none' }, {});
  assert.equal(onlyA.capabilities('default').hardExpiry, 'none');
  assert.equal((await onlyA.createPayment({ product: 'va-order', attemptRef: 'BSNX000001', amount: 1000 })).status, 'rejected');
  assert.equal((await onlyA.createPayment({ product: 'gateway', attemptRef: 'BSNX000001', amount: 1000 })).status, 'rejected');
  assert.equal((await onlyA.createPayment({ product: 'default', attemptRef: 'BSNX000001', amount: 1000, orderInfo: 'x' })).status, 'instructions');
  assert.equal((await onlyA.createPayment({ attemptRef: 'BSNX000001', amount: 1000, orderInfo: 'x' })).status, 'instructions');
  assert.equal(onlyA.cancel, undefined);
  assert.equal(typeof onlyA.reconcileFeed, 'function');

  // chỉ C (không accountNumber): không có A, không có feed; default là C
  const onlyC = createSepayAdapter({ pg: pgCfg, authMode: 'none' }, {});
  assert.equal(assertAdapterShape(onlyC), true);
  assert.equal(onlyC.capabilities('default').hardExpiry, 'unknown');
  assert.equal(onlyC.reconcileFeed, undefined);
  assert.equal((await onlyC.createPayment({ product: 'qr-static', attemptRef: 'BSNX000001', amount: 1000 })).status, 'rejected');
  assert.equal((await onlyC.createPayment({ attemptRef: 'BSNX000001', amount: 1000, orderInfo: 'x', returnUrl: 'https://s.test/r' })).status, 'redirect');
  assert.deepEqual(await onlyC.query({ product: 'va-order', attemptRef: 'BSNX000001' }), { state: 'unknown' });

  // B + C, A tắt (không accountNumber)
  const bc = createSepayAdapter({ va: vaCfg, pg: pgCfg, authMode: 'none' }, {});
  assert.equal(bc.capabilities('default').cancellable, true);
  assert.equal((await bc.createPayment({ product: 'qr-static', attemptRef: 'BSNX000001', amount: 1000 })).status, 'rejected');

  // defaultProduct chọn rõ
  const dflt = createSepayAdapter({ ...CREDS, authMode: 'none', va: vaCfg, pg: pgCfg, defaultProduct: 'gateway' }, {});
  assert.equal(dflt.capabilities('default').hardExpiry, 'unknown');
  assert.equal(dflt.capabilities('qr-static').hardExpiry, 'none');
  assert.equal(dflt.capabilities('va-order').createCanTimeout, true);
});

test('cấu hình sai dừng ngay khi dựng adapter', () => {
  assert.throws(() => createSepayAdapter({ va: {} }, {}), /bankAccountId/);
  assert.throws(() => createSepayAdapter({ pg: { merchantId: 'x' } }, {}), /secretKey/);
  assert.throws(() => createSepayAdapter({ ...CREDS, defaultProduct: 'gateway' }, {}), /defaultProduct/);
});

test('capabilities khác nhau theo product và đều qua assertAdapterShape', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', pg: true });
  try {
    assert.equal(assertAdapterShape(t.adapter), true);
    const a = t.adapter.capabilities('qr-static'); const b = t.adapter.capabilities('va-order'); const c = t.adapter.capabilities('gateway');
    assert.deepEqual([a.cancellable, b.cancellable, c.cancellable], [false, true, true]);
    assert.deepEqual([a.createCanTimeout, b.createCanTimeout, c.createCanTimeout], [false, true, false]);
    assert.deepEqual([a.hardExpiry, b.hardExpiry, c.hardExpiry], ['none', 'none', 'unknown']);
    assert.equal(t.adapter.capabilities('khong-co').hardExpiry, 'none', 'product lạ: lùi về sản phẩm mặc định, createPayment sẽ từ chối');
  } finally { await t.teardown(); }
});

test('định tuyến callback: webhook biến động số dư, IPN của cổng, return; mỗi loại đi đúng đường xác thực của nó', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', pg: true, authMode: 'apikey' });
  try {
    // webhook ngân hàng cần Apikey; IPN cổng cần X-Secret-Key: không lẫn
    const bank = { id: 1, gateway: 'x', transactionDate: '2026-10-02 10:00:00', accountNumber: '1', subAccount: '', code: 'BSNAAA1', content: 'BSNAAA1', transferType: 'in', description: '', transferAmount: 5, accumulated: 0, referenceCode: 'FT1' };
    assert.equal(t.adapter.parseCallback({ channel: 'ipn', headers: {}, body: bank }).valid, false);
    const okBank = await t.adapter.parseCallback({ channel: 'ipn', headers: { authorization: `Apikey ${CREDS.apiKey}` }, body: bank });
    assert.equal(okBank.event.attemptRef, 'BSNAAA1');
    const ipn = { notification_type: 'ORDER_PAID', order: { order_invoice_number: 'BSNGGG1', order_status: 'CAPTURED', order_amount: '5.00' }, transaction: { transaction_id: 'T', transaction_type: 'PAYMENT', transaction_status: 'APPROVED', transaction_amount: '5' } };
    assert.equal(t.adapter.parseCallback({ channel: 'ipn', headers: { authorization: `Apikey ${CREDS.apiKey}` }, body: ipn }).valid, false, 'Apikey của webhook ngân hàng không thay được X-Secret-Key');
    assert.equal(t.adapter.parseCallback({ channel: 'ipn', headers: { 'x-secret-key': 'test-pg-secret-not-real' }, body: ipn }).event.attemptRef, 'BSNGGG1');
    assert.equal(t.adapter.parseCallback({ channel: 'return', query: { ref: 'BSNGGG1', r: 'cancel' }, headers: {} }).event.source, 'return');
    // thân dạng chuỗi JSON (rawBody) cũng được nhận diện
    const raw = JSON.stringify(ipn);
    assert.equal(t.adapter.parseCallback({ channel: 'ipn', headers: { 'x-secret-key': 'test-pg-secret-not-real' }, body: raw, rawBody: raw }).valid, true);
  } finally { await t.teardown(); }
  // chỉ cấu hình C: webhook biến động số dư không có chỗ xử lý
  const onlyC = createSepayAdapter({ pg: pgCfg, authMode: 'none' }, {});
  const r = onlyC.parseCallback({ channel: 'ipn', headers: {}, body: { id: 1, transferType: 'in', transferAmount: 5 } });
  assert.equal(r.valid, false); assert.equal(r.reason, 'bank_webhook_not_configured');
  assert.equal(r.ack('invalid_signature').status, 401);
  // không cấu hình C: một thân có notification_type đi vào đường ngân hàng và bị từ chối
  const noC = createSepayAdapter({ ...CREDS, authMode: 'none' }, {});
  assert.equal(noC.parseCallback({ channel: 'ipn', headers: {}, body: { notification_type: 'ORDER_PAID', order: {}, transaction: {} } }).valid, false);
});

test('A và B cùng một tài khoản: một reconcileFeed phân giải đúng từng hàng (VA cho B, mã trong nội dung cho A, còn lại unmatched)', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', controls: { webhook_drop: true } });
  try {
    const b = await t.va('BSNVAROW001', 100000);
    const a = await t.adapter.createPayment({ product: 'qr-static', attemptRef: 'BSNQRROW001', amount: 50000, orderInfo: 'x' });
    assert.equal(a.status, 'instructions');
    await t.toVa(b, 100000);
    await t.sim.transfer({ content: a.instructions.transferContent, amount: 50000 });
    await t.sim.transfer({ content: 'khong ro', amount: 7000 });
    const feed = await t.newAdapter().reconcileFeed({ now: 0 });
    feed.events.forEach(assertEvent);
    assert.deepEqual(feed.events.map((e) => e.attemptRef), ['BSNVAROW001', 'BSNQRROW001', null]);
    assert.equal(feed.events[2].unmatched, true);
    // query theo từng product
    const qa = await t.adapter.query({ product: 'qr-static', attemptRef: 'BSNQRROW001' });
    assert.equal(qa[0].amount, 50000);
    const qb = await t.adapter.query({ product: 'va-order', attemptRef: 'BSNVAROW001', createdAt: t.sim.clock.now() - 1000 });
    assert.equal(qb[0].amount, 100000);
    // hỏi nhầm product: không lẫn đơn
    assert.deepEqual(await t.adapter.query({ product: 'qr-static', attemptRef: 'BSNVAROW001' }), { state: 'not_found' });
  } finally { await t.teardown(); }
});

test('hủy: dò đúng sản phẩm (B hoặc C) theo mã; A không hủy được', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', pg: true });
  try {
    const b = await t.va('BSNCANVA001', 1000);
    assert.equal(b.status, 'instructions');
    const c = await t.adapter.createPayment({ product: 'gateway', attemptRef: 'BSNCANPG001', amount: 1000, orderInfo: 'x', returnUrl: 'x' });
    await fetch(c.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(c.fields).toString(), redirect: 'manual' });
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCANPG001' }), { cancelled: true });
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCANVA001' }), { cancelled: true });
    assert.deepEqual(await t.newAdapter().cancel({ attemptRef: 'BSNCANVA001' }), { cancelled: false }, 'không gợi ý (sau khởi động lại): thử B rồi C, đơn đã hủy nên không hủy được nữa');
    const qr = await t.adapter.createPayment({ product: 'qr-static', attemptRef: 'BSNCANQR001', amount: 1000, orderInfo: 'x' });
    assert.equal(qr.status, 'instructions');
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCANQR001' }), { cancelled: false });
  } finally { await t.teardown(); }
});

test('hoàn tiền qua API cũng dùng được cho sản phẩm A (cùng endpoint theo giao dịch), mặc định vẫn manual', async () => {
  const t = await setupProducts({ adapterConfig: { refundApi: true } });
  try {
    assert.equal(t.adapter.capabilities('qr-static').refundable, 'api');
    const a = await t.adapter.createPayment({ product: 'qr-static', attemptRef: 'BSNREFQR001', amount: 20000, orderInfo: 'x' });
    const tx = (await t.call('POST', '/sim/transfer', { content: a.instructions.transferContent, amount: 20000 })).json.transaction;
    const r = await t.adapter.refund({ attemptRef: 'BSNREFQR001', refundRef: 'RFQR01', amount: 20000, gatewayTxnId: tx.referenceCode });
    assert.deepEqual(r, { status: 'processing' });
    assert.equal(t.sim.state.refunds[0].tx, tx.id);
  } finally { await t.teardown(); }
  const off = createSepayAdapter({ ...CREDS, authMode: 'none' }, {});
  assert.equal(off.capabilities('qr-static').refundable, 'manual');
});

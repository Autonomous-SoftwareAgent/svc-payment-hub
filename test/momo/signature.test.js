'use strict';
// spec: MOMO-S-001
const test = require('node:test');
const assert = require('node:assert/strict');
const { hmac } = require('./helpers.js');
const { createMomoAdapter } = require('../../src/adapters/momo/index.js');
const { SIGN_FIELDS } = require('../../tools/sim/momo/server.js');

const SECRET = 'test-secret-key-do-not-use';
const ACCESS = 'test-access-key';
const PARTNER = 'MOMOTEST01';

// Vector của nikki-erp (signature_test.go), bộ trường IPN 13 trường.
const genuine = () => ({
  partnerCode: PARTNER, orderId: 'ORD1234ABCD5', requestId: 'req-0001', amount: 150000, orderInfo: 'Test payment',
  orderType: 'momo_wallet', transId: 2147483647, resultCode: 0, message: 'Successful.', payType: 'qr',
  responseTime: 1755400000000, extraData: '',
  signature: 'c6c8e1c0dfbc246057d7a0cb6917a78399f919638af7c6c12c24af96fd47823a',
});
const adapter = () => createMomoAdapter({ partnerCode: PARTNER, accessKey: ACCESS, secretKey: SECRET, ipnUrl: 'x' });

test('IPN: tính độc lập bằng crypto khớp vector nikki-erp', () => {
  const p = genuine();
  const raw = `accessKey=${ACCESS}&amount=${p.amount}&extraData=&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}` +
    `&orderType=${p.orderType}&partnerCode=${p.partnerCode}&payType=${p.payType}&requestId=${p.requestId}` +
    `&responseTime=${p.responseTime}&resultCode=${p.resultCode}&transId=${p.transId}`;
  assert.equal(hmac(SECRET, raw), p.signature);
});

test('IPN: parseCallback chấp nhận vector thật, chữ hoa cũng được', () => {
  const r = adapter().parseCallback({ channel: 'ipn', method: 'POST', query: {}, body: genuine(), headers: {} });
  assert.equal(r.valid, true);
  assert.equal(r.event.type, 'succeeded');
  assert.equal(r.event.amount, 150000);
  assert.equal(r.event.gatewayTxnId, '2147483647');
  const up = { ...genuine() }; up.signature = up.signature.toUpperCase();
  assert.equal(adapter().parseCallback({ channel: 'ipn', method: 'POST', query: {}, body: up, headers: {} }).valid, true);
});

test('IPN: sửa bất kỳ trường nào cũng làm chữ ký sai', () => {
  const mutate = { amount: 999999, resultCode: 1, orderId: 'OTHER', transId: 1, signature: '00', message: 'x', payType: 'card' };
  for (const [k, v] of Object.entries(mutate)) {
    const p = { ...genuine(), [k]: v };
    assert.equal(adapter().parseCallback({ channel: 'ipn', method: 'POST', query: {}, body: p, headers: {} }).valid, false, k);
  }
});

test('create: chữ ký theo thứ tự khóa (vector nikki-erp)', () => {
  const raw = 'accessKey=test-access-key&amount=150000&extraData=&ipnUrl=https://example.test/v1/paymentinvoice/webhooks/momo' +
    '&orderId=ORD1234ABCD5&orderInfo=Test payment&partnerCode=MOMOTEST01&redirectUrl=https://example.test/done&requestId=req-0001&requestType=captureWallet';
  assert.equal(hmac(SECRET, raw), 'a6b49a43bd9ab22bdd498edb437f367e1fa6e518b1f9212f9c970d7dddb87495');
  assert.deepEqual(SIGN_FIELDS.create, [...SIGN_FIELDS.create].sort());
});

test('adapter ký create đúng thứ tự: simulator (độc lập) chấp nhận', async () => {
  const { setup } = require('./helpers.js');
  const h = await setup();
  try {
    const r = await h.create('SIGN-OK-1');
    assert.equal(r.status, 'redirect');
  } finally { await h.teardown(); }
});

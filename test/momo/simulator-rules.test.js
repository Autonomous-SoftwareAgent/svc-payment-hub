'use strict';
// spec: MOMO-S-002
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, CREDS } = require('./helpers.js');

function createBody(over = {}) {
  const b = {
    partnerCode: CREDS.partnerCode, requestType: 'captureWallet', ipnUrl: 'http://127.0.0.1:1/ipn', redirectUrl: 'http://127.0.0.1/r',
    orderId: 'RULE' + Math.random().toString(36).slice(2, 10), amount: '1000', orderInfo: 'bsn', requestId: crypto.randomUUID(), extraData: '', lang: 'en', ...over,
  };
  if (over.signature === undefined) {
    const f = ['accessKey', 'amount', 'extraData', 'ipnUrl', 'orderId', 'orderInfo', 'partnerCode', 'redirectUrl', 'requestId', 'requestType'];
    const src = { ...b, accessKey: CREDS.accessKey };
    b.signature = crypto.createHmac('sha256', CREDS.secretKey).update(f.map((k) => `${k}=${src[k]}`).join('&')).digest('hex');
  }
  return b;
}

test('quy tắc tham số create giống probe thật', async () => {
  const h = await setup();
  try {
    const P = '/v2/gateway/api/create';
    // A1: GET -> 405 resultCode 20
    let r = await h.call('GET', P); assert.equal(r.status, 405); assert.equal(r.json.resultCode, 20);
    // A2: body rỗng -> 400, 20
    r = await h.call('POST', P, {}); assert.equal(r.status, 400); assert.equal(r.json.resultCode, 20); assert.ok(r.json.subErrors.length > 3);
    // A3: JSON hỏng
    const raw = await fetch(h.sim.url + P, { method: 'POST', body: '{oops' }); assert.equal(raw.status, 400);
    // A4: merchant sai -> 13 (HTTP 400)
    r = await h.call('POST', P, createBody({ partnerCode: 'FAKE', signature: '00' })); assert.equal(r.json.resultCode, 13); assert.equal(r.status, 400);
    // A9: amount "abc" -> 20 trước cả merchant
    r = await h.call('POST', P, createBody({ partnerCode: 'FAKE', amount: 'abc', signature: '00' })); assert.equal(r.json.resultCode, 20);
    // A10: amount 1 với merchant sai -> 13 (định dạng ổn, merchant kiểm trước khoảng tiền)
    r = await h.call('POST', P, createBody({ partnerCode: 'FAKE', amount: '1', signature: '00' })); assert.equal(r.json.resultCode, 13);
    // A11: requestType lạ -> 20
    r = await h.call('POST', P, createBody({ requestType: 'nope' })); assert.equal(r.json.resultCode, 20);
    // B7: chữ ký sai -> 11007, HTTP 400
    r = await h.call('POST', P, createBody({ signature: 'deadbeef' })); assert.equal(r.json.resultCode, 11007); assert.equal(r.status, 400);
    // B8, B9: khoảng tiền -> 22, HTTP 400
    r = await h.call('POST', P, createBody({ amount: '999' })); assert.equal(r.json.resultCode, 22); assert.equal(r.status, 400);
    r = await h.call('POST', P, createBody({ amount: '50000001' })); assert.equal(r.json.resultCode, 22);
    // 22 chỉ sau chữ ký: amount 999 với chữ ký sai -> 11007
    r = await h.call('POST', P, createBody({ amount: '999', signature: 'bad' })); assert.equal(r.json.resultCode, 11007);
    // B10: amount kiểu số được nhận (ký ở dạng chuỗi)
    const num = createBody(); num.amount = 1000;
    r = await h.call('POST', P, num); assert.equal(r.json.resultCode, 0); assert.equal(r.status, 200); assert.ok(r.json.payUrl);
    // B11: orderId sai regex -> 20; cho phép ":"
    r = await h.call('POST', P, createBody({ orderId: 'bad id!' })); assert.equal(r.json.resultCode, 20);
    r = await h.call('POST', P, createBody({ orderId: 'AB:12' })); assert.equal(r.json.resultCode, 0);
    // biên 1.000 và 50.000.000 hợp lệ
    r = await h.call('POST', P, createBody({ amount: '50000000' })); assert.equal(r.json.resultCode, 0);
  } finally { await h.teardown(); }
});

test('orderId trùng trả 41 HTTP 200 không có payUrl; requestId không bị ép duy nhất (B2, B3, B4)', async () => {
  const h = await setup();
  try {
    const P = '/v2/gateway/api/create';
    const first = createBody();
    let r = await h.call('POST', P, first); assert.equal(r.json.resultCode, 0);
    r = await h.call('POST', P, first); // gửi lại y hệt
    assert.equal(r.status, 200); assert.equal(r.json.resultCode, 41); assert.equal(r.json.payUrl, undefined);
    r = await h.call('POST', P, createBody({ orderId: first.orderId })); // requestId mới, orderId cũ
    assert.equal(r.json.resultCode, 41);
    r = await h.call('POST', P, createBody({ requestId: first.requestId })); // requestId cũ, orderId mới
    assert.equal(r.json.resultCode, 0);
  } finally { await h.teardown(); }
});

test('query: đơn lạ 1005, chưa trả 1000, lỗi chữ ký 11007; refund/confirm sai trạng thái trả 43', async () => {
  const h = await setup();
  try {
    const q = (orderId, sigOk = true) => {
      const b = { partnerCode: CREDS.partnerCode, requestId: 'Q1', orderId, lang: 'en' };
      const raw = `accessKey=${CREDS.accessKey}&orderId=${orderId}&partnerCode=${b.partnerCode}&requestId=Q1`;
      b.signature = sigOk ? crypto.createHmac('sha256', CREDS.secretKey).update(raw).digest('hex') : 'x';
      return h.call('POST', '/v2/gateway/api/query', b);
    };
    let r = await q('NOSUCH'); assert.equal(r.status, 200); assert.equal(r.json.resultCode, 1005);
    assert.equal(r.json.signature, undefined); // A11: phản hồi query không có chữ ký
    await h.create('QRY-1');
    r = await q('QRY-1'); assert.equal(r.json.resultCode, 1000); assert.equal(r.json.transId, 0);
    r = await q('QRY-1', false); assert.equal(r.status, 400); assert.equal(r.json.resultCode, 11007);
    // confirm khi không ở 9000 -> 43 (B14)
    const cb = { partnerCode: CREDS.partnerCode, requestId: 'C1', orderId: 'QRY-1', requestType: 'capture', amount: 150000, description: '' };
    const raw = `accessKey=${CREDS.accessKey}&amount=150000&description=&orderId=QRY-1&partnerCode=${cb.partnerCode}&requestId=C1&requestType=capture`;
    cb.signature = crypto.createHmac('sha256', CREDS.secretKey).update(raw).digest('hex');
    r = await h.call('POST', '/v2/gateway/api/confirm', cb); assert.equal(r.json.resultCode, 43); assert.equal(r.status, 200);
    // refund với transId không tồn tại -> 43 (B13)
    assert.equal((await h.adapter.refund({ attemptRef: 'QRY-1', refundRef: 'RF-X', amount: 1000, gatewayTxnId: '123' })).status, 'failed');
  } finally { await h.teardown(); }
});

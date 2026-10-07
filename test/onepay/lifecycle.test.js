'use strict';
// spec: OPAY-S-001, OPAY-S-002, OPAY-S-003
const test = require('node:test');
const assert = require('node:assert');
const { setup, post, open, createAndOpen, create, CFG, KEY } = require('./helpers.js');
const { assertEvent } = require('../../src/contract.js');
const { ACK_CONFIRM, mapCode } = require('../../src/adapters/onepay/index.js');
const { hmac, signString } = require('../../tools/sim/onepay/server.js');

const REF = 'ATT-0001';
const pay = (t, outcome, ref = REF) => post(t.sim, '/sim/pay', { merchTxnRef: ref, outcome });
const callbackFromReturn = (t, returnUrl) => t.adapter.parseCallback({
  channel: 'return', method: 'GET', query: Object.fromEntries(new URL(returnUrl).searchParams), body: '', headers: {},
});

test('thành công: create -> /sim/pay -> IPN tới merchant -> succeeded đúng amount; return cũng ra succeeded nhưng source=return', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    const r = await pay(t, 'success');
    assert.strictEqual(r.body.status, 'paid');
    assert.strictEqual(t.merchant.received.length, 1);
    const cb = t.merchant.received[0].result;
    assert.strictEqual(cb.valid, true);
    assertEvent(cb.event);
    assert.strictEqual(cb.event.type, 'succeeded');
    assert.strictEqual(cb.event.amount, 150000);
    assert.strictEqual(cb.event.attemptRef, REF);
    assert.strictEqual(cb.event.source, 'ipn');
    assert.ok(cb.event.gatewayTxnId);
    assert.strictEqual(cb.ack('ok').body, ACK_CONFIRM);
    const ret = await callbackFromReturn(t, r.body.returnUrl);
    assert.strictEqual(ret.valid, true);
    assert.strictEqual(ret.event.type, 'succeeded');
    assert.strictEqual(ret.event.source, 'return'); // A8: kênh quyết định source, không phải payload
    // IPN đã được ack nên không retry
    await post(t.sim, '/sim/clock/advance', { seconds: 3600 });
    assert.strictEqual(t.merchant.received.length, 1);
  } finally { await t.close(); }
});

test('thất bại và hủy: failed, cancelled (không có gatewayTxnId)', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter, { attemptRef: 'F1' });
    await createAndOpen(t.adapter, { attemptRef: 'C1' });
    await pay(t, 'failed', 'F1');
    await pay(t, 'cancel', 'C1');
    const byRef = Object.fromEntries(t.merchant.received.map((x) => [x.result.event.attemptRef, x.result.event]));
    assert.strictEqual(byRef.F1.type, 'failed');
    assert.strictEqual(byRef.C1.type, 'cancelled');
    assert.strictEqual(byRef.F1.gatewayTxnId, undefined);
    assert.strictEqual((await t.adapter.query({ attemptRef: 'F1', amount: 150000 })).type, 'failed');
    assert.strictEqual((await t.adapter.query({ attemptRef: 'C1', amount: 150000 })).type, 'cancelled');
  } finally { await t.close(); }
});

test('mapCode: 0 succeeded, 99 cancelled, 253 expired, 100 và 300 pending, còn lại failed', () => {
  assert.strictEqual(mapCode('0'), 'succeeded');
  assert.strictEqual(mapCode('99'), 'cancelled');
  assert.strictEqual(mapCode('253'), 'expired');
  assert.strictEqual(mapCode('100'), 'pending');
  assert.strictEqual(mapCode('300'), 'pending');
  for (const c of ['1', '3', '5', '7', '51', '999', 'abc']) assert.strictEqual(mapCode(c), 'failed');
});

test('query: invoice chưa trả -> pending (100) KHÔNG failed; sau khi trả -> succeeded; ref lạ -> not_found', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    const q1 = await t.adapter.query({ attemptRef: REF, amount: 150000 });
    assert.strictEqual(q1.type, 'pending');
    assert.strictEqual(q1.raw.vpc_TxnResponseCode, '100');
    assert.strictEqual(q1.source, 'query');
    assertEvent(q1);
    await pay(t, 'success');
    const q2 = await t.adapter.query({ attemptRef: REF });
    assert.strictEqual(q2.type, 'succeeded');
    assert.strictEqual(q2.amount, 150000);
    assert.ok(q2.gatewayTxnId);
    assert.deepStrictEqual(await t.adapter.query({ attemptRef: 'NOPE' }), { state: 'not_found' });
  } finally { await t.close(); }
});

test('query: mã 300 (ép bằng force_response_code) và 100 đều là pending, không failed', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/control', { merchTxnRef: REF, force_response_code: '300' });
    assert.strictEqual((await t.adapter.query({ attemptRef: REF, amount: 150000 })).type, 'pending');
    await post(t.sim, '/sim/control', { merchTxnRef: REF, force_response_code: '100' });
    assert.strictEqual((await t.adapter.query({ attemptRef: REF, amount: 150000 })).type, 'pending');
  } finally { await t.close(); }
});

test('mã 100/300 trong IPN và return cũng thành pending (không failed)', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/control', { force_response_code: '300' });
    const r = await pay(t, 'failed');
    const ipn = t.merchant.received[0].result;
    assert.strictEqual(ipn.valid, true);
    assert.strictEqual(ipn.event.type, 'pending');
    assert.strictEqual((await callbackFromReturn(t, r.body.returnUrl)).event.type, 'pending');
  } finally { await t.close(); }
});

test('hết hạn theo sản phẩm: DOMESTIC 30 phút, INTERNATIONAL 15 phút ảo, rồi query ra expired (253)', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter, { attemptRef: 'D1', product: 'DOMESTIC' });
    await createAndOpen(t.adapter, { attemptRef: 'I1', product: 'INTERNATIONAL' });
    await post(t.sim, '/sim/clock/advance', { seconds: 14 * 60 });
    assert.strictEqual((await t.adapter.query({ attemptRef: 'I1', amount: 150000 })).type, 'pending');
    await post(t.sim, '/sim/clock/advance', { seconds: 60 });
    assert.strictEqual((await t.adapter.query({ attemptRef: 'I1', amount: 150000 })).type, 'expired');
    assert.strictEqual((await t.adapter.query({ attemptRef: 'D1', amount: 150000 })).type, 'pending');
    await post(t.sim, '/sim/clock/advance', { seconds: 15 * 60 });
    const q = await t.adapter.query({ attemptRef: 'D1', amount: 150000 });
    assert.strictEqual(q.type, 'expired');
    assert.strictEqual(q.raw.vpc_TxnResponseCode, '253');
    // khớp capabilities
    assert.deepStrictEqual(t.adapter.capabilities('DOMESTIC').hardExpiry, { minutes: 30 });
    // trả sau hạn bị từ chối mặc định
    assert.strictEqual((await pay(t, 'success', 'D1')).status, 410);
  } finally { await t.close(); }
});

test('paid_after_expiry: tiền về sau hết hạn, query ra succeeded (tiền về muộn, A12 unverified)', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/clock/advance', { seconds: 31 * 60 });
    assert.strictEqual((await t.adapter.query({ attemptRef: REF, amount: 150000 })).type, 'expired');
    await post(t.sim, '/sim/control', { paid_after_expiry: true });
    const r = await pay(t, 'success');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.paidAfterExpiry, true);
    assert.strictEqual(t.merchant.received[0].result.event.type, 'succeeded');
    assert.strictEqual((await t.adapter.query({ attemptRef: REF })).type, 'succeeded');
  } finally { await t.close(); }
});

// ---------- kịch bản bất lợi ----------

test('IPN trùng (ipn_duplicate): hai lần cùng sự kiện, đều valid; ack duplicate vẫn confirm', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/control', { ipn_duplicate: true });
    await pay(t, 'success');
    assert.strictEqual(t.merchant.received.length, 2);
    const [a, b] = t.merchant.received.map((x) => x.result.event);
    assert.strictEqual(a.attemptRef, b.attemptRef);
    assert.strictEqual(a.gatewayTxnId, b.gatewayTxnId);
    assert.strictEqual(t.merchant.received[1].result.ack('duplicate').body, ACK_CONFIRM);
  } finally { await t.close(); }
});

test('IPN mất (ipn_drop): merchant không nhận gì, query vẫn ra succeeded; resend thủ công đến được', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/control', { ipn_drop: true });
    await pay(t, 'success');
    await post(t.sim, '/sim/clock/advance', { seconds: 3600 });
    assert.strictEqual(t.merchant.received.length, 0);
    assert.strictEqual((await t.adapter.query({ attemptRef: REF, amount: 150000 })).type, 'succeeded');
    const rs = await post(t.sim, `/sim/ipn/${REF}/resend`);
    assert.strictEqual(rs.body.acked, true);
    assert.strictEqual(t.merchant.received.length, 1);
  } finally { await t.close(); }
});

test('IPN trễ (ipn_delay_seconds): chỉ đến khi đồng hồ ảo chạy qua', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/control', { ipn_delay_seconds: 120 });
    await pay(t, 'success');
    assert.strictEqual(t.merchant.received.length, 0);
    await post(t.sim, '/sim/clock/advance', { seconds: 119 });
    assert.strictEqual(t.merchant.received.length, 0);
    await post(t.sim, '/sim/clock/advance', { seconds: 2 });
    assert.strictEqual(t.merchant.received.length, 1);
  } finally { await t.close(); }
});

test('IPN sai số tiền: chữ ký đúng, event.amount khác amount attempt để Hub cảnh báo', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/control', { ipn_wrong_amount: true });
    await pay(t, 'success');
    const cb = t.merchant.received[0].result;
    assert.strictEqual(cb.valid, true);
    assert.notStrictEqual(cb.event.amount, 150000);
    assert.strictEqual(cb.event.amount, 150100);
    assert.strictEqual(cb.ack('amount_mismatch').body, 'responsecode=0&desc=confirm-fail');
    // query là trọng tài: trả đúng số tiền thật
    assert.strictEqual((await t.adapter.query({ attemptRef: REF })).amount, 150000);
  } finally { await t.close(); }
});

test('IPN sai chữ ký: valid=false, không có event, kể cả khi mã là 0; sửa 1 trường cũng sai', async () => {
  const t = await setup({}, { outcome: (res) => (res.valid ? 'ok' : 'invalid_signature') });
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/control', { ipn_bad_signature: true, ipn_retry_max: 0 });
    const r = await pay(t, 'success');
    const cb = t.merchant.received[0].result;
    assert.strictEqual(cb.valid, false);
    assert.strictEqual(cb.event, undefined);
    assert.strictEqual(t.sim.state.ipnLog[0].acked, false);
    // trường bị sửa sau khi ký
    const q = Object.fromEntries(new URL(r.body.returnUrl).searchParams);
    assert.strictEqual((await t.adapter.parseCallback({ channel: 'return', query: q })).valid, true);
    for (const mut of [{ vpc_Amount: '100' }, { vpc_TxnResponseCode: '0', vpc_MerchTxnRef: 'OTHER' }, { vpc_SecureHash: '' }]) {
      assert.strictEqual(t.adapter.parseCallback({ channel: 'ipn', query: { ...q, ...mut } }).valid, false);
    }
    const noHash = { ...q }; delete noHash.vpc_SecureHash;
    assert.strictEqual(t.adapter.parseCallback({ channel: 'ipn', query: noHash }).valid, false);
    // thêm một vpc_* lạ không được ký cũng làm sai
    assert.strictEqual(t.adapter.parseCallback({ channel: 'ipn', query: { ...q, vpc_Extra: 'x' } }).valid, false);
  } finally { await t.close(); }
});

test('mã 7 vẫn phải kiểm hash (A23): hash sai thì valid=false', () => {
  const t = require('./helpers.js');
  const { createOnepayAdapter } = require('../../src/adapters/onepay/index.js');
  const a = createOnepayAdapter(t.CFG);
  const p = { vpc_Merchant: CFG.merchant, vpc_MerchTxnRef: 'X', vpc_Amount: '100000', vpc_TxnResponseCode: '7' };
  assert.strictEqual(a.parseCallback({ channel: 'ipn', query: { ...p, vpc_SecureHash: 'F'.repeat(64) } }).valid, false);
  assert.strictEqual(a.parseCallback({ channel: 'ipn', query: { ...p, vpc_SecureHash: hmac(signString(p), KEY) } }).event.type, 'failed');
});

test('IPN không được ack: simulator retry theo cấu hình (số lần, khoảng cách) rồi dừng', async () => {
  const t = await setup({ ipnRetryMax: 2, ipnRetryIntervalSeconds: 30 }, { outcome: 'error' });
  try {
    await createAndOpen(t.adapter);
    await pay(t, 'success');
    assert.strictEqual(t.merchant.received.length, 1);
    await post(t.sim, '/sim/clock/advance', { seconds: 30 });
    assert.strictEqual(t.merchant.received.length, 2);
    await post(t.sim, '/sim/clock/advance', { seconds: 30 });
    assert.strictEqual(t.merchant.received.length, 3);
    await post(t.sim, '/sim/clock/advance', { seconds: 3000 });
    assert.strictEqual(t.merchant.received.length, 3); // hết retry
    assert.ok(t.sim.state.ipnLog.every((l) => !l.acked));
  } finally { await t.close(); }
});

test('ack sai chuỗi (ví dụ OK) bị coi là chưa nhận', async () => {
  const t = await setup({ ipnRetryMax: 1, ipnRetryIntervalSeconds: 10 });
  try {
    // thay merchant bằng ack sai
    t.sim.state.ipnUrl = t.merchant.url;
    const http = require('node:http');
    const bad = http.createServer((q, s) => { s.end('OK'); });
    await new Promise((r) => bad.listen(0, '127.0.0.1', r));
    t.sim.state.ipnUrl = `http://127.0.0.1:${bad.address().port}/ipn`;
    await createAndOpen(t.adapter);
    await pay(t, 'success');
    await post(t.sim, '/sim/clock/advance', { seconds: 10 });
    assert.strictEqual(t.sim.state.ipnLog.length, 2);
    assert.ok(t.sim.state.ipnLog.every((l) => l.acked === false));
    bad.close(); bad.closeAllConnections();
  } finally { await t.close(); }
});

test('return_never: không có returnUrl, vẫn có IPN và query', async () => {
  const t = await setup();
  try {
    await createAndOpen(t.adapter);
    await post(t.sim, '/sim/control', { return_never: true });
    const r = await pay(t, 'success');
    assert.strictEqual(r.body.returnUrl, null);
    assert.strictEqual(t.merchant.received.length, 1);
  } finally { await t.close(); }
});

test('refund và queryRefund -> manual_required; không có cancel', async () => {
  const t = await setup();
  try {
    assert.deepStrictEqual(await t.adapter.refund({ attemptRef: REF, refundRef: 'R1', amount: 1000 }), { status: 'manual_required' });
    assert.deepStrictEqual(await t.adapter.queryRefund({ refundRef: 'R1', attemptRef: REF }), { status: 'manual_required' });
    assert.strictEqual(t.adapter.cancel, undefined);
  } finally { await t.close(); }
});

// ---------- QueryDR phía endpoint ----------

test('QueryDR endpoint: không ký, ký sai, sai AccessCode -> 401; GET -> 405; JSON -> 415; ref lạ -> N code 5 có ký', async () => {
  const t = await setup();
  try {
    const url = `${t.sim.url}/msp/api/v1/vpc/invoices/queries`;
    const form = { vpc_Command: 'queryDR', vpc_Version: '1', vpc_MerchTxnRef: 'NOPE', vpc_Merchant: CFG.merchant, vpc_AccessCode: CFG.accessCode, vpc_User: 'x', vpc_Password: 'y' };
    const H = { 'content-type': 'application/x-www-form-urlencoded' };
    const doPost = (o) => fetch(url, { method: 'POST', headers: H, body: new URLSearchParams(o).toString() });
    const signed = (o) => ({ ...o, vpc_SecureHash: hmac(signString(o), KEY) });
    assert.strictEqual((await doPost(form)).status, 401);
    assert.strictEqual((await doPost({ ...form, vpc_SecureHash: 'A'.repeat(64) })).status, 401);
    assert.strictEqual((await doPost(signed({ ...form, vpc_AccessCode: 'ZZZZZZZZ' }))).status, 401);
    assert.strictEqual((await fetch(`${url}?${new URLSearchParams(signed(form))}`)).status, 405);
    assert.strictEqual((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })).status, 415);
    const ok = await doPost(signed({ ...form, vpc_User: '', vpc_Password: '' })); // A14: không kiểm user/password
    assert.strictEqual(ok.status, 200);
    const body = Object.fromEntries(new URLSearchParams(await ok.text()));
    assert.strictEqual(body.vpc_DRExists, 'N');
    assert.strictEqual(body.vpc_TxnResponseCode, '5');
    assert.strictEqual(body.vpc_SecureHash, hmac(signString(body), KEY));
  } finally { await t.close(); }
});

test('strictQueryCredentials: sai vpc_User/Password -> 401 và adapter trả unknown, không phải not_found/failed', async () => {
  const t = await setup({ strictQueryCredentials: true, queryUser: 'u', queryPassword: 'p' });
  try {
    await createAndOpen(t.adapter);
    assert.strictEqual((await t.adapter.query({ attemptRef: REF, amount: 150000 })).type, 'pending');
    const { createOnepayAdapter } = require('../../src/adapters/onepay/index.js');
    const badCreds = createOnepayAdapter({ ...CFG, baseUrl: t.sim.url, queryPassword: 'wrong' });
    assert.deepStrictEqual(await badCreds.query({ attemptRef: REF }), { state: 'unknown' });
  } finally { await t.close(); }
});

test('query: lỗi mạng, 401, phản hồi sai chữ ký -> unknown (không bao giờ failed)', async () => {
  const { createOnepayAdapter } = require('../../src/adapters/onepay/index.js');
  const mk = (fetchImpl) => createOnepayAdapter(CFG, { fetch: fetchImpl, clock: { now: () => 1 } });
  assert.deepStrictEqual(await mk(async () => { throw new Error('ECONNRESET'); }).query({ attemptRef: 'A' }), { state: 'unknown' });
  const resp = (status, text) => async () => ({ status, text: async () => text });
  assert.deepStrictEqual(await mk(resp(401, '{}')).query({ attemptRef: 'A' }), { state: 'unknown' });
  assert.deepStrictEqual(await mk(resp(200, 'vpc_DRExists=Y&vpc_TxnResponseCode=0&vpc_MerchTxnRef=A&vpc_Amount=100&vpc_SecureHash=' + 'A'.repeat(64))).query({ attemptRef: 'A' }), { state: 'unknown' });
  // phản hồi ký đúng nhưng thuộc ref khác
  const o = { vpc_Command: 'queryDR', vpc_MerchTxnRef: 'B', vpc_Merchant: CFG.merchant, vpc_Version: '1', vpc_DRExists: 'Y', vpc_TxnResponseCode: '0', vpc_Amount: '100' };
  const body = new URLSearchParams({ ...o, vpc_SecureHash: hmac(signString(o), KEY) }).toString();
  assert.deepStrictEqual(await mk(resp(200, body)).query({ attemptRef: 'A' }), { state: 'unknown' });
});

// ---------- ack(outcome) ----------

test('ack(outcome): ok/duplicate -> confirm-success; lỗi -> không confirm, theo hướng bảo thủ', async () => {
  const t = await setup();
  try {
    const { r } = await create(t.adapter);
    const cb = t.adapter.parseCallback({ channel: 'ipn', query: { vpc_SecureHash: 'x' } });
    assert.strictEqual(r.status, 'redirect');
    for (const o of ['ok', 'duplicate']) {
      const a = cb.ack(o);
      assert.deepStrictEqual([a.status, a.body], [200, 'responsecode=1&desc=confirm-success']);
      assert.match(a.contentType, /^text\/plain/);
    }
    for (const o of ['unknown_attempt', 'amount_mismatch', 'invalid_signature', 'error']) {
      const a = cb.ack(o);
      assert.notStrictEqual(a.body, ACK_CONFIRM, o);
      assert.match(a.body, /^responsecode=0/);
    }
    assert.strictEqual(cb.ack('invalid_signature').status, 400);
    assert.strictEqual(cb.ack('error').status, 500);
    assert.strictEqual(cb.ack('khong-biet').body, 'responsecode=0&desc=confirm-fail');
  } finally { await t.close(); }
});

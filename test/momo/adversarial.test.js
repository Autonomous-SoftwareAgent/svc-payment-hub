'use strict';
// spec: MOMO-S-002, MOMO-S-003
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers.js');

const asCallback = (rcvd) => ({ channel: 'ipn', method: 'POST', query: {}, body: rcvd.body, headers: rcvd.headers });

test('create_drop_response: adapter trả unknown; gọi lại cùng orderId bị 41, không lấy lại payUrl', async () => {
  const h = await setup();
  try {
    await h.control({ create_drop_response: true });
    const r = await h.create('DROP-1');
    assert.deepEqual(r, { status: 'unknown' });
    assert.equal(h.sim.state.transactions.has('DROP-1'), true); // đơn đã được tạo ở cổng
    await h.control({ create_drop_response: false });
    const again = await h.create('DROP-1'); // 41 -> unknown (đơn tồn tại, payUrl đã mất), không phải rejected
    assert.deepEqual(again, { status: 'unknown' });
    // đối soát: query ra pending, rồi tiền về vẫn nhận được
    assert.equal((await h.adapter.query({ attemptRef: 'DROP-1', amount: 150000 })).type, 'pending');
    await h.pay('DROP-1', 'success');
    assert.equal((await h.adapter.query({ attemptRef: 'DROP-1', amount: 150000 })).type, 'succeeded');
  } finally { await h.teardown(); }
});

test('timeout phía adapter -> unknown (không phải rejected)', async () => {
  const h = await setup();
  try {
    const slow = require('../../src/adapters/momo/index.js').createMomoAdapter(
      { ...h.sim.config, baseUrl: h.sim.url, ipnUrl: h.ipn.url, redirectUrl: 'x', timeoutMs: 50 },
      { fetch: (u, o) => new Promise((resolve, reject) => { o.signal.addEventListener('abort', () => reject(o.signal.reason)); }) });
    assert.deepEqual(await slow.createPayment({ attemptRef: 'T-1', amount: 1000, orderInfo: 'x', returnUrl: 'x' }), { status: 'unknown' });
    const garbage = require('../../src/adapters/momo/index.js').createMomoAdapter(
      { ...h.sim.config, baseUrl: h.sim.url, ipnUrl: h.ipn.url, redirectUrl: 'x' },
      { fetch: async () => ({ status: 200, text: async () => '<html>oops</html>' }) });
    assert.deepEqual(await garbage.createPayment({ attemptRef: 'T-2', amount: 1000, orderInfo: 'x', returnUrl: 'x' }), { status: 'unknown' });
    assert.deepEqual(await garbage.query({ attemptRef: 'T-2', amount: 1000 }), { state: 'unknown' });
  } finally { await h.teardown(); }
});

test('IPN trùng: hai IPN hợp lệ cùng nội dung', async () => {
  const h = await setup();
  try {
    await h.control({ ipn_duplicate: true });
    await h.create('DUP-1'); await h.pay('DUP-1', 'success');
    assert.equal(h.ipn.received.length, 2);
    const [a, b] = h.ipn.received.map((x) => h.adapter.parseCallback(asCallback(x)));
    assert.equal(a.valid && b.valid, true);
    assert.equal(a.event.gatewayTxnId, b.event.gatewayTxnId);
  } finally { await h.teardown(); }
});

test('IPN drop rồi query ra đúng; resend đưa IPN tới', async () => {
  const h = await setup();
  try {
    await h.control({ ipn_drop: true });
    await h.create('LOST-1', 300000); await h.pay('LOST-1', 'success');
    assert.equal(h.ipn.received.length, 0);
    const q = await h.adapter.query({ attemptRef: 'LOST-1', amount: 300000 });
    assert.equal(q.type, 'succeeded'); assert.equal(q.amount, 300000);
    await h.call('POST', '/sim/ipn/LOST-1/resend');
    assert.equal(h.ipn.received.length, 1);
    assert.equal(h.adapter.parseCallback(asCallback(h.ipn.received[0])).valid, true);
  } finally { await h.teardown(); }
});

test('IPN trễ theo đồng hồ ảo; retry khi merchant không trả 204', async () => {
  const h = await setup();
  try {
    await h.control({ ipn_delay_seconds: 60 });
    await h.create('DLY-1'); await h.pay('DLY-1', 'success');
    assert.equal(h.ipn.received.length, 0);
    await h.call('POST', '/sim/clock/advance', { seconds: 61 });
    assert.equal(h.ipn.received.length, 1);
    // retry: merchant trả 500, MoMo gửi lại sau 5 phút ảo, tối đa 5 lần (unverified)
    await h.control({ ipn_delay_seconds: 0 }); h.ipn.status = 500;
    await h.create('RTY-1'); await h.pay('RTY-1', 'success');
    const base = h.ipn.received.length;
    for (let i = 0; i < 6; i++) await h.call('POST', '/sim/clock/advance', { seconds: 300 });
    assert.equal(h.ipn.received.length - base, 5);
    assert.equal(h.adapter.parseCallback(asCallback(h.ipn.received[base + 4])).valid, true);
  } finally { await h.teardown(); }
});

test('sai số tiền: IPN ký hợp lệ nhưng amount khác; chữ ký sai: valid=false', async () => {
  const h = await setup();
  try {
    await h.control({ ipn_wrong_amount: true });
    await h.create('AMT-1', 150000); await h.pay('AMT-1', 'success');
    const r = h.adapter.parseCallback(asCallback(h.ipn.received[0]));
    assert.equal(r.valid, true); assert.equal(r.event.amount, 151000); // Hub phải bắt amount_mismatch
    assert.equal(r.ack('amount_mismatch').status, 204);
    await h.control({ ipn_wrong_amount: false, ipn_bad_signature: true });
    await h.create('SIG-1'); await h.pay('SIG-1', 'success');
    const bad = h.adapter.parseCallback(asCallback(h.ipn.received[1]));
    assert.equal(bad.valid, false); assert.equal(bad.event, undefined);
    assert.equal(bad.ack('invalid_signature').status, 400);
  } finally { await h.teardown(); }
});

test('paid_after_expiry: query 1005 (not_found) rồi tiền về muộn vẫn succeeded', async () => {
  const h = await setup();
  try {
    await h.create('LATE-1', 150000);
    h.sim.clock.advance(1000);
    assert.deepEqual(await h.adapter.query({ attemptRef: 'LATE-1', amount: 150000 }), { state: 'not_found' });
    const p = await h.pay('LATE-1', 'success');
    assert.equal(p.json.paidAfterExpiry, true);
    const cb = h.adapter.parseCallback(asCallback(h.ipn.received[0]));
    assert.equal(cb.event.type, 'succeeded');
    assert.equal((await h.adapter.query({ attemptRef: 'LATE-1', amount: 150000 })).type, 'succeeded');
    // cấu hình ngược lại
    await h.control({ orderId: 'LATE-2', paid_after_expiry: false });
    await h.create('LATE-2'); h.sim.clock.advance(1000);
    assert.equal((await h.pay('LATE-2', 'success')).status, 409);
  } finally { await h.teardown(); }
});

test('force_result_code cho create/query', async () => {
  const h = await setup();
  try {
    await h.control({ orderId: 'FRC-1', force_result_code: 10 });
    assert.deepEqual(await h.create('FRC-1'), { status: 'unknown' }); // 10 hệ thống bận: không chắc chắn
    assert.deepEqual(await h.adapter.query({ attemptRef: 'FRC-1', amount: 1000 }), { state: 'unknown' });
    await h.control({ orderId: 'FRC-1', force_result_code: 7002 });
    assert.equal((await h.adapter.query({ attemptRef: 'FRC-1', amount: 1000 })).type, 'pending');
    await h.control({ orderId: 'FRC-2', force_result_code: 1001 });
    assert.equal((await h.adapter.query({ attemptRef: 'FRC-2', amount: 1000 })).type, 'failed');
  } finally { await h.teardown(); }
});

test('refund đồng bộ: succeeded; refund 7002 -> processing, queryRefund ra succeeded/failed muộn', async () => {
  const h = await setup();
  try {
    await h.create('RF-1', 100000); await h.pay('RF-1', 'success');
    const txn = (await h.adapter.query({ attemptRef: 'RF-1', amount: 100000 })).gatewayTxnId;
    // đồng bộ
    let r = await h.adapter.refund({ attemptRef: 'RF-1', refundRef: 'RFD-SYNC', amount: 10000, gatewayTxnId: txn });
    assert.equal(r.status, 'succeeded');
    assert.equal((await h.adapter.queryRefund({ refundRef: 'RFD-SYNC', attemptRef: 'RF-1' })).status, 'succeeded');
    // bất đồng bộ thành công muộn
    await h.control({ refund_mode: 'async', refund_async_delay_seconds: 3600, refund_async_final: 'success' });
    r = await h.adapter.refund({ attemptRef: 'RF-1', refundRef: 'RFD-ASYNC', amount: 20000, gatewayTxnId: txn });
    assert.equal(r.status, 'processing');
    assert.equal((await h.adapter.queryRefund({ refundRef: 'RFD-ASYNC', attemptRef: 'RF-1' })).status, 'processing');
    h.sim.clock.advance(3601);
    assert.equal((await h.adapter.queryRefund({ refundRef: 'RFD-ASYNC', attemptRef: 'RF-1' })).status, 'succeeded');
    // bất đồng bộ thất bại muộn
    await h.control({ refund_async_final: 'failed' });
    r = await h.adapter.refund({ attemptRef: 'RF-1', refundRef: 'RFD-FAIL', amount: 20000, gatewayTxnId: txn });
    assert.equal(r.status, 'processing');
    h.sim.clock.advance(3601);
    assert.equal((await h.adapter.queryRefund({ refundRef: 'RFD-FAIL', attemptRef: 'RF-1' })).status, 'failed');
    // refundRef lạ: chưa biết, không phải failed
    assert.equal((await h.adapter.queryRefund({ refundRef: 'NOPE', attemptRef: 'RF-1' })).status, 'requested');
    // quá số tiền gốc -> failed (43); refundRef trùng -> processing (41)
    assert.equal((await h.adapter.refund({ attemptRef: 'RF-1', refundRef: 'RFD-BIG', amount: 90000, gatewayTxnId: txn })).status, 'failed');
    assert.equal((await h.adapter.refund({ attemptRef: 'RF-1', refundRef: 'RFD-SYNC', amount: 10000, gatewayTxnId: txn })).status, 'processing');
    await h.control({ refund_mode: 'sync' });
    // thiếu gatewayTxnId: adapter tự query để lấy transId
    assert.equal((await h.adapter.refund({ attemptRef: 'RF-1', refundRef: 'RFD-Q', amount: 1000 })).status, 'succeeded');
  } finally { await h.teardown(); }
});

test('khách thử lại sau thất bại trên cùng payUrl (A17): hai IPN mâu thuẫn, query trọng tài', async () => {
  const h = await setup();
  try {
    await h.create('RETRY-1');
    await h.pay('RETRY-1', 'failed'); await h.pay('RETRY-1', 'success');
    const types = h.ipn.received.map((x) => h.adapter.parseCallback(asCallback(x)).event.type);
    assert.deepEqual(types, ['failed', 'succeeded']);
    assert.equal((await h.adapter.query({ attemptRef: 'RETRY-1', amount: 150000 })).type, 'succeeded');
  } finally { await h.teardown(); }
});

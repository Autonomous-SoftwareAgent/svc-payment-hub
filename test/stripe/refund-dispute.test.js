'use strict';
// spec: STRP-S-001
// spec: STRP-S-002
// Hoàn tiền, hoàn ngoài Hub (Dashboard) và tranh chấp của adapter Stripe với simulator. Chỉ chạy với simulator: chưa kiểm Stripe thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { assertEvent } = require('../../src/contract');

const paid = async (t, ref = 'BSNrefd0001', amount = 1999) => {
  const c = await t.create(ref, { amount });
  await t.pay(c.state.cs);
  const ev = (await t.events()).find((e) => e.type === 'succeeded' && e.attemptRef === ref);
  return { c, ref, amount, pi: ev.gatewayTxnId };
};
const refundP = (p, refundRef, amount) => ({ attemptRef: p.ref, refundRef, amount, currency: 'USD', gatewayTxnId: p.pi, state: p.c.state });

test('hoàn đồng bộ: succeeded, khóa idempotency theo refundRef, metadata hubRefund; hoàn nhiều lần tới hết số đã thu rồi bị từ chối', async () => {
  const t = await setup();
  try {
    const p = await paid(t);
    assert.deepEqual(await t.adapter.refund(refundP(p, 'RFaaa00001', 500)), { status: 'succeeded' });
    const req = (await t.state()).requests.find((x) => x.path === '/v1/refunds' && x.method === 'POST');
    assert.equal(req.key, 'RFaaa00001:refund');
    assert.equal(req.body.metadata.hubRefund, 'RFaaa00001');
    assert.equal(req.body.metadata.attemptRef, p.ref);
    assert.equal(req.body.amount, '500');
    assert.deepEqual(await t.adapter.refund(refundP(p, 'RFaaa00002', 1499)), { status: 'succeeded' });
    assert.deepEqual(await t.adapter.refund(refundP(p, 'RFaaa00003', 1)), { status: 'failed' }); // charge_already_refunded: chắc chắn không hoàn
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RFaaa00001', attemptRef: p.ref, state: p.c.state }), { status: 'succeeded' });
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RFkhongco1', attemptRef: p.ref, state: p.c.state }), { status: 'requested' }, 'chưa từng tạo: requested, không phải failed');
  } finally { await t.teardown(); }
});

test('hoàn vượt số còn lại bị từ chối; không có gatewayTxnId thì tự tìm pi_ qua truy vấn; khóa khác khoản đã thu thì không đổi gì', async () => {
  const t = await setup();
  try {
    const p = await paid(t);
    assert.deepEqual(await t.adapter.refund(refundP(p, 'RFbig000001', 5000)), { status: 'failed' });
    assert.deepEqual(await t.adapter.refund({ ...refundP(p, 'RFfind00001', 100), gatewayTxnId: undefined }), { status: 'succeeded' });
    const lost = await t.create('BSNnotpaid1'); // chưa trả, không có khoản nào để hoàn
    assert.deepEqual(await t.adapter.refund({ attemptRef: 'BSNnotpaid1', refundRef: 'RFnone00001', amount: 100, currency: 'USD', state: lost.state }), { status: 'manual_required' });
  } finally { await t.teardown(); }
});

test('hoàn bất đồng bộ: pending là processing; thành công hoặc thất bại muộn được queryRefund thấy; refund.failed không đổi gì ở kênh webhook', async () => {
  const t = await setup({ controls: { refund_mode: 'async' } });
  try {
    const p = await paid(t);
    assert.deepEqual(await t.adapter.refund(refundP(p, 'RFasy00001', 500)), { status: 'processing' });
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RFasy00001', attemptRef: p.ref, state: p.c.state }), { status: 'processing' });
    const id = Object.values((await t.state()).refunds)[0].id;
    await t.post('/sim/refund/resolve', { id, outcome: 'failed' });
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RFasy00001', attemptRef: p.ref, state: p.c.state }), { status: 'failed' });
    assert.ok(t.types().includes('refund.failed'));
    assert.ok((await t.events()).every((e) => e.type !== 'reversed'), 'hoàn do Hub tạo không thành reversed');
    assert.deepEqual(await t.adapter.refund(refundP(p, 'RFasy00002', 500)), { status: 'processing' });
    const id2 = Object.values((await t.state()).refunds).find((r) => r.metadata.hubRefund === 'RFasy00002').id;
    await t.post('/sim/refund/resolve', { id: id2, outcome: 'success' });
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RFasy00002', attemptRef: p.ref, state: p.c.state }), { status: 'succeeded' });
  } finally { await t.teardown(); }
});

test('hoàn mất phản hồi (500 sau khi đã xử lý, hoặc timeout): processing, KHÔNG failed; queryRefund thấy đã hoàn; gửi lại cùng khóa chỉ nhận lại kết quả 500 đã lưu', async () => {
  for (const mode of ['status500_after', 'timeout_after']) {
    const t = await setup({ timeoutMs: 400 });
    try {
      const p = await paid(t, `BSNlost${mode.length}01`);
      await t.control({ inject: [{ match: 'POST /v1/refunds', mode, times: 1 }] });
      assert.deepEqual(await t.adapter.refund(refundP(p, `RFlost${mode.length}01`, 500)), { status: 'processing' }, mode);
      assert.deepEqual(await t.adapter.queryRefund({ refundRef: `RFlost${mode.length}01`, attemptRef: p.ref, state: p.c.state }), { status: 'succeeded' }, `${mode}: hiệu ứng đã xảy ra`);
      assert.equal(Object.keys((await t.state()).refunds).length, 1);
    } finally { await t.teardown(); }
  }
});

test('hoàn ngoài Hub (Dashboard): webhook refund.created thành reversed với attemptRef tra từ PaymentIntent; hoàn do Hub tạo thì bị bỏ qua', async () => {
  const t = await setup();
  try {
    const p = await paid(t);
    t.rcv.received.length = 0;
    await t.adapter.refund(refundP(p, 'RFhub000001', 300));
    assert.deepEqual(await t.events(), [], 'hoàn do Hub tạo không phát sự kiện');
    t.rcv.received.length = 0;
    await fetch(`${t.sim.url}/v1/refunds`, { method: 'POST', headers: { authorization: `Bearer ${t.sim.config.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `payment_intent=${p.pi}&amount=700` }); // như bấm hoàn trong Dashboard: không có metadata của Hub
    const evs = await t.events();
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, 'reversed');
    assert.equal(evs[0].attemptRef, p.ref);
    assert.equal(evs[0].amount, 700);
    assert.match(evs[0].gatewayTxnId, /^re_/);
    assert.equal(assertEvent(evs[0]), true);
  } finally { await t.teardown(); }
});

test('tranh chấp: created thành dispute_opened, closed won hoặc lost thành dispute_won hoặc dispute_lost, mã là mã dispute; warning_closed và funds_* bị bỏ qua', async () => {
  const t = await setup();
  try {
    const p = await paid(t);
    t.rcv.received.length = 0;
    const d = (await t.post('/sim/dispute', { payment_intent: p.pi, amount: 1999 })).json;
    assert.deepEqual(t.types(), ['charge.dispute.created', 'charge.dispute.funds_withdrawn']);
    let evs = await t.events();
    assert.equal(evs.length, 1);
    assert.deepEqual([evs[0].type, evs[0].attemptRef, evs[0].amount, evs[0].currency, evs[0].gatewayTxnId], ['dispute_opened', p.ref, 1999, 'USD', d.id]);
    assert.equal(assertEvent(evs[0]), true);
    t.rcv.received.length = 0;
    await t.post('/sim/dispute/close', { id: d.id, outcome: 'won' });
    evs = await t.events();
    assert.deepEqual(evs.map((e) => [e.type, e.gatewayTxnId]), [['dispute_won', d.id]]);
    const p2 = await paid(t, 'BSNdisp0002');
    const d2 = (await t.post('/sim/dispute', { payment_intent: p2.pi })).json;
    t.rcv.received.length = 0;
    await t.post('/sim/dispute/close', { id: d2.id, outcome: 'lost' });
    assert.deepEqual((await t.events()).map((e) => e.type), ['dispute_lost']);
    const p3 = await paid(t, 'BSNdisp0003');
    const d3 = (await t.post('/sim/dispute', { payment_intent: p3.pi })).json;
    t.rcv.received.length = 0;
    await t.post('/sim/dispute/close', { id: d3.id, outcome: 'warning_closed' });
    assert.deepEqual(await t.events(), [], 'warning_closed: Hub chưa có chuẩn tương ứng, chỉ bỏ qua');
  } finally { await t.teardown(); }
});

test('tranh chấp khi tra PaymentIntent lỗi tạm thời: retryLater (Stripe giao lại), không mất; PaymentIntent không thuộc Hub thì bỏ qua', async () => {
  const t = await setup();
  try {
    const p = await paid(t);
    t.rcv.received.length = 0;
    await t.control({ inject: [{ match: 'GET /v1/payment_intents/', mode: 'status500_before', times: 1 }] });
    await t.post('/sim/dispute', { payment_intent: p.pi });
    const first = await t.parse(t.rcv.received[0]);
    assert.equal(first.valid, true);
    assert.equal(first.retryLater, true);
    assert.equal(first.event, undefined);
    assert.equal(first.ack('error').status, 500, 'trả 5xx để Stripe giao lại');
    const again = await t.parse(t.rcv.received[0]); // giao lại: lần này tra được
    assert.equal(again.event.type, 'dispute_opened');
    // PaymentIntent của hệ khác trong cùng tài khoản (không có metadata attemptRef): không phải việc của Hub
    const raw = `mode=payment&success_url=${encodeURIComponent('http://x/r')}&line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=1000&line_items[0][quantity]=1`;
    const s = await (await fetch(`${t.sim.url}/v1/checkout/sessions`, { method: 'POST', headers: { authorization: `Bearer ${t.sim.config.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body: raw })).json();
    t.rcv.received.length = 0;
    await t.pay(s.id);
    assert.deepEqual(await t.events(), [], 'thanh toán không do Hub tạo bị bỏ qua, không thành tiền chưa rõ chủ');
  } finally { await t.teardown(); }
});

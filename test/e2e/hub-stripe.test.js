'use strict';
// spec: STRP-S-001
// spec: STRP-S-002
// spec: STRP-S-003
// Tích hợp: lõi Hub + adapter Stripe thật + simulator Stripe + server HTTP của Hub (webhook vào /ipn/stripe, có kiểm Stripe-Signature).
// Điều cần giữ là bất biến về tiền qua các kịch bản bất lợi. CHỈ chạy với simulator: chưa kiểm Stripe thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, order } = require('../support/world');

const anomalies = (hub, type) => hub.listAnomalies(type ? { type } : {});
const usd = (o = {}) => order({ amount: 1999, currency: 'USD', ...o });
async function start(opts = {}, hubOpts = {}) {
  const w = await createWorld(['stripe'], hubOpts, { stripe: opts });
  const d = w.drivers.stripe;
  const r = await w.hub.createPayment(usd());
  return { w, d, hub: w.hub, payment: r.payment, attempt: r.attempt };
}

test('[stripe] thu ngay: nextAction redirect, khách trả, webhook có chữ ký vào Hub, đơn PAID, mã giao dịch là pi_, không cảnh báo', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    assert.equal(attempt.status, 'AWAITING');
    assert.equal(attempt.nextAction.type, 'redirect');
    assert.equal(attempt.url, attempt.nextAction.url, 'trường cũ được điền cho cửa hàng cũ');
    assert.match(attempt.state.cs, /^cs_test_/);
    await d.pay(attempt);
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(payment.status, 'PAID');
    assert.match(attempt.gatewayTxnId, /^pi_/);
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

test('[stripe] webhook trùng ba lần và đảo thứ tự: một lần ghi nhận tiền, không cảnh báo', async () => {
  const { w, d, payment, attempt } = await start({ controls: { dup_webhooks: 2, reverse_events: true } });
  try {
    await d.pay(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(anomalies(w.hub).length, 0);
    const paid = w.hub.store.events.filter((e) => e.type === 'succeeded' && !e.duplicate);
    assert.equal(paid.length, 1);
  } finally { await w.close(); }
});

test('[stripe] webhook mất hẳn: đối soát bằng truy vấn phiên tìm ra tiền', async () => {
  const { w, d, payment, attempt } = await start({ controls: { drop_types: ['payment_intent.succeeded', 'charge.succeeded', 'checkout.session.completed'] } });
  try {
    await d.pay(attempt);
    assert.equal(payment.status, 'OPEN', 'chưa có thông báo nào');
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(payment.status, 'PAID');
    assert.match(attempt.gatewayTxnId, /^pi_/);
  } finally { await w.close(); }
});

test('[stripe] chữ ký sai: Hub từ chối, không đổi gì về tiền hay đơn; đối soát bằng truy vấn vẫn tìm ra tiền', async () => {
  const { w, d, payment, attempt } = await start({ controls: { sign_with: 'whsec_khac' } });
  try {
    await d.pay(attempt);
    assert.equal(payment.status, 'OPEN');
    assert.equal(attempt.status, 'AWAITING');
    assert.ok(w.hub.store.events.some((e) => e.outcome === 'invalid_signature'));
    assert.equal(anomalies(w.hub).length, 0, 'thông báo giả không tạo cảnh báo tiền');
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(payment.status, 'PAID', 'truy vấn thật mới là nguồn khi webhook không đáng tin');
  } finally { await w.close(); }
});

test('[stripe] khách trả hỏng không làm attempt thất bại (phiên vẫn mở), khách thử lại trên cùng phiên thì đơn PAID', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    const decl = await d.pay(attempt, 'decline', { decline_code: 'insufficient_funds' });
    assert.equal(decl.body.status, 'declined');
    assert.equal(attempt.status, 'AWAITING', 'thẻ hỏng trên hosted Checkout không phải thất bại của attempt');
    assert.equal(payment.status, 'OPEN');
    await d.pay(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

test('[stripe] tạo phiên mất phản hồi (500 sau khi đã xử lý): attempt UNKNOWN, không chuyển cổng; khách vẫn trả được và webhook (mang client_reference_id) cứu đơn', async () => {
  const w = await createWorld(['stripe'], {}, { stripe: {} });
  const d = w.drivers.stripe;
  try {
    await d.control({ inject: [{ match: 'POST /v1/checkout/sessions', mode: 'status500_after', times: 1 }] });
    const { payment, attempt } = await w.hub.createPayment(usd());
    assert.equal(attempt.status, 'UNKNOWN');
    assert.equal(attempt.state, undefined, 'không có mã phiên');
    assert.equal(payment.status, 'OPEN');
    const sessions = (await (await fetch(`${d.sim.url}/sim/state`)).json()).sessions;
    assert.equal(sessions.length, 1, 'phiên ĐÃ được tạo ở Stripe');
    await d.post('/sim/pay', { session: sessions[0].id });
    assert.equal(attempt.status, 'SUCCEEDED', 'webhook mang attemptRef nên Hub nhận ra dù mất mã phiên');
    assert.equal(payment.status, 'PAID');
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

test('[stripe] hủy bằng expire khi chuyển cổng: attempt cũ CANCELLED, tạo được attempt mới; phiên cũ không trả được nữa', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    const r = await w.hub.createAttempt(payment.id, { reason: 'customer_retry', cancelLive: true });
    assert.equal(attempt.status, 'CANCELLED');
    assert.notEqual(r.attempt.id, attempt.id);
    assert.equal((await d.pay(attempt)).status, 409, 'phiên đã hết hạn');
    await d.pay(r.attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(payment.paidByAttempt, r.attempt.id);
  } finally { await w.close(); }
});

test('[stripe] phiên hết hạn: attempt EXPIRED qua webhook, đơn đóng sau hạn', async () => {
  const { w, payment, attempt } = await start();
  try {
    await w.advance(25 * 3600);
    assert.equal(attempt.status, 'EXPIRED');
    await w.hub.reconcile();
    assert.equal(payment.status, 'CLOSED');
  } finally { await w.close(); }
});

test('[stripe] giữ tiền rồi thu: AUTHORIZED (đơn vẫn OPEN), capturePayment thành PAID; webhook succeeded đến giữa chừng không tạo cảnh báo', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth' } });
  try {
    await d.pay(attempt);
    assert.equal(attempt.status, 'AUTHORIZED');
    assert.equal(payment.status, 'OPEN');
    assert.match(attempt.gatewayTxnId, /^pi_/);
    const r = await w.hub.capturePayment({ paymentId: payment.id });
    assert.equal(r.outcome, 'captured');
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(anomalies(w.hub).length, 0, 'webhook succeeded do chính lệnh thu gây ra đến trước phản hồi: chỉ là trùng');
    assert.equal((await w.hub.refund({ attemptId: attempt.id, amount: 500 })).status, 'SUCCEEDED');
  } finally { await w.close(); }
});

test('[stripe] authorized đến SAU khi đã thu (đảo thứ tự): không còn late_authorization oan (PHUB-D-038)', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth' }, controls: { hold_webhooks: true } });
  try {
    await d.pay(attempt); // webhook authorized bị giữ lại
    assert.equal(attempt.status, 'AWAITING');
    await w.advance(61);
    await w.hub.reconcile(); // truy vấn thấy khoản giữ trước webhook
    assert.equal(attempt.status, 'AUTHORIZED');
    await w.hub.capturePayment({ paymentId: payment.id });
    assert.equal(payment.status, 'PAID');
    await d.post('/sim/webhook/flush', {}); // giờ authorized, succeeded cũ đến muộn
    assert.equal(anomalies(w.hub, 'late_authorization').length, 0);
    assert.equal(anomalies(w.hub).length, 0);
    assert.equal(attempt.status, 'SUCCEEDED');
  } finally { await w.close(); }
});

test('[stripe] giữ tiền rồi nhả (void): attempt CANCELLED, đơn vẫn OPEN để khách thử lại; webhook canceled đến sau chỉ là trùng', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth' } });
  try {
    await d.pay(attempt);
    const r = await w.hub.voidPayment({ paymentId: payment.id });
    assert.equal(r.outcome, 'voided');
    assert.equal(attempt.status, 'CANCELLED');
    assert.equal(payment.status, 'OPEN');
    assert.equal(anomalies(w.hub).length, 0);
    await assert.rejects(w.hub.capturePayment({ paymentId: payment.id }), { code: 'invalid_state' });
  } finally { await w.close(); }
});

test('[stripe] thu mất phản hồi (timeout sau khi đã thu): outcome unknown, không coi là thất bại; đối soát thấy đã thu thì PAID, không thu lần hai', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth', timeoutMs: 400 }, controls: {} });
  try {
    await d.pay(attempt);
    await d.control({ inject: [{ match: '/capture', mode: 'timeout_after', times: 1 }], drop_types: ['payment_intent.succeeded', 'charge.captured'] });
    const r = await w.hub.capturePayment({ paymentId: payment.id });
    assert.equal(r.outcome, 'unknown');
    assert.equal(payment.status, 'OPEN');
    assert.equal(attempt.op.status, 'UNKNOWN');
    await assert.rejects(w.hub.capturePayment({ paymentId: payment.id }), { code: 'op_in_progress' });
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.op, null);
    const calls = (await (await fetch(`${d.sim.url}/sim/state`)).json()).requests.filter((x) => x.path.endsWith('/capture'));
    assert.equal(calls.length, 1, 'chỉ một lần gọi thu');
  } finally { await w.close(); }
});

test('[stripe] giữ tiền hết hạn (7 ngày): Stripe tự nhả, attempt EXPIRED; không có cảnh báo authorization_stale khi đã đặt maxAgeSeconds dài hơn', async () => {
  const { w, payment, attempt, d } = await start({ adapter: { product: 'auth' } }, { reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 3600], maxAgeSeconds: 10 * 86400 } });
  try {
    await d.pay(attempt);
    assert.equal(attempt.status, 'AUTHORIZED');
    await w.advance(3 * 86400);
    await w.hub.reconcile();
    assert.equal(anomalies(w.hub, 'authorization_stale').length, 0);
    await w.advance(5 * 86400);
    await w.hub.reconcile();
    assert.equal(attempt.status, 'EXPIRED');
    assert.equal(payment.status, 'CLOSED');
    await assert.rejects(w.hub.capturePayment({ paymentId: payment.id }), { code: 'payment_not_open' });
  } finally { await w.close(); }
});

test('[stripe] tranh chấp: dispute_opened rồi dispute_lost thành cảnh báo, đơn và attempt không đổi, hoàn tiền bị cổng từ chối khi đang tranh chấp', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.pay(attempt);
    const dsp = (await d.post('/sim/dispute', { payment_intent: attempt.gatewayTxnId })).body;
    assert.equal(anomalies(w.hub, 'dispute_opened').length, 1);
    assert.equal(attempt.needsOperator, true);
    assert.equal(payment.status, 'PAID');
    const rf = await w.hub.refund({ attemptId: attempt.id, amount: 100 });
    assert.equal(rf.status, 'FAILED', 'Stripe từ chối hoàn khi đang tranh chấp (charge_disputed)');
    await d.post('/sim/dispute/close', { id: dsp.id, outcome: 'lost' });
    assert.equal(anomalies(w.hub, 'dispute_lost').length, 1);
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('[stripe] tiền theo đơn vị nhỏ nhất qua cả Hub: JPY, VND, USD đều ghi nhận đúng số tiền đã trả', async () => {
  const w = await createWorld(['stripe'], {}, { stripe: {} });
  const d = w.drivers.stripe;
  try {
    for (const [currency, amount] of [['JPY', 500], ['VND', 150000], ['USD', 1999]]) {
      const { payment, attempt } = await w.hub.createPayment(order({ currency, amount }));
      await d.pay(attempt);
      assert.equal(payment.status, 'PAID', currency);
      assert.equal(payment.amount, amount);
    }
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

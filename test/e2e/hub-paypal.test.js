'use strict';
// spec: PYPL-S-001
// spec: PYPL-S-002
// spec: PYPL-S-003
// Tích hợp: lõi Hub + adapter PayPal thật + simulator PayPal + server HTTP của Hub (webhook vào /ipn/paypal có kiểm chữ ký; khách quay về /return/paypal).
// Điều cần giữ là bất biến về tiền qua các kịch bản bất lợi, và lõi không biết gì riêng về PayPal. CHỈ chạy với simulator: chưa kiểm PayPal thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, order } = require('../support/world');

const anomalies = (hub, type) => hub.listAnomalies(type ? { type } : {});
const usd = (o = {}) => order({ amount: 1999, currency: 'USD', ...o });
async function start(opts = {}, hubOpts = {}) {
  const w = await createWorld(['paypal'], hubOpts, { paypal: opts });
  const d = w.drivers.paypal;
  const r = await w.hub.createPayment(usd());
  return { w, d, hub: w.hub, payment: r.payment, attempt: r.attempt };
}
const simState = async (d) => (await fetch(`${d.sim.url}/sim/state`)).json();

test('[paypal] thu ngay: nextAction redirect, khách duyệt và quay về, adapter thu, đơn PAID, mã giao dịch là mã order, không cảnh báo', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    assert.equal(attempt.status, 'AWAITING');
    assert.equal(attempt.nextAction.type, 'redirect');
    assert.equal(attempt.url, attempt.nextAction.url, 'trường cũ được điền cho cửa hàng cũ');
    assert.ok(attempt.state.order);
    await d.pay(attempt);
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.gatewayTxnId, attempt.state.order);
    assert.equal(anomalies(w.hub).length, 0);
    assert.equal((await simState(d)).captures.length, 1);
  } finally { await w.close(); }
});

test('[paypal] khách duyệt rồi ĐÓNG TAB (không quay về): webhook CHECKOUT.ORDER.APPROVED làm adapter thu, đơn PAID', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.pay(attempt, 'approve_only');
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(anomalies(w.hub).length, 0);
    assert.equal((await simState(d)).captures.length, 1, 'thu đúng một lần dù return và webhook cùng có thể đến');
  } finally { await w.close(); }
});

test('[paypal] duyệt mà CẢ return lẫn webhook mất: không ai thu, đối soát không thu hộ (truy vấn chỉ đọc), đơn vẫn OPEN, khách không bị trừ tiền', async () => {
  const { w, d, payment, attempt } = await start({ controls: { drop_types: ['CHECKOUT.ORDER.APPROVED'] } });
  try {
    await d.pay(attempt, 'approve_only');
    assert.equal(payment.status, 'OPEN');
    for (let i = 0; i < 4; i += 1) { await w.advance(120); await w.hub.reconcile(); }
    assert.equal(payment.status, 'OPEN');
    assert.equal((await simState(d)).captures.length, 0, 'Hub không thu tiền khách bằng đường truy vấn');
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

test('[paypal] webhook trùng ba lần và đảo thứ tự: một lần ghi nhận tiền, không cảnh báo', async () => {
  const { w, d, payment, attempt } = await start({ controls: { dup_webhooks: 2, reverse_events: true } });
  try {
    await d.pay(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(anomalies(w.hub).length, 0);
    assert.equal((await simState(d)).captures.length, 1);
  } finally { await w.close(); }
});

test('[paypal] chữ ký webhook sai: Hub từ chối webhook, không đổi gì; kênh return (Hub tự hỏi PayPal bằng khóa của mình) vẫn cứu đơn', async () => {
  const { w, d, payment, attempt } = await start({ controls: { bad_signature: true } });
  try {
    await d.pay(attempt);
    assert.ok(w.hub.store.events.some((e) => e.outcome === 'invalid_signature'));
    assert.equal(payment.status, 'PAID', 'tiền ghi nhận từ lời gọi API của Hub, không từ thông báo giả');
    assert.equal(anomalies(w.hub).length, 0);
    const c2 = await w.hub.createPayment(usd({ orderId: 'O2' }));
    await d.pay(c2.attempt, 'approve_only'); // chỉ có webhook giả: không ai thu
    assert.equal(c2.payment.status, 'OPEN');
    assert.equal((await simState(d)).captures.length, 1);
  } finally { await w.close(); }
});

test('[paypal] thu bị từ chối: attempt FAILED (declined), đơn OPEN, không có tiền; khách thử lại bằng attempt mới thì PAID', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.pay(attempt, 'decline');
    assert.equal(attempt.status, 'FAILED');
    assert.equal(attempt.failReason, 'failed');
    assert.equal(payment.status, 'OPEN');
    assert.equal((await simState(d)).captures.length, 0);
    const r = await w.hub.createAttempt(payment.id, { reason: 'customer_retry' });
    await d.pay(r.attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(payment.paidByAttempt, r.attempt.id);
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

test('[paypal] khách hủy ở trang PayPal: attempt vẫn AWAITING, đơn OPEN, không có tiền; đối soát không đổi gì', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.pay(attempt, 'cancel');
    assert.equal(attempt.status, 'AWAITING');
    assert.equal(payment.status, 'OPEN');
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(attempt.status, 'AWAITING');
    assert.equal((await simState(d)).captures.length, 0);
    await d.pay(attempt);
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('[paypal] capture PENDING: attempt chưa SUCCEEDED, đơn OPEN; khi PayPal hoàn tất thì webhook đưa đơn thành PAID', async () => {
  const { w, d, payment, attempt } = await start({ controls: { capture_pending: true } });
  try {
    await d.pay(attempt);
    assert.equal(payment.status, 'OPEN');
    assert.notEqual(attempt.status, 'SUCCEEDED');
    const cap = (await simState(d)).captures[0];
    await d.post('/sim/capture/resolve', { id: cap.id, outcome: 'completed' });
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

test('[paypal] khách duyệt SAU khi đơn Hub đã hết hạn (order PayPal sống 3 giờ, đơn Hub 30 phút): tiền không được vô hình', async () => {
  const { w, d, payment, attempt } = await start({ controls: { drop_types: ['CHECKOUT.ORDER.APPROVED'] } });
  try {
    await w.advance(3000);
    await w.hub.reconcile();
    await d.pay(attempt); // khách vẫn duyệt và quay về
    const kept = payment.status === 'PAID' || anomalies(w.hub, 'late_success').length > 0;
    assert.equal(kept, true, `payment=${payment.status} attempt=${attempt.status}`);
    assert.equal((await simState(d)).captures.length, 1);
  } finally { await w.close(); }
});

test('[paypal] giữ tiền rồi thu: AUTHORIZED (đơn OPEN), capturePayment thành PAID; không cảnh báo; hoàn một phần được', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth' } });
  try {
    await d.pay(attempt);
    assert.equal(attempt.status, 'AUTHORIZED');
    assert.equal(payment.status, 'OPEN');
    assert.equal(attempt.gatewayTxnId, attempt.state.order);
    const r = await w.hub.capturePayment({ paymentId: payment.id });
    assert.equal(r.outcome, 'captured');
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(anomalies(w.hub).length, 0);
    assert.equal((await w.hub.refund({ attemptId: attempt.id, amount: 500 })).status, 'SUCCEEDED');
    assert.equal(anomalies(w.hub).length, 0, 'webhook hoàn của chính Hub không thành tiền bị đảo');
  } finally { await w.close(); }
});

test('[paypal] authorized đến SAU khi đã thu (đảo thứ tự, webhook bị giữ): không late_authorization oan nhờ mã order chung', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth' }, controls: { hold_webhooks: true } });
  try {
    await d.pay(attempt, 'approve_only'); // chưa có webhook nào
    await d.post('/sim/control', { hold_webhooks: false });
    const a2 = await d.post('/sim/webhook/flush', {}); // giao CHECKOUT.ORDER.APPROVED: adapter giữ tiền
    assert.ok(a2.body.delivered >= 1);
    assert.equal(attempt.status, 'AUTHORIZED');
    await w.hub.capturePayment({ paymentId: payment.id });
    assert.equal(payment.status, 'PAID');
    await d.post('/sim/control', { hold_webhooks: true });
    const orderId = attempt.state.order;
    await d.post('/sim/emit', { type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: 'AUT-MUON', status: 'CREATED', custom_id: attempt.ref, amount: { currency_code: 'USD', value: '19.99' }, links: [{ rel: 'up', href: `${d.sim.url}/v2/checkout/orders/${orderId}` }] } });
    await d.post('/sim/webhook/flush', {}); // authorized cũ đến muộn
    assert.equal(anomalies(w.hub, 'late_authorization').length, 0);
    assert.equal(anomalies(w.hub).length, 0);
    assert.equal(attempt.status, 'SUCCEEDED');
  } finally { await w.close(); }
});

test('[paypal] giữ tiền rồi nhả (void): attempt CANCELLED, đơn vẫn OPEN để khách thử lại; thu sau khi nhả bị từ chối', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth' } });
  try {
    await d.pay(attempt);
    const r = await w.hub.voidPayment({ paymentId: payment.id });
    assert.equal(r.outcome, 'voided');
    assert.equal(attempt.status, 'CANCELLED');
    assert.equal(payment.status, 'OPEN');
    assert.equal(anomalies(w.hub).length, 0);
    await assert.rejects(w.hub.capturePayment({ paymentId: payment.id }), { code: 'invalid_state' });
    assert.equal((await simState(d)).captures.length, 0);
  } finally { await w.close(); }
});

test('[paypal] thu mất phản hồi (timeout sau khi đã thu): unknown, không coi là thất bại; đối soát thấy đã thu thì PAID, không thu lần hai', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth', timeoutMs: 400 } });
  try {
    await d.pay(attempt);
    await d.control({ inject: [{ match: '/capture', mode: 'timeout_after', times: 1 }], drop_types: ['PAYMENT.CAPTURE.COMPLETED'] });
    const r = await w.hub.capturePayment({ paymentId: payment.id });
    assert.equal(r.outcome, 'unknown');
    assert.equal(payment.status, 'OPEN');
    assert.equal(attempt.op.status, 'UNKNOWN');
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.op, null);
    assert.equal((await simState(d)).captures.length, 1);
  } finally { await w.close(); }
});

test('[paypal] khoản giữ hết hạn (29 ngày): PayPal nhả, attempt EXPIRED; không cảnh báo authorization_stale khi maxAgeSeconds đủ dài', async () => {
  const { w, d, payment, attempt } = await start({ adapter: { product: 'auth' } }, { reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 3600], maxAgeSeconds: 40 * 86400 } });
  try {
    await d.pay(attempt);
    assert.equal(attempt.status, 'AUTHORIZED');
    await w.advance(10 * 86400);
    await w.hub.reconcile();
    assert.equal(anomalies(w.hub, 'authorization_stale').length, 0);
    await w.advance(20 * 86400);
    await w.hub.reconcile();
    assert.equal(attempt.status, 'EXPIRED');
    assert.equal(payment.status, 'CLOSED');
  } finally { await w.close(); }
});

test('[paypal] tranh chấp: dispute_opened rồi dispute_lost thành cảnh báo, đơn và attempt không đổi', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.pay(attempt);
    const cap = (await simState(d)).captures[0];
    const dsp = (await d.post('/sim/dispute', { capture: cap.id })).body;
    assert.equal(anomalies(w.hub, 'dispute_opened').length, 1);
    assert.equal(attempt.needsOperator, true);
    assert.equal(payment.status, 'PAID');
    await d.post('/sim/dispute/close', { id: dsp.dispute_id, outcome: 'lost' });
    assert.equal(anomalies(w.hub, 'dispute_lost').length, 1);
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('[paypal] hoàn ngoài Hub (làm trên trang PayPal): thành cảnh báo funds_reversed, một lần dù webhook trùng', async () => {
  const { w, d, attempt } = await start({ controls: { dup_webhooks: 1 } });
  try {
    await d.pay(attempt);
    const cap = (await simState(d)).captures[0];
    const tok = (await (await fetch(`${d.sim.url}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${d.sim.config.clientId}:${d.sim.config.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json()).access_token;
    await fetch(`${d.sim.url}/v2/payments/captures/${cap.id}/refund`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount: { currency_code: 'USD', value: '5.00' } }) });
    assert.equal(anomalies(w.hub, 'funds_reversed').length, 1);
    assert.equal(attempt.reversedTotal, 500);
  } finally { await w.close(); }
});

test('[paypal] tiền theo đơn vị nhỏ nhất qua cả Hub: JPY và USD ghi nhận đúng số tiền; VND không bao giờ tới PayPal', async () => {
  const w = await createWorld(['paypal'], {}, { paypal: {} });
  const d = w.drivers.paypal;
  try {
    for (const [currency, amount] of [['JPY', 500], ['USD', 1999], ['EUR', 5]]) {
      const { payment, attempt } = await w.hub.createPayment(order({ currency, amount }));
      await d.pay(attempt);
      assert.equal(payment.status, 'PAID', currency);
      assert.equal(payment.amount, amount);
    }
    await assert.rejects(w.hub.createPayment(order({ currency: 'VND', amount: 150000 })), { code: 'no_gateway_available' });
    assert.equal((await simState(d)).orders.length, 3, 'không có order nào cho VND');
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

test('[paypal] cùng Hub với Stripe: VND đi Stripe, USD đi PayPal theo ưu tiên; lõi không biết tên cổng', async () => {
  const w = await createWorld(['paypal', 'stripe'], {}, { paypal: {}, stripe: {} });
  try {
    const a = await w.hub.createPayment(order({ currency: 'USD', amount: 1999 }));
    assert.equal(a.attempt.gateway, 'paypal');
    const b = await w.hub.createPayment(order({ currency: 'VND', amount: 150000 }));
    assert.equal(b.attempt.gateway, 'stripe');
    await w.drivers.paypal.pay(a.attempt);
    await w.drivers.stripe.pay(b.attempt);
    assert.equal(a.payment.status, 'PAID');
    assert.equal(b.payment.status, 'PAID');
    assert.equal(anomalies(w.hub).length, 0);
  } finally { await w.close(); }
});

'use strict';
// spec: PHUB-S-001
// spec: PHUB-S-002
// spec: PHUB-S-005
// spec: PHUB-S-006
// Kiểm tra lõi Hub bằng adapter giả: quy tắc nhất quán tiền, routing, failover, đối soát, hoàn tiền.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

function setup(opts = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a', opts.capsA);
  const b = createFakeAdapter('b', opts.capsB);
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a, b },
    clock,
    newRef: (p) => `${p}${++n}`,
    config: {
      gateways: [
        { id: 'a', priority: 1, products: opts.productsA },
        { id: 'b', priority: 2, minAmount: opts.minB },
      ],
      reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120], maxAgeSeconds: 3600 },
      paymentTtlSeconds: 1800,
    },
  });
  return { hub, a, b, clock };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });
// Cổng xác nhận (qua query) rằng attempt đã nhận tiền.
const confirmByQuery = (fake, attempt, txn = 'T1') => fake.queryResults.set(attempt.ref, { gateway: fake.id, attemptRef: attempt.ref, type: 'succeeded', amount: attempt.amount, gatewayTxnId: txn, occurredAt: 1, source: 'query' });
const cb = (gw, hub, body, channel = 'ipn') => hub.handleCallback(gw, { channel, method: 'GET', query: {}, body, headers: {} });
const ev = (attempt, type, extra = {}) => ({ ref: attempt.ref, type, amount: attempt.amount, txn: 'T1', ...extra });

test('routing chọn cổng theo priority, product và khoảng tiền', async () => {
  const s = setup({ productsA: ['card'], minB: 50000 });
  const r1 = await s.hub.createPayment(order({ product: 'card' }));
  assert.equal(r1.attempt.gateway, 'a');
  const r2 = await s.hub.createPayment(order({ orderId: 'O2', product: 'wallet' }));
  assert.equal(r2.attempt.gateway, 'b');
  // không cổng nào phù hợp (a không hỗ trợ product, b dưới số tiền tối thiểu): từ chối, không chọn bừa
  await assert.rejects(s.hub.createPayment(order({ orderId: 'O3', product: 'wallet', amount: 1000 })), { code: 'no_gateway_available' });
});

test('IPN thành công đưa payment sang PAID; IPN trùng không đổi gì', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  const r1 = await cb('a', hub, ev(attempt, 'succeeded'));
  assert.equal(r1.outcome, 'ok');
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(payment.status, 'PAID');
  const before = JSON.stringify(hub.getPayment(payment.id));
  const r2 = await cb('a', hub, ev(attempt, 'succeeded'));
  assert.equal(r2.outcome, 'duplicate');
  assert.equal(JSON.stringify(hub.getPayment(payment.id)), before);
  assert.equal(hub.listAnomalies().length, 0);
});

test('return URL chỉ để hiển thị, không đổi trạng thái', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'succeeded'), 'return');
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(payment.status, 'OPEN');
});

test('chữ ký sai: từ chối, không đổi trạng thái', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order());
  const r = await cb('a', hub, { valid: false });
  assert.equal(r.outcome, 'invalid_signature');
  assert.equal(attempt.status, 'AWAITING');
});

test('sai số tiền: giữ lại, anomaly, vẫn báo mismatch ở lần gửi lại', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  const r1 = await cb('a', hub, ev(attempt, 'succeeded', { amount: 99999 }));
  const r2 = await cb('a', hub, ev(attempt, 'succeeded', { amount: 99999 }));
  assert.equal(r1.outcome, 'amount_mismatch');
  assert.equal(r2.outcome, 'amount_mismatch');
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(payment.status, 'OPEN');
  assert.equal(hub.listAnomalies({ type: 'amount_mismatch' }).length, 1);
});

test('callback cho attempt lạ: anomaly và outcome unknown_attempt', async () => {
  const { hub } = setup();
  const r = await cb('a', hub, { ref: 'nope', type: 'succeeded', amount: 1, txn: 'X' });
  assert.equal(r.outcome, 'unknown_attempt');
  assert.equal(hub.listAnomalies({ type: 'unknown_attempt' }).length, 1);
});

test('failed rồi succeeded muộn: attempt giữ FAILED, tiền được ghi là late_success', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'failed'));
  assert.equal(attempt.status, 'FAILED');
  const r = await cb('a', hub, ev(attempt, 'succeeded'));
  assert.equal(r.outcome, 'ok');
  assert.equal(attempt.status, 'FAILED');
  assert.equal(hub.listAnomalies({ type: 'late_success' }).length, 1);
});

test('succeeded rồi failed: giữ SUCCEEDED, ghi conflicting_result', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'succeeded'));
  await cb('a', hub, ev(attempt, 'failed'));
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(payment.status, 'PAID');
  assert.equal(hub.listAnomalies({ type: 'conflicting_result' }).length, 1);
});

test('hai attempt cùng thành công: duplicate_charge, payment chỉ PAID một lần', async () => {
  const { hub, a } = setup();
  const { payment, attempt: a1 } = await hub.createPayment(order());
  await cb('a', hub, ev(a1, 'failed'));
  const { attempt: a2 } = await hub.createAttempt(payment.id);
  assert.notEqual(a1.ref, a2.ref);
  await cb('a', hub, ev(a2, 'succeeded', { txn: 'T2' }));
  await cb('a', hub, ev(a1, 'succeeded', { txn: 'T1' })); // attempt cũ cũng thu tiền
  assert.equal(payment.status, 'PAID');
  assert.equal(payment.paidByAttempt, a2.id);
  assert.equal(hub.listAnomalies({ type: 'duplicate_charge' }).length, 1);
  assert.ok(a);
});

test('không tạo attempt mới khi attempt cũ còn có thể nhận tiền', async () => {
  const { hub } = setup();
  const { payment } = await hub.createPayment(order());
  await assert.rejects(hub.createAttempt(payment.id, { reason: 'failover' }), { code: 'attempt_still_live' });
});

test('failover sang cổng khác sau khi attempt cũ FAILED', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'failed'));
  const r = await hub.createAttempt(payment.id, { reason: 'failover' });
  assert.equal(r.attempt.gateway, 'b');
});

test('failover tắt thì bị từ chối; quá maxAttempts bị từ chối', async () => {
  const { hub } = setup();
  hub.config.failover.enabled = false;
  const { payment, attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'failed'));
  await assert.rejects(hub.createAttempt(payment.id, { reason: 'failover' }), { code: 'failover_disabled' });
  hub.config.failover.enabled = true;
  hub.config.failover.maxAttempts = 1;
  await assert.rejects(hub.createAttempt(payment.id), { code: 'max_attempts' });
});

test('cổng từ chối lúc tạo: chuyển ngay sang cổng kế (chắc chắn chưa có giao dịch)', async () => {
  const { hub, a } = setup();
  a.createMode = 'rejected';
  const { attempt, payment } = await hub.createPayment(order());
  assert.equal(attempt.gateway, 'b');
  const attempts = hub.getPayment(payment.id).attempts;
  assert.equal(attempts[0].status, 'FAILED');
});

test('tạo mất phản hồi (unknown): không failover; đối soát bằng query tìm ra thanh toán', async () => {
  const { hub, a, clock } = setup({ capsA: { caps: { createCanTimeout: true } } });
  a.createMode = 'unknown';
  const { payment, attempt } = await hub.createPayment(order());
  assert.equal(attempt.status, 'UNKNOWN');
  assert.equal(attempt.gateway, 'a');
  await assert.rejects(hub.createAttempt(payment.id, { reason: 'failover' }), { code: 'attempt_still_live' });
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'succeeded', amount: attempt.amount, gatewayTxnId: 'TQ', occurredAt: 1, source: 'query' });
  clock.advance(61);
  await hub.reconcile();
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(payment.status, 'PAID');
});

test('lỗi mạng khi tạo ở cổng createCanTimeout được coi là unknown, không phải failed', async () => {
  const { hub, a } = setup({ capsA: { caps: { createCanTimeout: true } } });
  a.createMode = 'throw';
  const { attempt } = await hub.createPayment(order());
  assert.equal(attempt.status, 'UNKNOWN');
});

test('IPN mất hẳn: đối soát theo lịch backoff tìm ra kết quả', async () => {
  const { hub, a, clock } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  clock.advance(30);
  assert.equal((await hub.reconcile()).queried, 0); // chưa đến lịch
  clock.advance(31);
  assert.equal((await hub.reconcile()).queried, 1);
  assert.equal(attempt.status, 'AWAITING'); // not_found: không đổi
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'succeeded', amount: attempt.amount, gatewayTxnId: 'TQ', occurredAt: 1, source: 'query' });
  clock.advance(61);
  await hub.reconcile();
  assert.equal(payment.status, 'PAID');
});

test('query not_found hoặc pending không bao giờ làm attempt thành failed/expired', async () => {
  const { hub, a, clock } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'pending', amount: attempt.amount, occurredAt: 1, source: 'query' });
  for (let i = 0; i < 5; i += 1) { clock.advance(200); await hub.reconcile(); }
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(payment.status, 'OPEN'); // quá hạn đơn nhưng attempt còn có thể nhận tiền: không đóng
});

test('quá maxAge mà chưa rõ: gắn cờ người vận hành, không tự kết luận', async () => {
  const { hub, clock } = setup();
  const { attempt } = await hub.createPayment(order());
  clock.advance(3601);
  await hub.reconcile();
  assert.equal(attempt.needsOperator, true);
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(hub.listAnomalies({ type: 'stale_attempt' }).length, 1);
});

test('payment đóng khi hết hạn và không còn attempt có thể nhận tiền; thành công muộn sau đó là late_success', async () => {
  const { hub, clock } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'expired'));
  assert.equal(attempt.status, 'EXPIRED');
  assert.equal(payment.status, 'OPEN'); // chưa quá hạn đơn
  clock.advance(1801);
  await hub.reconcile();
  assert.equal(payment.status, 'CLOSED');
  await cb('a', hub, ev(attempt, 'succeeded'));
  assert.equal(attempt.status, 'EXPIRED');
  assert.equal(payment.status, 'CLOSED');
  assert.equal(hub.listAnomalies({ type: 'late_success' }).length, 1);
});

test('thành công đến khi payment đã CLOSED và attempt còn sống: SUCCEEDED + late_success, payment vẫn CLOSED', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  payment.status = 'CLOSED';
  await cb('a', hub, ev(attempt, 'succeeded'));
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(payment.status, 'CLOSED');
  assert.equal(hub.listAnomalies({ type: 'late_success' }).length, 1);
});

test('xử lý late_success: refund qua anomaly, hoặc apply khi payment còn mở', async () => {
  const { hub, a } = setup();
  const p1 = await hub.createPayment(order());
  await cb('a', hub, ev(p1.attempt, 'failed'));
  await cb('a', hub, ev(p1.attempt, 'succeeded'));
  confirmByQuery(a, p1.attempt);
  const [an] = hub.listAnomalies({ type: 'late_success' });
  await hub.resolveAnomaly(an.id, { action: 'apply' });
  assert.equal(p1.payment.status, 'PAID');

  const p2 = await hub.createPayment(order({ orderId: 'O2' }));
  await cb('a', hub, ev(p2.attempt, 'failed', { txn: 'Z' }));
  await cb('a', hub, ev(p2.attempt, 'succeeded', { txn: 'Z' }));
  confirmByQuery(a, p2.attempt, 'Z');
  const an2 = hub.listAnomalies({ type: 'late_success' }).find((x) => x.attemptId === p2.attempt.id);
  const done = await hub.resolveAnomaly(an2.id, { action: 'refund' });
  assert.equal(done.status, 'refunding');
  assert.equal(hub.store.getRefund(done.refundId).amount, 100000);
});

test('hoàn tiền bất đồng bộ: PROCESSING rồi đối soát ra SUCCEEDED; không hoàn quá số đã thu', async () => {
  const { hub, a, clock } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'succeeded'));
  const r = await hub.refund({ attemptId: attempt.id, amount: 40000 });
  assert.equal(r.status, 'PROCESSING');
  await assert.rejects(hub.refund({ attemptId: attempt.id, amount: 70000 }), { code: 'invalid_refund_amount' });
  a.queryRefundStatus = 'succeeded';
  clock.advance(61);
  await hub.reconcile();
  assert.equal(r.status, 'SUCCEEDED');
});

test('hoàn tiền thất bại muộn được ghi nhận và cho phép hoàn lại phần đó', async () => {
  const { hub, a, clock } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'succeeded'));
  const r = await hub.refund({ attemptId: attempt.id, amount: 100000 });
  a.queryRefundStatus = 'failed';
  clock.advance(61);
  await hub.reconcile();
  assert.equal(r.status, 'FAILED');
  const r2 = await hub.refund({ attemptId: attempt.id, amount: 100000 });
  assert.notEqual(r2.id, r.id);
});

test('cổng không có API hoàn: MANUAL_REQUIRED rồi xác nhận thủ công', async () => {
  const { hub } = setup({ capsA: { caps: { refundable: 'manual' } } });
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'succeeded'));
  const r = await hub.refund({ attemptId: attempt.id });
  assert.equal(r.status, 'MANUAL_REQUIRED');
  assert.equal((await hub.markRefundDone(r.id)).status, 'SUCCEEDED');
});

test('không hoàn được attempt chưa nhận tiền', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order());
  await assert.rejects(hub.refund({ attemptId: attempt.id }), { code: 'nothing_to_refund' });
});

test('đầu vào không hợp lệ bị từ chối', async () => {
  const { hub } = setup();
  await assert.rejects(hub.createPayment(order({ amount: 10.5 })), { code: 'invalid_input' });
  await assert.rejects(hub.createPayment(order({ amount: 0 })), { code: 'invalid_input' });
});

test('qua hạn cứng của cổng: hỏi lại bắt buộc một lần; chưa rõ thì báo người vận hành, không tự kết luận', async () => {
  const { hub, a, clock } = setup({ capsA: { caps: { hardExpiry: { minutes: 30 } } } });
  const { payment, attempt } = await hub.createPayment(order());
  clock.advance(25 * 60);
  await hub.reconcile();
  assert.equal(hub.listAnomalies({ type: 'expiry_unresolved' }).length, 0, 'chưa qua hạn cứng');
  clock.advance(7 * 60); // 32 phút > 30 phút + đệm
  await hub.reconcile();
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(attempt.needsOperator, true);
  assert.equal(hub.listAnomalies({ type: 'expiry_unresolved' }).length, 1);
  clock.advance(600);
  await hub.reconcile();
  assert.equal(hub.listAnomalies({ type: 'expiry_unresolved' }).length, 1, 'chỉ báo một lần');
  assert.equal(payment.status, 'OPEN');
  assert.ok(a);
});

test('qua hạn cứng: cổng xác nhận expired thì attempt EXPIRED, không có cảnh báo', async () => {
  const { hub, a, clock } = setup({ capsA: { caps: { hardExpiry: { minutes: 30 } } } });
  const { attempt } = await hub.createPayment(order());
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'expired', amount: attempt.amount, occurredAt: 1, source: 'query' });
  clock.advance(32 * 60);
  await hub.reconcile();
  assert.equal(attempt.status, 'EXPIRED');
  assert.equal(hub.listAnomalies({ type: 'expiry_unresolved' }).length, 0);
});

test('hardExpiry unknown hoặc gateway-fixed: không có hỏi lại bắt buộc', async () => {
  const { hub, clock } = setup(); // mặc định unknown
  const { attempt } = await hub.createPayment(order());
  clock.advance(3000);
  await hub.reconcile();
  assert.equal(attempt.finalQueryDone, undefined);
  assert.equal(hub.listAnomalies({ type: 'expiry_unresolved' }).length, 0);
});

// ---------- phân xử bằng query (PHUB-D-002 mục 9) ----------
test('phân xử: late_success được cổng xác nhận qua reconcile (verdict success)', async () => {
  const { hub, a, clock } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'failed'));
  await cb('a', hub, ev(attempt, 'succeeded'));
  confirmByQuery(a, attempt);
  clock.advance(61);
  await hub.reconcile();
  const [an] = hub.listAnomalies({ type: 'late_success' });
  assert.equal(an.arbiter.verdict, 'success');
  assert.equal(attempt.status, 'FAILED', 'trạng thái cuối không đổi');
});

test('phân xử: cổng nói không có tiền thì không cho hoàn tiền, trừ khi force', async () => {
  const { hub, a } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'failed'));
  await cb('a', hub, ev(attempt, 'succeeded')); // thông báo nói có tiền
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'failed', amount: attempt.amount, occurredAt: 1, source: 'query' });
  const [an] = hub.listAnomalies({ type: 'late_success' });
  await assert.rejects(hub.resolveAnomaly(an.id, { action: 'refund' }), { code: 'not_confirmed' });
  assert.equal(an.arbiter.verdict, 'failure');
  assert.equal(an.status, 'open');
  const done = await hub.resolveAnomaly(an.id, { action: 'refund', force: true, note: 'đã kiểm tra sao kê ngân hàng' });
  assert.equal(done.status, 'refunding');
});

test('phân xử: cổng chưa trả lời được (unknown) thì thử lại theo lịch, chưa cho hoàn tiền', async () => {
  const { hub, a, clock } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'failed'));
  await cb('a', hub, ev(attempt, 'succeeded'));
  const [an] = hub.listAnomalies({ type: 'late_success' });
  await hub.reconcile();
  assert.equal(an.arbiter.verdict, 'unknown');
  const firstAt = an.arbiter.at;
  clock.advance(10);
  await hub.reconcile();
  assert.equal(an.arbiter.at, firstAt, 'chưa tới lịch hỏi lại');
  confirmByQuery(a, attempt);
  clock.advance(61);
  await hub.reconcile();
  assert.equal(an.arbiter.verdict, 'success');
});

test('phân xử: IPN nói failed sau khi đã SUCCEEDED, query xác nhận success thì kết quả cũ đứng vững, không cần người xem', async () => {
  const { hub, a, clock } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'succeeded'));
  await cb('a', hub, ev(attempt, 'failed'));
  confirmByQuery(a, attempt);
  clock.advance(61);
  await hub.reconcile();
  const [an] = hub.listAnomalies({ type: 'conflicting_result' });
  assert.equal(an.arbiter.verdict, 'success');
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(attempt.needsOperator, false);
});

test('phân xử: IPN nói failed sau SUCCEEDED, cổng không xác nhận success thì gắn cờ người vận hành', async () => {
  const { hub, a, clock } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ev(attempt, 'succeeded'));
  await cb('a', hub, ev(attempt, 'failed'));
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'failed', amount: attempt.amount, occurredAt: 1, source: 'query' });
  clock.advance(61);
  await hub.reconcile();
  assert.equal(attempt.status, 'SUCCEEDED', 'không đổi trạng thái cuối');
  assert.equal(attempt.needsOperator, true);
});

test('cổng bắt khách gửi form POST: method và fields được giữ trên attempt; cổng GET thì method mặc định GET và không có fields', async () => {
  const { hub, a } = setup();
  a.createMode = 'post_form';
  const post = await hub.createPayment(order({ orderId: 'POST1' }));
  assert.equal(post.attempt.status, 'AWAITING');
  assert.equal(post.attempt.method, 'POST');
  assert.deepEqual(post.attempt.fields, { order: post.attempt.ref, signature: 'SIG' });
  a.createMode = 'redirect';
  const get = await hub.createPayment(order({ orderId: 'GET1' }));
  assert.equal(get.attempt.method, undefined);
  assert.equal(get.attempt.fields, undefined);
});

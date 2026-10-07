'use strict';
// spec: PHUB-S-037
// Giữ tiền rồi thu sau (PHUB-D-037): authorized -> capture hoặc void. Điểm cốt lõi là tiền: khoản giữ không phải tiền đã thu, không được tạo attempt khác
// trong lúc giữ, thu hay nhả mất phản hồi thì KHÔNG coi là thất bại mà đối soát lại, và không thu hai lần.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { assertEvent, assertAdapterShape } = require('../../src/contract');
const { createApp } = require('../../src/app/app');
const { PostgresStore } = require('../../src/store-postgres');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

const OPS = ['purchase', 'authorize', 'capture', 'void'];
const REC = { firstAfterSeconds: 60, backoffSeconds: [60, 120], maxAgeSeconds: 3600 };
const setup = (caps = { operations: OPS }, extra = {}) => {
  const a = createFakeAdapter('a', { caps });
  const clock = createClock();
  const hub = new PaymentHub({ adapters: { a }, clock, config: { gateways: [{ id: 'a' }], reconcile: REC, paymentTtlSeconds: 1800, ...extra } });
  return { a, hub, clock };
};
const cb = (hub, body) => hub.handleCallback('a', { channel: 'ipn', method: 'POST', query: {}, headers: {}, body });
const order = (o = {}) => ({ orderId: `O${Math.random().toString(36).slice(2, 8)}`, amount: 100000, returnUrl: 'https://s/r', ...o });
const held = async (ctx, o = {}) => {
  const { payment, attempt } = await ctx.hub.createPayment(order(o));
  const r = await cb(ctx.hub, { ref: attempt.ref, type: 'authorized', amount: payment.amount, txn: 'AUTH1' });
  assert.equal(r.outcome, 'ok');
  assert.equal(attempt.status, 'AUTHORIZED');
  return { payment, attempt };
};
const queryEvent = (attempt, type, extra = {}) => ({ gateway: 'a', attemptRef: attempt.ref, type, amount: attempt.amount, gatewayTxnId: 'AUTH1', occurredAt: 0, source: 'query', ...extra });

test('hợp đồng: sự kiện authorized cần gatewayTxnId; khai capture hoặc void trong operations mà thiếu hàm thì adapter bị từ chối', () => {
  const ev = { gateway: 'a', attemptRef: 'R', type: 'authorized', amount: 5, occurredAt: 0, source: 'ipn' };
  assert.throws(() => assertEvent(ev), /thiếu gatewayTxnId/);
  assert.equal(assertEvent({ ...ev, gatewayTxnId: 'T' }), true);
  const a = createFakeAdapter('a', { caps: { operations: OPS } });
  assert.equal(assertAdapterShape(a), true);
  delete a.capture;
  assert.throws(() => assertAdapterShape(a), /thiếu hàm capture/);
});

test('authorized: attempt thành AUTHORIZED, đơn vẫn OPEN (khoản giữ chưa phải tiền đã thu); pending đến sau không hạ trạng thái', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  assert.equal(payment.status, 'OPEN');
  assert.equal(attempt.gatewayTxnId, 'AUTH1');
  assert.ok(attempt.authorizedAt);
  await cb(ctx.hub, { ref: attempt.ref, type: 'pending', amount: 100000, txn: 'X' });
  assert.equal(attempt.status, 'AUTHORIZED');
});

test('authorized sai số tiền: giữ lại như amount_mismatch, attempt không đổi', async () => {
  const ctx = setup();
  const { attempt } = await ctx.hub.createPayment(order());
  const r = await cb(ctx.hub, { ref: attempt.ref, type: 'authorized', amount: 99999, txn: 'A' });
  assert.equal(r.outcome, 'amount_mismatch');
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(ctx.hub.listAnomalies({ type: 'amount_mismatch' }).length, 1);
});

test('đang giữ tiền: không tạo được attempt khác (kể cả cancelLive), đơn không bị đóng khi qua hạn thanh toán', async () => {
  const ctx = setup({ operations: OPS, cancellable: true });
  const { payment, attempt } = await held(ctx);
  await assert.rejects(ctx.hub.createAttempt(payment.id, { reason: 'customer_retry', cancelLive: true }), { code: 'attempt_still_live' });
  assert.deepEqual(ctx.a.cancelled, []); // không dùng cancel cho khoản đang giữ (thao tác đúng là void)
  ctx.clock.advance(1800 + 120);
  await ctx.hub.reconcile();
  assert.equal(payment.status, 'OPEN');
  assert.equal(attempt.status, 'AUTHORIZED');
});

test('capture thành công: đơn PAID theo đúng đường succeeded; gọi cổng một lần với khóa idempotency ổn định; gọi lại không thu thêm', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  const r = await ctx.hub.capturePayment({ paymentId: payment.id });
  assert.equal(r.outcome, 'captured');
  assert.equal(payment.status, 'PAID');
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(payment.paidByAttempt, attempt.id);
  assert.equal(ctx.a.calls.capture.length, 1);
  assert.equal(ctx.a.calls.capture[0].idempotencyKey, `${attempt.id}:capture`);
  assert.equal(ctx.a.calls.capture[0].amount, 100000);
  assert.equal(ctx.a.calls.capture[0].gatewayTxnId, 'AUTH1');
  await assert.rejects(ctx.hub.capturePayment({ paymentId: payment.id }), { code: 'payment_not_open' });
  assert.equal(ctx.a.calls.capture.length, 1);
  // thông báo thu của cổng đến sau (cùng mã giao dịch) chỉ là trùng, không phải khoản thu thứ hai
  const late = await cb(ctx.hub, { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'AUTH1' });
  assert.equal(late.outcome, 'duplicate');
  assert.equal(ctx.hub.listAnomalies({ type: 'duplicate_charge' }).length, 0);
});

test('capture bị cổng từ chối chắc chắn: báo lỗi, khoản giữ vẫn còn, làm lại được', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  ctx.a.captureMode = 'rejected';
  await assert.rejects(ctx.hub.capturePayment({ paymentId: payment.id }), (e) => e.code === 'capture_rejected' && /fake_capture_rejected/.test(e.message));
  assert.equal(attempt.status, 'AUTHORIZED');
  assert.equal(attempt.op, null);
  assert.equal(payment.status, 'OPEN');
  ctx.a.captureMode = 'captured';
  assert.equal((await ctx.hub.capturePayment({ paymentId: payment.id })).outcome, 'captured');
  assert.equal(payment.status, 'PAID');
});

test('capture mất phản hồi (unknown hoặc lỗi mạng): KHÔNG coi là thất bại, đơn chưa PAID, chặn thu lần hai, đối soát thấy đã thu thì PAID mà không gọi cổng thu lại', async () => {
  for (const mode of ['unknown', 'throw']) {
    const ctx = setup();
    const { payment, attempt } = await held(ctx);
    ctx.a.captureMode = mode;
    const r = await ctx.hub.capturePayment({ paymentId: payment.id });
    assert.equal(r.outcome, 'unknown', mode);
    assert.equal(attempt.status, 'AUTHORIZED');
    assert.equal(attempt.op.status, 'UNKNOWN');
    assert.equal(payment.status, 'OPEN');
    await assert.rejects(ctx.hub.capturePayment({ paymentId: payment.id }), { code: 'op_in_progress' });
    assert.equal(ctx.a.calls.capture.length, 1);
    ctx.a.queryResults.set(attempt.ref, queryEvent(attempt, 'succeeded'));
    ctx.clock.advance(120);
    await ctx.hub.reconcile();
    assert.equal(payment.status, 'PAID', mode);
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(attempt.op, null);
    assert.equal(ctx.a.calls.capture.length, 1);
  }
});

test('capture mất phản hồi rồi cổng nói khoản giữ vẫn còn: thao tác chưa xảy ra, cho thu lại', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  ctx.a.captureMode = 'unknown';
  await ctx.hub.capturePayment({ paymentId: payment.id });
  ctx.a.queryResults.set(attempt.ref, queryEvent(attempt, 'authorized'));
  ctx.clock.advance(120);
  await ctx.hub.reconcile();
  assert.equal(attempt.op, null);
  assert.equal(attempt.status, 'AUTHORIZED');
  ctx.a.captureMode = 'captured';
  assert.equal((await ctx.hub.capturePayment({ paymentId: payment.id })).outcome, 'captured');
  assert.equal(payment.status, 'PAID');
});

test('cổng chưa nhận lời gọi (breaker mở): gateway_unavailable, chắc chắn chưa thu, gọi lại được', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  ctx.a.captureMode = 'not_sent';
  await assert.rejects(ctx.hub.capturePayment({ paymentId: payment.id }), { code: 'gateway_unavailable' });
  assert.equal(attempt.op, null);
  ctx.a.captureMode = 'captured';
  assert.equal((await ctx.hub.capturePayment({ paymentId: payment.id })).outcome, 'captured');
});

test('hai lệnh capture cùng lúc: chỉ một lệnh tới cổng, lệnh kia bị op_in_progress', async () => {
  const ctx = setup();
  const { payment } = await held(ctx);
  const results = await Promise.allSettled([ctx.hub.capturePayment({ paymentId: payment.id }), ctx.hub.capturePayment({ paymentId: payment.id })]);
  assert.equal(ctx.a.calls.capture.length, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && /op_in_progress|payment_not_open/.test(r.reason.code)).length, 1);
  assert.equal(payment.status, 'PAID');
});

test('void thành công: attempt CANCELLED, đơn vẫn OPEN nên khách thử lại được', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  const r = await ctx.hub.voidPayment({ paymentId: payment.id });
  assert.equal(r.outcome, 'voided');
  assert.equal(attempt.status, 'CANCELLED');
  assert.equal(payment.status, 'OPEN');
  assert.equal(ctx.a.calls.void[0].idempotencyKey, `${attempt.id}:void`);
  const again = await ctx.hub.createAttempt(payment.id, { reason: 'customer_retry' });
  assert.ok(again.attempt);
  await assert.rejects(ctx.hub.voidPayment({ paymentId: payment.id }), { code: 'invalid_state' }); // attempt mới chưa giữ tiền
});

test('void mất phản hồi: chưa kết luận; cổng báo đã nhả thì attempt CANCELLED', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  ctx.a.voidMode = 'unknown';
  assert.equal((await ctx.hub.voidPayment({ paymentId: payment.id })).outcome, 'unknown');
  assert.equal(attempt.status, 'AUTHORIZED');
  await assert.rejects(ctx.hub.capturePayment({ paymentId: payment.id }), { code: 'op_in_progress' }); // đang chờ xác nhận nhả: không thu
  ctx.a.queryResults.set(attempt.ref, queryEvent(attempt, 'cancelled'));
  ctx.clock.advance(120);
  await ctx.hub.reconcile();
  assert.equal(attempt.status, 'CANCELLED');
  assert.equal(attempt.op, null);
});

test('cổng không khai capture hoặc void: not_supported; không có khoản giữ: invalid_state', async () => {
  const ctx = setup({});
  const { payment, attempt } = await ctx.hub.createPayment(order());
  await assert.rejects(ctx.hub.capturePayment({ paymentId: payment.id }), { code: 'invalid_state' }); // chưa giữ
  await cb(ctx.hub, { ref: attempt.ref, type: 'authorized', amount: 100000, txn: 'A' });
  await assert.rejects(ctx.hub.capturePayment({ paymentId: payment.id }), { code: 'not_supported' });
  await assert.rejects(ctx.hub.voidPayment({ paymentId: payment.id }), { code: 'not_supported' });
  assert.equal(attempt.status, 'AUTHORIZED');
  await assert.rejects(ctx.hub.capturePayment({ paymentId: 'pay_khong_co' }), { code: 'not_found' });
});

test('authorized đến muộn trên attempt đã đóng, hoặc khi đơn đã PAID bởi attempt khác: late_authorization cho người vận hành, chỉ ignore', async () => {
  const ctx = setup();
  const { payment, attempt } = await ctx.hub.createPayment(order());
  await cb(ctx.hub, { ref: attempt.ref, type: 'failed', amount: 100000, txn: 'F' });
  assert.equal(attempt.status, 'FAILED');
  assert.equal((await cb(ctx.hub, { ref: attempt.ref, type: 'authorized', amount: 100000, txn: 'A1' })).outcome, 'ok');
  assert.equal(attempt.status, 'FAILED'); // trạng thái cuối bất biến
  const late = ctx.hub.listAnomalies({ type: 'late_authorization' });
  assert.equal(late.length, 1);
  assert.equal(attempt.needsOperator, true);
  await assert.rejects(ctx.hub.resolveAnomaly(late[0].id, { action: 'refund', force: true }), { code: 'invalid_state' });
  await ctx.hub.resolveAnomaly(late[0].id, { action: 'ignore', note: 'đã nhả ở cổng' });
  assert.equal(payment.status, 'OPEN');

  // đơn không còn OPEN (ví dụ đã PAID bởi một đường khác) mà attempt còn sống lại báo giữ tiền: khoản giữ không còn ai thu
  const two = setup();
  const live = await two.hub.createPayment(order());
  live.payment.status = 'PAID';
  await cb(two.hub, { ref: live.attempt.ref, type: 'authorized', amount: 100000, txn: 'A2' });
  assert.equal(live.attempt.status, 'AUTHORIZED');
  assert.equal(live.attempt.needsOperator, true);
  assert.equal(two.hub.listAnomalies({ type: 'late_authorization' }).length, 1);
});

test('giữ tiền quá lâu mà không ai thu hay nhả: anomaly authorization_stale (Hub không tự thu hay nhả)', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  ctx.clock.advance(3600 + 60);
  await ctx.hub.reconcile();
  assert.equal(ctx.hub.listAnomalies({ type: 'authorization_stale' }).length, 1);
  assert.equal(ctx.hub.listAnomalies({ type: 'stale_attempt' }).length, 0);
  assert.equal(attempt.status, 'AUTHORIZED');
  assert.equal(payment.status, 'OPEN');
  assert.equal(ctx.a.calls.capture.length + ctx.a.calls.void.length, 0);
});

test('cổng báo khoản giữ đã hết hạn (expired): attempt EXPIRED, đơn không bị kẹt', async () => {
  const ctx = setup();
  const { payment, attempt } = await held(ctx);
  await cb(ctx.hub, { ref: attempt.ref, type: 'expired', amount: 100000, txn: 'AUTH1' });
  assert.equal(attempt.status, 'EXPIRED');
  ctx.clock.advance(1800 + 60);
  await ctx.hub.reconcile();
  assert.equal(payment.status, 'CLOSED');
});

test('API: capturePayment trả outcome và payment; token cửa hàng khác không thấy payment (not_found)', async () => {
  const ctx = setup();
  const app = createApp({ hub: ctx.hub });
  const { payment } = await held(ctx);
  await assert.rejects(app.execute('capturePayment', { paymentId: payment.id }, { role: 'shop', id: 'other' }), { code: 'not_found' });
  assert.equal(ctx.a.calls.capture.length, 0);
  const r = await app.execute('capturePayment', { paymentId: payment.id }, { role: 'admin' });
  assert.equal(r.outcome, 'captured');
  assert.equal(r.payment.status, 'PAID');
  assert.equal(r.attempt.status, 'SUCCEEDED');
});

// ---- trên PostgreSQL thật: khoản giữ sống qua khởi động lại ----
test('PostgreSQL: AUTHORIZED và thao tác chưa rõ sống qua khởi động lại; thu xong thì PAID bền', { skip: SKIP }, async () => {
  const db = freshDb();
  const a = createFakeAdapter('a', { caps: { operations: OPS } });
  const clock = createClock();
  const boot = (store) => new PaymentHub({ adapters: { a }, clock, store, config: { gateways: [{ id: 'a' }], reconcile: REC, paymentTtlSeconds: 1800 } });
  try {
    const s1 = await db.open();
    const hub1 = boot(s1);
    const { payment, attempt } = await hub1.createPayment(order({ orderId: 'PG1' }));
    await cb(hub1, { ref: attempt.ref, type: 'authorized', amount: 100000, txn: 'AUTH1' });
    a.captureMode = 'unknown';
    assert.equal((await hub1.capturePayment({ paymentId: payment.id })).outcome, 'unknown');
    await s1.close();

    const s2 = await db.open();
    const hub2 = boot(s2);
    await hub2.store.hydratePayment(payment.id);
    const again = hub2.store.attemptsOfPayment(payment.id)[0];
    assert.equal(again.status, 'AUTHORIZED');
    assert.equal(again.op.status, 'UNKNOWN');
    assert.equal(hub2.store.getPayment(payment.id).status, 'OPEN');
    await assert.rejects(hub2.capturePayment({ paymentId: payment.id }), { code: 'op_in_progress' });
    a.queryResults.set(again.ref, queryEvent(again, 'succeeded'));
    clock.advance(120);
    await hub2.reconcile();
    assert.equal(hub2.store.getPayment(payment.id).status, 'PAID');
    await s2.close();

    const s3 = await db.open();
    const hub3 = boot(s3);
    await hub3.store.hydratePayment(payment.id);
    assert.equal(hub3.store.getPayment(payment.id).status, 'PAID');
    assert.equal(hub3.store.attemptsOfPayment(payment.id)[0].status, 'SUCCEEDED');
    assert.equal(a.calls.capture.length, 1); // chỉ một lần gọi thu suốt ba lần khởi động
    await s3.close();
  } finally { await db.cleanup(); }
});

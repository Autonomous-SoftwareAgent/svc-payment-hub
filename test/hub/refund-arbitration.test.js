'use strict';
// spec: PHUB-S-038
// Hai sửa lõi (PHUB-D-038). (1) Hoàn khoản nằm trong cảnh báo (tiền về muộn, thu hai lần) dựa trên MỘT thông báo chưa kiểm: phải được cổng xác nhận
// tiền đã về trước khi hoàn, ở mọi đường (xử lý cảnh báo và hoàn trực tiếp), trừ khi người vận hành ép. (2) 'authorized' cùng giao dịch đến sau khi giao dịch
// đó đã thu hoặc đã nhả không phải là khoản giữ mồ côi (cổng không đảm bảo thứ tự).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createApp } = require('../../src/app/app');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const OPS = ['purchase', 'authorize', 'capture', 'void'];
const setup = (caps = { operations: OPS }) => {
  const a = createFakeAdapter('a', { caps });
  const hub = new PaymentHub({ adapters: { a }, clock: createClock(), config: { gateways: [{ id: 'a' }] } });
  return { a, hub };
};
const cb = (hub, body) => hub.handleCallback('a', { channel: 'ipn', method: 'POST', query: {}, headers: {}, body });
const order = () => ({ orderId: `O${Math.random().toString(36).slice(2, 8)}`, amount: 100000, returnUrl: 'https://s/r' });
const confirm = (a, attempt, type = 'succeeded', txn = 'LATE1') => a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type, amount: 100000, gatewayTxnId: txn, occurredAt: 0, source: 'query' });
// attempt đã FAILED rồi tiền về muộn: anomaly late_success
const lateMoney = async (ctx) => {
  const { attempt } = await ctx.hub.createPayment(order());
  await cb(ctx.hub, { ref: attempt.ref, type: 'failed', amount: 100000, txn: 'F1' });
  await cb(ctx.hub, { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'LATE1' });
  assert.equal(ctx.hub.listAnomalies({ type: 'late_success' }).length, 1);
  return attempt;
};

test('hoàn trực tiếp khoản tiền về muộn khi cổng chưa xác nhận: not_confirmed, không gọi hoàn ở cổng', async () => {
  for (const verdict of ['unknown', 'pending', 'failure']) {
    const ctx = setup();
    const attempt = await lateMoney(ctx);
    if (verdict === 'pending') ctx.a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'pending', occurredAt: 0, source: 'query' });
    if (verdict === 'failure') confirm(ctx.a, attempt, 'failed');
    await assert.rejects(ctx.hub.refund({ attemptId: attempt.id, amount: 100000 }), (e) => e.code === 'not_confirmed' && new RegExp(`verdict=${verdict}`).test(e.message), verdict);
    assert.equal(ctx.a.calls.refund.length, 0, verdict);
    assert.equal(ctx.hub.store.refundsOfAttempt(attempt.id).length, 0, 'không tạo bản ghi hoàn khi bị từ chối');
  }
});

test('hoàn trực tiếp khi cổng xác nhận tiền đã về: hoàn được, kết luận lưu trên anomaly', async () => {
  const ctx = setup();
  const attempt = await lateMoney(ctx);
  confirm(ctx.a, attempt);
  const r = await ctx.hub.refund({ attemptId: attempt.id, amount: 100000 });
  assert.ok(r.id);
  assert.equal(ctx.a.calls.refund.length, 1);
  assert.equal(ctx.hub.listAnomalies({ type: 'late_success' })[0].arbiter.verdict, 'success');
});

test('người vận hành ép (force): hoàn được dù cổng chưa xác nhận', async () => {
  const ctx = setup();
  const attempt = await lateMoney(ctx);
  const r = await ctx.hub.refund({ attemptId: attempt.id, amount: 100000, force: true });
  assert.ok(r.id);
  assert.equal(ctx.a.calls.refund.length, 1);
});

test('hoàn attempt đã SUCCEEDED bình thường không bị hỏi lại cổng (đường cũ không đổi)', async () => {
  const ctx = setup();
  const { attempt } = await ctx.hub.createPayment(order());
  await cb(ctx.hub, { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
  const r = await ctx.hub.refund({ attemptId: attempt.id, amount: 1000 });
  assert.ok(r.id);
  assert.equal(ctx.a.calls.query.length, 0);
});

test('đường xử lý cảnh báo (resolveAnomaly refund) vẫn hoạt động: không hỏi cổng hai lần', async () => {
  const ctx = setup();
  const attempt = await lateMoney(ctx);
  confirm(ctx.a, attempt);
  const an = ctx.hub.listAnomalies({ type: 'late_success' })[0];
  await ctx.hub.resolveAnomaly(an.id, { action: 'refund' });
  assert.equal(ctx.a.calls.refund.length, 1);
  assert.equal(ctx.a.calls.query.length, 1); // đã hỏi một lần ở resolveAnomaly, hoàn không hỏi lại
});

test('API: cửa hàng không được ép; quản trị ép được; cửa hàng hoàn khoản chưa xác nhận bị not_confirmed', async () => {
  const ctx = setup();
  const app = createApp({ hub: ctx.hub });
  const attempt = await lateMoney(ctx);
  await assert.rejects(app.execute('createRefund', { attemptId: attempt.id, force: true }, { role: 'shop', id: 'default' }), { code: 'forbidden' });
  await assert.rejects(app.execute('createRefund', { attemptId: attempt.id }, { role: 'shop', id: 'default' }), { code: 'not_confirmed' });
  assert.equal(ctx.a.calls.refund.length, 0);
  const r = await app.execute('createRefund', { attemptId: attempt.id, force: true }, { role: 'admin' });
  assert.ok(r.id);
  assert.equal(ctx.a.calls.refund.length, 1);
});

// ---- authorized đến sai thứ tự ----
test('authorized cùng giao dịch đến SAU succeeded (đảo thứ tự): không phải khoản giữ mồ côi', async () => {
  const ctx = setup();
  const { attempt } = await ctx.hub.createPayment(order());
  await cb(ctx.hub, { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'PI1' });
  assert.equal(attempt.status, 'SUCCEEDED');
  const r = await cb(ctx.hub, { ref: attempt.ref, type: 'authorized', amount: 100000, txn: 'PI1' });
  assert.equal(r.outcome, 'duplicate');
  assert.equal(ctx.hub.listAnomalies({ type: 'late_authorization' }).length, 0);
  assert.equal(attempt.needsOperator, false);
});

test('authorized cùng giao dịch đến SAU khi giao dịch đã nhả hoặc hết hạn: không anomaly', async () => {
  for (const type of ['cancelled', 'expired']) {
    const ctx = setup();
    const { attempt } = await ctx.hub.createPayment(order());
    await cb(ctx.hub, { ref: attempt.ref, type, amount: 100000, txn: 'PI2' });
    assert.notEqual(attempt.status, 'AWAITING');
    const r = await cb(ctx.hub, { ref: attempt.ref, type: 'authorized', amount: 100000, txn: 'PI2' });
    assert.equal(r.outcome, 'duplicate', type);
    assert.equal(ctx.hub.listAnomalies({ type: 'late_authorization' }).length, 0, type);
  }
});

test('authorized khác giao dịch, hoặc sau FAILED: vẫn là late_authorization (thận trọng, tiền có thể đang bị giữ)', async () => {
  const ctx = setup();
  const { attempt } = await ctx.hub.createPayment(order());
  await cb(ctx.hub, { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'PI3' });
  await cb(ctx.hub, { ref: attempt.ref, type: 'authorized', amount: 100000, txn: 'PI3-KHAC' }); // khoản giữ thứ hai
  assert.equal(ctx.hub.listAnomalies({ type: 'late_authorization' }).length, 1);

  const f = setup();
  const failed = await f.hub.createPayment(order());
  await cb(f.hub, { ref: failed.attempt.ref, type: 'failed', amount: 100000, txn: 'PI4' });
  await cb(f.hub, { ref: failed.attempt.ref, type: 'authorized', amount: 100000, txn: 'PI4' }); // cùng mã nhưng FAILED: không biết khoản giữ còn không
  assert.equal(f.hub.listAnomalies({ type: 'late_authorization' }).length, 1);
});

test('đường xử lý cảnh báo với force: hoàn được dù cổng chưa xác nhận (force đi tới tận lệnh hoàn)', async () => {
  const ctx = setup();
  const attempt = await lateMoney(ctx);
  const an = ctx.hub.listAnomalies({ type: 'late_success' })[0];
  await assert.rejects(ctx.hub.resolveAnomaly(an.id, { action: 'refund' }), { code: 'not_confirmed' });
  assert.equal(ctx.a.calls.refund.length, 0);
  await ctx.hub.resolveAnomaly(an.id, { action: 'refund', force: true, note: 'đã đối chiếu sao kê' });
  assert.equal(ctx.a.calls.refund.length, 1);
  assert.equal(ctx.hub.store.refundsOfAttempt(attempt.id).length, 1);
});

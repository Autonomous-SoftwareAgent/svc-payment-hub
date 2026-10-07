'use strict';
// spec: PHUB-S-036
// Tranh chấp (chargeback) là sự kiện chuẩn (PHUB-D-036): dispute_opened, dispute_won, dispute_lost. Giống tiền bị đảo (reversed), Hub KHÔNG
// đổi trạng thái đơn hay attempt (đơn có thể đã giao, tiền có thể mất); chỉ ghi anomaly cùng tên và báo người vận hành.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { assertEvent, DISPUTE_TYPES, EVENT_TYPES } = require('../../src/contract');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const setup = () => {
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({ adapters: { a }, clock: createClock(), config: { gateways: [{ id: 'a' }] } });
  return { a, hub };
};
const cb = (hub, body) => hub.handleCallback('a', { channel: 'ipn', method: 'POST', query: {}, headers: {}, body });
const order = () => ({ orderId: `O${Math.random().toString(36).slice(2, 8)}`, amount: 100000, returnUrl: 'https://s/r' });
const paid = async (hub) => {
  const { payment, attempt } = await hub.createPayment(order());
  const r = await cb(hub, { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
  assert.equal(r.outcome, 'ok');
  return { payment, attempt };
};

test('ba loại sự kiện tranh chấp có trong bảng chuẩn; gatewayTxnId là bắt buộc (phải ổn định giữa các kênh)', () => {
  assert.deepEqual(DISPUTE_TYPES, ['dispute_opened', 'dispute_won', 'dispute_lost']);
  for (const t of DISPUTE_TYPES) {
    assert.ok(EVENT_TYPES.includes(t), t);
    const ev = { gateway: 'a', attemptRef: 'R', type: t, amount: 5000, occurredAt: 0, source: 'ipn' };
    assert.throws(() => assertEvent(ev), /thiếu gatewayTxnId/);
    assert.equal(assertEvent({ ...ev, gatewayTxnId: 'D1' }), true);
  }
});

test('mở tranh chấp trên đơn đã trả: trạng thái đơn và attempt KHÔNG đổi; có anomaly dispute_opened; người vận hành được báo', async () => {
  const { hub } = setup();
  const { payment, attempt } = await paid(hub);
  const r = await cb(hub, { ref: attempt.ref, type: 'dispute_opened', amount: 100000, txn: 'D1' });
  assert.equal(r.outcome, 'ok');
  assert.equal(payment.status, 'PAID');
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(attempt.needsOperator, true);
  const list = hub.listAnomalies({ type: 'dispute_opened' });
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 100000);
  assert.equal(list[0].gatewayTxnId, 'D1');
  assert.equal(list[0].status, 'open');
  assert.equal(list[0].detail.stage, 'opened');
});

test('cùng thông báo tranh chấp gửi lại: duplicate, không tạo thêm anomaly', async () => {
  const { hub } = setup();
  const { attempt } = await paid(hub);
  const body = { ref: attempt.ref, type: 'dispute_opened', amount: 100000, txn: 'D1' };
  assert.equal((await cb(hub, body)).outcome, 'ok');
  assert.equal((await cb(hub, body)).outcome, 'duplicate');
  assert.equal(hub.listAnomalies({ type: 'dispute_opened' }).length, 1);
});

test('thắng hoặc thua: mỗi giai đoạn một anomaly riêng, đơn vẫn không đổi', async () => {
  const { hub } = setup();
  const { payment, attempt } = await paid(hub);
  await cb(hub, { ref: attempt.ref, type: 'dispute_opened', amount: 100000, txn: 'D1' });
  await cb(hub, { ref: attempt.ref, type: 'dispute_lost', amount: 100000, txn: 'D1' });
  assert.equal(hub.listAnomalies({ type: 'dispute_opened' }).length, 1);
  const lost = hub.listAnomalies({ type: 'dispute_lost' });
  assert.equal(lost.length, 1);
  assert.equal(lost[0].detail.stage, 'lost');
  assert.equal(payment.status, 'PAID');
  assert.equal(attempt.status, 'SUCCEEDED');

  const second = await paid(hub);
  await cb(hub, { ref: second.attempt.ref, type: 'dispute_won', amount: 100000, txn: 'D2' });
  assert.equal(hub.listAnomalies({ type: 'dispute_won' }).length, 1);
});

test('tranh chấp từng phần cùng một giao dịch gốc là các sự kiện khác nhau (khác số tiền)', async () => {
  const { hub } = setup();
  const { attempt } = await paid(hub);
  assert.equal((await cb(hub, { ref: attempt.ref, type: 'dispute_opened', amount: 30000, txn: 'D1' })).outcome, 'ok');
  assert.equal((await cb(hub, { ref: attempt.ref, type: 'dispute_opened', amount: 70000, txn: 'D1' })).outcome, 'ok');
  assert.equal(hub.listAnomalies({ type: 'dispute_opened' }).length, 2);
});

test('anomaly tranh chấp chỉ xử lý bằng ignore kèm ghi chú: hoàn tiền hay áp dụng đều bị từ chối', async () => {
  const { hub } = setup();
  const { attempt } = await paid(hub);
  await cb(hub, { ref: attempt.ref, type: 'dispute_opened', amount: 100000, txn: 'D1' });
  const an = hub.listAnomalies({ type: 'dispute_opened' })[0];
  await assert.rejects(hub.resolveAnomaly(an.id, { action: 'refund', force: true }), (e) => e.code === 'invalid_state' && /dispute_opened chỉ xử lý bằng ignore/.test(e.message));
  await assert.rejects(hub.resolveAnomaly(an.id, { action: 'apply' }), { code: 'invalid_state' });
  await hub.resolveAnomaly(an.id, { action: 'ignore', note: 'đã làm việc với ngân hàng' });
  assert.equal(hub.listAnomalies({ type: 'dispute_opened' })[0].status, 'ignored');
});

test('tranh chấp cho attempt lạ: ghi unknown_attempt, không nhầm sang đơn nào', async () => {
  const { hub } = setup();
  const r = await cb(hub, { ref: 'KHONGCO', type: 'dispute_opened', amount: 1000, txn: 'D9' });
  assert.equal(r.outcome, 'unknown_attempt');
  assert.equal(hub.listAnomalies({ type: 'unknown_attempt' }).length, 1);
  assert.equal(hub.listAnomalies({ type: 'dispute_opened' }).length, 0);
});

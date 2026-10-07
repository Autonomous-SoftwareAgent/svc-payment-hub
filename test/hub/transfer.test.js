'use strict';
// spec: PHUB-S-001
// spec: PHUB-S-002
// spec: PHUB-S-005
// spec: PHUB-S-006
// Kiểm tra lõi Hub với kiểu chuyển khoản do khách chủ động (adapter giả): hướng dẫn chuyển khoản,
// khoản nhận 'received' (thiếu/đủ/thừa/trùng), tiền chưa rõ chủ, kéo sao kê, mã không phân biệt hoa thường.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

function setup(extra = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a', {
    caps: { hardExpiry: 'none', refundable: 'manual', referenceFormat: { prefix: 'DH', maxLength: 12, caseInsensitive: true } },
    withFeed: extra.withFeed,
  });
  a.createMode = 'instructions';
  const hub = new PaymentHub({
    adapters: { a },
    clock,
    config: {
      gateways: [{ id: 'a', priority: 1 }],
      reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120], maxAgeSeconds: 3600 },
      paymentTtlSeconds: 1800,
    },
  });
  return { hub, a, clock };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });
const cb = (hub, body, channel = 'ipn') => hub.handleCallback('a', { channel, method: 'POST', query: {}, body, headers: {} });
const rcv = (attempt, amount, txn, extra = {}) => ({ ref: attempt.ref, type: 'received', amount, txn, ...extra });
const event = (attempt, amount, txn) => ({ gateway: 'a', attemptRef: attempt.ref, type: 'received', amount, gatewayTxnId: txn, occurredAt: 1, source: 'query' });

test('createPayment trả hướng dẫn chuyển khoản; attempt AWAITING; mã thỏa referenceFormat', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order());
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(attempt.url, null);
  assert.equal(attempt.instructions.transferContent, attempt.ref);
  assert.match(attempt.ref, /^DH/);
  assert.equal(attempt.ref, attempt.ref.toUpperCase());
  assert.ok(attempt.ref.length <= 12);
});

test('khoản nhận đủ tiền: SUCCEEDED, payment PAID; tra cứu mã không phân biệt hoa thường', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  const r = await cb(hub, rcv(attempt, 100000, 'T1', { ref: attempt.ref.toLowerCase() }));
  assert.equal(r.outcome, 'ok');
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(payment.status, 'PAID');
  assert.equal(hub.listAnomalies().length, 0);
});

test('nhận thiếu rồi bù đủ: underpaid giữ chờ, rồi được thay thế khi đủ', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb(hub, rcv(attempt, 60000, 'T1'));
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(payment.status, 'OPEN');
  assert.equal(hub.listAnomalies({ type: 'underpaid' })[0].amount, 60000);
  await cb(hub, rcv(attempt, 40000, 'T2'));
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(payment.status, 'PAID');
  assert.equal(hub.listAnomalies({ type: 'underpaid' })[0].status, 'superseded');
  assert.equal(hub.listAnomalies({ type: 'overpaid' }).length, 0);
});

test('nhận thừa: SUCCEEDED, phần dư là overpaid, hoàn qua anomaly ra MANUAL_REQUIRED', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb(hub, rcv(attempt, 130000, 'T1'));
  assert.equal(payment.status, 'PAID');
  const [over] = hub.listAnomalies({ type: 'overpaid' });
  assert.equal(over.amount, 30000);
  const done = await hub.resolveAnomaly(over.id, { action: 'refund' });
  const refund = hub.store.getRefund(done.refundId);
  assert.equal(refund.amount, 30000);
  assert.equal(refund.status, 'MANUAL_REQUIRED');
});

test('cùng một khoản qua webhook rồi qua query chỉ tính một lần', async () => {
  const { hub, a, clock } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb(hub, rcv(attempt, 60000, 'T1'));
  a.queryResults.set(attempt.ref, [event(attempt, 60000, 'T1')]);
  clock.advance(61);
  await hub.reconcile();
  assert.equal(attempt.receivedTotal, 60000);
  assert.equal(payment.status, 'OPEN');
});

test('khoản đến sau khi attempt SUCCEEDED là duplicate_charge; sau khi payment đóng là late_success', async () => {
  const s = setup();
  const p1 = await s.hub.createPayment(order());
  await cb(s.hub, rcv(p1.attempt, 100000, 'T1'));
  await cb(s.hub, rcv(p1.attempt, 100000, 'T2'));
  assert.equal(s.hub.listAnomalies({ type: 'duplicate_charge' }).length, 1);
  const p2 = await s.hub.createPayment(order({ orderId: 'O2' }));
  p2.payment.status = 'CLOSED';
  p2.attempt.status = 'EXPIRED';
  await cb(s.hub, rcv(p2.attempt, 100000, 'T3'));
  assert.equal(p2.attempt.status, 'EXPIRED');
  assert.equal(s.hub.listAnomalies({ type: 'late_success' }).length, 1);
});

test('tiền không gắn được attempt là unmatched_funds; gửi lại là duplicate', async () => {
  const { hub } = setup();
  const r1 = await cb(hub, { unmatched: true, amount: 50000, txn: 'U1', content: 'chuyen tien linh tinh' });
  const r2 = await cb(hub, { unmatched: true, amount: 50000, txn: 'U1', content: 'chuyen tien linh tinh' });
  assert.equal(r1.outcome, 'ok');
  assert.equal(r2.outcome, 'duplicate');
  const list = hub.listAnomalies({ type: 'unmatched_funds' });
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 50000);
});

test('mã tham chiếu lạ có tiền đi kèm: unknown_attempt được ghi một lần', async () => {
  const { hub } = setup();
  await cb(hub, { ref: 'DHNOPE', type: 'received', amount: 1000, txn: 'X1' });
  await cb(hub, { ref: 'DHNOPE', type: 'received', amount: 1000, txn: 'X1' });
  assert.equal(hub.listAnomalies({ type: 'unknown_attempt' }).length, 1);
});

test('thông báo hợp lệ nhưng không có event (ví dụ tiền ra) bị bỏ qua', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order());
  const r = await cb(hub, { noEvent: true });
  assert.equal(r.outcome, 'ok');
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(hub.listAnomalies().length, 0);
});

test('webhook mất: kéo sao kê tìm ra khoản của attempt và cả khoản chưa rõ chủ; con trỏ được lưu', async () => {
  const { hub, a, clock } = setup({ withFeed: true });
  const { payment, attempt } = await hub.createPayment(order());
  const calls = [];
  a.feed = async ({ cursor }) => {
    calls.push(cursor);
    if (cursor !== undefined) return { events: [], nextCursor: cursor };
    return {
      events: [
        event(attempt, 100000, 'F1'),
        { gateway: 'a', attemptRef: null, unmatched: true, type: 'received', amount: 70000, gatewayTxnId: 'F2', content: 'khong ro', occurredAt: 2, source: 'query' },
      ],
      nextCursor: 'F2',
    };
  };
  await hub.reconcile();
  assert.equal(payment.status, 'PAID');
  assert.equal(hub.listAnomalies({ type: 'unmatched_funds' }).length, 1);
  clock.advance(61);
  await hub.reconcile();
  assert.deepEqual(calls, [undefined, 'F2']);
  assert.equal(hub.listAnomalies({ type: 'unmatched_funds' }).length, 1, 'không đếm lại');
});

test('hardExpiry none: không hỏi lại bắt buộc theo hạn; không tự đóng attempt bằng hết hạn', async () => {
  const { hub, clock } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  clock.advance(5 * 3600);
  await hub.reconcile();
  assert.equal(attempt.status, 'AWAITING');
  assert.equal(payment.status, 'OPEN');
  assert.equal(hub.listAnomalies({ type: 'expiry_unresolved' }).length, 0);
});

'use strict';
// spec: PHUB-S-007
// spec: PHUB-S-012
// Lưu bền vững (PostgreSQL) và đối soát chạy nền: trạng thái, idempotency và con trỏ sao kê phải sống qua khởi động lại.
// Test cần PostgreSQL thật (xem test/support/pg.js); không có thì bị bỏ qua và nêu lý do.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { PostgresStore } = require('../../src/store-postgres');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

// Dựng một "tiến trình Hub" mới trên cùng schema; adapter giả có trạng thái nên dùng chung giữa các lần dựng.
function boot(store, a, clock, extra = {}) {
  return new PaymentHub({
    adapters: { a },
    clock,
    store,
    config: {
      gateways: [{ id: 'a', priority: 1 }],
      reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120], maxAgeSeconds: 3600, ...extra.reconcile },
      paymentTtlSeconds: 1800,
    },
  });
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });
const cb = (hub, body) => hub.handleCallback('a', { channel: 'ipn', method: 'GET', query: {}, body, headers: {} });
const ev = (attempt, type, extra = {}) => ({ ref: attempt.ref, type, amount: attempt.amount, txn: 'T1', ...extra });

// Mỗi test: schema sạch, dọn sau khi xong.
const withDb = (name, fn) => test(name, { skip: SKIP }, async () => {
  const db = freshDb();
  try { await fn(db); } finally { await db.cleanup(); }
});

withDb('trạng thái sống qua khởi động lại: payment PAID, attempt, bộ đếm id không đụng nhau', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock);
  const { payment, attempt } = await hub1.createPayment(order());
  await cb(hub1, ev(attempt, 'succeeded'));
  await s1.close();

  const s2 = await db.open();
  const hub2 = boot(s2, a, clock);
  assert.equal(s2.payments.size, 0, 'giao dịch đã đóng không được nạp khi khởi động');
  const got = await hub2.loadPayment(payment.id);
  assert.equal(got.payment.status, 'PAID');
  assert.equal(got.attempts.length, 1);
  assert.equal(got.attempts[0].status, 'SUCCEEDED');
  const next = await hub2.createPayment(order({ orderId: 'O2' }));
  assert.notEqual(next.payment.id, payment.id);
  assert.notEqual(next.attempt.id, attempt.id);
  assert.equal(s2.attempts.size, 2);
});

withDb('idempotency sống qua khởi động lại: thông báo trùng sau restart vẫn là duplicate, không tính lại', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock);
  const { attempt } = await hub1.createPayment(order());
  const body = ev(attempt, 'succeeded');
  assert.equal((await cb(hub1, body)).outcome, 'ok');
  await s1.close();

  const hub2 = boot(await db.open(), a, clock);
  assert.equal((await cb(hub2, body)).outcome, 'duplicate');
  assert.equal(hub2.listAnomalies().length, 0);
});

withDb('anomaly, refund và nhật ký sự kiện được lưu và nạp lại đúng thứ tự', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock);
  const { attempt } = await hub1.createPayment(order());
  await cb(hub1, ev(attempt, 'succeeded', { amount: 99999 })); // amount_mismatch
  await cb(hub1, ev(attempt, 'succeeded'));
  const refund = await hub1.refund({ attemptId: attempt.id, amount: 40000 });
  const events = s1.events.length;
  const anomalyId = hub1.listAnomalies()[0].id;
  await s1.close();

  const s2 = await db.open();
  const hub2 = boot(s2, a, clock);
  assert.equal(s2.events.length, events);
  assert.equal(hub2.listAnomalies()[0].id, anomalyId);
  assert.equal(hub2.listAnomalies()[0].type, 'amount_mismatch');
  assert.equal(s2.getRefund(refund.id).amount, 40000);
  assert.equal(s2.getRefund(refund.id).status, 'PROCESSING');
});

withDb('đối soát tiếp tục sau khởi động lại: attempt UNKNOWN được hỏi lại và tìm ra tiền', async (db) => {
  const a = createFakeAdapter('a', { caps: { createCanTimeout: true } });
  a.createMode = 'unknown';
  const clock = createClock();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock);
  const { payment, attempt } = await hub1.createPayment(order());
  assert.equal(attempt.status, 'UNKNOWN');
  await s1.close();

  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'succeeded', amount: attempt.amount, gatewayTxnId: 'TQ', occurredAt: 1, source: 'query' });
  clock.advance(61);
  const s2 = await db.open();
  const hub2 = boot(s2, a, clock);
  await hub2.reconcile();
  assert.equal(hub2.getPayment(payment.id).payment.status, 'PAID');
  await s2.close();

  const hub3 = boot(await db.open(), a, clock);
  assert.equal((await hub3.loadPayment(payment.id)).payment.status, 'PAID', 'kết quả đối soát cũng được lưu');
});

withDb('con trỏ sao kê sống qua khởi động lại: không kéo lại và không đếm lại khoản cũ', async (db) => {
  const a = createFakeAdapter('a', { withFeed: true });
  const clock = createClock();
  const calls = [];
  a.feed = async ({ cursor }) => {
    calls.push(cursor);
    return cursor === undefined
      ? { events: [{ gateway: 'a', attemptRef: null, unmatched: true, type: 'received', amount: 5000, gatewayTxnId: 'F1', content: 'x', occurredAt: 1, source: 'query' }], nextCursor: 'F1' }
      : { events: [], nextCursor: cursor };
  };
  const s1 = await db.open();
  await boot(s1, a, clock).reconcile();
  await s1.close();

  clock.advance(61);
  const hub2 = boot(await db.open(), a, clock);
  await hub2.reconcile();
  assert.deepEqual(calls, [undefined, 'F1']);
  assert.equal(hub2.listAnomalies({ type: 'unmatched_funds' }).length, 1);
});

withDb('thao tác ném lỗi giữa chừng vẫn lưu phần đã làm và không làm hỏng cơ sở dữ liệu', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock);
  await assert.rejects(hub1.createPayment(order({ amount: 0 })), { code: 'invalid_input' });
  const ok = await hub1.createPayment(order());
  await s1.close();
  const hub2 = boot(await db.open(), a, clock);
  assert.equal(hub2.getPayment(ok.payment.id).payment.status, 'OPEN');
});

withDb('chỉ một tiến trình Hub cho mỗi schema: tiến trình thứ hai bị từ chối ngay, đóng tiến trình đầu thì mở lại được', async (db) => {
  const first = await db.open();
  await assert.rejects(PostgresStore.open(db.url, { schema: db.schema }), /tiến trình Hub khác/);
  await first.close();
  const again = await db.open();
  assert.ok(again);
});

withDb('lưu lỗi giữa chừng: rollback toàn bộ, lần lưu sau ghi lại phần chưa lưu được, không mất dữ liệu', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock);
  const realQuery = s1.client.query.bind(s1.client);
  let failOnce = true;
  s1.client.query = (text, ...rest) => {
    if (failOnce && typeof text === 'string' && text.startsWith('INSERT INTO docs')) { failOnce = false; return Promise.reject(new Error('lỗi mạng giả lập')); }
    return realQuery(text, ...rest);
  };
  await assert.rejects(hub1.createPayment(order()), /lỗi mạng giả lập/);
  s1.client.query = realQuery;
  const { payment } = await hub1.createPayment(order({ orderId: 'O2' })); // lần lưu kế tiếp ghi cả phần trước
  await s1.close();

  const hub2 = boot(await db.open(), a, clock);
  assert.equal(hub2.getPayment(payment.id).payment.orderId, 'O2');
  assert.ok(hub2.store.findPaymentByOrderId('O1'), 'payment của lần lưu lỗi vẫn có sau lần lưu sau');
});

withDb('20 thao tác chạy đồng thời đều được lưu và nạp lại đủ (các lần lưu được xếp hàng)', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock);
  const made = await Promise.all(Array.from({ length: 20 }, (_, i) => hub1.createPayment(order({ orderId: `C${i}` }))));
  await Promise.all(made.map((m, i) => cb(hub1, ev(m.attempt, 'succeeded', { txn: `T${i}` }))));
  await s1.close();

  const hub2 = boot(await db.open(), a, clock);
  assert.equal(hub2.store.payments.size, 0, 'tất cả đã PAID nên không nạp khi khởi động');
  const loaded = await Promise.all(made.map((m) => hub2.loadPayment(m.payment.id)));
  assert.equal(loaded.filter((d) => d.payment.status === 'PAID').length, 20);
  assert.equal(hub2.store.attempts.size, 20);
});

// ---------- bộ lập lịch (không cần DB) ----------
test('bộ lập lịch chạy reconcile định kỳ, không chồng lấn, và dừng được', async () => {
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({
    adapters: { a },
    clock: { now: () => Date.now() },
    config: { gateways: [{ id: 'a', priority: 1 }], reconcile: { firstAfterSeconds: 0.02, backoffSeconds: [0.02], maxAgeSeconds: 3600 }, paymentTtlSeconds: 1800 },
  });
  const { payment, attempt } = await hub.createPayment(order());
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'succeeded', amount: attempt.amount, gatewayTxnId: 'TS', occurredAt: 1, source: 'query' });
  hub.startScheduler({ everySeconds: 0.03 });
  hub.startScheduler({ everySeconds: 0.03 }); // gọi lại không tạo thêm timer
  await new Promise((r) => setTimeout(r, 400));
  hub.stopScheduler();
  assert.equal(payment.status, 'PAID', 'đối soát nền tự tìm ra kết quả');
  const events = hub.store.events.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.store.events.length, events, 'đã dừng thì không chạy nữa');
});

test('bộ lập lịch: lỗi trong reconcile không làm chết vòng lặp và báo qua onError', async () => {
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({
    adapters: { a },
    clock: { now: () => Date.now() },
    config: { gateways: [{ id: 'a', priority: 1 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 3600 } },
  });
  let calls = 0;
  const errors = [];
  hub.reconcile = async () => { calls += 1; throw new Error('boom'); };
  hub.startScheduler({ everySeconds: 0.02, onError: (e) => errors.push(e.message) });
  await new Promise((r) => setTimeout(r, 250));
  hub.stopScheduler();
  assert.ok(calls >= 3, `chạy lại sau lỗi (calls=${calls})`);
  assert.equal(errors[0], 'boom');
});

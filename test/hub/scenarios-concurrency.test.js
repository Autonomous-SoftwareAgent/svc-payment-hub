'use strict';
// spec: PHUB-S-019
// Kịch bản chạy ĐỒNG THỜI: các test khác gọi tuần tự từng ca. Ở đây cùng một thứ bị gọi nhiều lần cùng lúc
// (IPN trùng dồn dập, cửa hàng gọi lại khi timeout, khách bấm "thử lại" hai lần, hai hoàn tiền cùng lúc,
// đối soát đang hỏi cổng thì IPN về), vì đó là chỗ lõi có thể làm tiền sai mà từng bước đơn lẻ vẫn đúng.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Làm mọi lời gọi ra cổng chậm một chút để các lời gọi đồng thời thật sự xen kẽ nhau.
function slow(fake, ms = 4) {
  for (const fn of ['createPayment', 'query', 'refund', 'queryRefund']) {
    const raw = fake[fn].bind(fake);
    fake[fn] = async (...a) => { await sleep(ms); return raw(...a); };
  }
  if (fake.cancel) { const raw = fake.cancel.bind(fake); fake.cancel = async (...a) => { await sleep(ms); return raw(...a); }; }
  return fake;
}

function setup(opts = {}) {
  const clock = createClock();
  const a = slow(createFakeAdapter('a', opts.capsA));
  const b = slow(createFakeAdapter('b', opts.capsB));
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a, b },
    clock,
    newRef: (p) => `${p}${++n}`,
    config: {
      gateways: [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }],
      reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120], maxAgeSeconds: 3600 },
      paymentTtlSeconds: 1800,
      failover: { enabled: true, maxAttempts: 5 },
    },
  });
  const emitted = [];
  const rawEmit = hub.events.emit.bind(hub.events);
  hub.events.emit = (type, ...rest) => { emitted.push(type); return rawEmit(type, ...rest); };
  return { hub, a, b, clock, emitted };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });
const cb = (gw, hub, body, channel = 'ipn') => hub.handleCallback(gw, { channel, method: 'GET', query: {}, body, headers: {} });
const ok = (attempt, extra = {}) => ({ ref: attempt.ref, type: 'succeeded', amount: attempt.amount, txn: 'T1', ...extra });

test('50 IPN thành công giống hệt đến cùng lúc: payment PAID một lần, một sự kiện payment.paid, không anomaly', async () => {
  const { hub, emitted } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  const rs = await Promise.all(Array.from({ length: 50 }, () => cb('a', hub, ok(attempt))));
  assert.equal(rs.filter((r) => r.outcome === 'ok').length, 1);
  assert.equal(rs.filter((r) => r.outcome === 'duplicate').length, 49);
  assert.equal(payment.status, 'PAID');
  assert.equal(emitted.filter((t) => t === 'payment.paid').length, 1);
  assert.equal(hub.listAnomalies().length, 0);
});

test('cửa hàng gọi tạo thanh toán 30 lần cùng lúc cho cùng một đơn: một payment, một attempt, cổng chỉ nhận một lần tạo', async () => {
  const { hub, a } = setup();
  const rs = await Promise.all(Array.from({ length: 30 }, () => hub.createPayment(order())));
  assert.equal(new Set(rs.map((r) => r.payment.id)).size, 1);
  assert.equal(new Set(rs.map((r) => r.attempt.id)).size, 1);
  assert.equal(a.created.length, 1, 'không tạo trùng giao dịch ở cổng');
  assert.equal(rs.filter((r) => !r.existing).length, 1);
});

test('khách bấm "thử lại" 10 lần cùng lúc sau khi attempt đầu thất bại: chỉ một attempt mới được tạo', async () => {
  const { hub, a, b } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb('a', hub, { ref: attempt.ref, type: 'failed', amount: attempt.amount, txn: 'F1' });
  assert.equal(attempt.status, 'FAILED');
  const rs = await Promise.allSettled(Array.from({ length: 10 }, () => hub.createAttempt(payment.id, { reason: 'customer_retry' })));
  const made = rs.filter((r) => r.status === 'fulfilled');
  assert.equal(made.length, 1, `được tạo ${made.length} attempt`);
  assert.equal(hub.store.attemptsOfPayment(payment.id).filter((x) => ['CREATED', 'AWAITING', 'UNKNOWN'].includes(x.status)).length, 1);
  assert.equal(a.created.length + b.created.length, 2);
});

test('failover đồng thời (cancelLive) trên attempt còn sống: không có hai attempt cùng nhận tiền', async () => {
  const { hub } = setup({ capsA: { cancellable: true }, capsB: { cancellable: true } });
  const { payment } = await hub.createPayment(order());
  const rs = await Promise.allSettled(Array.from({ length: 6 }, () => hub.createAttempt(payment.id, { reason: 'failover', cancelLive: true })));
  const live = hub.store.attemptsOfPayment(payment.id).filter((x) => ['CREATED', 'AWAITING', 'UNKNOWN'].includes(x.status));
  assert.ok(live.length <= 1, `${live.length} attempt cùng còn sống (${rs.filter((r) => r.status === 'fulfilled').length} lời gọi thành công)`);
});

test('hai attempt của cùng payment (sau failover) cùng báo thành công đồng thời: PAID một lần, lần kia là duplicate_charge', async () => {
  const { hub, emitted } = setup();
  const { payment, attempt: a1 } = await hub.createPayment(order());
  await cb('a', hub, { ref: a1.ref, type: 'failed', amount: a1.amount, txn: 'F1' });
  const { attempt: a2 } = await hub.createAttempt(payment.id, { reason: 'failover' });
  assert.notEqual(a1.gateway, undefined);
  // a1 FAILED nhưng khách vẫn trả được ở cổng cũ; a2 cũng trả: hai lời báo đến cùng lúc
  const [r1, r2] = await Promise.all([cb(a1.gateway, hub, ok(a1, { txn: 'T-A1' })), cb(a2.gateway, hub, ok(a2, { txn: 'T-A2' }))]);
  assert.deepEqual([r1.outcome, r2.outcome], ['ok', 'ok']);
  assert.equal(payment.status, 'PAID');
  assert.equal(emitted.filter((t) => t === 'payment.paid').length, 1);
  assert.equal(hub.listAnomalies({ type: 'duplicate_charge' }).length + hub.listAnomalies({ type: 'late_success' }).length, 1);
});

test('5 hoàn tiền cùng lúc mỗi cái 40% số đã thu: tổng không vượt số đã thu', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ok(attempt));
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => hub.refund({ attemptId: attempt.id, amount: 40000 })));
  const done = rs.filter((r) => r.status === 'fulfilled');
  const total = hub.store.refundsOfAttempt(attempt.id).filter((r) => r.status !== 'FAILED').reduce((s, r) => s + r.amount, 0);
  assert.ok(total <= attempt.amount, `đã yêu cầu hoàn ${total} trên ${attempt.amount} (${done.length} lời gọi thành công)`);
  assert.equal(done.length, 2);
});

test('đối soát đang hỏi cổng thì IPN thành công về trước: kết quả hỏi chậm (chưa thanh toán) không làm lùi trạng thái', async () => {
  const { hub, a, clock } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'pending', occurredAt: 1, source: 'query' });
  clock.advance(61);
  const rec = hub.reconcile(); // đang chờ cổng trả lời
  await cb('a', hub, ok(attempt));
  await rec;
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(payment.status, 'PAID');
  assert.equal(hub.listAnomalies().length, 0);
});

test('đối soát và IPN cùng báo thành công (khác kênh, cùng mã giao dịch): một lần ghi nhận, không anomaly', async () => {
  const { hub, a, clock, emitted } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'succeeded', amount: attempt.amount, gatewayTxnId: 'T1', occurredAt: 1, source: 'query' });
  clock.advance(61);
  await Promise.all([hub.reconcile(), cb('a', hub, ok(attempt)), cb('a', hub, ok(attempt))]);
  assert.equal(payment.status, 'PAID');
  assert.equal(emitted.filter((t) => t === 'payment.paid').length, 1);
  assert.equal(hub.listAnomalies().length, 0);
});

test('hai lần reconcile chồng nhau trên cùng attempt: kết quả vẫn một lần, không làm đếm lần hỏi sai kéo lịch', async () => {
  const { hub, a, clock } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'succeeded', amount: attempt.amount, gatewayTxnId: 'T1', occurredAt: 1, source: 'query' });
  clock.advance(61);
  await Promise.all([hub.reconcile(), hub.reconcile(), hub.reconcile()]);
  assert.equal(payment.status, 'PAID');
  assert.equal(hub.listAnomalies().length, 0);
});

test('attempt đã SUCCEEDED rồi nhận thêm một khoản "thành công" với mã giao dịch KHÁC: phải ghi lại, không được bỏ qua âm thầm', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ok(attempt, { txn: 'T-FIRST' }));
  assert.equal(attempt.status, 'SUCCEEDED');
  const r = await cb('a', hub, ok(attempt, { txn: 'T-SECOND' }));
  const held = hub.listAnomalies().filter((an) => an.gatewayTxnId === 'T-SECOND');
  assert.ok(held.length === 1 || r.outcome !== 'duplicate', `khoản T-SECOND (${attempt.amount} VND) trả outcome "${r.outcome}" và ${held.length} anomaly: tiền đã thu thêm mà Hub không ghi`);
});

test('khoản thu thứ hai cùng kênh: chỉ một anomaly dù thông báo lặp lại, và không hoàn được qua anomaly (Hub nhắm theo mã khoản đầu)', async () => {
  const { hub } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  await cb('a', hub, ok(attempt, { txn: 'T-FIRST' }));
  for (let i = 0; i < 3; i += 1) await cb('a', hub, ok(attempt, { txn: 'T-SECOND' }));
  const dup = hub.listAnomalies({ type: 'duplicate_charge' });
  assert.equal(dup.length, 1);
  assert.equal(dup[0].gatewayTxnId, 'T-SECOND');
  assert.equal(dup[0].detail.sameAttempt, true);
  assert.equal(payment.status, 'PAID');
  assert.equal(attempt.gatewayTxnId, 'T-FIRST', 'khoản ghi nhận vẫn là khoản đầu');
  await assert.rejects(hub.resolveAnomaly(dup[0].id, { action: 'refund', force: true }), /hoàn tại cổng theo mã giao dịch/);
  await hub.resolveAnomaly(dup[0].id, { action: 'ignore', note: 'đã hoàn tại cổng' });
  assert.equal(dup[0].status, 'ignored');
});

test('khác kênh, khác mã giao dịch (IPN rồi truy vấn): không báo động giả, vì mã giữa các kênh của một số cổng không trùng', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order());
  await cb('a', hub, ok(attempt, { txn: 'T-IPN' }));
  const r = await cb('a', hub, ok(attempt, { txn: 'T-API', source: 'query' }));
  assert.equal(r.outcome, 'duplicate');
  assert.equal(hub.listAnomalies().length, 0);
});

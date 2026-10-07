'use strict';
// spec: PHUB-S-010
// Lớp bảo vệ khi gọi cổng: circuit breaker, giới hạn đồng thời, timeout, nhật ký gọi; và cách Hub dùng nó (chưa gửi thì được chuyển cổng).
const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayGuard, GuardError } = require('../../src/guard');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const boom = () => Promise.reject(new Error('boom'));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function guard(o = {}) {
  const clock = createClock();
  const calls = [];
  const g = new GatewayGuard('x', { clock, failureThreshold: 3, openSeconds: 30, timeoutMs: 1000, onCall: (e) => calls.push(e), ...o });
  return { g, clock, calls };
}

test('breaker: lỗi liên tiếp quá ngưỡng thì mở, lời gọi sau đó bị từ chối mà KHÔNG gọi cổng (notSent)', async () => {
  const { g } = guard();
  for (let i = 0; i < 3; i++) await assert.rejects(g.run('createPayment', 'R', boom), /boom/);
  assert.equal(g.state, 'open');
  let called = false;
  await assert.rejects(g.run('createPayment', 'R', async () => { called = true; }), (e) => e instanceof GuardError && e.code === 'circuit_open' && e.notSent === true);
  assert.equal(called, false, 'không gọi cổng khi breaker mở');
  assert.equal(g.available(), false);
});

test('breaker: thành công xen giữa làm đếm lại; hết thời gian nghỉ thì thử một lần (half_open), thành công thì đóng', async () => {
  const { g, clock } = guard();
  await assert.rejects(g.run('q', 'R', boom));
  await assert.rejects(g.run('q', 'R', boom));
  await g.run('q', 'R', async () => 1);
  assert.equal(g.failures, 0);
  for (let i = 0; i < 3; i++) await assert.rejects(g.run('q', 'R', boom));
  assert.equal(g.state, 'open');
  clock.advance(29);
  assert.equal(g.available(), false);
  clock.advance(2);
  assert.equal(g.available(), true);
  assert.equal(await g.run('q', 'R', async () => 'ok'), 'ok');
  assert.equal(g.state, 'closed');
});

test('breaker half_open: chỉ một lời gọi thử, lời gọi thứ hai bị từ chối; thử thất bại thì mở lại', async () => {
  const { g, clock } = guard();
  for (let i = 0; i < 3; i++) await assert.rejects(g.run('q', 'R', boom));
  clock.advance(31);
  const probe = deferred();
  const first = g.run('q', 'R', () => probe.promise);
  await assert.rejects(g.run('q', 'R', async () => 1), (e) => e.code === 'circuit_open' && e.notSent);
  probe.resolve();
  await first;
  assert.equal(g.state, 'closed');
  for (let i = 0; i < 3; i++) await assert.rejects(g.run('q', 'R', boom));
  clock.advance(31);
  await assert.rejects(g.run('q', 'R', boom));
  assert.equal(g.state, 'open', 'thử thất bại: mở lại ngay');
});

test('timeout: lỗi KHÔNG mang cờ notSent (đã gửi, kết quả không rõ) và tính vào lỗi liên tiếp', async () => {
  const { g, calls } = guard({ timeoutMs: 20 });
  await assert.rejects(g.run('createPayment', 'R1', () => new Promise(() => {})), (e) => e.code === 'timeout' && e.notSent === false);
  assert.equal(g.failures, 1);
  assert.equal(calls[0].outcome, 'timeout');
});

test('bulkhead: vượt giới hạn đồng thời và hàng chờ thì từ chối ngay (notSent); hàng chờ chạy khi có chỗ', async () => {
  const { g } = guard({ maxConcurrent: 2, maxQueue: 1, queueWaitMs: 1000 });
  const d1 = deferred(); const d2 = deferred(); const d3 = deferred();
  const p1 = g.run('q', 'a', () => d1.promise);
  const p2 = g.run('q', 'b', () => d2.promise);
  await new Promise((r) => setImmediate(r));
  let thirdStarted = false;
  const p3 = g.run('q', 'c', () => { thirdStarted = true; return d3.promise; });
  await new Promise((r) => setImmediate(r));
  assert.equal(g.inflight, 2);
  assert.equal(g.queue.length, 1);
  assert.equal(thirdStarted, false, 'chờ chỗ');
  await assert.rejects(g.run('q', 'd', async () => 1), (e) => e.code === 'overloaded' && e.notSent);
  assert.equal(g.available(), false);
  d1.resolve();
  await p1;
  await new Promise((r) => setImmediate(r));
  assert.equal(thirdStarted, true, 'đến lượt khi có chỗ');
  d2.resolve(); d3.resolve();
  await Promise.all([p2, p3]);
  assert.equal(g.inflight, 0);
  assert.equal(g.available(), true);
});

test('bulkhead: chờ quá queueWaitMs thì bị từ chối (notSent) và rời hàng', async () => {
  const { g } = guard({ maxConcurrent: 1, maxQueue: 5, queueWaitMs: 20 });
  const hold = deferred();
  const p1 = g.run('q', 'a', () => hold.promise);
  await assert.rejects(g.run('q', 'b', async () => 1), (e) => e.code === 'overloaded' && e.notSent);
  assert.equal(g.queue.length, 0);
  hold.resolve();
  await p1;
});

test('nhật ký gọi: mỗi lần gọi một dòng (thời điểm, cổng, phương thức, mã tham chiếu, kết quả); createPayment trả unknown tính là lỗi', async () => {
  const { g, calls, clock } = guard({ failureThreshold: 2 });
  await g.run('createPayment', 'R1', async () => ({ status: 'redirect' }), (r) => r.status === 'unknown');
  await g.run('createPayment', 'R2', async () => ({ status: 'unknown' }), (r) => r.status === 'unknown');
  await assert.rejects(g.run('query', 'R3', boom));
  await assert.rejects(g.run('query', 'R4', async () => 1), (e) => e.notSent); // đã mở: failures 2 (unknown + boom)
  assert.deepEqual(calls.map((c) => [c.method, c.ref, c.outcome]), [['createPayment', 'R1', 'ok'], ['createPayment', 'R2', 'error'], ['query', 'R3', 'error'], ['query', 'R4', 'not_sent']]);
  assert.ok(calls.every((c) => c.gateway === 'x' && c.at === clock.now() && typeof c.ms === 'number'));
  assert.equal(g.status().totals.not_sent, 1);
});

// ---------- cách Hub dùng lớp bảo vệ ----------

function hubWith(opts = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a', { caps: opts.capsA });
  const b = createFakeAdapter('b');
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a, b },
    clock,
    newRef: (p) => `${p}${++n}`,
    config: { gateways: [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }], protection: { perGateway: { a: { failureThreshold: 2, timeoutMs: opts.timeoutMs || 15000 } } }, ...(opts.config || {}) },
  });
  return { hub, a, b, clock };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });

test('Hub: cổng đang mở breaker bị bỏ qua khi chọn cổng, không gọi nó', async () => {
  const { hub, a, b } = hubWith();
  a.createMode = 'throw'; // capsA createCanTimeout=false: lỗi mạng = rejected, chuyển b
  await hub.createPayment(order({ orderId: 'O1' }));
  await hub.createPayment(order({ orderId: 'O2' }));
  assert.equal(hub.guards.a.state, 'open');
  assert.equal(a.created.length, 2);
  const r = await hub.createPayment(order({ orderId: 'O3' }));
  assert.equal(r.attempt.gateway, 'b');
  assert.equal(a.created.length, 2, 'a không bị gọi thêm');
  assert.equal(b.created.length, 3);
});

test('Hub: cổng duy nhất mở breaker: attempt FAILED vì circuit_open (chưa gửi), kể cả khi cổng có createCanTimeout', async () => {
  const clock = createClock();
  const a = createFakeAdapter('a', { caps: { createCanTimeout: true } });
  const hub = new PaymentHub({ adapters: { a }, clock, config: { gateways: [{ id: 'a' }], protection: { failureThreshold: 1 } } });
  a.createMode = 'throw';
  const first = await hub.createPayment(order({ orderId: 'O1' }));
  assert.equal(first.attempt.status, 'UNKNOWN', 'đã gửi mà lỗi mạng: không rõ, không failover');
  assert.equal(hub.guards.a.state, 'open');
  await assert.rejects(hub.createPayment(order({ orderId: 'O2' })), { code: 'no_gateway_available' });
  assert.equal(a.created.length, 1, 'không gọi cổng khi breaker mở');
  const failed = [...hub.store.attempts.values()].find((x) => x.failReason === 'circuit_open');
  assert.ok(failed && failed.status === 'FAILED');
});

test('Hub: timeout khi tạo thanh toán với cổng có createCanTimeout: UNKNOWN và KHÔNG chuyển cổng', async () => {
  const { hub, a, b } = hubWith({ capsA: { createCanTimeout: true }, timeoutMs: 20 });
  a.createPayment = () => new Promise(() => {});
  const r = await hub.createPayment(order());
  assert.equal(r.attempt.gateway, 'a');
  assert.equal(r.attempt.status, 'UNKNOWN');
  assert.equal(b.created.length, 0, 'tiền có thể đã bị thu: không failover');
});

test('Hub: hoàn tiền khi cổng chưa gọi được (breaker mở) thì FAILED, gọi lại được sau khi breaker đóng', async () => {
  const { hub, a, clock } = hubWith();
  const { attempt } = await hub.createPayment(order());
  await hub.handleCallback('a', { channel: 'ipn', body: { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' }, headers: {} });
  hub.guards.a.state = 'open';
  hub.guards.a.openedAt = clock.now();
  const r1 = await hub.refund({ attemptId: attempt.id });
  assert.equal(r1.status, 'FAILED');
  assert.equal(a.refundCalls || 0, 0);
  clock.advance(31);
  const r2 = await hub.refund({ attemptId: attempt.id });
  assert.equal(r2.status, 'PROCESSING', 'đã đóng lại: hoàn được, số tiền của lần FAILED không bị tính');
});

test('Hub: đối soát không tính lần hỏi khi chưa gọi được (breaker mở): không tăng checks, hẹn lại sớm', async () => {
  const { hub, a, clock } = hubWith();
  const { attempt } = await hub.createPayment(order());
  const real = hub.store.getAttempt(attempt.id);
  hub.guards.a.state = 'open';
  hub.guards.a.openedAt = clock.now() + 3600 * 1000;
  clock.advance(61);
  const r = await hub.reconcile();
  assert.equal(r.queried, 0);
  assert.equal(real.checks, 0);
  assert.ok(real.nextCheckAt - clock.now() <= 10000);
  assert.equal(a.created.length, 1);
});

test('Hub: nhật ký gọi cổng lưu được và truy vấn theo mã tham chiếu', async () => {
  const { hub } = hubWith();
  const { attempt } = await hub.createPayment(order());
  const calls = await hub.listCalls({ ref: attempt.ref });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'createPayment');
  assert.equal(calls[0].outcome, 'ok');
  assert.equal(calls[0].gateway, 'a');
  assert.equal(JSON.stringify(calls).includes('returnUrl'), false, 'không ghi thân request');
  const st = hub.gatewayStatus();
  assert.deepEqual(st.map((s) => s.gateway), ['a', 'b']);
  assert.equal(st[0].state, 'closed');
});

test('Hub: protection.enabled=false thì không bọc adapter', async () => {
  const clock = createClock();
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({ adapters: { a }, clock, config: { gateways: [{ id: 'a' }], protection: { enabled: false } } });
  assert.equal(hub.adapters.a, a);
  assert.deepEqual(hub.gatewayStatus(), [{ gateway: 'a', state: 'unguarded' }]);
});

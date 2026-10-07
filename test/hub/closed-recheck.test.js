'use strict';
// spec: PHUB-S-027
// Hỏi lại attempt đã đóng KHÔNG thành công (PHUB-D-027): khách vẫn trả được trên URL cũ, nếu IPN mất hẳn thì Hub không bao giờ biết; nên Hub hỏi lại cổng
// theo lịch closedRecheckSeconds (mặc định 1 giờ và 24 giờ sau khi đóng) và ghi anomaly late_success khi tìm thấy tiền. Trạng thái cuối không đổi.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { createWorld, order: worldOrder } = require('../support/world');
const { freshDb, SKIP } = require('../support/pg');

function setup({ reconcile = {}, capsA, withFeedA = false } = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a', { caps: capsA, withFeed: withFeedA });
  const b = createFakeAdapter('b');
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a, b }, clock, newRef: (p) => `${p}${++n}`,
    config: { gateways: [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 100000, ...reconcile }, paymentTtlSeconds: 900, failover: { enabled: true, maxAttempts: 4 } },
  });
  return { hub, a, b, clock };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/r', ...o });
const cb = (hub, gw, body) => hub.handleCallback(gw, { channel: 'ipn', method: 'GET', query: {}, body: { ...body, source: 'ipn' }, headers: {} });
const paid = (at, txn = 'LATE1') => ({ gateway: at.gateway, attemptRef: at.ref, type: 'succeeded', amount: at.amount, gatewayTxnId: txn, occurredAt: 1, source: 'query' });
const closeA = async (s) => { const r = await s.hub.createPayment(order()); await cb(s.hub, 'a', { ref: r.attempt.ref, type: 'failed', amount: r.attempt.amount, txn: 'F' }); assert.equal(r.attempt.status, 'FAILED'); return r; };

test('attempt đóng thất bại được đặt lịch hỏi lại: mốc đầu 1 giờ sau khi đóng; tiền về muộn thành anomaly late_success, trạng thái cuối không đổi', async () => {
  const s = setup();
  const { attempt, payment } = await closeA(s);
  assert.equal(attempt.recheckAt, attempt.finalizedAt + 3600 * 1000);
  s.a.queryResults.set(attempt.ref, paid(attempt));
  await s.hub.reconcile();
  assert.equal(s.a.calls.query.filter((c) => c.attemptRef === attempt.ref).length, 0, 'chưa tới mốc thì chưa hỏi');
  s.clock.advance(3601);
  await s.hub.reconcile();
  const an = s.hub.listAnomalies({ type: 'late_success' });
  assert.equal(an.length, 1);
  assert.equal(an[0].gatewayTxnId, 'LATE1');
  assert.equal(attempt.status, 'FAILED', 'trạng thái cuối bất biến');
  assert.equal(payment.status, 'CLOSED', 'payment đã tự đóng sau thời hạn; tiền về muộn không mở lại nó');
  assert.equal(attempt.recheckAt, attempt.finalizedAt + 86400 * 1000, 'còn mốc 24 giờ');
});

test('hỏi hết các mốc thì dừng: không tìm thấy gì thì không anomaly, lịch xóa sau mốc cuối, số lần hỏi đúng bằng số mốc', async () => {
  const s = setup();
  const { attempt } = await closeA(s);
  s.a.queryResults.set(attempt.ref, { gateway: 'a', attemptRef: attempt.ref, type: 'pending', occurredAt: 1, source: 'query' });
  for (const sec of [3601, 86400, 86400, 86400]) { s.clock.advance(sec); await s.hub.reconcile(); }
  assert.equal(s.hub.listAnomalies().length, 0);
  assert.equal(attempt.recheckAt, null);
  assert.equal(attempt.rechecks, 2);
  const calls = s.a.calls.query.filter((c) => c.attemptRef === attempt.ref).length;
  assert.equal(calls, 2, 'đúng hai lần hỏi');
});

test('payment đã PAID bởi attempt khác mà attempt cũ tìm thấy tiền: duplicate_charge', async () => {
  const s = setup();
  const { payment, attempt: a1 } = await closeA(s);
  const { attempt: a2 } = await s.hub.createAttempt(payment.id, { reason: 'customer_retry' });
  await cb(s.hub, a2.gateway, { ref: a2.ref, type: 'succeeded', amount: a2.amount, txn: 'T2' });
  assert.equal(payment.status, 'PAID');
  (a1.gateway === 'a' ? s.a : s.b).queryResults.set(a1.ref, paid(a1));
  s.clock.advance(3601);
  await s.hub.reconcile();
  assert.equal(s.hub.listAnomalies({ type: 'duplicate_charge' }).length, 1);
});

test('tắt bằng [] (toàn cục hoặc theo cổng) thì không đặt lịch và không hỏi', async () => {
  for (const reconcile of [{ closedRecheckSeconds: [] }, { perGateway: { a: { closedRecheckSeconds: [] } } }]) {
    const s = setup({ reconcile });
    const { attempt } = await closeA(s);
    assert.equal(attempt.recheckAt, null);
    s.a.queryResults.set(attempt.ref, paid(attempt));
    s.clock.advance(100000);
    await s.hub.reconcile();
    assert.equal(s.hub.listAnomalies().length, 0);
  }
});

test('ghi đè theo cổng đổi mốc: cổng a hỏi sau 10 giây, cổng khác theo mặc định', async () => {
  const s = setup({ reconcile: { perGateway: { a: { closedRecheckSeconds: [10, 20] } } } });
  const { attempt } = await closeA(s);
  assert.equal(attempt.recheckAt, attempt.finalizedAt + 10000);
  s.a.queryResults.set(attempt.ref, paid(attempt));
  s.clock.advance(11);
  await s.hub.reconcile();
  assert.equal(s.hub.listAnomalies({ type: 'late_success' }).length, 1);
});

test('không đặt lịch khi: thành công, cổng từ chối lúc tạo (chưa từng có giao dịch), cổng không truy vấn được, cổng đã có sao kê đối soát', async () => {
  // thành công
  let s = setup();
  const ok = await s.hub.createPayment(order());
  await cb(s.hub, 'a', { ref: ok.attempt.ref, type: 'succeeded', amount: ok.attempt.amount, txn: 'T' });
  assert.ok(ok.attempt.recheckAt == null);
  // từ chối lúc tạo
  s = setup();
  s.a.createMode = 'rejected'; s.b.createMode = 'rejected';
  await assert.rejects(s.hub.createPayment(order()), (e) => e.code === 'no_gateway_available');
  for (const x of s.hub.store.attempts.values()) assert.ok(x.recheckAt == null, `attempt ${x.id} bị từ chối lúc tạo không được hỏi lại`);
  // không truy vấn được
  s = setup({ capsA: { queryable: false } });
  const nq = await closeA(s);
  assert.ok(nq.attempt.recheckAt == null);
  // có sao kê đối soát: tiền về muộn đã có đường khác bắt
  s = setup({ withFeedA: true });
  const fd = await closeA(s);
  assert.ok(fd.attempt.recheckAt == null);
});

test('Hub tự hủy attempt cũng được hỏi lại (hủy chưa chắc đã chặn được khách)', async () => {
  const s = setup({ capsA: { cancellable: true } });
  const { payment, attempt } = await s.hub.createPayment(order());
  await s.hub.createAttempt(payment.id, { reason: 'customer_retry', cancelLive: true });
  assert.equal(attempt.status, 'CANCELLED');
  assert.equal(attempt.recheckAt, attempt.finalizedAt + 3600 * 1000);
});

test('hỏi lỗi: thử lại sau 10 phút, quá 5 lần liên tiếp thì ngừng và ghi anomaly recheck_failed (không im lặng)', async () => {
  const s = setup();
  const { attempt } = await closeA(s);
  s.a.query = async () => { throw new Error('cổng sập'); };
  s.clock.advance(3601);
  await s.hub.reconcile();
  assert.equal(attempt.recheckErrors, 1);
  assert.equal(attempt.recheckAt, s.clock.now() + 600000);
  for (let i = 0; i < 6; i += 1) { s.clock.advance(601); await s.hub.reconcile(); }
  assert.equal(attempt.recheckAt, null);
  assert.equal(s.hub.listAnomalies({ type: 'recheck_failed' }).length, 1);
  // lần sau thành công thì bộ đếm lỗi về 0
  const s2 = setup();
  const r2 = await closeA(s2);
  let fail = true;
  s2.a.query = async () => { if (fail) throw new Error('x'); return { state: 'not_found' }; };
  s2.clock.advance(3601); await s2.hub.reconcile();
  assert.equal(r2.attempt.recheckErrors, 1);
  fail = false; s2.clock.advance(601); await s2.hub.reconcile();
  assert.equal(r2.attempt.recheckErrors, 0);
});

test('closedRecheckSeconds sai bị từ chối khi dựng Hub (toàn cục và theo cổng)', () => {
  const a = createFakeAdapter('a');
  const mk = (reconcile) => () => new PaymentHub({ adapters: { a }, config: { gateways: [{ id: 'a' }], reconcile } });
  for (const bad of ['3600', [0], [-5], [100, 50], [100, 100], ['x']]) assert.throws(mk({ closedRecheckSeconds: bad }), /closedRecheckSeconds/);
  assert.throws(mk({ perGateway: { a: { closedRecheckSeconds: [5, 1] } } }), /perGateway\.a\.closedRecheckSeconds/);
  assert.doesNotThrow(mk({ closedRecheckSeconds: [] }));
  assert.doesNotThrow(mk({ closedRecheckSeconds: [60, 3600] }));
});

test('số đo hub_closed_rechecks_total đếm theo kết quả', async () => {
  const s = setup();
  const { attempt } = await closeA(s);
  s.a.queryResults.set(attempt.ref, paid(attempt));
  s.clock.advance(3601);
  await s.hub.reconcile();
  assert.match(s.hub.metrics.render(), /hub_closed_rechecks_total\{gateway="a",outcome="found_money"\} 1/);
});

// ---- với simulator thật: khách trả muộn trên URL cũ, IPN mất hẳn
for (const id of ['momo', 'vnpay']) {
  test(`[${id}] khách trả muộn trên attempt đã FAILED và IPN mất hẳn: Hub vẫn thấy tiền (late_success) sau khi hỏi lại`, async () => {
    const w = await createWorld([id]);
    const d = w.drivers[id];
    try {
      const { attempt } = await w.hub.createPayment(worldOrder());
      await d.land(attempt);
      await d.pay(attempt, 'failed');
      assert.equal(attempt.status, 'FAILED');
      await d.control({ ipn_drop: true });
      await d.pay(attempt, 'success');
      assert.equal(w.hub.listAnomalies().length, 0, 'IPN mất nên chưa biết gì');
      for (const sec of [2000, 2000, 2000, 90000]) { await w.advance(sec); await w.hub.reconcile(); }
      const an = w.hub.listAnomalies({ type: 'late_success' });
      assert.equal(an.length, 1, 'tiền đã thu ở cổng phải được ghi nhận');
      assert.equal(an[0].amount, attempt.amount);
      assert.equal(attempt.status, 'FAILED');
    } finally { await w.close(); }
  });
}

test('[onepay] simulator từ chối trả trên hóa đơn đã đóng: không có tiền thì Hub không báo gì', async () => {
  const w = await createWorld(['onepay']);
  const d = w.drivers.onepay;
  try {
    const { attempt } = await w.hub.createPayment(worldOrder());
    await d.land(attempt);
    await d.pay(attempt, 'failed');
    await d.control({ ipn_drop: true });
    await d.pay(attempt, 'success');
    for (const sec of [2000, 2000, 2000, 90000]) { await w.advance(sec); await w.hub.reconcile(); }
    assert.equal(w.hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

// ---- PostgreSQL: lịch hỏi lại sống sót qua khởi động lại và không bị đẩy ra khỏi bộ nhớ
test('[PostgreSQL] lịch hỏi lại sống sót qua khởi động lại; payment còn lịch không bị evict; tìm thấy tiền sau khi nạp lại', { skip: SKIP, timeout: 120000 }, async () => {
  const db = freshDb();
  const w = await createWorld(['momo'], {}, { db });
  const d = w.drivers.momo;
  try {
    const { attempt } = await w.hub.createPayment(worldOrder());
    await d.land(attempt);
    await d.pay(attempt, 'failed');
    await d.control({ ipn_drop: true });
    await d.pay(attempt, 'success');
    const ref = attempt.ref;
    assert.ok(attempt.recheckAt != null);
    // cho payment tự đóng (quá hạn 30 phút) nhưng chưa tới mốc hỏi lại đầu (1 giờ): lúc này payment CLOSED, chỉ lịch hỏi lại giữ nó trong bộ nhớ và khi khởi động
    await w.advance(2000);
    await w.hub.reconcile();
    assert.equal(w.hub.store.getPayment(attempt.paymentId).status, 'CLOSED');
    assert.ok(attempt.recheckAt != null && w.hub.listAnomalies().length === 0);
    await w.hub.store.persist();
    assert.equal(w.hub.store.evictIdle(0, Date.now() + 3600e3), 0, 'còn lịch hỏi lại thì chưa được đẩy ra');
    await w.restart();
    const again = w.hub.store.findAttemptByRef('momo', ref);
    assert.ok(again, 'payment có lịch hỏi lại được nạp lại khi khởi động');
    assert.ok(again.recheckAt != null);
    for (const sec of [2000, 90000]) { await w.advance(sec); await w.hub.reconcile(); }
    assert.equal((await w.hub.findAnomalies({ type: 'late_success' })).length, 1);
    assert.equal(again.recheckAt, null);
    await w.hub.store.persist();
    assert.equal(w.hub.store.evictIdle(0, Date.now() + 3600e3), 0, 'còn anomaly mở thì chưa đẩy ra (như mọi payment có anomaly mở)');
    const [an] = await w.hub.findAnomalies({ type: 'late_success' });
    await w.hub.resolveAnomaly(an.id, { action: 'ignore', note: 'đã xử lý' });
    await w.hub.store.persist();
    assert.ok(w.hub.store.evictIdle(0, Date.now() + 3600e3) >= 1, 'hỏi xong và anomaly đã xử lý thì được đẩy ra như thường');
  } finally { await w.close(); await db.cleanup(); }
});

'use strict';
// spec: PHUB-S-020
// Mã lý do thất bại chuẩn (PHUB-D-020): adapter dịch mã riêng của cổng sang mã chuẩn, lõi và routing chỉ đọc mã chuẩn,
// mã chưa biết luôn là "unknown", và cấu hình ghi đè chỉ đổi LÝ DO, không bao giờ đổi việc có tiền hay không.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFailCodeMapper } = require('../../src/adapters/fail-codes');
const { assertEvent, FAIL_CODES } = require('../../src/contract');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { createWorld, order } = require('../support/world');

test('bảng mã chuẩn: mặc định, ghi đè thắng, mã lạ và thiếu mã ra unknown', () => {
  const m = createFailCodeMapper('x', { '24': 'user_cancelled', 51: 'insufficient_funds' }, { '51': 'declined', '99': 'gateway_error' });
  assert.equal(m('24'), 'user_cancelled');
  assert.equal(m(24), 'user_cancelled', 'số và chuỗi như nhau');
  assert.equal(m('51'), 'declined', 'ghi đè thắng mặc định');
  assert.equal(m('99'), 'gateway_error', 'bổ sung mã mới');
  assert.equal(m('12345'), 'unknown');
  assert.equal(m(undefined), 'unknown');
  assert.equal(m(null), 'unknown');
});

test('bảng mã sai bị từ chối ngay khi dựng, nói rõ mã nào sai', () => {
  assert.throws(() => createFailCodeMapper('x', {}, { '24': 'cancelled_by_user' }), /failCodeMap\[24\]="cancelled_by_user" không phải mã chuẩn/);
  assert.throws(() => createFailCodeMapper('x', {}, []), /phải là đối tượng/);
  assert.throws(() => createFailCodeMapper('x', {}, 'abc'), /phải là đối tượng/);
  const { createVnpayAdapter } = require('../../src/adapters/vnpay');
  const { createMomoAdapter } = require('../../src/adapters/momo');
  const { createOnepayAdapter } = require('../../src/adapters/onepay');
  const { createSepayAdapter } = require('../../src/adapters/sepay');
  const bad = { failCodeMap: { '1': 'nope' } };
  assert.throws(() => createVnpayAdapter({ tmnCode: 'T', hashSecret: 'S', ...bad }), /vnpay: failCodeMap\[1\]/);
  assert.throws(() => createMomoAdapter({ partnerCode: 'P', accessKey: 'a', secretKey: 's', ...bad }), /momo: failCodeMap\[1\]/);
  assert.throws(() => createOnepayAdapter({ merchant: 'M', accessCode: 'A', hashKeyHex: '00112233445566778899AABBCCDDEEFF', ...bad }), /onepay: failCodeMap\[1\]/);
  assert.throws(() => createSepayAdapter({ accountNumber: '1', bankName: 'B', accountName: 'N', ...bad }), /sepay: failCodeMap\[1\]/);
});

test('sự kiện chuẩn: failCode phải thuộc bảng và chỉ dành cho failed, cancelled, expired', () => {
  const base = { gateway: 'g', attemptRef: 'A', occurredAt: 1, source: 'ipn', amount: 1000 };
  for (const type of ['failed', 'cancelled', 'expired']) for (const failCode of FAIL_CODES) assert.equal(assertEvent({ ...base, type, failCode }), true);
  assert.equal(assertEvent({ ...base, type: 'failed' }), true, 'vắng failCode vẫn hợp lệ (hiểu là unknown)');
  assert.throws(() => assertEvent({ ...base, type: 'failed', failCode: 'bogus' }), /failCode không hợp lệ/);
  for (const type of ['succeeded', 'pending', 'reversed']) assert.throws(() => assertEvent({ ...base, type, gatewayTxnId: 't', failCode: 'declined' }), /chỉ dành cho/);
});

// ---- Hub dùng mã chuẩn (adapter giả, không cổng thật)
function setup(cfg = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a');
  const b = createFakeAdapter('b');
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a, b }, clock, newRef: (p) => `${p}${++n}`,
    config: { gateways: [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 3600 }, failover: { enabled: true, maxAttempts: 5, ...(cfg.failover || {}) } },
  });
  return { hub, a, b, clock };
}
const cb = (hub, body, source = 'ipn') => hub.handleCallback(body.gw || 'a', { channel: 'ipn', method: 'GET', query: {}, body: { ...body, source }, headers: {} });
const order1 = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });

test('Hub ghi failCode và gatewayCode của sự kiện lên attempt; thiếu failCode ra unknown; thành công thì không có', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order1());
  // sự kiện thật do adapter dựng: fake adapter đọc body, nên chuyển failCode qua parseCallback bằng cách bọc
  const raw = hub.rawAdapters.a.parseCallback.bind(hub.rawAdapters.a);
  hub.adapters.a.parseCallback = (req) => { const r = raw(req); if (r.event && req.body.failCode) { r.event.failCode = req.body.failCode; r.event.gatewayCode = req.body.gatewayCode; } return r; };
  await cb(hub, { ref: attempt.ref, type: 'failed', amount: attempt.amount, txn: 'F', failCode: 'insufficient_funds', gatewayCode: '51' });
  assert.equal(attempt.status, 'FAILED');
  assert.equal(attempt.failCode, 'insufficient_funds');
  assert.equal(attempt.gatewayCode, '51');
  const p2 = await hub.createAttempt(attempt.paymentId, { reason: 'customer_retry' });
  await cb(hub, { ref: p2.attempt.ref, type: 'failed', amount: p2.attempt.amount, txn: 'F2' });
  assert.equal(p2.attempt.failCode, 'unknown', 'adapter không nói gì thì unknown');
  assert.equal(p2.attempt.gatewayCode, null);
  const p3 = await hub.createAttempt(attempt.paymentId, { reason: 'customer_retry' });
  await cb(hub, { ref: p3.attempt.ref, type: 'succeeded', amount: p3.attempt.amount, txn: 'OK' });
  assert.equal(p3.attempt.status, 'SUCCEEDED');
  assert.ok(!p3.attempt.failCode, 'thành công thì không có lý do thất bại');
});

test('failover chỉ đọc lý do chuẩn: mặc định không chặn; skipOnFailCodes chặn đúng mã, mã khác vẫn chuyển cổng', async () => {
  for (const [skip, failCode, blocked] of [[[], 'user_cancelled', false], [['user_cancelled'], 'user_cancelled', true], [['user_cancelled'], 'gateway_error', false], [['user_cancelled', 'declined'], 'declined', true], [['user_cancelled'], 'unknown', false]]) {
    const { hub } = setup({ failover: { skipOnFailCodes: skip } });
    const { payment, attempt } = await hub.createPayment(order1());
    const raw = hub.rawAdapters.a.parseCallback.bind(hub.rawAdapters.a);
    hub.adapters.a.parseCallback = (req) => { const r = raw(req); if (r.event) r.event.failCode = failCode; return r; };
    await cb(hub, { ref: attempt.ref, type: 'cancelled', amount: attempt.amount, txn: 'C' });
    const go = hub.createAttempt(payment.id, { reason: 'failover' });
    if (blocked) await assert.rejects(go, (e) => e.code === 'failover_not_applicable' && e.message.includes(failCode));
    else assert.equal((await go).attempt.gateway, 'b', `skip=${skip} failCode=${failCode}`);
  }
});

test('failover bị chặn thì customer_retry vẫn dùng được (khách muốn thử lại)', async () => {
  const { hub } = setup({ failover: { skipOnFailCodes: ['user_cancelled'] } });
  const { payment, attempt } = await hub.createPayment(order1());
  const raw = hub.rawAdapters.a.parseCallback.bind(hub.rawAdapters.a);
  hub.adapters.a.parseCallback = (req) => { const r = raw(req); if (r.event) r.event.failCode = 'user_cancelled'; return r; };
  await cb(hub, { ref: attempt.ref, type: 'cancelled', amount: attempt.amount, txn: 'C' });
  await assert.rejects(hub.createAttempt(payment.id, { reason: 'failover' }), (e) => e.code === 'failover_not_applicable');
  const r = await hub.createAttempt(payment.id, { reason: 'customer_retry' });
  assert.ok(r.attempt.id);
});

test('skipOnFailCodes sai bị từ chối khi dựng Hub', () => {
  const a = createFakeAdapter('a');
  const mk = (skip) => () => new PaymentHub({ adapters: { a }, config: { gateways: [{ id: 'a' }], failover: { enabled: true, maxAttempts: 3, skipOnFailCodes: skip } } });
  assert.throws(mk(['nope']), /skipOnFailCodes/);
  assert.throws(mk('user_cancelled'), /skipOnFailCodes/);
  assert.doesNotThrow(mk(['user_cancelled', 'declined']));
});

test('số đo hub_attempt_failures_total đếm theo cổng, trạng thái và lý do chuẩn; Hub tự hủy ghi none', async () => {
  const { hub } = setup();
  const { attempt } = await hub.createPayment(order1());
  await cb(hub, { ref: attempt.ref, type: 'failed', amount: attempt.amount, txn: 'F' });
  const text = hub.metrics.render();
  assert.match(text, /hub_attempt_failures_total\{fail_code="unknown",gateway="a",status="FAILED"\} 1/);
  // Hub tự hủy attempt (không phải cổng báo): fail_code none, không bị tính là lý do của cổng
  const c = createFakeAdapter('c', { caps: { cancellable: true } });
  const hub2 = new PaymentHub({ adapters: { c }, config: { gateways: [{ id: 'c' }] } });
  const first = await hub2.createPayment(order1());
  await hub2.createAttempt(first.payment.id, { reason: 'customer_retry', cancelLive: true });
  const live = first;
  assert.equal(live.attempt.status, 'CANCELLED');
  assert.ok(!live.attempt.failCode, 'Hub tự hủy: không có lý do của cổng');
  assert.match(hub2.metrics.render(), /hub_attempt_failures_total\{fail_code="none",gateway="c",status="CANCELLED"\} 1/);
});

test('lý do từ chối lúc tạo: rejected có failCode thì ghi lên attempt, thiếu hoặc sai thì unknown', async () => {
  for (const [res, want] of [[{ status: 'rejected', reason: 'r', failCode: 'invalid_request', gatewayCode: '22' }, 'invalid_request'], [{ status: 'rejected', reason: 'r' }, 'unknown'], [{ status: 'rejected', reason: 'r', failCode: 'bogus' }, 'unknown']]) {
    const a = createFakeAdapter('a');
    a.createPayment = async () => res;
    const hub = new PaymentHub({ adapters: { a }, config: { gateways: [{ id: 'a' }] } });
    await assert.rejects(hub.createPayment(order1()), (e) => e.code === 'no_gateway_available');
    const [att] = [...hub.store.attempts.values()];
    assert.equal(att.failCode, want);
    assert.equal(att.gatewayCode, res.gatewayCode || null);
  }
});

// ---- Từng cổng thật với simulator thật
const SCENARIOS = {
  vnpay: [['cancel', 'CANCELLED', 'user_cancelled', '24'], ['failed', 'FAILED', 'insufficient_funds', '51']],
  momo: [['cancel', 'CANCELLED', 'user_cancelled', '1006'], ['failed', 'FAILED', 'insufficient_funds', '1001']],
  onepay: [['cancel', 'CANCELLED', 'user_cancelled', '99'], ['failed', 'FAILED', 'unknown', '1']],
};
for (const [id, list] of Object.entries(SCENARIOS)) {
  for (const [outcome, status, failCode, gatewayCode] of list) {
    test(`[${id}] khách ${outcome}: attempt ${status}, lý do chuẩn ${failCode}, mã gốc ${gatewayCode}`, async () => {
      const w = await createWorld([id]);
      try {
        const { attempt } = await w.hub.createPayment(order());
        await w.drivers[id].land(attempt);
        await w.drivers[id].pay(attempt, outcome);
        assert.equal(attempt.status, status);
        assert.equal(attempt.failCode, failCode);
        assert.equal(attempt.gatewayCode, gatewayCode);
      } finally { await w.close(); }
    });
  }

  test(`[${id}] ghi đè failCodeMap trong cấu hình đổi lý do, không đổi trạng thái; loại sự kiện vẫn do adapter quyết định`, async () => {
    const [, status, , gatewayCode] = list[1];
    const w = await createWorld([id], {}, { [id]: { adapter: { failCodeMap: { [gatewayCode]: 'gateway_error', 0: 'declined' } } } });
    try {
      const { attempt } = await w.hub.createPayment(order());
      await w.drivers[id].land(attempt);
      await w.drivers[id].pay(attempt, list[1][0]);
      assert.equal(attempt.status, status);
      assert.equal(attempt.failCode, 'gateway_error');
      // mã thành công "0" bị ghi đè sang declined cũng không làm một thanh toán thành công thành thất bại
      const second = await w.hub.createPayment(order());
      await w.drivers[id].land(second.attempt);
      await w.drivers[id].pay(second.attempt, 'success');
      assert.equal(second.attempt.status, 'SUCCEEDED');
      assert.ok(!second.attempt.failCode);
      assert.equal(second.payment.status, 'PAID');
    } finally { await w.close(); }
  });
}

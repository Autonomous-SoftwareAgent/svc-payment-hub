'use strict';
// spec: PHUB-S-019
// Thông báo của cổng đến KHI attempt còn CREATED, tức trước khi lời gọi tạo giao dịch trả về (P-011, nhóm 1).
// Cổng nhanh có thể gửi IPN trước khi phản hồi tạo đến nơi. Tiền đã vào thì kết quả của lời gọi tạo đến sau không được ghi đè trạng thái cuối.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

function setup(createMode) {
  const clock = createClock();
  const a = createFakeAdapter('a');
  if (createMode) a.createMode = createMode;
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a }, clock, newRef: (p) => `${p}${++n}`,
    config: { gateways: [{ id: 'a', priority: 1 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 100000 }, paymentTtlSeconds: 900, failover: { enabled: true, maxAttempts: 4 } },
  });
  // Giữ lời gọi tạo lại cho tới khi test nhả; trong lúc đó attempt đứng ở CREATED.
  let release;
  const gate = new Promise((r) => { release = r; });
  const inner = a.createPayment;
  let entered;
  const enteredP = new Promise((r) => { entered = r; });
  a.createPayment = async (p) => { entered(p); await gate; return inner(p); };
  return { hub, a, release, enteredP };
}
const order = () => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/r' });
const ipn = (hub, ref, type, txn = 'T1') => hub.handleCallback('a', { channel: 'ipn', method: 'GET', query: {}, body: { ref, type, amount: 100000, txn, source: 'ipn' }, headers: {} });

async function startInFlight(s) {
  const p = s.hub.createPayment(order());
  p.catch(() => {}); // tránh báo lỗi chưa xử lý nếu test hỏng giữa chừng
  const created = await s.enteredP; // adapter đã nhận lời gọi tạo; attempt đang CREATED
  const attempt = s.hub.store.findAttemptByRef('a', created.attemptRef);
  assert.equal(attempt.status, 'CREATED');
  return { p, attempt };
}

test('IPN thành công đến khi attempt còn CREATED: tiền được ghi nhận, lời gọi tạo trả về sau không kéo trạng thái lùi về AWAITING', async () => {
  const s = setup();
  const { p, attempt } = await startInFlight(s);
  const r = await ipn(s.hub, attempt.ref, 'succeeded');
  assert.equal(r.outcome, 'ok');
  assert.equal(attempt.status, 'SUCCEEDED');
  s.release();
  const out = await p;
  assert.equal(out.attempt.status, 'SUCCEEDED', 'trạng thái cuối bất biến, kể cả khi lời gọi tạo trả về muộn');
  assert.equal(out.payment.status, 'PAID');
  assert.equal(s.hub.listAnomalies().length, 0, 'không sinh anomaly giả');
});

test('IPN thất bại đến khi attempt còn CREATED: lời gọi tạo trả về sau không mở lại attempt đã FAILED', async () => {
  const s = setup();
  const { p, attempt } = await startInFlight(s);
  await ipn(s.hub, attempt.ref, 'failed', 'F1');
  assert.equal(attempt.status, 'FAILED');
  s.release();
  await p.catch(() => {}); // trả attempt hay báo no_gateway_available đều được; điều không được là sống lại
  assert.equal(attempt.status, 'FAILED', 'attempt đã đóng không được sống lại thành AWAITING');
});

test('IPN thành công đến khi CREATED, rồi lời gọi tạo trả "chưa rõ": vẫn giữ SUCCEEDED, không thành UNKNOWN', async () => {
  const s = setup('unknown');
  const { p, attempt } = await startInFlight(s);
  await ipn(s.hub, attempt.ref, 'succeeded');
  s.release();
  await p;
  assert.equal(attempt.status, 'SUCCEEDED');
});

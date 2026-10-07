'use strict';
// spec: PHUB-S-022
// VNPay mã 07 ("Trừ tiền thành công. Giao dịch bị nghi ngờ"): tiền có thể đã bị trừ nên KHÔNG bao giờ là thất bại (PHUB-D-022).
// Bảng đầy đủ các tổ hợp mã kết quả theo bảng chính thức, để đổi mã không làm lệch ngầm.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapResult } = require('../../src/adapters/vnpay');
const { createWorld, order } = require('../support/world');

// [vnp_ResponseCode, vnp_TransactionStatus, loại sự kiện chuẩn mong đợi]. Nguồn mã: https://sandbox.vnpayment.vn/apis/docs/bang-ma-loi/
const TABLE = [
  ['00', '00', 'succeeded'],
  ['07', '07', 'pending'], ['07', '02', 'pending'], ['07', '00', 'pending'], ['00', '07', 'pending'], ['51', '07', 'pending'],
  ['24', '02', 'cancelled'], ['11', '02', 'expired'],
  ['09', '02', 'failed'], ['10', '02', 'failed'], ['12', '02', 'failed'], ['13', '02', 'failed'], ['51', '02', 'failed'], ['65', '02', 'failed'], ['75', '02', 'failed'], ['79', '02', 'failed'], ['99', '02', 'failed'],
  // mâu thuẫn hoặc thiếu trường: có thể đã mất tiền, không bao giờ failed
  ['00', '02', 'pending'], ['51', '00', 'pending'], ['51', '04', 'pending'], ['51', '01', 'pending'], [undefined, '02', 'pending'], ['51', undefined, 'pending'],
];

test('bảng mã kết quả VNPay: mỗi tổ hợp ra đúng loại sự kiện chuẩn; mã 07 và mâu thuẫn luôn là pending', () => {
  for (const [rc, ts, want] of TABLE) assert.equal(mapResult(rc, ts), want, `rc=${rc} ts=${ts}`);
});

test('mã 07 qua Hub với simulator: attempt vẫn đang chờ, không cho tạo attempt khác, quá hạn thì báo người vận hành, không bao giờ FAILED', async () => {
  const w = await createWorld(['vnpay']);
  const d = w.drivers.vnpay;
  try {
    await d.control({ scope: 'global', force_response_code: '07' });
    const { payment, attempt } = await w.hub.createPayment(order());
    await d.land(attempt);
    await d.pay(attempt, 'success');
    assert.equal(attempt.status, 'AWAITING', 'tiền có thể đã bị trừ: không được FAILED');
    assert.equal(payment.status, 'OPEN');
    assert.ok(!attempt.failCode, 'pending không có lý do thất bại');
    await assert.rejects(w.hub.createAttempt(payment.id, { reason: 'failover' }), (e) => e.code === 'attempt_still_live');
    await w.advance(86401);
    await w.hub.reconcile();
    assert.equal(attempt.status, 'AWAITING', 'đối soát không tự kết luận');
    assert.equal(attempt.needsOperator, true);
    assert.ok(w.hub.listAnomalies({ type: 'stale_attempt' }).length >= 1);
  } finally { await w.close(); }
});

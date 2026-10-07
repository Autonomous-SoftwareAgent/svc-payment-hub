'use strict';
// spec: PHUB-S-002
// spec: PHUB-S-006
// Kiểm tra tích hợp: lõi Hub + adapter thật + simulator thật, với kịch bản bất lợi.
// Mỗi kịch bản chạy cho từng cổng có driver; điều cần giữ là bất biến về tiền, không phải chi tiết của cổng.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, order, DRIVERS } = require('../support/world');

// Kịch bản chung ở đây dành cho cổng kiểu chuyển hướng (khách trả/thất bại/hủy); kiểu chuyển khoản có file riêng.
const GATEWAYS = Object.keys(DRIVERS).filter((g) => g !== 'sepay');

async function start(id, hubOpts) {
  const w = await createWorld([id], hubOpts);
  const d = w.drivers[id];
  const { payment, attempt } = await w.hub.createPayment(order());
  await d.land(attempt);
  return { w, d, hub: w.hub, payment, attempt };
}
const anomalies = (hub, type) => hub.listAnomalies(type ? { type } : {});

for (const id of GATEWAYS) {
  test(`[${id}] thanh toán thành công qua IPN`, async () => {
    const { w, d, payment, attempt } = await start(id);
    try {
      await d.pay(attempt, 'success');
      assert.equal(attempt.status, 'SUCCEEDED');
      assert.equal(payment.status, 'PAID');
      assert.ok(attempt.gatewayTxnId, 'có mã giao dịch của cổng');
      assert.equal(anomalies(w.hub).length, 0);
    } finally { await w.close(); }
  });

  test(`[${id}] IPN mất hẳn: đối soát bằng query tìm ra tiền`, async () => {
    const { w, d, payment, attempt } = await start(id);
    try {
      await d.control({ ipn_drop: true });
      await d.pay(attempt, 'success');
      assert.equal(payment.status, 'OPEN', 'chưa có thông báo nào');
      await w.advance(61);
      await w.hub.reconcile();
      assert.equal(attempt.status, 'SUCCEEDED');
      assert.equal(payment.status, 'PAID');
    } finally { await w.close(); }
  });

  test(`[${id}] IPN trùng: chỉ ghi nhận một lần, không anomaly`, async () => {
    const { w, d, payment, attempt } = await start(id);
    try {
      await d.control({ ipn_duplicate: true });
      await d.pay(attempt, 'success');
      assert.equal(payment.status, 'PAID');
      assert.equal(anomalies(w.hub).length, 0);
      assert.equal(w.hub.store.events.filter((e) => e.duplicate).length >= 1, true, 'bản trùng được nhận diện');
    } finally { await w.close(); }
  });

  test(`[${id}] IPN sai số tiền: giữ lại, không ghi nhận; query xác nhận số tiền thật`, async () => {
    const { w, d, payment, attempt } = await start(id);
    try {
      await d.control({ ipn_wrong_amount: true });
      await d.pay(attempt, 'success');
      assert.equal(attempt.status, 'AWAITING');
      assert.equal(payment.status, 'OPEN');
      assert.equal(anomalies(w.hub, 'amount_mismatch').length >= 1, true);
      await w.advance(61);
      await w.hub.reconcile(); // query là trọng tài
      assert.equal(payment.status, 'PAID');
    } finally { await w.close(); }
  });

  test(`[${id}] IPN sai chữ ký: từ chối, không đổi trạng thái; query vẫn tìm ra tiền`, async () => {
    const { w, d, payment, attempt } = await start(id);
    try {
      await d.control({ ipn_bad_signature: true, ipn_retry_max: 0, ipn_retry_count: 0 });
      await d.pay(attempt, 'success');
      assert.equal(attempt.status, 'AWAITING');
      assert.equal(payment.status, 'OPEN');
      assert.ok(w.hub.store.events.some((e) => e.outcome === 'invalid_signature'));
      await w.advance(61);
      await w.hub.reconcile();
      assert.equal(payment.status, 'PAID');
    } finally { await w.close(); }
  });

  test(`[${id}] IPN đến trễ sau khi đối soát đã thấy kết quả: không đổi gì`, async () => {
    const { w, d, payment, attempt } = await start(id);
    try {
      await d.control({ ipn_delay_seconds: 1200 });
      await d.pay(attempt, 'success');
      await w.advance(61);
      await w.hub.reconcile();
      assert.equal(payment.status, 'PAID');
      await w.advance(1200); // IPN trễ tới nơi
      assert.equal(payment.status, 'PAID');
      assert.equal(attempt.status, 'SUCCEEDED');
      assert.equal(anomalies(w.hub).length, 0);
    } finally { await w.close(); }
  });

  test(`[${id}] khách thanh toán thất bại: attempt FAILED, payment vẫn mở, tạo được attempt mới`, async () => {
    const { w, d, hub, payment, attempt } = await start(id);
    try {
      await d.pay(attempt, 'failed');
      assert.equal(attempt.status, 'FAILED');
      assert.equal(payment.status, 'OPEN');
      const r = await hub.createAttempt(payment.id);
      assert.notEqual(r.attempt.ref, attempt.ref);
    } finally { await w.close(); }
  });

  test(`[${id}] khách trả sau khi hết hạn: tiền không bao giờ mất (PAID hoặc late_success)`, async () => {
    const { w, d, hub, payment, attempt } = await start(id);
    try {
      await d.control({ paid_after_expiry: true }); // kịch bản bất lợi: tiền về sau hết hạn (unverified)
      await w.advance(3600);
      await hub.reconcile();
      await d.pay(attempt, 'success');
      await w.advance(61);
      await hub.reconcile();
      const kept = payment.status === 'PAID' || anomalies(hub, 'late_success').length > 0;
      assert.equal(kept, true, `payment=${payment.status} attempt=${attempt.status}`);
    } finally { await w.close(); }
  });

  test(`[${id}] hoàn tiền sau khi thu: đi vào trạng thái xác định`, async () => {
    const { w, d, hub, attempt } = await start(id);
    try {
      await d.pay(attempt, 'success');
      const r = await hub.refund({ attemptId: attempt.id });
      assert.ok(['MANUAL_REQUIRED', 'PROCESSING', 'SUCCEEDED', 'REQUESTED', 'FAILED'].includes(r.status), r.status);
      assert.equal(r.amount, attempt.amount);
    } finally { await w.close(); }
  });
}

// ---------- kịch bản riêng của từng cổng ----------
if (GATEWAYS.includes('momo')) {
  test('[momo] tạo đơn mất phản hồi: UNKNOWN, không failover, đối soát tìm ra rồi khách trả', async () => {
    const w = await createWorld(['momo']);
    const d = w.drivers.momo;
    try {
      await d.control({ create_drop_response: true });
      const { payment, attempt } = await w.hub.createPayment(order());
      assert.equal(attempt.status, 'UNKNOWN');
      await assert.rejects(w.hub.createAttempt(payment.id, { reason: 'failover' }), { code: 'attempt_still_live' });
      await d.control({ create_drop_response: false });
      await w.advance(61);
      await w.hub.reconcile(); // query thấy đơn đang chờ (1000)
      assert.equal(attempt.status, 'AWAITING');
      await d.pay(attempt, 'success');
      assert.equal(payment.status, 'PAID');
    } finally { await w.close(); }
  });

  test('[momo] hoàn tiền bất đồng bộ: PROCESSING rồi SUCCEEDED; thất bại muộn được ghi nhận', async () => {
    for (const final of ['success', 'failed']) {
      const w = await createWorld(['momo']);
      const d = w.drivers.momo;
      try {
        await d.control({ refund_mode: 'async', refund_async_final: final, refund_async_delay_seconds: 3600 });
        const { attempt } = await w.hub.createPayment(order());
        await d.pay(attempt, 'success');
        const r = await w.hub.refund({ attemptId: attempt.id });
        assert.equal(r.status, 'PROCESSING');
        await w.advance(3700);
        await w.hub.reconcile();
        assert.equal(r.status, final === 'success' ? 'SUCCEEDED' : 'FAILED');
      } finally { await w.close(); }
    }
  });

  test('[momo] attempt cũ đã FAILED nhưng khách vẫn trả được trên payUrl cũ: duplicate_charge', async () => {
    const w = await createWorld(['momo']);
    const d = w.drivers.momo;
    try {
      const { payment, attempt: a1 } = await w.hub.createPayment(order());
      await d.pay(a1, 'failed');
      assert.equal(a1.status, 'FAILED');
      const { attempt: a2 } = await w.hub.createAttempt(payment.id);
      await d.pay(a2, 'success');
      assert.equal(payment.status, 'PAID');
      await d.pay(a1, 'success'); // khách thử lại trên payUrl cũ (A17 unverified)
      assert.equal(a1.status, 'FAILED', 'trạng thái cuối bất biến');
      assert.equal(anomalies(w.hub, 'duplicate_charge').length, 1);
      const [an] = anomalies(w.hub, 'duplicate_charge');
      const done = await w.hub.resolveAnomaly(an.id, { action: 'refund' });
      assert.equal(done.status, 'refunding');
    } finally { await w.close(); }
  });

  test('[momo] 9000 (authorized) được xem là đang chờ, không phải thất bại', async () => {
    const { w, d, payment, attempt } = await start('momo');
    try {
      await d.pay(attempt, 'authorized');
      assert.equal(payment.status, 'OPEN');
      assert.notEqual(attempt.status, 'FAILED');
    } finally { await w.close(); }
  });
}

if (GATEWAYS.includes('onepay')) {
  test('[onepay] hết hạn theo cổng: query ra expired, payment đóng; tiền về muộn thành late_success', async () => {
    const { w, d, hub, payment, attempt } = await start('onepay');
    try {
      await w.drivers.onepay.control({ paid_after_expiry: true });
      await w.advance(31 * 60);
      await hub.reconcile();
      assert.equal(attempt.status, 'EXPIRED');
      assert.equal(payment.status, 'CLOSED');
      await d.pay(attempt, 'success'); // paid_after_expiry (A12 unverified)
      await w.advance(61);
      await hub.reconcile();
      assert.equal(attempt.status, 'EXPIRED', 'trạng thái cuối bất biến');
      assert.equal(payment.status, 'CLOSED');
      assert.equal(anomalies(hub, 'late_success').length, 1);
      const [an] = anomalies(hub, 'late_success');
      const done = await hub.resolveAnomaly(an.id, { action: 'refund' });
      const refund = hub.store.getRefund(done.refundId);
      assert.equal(refund.status, 'MANUAL_REQUIRED', 'OnePAY không có API hoàn tiền');
    } finally { await w.close(); }
  });

  test('[onepay] mã 100 (đang xử lý) không bao giờ thành failed dù đối soát nhiều lần', async () => {
    const { w, hub, payment, attempt } = await start('onepay');
    try {
      for (let i = 0; i < 4; i += 1) { await w.advance(200); await hub.reconcile(); }
      assert.equal(attempt.status, 'AWAITING');
      assert.equal(payment.status, 'OPEN');
    } finally { await w.close(); }
  });
}

// ---------- chuyển cổng ----------
if (GATEWAYS.includes('momo') && GATEWAYS.includes('onepay')) {
  test('[momo -> onepay] failover chỉ sau khi attempt đầu chắc chắn không nhận tiền', async () => {
    const w = await createWorld(['momo', 'onepay']);
    try {
      const { hub } = w;
      const { payment, attempt: a1 } = await hub.createPayment(order());
      assert.equal(a1.gateway, 'momo');
      await assert.rejects(hub.createAttempt(payment.id, { reason: 'failover' }), { code: 'attempt_still_live' });
      await w.drivers.momo.pay(a1, 'failed');
      const { attempt: a2 } = await hub.createAttempt(payment.id, { reason: 'failover' });
      assert.equal(a2.gateway, 'onepay');
      await w.drivers.onepay.land(a2);
      await w.drivers.onepay.pay(a2, 'success');
      assert.equal(payment.status, 'PAID');
      assert.equal(payment.paidByAttempt, a2.id);
      assert.equal(anomalies(hub).length, 0);
    } finally { await w.close(); }
  });

  test('[momo -> onepay] tạo đơn MoMo mất phản hồi thì KHÔNG chuyển sang OnePAY (tiền có thể đã thu)', async () => {
    const w = await createWorld(['momo', 'onepay']);
    try {
      await w.drivers.momo.control({ create_drop_response: true });
      const { payment, attempt } = await w.hub.createPayment(order());
      assert.equal(attempt.gateway, 'momo');
      assert.equal(attempt.status, 'UNKNOWN');
      assert.equal(w.hub.getPayment(payment.id).attempts.length, 1);
      await assert.rejects(w.hub.createAttempt(payment.id, { reason: 'failover' }), { code: 'attempt_still_live' });
    } finally { await w.close(); }
  });
}

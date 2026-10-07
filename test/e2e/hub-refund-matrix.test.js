'use strict';
// spec: PHUB-S-006
// spec: PHUB-S-002
// Ma trận luồng x cổng (P-011, nhóm 4), phần HOÀN MỘT PHẦN: mỗi cổng có driver (VNPay, MoMo, OnePAY, SePay A, Stripe, PayPal) chạy cùng một bộ kịch bản qua lõi Hub +
// adapter thật + simulator thật. Điều cần giữ là bất biến về tiền: tổng các khoản hoàn chưa hỏng không bao giờ vượt số đã thu, hoàn quá số còn lại bị từ chối,
// chưa thu thì không hoàn được. Trạng thái cuối của từng khoản hoàn tùy cổng (cổng không có API hoàn thì MANUAL_REQUIRED), nên chỉ kiểm tập trạng thái hợp lệ.
// CHỈ chạy với simulator: chưa kiểm hoàn một phần với cổng thật nào.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, order, DRIVERS } = require('../support/world');

const VALID = ['MANUAL_REQUIRED', 'PROCESSING', 'SUCCEEDED', 'REQUESTED'];
// Mỗi dòng: id cổng, tạo thế giới, đơn, và cách khách trả.
const CASES = [
  ...Object.keys(DRIVERS).filter((g) => g !== 'sepay').map((id) => ({ name: id, gateways: [id], extra: {}, order: () => order({ amount: 150000 }), land: true })),
  { name: 'sepay-A', gateways: ['sepay'], extra: { sepay: {} }, order: () => order({ amount: 150000 }), land: false },
  { name: 'stripe', gateways: ['stripe'], extra: { stripe: {} }, order: () => order({ amount: 5000, currency: 'USD' }), land: false },
  { name: 'paypal', gateways: ['paypal'], extra: { paypal: {} }, order: () => order({ amount: 5000, currency: 'USD' }), land: false },
];

async function paid(c) {
  const w = await createWorld(c.gateways, {}, c.extra);
  const d = w.drivers[c.gateways[0]];
  const { payment, attempt } = await w.hub.createPayment(c.order());
  if (c.land) await d.land(attempt);
  await d.pay(attempt, 'success');
  assert.equal(attempt.status, 'SUCCEEDED', `${c.name}: phải thu được trước khi hoàn`);
  return { w, hub: w.hub, payment, attempt };
}
const live = (hub, id) => hub.store.refundsOfAttempt(id).filter((r) => r.status !== 'FAILED');
const sum = (rs) => rs.reduce((s, r) => s + r.amount, 0);

for (const c of CASES) {
  test(`[${c.name}] hoàn một phần rồi hoàn nốt phần còn lại: tổng đúng bằng số đã thu, mỗi khoản ở trạng thái hợp lệ`, async () => {
    const { w, hub, attempt } = await paid(c);
    try {
      const part = Math.floor(attempt.amount * 0.4);
      const r1 = await hub.refund({ attemptId: attempt.id, amount: part });
      assert.equal(r1.amount, part);
      assert.ok(VALID.includes(r1.status), `${c.name}: khoản hoàn một phần ở trạng thái ${r1.status}, mong một trong ${VALID.join('/')}`);
      const r2 = await hub.refund({ attemptId: attempt.id }); // mặc định = phần còn lại
      assert.equal(r2.amount, attempt.amount - part);
      assert.ok(VALID.includes(r2.status), `${c.name}: khoản hoàn nốt ở trạng thái ${r2.status}`);
      assert.equal(sum(live(hub, attempt.id)), attempt.amount, 'tổng hoàn đúng bằng số đã thu');
    } finally { await w.close(); }
  });

  test(`[${c.name}] hoàn quá số còn lại bị từ chối, không tạo khoản hoàn nào; chưa thu thì không hoàn được`, async () => {
    const { w, hub, attempt, payment } = await paid(c);
    try {
      const part = Math.floor(attempt.amount * 0.4);
      await hub.refund({ attemptId: attempt.id, amount: part });
      await assert.rejects(hub.refund({ attemptId: attempt.id, amount: attempt.amount - part + 1 }), { code: 'invalid_refund_amount' });
      await assert.rejects(hub.refund({ attemptId: attempt.id, amount: 0 }), { code: 'invalid_refund_amount' });
      assert.equal(live(hub, attempt.id).length, 1, 'các lần bị từ chối không để lại khoản hoàn');
      assert.ok(sum(live(hub, attempt.id)) <= attempt.amount);
      // Attempt khác của cùng cổng chưa thu: không hoàn được.
      const w2 = await createWorld(c.gateways, {}, c.extra);
      try {
        const { attempt: unpaid } = await w2.hub.createPayment(c.order());
        await assert.rejects(w2.hub.refund({ attemptId: unpaid.id }), { code: 'nothing_to_refund' });
      } finally { await w2.close(); }
      void payment;
    } finally { await w.close(); }
  });
}

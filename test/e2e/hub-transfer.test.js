'use strict';
// spec: PHUB-S-001
// spec: PHUB-S-002
// spec: PHUB-S-006
// spec: SEPY-S-002
// Tích hợp kiểu chuyển khoản do khách chủ động: lõi Hub + adapter SePay + simulator SePay (webhook ký HMAC trên body thô).
// Bất biến cần giữ: mọi khoản tiền vào đều được ghi lại, không bao giờ đếm hai lần, không bao giờ bỏ im lặng.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, order } = require('../support/world');
const { SKIP, freshDb } = require('../support/pg');

async function start(hubOpts) {
  const w = await createWorld(['sepay'], hubOpts);
  const d = w.drivers.sepay;
  const { payment, attempt } = await w.hub.createPayment(order());
  return { w, d, hub: w.hub, payment, attempt };
}
const an = (hub, type) => hub.listAnomalies({ type });

test('[sepay] hướng dẫn chuyển khoản; khách chuyển đủ thì webhook (ký HMAC) đưa payment sang PAID', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    assert.equal(attempt.status, 'AWAITING');
    assert.equal(attempt.instructions.accountNumber, '0123456789');
    assert.match(attempt.instructions.transferContent, /^DH[A-Z0-9]+$/);
    await d.transfer(attempt);
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(payment.status, 'PAID');
    assert.equal(w.hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('[sepay] webhook sai chữ ký bị từ chối; sao kê và query vẫn tìm ra tiền', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ webhook_bad_auth: true, webhook_retry_max_attempts: 1 });
    await d.transfer(attempt);
    assert.equal(payment.status, 'OPEN');
    assert.ok(w.hub.store.events.some((e) => e.outcome === 'invalid_signature'));
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('[sepay] webhook mất hẳn: đối soát tìm ra khoản tiền', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ webhook_drop: true });
    await d.transfer(attempt);
    assert.equal(payment.status, 'OPEN');
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.receivedTotal, attempt.amount, 'webhook mất, sao kê và query không đếm hai lần');
  } finally { await w.close(); }
});

test('[sepay] webhook trùng: chỉ tính một lần', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ webhook_duplicate: 3 });
    await d.transfer(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.receivedTotal, attempt.amount);
    assert.equal(w.hub.listAnomalies().length, 0);
    await w.advance(61);
    await w.hub.reconcile(); // sao kê thấy lại cùng khoản
    assert.equal(attempt.receivedTotal, attempt.amount);
    assert.equal(w.hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('[sepay] khách chuyển thiếu rồi bù: underpaid giữ chờ, đủ thì PAID', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.transfer(attempt, { amount: 100000 });
    assert.equal(payment.status, 'OPEN');
    assert.equal(an(w.hub, 'underpaid')[0].amount, 100000);
    await d.transfer(attempt, { amount: 50000 });
    assert.equal(payment.status, 'PAID');
    assert.equal(an(w.hub, 'underpaid')[0].status, 'superseded');
  } finally { await w.close(); }
});

test('[sepay] khách chuyển thừa: PAID, phần dư là overpaid, hoàn thủ công', async () => {
  const { w, d, hub, payment, attempt } = await start();
  try {
    await d.transfer(attempt, { amount: 200000 });
    assert.equal(payment.status, 'PAID');
    const [over] = an(hub, 'overpaid');
    assert.equal(over.amount, 50000);
    const done = await hub.resolveAnomaly(over.id, { action: 'refund' });
    const refund = hub.store.getRefund(done.refundId);
    assert.equal(refund.status, 'MANUAL_REQUIRED', 'SePay không có API hoàn tiền');
    assert.equal((await hub.markRefundDone(refund.id)).status, 'SUCCEEDED');
  } finally { await w.close(); }
});

test('[sepay] khách chuyển hai lần đủ tiền: lần hai là duplicate_charge', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.transfer(attempt);
    await d.transfer(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(an(w.hub, 'duplicate_charge').length, 1);
  } finally { await w.close(); }
});

test('[sepay] không ghi mã trong nội dung: unmatched_funds, tiền không bị mất, payment vẫn mở', async () => {
  const { w, d, payment } = await start();
  try {
    await d.transfer({ instructions: { transferContent: 'chuyen tien an trua' }, amount: 150000 });
    assert.equal(payment.status, 'OPEN');
    const [u] = an(w.hub, 'unmatched_funds');
    assert.equal(u.amount, 150000);
    assert.equal(u.detail.content, 'chuyen tien an trua');
  } finally { await w.close(); }
});

test('[sepay] SePay không tách được code nhưng nội dung có mã: adapter vẫn khớp attempt', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ code_extraction: false });
    await d.transfer(attempt, { content: `thanh toan ${attempt.instructions.transferContent} cam on` });
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('[sepay] ngân hàng đổi chữ thường: vẫn khớp (tra cứu mã không phân biệt hoa thường)', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ content_mangle: 'lowercase' });
    await d.transfer(attempt);
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('[sepay] ngân hàng cắt cụt nội dung: không khớp attempt nào nhưng tiền vẫn được ghi (unknown_attempt)', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ content_mangle: 'truncate:5' });
    await d.transfer(attempt);
    assert.equal(payment.status, 'OPEN');
    const total = w.hub.listAnomalies().filter((x) => ['unknown_attempt', 'unmatched_funds'].includes(x.type)).reduce((s, x) => s + x.amount, 0);
    assert.equal(total, attempt.amount, 'số tiền vào được ghi nhận đủ, chờ xử lý thủ công');
  } finally { await w.close(); }
});

test('[sepay] QR tĩnh không hết hạn: khách chuyển sau nhiều giờ vẫn PAID, không thành late_success', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await w.advance(6 * 3600);
    await w.hub.reconcile();
    assert.equal(attempt.status, 'AWAITING');
    assert.equal(payment.status, 'OPEN');
    await d.transfer(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(an(w.hub, 'late_success').length, 0);
  } finally { await w.close(); }
});

test('[sepay] tiền ra trong luồng webhook bị bỏ qua', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ webhook_send_out: true });
    await d.transfer(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.receivedTotal, attempt.amount);
    assert.equal(w.hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('[sepay] form-urlencoded: mọi giá trị là chuỗi vẫn xử lý đúng', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ webhook_content_type: 'form' });
    await d.transfer(attempt);
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('[sepay] webhook đảo thứ tự và trễ: kết quả cuối vẫn đúng', async () => {
  const { w, d, payment, attempt } = await start();
  try {
    await d.control({ webhook_delay_seconds: 600 });
    await d.transfer(attempt, { amount: 100000 });
    await d.transfer(attempt, { amount: 50000 });
    assert.equal(payment.status, 'OPEN', 'webhook chưa tới');
    await w.advance(61);
    await w.hub.reconcile(); // sao kê thấy cả hai khoản
    assert.equal(payment.status, 'PAID');
    await w.advance(600); // webhook trễ tới nơi: không đếm lại
    assert.equal(attempt.receivedTotal, 150000);
    // Sao kê trả khoản mới trước nên underpaid xuất hiện thoáng qua rồi được thay thế; không còn cảnh báo nào đang mở.
    assert.equal(w.hub.listAnomalies({ status: 'open' }).length, 0);
  } finally { await w.close(); }
});

test('[sepay] attempt chuyển khoản còn có thể nhận tiền nên không tạo attempt mới hay chuyển cổng', async () => {
  const { w, hub, payment } = await start();
  try {
    await assert.rejects(hub.createAttempt(payment.id, { reason: 'failover' }), { code: 'attempt_still_live' });
    await assert.rejects(hub.createAttempt(payment.id), { code: 'attempt_still_live' });
  } finally { await w.close(); }
});

test('[sepay] hoàn tiền sau khi thu: MANUAL_REQUIRED', async () => {
  const { w, d, hub, attempt } = await start();
  try {
    await d.transfer(attempt);
    const r = await hub.refund({ attemptId: attempt.id });
    assert.equal(r.status, 'MANUAL_REQUIRED');
    assert.equal(r.amount, attempt.amount);
  } finally { await w.close(); }
});

test('[onepay -> sepay] OnePAY thất bại hẳn thì chuyển sang chuyển khoản SePay, khách chuyển khoản, PAID', async () => {
  const w = await createWorld(['onepay', 'sepay']);
  try {
    const { hub } = w;
    const { payment, attempt: a1 } = await hub.createPayment(order());
    assert.equal(a1.gateway, 'onepay');
    await w.drivers.onepay.land(a1);
    await w.drivers.onepay.pay(a1, 'failed');
    const { attempt: a2 } = await hub.createAttempt(payment.id, { reason: 'failover' });
    assert.equal(a2.gateway, 'sepay');
    assert.ok(a2.instructions && !a2.url);
    await w.drivers.sepay.transfer(a2);
    assert.equal(payment.status, 'PAID');
    assert.equal(payment.paidByAttempt, a2.id);
    assert.equal(hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('[sepay] khởi động lại Hub giữa chừng (đã nhận thiếu tiền): trạng thái được nạp lại từ PostgreSQL, bù đủ thì PAID, sao kê không đếm lại', { skip: SKIP }, async () => {
  const db = freshDb();
  const w = await createWorld(['sepay'], {}, { db });
  const d = w.drivers.sepay;
  try {
    const { payment, attempt } = await w.hub.createPayment(order());
    await d.transfer(attempt, { amount: 100000 });
    assert.equal(w.hub.getPayment(payment.id).payment.status, 'OPEN');
    const hub2 = await w.restart(); // tiến trình Hub chết và chạy lại trên cùng cơ sở dữ liệu
    const got = hub2.getPayment(payment.id);
    assert.equal(got.attempts[0].receivedTotal, 100000);
    assert.equal(an(hub2, 'underpaid')[0].amount, 100000);
    await d.transfer(attempt, { amount: 50000 });
    assert.equal(hub2.getPayment(payment.id).payment.status, 'PAID');
    await w.advance(61);
    await hub2.reconcile(); // sao kê thấy lại cả hai khoản: không đếm lại sau restart
    assert.equal(hub2.getPayment(payment.id).attempts[0].receivedTotal, 150000);
    assert.equal(hub2.listAnomalies({ status: 'open' }).length, 0);
  } finally {
    await w.close();
    await db.cleanup();
  }
});

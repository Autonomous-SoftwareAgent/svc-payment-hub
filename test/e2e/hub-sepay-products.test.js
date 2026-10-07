'use strict';
// spec: SEPY-S-007
// spec: SEPY-S-004
// spec: SEPY-S-005
// spec: SEPY-S-006
// Hub + adapter SePay (một adapter, ba sản phẩm chọn theo product) + simulator SePay. Bất biến: mọi khoản tiền vào được ghi lại, không đếm hai lần,
// không bao giờ bỏ im lặng. Simulator chỉ mô phỏng GIẢ ĐỊNH đã ghi trong SEPY-D-004/005 (docs-only): test này chứng minh Hub khớp giả định, không chứng minh SePay thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, order } = require('../support/world');

const an = (hub, type) => hub.listAnomalies({ type });

async function startVa(vaBank = 'VietinBank', opts = {}, hubOpts = {}) {
  const w = await createWorld(['sepay'], hubOpts, { sepay: { vaBank, ...opts } });
  const d = w.drivers.sepay;
  const { payment, attempt } = await w.hub.createPayment(order({ product: 'va-order' }));
  return { w, d, hub: w.hub, payment, attempt };
}
async function startPg(opts = {}, hubOpts = {}) {
  const w = await createWorld(['sepay'], hubOpts, { sepay: { pg: true, ...opts } });
  const d = w.drivers.sepay;
  const { payment, attempt } = await w.hub.createPayment(order({ product: 'gateway' }));
  await d.land(attempt);
  return { w, d, hub: w.hub, payment, attempt };
}

// ---------------- B: VA theo đơn ----------------

test('[sepay va-order] attempt có hướng dẫn chuyển vào VA riêng; khách chuyển đủ thì webhook đưa payment sang PAID', async () => {
  const { w, d, payment, attempt } = await startVa();
  try {
    assert.equal(attempt.product, 'va-order');
    assert.equal(attempt.status, 'AWAITING');
    assert.match(attempt.instructions.accountNumber, /^963\d+$/);
    assert.ok(!attempt.url);
    assert.match(attempt.ref, /^DH[A-Z0-9]+$/);
    await d.transfer(attempt);
    assert.equal(attempt.status, 'SUCCEEDED'); assert.equal(payment.status, 'PAID');
    assert.equal(w.hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('[sepay va-order] trả thiếu rồi bù: underpaid giữ chờ, đủ thì PAID (VietinBank nhận trả thiếu)', async () => {
  const { w, d, payment, attempt } = await startVa();
  try {
    await d.transfer(attempt, { amount: 100000 });
    assert.equal(payment.status, 'OPEN'); assert.equal(an(w.hub, 'underpaid')[0].amount, 100000);
    await d.transfer(attempt, { amount: 50000 });
    assert.equal(payment.status, 'PAID'); assert.equal(an(w.hub, 'underpaid')[0].status, 'superseded');
    assert.equal(attempt.receivedTotal, 150000);
  } finally { await w.close(); }
});

test('[sepay va-order] VietinBank: chuyển lớn hơn amount không khớp VA -> tiền vào tài khoản thật, webhook không mang VA: unmatched_funds, payment vẫn mở', async () => {
  const { w, d, payment, attempt } = await startVa();
  try {
    await d.transfer(attempt, { amount: 170000 });
    assert.equal(payment.status, 'OPEN');
    const [u] = an(w.hub, 'unmatched_funds');
    assert.equal(u.amount, 170000);
    // nếu webhook mang VA thì tiền được gắn attempt: đủ và thừa -> PAID + overpaid, hoàn thủ công cho phần dư
    await d.control({ va_unmatched_subaccount: 'va' });
    await d.transfer(attempt, { amount: 170000 });
    assert.equal(payment.status, 'PAID');
    assert.equal(an(w.hub, 'overpaid')[0].amount, 20000);
  } finally { await w.close(); }
});

test('[sepay va-order] Sacombank chỉ nhận đúng số tiền: chuyển sai mà tiền vẫn vào (land) -> underpaid, đúng thì PAID; bị ngân hàng từ chối (reject) thì không có gì xảy ra', async () => {
  const { w, d, payment, attempt } = await startVa('Sacombank', { controls: { va_unmatched_subaccount: 'va' } });
  try {
    await d.transfer(attempt, { amount: 100000 });
    assert.equal(payment.status, 'OPEN'); assert.equal(an(w.hub, 'underpaid')[0].amount, 100000);
    await d.control({ va_mismatch_mode: 'reject' });
    assert.equal((await d.transfer(attempt, { amount: 99 })).status, 422);
    assert.equal(attempt.receivedTotal, 100000);
    await d.control({ va_mismatch_mode: 'land' });
    await d.transfer(attempt); // đúng số tiền của đơn
    assert.equal(payment.status, 'PAID');
    assert.equal(attempt.receivedTotal, 250000, 'Hub cộng mọi khoản đã nhận: 100000 sai + 150000 đúng, phần dư là overpaid cần hoàn');
    assert.equal(an(w.hub, 'overpaid')[0].amount, 100000);
  } finally { await w.close(); }
});

test('[sepay va-order] webhook mất: sao kê và query cùng tìm ra khoản, không đếm hai lần', async () => {
  const { w, d, payment, attempt } = await startVa();
  try {
    await d.control({ webhook_drop: true });
    await d.transfer(attempt);
    assert.equal(payment.status, 'OPEN');
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(payment.status, 'PAID'); assert.equal(attempt.receivedTotal, attempt.amount);
    await w.advance(61);
    await w.hub.reconcile();
    assert.equal(attempt.receivedTotal, attempt.amount);
    assert.equal(w.hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('[sepay va-order] webhook trùng, trễ và đảo thứ tự: kết quả cuối vẫn đúng, không đếm đôi', async () => {
  const { w, d, payment, attempt } = await startVa();
  try {
    await d.control({ webhook_duplicate: 3 });
    await d.transfer(attempt, { amount: 100000 });
    await d.control({ webhook_duplicate: 1, webhook_delay_seconds: 600 });
    await d.transfer(attempt, { amount: 50000 });
    assert.equal(payment.status, 'OPEN');
    await w.advance(61);
    await w.hub.reconcile(); // sao kê thấy khoản bị trễ
    assert.equal(payment.status, 'PAID');
    await w.advance(600); // webhook trễ tới nơi
    assert.equal(attempt.receivedTotal, 150000);
    assert.equal(w.hub.listAnomalies({ status: 'open' }).length, 0);
  } finally { await w.close(); }
});

test('[sepay va-order] mất phản hồi khi tạo đơn: attempt UNKNOWN (không failover), tiền vào VA của đơn đã tạo vẫn được nhận ra (phân giải VA qua danh sách đơn)', async () => {
  const w = await createWorld(['sepay'], {}, { sepay: { vaBank: 'VietinBank', controls: { va_create_mode: 'lost_response' } } });
  try {
    const d = w.drivers.sepay;
    const { payment, attempt } = await w.hub.createPayment(order({ product: 'va-order' }));
    assert.equal(attempt.status, 'UNKNOWN');
    assert.equal(d.sim.state.orders.length, 1, 'SePay đã tạo đơn');
    await assert.rejects(w.hub.createAttempt(payment.id, { reason: 'failover' }), { code: 'attempt_still_live' });
    const va = d.sim.state.orders[0].va[0].va_number;
    await d.control({ va_create_mode: 'ok' });
    await fetch(`${d.sim.url}/sim/transfer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ va, amount: 150000 }) });
    assert.equal(payment.status, 'PAID', 'webhook mang subAccount: adapter phân giải VA -> attemptRef');
    assert.equal(attempt.receivedTotal, 150000);
  } finally { await w.close(); }
});

test('[sepay va-order] khách hàng thử lại: Hub hủy VA cũ (hủy được vì chưa có tiền) rồi tạo VA mới; tiền về VA cũ sau đó là late_success, không mất', async () => {
  const { w, d, hub, payment, attempt: a1 } = await startVa('VietinBank', { controls: { va_closed_mode: 'land', va_unmatched_subaccount: 'va' } });
  try {
    const { attempt: a2 } = await hub.createAttempt(payment.id, { reason: 'customer_retry', cancelLive: true });
    assert.equal(a1.status, 'CANCELLED');
    assert.notEqual(a2.instructions.accountNumber, a1.instructions.accountNumber);
    assert.equal(d.sim.state.orders.find((o) => o.id === a1.instructions.orderId).status, 'Cancelled');
    await d.transfer(a1); // khách vẫn chuyển vào VA cũ (ngân hàng không chặn: giả định xấu)
    assert.equal(an(hub, 'late_success').length, 1);
    assert.equal(payment.status, 'OPEN', 'tiền vào VA đã hủy không tự đóng payment');
    await d.transfer(a2);
    assert.equal(payment.status, 'PAID');
    assert.equal(an(hub, 'duplicate_charge').length, 0);
  } finally { await w.close(); }
});

test('[sepay va-order] hủy đua với thanh toán: đã có tiền nên SePay từ chối hủy, Hub không tạo attempt mới', async () => {
  const { w, d, hub, payment, attempt } = await startVa('VietinBank');
  try {
    await d.transfer(attempt, { amount: 100000 }); // trả thiếu: đơn sang Partially, không hủy được
    await assert.rejects(hub.createAttempt(payment.id, { reason: 'customer_retry', cancelLive: true }), { code: 'attempt_still_live' });
    assert.equal(attempt.status, 'AWAITING');
  } finally { await w.close(); }
});

test('[sepay va-order] hoàn tiền qua API (refundApi): pending -> succeeded sau đối soát; không bật refundApi thì MANUAL_REQUIRED', async () => {
  const { w, d, hub, attempt } = await startVa('VietinBank', { refundApi: true });
  try {
    await d.transfer(attempt);
    const r = await hub.refund({ attemptId: attempt.id });
    assert.notEqual(r.status, 'MANUAL_REQUIRED');
    assert.equal(d.sim.state.refunds.length, 1); assert.equal(d.sim.state.refunds[0].amount, attempt.amount);
    await w.advance(61);
    await hub.reconcile();
    assert.equal(hub.store.getRefund(r.id).status, 'SUCCEEDED');
  } finally { await w.close(); }
  const off = await startVa('VietinBank');
  try {
    await off.d.transfer(off.attempt);
    assert.equal((await off.hub.refund({ attemptId: off.attempt.id })).status, 'MANUAL_REQUIRED');
  } finally { await off.w.close(); }
});

// ---------------- C: cổng pay.sepay.vn ----------------

test('[sepay gateway] attempt kiểu redirect; khách mở form (POST đã ký), trả trên trang SePay, IPN đưa payment sang PAID; trình duyệt quay về Hub chỉ để hiển thị', async () => {
  const { w, d, payment, attempt } = await startPg();
  try {
    assert.equal(attempt.product, 'gateway'); assert.equal(attempt.status, 'AWAITING');
    assert.match(attempt.url, /\/v1\/checkout\/init$/);
    assert.ok(!attempt.instructions);
    assert.equal(d.sim.state.pgOrders.length, 1);
    const r = await d.pgPay(attempt);
    assert.equal(r.status, 200);
    assert.equal(attempt.status, 'SUCCEEDED'); assert.equal(payment.status, 'PAID');
    assert.equal(attempt.gatewayTxnId.startsWith('68ba'), true);
    assert.equal(w.hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('[sepay gateway] trình duyệt về cancel_url/error_url (return) không đổi trạng thái; IPN mất thì query cứu', async () => {
  const { w, d, hub, payment, attempt } = await startPg();
  try {
    await d.control({ webhook_drop: true });
    await d.pgPay(attempt, { outcome: 'error' }); // trình duyệt về error_url
    assert.equal(attempt.status, 'AWAITING'); assert.equal(payment.status, 'OPEN');
    await d.pgPay(attempt); // trả thành công nhưng IPN mất
    assert.equal(payment.status, 'OPEN');
    await w.advance(61);
    await hub.reconcile();
    assert.equal(payment.status, 'PAID'); assert.equal(attempt.status, 'SUCCEEDED');
  } finally { await w.close(); }
});

test('[sepay gateway] thẻ bị từ chối rồi khách thử lại: không bao giờ FAILED giữa chừng, thử lại thành công thì PAID', async () => {
  const { w, d, payment, attempt } = await startPg({ controls: { pg_ipn_on_decline: true } });
  try {
    await d.pgPay(attempt, { outcome: 'declined', method: 'CARD' });
    assert.equal(attempt.status, 'AWAITING'); assert.equal(payment.status, 'OPEN');
    await d.pgPay(attempt, { method: 'CARD' });
    assert.equal(payment.status, 'PAID');
    assert.equal(w.hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('[sepay gateway] IPN sai khóa bí mật bị từ chối; sau đó query tìm ra thanh toán', async () => {
  const { w, d, hub, payment, attempt } = await startPg({ controls: { webhook_bad_auth: true, webhook_retry_max_attempts: 1 } });
  try {
    await d.pgPay(attempt);
    assert.equal(payment.status, 'OPEN');
    assert.ok(hub.store.events.some((e) => e.outcome === 'invalid_signature'));
    await w.advance(61);
    await hub.reconcile();
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('[sepay gateway] IPN trùng; IPN đến trễ sau khi query đã thấy thanh toán (id giao dịch hai kênh khác nhau): chỉ tính một lần, không anomaly', async () => {
  const { w, d, hub, payment, attempt } = await startPg({ controls: { webhook_duplicate: 3 } });
  try {
    await d.pgPay(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(hub.listAnomalies().length, 0);
  } finally { await w.close(); }
  const late = await startPg({ controls: { webhook_delay_seconds: 600 } });
  try {
    await late.d.pgPay(late.attempt);
    assert.equal(late.payment.status, 'OPEN');
    await late.w.advance(61);
    await late.hub.reconcile(); // query thấy CAPTURED (gatewayTxnId của API chi tiết)
    assert.equal(late.payment.status, 'PAID');
    const txnViaQuery = late.attempt.gatewayTxnId;
    await late.w.advance(600); // IPN trễ tới nơi, mang transaction_id khác
    assert.equal(late.payment.status, 'PAID'); assert.equal(late.attempt.status, 'SUCCEEDED');
    assert.equal(late.attempt.gatewayTxnId, txnViaQuery);
    assert.equal(late.hub.listAnomalies().length, 0);
  } finally { await late.w.close(); }
});

test('[sepay gateway] khách trả khác số tiền của đơn: amount_mismatch, payment không tự PAID', async () => {
  const { w, d, payment, attempt } = await startPg();
  try {
    await d.pgPay(attempt, { amount: 120000 });
    assert.equal(payment.status, 'OPEN');
    assert.equal(an(w.hub, 'amount_mismatch').length, 1);
    assert.equal(an(w.hub, 'amount_mismatch')[0].amount, 120000);
  } finally { await w.close(); }
});

test('[sepay gateway] void thẻ sau khi đã thu: funds_reversed cho người vận hành, payment giữ trạng thái cuối (không tự đảo), hoàn tiền chỉ tính phần còn lại', async () => {
  const { w, d, hub, payment, attempt } = await startPg();
  try {
    await d.pgPay(attempt, { method: 'CARD' });
    assert.equal(payment.status, 'PAID');
    const v = await fetch(`${d.sim.url}/sim/pg/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoice: attempt.ref }) });
    assert.equal(v.status, 200);
    assert.equal(an(hub, 'funds_reversed').length, 1);
    assert.equal(an(hub, 'conflicting_result').length, 0, 'void không còn mượn cancelled');
    assert.equal(payment.status, 'PAID'); assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(attempt.needsOperator, true); assert.equal(attempt.reversedTotal, attempt.amount);
    assert.equal(an(hub, 'funds_reversed')[0].gatewayTxnId, `void:${attempt.ref}`);
    // đối soát sau đó cũng thấy VOID (kênh query): cùng mã nên không cộng lần hai
    attempt.nextCheckAt = 0; await hub.reconcile();
    assert.equal(attempt.reversedTotal, attempt.amount, 'IPN và truy vấn không tính hai lần');
    await assert.rejects(hub.refund({ attemptId: attempt.id }), { code: 'nothing_to_refund' }, 'đã bị đảo hết nên không hoàn được');
  } finally { await w.close(); }
});

test('[sepay gateway] khách hàng thử lại: Hub hủy đơn cổng chưa trả rồi tạo attempt mới; đơn đã CAPTURED thì không hủy được', async () => {
  const { w, d, hub, payment, attempt: a1 } = await startPg();
  try {
    const { attempt: a2 } = await hub.createAttempt(payment.id, { reason: 'customer_retry', cancelLive: true });
    assert.equal(a1.status, 'CANCELLED');
    assert.notEqual(a2.ref, a1.ref);
    await d.land(a2);
    await d.pgPay(a2);
    assert.equal(payment.status, 'PAID');
    // khách đã trả ở attempt 2: attempt 3 không được tạo (payment đã đóng)
    await assert.rejects(hub.createAttempt(payment.id, { reason: 'customer_retry', cancelLive: true }), { code: 'payment_not_open' });
  } finally { await w.close(); }
});

test('[sepay gateway] hoàn tiền: MANUAL_REQUIRED (cổng không có API hoàn)', async () => {
  const { w, d, hub, attempt } = await startPg();
  try {
    await d.pgPay(attempt);
    assert.equal((await hub.refund({ attemptId: attempt.id })).status, 'MANUAL_REQUIRED');
  } finally { await w.close(); }
});

// ---------------- Ba sản phẩm cùng lúc ----------------

test('[sepay qr-static + va-order + gateway] ba payment cùng lúc trong một adapter: mỗi cái PAID đúng sản phẩm, không lẫn, không khoản chưa rõ chủ', async () => {
  const w = await createWorld(['sepay'], {}, { sepay: { vaBank: 'BIDV', pg: true } });
  try {
    const d = w.drivers.sepay;
    const { hub } = w;
    const pa = await hub.createPayment(order({ product: 'qr-static' }));
    const pb = await hub.createPayment(order({ product: 'va-order' }));
    const pc = await hub.createPayment(order({ product: 'gateway' }));
    assert.deepEqual([pa.attempt.product, pb.attempt.product, pc.attempt.product], ['qr-static', 'va-order', 'gateway']);
    assert.ok(pa.attempt.instructions.transferContent); assert.ok(pb.attempt.instructions.accountNumber.startsWith('963')); assert.ok(pc.attempt.url);
    await d.land(pc.attempt);
    await d.transfer(pa.attempt);
    await d.transfer(pb.attempt);
    await d.pgPay(pc.attempt);
    for (const p of [pa, pb, pc]) assert.equal(p.payment.status, 'PAID', p.attempt.product);
    await w.advance(61);
    await hub.reconcile(); // sao kê thấy lại cả hai khoản chuyển khoản: không đếm lại
    assert.equal(pa.attempt.receivedTotal, pa.attempt.amount); assert.equal(pb.attempt.receivedTotal, pb.attempt.amount);
    assert.equal(hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

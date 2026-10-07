'use strict';
// spec: PHUB-S-018
// spec: SEPY-S-007
// Hub + SePay thật-với-simulator: B (VA theo đơn) làm chính, C (cổng thẻ) dự phòng, cùng một adapter (PHUB-D-018 P6, SEPY-D-007).
// Chỉ chứng minh Hub khớp giả định của simulator (SEPY-D-004/005), không chứng minh SePay thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, order } = require('../support/world');
const { createSepayAdapter } = require('../../src/adapters/sepay');

const GATEWAYS = [{ id: 'sepay', adapterProduct: 'va-order', priority: 1 }, { id: 'sepay', adapterProduct: 'gateway', priority: 2 }];
const an = (hub, type) => hub.listAnomalies({ type });

async function start(sepayOpts = {}, hubOpts = {}) {
  const w = await createWorld(['sepay'], { gateways: GATEWAYS, ...hubOpts }, { sepay: { vaBank: 'VietinBank', pg: true, ...sepayOpts } });
  return { w, d: w.drivers.sepay, hub: w.hub };
}

test('B chính: payment không chỉ định product dùng VA theo đơn, attempt giữ state, hướng dẫn không có transferContent; chuyển đủ thì PAID', async () => {
  const { w, d, hub } = await start();
  try {
    const { payment, attempt } = await hub.createPayment(order());
    assert.equal(attempt.product, 'va-order');
    assert.equal(attempt.status, 'AWAITING');
    assert.ok(attempt.state.orderId && attempt.state.vas.length === 1, 'state do adapter trả');
    assert.equal(attempt.instructions.transferContent, undefined);
    await d.transfer(attempt);
    assert.equal(payment.status, 'PAID');
    assert.equal(hub.listAnomalies().length, 0);
  } finally { await w.close(); }
});

test('B bị từ chối (không tìm thấy tài khoản VA) thì C dự phòng nhận ngay trong lần tạo; khách trả bằng thẻ thì PAID', async () => {
  const { w, d, hub } = await start({ va: { bankAccountId: 'khong-ton-tai' } });
  try {
    const { payment, attempt } = await hub.createPayment(order());
    assert.equal(attempt.product, 'gateway');
    const atts = hub.store.attemptsOfPayment(payment.id);
    assert.deepEqual(atts.map((a) => [a.product, a.status]), [['va-order', 'FAILED'], ['gateway', 'AWAITING']]);
    await d.land(attempt);
    await d.pgPay(attempt);
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('khách hủy B rồi failover: attempt kế là C của cùng adapter (không bị loại vì cùng id cổng)', async () => {
  const { w, d, hub } = await start();
  try {
    const { payment, attempt: b } = await hub.createPayment(order());
    assert.equal(b.product, 'va-order');
    const { attempt: c } = await hub.createAttempt(payment.id, { reason: 'failover', cancelLive: true });
    assert.equal(b.status, 'CANCELLED', 'VA đã hủy bằng state');
    assert.equal(c.product, 'gateway');
    await d.land(c);
    await d.pgPay(c);
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('payment đòi đúng product: product "gateway" chỉ dùng mục C, "va-order" chỉ dùng mục B', async () => {
  const { w, hub } = await start();
  try {
    assert.equal((await hub.createPayment(order({ product: 'gateway' }))).attempt.product, 'gateway');
    assert.equal((await hub.createPayment(order({ product: 'va-order' }))).attempt.product, 'va-order');
  } finally { await w.close(); }
});

test('P7: webhook đến lúc API tra VA quá tải: Hub trả ack lỗi (SePay gửi lại), không tạo anomaly; lần gửi lại thành công thì PAID', async () => {
  const { w, d, hub } = await start({ controls: { api_rate_limit: 1 } });
  try {
    const { payment, attempt } = await hub.createPayment(order({ product: 'va-order' }));
    // Adapter của Hub đã biết VA (vừa tạo đơn). Thay bằng adapter cùng cấu hình nhưng đệm trống (như sau khởi động lại) cho đường callback.
    const cold = createSepayAdapter({
      accountNumber: '0123456789', bankName: 'MBBank', accountName: 'X', codePrefix: 'DH', apiKey: 'test-api-key-not-real', hmacSecret: 'test-hmac-secret-not-real', apiToken: 'test-api-token-not-real', authMode: 'hmac',
      apiBaseUrl: `${d.sim.url}/v2`, va: { bankAccountId: d.sim.config.bankAccountId }, timeoutMs: 3000,
    }, { clock: d.sim.clock });
    hub.adapters.sepay = Object.create(hub.adapters.sepay, { parseCallback: { value: (req) => cold.parseCallback(req) } });
    await d.advance(1);
    d.sim.state.apiRequests.push(d.sim.clock.now()); // hạn mức của giây này đã dùng hết đúng lúc webhook đến
    await d.transfer(attempt);
    assert.notEqual(payment.status, 'PAID', 'chưa tra được VA nên chưa gắn được đơn');
    assert.equal(an(hub, 'unmatched_funds').length, 0, 'không đoán thành tiền chưa rõ chủ');
    assert.ok(hub.store.events.some((e) => e.outcome === 'retry_later'));
    await d.advance(120); // SePay gửi lại webhook theo lịch
    assert.equal(payment.status, 'PAID');
  } finally { await w.close(); }
});

test('routing cùng id không khai adapterProduct dừng khi khởi động (Hub không nhận)', async () => {
  await assert.rejects(createWorld(['sepay'], { gateways: [{ id: 'sepay' }, { id: 'sepay', adapterProduct: 'gateway' }] }, { sepay: { vaBank: 'VietinBank', pg: true } }), /nhiều mục cùng id phải khai adapterProduct/);
});

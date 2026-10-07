'use strict';
// spec: PHUB-S-019
// Đầu vào cực đoan đi qua Hub + adapter thật + simulator thật: số tiền ngoài giới hạn, mô tả có ký tự đặc biệt.
// Điều cần giữ: hoặc thanh toán xong đúng số tiền, hoặc bị từ chối sạch ngay lúc tạo; không bao giờ để một giao dịch
// nửa chừng với số tiền sai (chữ ký chứa 1e+23, số mất chính xác).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorld, order, DRIVERS } = require('../support/world');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter } = require('../support/fake-adapter');

const GATEWAYS = Object.keys(DRIVERS).filter((g) => g !== 'sepay');

test('Hub từ chối số tiền không an toàn hoặc quá trần ngay ở cửa vào (không để tới adapter)', async () => {
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({ adapters: { a }, config: { gateways: [{ id: 'a' }] } });
  for (const amount of [0, -5, 1.5, NaN, Infinity, '1000', null, 1e21, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 1_000_000_000_001]) {
    await assert.rejects(hub.createPayment({ orderId: `O-${String(amount)}`, amount, returnUrl: 'https://s/r' }), (e) => e.code === 'invalid_input', `amount=${String(amount)}`);
  }
  assert.equal(a.created.length, 0, 'không lời gọi nào tới cổng');
  const ok = await hub.createPayment({ orderId: 'OK', amount: 1_000_000_000_000, returnUrl: 'https://s/r' });
  assert.equal(ok.attempt.amount, 1_000_000_000_000);
});

test('trần số tiền cấu hình được và bị kiểm khi dựng Hub', () => {
  const a = createFakeAdapter('a');
  assert.throws(() => new PaymentHub({ adapters: { a }, config: { gateways: [{ id: 'a' }], maxAmount: 0 } }), /maxAmount/);
  assert.throws(() => new PaymentHub({ adapters: { a }, config: { gateways: [{ id: 'a' }], maxAmount: Number.MAX_SAFE_INTEGER } }), /maxAmount/);
  assert.doesNotThrow(() => new PaymentHub({ adapters: { a }, config: { gateways: [{ id: 'a' }], maxAmount: 5_000_000 } }));
});

const INFOS = ['Đơn hàng số 1 – Nguyễn Văn Á', 'a&b=c+d%e#f?g', '😀 emoji 日本語', '<script>alert(1)</script>', 'o\'brien "quoted"', 'dòng 1\ndòng 2\ttab'];
const AMOUNTS = [5000, 150000, 2_147_483_647, 2_147_483_648];

for (const id of GATEWAYS) {
  test(`[${id}] mô tả có ký tự đặc biệt: chữ ký vẫn đúng, thanh toán xong đúng số tiền`, async () => {
    for (const info of INFOS) {
      const w = await createWorld([id]);
      try {
        const { payment, attempt } = await w.hub.createPayment(order({ orderInfo: info }));
        await w.drivers[id].land(attempt);
        await w.drivers[id].pay(attempt, 'success');
        assert.equal(payment.status, 'PAID', `orderInfo=${JSON.stringify(info)}`);
        assert.equal(w.hub.listAnomalies().length, 0);
      } finally { await w.close(); }
    }
  });

  test(`[${id}] số tiền lớn trong trần: hoặc trả xong đúng số tiền, hoặc cổng từ chối sạch lúc tạo (không nửa chừng)`, async () => {
    for (const amount of AMOUNTS) {
      const w = await createWorld([id]);
      try {
        let r;
        try { r = await w.hub.createPayment(order({ amount })); } catch (e) { assert.equal(e.code, 'no_gateway_available', `amount=${amount}: ${e.message}`); continue; }
        await w.drivers[id].land(r.attempt);
        await w.drivers[id].pay(r.attempt, 'success');
        assert.equal(r.payment.status, 'PAID', `amount=${amount}: cổng nhận đơn nhưng không trả xong`);
        assert.equal(r.attempt.amount, amount);
        assert.equal(w.hub.listAnomalies().length, 0, `amount=${amount}`);
      } finally { await w.close(); }
    }
  });

  test(`[${id}] mô tả quá dài: được nhận hoặc bị cổng từ chối sạch lúc tạo`, async () => {
    const w = await createWorld([id]);
    try {
      let r;
      try { r = await w.hub.createPayment(order({ orderInfo: 'x'.repeat(300) })); } catch (e) { assert.equal(e.code, 'no_gateway_available'); return; }
      await w.drivers[id].land(r.attempt);
      await w.drivers[id].pay(r.attempt, 'success');
      assert.equal(r.payment.status, 'PAID');
    } finally { await w.close(); }
  });
}

'use strict';
// spec: PHUB-S-014
// Breaker bền vững qua khởi động lại: cổng đang lỗi không bị đổ tải lại ngay khi Hub khởi động.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayGuard } = require('../../src/guard');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

const boom = () => Promise.reject(new Error('boom'));
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });

test('guard: xuất/nhập trạng thái; nửa mở lưu như mở; dữ liệu hỏng thì bỏ qua; onChange chỉ gọi khi đổi', async () => {
  const clock = createClock();
  const changes = [];
  const g = new GatewayGuard('x', { clock, failureThreshold: 2, openSeconds: 30, onChange: (s) => changes.push(s) });
  await assert.rejects(g.run('q', 'R', boom));
  assert.equal(changes.length, 1, 'số lỗi liên tiếp đổi');
  await assert.rejects(g.run('q', 'R', boom));
  assert.equal(g.state, 'open');
  assert.deepEqual(changes[changes.length - 1], { state: 'open', failures: 2, openedAt: clock.now() });
  clock.advance(31);
  g.state = 'half_open';
  assert.equal(g.exportState().state, 'open');

  const h = new GatewayGuard('x', { clock });
  h.restore(g.exportState());
  assert.equal(h.state, 'open');
  assert.equal(h.failures, 2);
  assert.equal(h.available(), true, 'hết thời gian nghỉ thì cho thử một lời gọi');
  const k = new GatewayGuard('x', { clock });
  k.restore('rác');
  k.restore({ state: 'bậy', failures: 'x', openedAt: 'y' });
  assert.equal(k.state, 'closed');
  assert.equal(k.failures, 0);
});

function boot(store, clock, a) {
  return new PaymentHub({ adapters: { a }, store, clock, config: { gateways: [{ id: 'a' }], protection: { failureThreshold: 2, openSeconds: 30 } } });
}

test('Hub (PostgreSQL): breaker mở được lưu và khôi phục sau khởi động lại; cổng không bị gọi cho tới khi hết thời gian nghỉ', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const clock = createClock();
    const a = createFakeAdapter('a', { caps: { createCanTimeout: false } });
    const s1 = await db.open();
    const hub1 = boot(s1, clock, a);
    a.createMode = 'throw';
    await assert.rejects(hub1.createPayment(order({ orderId: 'A' })), { code: 'no_gateway_available' });
    await assert.rejects(hub1.createPayment(order({ orderId: 'B' })), { code: 'no_gateway_available' });
    assert.equal(hub1.guards.a.state, 'open');
    assert.equal(a.created.length, 2);
    await s1.close();

    const s2 = await db.open();
    const hub2 = boot(s2, clock, a);
    assert.equal(hub2.guards.a.state, 'open', 'khôi phục sau khởi động lại');
    a.createMode = 'redirect';
    await assert.rejects(hub2.createPayment(order({ orderId: 'C' })), { code: 'no_gateway_available' });
    assert.equal(a.created.length, 2, 'cổng không bị gọi khi breaker còn mở');

    clock.advance(31);
    const ok = await hub2.createPayment(order({ orderId: 'D' }));
    assert.equal(ok.attempt.status, 'AWAITING');
    assert.equal(hub2.guards.a.state, 'closed');
    await s2.close();

    const s3 = await db.open();
    const hub3 = boot(s3, clock, a);
    assert.equal(hub3.guards.a.state, 'closed', 'trạng thái đóng lại cũng được lưu');
    assert.equal(hub3.guards.a.failures, 0);
    await s3.close();
  } finally { await db.cleanup(); }
});

test('trạng thái breaker của cổng không còn trong cấu hình bị bỏ qua', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const s1 = await db.open();
    s1.extra.breakers = { cu: { state: 'open', failures: 9, openedAt: Date.now() } };
    await s1.persist();
    await s1.close();
    const s2 = await db.open();
    const hub = boot(s2, createClock(), createFakeAdapter('a'));
    assert.deepEqual(Object.keys(hub.guards), ['a']);
    assert.equal(hub.guards.a.state, 'closed');
    await s2.close();
  } finally { await db.cleanup(); }
});

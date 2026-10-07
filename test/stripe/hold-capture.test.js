'use strict';
// spec: STRP-S-001
// spec: STRP-S-002
// Giữ tiền rồi thu sau (sản phẩm auth) với simulator: authorized, capture, void, hết hạn giữ. Nguồn sự thật là PaymentIntent, không phải trạng thái của phiên.
// Chỉ chạy với simulator: các điểm unverified (payment_status khi giữ, cancellation_reason khi hết hạn, mã lỗi thu hai lần) là cấu hình của simulator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { assertEvent } = require('../../src/contract');

const held = async (t, ref = 'BSNhold0001', amount = 1999) => {
  const c = await t.create(ref, { amount, product: 'auth' });
  await t.pay(c.state.cs);
  const ev = (await t.events()).find((e) => e.type === 'authorized' && e.attemptRef === ref);
  return { c, ref, amount, pi: ev.gatewayTxnId, ev };
};
const heldOp = (h, kind, o = {}) => ({ attemptRef: h.ref, amount: h.amount, currency: 'USD', gatewayTxnId: h.pi, idempotencyKey: `att_${h.ref}:${kind}`, ...o });

test('giữ tiền: webhook amount_capturable_updated thành authorized (không phải succeeded), truy vấn cùng mã pi_, kể cả khi phiên báo paid', async () => {
  for (const status of ['unpaid', 'paid']) {
    const t = await setup({ controls: { hold_payment_status: status } });
    try {
      const h = await held(t);
      assert.deepEqual(t.types(), ['checkout.session.completed', 'payment_intent.amount_capturable_updated']);
      assert.equal(h.ev.type, 'authorized');
      assert.equal(h.ev.amount, 1999);
      assert.equal(h.ev.currency, 'USD');
      assert.equal(assertEvent(h.ev), true);
      assert.ok((await t.events()).every((e) => e.type !== 'succeeded'), `phiên ${status} nhưng chưa thu`);
      const q = await t.adapter.query({ attemptRef: h.ref, amount: 1999, state: h.c.state });
      assert.equal(q.type, 'authorized', `phiên ${status}: PaymentIntent mới là nguồn sự thật`);
      assert.equal(q.gatewayTxnId, h.pi);
    } finally { await t.teardown(); }
  }
});

test('capture thành công: captured, webhook succeeded cùng mã, khóa idempotency của Hub được gửi; gọi lại cùng khóa là phát lại, khóa khác thì giải quyết bằng trạng thái thật', async () => {
  const t = await setup();
  try {
    const h = await held(t);
    const r = await t.adapter.capture(heldOp(h, 'capture'));
    assert.deepEqual(r, { status: 'captured', gatewayTxnId: h.pi });
    const reqs = (await t.state()).requests.filter((x) => x.path.endsWith('/capture'));
    assert.equal(reqs[0].key, `att_${h.ref}:capture`);
    assert.equal(reqs[0].body.amount_to_capture, '1999');
    const succ = (await t.events()).filter((e) => e.type === 'succeeded');
    assert.equal(succ.length, 1);
    assert.equal(succ[0].gatewayTxnId, h.pi, 'mã giao dịch của khoản thu trùng mã của khoản giữ (pi_)');
    assert.equal((await t.adapter.capture(heldOp(h, 'capture'))).status, 'captured'); // cùng khóa: Stripe phát lại kết quả đã lưu
    assert.equal((await t.state()).requests.filter((x) => x.path.endsWith('/capture')).length, 2);
    for (const code of ['payment_intent_unexpected_state', 'charge_already_captured']) {
      await t.control({ double_capture_code: code });
      const again = await t.adapter.capture(heldOp(h, `capture-${code}`)); // khóa mới: Stripe từ chối, adapter hỏi lại PaymentIntent
      assert.deepEqual(again, { status: 'captured', gatewayTxnId: h.pi }, code);
    }
    const q = await t.adapter.query({ attemptRef: h.ref, amount: 1999, state: h.c.state });
    assert.equal(q.type, 'succeeded');
  } finally { await t.teardown(); }
});

test('capture bị từ chối chắc chắn: số tiền lớn hơn khoản giữ, thiếu mã giao dịch, loại tiền sai đơn vị; không gọi mạng khi thiếu mã', async () => {
  const t = await setup();
  try {
    const h = await held(t);
    const big = await t.adapter.capture(heldOp(h, 'big', { amount: 2500 }));
    assert.equal(big.status, 'rejected');
    assert.match(big.reason, /amount_too_large/);
    const n = (await t.state()).requests.length;
    assert.equal((await t.adapter.capture(heldOp(h, 'x', { gatewayTxnId: undefined }))).status, 'rejected');
    assert.equal((await t.adapter.capture(heldOp(h, 'x', { amount: 1.5 }))).status, 'rejected');
    assert.equal((await t.state()).requests.length, n);
    assert.equal((await t.adapter.capture(heldOp(h, 'ok'))).status, 'captured', 'khoản giữ còn nguyên sau các lần bị từ chối');
  } finally { await t.teardown(); }
});

test('void: voided; webhook canceled thành cancelled; void lại bằng khóa khác vẫn voided; void sau khi đã thu bị từ chối', async () => {
  const t = await setup();
  try {
    const h = await held(t, 'BSNvoid0001');
    assert.deepEqual(await t.adapter.void(heldOp(h, 'void')), { status: 'voided' });
    const e = (await t.events()).find((x) => x.type === 'cancelled');
    assert.equal(e.gatewayTxnId, h.pi);
    assert.equal(e.failCode, 'user_cancelled');
    assert.equal(e.amount, 1999);
    assert.deepEqual(await t.adapter.void(heldOp(h, 'void-2')), { status: 'voided' }); // đã nhả rồi: giải quyết bằng trạng thái thật
    assert.equal((await t.adapter.query({ attemptRef: h.ref, amount: 1999, state: h.c.state })).type, 'cancelled');
    const other = await held(t, 'BSNvoid0002');
    await t.adapter.capture(heldOp(other, 'capture'));
    const late = await t.adapter.void(heldOp(other, 'void'));
    assert.equal(late.status, 'rejected');
    assert.match(late.reason, /đã được thu/);
  } finally { await t.teardown(); }
});

test('giữ tiền hết hạn (7 ngày): Stripe tự nhả, adapter báo expired (cancellation_reason automatic), thu sau hạn bị từ chối, truy vấn cũng expired', async () => {
  const t = await setup();
  try {
    const h = await held(t, 'BSNhexp0001');
    await t.advance(7 * 86400 + 60);
    assert.ok(t.types().includes('charge.expired') && t.types().includes('payment_intent.canceled'));
    const e = (await t.events()).find((x) => x.type === 'expired');
    assert.ok(e, 'sự kiện expired');
    assert.equal(e.gatewayTxnId, h.pi);
    assert.equal(e.failCode, 'expired');
    const cap = await t.adapter.capture(heldOp(h, 'capture'));
    assert.equal(cap.status, 'rejected');
    assert.match(cap.reason, /charge_expired_for_capture/);
    assert.equal((await t.adapter.query({ attemptRef: h.ref, amount: 1999, state: h.c.state })).type, 'expired');
  } finally { await t.teardown(); }
});

test('khoản giữ của phiên hết hạn trước khi khách trả không tồn tại: expire phiên rồi truy vấn expired, không có authorized', async () => {
  const t = await setup();
  try {
    const c = await t.create('BSNnohold01', { product: 'auth' });
    await t.advance(25 * 3600);
    assert.equal((await t.adapter.query({ attemptRef: 'BSNnohold01', amount: 1999, state: c.state })).type, 'expired');
    assert.ok((await t.events()).every((e) => e.type !== 'authorized'));
  } finally { await t.teardown(); }
});

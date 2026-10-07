'use strict';
// spec: PYPL-S-001
// spec: PYPL-S-002
// Sản phẩm auth (intent AUTHORIZE): giữ tiền rồi thu hoặc nhả. Hub chỉ biết MỘT mã giao dịch (mã order); mã khoản giữ và mã capture adapter tự tra.
// CHỈ chạy với simulator: chưa kiểm PayPal thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

async function held(t, ref = 'REF1', o = {}) {
  const c = await t.create(ref, o);
  const a = await t.approve(c);
  const r = await t.back({ ref, ...a.query });
  return { c, a, r };
}
const key = (ref, what) => `${ref}:${what}`;

test('auth: khách duyệt rồi quay về thì adapter GIỮ tiền (authorize), ra authorized với mã order; chưa có capture nào', async () => {
  const t = await setup({ adapter: { product: 'auth' } });
  try {
    const { c, r } = await held(t);
    assert.equal(r.event.type, 'authorized');
    assert.equal(r.event.amount, 1999);
    assert.equal(r.event.gatewayTxnId, c.state.order);
    const st = await t.state();
    assert.equal(st.auths.length, 1);
    assert.equal(st.captures.length, 0);
    assert.equal(st.orders[0].intent, 'AUTHORIZE');
    assert.deepEqual(t.adapter.capabilities().operations, ['authorize', 'capture', 'void', 'refund', 'inquire']);
    assert.equal(t.adapter.capabilities().partialCapture, true);
    const evs = await t.events();
    const created = evs.find((e) => e.type === 'authorized' && e.source === 'ipn');
    assert.ok(created, 'webhook PAYMENT.AUTHORIZATION.CREATED thành authorized');
    assert.equal(created.gatewayTxnId, c.state.order, 'cùng mã order ở mọi kênh');
    const q = await t.adapter.query({ attemptRef: 'REF1', state: c.state });
    assert.equal(q.type, 'authorized');
    assert.equal(q.gatewayTxnId, c.state.order);
  } finally { await t.teardown(); }
});

test('auth: capture thu đủ khoản giữ; webhook succeeded cùng mã order với authorized (lõi không báo late_authorization giả)', async () => {
  const t = await setup({ adapter: { product: 'auth' } });
  try {
    const { c } = await held(t);
    const r = await t.adapter.capture({ attemptRef: 'REF1', amount: 1999, currency: 'USD', gatewayTxnId: c.state.order, state: c.state, idempotencyKey: key('REF1', 'cap') });
    assert.deepEqual(r, { status: 'captured', gatewayTxnId: c.state.order });
    const st = await t.state();
    assert.equal(st.captures.length, 1);
    assert.equal(st.auths[0].status, 'CAPTURED');
    const evs = await t.events();
    const paid = evs.filter((e) => e.type === 'succeeded');
    assert.ok(paid.length >= 1, 'webhook thu (và webhook duyệt đến sau khi đã thu, đọc trạng thái thật) đều ra succeeded');
    for (const e of paid) { assert.equal(e.gatewayTxnId, c.state.order); assert.equal(e.amount, 1999); }
    const authed = evs.filter((e) => e.type === 'authorized');
    for (const e of authed) assert.equal(e.gatewayTxnId, paid[0].gatewayTxnId, 'authorized và succeeded cùng mã');
    const q = await t.adapter.query({ attemptRef: 'REF1', state: c.state });
    assert.equal(q.type, 'succeeded');
  } finally { await t.teardown(); }
});

test('auth: capture gọi lại (mất phản hồi lần trước) vẫn captured và chỉ một capture; thu số tiền khác bị từ chối hoặc chưa rõ, không đoán', async () => {
  const t = await setup({ adapter: { product: 'auth' } });
  try {
    const { c } = await held(t);
    const p = { attemptRef: 'REF1', amount: 1999, currency: 'USD', gatewayTxnId: c.state.order, state: c.state, idempotencyKey: key('REF1', 'cap') };
    assert.equal((await t.adapter.capture(p)).status, 'captured');
    assert.equal((await t.adapter.capture(p)).status, 'captured');
    assert.equal((await t.state()).captures.length, 1);
    const wrong = await t.adapter.capture({ ...p, amount: 1000 });
    assert.notEqual(wrong.status, 'captured', 'đã thu 19,99 thì không được báo captured cho 10,00');
  } finally { await t.teardown(); }
});

test('auth: mất phản hồi khi thu (tiền ĐÃ thu) là unknown ở lần đầu, lần sau giải quyết bằng trạng thái thật thành captured', async () => {
  const t = await setup({ adapter: { product: 'auth' }, timeoutMs: 400 });
  try {
    const { c } = await held(t);
    await t.control({ inject: [{ match: '/capture', mode: 'timeout_after', times: 1 }] });
    const p = { attemptRef: 'REF1', amount: 1999, currency: 'USD', gatewayTxnId: c.state.order, state: c.state, idempotencyKey: key('REF1', 'cap') };
    assert.deepEqual(await t.adapter.capture(p), { status: 'unknown' });
    assert.equal((await t.state()).captures.length, 1, 'tiền đã thu dù khách không nhận phản hồi');
    assert.equal((await t.adapter.capture(p)).status, 'captured');
  } finally { await t.teardown(); }
});

test('auth: void nhả khoản giữ, webhook thành cancelled cùng mã order; thu sau khi nhả bị từ chối; nhả hai lần vẫn voided', async () => {
  const t = await setup({ adapter: { product: 'auth' } });
  try {
    const { c } = await held(t);
    const p = { attemptRef: 'REF1', amount: 1999, currency: 'USD', gatewayTxnId: c.state.order, state: c.state, idempotencyKey: key('REF1', 'void') };
    assert.deepEqual(await t.adapter.void(p), { status: 'voided' });
    assert.deepEqual(await t.adapter.void(p), { status: 'voided' });
    const cancelled = (await t.events()).filter((e) => e.type === 'cancelled');
    assert.equal(cancelled.length >= 1, true);
    assert.equal(cancelled[0].gatewayTxnId, c.state.order);
    const cap = await t.adapter.capture({ ...p, idempotencyKey: key('REF1', 'cap') });
    assert.equal(cap.status, 'rejected');
    assert.equal((await t.state()).captures.length, 0);
    const q = await t.adapter.query({ attemptRef: 'REF1', state: c.state });
    assert.equal(q.type, 'cancelled');
  } finally { await t.teardown(); }
});

test('auth: nhả khoản giữ đã được thu thì bị từ chối (tiền không bị nhả nhầm)', async () => {
  const t = await setup({ adapter: { product: 'auth' } });
  try {
    const { c } = await held(t);
    const p = { attemptRef: 'REF1', amount: 1999, currency: 'USD', gatewayTxnId: c.state.order, state: c.state, idempotencyKey: key('REF1', 'cap') };
    await t.adapter.capture(p);
    const v = await t.adapter.void({ ...p, idempotencyKey: key('REF1', 'void') });
    assert.equal(v.status, 'rejected');
  } finally { await t.teardown(); }
});

test('auth: khoản giữ hết hạn sau 29 ngày: webhook VOIDED với status EXPIRED thành expired; thu bị từ chối', async () => {
  const t = await setup({ adapter: { product: 'auth' } });
  try {
    const { c } = await held(t);
    await t.advance(30 * 86400);
    const evs = await t.events();
    const last = evs[evs.length - 1];
    assert.equal(last.type, 'expired');
    assert.equal(last.failCode, 'expired');
    assert.equal(last.gatewayTxnId, c.state.order);
    const cap = await t.adapter.capture({ attemptRef: 'REF1', amount: 1999, currency: 'USD', gatewayTxnId: c.state.order, state: c.state, idempotencyKey: key('REF1', 'cap') });
    assert.equal(cap.status, 'rejected');
    assert.equal((await t.adapter.query({ attemptRef: 'REF1', state: c.state })).type, 'expired');
  } finally { await t.teardown(); }
});

test('auth: thu bị từ chối thì khoản giữ còn nguyên (rejected, không phải thất bại của attempt); 429 ném notSent', async () => {
  const t = await setup({ adapter: { product: 'auth' } });
  try {
    const { c } = await held(t);
    const p = { attemptRef: 'REF1', amount: 1999, currency: 'USD', gatewayTxnId: c.state.order, state: c.state, idempotencyKey: key('REF1', 'cap') };
    await t.control({ capture_decline: 'INSTRUMENT_DECLINED' });
    assert.equal((await t.adapter.capture(p)).status, 'rejected');
    assert.equal((await t.state()).auths[0].status, 'CREATED', 'khoản giữ còn nguyên');
    await t.control({ capture_decline: null, inject: [{ match: '/capture', mode: 'status429', times: 1 }] });
    await assert.rejects(t.adapter.capture(p), (e) => e.notSent === true && e.code === 'rate_limited');
    assert.equal((await t.adapter.capture(p)).status, 'captured');
  } finally { await t.teardown(); }
});

test('auth: thiếu mã order hoặc order chưa có khoản giữ thì rejected, không gọi thu bừa', async () => {
  const t = await setup({ adapter: { product: 'auth' } });
  try {
    assert.equal((await t.adapter.capture({ attemptRef: 'X', amount: 100, currency: 'USD', idempotencyKey: 'k' })).status, 'rejected');
    assert.equal((await t.adapter.void({ attemptRef: 'X', amount: 100, currency: 'USD', idempotencyKey: 'k' })).status, 'rejected');
    const c = await t.create('REF1');
    const r = await t.adapter.capture({ attemptRef: 'REF1', amount: 1999, currency: 'USD', state: c.state, idempotencyKey: 'k' });
    assert.equal(r.status, 'rejected');
    assert.equal((await t.state()).captures.length, 0);
  } finally { await t.teardown(); }
});

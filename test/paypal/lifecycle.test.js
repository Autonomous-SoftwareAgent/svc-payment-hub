'use strict';
// spec: PYPL-S-001
// spec: PYPL-S-002
// Vòng đời thu ngay của adapter PayPal với simulator: tạo, khách duyệt, thu (qua kênh return và webhook), truy vấn chỉ đọc, từ chối, PENDING, token hết hạn,
// lỗi mạng. CHỈ chạy với simulator: chưa kiểm PayPal thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { toPaypalValue, fromPaypalValue } = require('../../src/adapters/paypal');

test('đổi tiền: đơn vị nhỏ nhất sang chuỗi thập phân và ngược lại; JPY không thập phân; sai thì từ chối, không đoán', () => {
  assert.deepEqual(toPaypalValue(1999, 'USD'), { value: '19.99' });
  assert.deepEqual(toPaypalValue(5, 'USD'), { value: '0.05' });
  assert.deepEqual(toPaypalValue(500, 'JPY'), { value: '500' });
  assert.deepEqual(toPaypalValue(1000, 'TWD'), { value: '10' }, 'TWD: ISO 2 chữ số, PayPal không thập phân: phải là bội của 100');
  assert.ok(toPaypalValue(1050, 'TWD').error);
  assert.ok(toPaypalValue(0, 'USD').error);
  assert.ok(toPaypalValue(1.5, 'USD').error);
  assert.ok(toPaypalValue(100, 'XXX').error);
  assert.equal(fromPaypalValue('19.99', 'USD'), 1999);
  assert.equal(fromPaypalValue('19.9', 'USD'), 1990);
  assert.equal(fromPaypalValue('500', 'JPY'), 500);
  assert.equal(fromPaypalValue('19.999', 'USD'), null, 'quá số chữ số thập phân: không làm tròn');
  assert.equal(fromPaypalValue('500.5', 'JPY'), null);
  assert.equal(fromPaypalValue('abc', 'USD'), null);
});

test('tạo thanh toán: nextAction redirect tới link payer-action, state.order, custom_id là attemptRef, VND bị từ chối', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    assert.equal(c.status, 'next_action');
    assert.equal(c.nextAction.type, 'redirect');
    assert.match(c.nextAction.url, /\/checkoutnow\?token=/);
    assert.ok(c.state.order);
    const st = await t.state();
    assert.equal(st.orders[0].custom_id, 'REF1');
    assert.equal(st.orders[0].intent, 'CAPTURE');
    assert.match(st.orders[0].return_url, /^http:\/\/hub\.test\/return\/paypal\?ref=REF1$/);
    const vnd = await t.create('REF2', { currency: 'VND', amount: 100000 });
    assert.equal(vnd.status, 'rejected');
    assert.match(vnd.reason, /VND/);
    assert.equal((await t.state()).orders.length, 1, 'VND không bao giờ tới PayPal');
    const usdBad = await t.create('REF3', { currency: 'CHF' });
    assert.equal(usdBad.status, 'rejected', 'chưa bật trong cấu hình');
  } finally { await t.teardown(); }
});

test('khách duyệt rồi quay về: adapter thu giúp Hub, ra succeeded với mã giao dịch là mã order; webhook đến sau là cùng một sự kiện', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    const a = await t.approve(c);
    assert.equal(a.query.token, c.state.order);
    const r = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(r.valid, true);
    assert.equal(r.event.type, 'succeeded');
    assert.equal(r.event.amount, 1999);
    assert.equal(r.event.currency, 'USD');
    assert.equal(r.event.gatewayTxnId, c.state.order);
    const caps = (await t.state()).captures;
    assert.equal(caps.length, 1, 'thu đúng một lần');
    const evs = await t.events();
    const paid = evs.filter((e) => e.type === 'succeeded');
    assert.ok(paid.length >= 1);
    for (const e of paid) { assert.equal(e.gatewayTxnId, c.state.order); assert.equal(e.attemptRef, 'REF1'); assert.equal(e.amount, 1999); }
  } finally { await t.teardown(); }
});

test('khách đóng tab sau khi duyệt: webhook CHECKOUT.ORDER.APPROVED làm adapter thu; return đến sau không thu lần hai', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    const a = await t.approve(c); // simulator gửi CHECKOUT.ORDER.APPROVED
    assert.deepEqual(t.types(), ['CHECKOUT.ORDER.APPROVED']);
    const r = await t.parse(t.rcv.received[0]);
    assert.equal(r.event.type, 'succeeded');
    assert.equal((await t.state()).captures.length, 1);
    const again = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(again.event.type, 'succeeded', 'order đã thu: đọc trạng thái thật');
    assert.equal((await t.state()).captures.length, 1, 'không thu lần hai');
    const reqs = (await t.state()).requests.filter((q) => q.path.endsWith('/capture'));
    assert.equal(reqs.length, 1, 'không cả gọi capture lần hai vì order đã COMPLETED');
  } finally { await t.teardown(); }
});

test('hai nơi cùng thu một lúc: idempotent bằng PayPal-Request-Id, chỉ một capture', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    const a = await t.approve(c);
    const d = t.rcv.received[0];
    const [r1, r2] = await Promise.all([t.back({ ref: 'REF1', ...a.query }), t.parse(d)]);
    assert.equal(r1.event.type, 'succeeded');
    assert.equal(r2.event.type, 'succeeded');
    assert.equal((await t.state()).captures.length, 1);
  } finally { await t.teardown(); }
});

test('query chỉ đọc: order đã duyệt mà chưa thu vẫn là pending và KHÔNG bị thu; sau khi thu thì succeeded', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    const p0 = { attemptRef: 'REF1', amount: 1999, state: c.state };
    assert.equal((await t.adapter.query(p0)).type, 'pending');
    await t.control({ drop_types: ['CHECKOUT.ORDER.APPROVED'] }); // webhook duyệt mất
    await t.approve(c);
    const q = await t.adapter.query(p0);
    assert.equal(q.type, 'pending');
    assert.equal((await t.state()).captures.length, 0, 'truy vấn không được thu tiền khách');
    assert.equal((await t.state()).requests.filter((x) => x.method === 'POST' && x.path !== '/v2/checkout/orders').length, 0);
    // adapter thu qua return, rồi truy vấn thấy tiền
    await t.back({ ref: 'REF1', token: c.state.order });
    const q2 = await t.adapter.query(p0);
    assert.equal(q2.type, 'succeeded');
    assert.equal(q2.source, 'query');
    assert.equal(q2.gatewayTxnId, c.state.order);
    assert.deepEqual(await t.adapter.query({ attemptRef: 'REF1', state: { order: 'NOPE' } }), { state: 'not_found' });
    assert.deepEqual(await t.adapter.query({ attemptRef: 'REF1' }), { state: 'unknown' });
  } finally { await t.teardown(); }
});

test('khách hủy ở trang PayPal: quay về cancel_url, chỉ hiển thị (pending, nguồn return), không thu', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    const a = await t.approve(c, 'cancel');
    assert.equal(a.query.cancel, '1');
    const r = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(r.event.type, 'pending');
    assert.equal(r.event.source, 'return');
    assert.equal((await t.state()).captures.length, 0);
    assert.equal(t.rcv.received.length, 0, 'không có webhook');
  } finally { await t.teardown(); }
});

test('thu bị từ chối (INSTRUMENT_DECLINED): failed với lý do declined, không có tiền; mã lạ thì unknown, không đoán', async () => {
  const t = await setup({ controls: { capture_decline: 'INSTRUMENT_DECLINED' } });
  try {
    const c = await t.create('REF1');
    const a = await t.approve(c);
    const r = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(r.event.type, 'failed');
    assert.equal(r.event.failCode, 'declined');
    assert.equal(r.event.gatewayCode, 'INSTRUMENT_DECLINED');
    assert.equal(r.event.amount, 1999);
    assert.equal((await t.state()).captures.length, 0);
    await t.control({ capture_decline: 'SOME_NEW_ISSUE' });
    const r2 = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(r2.event.failCode, 'unknown');
  } finally { await t.teardown(); }
});

test('capture PENDING: pending, rồi webhook COMPLETED thành succeeded; DENIED thành failed', async () => {
  const t = await setup({ controls: { capture_pending: true } });
  try {
    const c = await t.create('REF1');
    const a = await t.approve(c);
    const r = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(r.event.type, 'pending');
    const cap = (await t.state()).captures[0];
    assert.equal(cap.status, 'PENDING');
    await t.post('/sim/capture/resolve', { id: cap.id, outcome: 'completed' });
    const evs = await t.events();
    assert.equal(evs[evs.length - 1].type, 'succeeded');
    assert.equal(evs[evs.length - 1].gatewayTxnId, c.state.order);
    const c2 = await t.create('REF2');
    const a2 = await t.approve(c2);
    await t.back({ ref: 'REF2', ...a2.query });
    const cap2 = (await t.state()).captures.find((x) => x.status === 'PENDING');
    await t.post('/sim/capture/resolve', { id: cap2.id, outcome: 'denied' });
    const last = (await t.events()).filter((e) => e.attemptRef === 'REF2').pop();
    assert.equal(last.type, 'failed');
    assert.equal(last.failCode, 'declined');
  } finally { await t.teardown(); }
});

test('token hết hạn hoặc bị thu hồi: adapter lấy token mới một lần và vẫn làm xong việc', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    await t.post('/sim/revoke-tokens', {});
    const q = await t.adapter.query({ attemptRef: 'REF1', state: c.state });
    assert.equal(q.type, 'pending');
    await t.advance(40000); // token (32400 giây) hết hạn theo đồng hồ simulator
    const q2 = await t.adapter.query({ attemptRef: 'REF1', state: c.state });
    assert.equal(q2.type, 'pending');
    const tokenCalls = (await t.state()).requests.length;
    assert.ok(tokenCalls >= 3);
  } finally { await t.teardown(); }
});

test('sai thông tin đăng nhập của ta: rejected invalid_request, không đoán là mạng lỗi', async () => {
  const t = await setup({ adapter: { clientSecret: 'sai' } });
  try {
    const c = await t.create('REF1');
    assert.equal(c.status, 'rejected');
    assert.equal(c.failCode, 'invalid_request');
  } finally { await t.teardown(); }
});

test('lỗi mạng khi tạo: 5xx và mất phản hồi là unknown (order có thể đã tạo); 429 là rejected rate_limited; 4xx là rejected', async () => {
  const t = await setup({ timeoutMs: 400 });
  try {
    await t.control({ inject: [{ match: 'POST /v2/checkout/orders', mode: 'status500_after', times: 1 }] });
    assert.deepEqual(await t.create('REF1'), { status: 'unknown' });
    assert.equal((await t.state()).orders.length, 1, 'order đã được tạo dù khách nhận 500');
    await t.control({ inject: [{ match: 'POST /v2/checkout/orders', mode: 'timeout_after', times: 1 }] });
    assert.deepEqual(await t.create('REF2'), { status: 'unknown' });
    await t.control({ inject: [{ match: 'POST /v2/checkout/orders', mode: 'status429', times: 1 }] });
    const r = await t.create('REF3');
    assert.equal(r.status, 'rejected');
    assert.equal(r.failCode, 'rate_limited');
    await t.control({ inject: [] });
    const bad = await t.create('REF4', { currency: 'JPY', amount: 500 });
    assert.equal(bad.status, 'next_action');
  } finally { await t.teardown(); }
});

test('order hết hạn sau 3 giờ: khách không duyệt được nữa; thu bị từ chối là failed expired, không có tiền', async () => {
  const t = await setup();
  try {
    await t.control({ drop_types: ['CHECKOUT.ORDER.APPROVED'] });
    const c = await t.create('REF1');
    const a = await t.approve(c); // khách duyệt, nhưng không ai thu kịp
    await t.advance(3 * 3600 + 5);
    const r = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(r.event.type, 'failed');
    assert.equal(r.event.failCode, 'expired');
    assert.equal((await t.state()).captures.length, 0, 'không có tiền');
    const c2 = await t.create('REF2');
    await t.advance(3 * 3600 + 5);
    assert.equal((await t.post('/sim/pay', { order: c2.state.order, outcome: 'approve' })).status, 409, 'order hết hạn thì khách không duyệt được nữa');
    assert.equal(t.adapter.capabilities().hardExpiry.minutes, 180);
  } finally { await t.teardown(); }
});

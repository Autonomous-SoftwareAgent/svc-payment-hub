'use strict';
// spec: PYPL-S-001
// spec: PYPL-S-002
// Kịch bản bất lợi của adapter PayPal: webhook trùng, đảo thứ tự, mất; kênh return bị làm giả; lỗi tra cứu tạm thời; sự kiện lạ.
// Điều cần giữ: không thu nhầm tiền, không mất tin về tiền, không tin kênh không có chữ ký. CHỈ chạy với simulator: chưa kiểm PayPal thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('webhook trùng ba lần và đảo thứ tự: mọi lần giao đều ra cùng sự kiện tiền (cùng mã), chỉ một capture', async () => {
  const t = await setup({ controls: { dup_webhooks: 2, reverse_events: true } });
  try {
    const c = await t.create('REF1');
    await t.approve(c);
    const evs = await t.events();
    const paid = evs.filter((e) => e.type === 'succeeded');
    assert.ok(paid.length >= 3);
    for (const e of paid) { assert.equal(e.gatewayTxnId, c.state.order); assert.equal(e.amount, 1999); }
    assert.equal((await t.state()).captures.length, 1);
  } finally { await t.teardown(); }
});

test('webhook duyệt mất hẳn và khách không quay về: order ở APPROVED, KHÔNG ai thu, truy vấn chỉ thấy pending (thất bại an toàn: không mất tiền)', async () => {
  const t = await setup({ controls: { drop_types: ['CHECKOUT.ORDER.APPROVED'] } });
  try {
    const c = await t.create('REF1');
    await t.approve(c);
    assert.equal(t.rcv.received.length, 0);
    await t.advance(3600);
    const q = await t.adapter.query({ attemptRef: 'REF1', state: c.state });
    assert.equal(q.type, 'pending');
    assert.equal((await t.state()).captures.length, 0);
    assert.equal((await t.order(c.state.order)).status, 'APPROVED');
  } finally { await t.teardown(); }
});

test('kênh return bị làm giả: token của order khác attempt, order không có, thiếu ref: không thu gì, không sinh sự kiện tiền', async () => {
  const t = await setup();
  try {
    const mine = await t.create('REF1');
    const other = await t.create('REF2');
    await t.control({ drop_types: ['CHECKOUT.ORDER.APPROVED'] });
    await t.approve(other); // order của REF2 đã duyệt, chưa thu
    // kẻ gọi đưa ref của REF1 kèm token của order REF2
    const r1 = await t.back({ ref: 'REF1', token: other.state.order });
    assert.equal(r1.valid, true);
    assert.equal(r1.event, undefined, 'custom_id của order không khớp ref: bỏ qua');
    assert.equal((await t.state()).captures.length, 0, 'không thu order của attempt khác');
    const r2 = await t.back({ ref: 'REF1', token: 'KHONG-CO' });
    assert.equal(r2.event, undefined);
    assert.equal((await t.back({ token: mine.state.order })).valid, false, 'thiếu ref');
    assert.equal((await t.back({ ref: 'REF1' })).event.type, 'pending', 'thiếu token: chỉ hiển thị');
    assert.equal((await t.state()).captures.length, 0);
  } finally { await t.teardown(); }
});

test('tra cứu order hỏng tạm thời lúc xử lý webhook duyệt: retryLater (PayPal giao lại), không thu; lần giao lại thành công thì thu đúng một lần', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    await t.approve(c);
    const d = t.rcv.received[0];
    await t.control({ inject: [{ match: 'GET /v2/checkout/orders', mode: 'status500_before', times: 1 }] });
    const first = await t.parse(d);
    assert.equal(first.valid, true);
    assert.equal(first.retryLater, true);
    assert.equal(first.ack('error').status, 500);
    assert.equal((await t.state()).captures.length, 0);
    const second = await t.parse(d);
    assert.equal(second.event.type, 'succeeded');
    assert.equal((await t.state()).captures.length, 1);
  } finally { await t.teardown(); }
});

test('thu mất phản hồi (tiền ĐÃ thu): kênh return trả retryLater hoặc kết quả đọc lại, lần sau không thu thêm và thấy tiền', async () => {
  const t = await setup({ timeoutMs: 400 });
  try {
    const c = await t.create('REF1');
    await t.control({ drop_types: ['CHECKOUT.ORDER.APPROVED'], inject: [{ match: '/capture', mode: 'timeout_after', times: 1 }] });
    const a = await t.approve(c);
    const r = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(r.valid, true);
    assert.equal(r.retryLater, true, 'không rõ: không đoán thất bại');
    assert.equal((await t.state()).captures.length, 1, 'tiền đã thu');
    const again = await t.back({ ref: 'REF1', ...a.query });
    assert.equal(again.event.type, 'succeeded');
    assert.equal((await t.state()).captures.length, 1);
    assert.equal((await t.adapter.query({ attemptRef: 'REF1', state: c.state })).type, 'succeeded');
  } finally { await t.teardown(); }
});

test('sự kiện lạ, thiếu trường hoặc sai hình dạng (chữ ký đúng): bỏ qua hoặc retryLater, không bao giờ đoán thành tiền', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    const a = await t.approve(c);
    await t.back({ ref: 'REF1', ...a.query });
    const cap = (await t.state()).captures[0];
    const mark = t.rcv.received.length;
    for (const type of ['CHECKOUT.ORDER.COMPLETED', 'PAYMENT.REFUND.PENDING', 'PAYMENT.REFUND.FAILED', 'CUSTOMER.DISPUTE.UPDATED', 'BILLING.SUBSCRIPTION.CREATED']) await t.post('/sim/emit', { type, resource: { id: 'X1' } });
    await t.post('/sim/emit', { type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-LA', amount: { currency_code: 'USD', value: '1.00' } } }); // capture không có trong PayPal
    await t.post('/sim/emit', { type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'D1', dispute_amount: { currency_code: 'USD', value: '1.00' }, disputed_transactions: [] } });
    await t.post('/sim/emit', { type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: 'AUT-LA', amount: { currency_code: 'USD', value: '1.00' } } }); // không order, không custom_id
    const got = t.rcv.received.slice(mark);
    assert.equal(got.length, 8);
    for (const d of got) {
      const r = await t.parse(d);
      assert.equal(r.valid, true);
      assert.equal(r.event, undefined, JSON.parse(d.raw).event_type);
    }
    // chữ ký đúng nhưng thân không phải sự kiện
    const bare = { ...got[0], raw: '[]' };
    assert.equal((await t.parse(bare)).valid, false, 'sửa thân thì chữ ký sai');
    // số tiền không đổi được (quá số chữ số thập phân của USD) thì retryLater, không làm tròn
    await t.post('/sim/emit', { type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: cap.id, custom_id: 'REF1', amount: { currency_code: 'USD', value: '19.999' }, supplementary_data: { related_ids: { order_id: c.state.order } } } });
    const odd = await t.parse(t.rcv.received[t.rcv.received.length - 1]);
    assert.equal(odd.retryLater, true);
  } finally { await t.teardown(); }
});

test('kênh webhook bị 5xx từ phía ta: simulator giao lại theo lịch (2, 4 phút...), adapter nhận đúng sự kiện mỗi lần, không thu thêm', async () => {
  const t = await setup();
  try {
    t.rcv.status = 500;
    const c = await t.create('REF1');
    await t.approve(c);
    assert.equal(t.rcv.received.length, 1);
    await t.advance(125);
    assert.ok(t.rcv.received.length >= 2, 'giao lại');
    t.rcv.status = 200;
    await t.advance(300);
    const evs = await t.events();
    for (const e of evs.filter((x) => x.type === 'succeeded')) assert.equal(e.gatewayTxnId, c.state.order);
    assert.equal((await t.state()).captures.length, 1);
  } finally { await t.teardown(); }
});

test('hai attempt cùng lúc: webhook của order này không bao giờ thu order kia', async () => {
  const t = await setup();
  try {
    const c1 = await t.create('REF1');
    const c2 = await t.create('REF2');
    await t.approve(c1);
    await t.events(); // adapter xử lý mọi webhook đã nhận
    const st = await t.state();
    assert.equal(st.captures.length, 1);
    assert.equal(st.captures[0].order, c1.state.order);
    assert.equal((await t.order(c2.state.order)).status, 'PAYER_ACTION_REQUIRED');
  } finally { await t.teardown(); }
});

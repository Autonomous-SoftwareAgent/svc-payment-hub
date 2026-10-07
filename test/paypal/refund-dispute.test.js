'use strict';
// spec: PYPL-S-002
// Hoàn tiền, hoàn ngoài Hub, đảo capture và tranh chấp của adapter PayPal với simulator. Hoàn do Hub tạo mang custom_id HUB:<refundRef> để webhook hoàn
// của PayPal không bị tính thành tiền bị đảo. CHỈ chạy với simulator: chưa kiểm PayPal thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

async function paid(t, ref = 'REF1', o = {}) {
  const c = await t.create(ref, o);
  const a = await t.approve(c);
  await t.back({ ref, ...a.query });
  const cap = (await t.state()).captures.find((x) => x.order === c.state.order);
  return { c, cap };
}
const rp = (c, extra = {}) => ({ attemptRef: 'REF1', refundRef: 'RF1', amount: 1999, currency: 'USD', gatewayTxnId: c.state.order, state: c.state, ...extra });

test('hoàn đủ: succeeded, custom_id đánh dấu hoàn của Hub, capture thành REFUNDED; webhook hoàn của Hub bị bỏ qua (không tính là tiền bị đảo)', async () => {
  const t = await setup();
  try {
    const { c, cap } = await paid(t);
    const r = await t.adapter.refund(rp(c));
    assert.deepEqual(r, { status: 'succeeded' });
    const st = await t.state();
    assert.equal(st.refunds.length, 1);
    assert.equal(st.refunds[0].custom_id, 'HUB:RF1');
    assert.equal(st.captures.find((x) => x.id === cap.id).status, 'REFUNDED');
    assert.ok(t.types().includes('PAYMENT.CAPTURE.REFUNDED'));
    const evs = await t.events();
    assert.equal(evs.filter((e) => e.type === 'reversed').length, 0, 'hoàn do Hub không thành reversed');
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RF1', attemptRef: 'REF1', state: c.state }), { status: 'succeeded' });
  } finally { await t.teardown(); }
});

test('hoàn một phần rồi hoàn nốt; hoàn quá số còn lại hoặc đã hoàn đủ thì failed (chắc chắn không hoàn)', async () => {
  const t = await setup();
  try {
    const { c } = await paid(t);
    assert.deepEqual(await t.adapter.refund(rp(c, { refundRef: 'RF1', amount: 500 })), { status: 'succeeded' });
    assert.deepEqual(await t.adapter.refund(rp(c, { refundRef: 'RF2', amount: 1500 })), { status: 'failed' }, 'vượt số còn lại (14,99)');
    assert.deepEqual(await t.adapter.refund(rp(c, { refundRef: 'RF3', amount: 1499 })), { status: 'succeeded' });
    assert.deepEqual(await t.adapter.refund(rp(c, { refundRef: 'RF4', amount: 1 })), { status: 'failed' }, 'đã hoàn đủ');
    assert.equal((await t.state()).refunds.length, 2);
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RF2', attemptRef: 'REF1', state: c.state }), { status: 'requested' }, 'hoàn bị từ chối không có trong PayPal: chưa thấy');
  } finally { await t.teardown(); }
});

test('hoàn bất đồng bộ: PENDING là processing, queryRefund theo custom_id, rồi COMPLETED hoặc FAILED', async () => {
  const t = await setup({ controls: { refund_mode: 'async' } });
  try {
    const { c } = await paid(t);
    assert.deepEqual(await t.adapter.refund(rp(c, { refundRef: 'RF1', amount: 1000 })), { status: 'processing' });
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RF1', attemptRef: 'REF1', state: c.state }), { status: 'processing' });
    const id = (await t.state()).refunds[0].id;
    await t.post('/sim/refund/resolve', { id, outcome: 'completed' });
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RF1', attemptRef: 'REF1', state: c.state }), { status: 'succeeded' });
    assert.deepEqual(await t.adapter.refund(rp(c, { refundRef: 'RF2', amount: 999 })), { status: 'processing' });
    const id2 = (await t.state()).refunds.find((x) => x.custom_id === 'HUB:RF2').id;
    await t.post('/sim/refund/resolve', { id: id2, outcome: 'failed' });
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RF2', attemptRef: 'REF1', state: c.state }), { status: 'failed' });
  } finally { await t.teardown(); }
});

test('hoàn mất phản hồi: processing (có thể đã hoàn), gọi lại cùng khóa không hoàn lần hai', async () => {
  const t = await setup({ timeoutMs: 400 });
  try {
    const { c } = await paid(t);
    await t.control({ inject: [{ match: '/refund', mode: 'timeout_after', times: 1 }] });
    assert.deepEqual(await t.adapter.refund(rp(c, { amount: 1000 })), { status: 'processing' });
    assert.equal((await t.state()).refunds.length, 1, 'hoàn đã chạy dù khách không nhận phản hồi');
    assert.deepEqual(await t.adapter.refund(rp(c, { amount: 1000 })), { status: 'succeeded' });
    assert.equal((await t.state()).refunds.length, 1, 'PayPal-Request-Id theo refundRef: không hoàn hai lần');
    await t.control({ inject: [{ match: '/refund', mode: 'status429', times: 1 }] });
    await assert.rejects(t.adapter.refund(rp(c, { refundRef: 'RF9', amount: 100 })), (e) => e.notSent === true);
    assert.equal((await t.state()).refunds.length, 1);
  } finally { await t.teardown(); }
});

test('chưa có capture hoặc thiếu mã order: manual_required, không gọi hoàn bừa', async () => {
  const t = await setup();
  try {
    const c = await t.create('REF1');
    assert.deepEqual(await t.adapter.refund(rp(c)), { status: 'manual_required' });
    assert.deepEqual(await t.adapter.refund({ attemptRef: 'REF1', refundRef: 'RF1', amount: 100, currency: 'USD' }), { status: 'manual_required' });
    assert.equal((await t.state()).refunds.length, 0);
    assert.deepEqual(await t.adapter.refund(rp(c, { amount: 0 })), { status: 'failed' });
  } finally { await t.teardown(); }
});

test('hoàn NGOÀI Hub (làm trên trang PayPal, không có custom_id của Hub): reversed với mã là mã hoàn; webhook trùng cùng mã', async () => {
  const t = await setup({ controls: { dup_webhooks: 1 } });
  try {
    const { c, cap } = await paid(t);
    const tok = (await (await fetch(`${t.sim.url}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${t.sim.config.clientId}:${t.sim.config.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json()).access_token;
    const rr = await fetch(`${t.sim.url}/v2/payments/captures/${cap.id}/refund`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount: { currency_code: 'USD', value: '5.00' } }) });
    assert.equal(rr.status, 201);
    const rev = (await t.events()).filter((e) => e.type === 'reversed');
    assert.equal(rev.length, 2, 'hai lần giao');
    assert.equal(rev[0].gatewayTxnId, rev[1].gatewayTxnId, 'mã ổn định giữa các lần giao');
    assert.equal(rev[0].amount, 500);
    assert.equal(rev[0].attemptRef, 'REF1');
    assert.equal(rev[0].currency, 'USD');
    void c;
  } finally { await t.teardown(); }
});

test('PayPal đảo capture (PAYMENT.CAPTURE.REVERSED): reversed với mã capture và đủ số tiền', async () => {
  const t = await setup();
  try {
    const { cap } = await paid(t);
    await t.post('/sim/reverse', { capture: cap.id });
    const rev = (await t.events()).filter((e) => e.type === 'reversed');
    assert.equal(rev.length, 1);
    assert.equal(rev[0].gatewayTxnId, cap.id);
    assert.equal(rev[0].amount, 1999);
  } finally { await t.teardown(); }
});

test('tranh chấp: mở, thắng, thua cho ra dispute_opened, dispute_won, dispute_lost cùng mã tranh chấp; kết quả khác thì bỏ qua', async () => {
  const t = await setup();
  try {
    const { cap } = await paid(t);
    const d = (await t.post('/sim/dispute', { capture: cap.id })).json;
    await t.post('/sim/dispute/close', { id: d.dispute_id, outcome: 'won' });
    const d2 = (await t.post('/sim/dispute', { capture: cap.id })).json;
    await t.post('/sim/dispute/close', { id: d2.dispute_id, outcome: 'lost' });
    const d3 = (await t.post('/sim/dispute', { capture: cap.id })).json;
    await t.post('/sim/dispute/close', { id: d3.dispute_id, outcome: 'other' });
    const evs = (await t.events()).filter((e) => e.type.startsWith('dispute_'));
    assert.deepEqual(evs.map((e) => [e.type, e.gatewayTxnId]), [
      ['dispute_opened', d.dispute_id], ['dispute_won', d.dispute_id],
      ['dispute_opened', d2.dispute_id], ['dispute_lost', d2.dispute_id],
      ['dispute_opened', d3.dispute_id],
    ]);
    for (const e of evs) { assert.equal(e.attemptRef, 'REF1'); assert.equal(e.amount, 1999); assert.equal(e.currency, 'USD'); }
  } finally { await t.teardown(); }
});

test('tranh chấp mà tra capture hỏng tạm thời: retryLater (cổng gửi lại), không mất tin', async () => {
  const t = await setup();
  try {
    const { cap } = await paid(t);
    const before = t.rcv.received.length;
    await t.post('/sim/dispute', { capture: cap.id });
    const d = t.rcv.received[before];
    await t.control({ inject: [{ match: 'GET /v2/payments/captures', mode: 'status500_before', times: 1 }] });
    const r = await t.parse(d);
    assert.equal(r.valid, true);
    assert.equal(r.retryLater, true);
    assert.equal(r.ack('error').status, 500);
    assert.equal((await t.parse(d)).event.type, 'dispute_opened');
  } finally { await t.teardown(); }
});

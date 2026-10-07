'use strict';
// spec: SEPY-S-001
// spec: SEPY-S-003
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertEvent } = require('../../src/contract.js');
const { setup } = require('./helpers.js');

for (const authMode of ['hmac', 'apikey', 'none']) {
  test(`vòng đời (${authMode}): chuyển khoản đủ -> received đúng amount/txnId/attemptRef`, async () => {
    const t = await setup({ authMode });
    try {
      const tx = await t.transfer('BSNORDER001 thanh toan', 150000);
      assert.equal(t.rcv.events.length, 1);
      const ev = t.rcv.events[0];
      assertEvent(ev);
      assert.equal(ev.type, 'received'); assert.equal(ev.attemptRef, 'BSNORDER001'); assert.equal(ev.amount, 150000);
      assert.equal(ev.gatewayTxnId, tx.referenceCode); assert.equal(ev.source, 'ipn'); assert.equal(ev.gateway, 'sepay');
      assert.equal(ev.content, 'BSNORDER001 thanh toan');
      assert.equal(ev.occurredAt, Date.parse(tx.transactionDate.replace(' ', 'T') + '+07:00'));
      assert.equal(tx.webhook.status, 'success');
    } finally { await t.teardown(); }
  });
}

test('mã viết thường trong nội dung vẫn khớp (code do SePay tách luôn viết hoa)', async () => {
  const t = await setup();
  try {
    await t.transfer('bsnorder002 chuyen tien', 5000);
    const ev = t.rcv.events[0];
    assert.equal(ev.attemptRef, 'BSNORDER002');
    assert.equal(t.rcv.results[0].event.raw.code, 'BSNORDER002');
  } finally { await t.teardown(); }
});

test('code null (SePay không tách) nhưng content có mã -> adapter tự tìm trong content', async () => {
  const t = await setup({ controls: { code_extraction: false } });
  try {
    await t.transfer('chuyen khoan bsnorder003 cam on', 7000);
    const ev = t.rcv.events[0];
    assert.equal(t.rcv.results[0].event.raw.code, null);
    assert.equal(ev.attemptRef, 'BSNORDER003'); assert.equal(ev.unmatched, undefined);
  } finally { await t.teardown(); }
});

test('code là chuỗi rỗng cũng được xử lý như null', () => {
  const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
  const a = createSepayAdapter({ codePrefix: 'BSN', authMode: 'none', accountNumber: '0123456789', bankName: 'MBBank' }, { clock: { now: () => 0 } });
  for (const code of [null, '', '  ']) {
    const r = a.parseCallback({ channel: 'ipn', headers: {}, body: { id: 1, code, content: 'x bsnzz9', transferType: 'in', transferAmount: 10, transactionDate: '2026-10-02 10:00:00' } });
    assert.equal(r.event.attemptRef, 'BSNZZ9');
  }
});

test('không có mã -> unmatched, vẫn có amount/txnId để Hub ghi anomaly', async () => {
  const t = await setup();
  try {
    const tx = await t.transfer('chuyen tien an trua', 99000);
    const ev = t.rcv.events[0];
    assertEvent(ev);
    assert.equal(ev.attemptRef, null); assert.equal(ev.unmatched, true); assert.equal(ev.type, 'received');
    assert.equal(ev.amount, 99000); assert.equal(ev.gatewayTxnId, tx.referenceCode); assert.equal(ev.content, 'chuyen tien an trua');
  } finally { await t.teardown(); }
});

test('tiền ra bị bỏ qua: valid nhưng không có event; webhook vẫn được ack', async () => {
  const t = await setup({ controls: { webhook_send_out: true } });
  try {
    await t.transfer('BSNORDER004', 1000);
    assert.equal(t.rcv.requests.length, 2); // một vào, một ra
    assert.equal(t.rcv.results[1].valid, true);
    assert.equal(t.rcv.results[1].event, undefined);
    assert.equal(t.rcv.events.length, 1);
    const direct = await t.transfer('rut tien BSNORDER004', 500, { transferType: 'out' });
    assert.equal(direct.webhook.status, 'success');
    assert.equal(t.rcv.events.length, 1);
  } finally { await t.teardown(); }
});

for (const authMode of ['hmac', 'apikey']) {
  test(`form-urlencoded (${authMode}): mọi giá trị là chuỗi, adapter ép kiểu số`, async () => {
    const t = await setup({ authMode, controls: { webhook_content_type: 'form', subaccount_null: true } });
    try {
      const tx = await t.transfer('BSNFORM001', 123000);
      assert.match(t.rcv.requests[0].headers['content-type'], /x-www-form-urlencoded/);
      assert.equal(typeof t.rcv.results[0].event.raw.transferAmount, 'string'); // body form thật sự là chuỗi
      const ev = t.rcv.events[0];
      assert.equal(ev.amount, 123000); assert.ok(Number.isInteger(ev.amount));
      assert.equal(ev.gatewayTxnId, tx.referenceCode); assert.equal(ev.attemptRef, 'BSNFORM001');
    } finally { await t.teardown(); }
  });
}

test('query và reconcileFeed thấy giao dịch đã nhận qua webhook', async () => {
  const t = await setup();
  try {
    const tx = await t.transfer('BSNQ0001', 10000);
    const q = await t.adapter.query({ attemptRef: 'BSNQ0001' });
    assert.ok(Array.isArray(q)); assert.equal(q.length, 1);
    assertEvent(q[0]);
    assert.equal(q[0].gatewayTxnId, tx.referenceCode); assert.equal(q[0].source, 'query'); assert.equal(q[0].amount, 10000);
    assert.deepEqual(await t.adapter.query({ attemptRef: 'BSNNONE1' }), { state: 'not_found' });
    const feed = await t.adapter.reconcileFeed({ now: t.sim.clock.now() });
    assert.equal(feed.events.length, 1); assert.equal(feed.nextCursor, String(tx.id));
    const again = await t.adapter.reconcileFeed({ cursor: feed.nextCursor, now: t.sim.clock.now() });
    assert.deepEqual(again.events, []); assert.equal(again.nextCursor, feed.nextCursor);
  } finally { await t.teardown(); }
});

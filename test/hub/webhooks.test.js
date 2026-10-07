'use strict';
// spec: PHUB-S-011
// Webhook đi tới cửa hàng: hộp thư đi, ký số (kiểm tra bằng HMAC tính độc lập), gửi lại theo bậc, dead, gửi lại thủ công, bền vững qua khởi động lại.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PaymentHub } = require('../../src/hub');
const { EventOutbox } = require('../../src/events');
const { buildSinks } = require('../../src/connectors/registry');
const { MemoryStore } = require('../../src/store');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

const SECRET = 'whsec-test-not-real';
const URL = 'https://shop.test/hook';

function setup(opts = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a', { caps: opts.caps });
  const sent = [];
  const state = { status: 200, throwError: null };
  const fetch = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body), at: clock.now() });
    if (state.throwError) throw new Error(state.throwError);
    return { status: state.status, body: null };
  };
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a },
    clock,
    store: opts.store,
    newRef: (p) => `${p}${++n}`,
    deps: { sinks: buildSinks({ fetch }) },
    config: { gateways: [{ id: 'a', priority: 1 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 86400 }, webhooks: { url: URL, secret: SECRET, auto: false, backoffSeconds: [5, 30], maxAttempts: 3, ...(opts.webhooks || {}) } },
  });
  return { hub, a, clock, sent, state };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });
const ipn = (hub, attempt, type = 'succeeded', extra = {}) => hub.handleCallback('a', { channel: 'ipn', body: { ref: attempt.ref, type, amount: attempt.amount, txn: 'T1', ...extra }, headers: {} });

test('thanh toán thành công: payment.paid vào hộp thư đi, gửi có ký HMAC khớp giá trị tính độc lập', async () => {
  const { hub, sent, clock } = setup();
  const { payment, attempt } = await hub.createPayment(order());
  assert.equal(sent.length, 0, 'chưa có gì để báo');
  await ipn(hub, attempt);
  await hub.deliverWebhooks();
  assert.equal(sent.length, 1);
  const r = sent[0];
  assert.equal(r.url, URL);
  assert.equal(r.body.type, 'payment.paid');
  assert.equal(r.body.data.paymentId, payment.id);
  assert.equal(r.body.data.orderId, 'O1');
  assert.equal(r.body.data.amount, 100000);
  assert.equal(r.body.data.gateway, 'a');
  const h = r.init.headers;
  assert.equal(h['x-hub-event-id'], r.body.id);
  assert.equal(h['x-hub-timestamp'], String(Math.floor(clock.now() / 1000)));
  const expected = crypto.createHmac('sha256', SECRET).update(`${h['x-hub-timestamp']}.${r.init.body}`).digest('hex');
  assert.equal(h['x-hub-signature'], expected);
});

test('IPN trùng không sinh thêm webhook; mỗi sự kiện chỉ một eventId', async () => {
  const { hub, sent } = setup();
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  await ipn(hub, attempt);
  await hub.deliverWebhooks();
  await hub.deliverWebhooks();
  assert.equal(sent.filter((x) => x.body.type === 'payment.paid').length, 1);
  assert.equal((await hub.listWebhooks({})).length, 1);
});

test('gửi lại theo bậc: 5xx thì hẹn lại, chưa đến hạn thì không gửi, cùng eventId và cùng thân; 2xx thì delivered', async () => {
  const { hub, sent, clock, state } = setup();
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  state.status = 500;
  await hub.deliverWebhooks();
  let [w] = await hub.listWebhooks({});
  assert.equal(w.status, 'pending');
  assert.equal(w.attempts, 1);
  assert.equal(w.lastStatus, 500);
  assert.equal(w.nextAt, clock.now() + 5000);
  await hub.deliverWebhooks();
  assert.equal(sent.length, 1, 'chưa đến hạn');
  clock.advance(5);
  state.status = 200;
  await hub.deliverWebhooks();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.id, sent[0].body.id);
  assert.equal(sent[1].init.body, sent[0].init.body, 'thân giữ nguyên giữa các lần gửi');
  [w] = await hub.listWebhooks({});
  assert.equal(w.status, 'delivered');
  assert.equal(w.attempts, 2);
  clock.advance(3600);
  await hub.deliverWebhooks();
  assert.equal(sent.length, 2, 'đã giao thì không gửi nữa');
});

test('lỗi mạng tính là thất bại; hết maxAttempts thì dead; gửi lại thủ công đưa về pending và gửi được', async () => {
  const { hub, sent, clock, state } = setup();
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  state.throwError = 'ECONNRESET';
  await hub.deliverWebhooks();
  clock.advance(5); await hub.deliverWebhooks();
  clock.advance(30); await hub.deliverWebhooks();
  let [w] = await hub.listWebhooks({});
  assert.equal(w.status, 'dead');
  assert.equal(w.attempts, 3);
  assert.match(w.lastError, /ECONNRESET/);
  clock.advance(99999); await hub.deliverWebhooks();
  assert.equal(sent.length, 3, 'dead thì không tự gửi nữa');
  state.throwError = null;
  await hub.retryWebhook(w.id);
  await hub.deliverWebhooks();
  [w] = await hub.listWebhooks({});
  assert.equal(w.status, 'delivered');
  assert.equal(sent.length, 4);
  await assert.rejects(hub.retryWebhook(w.id), { code: 'invalid_state' });
  await assert.rejects(hub.retryWebhook('evt_khong_co'), { code: 'not_found' });
});

test('payment.closed khi hết hạn mà không còn attempt nhận tiền được', async () => {
  const { hub, sent, clock } = setup();
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt, 'failed');
  clock.advance(1801);
  await hub.reconcile();
  await hub.deliverWebhooks();
  assert.deepEqual(sent.map((x) => x.body.type), ['payment.closed']);
  assert.equal(sent[0].body.data.status, 'CLOSED');
});

test('refund.updated: hoàn thủ công (cổng không có API) và xác nhận xong đều báo', async () => {
  const { hub, sent } = setup({ caps: { refundable: 'manual' } });
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  const r = await hub.refund({ attemptId: attempt.id });
  assert.equal(r.status, 'MANUAL_REQUIRED');
  await hub.markRefundDone(r.id);
  await hub.deliverWebhooks();
  const refunds = sent.filter((x) => x.body.type === 'refund.updated').map((x) => x.body.data.status);
  assert.deepEqual(refunds.sort(), ['MANUAL_REQUIRED', 'SUCCEEDED']);
});

test('anomaly.opened: thông báo cho mã không biết và tiền về muộn đều báo cửa hàng', async () => {
  const { hub, sent } = setup();
  await hub.handleCallback('a', { channel: 'ipn', body: { ref: 'KHONGCO', type: 'succeeded', amount: 5, txn: 'TX' }, headers: {} });
  await hub.deliverWebhooks();
  const an = sent.find((x) => x.body.type === 'anomaly.opened');
  assert.ok(an);
  assert.equal(an.body.data.type, 'unknown_attempt');
  assert.equal(an.body.data.amount, 5);
});

test('tắt khi không cấu hình url; bật url mà thiếu secret thì lỗi khi khởi động', async () => {
  const clock = createClock();
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({ adapters: { a }, clock, config: { gateways: [{ id: 'a' }] } });
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  assert.equal(hub.events.enabled, false);
  assert.deepEqual(await hub.listWebhooks({}), []);
  assert.throws(() => new EventOutbox({ store: new MemoryStore(), clock, sinks: buildSinks({}), config: { url: URL } }), /secret/);
  assert.throws(() => new EventOutbox({ store: new MemoryStore(), clock, sinks: buildSinks({}), config: { url: 'ftp://x', secret: 's' } }), /http/);
});

test('gửi song song có giới hạn concurrency', async () => {
  const clock = createClock();
  let cur = 0; let max = 0;
  const fetch = async () => { cur += 1; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 15)); cur -= 1; return { status: 200, body: null }; };
  const store = new MemoryStore();
  const ob = new EventOutbox({ store, clock, sinks: buildSinks({ fetch }), config: { url: URL, secret: SECRET, concurrency: 3 } });
  for (let i = 0; i < 12; i++) ob.emit('payment.paid', `p${i}`, 'paid', { i });
  assert.equal(await ob.deliverDue(), 12);
  assert.equal(max, 3);
  assert.equal(store.pendingWebhooks().length, 0);
});

test('bền vững: sự kiện nằm cùng transaction với thay đổi trạng thái, sống qua khởi động lại, đã giao thì rời bộ nhớ nhưng vẫn truy vấn được', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const s1 = await db.open();
    const t1 = setup({ store: s1 });
    const { attempt } = await t1.hub.createPayment(order());
    await ipn(t1.hub, attempt);
    await s1.close();

    const s2 = await db.open();
    const t2 = setup({ store: s2 });
    assert.equal(s2.pendingWebhooks().length, 1, 'webhook chưa giao được nạp lại');
    await t2.hub.deliverWebhooks();
    assert.equal(t2.sent.length, 1);
    assert.equal(s2.webhooks.size, 0, 'đã giao thì không giữ trong bộ nhớ');
    const delivered = await t2.hub.listWebhooks({ status: 'delivered' });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].attempts, 1);
    await s2.close();

    const s3 = await db.open();
    assert.equal(s3.pendingWebhooks().length, 0);
    const t3 = setup({ store: s3 });
    await t3.hub.deliverWebhooks();
    assert.equal(t3.sent.length, 0, 'không gửi lại webhook đã giao');
    await assert.rejects(t3.hub.retryWebhook(delivered[0].id), { code: 'invalid_state' }, 'nạp từ DB theo id rồi từ chối vì đã giao');
    await s3.close();
  } finally { await db.cleanup(); }
});

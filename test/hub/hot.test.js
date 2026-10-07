'use strict';
// spec: PHUB-S-012
// Bộ nhớ nóng (PHUB-D-012): giao dịch đã đóng được đẩy ra khỏi bộ nhớ và nạp lại theo yêu cầu mà không đổi kết quả nghiệp vụ.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { MemoryStore } = require('../../src/store');
const { createHubServer } = require('../../src/server');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });
const ipn = (hub, attempt, type = 'succeeded', extra = {}) => hub.handleCallback('a', { channel: 'ipn', body: { ref: attempt.ref, type, amount: attempt.amount, txn: 'T1', ...extra }, headers: {} });

async function boot(db, opts = {}) {
  const store = await db.open();
  const a = opts.a || createFakeAdapter('a', { caps: opts.caps });
  const clock = opts.clock || createClock();
  let n = 0;
  const hub = new PaymentHub({ adapters: { a }, store, clock, newRef: (p) => `${p}${opts.prefix || ''}${++n}`, config: { gateways: [{ id: 'a' }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 86400 } } });
  return { hub, store, a, clock };
}
const evictAll = (store) => store.evictIdle(0, Date.now() + 1000);
const withDb = (name, fn) => test(name, { skip: SKIP }, async () => { const db = freshDb(); try { await fn(db); } finally { await db.cleanup(); } });

withDb('chỉ đẩy ra payment đã đóng, đã lưu và nhàn rỗi; payment mở, attempt sống, hoàn tiền mở, anomaly mở, thực thể bẩn thì giữ lại', async (db) => {
  const { hub, store } = await boot(db);
  const open = await hub.createPayment(order({ orderId: 'OPEN' }));
  const paid = await hub.createPayment(order({ orderId: 'PAID' }));
  await ipn(hub, paid.attempt);
  const refunding = await hub.createPayment(order({ orderId: 'REF' }));
  await ipn(hub, refunding.attempt, 'succeeded', { txn: 'T2' });
  await hub.refund({ attemptId: refunding.attempt.id, amount: 1000 }); // PROCESSING = còn mở
  const withAnomaly = await hub.createPayment(order({ orderId: 'AN' }));
  await ipn(hub, withAnomaly.attempt, 'succeeded', { txn: 'T3' });
  await ipn(hub, withAnomaly.attempt, 'failed', { txn: 'T3b' }); // conflicting_result đang mở
  assert.equal(store.openAnomalies().length, 1);

  assert.equal(store.evictIdle(60000), 0, 'chưa nhàn rỗi đủ lâu thì không đẩy ra');
  assert.equal(evictAll(store), 1, 'chỉ payment PAID sạch');
  assert.equal(store.payments.has(paid.payment.id), false);
  for (const k of [open, refunding, withAnomaly]) assert.equal(store.payments.has(k.payment.id), true);

  const again = await hub.loadPayment(paid.payment.id);
  again.payment.note = 'sửa mà chưa lưu'; // làm bẩn
  assert.equal(evictAll(store), 0, 'thực thể bẩn thì giữ lại');
  await hub.store.persist();
  assert.equal(evictAll(store), 1, 'lưu xong thì đẩy ra được');
});

test('MemoryStore không bao giờ đẩy ra (không có nơi lưu)', async () => {
  const hub = new PaymentHub({ adapters: { a: createFakeAdapter('a') }, clock: createClock(), config: { gateways: [{ id: 'a' }] } });
  const { payment, attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  assert.equal(hub.store instanceof MemoryStore, true);
  assert.equal(hub.store.evictIdle(0, Date.now() + 10000), 0);
  assert.ok(hub.store.getPayment(payment.id));
});

withDb('thông báo muộn cho attempt đã đẩy ra: bản trùng vẫn là duplicate, kết quả mâu thuẫn vẫn thành anomaly', async (db) => {
  const { hub, store } = await boot(db);
  const { payment, attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  await store.persist();
  assert.equal(evictAll(store), 1);
  assert.equal(store.attempts.size, 0);

  const dup = await ipn(hub, attempt); // cùng khóa idempotency: phải nhớ được dù đã đẩy ra
  assert.equal(dup.outcome, 'duplicate');
  assert.equal(store.openAnomalies().length, 0);
  await store.persist();
  assert.equal(evictAll(store), 1);

  const late = await ipn(hub, attempt, 'failed', { txn: 'T9' });
  assert.equal(late.outcome, 'ok');
  assert.equal(hub.store.anomaliesOfPayment(payment.id)[0].type, 'conflicting_result');
  assert.equal(hub.store.getPayment(payment.id).status, 'PAID', 'trạng thái cuối không đổi');
});

withDb('callback trùng đồng thời cho attempt đã đẩy ra: chỉ nạp một bản, không có hai bản lệch nhau', async (db) => {
  const { hub, store } = await boot(db);
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  await store.persist();
  evictAll(store);
  const results = await Promise.all(Array.from({ length: 8 }, () => ipn(hub, attempt)));
  assert.deepEqual([...new Set(results.map((r) => r.outcome))], ['duplicate']);
  assert.equal(store.attempts.size, 1);
  assert.equal(store.payments.size, 1);
});

withDb('tạo thanh toán cùng orderId sau khi payment đã đẩy ra: trả payment cũ, không tạo lần thu thứ hai', async (db) => {
  const { hub, store, a } = await boot(db);
  const first = await hub.createPayment(order());
  await ipn(hub, first.attempt);
  await store.persist();
  evictAll(store);
  const again = await hub.createPayment(order());
  assert.equal(again.existing, true);
  assert.equal(again.payment.id, first.payment.id);
  assert.equal(a.created.length, 1);
  await store.persist();
  evictAll(store);
  await assert.rejects(hub.createPayment(order({ amount: 5 })), { code: 'order_conflict' });
});

withDb('đơn có payment cũ (CLOSED) còn trong bộ nhớ và payment mới (PAID) đã đẩy ra: vẫn trả payment mới, không tạo lần thứ ba', async (db) => {
  const { hub, store, a, clock } = await boot(db);
  const p1 = await hub.createPayment(order());
  await ipn(hub, p1.attempt, 'failed');
  clock.advance(1801);
  await hub.reconcile();
  assert.equal(store.getPayment(p1.payment.id).status, 'CLOSED');
  const p2 = await hub.createPayment(order());
  assert.notEqual(p2.payment.id, p1.payment.id);
  await ipn(hub, p2.attempt, 'succeeded', { txn: 'T2' });
  await store.persist();
  store._touched.set(p1.payment.id, Date.now()); // payment cũ còn "tươi", payment mới nhàn rỗi
  store._touched.set(p2.payment.id, 0);
  assert.equal(store.evictIdle(1000), 1);
  assert.equal(store.payments.has(p1.payment.id), true);
  assert.equal(store.payments.has(p2.payment.id), false);
  const r = await hub.createPayment(order());
  assert.equal(r.existing, true);
  assert.equal(r.payment.id, p2.payment.id);
  assert.equal(a.created.length, 2);
});

withDb('hoàn tiền và xử lý anomaly cho giao dịch đã đẩy ra: nạp lại rồi làm bình thường', async (db) => {
  const { hub, store } = await boot(db);
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  await store.persist();
  evictAll(store);
  const r = await hub.refund({ attemptId: attempt.id, amount: 5000 });
  assert.equal(r.status, 'PROCESSING');
  await hub.reconcile(); // hoàn tiền xong (fake trả succeeded khi hỏi lại)
  await hub.reconcile();

  const p2 = await hub.createPayment(order({ orderId: 'O2' }));
  await ipn(hub, p2.attempt, 'succeeded', { txn: 'TT' });
  const conflict = await ipn(hub, p2.attempt, 'failed', { txn: 'TF' });
  assert.equal(conflict.outcome, 'ok');
  const an = hub.store.anomaliesOfPayment(p2.payment.id)[0];
  await hub.resolveAnomaly(an.id, { action: 'ignore', note: 'đã kiểm tra' });
  await store.persist();
  evictAll(store);
  assert.equal(store.anomalies.length, 0, 'anomaly đã xử lý cũng rời bộ nhớ cùng payment');
  const found = await hub.findAnomalies({ status: 'ignored' });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, an.id);
  await assert.rejects(hub.resolveAnomaly(an.id, { action: 'ignore' }), { code: 'invalid_state' }, 'nạp lại từ DB thấy đã xử lý');
});

withDb('khởi động lại chỉ nạp phần còn hoạt động; vẫn tìm được giao dịch đã đóng theo mã và theo đơn', async (db) => {
  const t1 = await boot(db);
  const closed = await t1.hub.createPayment(order({ orderId: 'CLOSED' }));
  await ipn(t1.hub, closed.attempt);
  const live = await t1.hub.createPayment(order({ orderId: 'LIVE' }));
  await t1.hub.handleCallback('a', { channel: 'ipn', body: { unmatched: true, amount: 77, txn: 'UM1', content: 'x' }, headers: {} });
  await t1.store.close();

  const t2 = await boot(db, { a: t1.a, clock: t1.clock, prefix: 'z' });
  assert.deepEqual([...t2.store.payments.keys()], [live.payment.id], 'chỉ payment còn mở');
  assert.equal(t2.store.openAnomalies().length, 1, 'anomaly không gắn payment được nạp');
  const dupUnmatched = await t2.hub.handleCallback('a', { channel: 'ipn', body: { unmatched: true, amount: 77, txn: 'UM1', content: 'x' }, headers: {} });
  assert.equal(dupUnmatched.outcome, 'duplicate', 'khóa idempotency của tiền chưa rõ chủ vẫn nhớ');
  const dup = await ipn(t2.hub, closed.attempt);
  assert.equal(dup.outcome, 'duplicate', 'attempt đã đóng nạp theo mã, khóa idempotency kèm theo');
  const again = await t2.hub.createPayment(order({ orderId: 'CLOSED' }));
  assert.equal(again.existing, true);
  assert.equal(again.payment.id, closed.payment.id);
});

withDb('API: GET /payments/{id} và GET /anomalies thấy cả giao dịch đã đẩy ra', async (db) => {
  const { hub, store } = await boot(db);
  const { payment, attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  await ipn(hub, attempt, 'failed', { txn: 'TF' });
  const an = hub.store.anomaliesOfPayment(payment.id)[0];
  await hub.resolveAnomaly(an.id, { action: 'ignore' });
  await store.persist();
  evictAll(store);
  const api = createHubServer({ hub, apiToken: 'test-api-token-not-real', log: () => {} });
  const { url } = await api.listen(0);
  try {
    const h = { authorization: 'Bearer test-api-token-not-real' };
    const r = await fetch(`${url}/payments/${payment.id}`, { headers: h });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.payment.status, 'PAID');
    assert.equal(j.attempts[0].status, 'SUCCEEDED');
    assert.equal(j.anomalies.length, 1);
    const l = await (await fetch(`${url}/anomalies?status=ignored`, { headers: h })).json();
    assert.equal(l.anomalies.length, 1);
    assert.equal((await fetch(`${url}/payments/pay_khong_co`, { headers: h })).status, 404);
  } finally { await api.close(); }
});

withDb('khóa idempotency có hạn dùng: purgeSeen xóa khóa quá hạn trong DB, giữ khóa mới', async (db) => {
  const { hub, store } = await boot(db);
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  await store.persist();
  const n = async () => Number((await store.client.query('SELECT count(*) AS c FROM seen')).rows[0].c);
  assert.ok(await n() >= 1);
  assert.equal(await store.purgeSeen(90), 0, 'khóa mới không bị xóa');
  await store.client.query("UPDATE seen SET at = now() - interval '100 days'");
  assert.ok(await store.purgeSeen(90) >= 1);
  assert.equal(await n(), 0);
});

withDb('bộ lập lịch tự đẩy giao dịch đã đóng ra theo hot.idleSeconds', async (db) => {
  const store = await db.open();
  const a = createFakeAdapter('a');
  const hub = new PaymentHub({ adapters: { a }, store, clock: createClock(), config: { gateways: [{ id: 'a' }], hot: { idleSeconds: 0.05, evictEverySeconds: 0.05 } } });
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, attempt);
  await store.persist();
  hub.startScheduler({ everySeconds: 3600 });
  try {
    for (let i = 0; i < 40 && store.payments.size; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.payments.size, 0);
  } finally { hub.stopScheduler(); }
});

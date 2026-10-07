'use strict';
// spec: PHUB-S-009
// Chịu tải (PHUB-D-009): chỉ mục, theo dõi thay đổi, ghi theo thay đổi, nhóm commit, giữ đuôi nhật ký; cấu hình đối soát/hoàn tiền/routing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { MemoryStore } = require('../../src/store');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return', ...o });
const ipn = (hub, gw, attempt, type = 'succeeded', extra = {}) => hub.handleCallback(gw, { channel: 'ipn', body: { ref: attempt.ref, type, amount: attempt.amount, txn: 'T1', ...extra }, headers: {} });

function mk(cfg = {}, opts = {}) {
  const clock = createClock();
  const a = createFakeAdapter('a', opts.capsA);
  const b = createFakeAdapter('b', opts.capsB);
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a, b }, clock, store: opts.store, newRef: (p) => `${p}${++n}`,
    config: { gateways: [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120], maxAgeSeconds: 86400 }, ...cfg },
  });
  return { hub, a, b, clock };
}

// ---------- chỉ mục và theo dõi thay đổi ----------

test('chỉ mục: attempt theo (cổng, mã) kể cả khác hoa thường; payment theo orderId (mới nhất); payment/attempt còn sống', async () => {
  const { hub } = mk({}, { capsA: { caps: { referenceFormat: { caseInsensitive: true } } } });
  const { payment, attempt } = await hub.createPayment(order());
  assert.equal(hub.store.findAttemptByRef('a', attempt.ref), attempt);
  assert.equal(hub.store.findAttemptByRef('a', attempt.ref.toLowerCase()).id, attempt.id);
  assert.equal(hub.store.findAttemptByRef('b', attempt.ref), undefined);
  assert.equal(hub.store.findPaymentByOrderId('O1').id, payment.id);
  assert.deepEqual(hub.store.openPayments().map((p) => p.id), [payment.id]);
  assert.deepEqual(hub.store.liveAttempts().map((x) => x.id), [attempt.id]);
  await ipn(hub, 'a', attempt);
  assert.equal(hub.store.openPayments().length, 0, 'PAID không còn mở');
  assert.equal(hub.store.liveAttempts().length, 0, 'SUCCEEDED không còn sống');
});

test('chỉ mục anomaly: theo attempt, theo payment, theo (cổng, mã lạ), danh sách đang mở', async () => {
  const { hub } = mk();
  const { payment, attempt } = await hub.createPayment(order());
  await ipn(hub, 'a', attempt);
  await ipn(hub, 'a', attempt, 'failed', { txn: 'T2' }); // kết quả mâu thuẫn với SUCCEEDED đã ghi
  await hub.handleCallback('a', { channel: 'ipn', body: { ref: 'LA', type: 'succeeded', amount: 7, txn: 'TX' }, headers: {} });
  assert.equal(hub.store.anomaliesOfAttempt(attempt.id).length, 1);
  assert.equal(hub.store.anomaliesOfPayment(payment.id).length, 1);
  assert.equal(hub.store.anomaliesOfRef('a', 'LA').length, 1);
  assert.equal(hub.store.openAnomalies().length, 2);
  const an = hub.store.anomaliesOfAttempt(attempt.id)[0];
  await hub.resolveAnomaly(an.id, { action: 'ignore', note: 'x' });
  assert.equal(hub.store.openAnomalies().length, 1, 'đã xử lý thì rời danh sách mở');
  assert.equal(hub.store.getAnomaly(an.id), an);
});

test('theo dõi thay đổi: sửa trường lồng nhau (push vào mảng) cũng đánh dấu bẩn; nạp từ nơi lưu thì không bẩn', async () => {
  const s = new MemoryStore();
  const att = s.putAttempt({ id: 'att_1', ref: 'R', gateway: 'a', paymentId: 'pay_1', status: 'AWAITING', receipts: [] });
  s.dirty.clear();
  att.receipts.push({ txn: 'T', amount: 1 });
  assert.ok(s.dirty.has('attempt:att_1'));
  s.dirty.clear();
  att.nested = { deep: { x: 1 } };
  s.dirty.clear();
  att.nested.deep.x = 2;
  assert.ok(s.dirty.has('attempt:att_1'));
  s.dirty.clear();
  s.adopt('payment', { id: 'pay_9', orderId: 'Z', status: 'OPEN' });
  assert.equal(s.dirty.size, 0);
  assert.equal(s.openPayments().length, 1, 'nhưng vẫn vào chỉ mục');
  assert.equal(JSON.parse(JSON.stringify(att)).receipts[0].txn, 'T', 'chuỗi hóa qua proxy ra dữ liệu thật');
});

// ---------- PostgreSQL: ghi theo thay đổi, nhóm commit, đuôi nhật ký ----------

function spy(store) {
  const log = [];
  const orig = store.client.query.bind(store.client);
  store.client.query = (text, params) => { if (typeof text === 'string') log.push({ text, params }); return orig(text, params); };
  return log;
}

test('persist chỉ ghi thực thể đã đổi, không quét toàn bộ', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const store = await db.open();
    const { hub } = mk({}, { store });
    for (let i = 0; i < 200; i++) await hub.createPayment(order({ orderId: `O${i}` }));
    const log = spy(store);
    const { attempt } = await hub.createPayment(order({ orderId: 'ONE' }));
    log.length = 0;
    await ipn(hub, 'a', attempt);
    const docWrites = log.filter((q) => q.text.startsWith('INSERT INTO docs'));
    assert.equal(docWrites.length, 1);
    assert.ok(docWrites[0].params[1].length <= 2, `ghi ${docWrites[0].params[1].length} dòng cho một callback (payment + attempt)`);
    await store.close();
  } finally { await db.cleanup(); }
});

test('nhóm commit: 20 luồng làm lần lượt 10 thao tác (chờ lưu xong mới làm tiếp) dùng chung ít transaction, không phải mỗi thao tác một lần', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const store = await db.open();
    const { hub } = mk({}, { store });
    const log = spy(store);
    await Promise.all(Array.from({ length: 20 }, async (_, w) => { for (let i = 0; i < 10; i++) await hub.createPayment(order({ orderId: `C${w}_${i}` })); }));
    const commits = log.filter((q) => q.text === 'COMMIT').length;
    assert.ok(commits < 50, `200 thao tác cần ${commits} commit`);
    await store.close();
    const s2 = await db.open();
    assert.equal(s2.payments.size, 200, 'mọi thao tác đều đã lưu');
    assert.equal(s2.attempts.size, 200);
    await s2.close();
  } finally { await db.cleanup(); }
});

test('nhật ký sự kiện chỉ giữ đuôi trong bộ nhớ, DB giữ đủ; khởi động lại nạp đuôi và đánh số tiếp không trùng', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const s1 = await db.open();
    for (let i = 0; i < 2600; i++) s1.addEvent({ at: i, outcome: 'x', i });
    await s1.persist();
    assert.ok(s1.events.length <= 2000, `bộ nhớ giữ ${s1.events.length}`);
    const count = async (s) => Number((await s.client.query('SELECT count(*) AS c FROM events')).rows[0].c);
    assert.equal(await count(s1), 2600);
    s1.addEvent({ at: 9999, outcome: 'y' });
    await s1.persist();
    assert.equal(await count(s1), 2601);
    await s1.close();

    const s2 = await db.open();
    assert.ok(s2.events.length <= 1000);
    assert.equal(s2.events[s2.events.length - 1].at, 9999, 'đuôi là các sự kiện mới nhất');
    s2.addEvent({ at: 10000, outcome: 'z' });
    await s2.persist(); // không đụng khóa chính
    assert.equal(await count(s2), 2602);
    await s2.close();
  } finally { await db.cleanup(); }
});

test('nhật ký gọi cổng: ghi theo lô, truy vấn theo cổng và mã, giữ đuôi', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const store = await db.open();
    for (let i = 0; i < 30; i++) store.addCall({ at: i, gateway: i % 2 ? 'a' : 'b', method: 'query', ref: `R${i % 3}`, ms: 1, outcome: 'ok' });
    await store.persist();
    assert.equal((await store.listCalls({ gateway: 'a' })).length, 15);
    assert.equal((await store.listCalls({ ref: 'R0' })).length, 10);
    assert.equal((await store.listCalls({ limit: 5 }))[0].at, 29, 'mới nhất trước');
    assert.equal(store._callsPending.length, 0);
    await store.close();
  } finally { await db.cleanup(); }
});

// ---------- cấu hình ----------

test('kiểm tra cấu hình routing khi nạp: rỗng, trùng, thiếu adapter, khoảng tiền ngược, không cổng bật, đối soát cho cổng lạ', () => {
  const a = createFakeAdapter('a');
  const make = (config) => () => new PaymentHub({ adapters: { a }, config });
  assert.throws(make({ gateways: [] }), /rỗng/);
  assert.throws(make({ gateways: [{ id: 'a' }, { id: 'a' }] }), /trùng/);
  assert.throws(make({ gateways: [{ id: 'a' }, { id: 'zz' }] }), /không có adapter/);
  assert.throws(make({ gateways: [{ id: 'a', minAmount: 10, maxAmount: 5 }] }), /minAmount/);
  assert.throws(make({ gateways: [{ id: 'a', enabled: false }] }), /không có cổng nào/);
  assert.throws(make({ gateways: [{ id: 'a' }], reconcile: { perGateway: { zz: {} } } }), /không tồn tại/);
  assert.doesNotThrow(make({ gateways: [{ id: 'a' }, { id: 'zz', enabled: false }] }));
});

test('lịch đối soát theo cổng: cổng a hỏi sớm hơn và dày hơn cổng b', async () => {
  const { hub, clock } = mk({ reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120], perGateway: { a: { firstAfterSeconds: 5, backoffSeconds: [10] } } } });
  const ra = await hub.createPayment(order({ orderId: 'A' }));
  assert.equal(ra.attempt.gateway, 'a');
  assert.equal(ra.attempt.nextCheckAt, clock.now() + 5000);
  clock.advance(5);
  await hub.reconcile();
  assert.equal(hub.store.getAttempt(ra.attempt.id).nextCheckAt, clock.now() + 10000);
  const rb = await hub.createPayment(order({ orderId: 'B', amount: 5 }));
  // cổng b chỉ khi a loại: kiểm tra mặc định bằng _rc
  assert.equal(hub._rc('b').firstAfterSeconds, 60);
  assert.deepEqual(hub._rc('a').backoffSeconds, [10]);
  assert.ok(rb);
});

test('đối soát chạy song song có giới hạn (không tuần tự, không vượt concurrency)', async () => {
  const { hub, a, clock } = mk({ reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], concurrency: 4 } });
  for (let i = 0; i < 12; i++) await hub.createPayment(order({ orderId: `P${i}` }));
  let cur = 0; let max = 0;
  const q = a.query;
  a.query = async (x) => { cur += 1; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 10)); cur -= 1; return q(x); };
  clock.advance(61);
  const r = await hub.reconcile();
  assert.equal(r.queried, 12);
  assert.equal(max, 4);
});

test('lịch hoàn tiền dài hơn lịch giao dịch và tách riêng', async () => {
  const { hub, a, clock } = mk({ reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], refundBackoffSeconds: [100, 5000] } });
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, 'a', attempt);
  a.queryRefundStatus = 'processing';
  const r = await hub.refund({ attemptId: attempt.id });
  assert.equal(r.status, 'PROCESSING');
  clock.advance(61);
  await hub.reconcile();
  assert.equal(r.nextCheckAt, clock.now() + 5000 * 1000);
  assert.equal(r.checks, 1);
});

test('trần hoàn tiền: số lần mỗi attempt và tuổi tối đa của giao dịch gốc', async () => {
  const { hub, clock } = mk({ refund: { maxPerAttempt: 2, maxAgeDays: 30 } });
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, 'a', attempt);
  await hub.refund({ attemptId: attempt.id, amount: 1000 });
  await hub.refund({ attemptId: attempt.id, amount: 1000 });
  await assert.rejects(hub.refund({ attemptId: attempt.id, amount: 1000 }), { code: 'refund_limit' });
  const second = mk({ refund: { maxPerAttempt: 10, maxAgeDays: 30 } });
  const r2 = await second.hub.createPayment(order());
  await ipn(second.hub, 'a', r2.attempt);
  second.clock.advance(31 * 86400);
  await assert.rejects(second.hub.refund({ attemptId: r2.attempt.id }), { code: 'refund_limit' });
  assert.ok(clock);
});

test('refund FAILED không tính vào trần số lần', async () => {
  const { hub, a } = mk({ refund: { maxPerAttempt: 1 } });
  const { attempt } = await hub.createPayment(order());
  await ipn(hub, 'a', attempt);
  a.refundStatus = 'failed';
  const r1 = await hub.refund({ attemptId: attempt.id, amount: 1000 });
  assert.equal(r1.status, 'FAILED');
  a.refundStatus = 'processing';
  const r2 = await hub.refund({ attemptId: attempt.id, amount: 1000 });
  assert.equal(r2.status, 'PROCESSING');
});

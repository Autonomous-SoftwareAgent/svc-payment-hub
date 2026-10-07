'use strict';
// spec: PHUB-S-018
// Mở rộng hợp đồng adapter (PHUB-D-018, P2-P7): state, instructions tùy chọn transferContent, receipts, reversed,
// nhiều mục cùng cổng khác adapterProduct, retryLater. Mọi thay đổi tương thích ngược với adapter cũ.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { MemoryStore } = require('../../src/store');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

function setup(opts = {}) {
  const clock = createClock();
  const adapters = opts.adapters || { a: createFakeAdapter('a', { caps: opts.caps, withFeed: false }) };
  let n = 0;
  const hub = new PaymentHub({
    adapters, clock, store: opts.store, newRef: (p) => `${p}${++n}`,
    config: { gateways: opts.gateways || [{ id: 'a', priority: 1 }], reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 86400 }, ...(opts.config || {}) },
  });
  return { hub, a: adapters.a, adapters, clock };
}
const order = (o = {}) => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/r', ...o });
const cb = (hub, gw, body) => hub.handleCallback(gw, { channel: 'ipn', body, headers: {} });

// ---------- P2: state ----------

test('P2: state do adapter trả khi tạo được lưu trên attempt và trả lại cho query, refund, queryRefund, cancel', async () => {
  const { hub, a, clock } = setup({ caps: { cancellable: true } });
  a.createState = { orderId: 'ORD-9', vas: ['VA1', 'VA2'] };
  const { attempt } = await hub.createPayment(order());
  assert.deepEqual(attempt.state, { orderId: 'ORD-9', vas: ['VA1', 'VA2'] });
  clock.advance(61);
  await hub.reconcile();
  assert.deepEqual(a.calls.query[0].state, { orderId: 'ORD-9', vas: ['VA1', 'VA2'] }, 'đối soát truyền state');

  await cb(hub, 'a', { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
  const r = await hub.refund({ attemptId: attempt.id, amount: 1000 });
  assert.deepEqual(a.calls.refund[0].state, { orderId: 'ORD-9', vas: ['VA1', 'VA2'] });
  a.refundStatus = 'processing';
  clock.advance(61);
  await hub.reconcile();
  assert.deepEqual(a.calls.queryRefund[0].state, { orderId: 'ORD-9', vas: ['VA1', 'VA2'] });
  assert.ok(r.id);

  const t2 = setup({ caps: { cancellable: true } });
  t2.a.createState = { orderId: 'ORD-10' };
  const p2 = await t2.hub.createPayment(order());
  await t2.hub.createAttempt(p2.payment.id, { cancelLive: true, reason: 'customer_retry' });
  assert.deepEqual(t2.a.calls.cancel[0].state, { orderId: 'ORD-10' }, 'hủy khi tạo attempt mới truyền state');
});

test('P2: không có state thì tham số state vắng (adapter cũ không bị ảnh hưởng); state không phải đối tượng hoặc quá 2 KB thì kết quả tạo thành unknown, attempt vẫn được giữ', async () => {
  const t = setup();
  const { attempt } = await t.hub.createPayment(order());
  assert.equal('state' in attempt, false);
  await t.hub.reconcile();

  for (const [name, state] of [['mảng', [1, 2]], ['chuỗi', 'x'], ['quá lớn', { blob: 'x'.repeat(3000) }], ['null', null]]) {
    const t2 = setup();
    t2.a.createState = state;
    const r = await t2.hub.createPayment(order({ orderId: `O-${name}` }));
    assert.equal(r.attempt.status, 'UNKNOWN', `state ${name}`);
    assert.equal('state' in r.attempt, false, 'không lưu state hỏng');
    assert.ok(t2.hub.store.events.some((e) => e.outcome === 'bad_create_result'), `ghi sự kiện bad_create_result (${name})`);
  }
});

test('P2: state không lộ ra API cửa hàng (view của attempt không có state)', async () => {
  const { createApp } = require('../../src/app/app');
  const t = setup();
  t.a.createState = { secretish: 'x' };
  const app = createApp({ hub: t.hub, checkOutput: true });
  const r = await app.execute('createPayment', { orderId: 'O1', amount: 1000, returnUrl: 'u' }, { role: 'admin' });
  assert.equal(JSON.stringify(r).includes('secretish'), false);
});

// ---------- P3: instructions ----------

test('P3: instructions không cần transferContent; thiếu bank/accountNumber/amount nguyên thì thành unknown + bad_create_result', async () => {
  const t = setup();
  t.a.createMode = 'instructions';
  const orig = t.a.createPayment;
  t.a.createPayment = async (p) => { const r = await orig(p); delete r.instructions.transferContent; return r; };
  const ok = await t.hub.createPayment(order());
  assert.equal(ok.attempt.status, 'AWAITING');
  assert.equal(ok.attempt.instructions.transferContent, undefined);

  const bad = setup();
  bad.a.createMode = 'bad_instructions';
  const r = await bad.hub.createPayment(order());
  assert.equal(r.attempt.status, 'UNKNOWN');
  assert.ok(bad.hub.store.events.some((e) => e.outcome === 'bad_create_result' && /accountNumber/.test(e.detail)));
});

// ---------- P4: receipts ----------

test('P4: refund nhận receipts: kiểu received là toàn bộ các khoản; kiểu succeeded là một khoản; anomaly giữ tiền là khoản của anomaly', async () => {
  const t = setup();
  const { attempt } = await t.hub.createPayment(order({ amount: 100000 }));
  await cb(t.hub, 'a', { ref: attempt.ref, type: 'received', amount: 60000, txn: 'R1' });
  await cb(t.hub, 'a', { ref: attempt.ref, type: 'received', amount: 50000, txn: 'R2' });
  await t.hub.refund({ attemptId: attempt.id, amount: 5000 });
  const rc = t.a.calls.refund[0].receipts;
  assert.deepEqual(rc.map((x) => [x.txn, x.amount]), [['R1', 60000], ['R2', 50000]]);

  const s = setup();
  const p = await s.hub.createPayment(order());
  await cb(s.hub, 'a', { ref: p.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
  await s.hub.refund({ attemptId: p.attempt.id, amount: 1000 });
  assert.deepEqual(s.a.calls.refund[0].receipts, [{ txn: 'T1', amount: 100000 }]);

  const h = setup();
  const q = await h.hub.createPayment(order());
  await cb(h.hub, 'a', { ref: q.attempt.ref, type: 'failed', amount: 100000, txn: 'F1' });
  await cb(h.hub, 'a', { ref: q.attempt.ref, type: 'succeeded', amount: 100000, txn: 'LATE1' });
  // hoàn khoản tiền về muộn chỉ khi cổng xác nhận tiền đã về (PHUB-D-038)
  h.a.queryResults.set(q.attempt.ref, { gateway: 'a', attemptRef: q.attempt.ref, type: 'succeeded', amount: 100000, gatewayTxnId: 'LATE1', occurredAt: 0, source: 'query' });
  await h.hub.refund({ attemptId: q.attempt.id, amount: 100000 });
  assert.deepEqual(h.a.calls.refund[0].receipts, [{ txn: 'LATE1', amount: 100000 }], 'tiền về muộn: khoản của anomaly');
});

// ---------- P5: reversed ----------

test('P5: reversed không đổi trạng thái payment/attempt; ghi anomaly funds_reversed, đánh dấu cần người, phát anomaly.opened; trùng không nhân đôi; đảo từng phần là sự kiện khác nhau', async () => {
  const emitted = [];
  const t = setup();
  const realEmit = t.hub.events.emit.bind(t.hub.events);
  t.hub.events.emit = (...args) => { emitted.push(args[0]); return realEmit(...args); };
  const { payment, attempt } = await t.hub.createPayment(order());
  await cb(t.hub, 'a', { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
  assert.equal(t.hub.store.getPayment(payment.id).status, 'PAID');

  const r1 = await cb(t.hub, 'a', { ref: attempt.ref, type: 'reversed', amount: 30000, txn: 'T1' });
  assert.equal(r1.outcome, 'ok');
  assert.equal(t.hub.store.getPayment(payment.id).status, 'PAID', 'không tự đổi payment');
  const att = t.hub.store.getAttempt(attempt.id);
  assert.equal(att.status, 'SUCCEEDED', 'không tự đổi attempt');
  assert.equal(att.needsOperator, true);
  assert.equal(att.reversedTotal, 30000);
  const open = t.hub.store.anomaliesOfAttempt(attempt.id).filter((x) => x.type === 'funds_reversed');
  assert.equal(open.length, 1);
  assert.equal(open[0].amount, 30000);
  assert.equal(open[0].gatewayTxnId, 'T1');
  assert.ok(emitted.includes('anomaly.opened'));

  const dup = await cb(t.hub, 'a', { ref: attempt.ref, type: 'reversed', amount: 30000, txn: 'T1' });
  assert.equal(dup.outcome, 'duplicate');
  assert.equal(t.hub.store.getAttempt(attempt.id).reversedTotal, 30000, 'sự kiện trùng không cộng lần hai');
  await cb(t.hub, 'a', { ref: attempt.ref, type: 'reversed', amount: 20000, txn: 'T1' }); // đảo thêm một phần khác của cùng khoản gốc
  assert.equal(t.hub.store.getAttempt(attempt.id).reversedTotal, 50000);
});

test('P5: sau khi bị đảo, hoàn tiền chỉ tính phần còn lại; đảo hết thì không hoàn được nữa', async () => {
  const t = setup();
  const { attempt } = await t.hub.createPayment(order({ amount: 100000 }));
  await cb(t.hub, 'a', { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
  await cb(t.hub, 'a', { ref: attempt.ref, type: 'reversed', amount: 70000, txn: 'T1' });
  await assert.rejects(t.hub.refund({ attemptId: attempt.id, amount: 40000 }), { code: 'invalid_refund_amount' }, 'chỉ còn 30000 hoàn được');
  const ok = await t.hub.refund({ attemptId: attempt.id, amount: 30000 });
  assert.equal(ok.amount, 30000);
  assert.equal(t.a.calls.refund[0].originalAmount, 30000);

  const full = setup();
  const p = await full.hub.createPayment(order({ amount: 50000 }));
  await cb(full.hub, 'a', { ref: p.attempt.ref, type: 'succeeded', amount: 50000, txn: 'T2' });
  await cb(full.hub, 'a', { ref: p.attempt.ref, type: 'reversed', amount: 50000, txn: 'T2' });
  await assert.rejects(full.hub.refund({ attemptId: p.attempt.id }), { code: 'nothing_to_refund' });
});

test('P5: funds_reversed chỉ xử lý bằng ignore (ghi chú); refund/apply bị từ chối; reversed cũng đi được từ kênh query', async () => {
  const t = setup();
  const { attempt } = await t.hub.createPayment(order());
  await cb(t.hub, 'a', { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
  await cb(t.hub, 'a', { ref: attempt.ref, type: 'reversed', amount: 100000, txn: 'T1' });
  const an = t.hub.store.anomaliesOfAttempt(attempt.id).find((x) => x.type === 'funds_reversed');
  await assert.rejects(t.hub.resolveAnomaly(an.id, { action: 'refund', force: true }), { code: 'invalid_state' });
  await assert.rejects(t.hub.resolveAnomaly(an.id, { action: 'apply' }), { code: 'invalid_state' });
  const done = await t.hub.resolveAnomaly(an.id, { action: 'ignore', note: 'đã đối chiếu sao kê, đơn đã hủy' });
  assert.equal(done.status, 'ignored');

  // qua đối soát (source=query): query trả reversed
  const q = setup();
  const p = await q.hub.createPayment(order());
  await cb(q.hub, 'a', { ref: p.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T9' });
  q.a.queryResults.set(p.attempt.ref, [{ gateway: 'a', attemptRef: p.attempt.ref, type: 'reversed', amount: 100000, gatewayTxnId: 'T9', occurredAt: 1, source: 'query' }]);
  const store = q.hub.store;
  q.hub._applyEvent(store.getAttempt(p.attempt.id), { ...q.a.queryResults.get(p.attempt.ref)[0] });
  assert.equal(store.getAttempt(p.attempt.id).reversedTotal, 100000);
});

// ---------- P6: nhiều mục cùng id ----------

function twoSepay() {
  const a = createFakeAdapter('sepay');
  const seen = [];
  const create = a.createPayment;
  a.createPayment = async (p) => { seen.push(p.product); if (a.rejectProduct === p.product) return { status: 'rejected', reason: 'p_rejected' }; return create(p); };
  return { a, seen };
}
const GW2 = [{ id: 'sepay', adapterProduct: 'va-order', priority: 1 }, { id: 'sepay', adapterProduct: 'gateway', priority: 2 }];

test('P6: hai mục cùng id khác adapterProduct: B chính, C dự phòng; payment product "default" dùng product của mục', async () => {
  const { a, seen } = twoSepay();
  const t = setup({ adapters: { sepay: a }, gateways: GW2 });
  const { attempt } = await t.hub.createPayment(order());
  assert.equal(attempt.product, 'va-order');
  assert.deepEqual(seen, ['va-order']);
});

test('P6: B từ chối thì thử C ngay trong lần tạo (cùng adapter); failover sau khi B hỏng loại đúng mục B chứ không loại cả cổng', async () => {
  const { a, seen } = twoSepay();
  a.rejectProduct = 'va-order';
  const t = setup({ adapters: { sepay: a }, gateways: GW2 });
  const first = await t.hub.createPayment(order());
  assert.equal(first.attempt.product, 'gateway');
  assert.deepEqual(seen, ['va-order', 'gateway']);

  // attempt B thành công tạo rồi hỏng: failover sang C, không bị loại vì cùng id
  const b = twoSepay();
  const t2 = setup({ adapters: { sepay: b.a }, gateways: GW2 });
  const p = await t2.hub.createPayment(order({ orderId: 'O2' }));
  assert.equal(p.attempt.product, 'va-order');
  await cb(t2.hub, 'sepay', { ref: p.attempt.ref, type: 'failed', amount: 100000, txn: 'F1' });
  const next = await t2.hub.createAttempt(p.payment.id, { reason: 'failover' });
  assert.equal(next.attempt.product, 'gateway', 'failover sang mục C của cùng adapter');
  await cb(t2.hub, 'sepay', { ref: next.attempt.ref, type: 'failed', amount: 100000, txn: 'F2' });
  const third = await t2.hub.createAttempt(p.payment.id, { reason: 'failover' });
  assert.ok(['va-order', 'gateway'].includes(third.attempt.product), 'hết mục mới thì dùng lại như hành vi cũ');
});

test('P6: payment đòi product cụ thể chỉ dùng mục khớp adapterProduct; mục không khai adapterProduct vẫn hoạt động như cũ', async () => {
  const { a } = twoSepay();
  const t = setup({ adapters: { sepay: a }, gateways: GW2 });
  const r = await t.hub.createPayment(order({ product: 'gateway' }));
  assert.equal(r.attempt.product, 'gateway');
  await assert.rejects(t.hub.createPayment(order({ orderId: 'O3', product: 'khong-co' })), { code: 'no_gateway_available' });

  const legacy = setup({ gateways: [{ id: 'a', priority: 1 }] });
  const p = await legacy.hub.createPayment(order({ product: 'x' }));
  assert.equal(p.attempt.product, 'x');
});

test('P6: cấu hình routing sai: cùng id không khai adapterProduct, trùng id/adapterProduct', () => {
  const a = createFakeAdapter('sepay');
  assert.throws(() => setup({ adapters: { sepay: a }, gateways: [{ id: 'sepay' }, { id: 'sepay', adapterProduct: 'gateway' }] }), /nhiều mục cùng id phải khai adapterProduct/);
  assert.throws(() => setup({ adapters: { sepay: a }, gateways: [{ id: 'sepay' }, { id: 'sepay' }] }), /trùng cổng sepay/);
  assert.throws(() => setup({ adapters: { sepay: a }, gateways: [{ id: 'sepay', adapterProduct: 'va-order' }, { id: 'sepay', adapterProduct: 'va-order', priority: 2 }] }), /trùng cổng sepay\/va-order/);
  assert.doesNotThrow(() => setup({ adapters: { sepay: a }, gateways: GW2 }));
});

// ---------- P7: retryLater ----------

test('P7: retryLater không đổi gì, ghi retry_later, trả ack error của adapter (cổng gửi lại), đếm metric; callback hợp lệ sau đó vẫn xử lý bình thường', async () => {
  const t = setup();
  const { attempt, payment } = await t.hub.createPayment(order());
  const r = await cb(t.hub, 'a', { retryLater: true });
  assert.equal(r.outcome, 'retry_later');
  assert.equal(r.ack.status, 503);
  assert.equal(t.hub.store.getAttempt(attempt.id).status, 'AWAITING');
  assert.ok(t.hub.store.events.some((e) => e.outcome === 'retry_later'));
  assert.match(t.hub.metrics.render(), /hub_callbacks_total\{[^}]*outcome="retry_later"[^}]*\} 1/);
  const ok = await cb(t.hub, 'a', { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
  assert.equal(ok.outcome, 'ok');
  assert.equal(t.hub.store.getPayment(payment.id).status, 'PAID');
});

// ---------- bền vững ----------

test('bền vững: state, reversedTotal và anomaly funds_reversed sống qua khởi động lại; refund sau khởi động vẫn nhận state và receipts', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const s1 = await db.open();
    const t1 = setup({ store: s1 });
    t1.a.createState = { orderId: 'ORD-7' };
    const { attempt } = await t1.hub.createPayment(order());
    await cb(t1.hub, 'a', { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' });
    await cb(t1.hub, 'a', { ref: attempt.ref, type: 'reversed', amount: 20000, txn: 'T1' });
    await s1.close();

    const s2 = await db.open();
    const t2 = setup({ store: s2 });
    await s2.hydrateAttempt(attempt.id);
    const loaded = s2.getAttempt(attempt.id);
    assert.deepEqual(loaded.state, { orderId: 'ORD-7' });
    assert.equal(loaded.reversedTotal, 20000);
    await t2.hub.refund({ attemptId: attempt.id, amount: 10000 });
    assert.deepEqual(t2.a.calls.refund[0].state, { orderId: 'ORD-7' });
    assert.deepEqual(t2.a.calls.refund[0].receipts, [{ txn: 'T1', amount: 100000 }]);
    assert.equal((await s2.findAnomalies({ type: 'funds_reversed' })).length, 1);
    await s2.close();
  } finally { await db.cleanup(); }
});

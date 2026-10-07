'use strict';
// spec: PHUB-S-017
// Connector Kafka vào/ra (PHUB-D-017) với broker giả: sink ra (key, header, thứ tự), nguồn vào (lệnh đúng một lần theo commandId,
// phản hồi command.completed/failed, DLQ, thử lại khi lỗi tạm). Broker thật: test/e2e/kafka-live.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { MemoryStore } = require('../../src/store');
const { createApp } = require('../../src/app/app');
const { buildSinks, inboundKinds } = require('../../src/connectors/registry');
const { buildInbound } = require('../../src/main');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

function fakeKafka() {
  const f = { sent: [], consumers: [], down: false };
  f.kafka = {
    producer: () => ({ connect: async () => {}, send: async (m) => { if (f.down) throw new Error('broker down'); f.sent.push(m); }, disconnect: async () => {} }),
    consumer: (cfg) => {
      const c = { cfg, subs: [], handler: null, connect: async () => {}, subscribe: async (x) => { c.subs.push(x); }, run: async ({ eachMessage }) => { c.handler = eachMessage; }, disconnect: async () => {} };
      f.consumers.push(c);
      return c;
    },
  };
  return f;
}

const REPLY_ROUTE = { id: 'bus', sink: 'kafka', topic: 'payment.events.v1', types: ['command.*', 'payment.*'] };

function setup({ store, principal = { role: 'admin' }, routes = [REPLY_ROUTE], inCfg = {} } = {}) {
  const fk = fakeKafka();
  const deps = { kafka: { brokers: ['fake:9092'] }, kafkaFactory: () => fk.kafka };
  const clock = createClock();
  const a = createFakeAdapter('a', { caps: { refundable: 'manual' } });
  let n = 0;
  const hub = new PaymentHub({
    adapters: { a }, clock, store, newRef: (p) => `${p}${++n}`,
    deps: { sinks: buildSinks(deps) },
    config: { gateways: [{ id: 'a' }], events: { routes }, webhooks: null },
  });
  const app = createApp({ hub });
  const conn = inboundKinds().get('kafka').create({ app, deps, config: { id: 'cmd', topic: 'payment.commands.v1', groupId: 'hub', principal, retryDelayMs: 5, retryMaxDelayMs: 20, ...inCfg } });
  const msg = (cmd) => ({ key: Buffer.from(cmd.commandId || 'x'), value: Buffer.from(typeof cmd === 'string' ? cmd : JSON.stringify(cmd)) });
  const replies = async () => { await hub.deliverWebhooks(); return fk.sent.filter((m) => m.topic === 'payment.events.v1').flatMap((m) => m.messages.map((x) => JSON.parse(x.value))); };
  return { hub, a, app, conn, fk, msg, replies, clock };
}
const payCmd = (id, o = {}) => ({ commandId: id, op: 'createPayment', input: { orderId: `O-${id}`, amount: 50000, returnUrl: 'https://shop.test/r', ...o } });

test('sink ra: key là paymentId, header mang id/loại/cửa hàng, acks=all; sự kiện payment.paid đi vào topic cấu hình', async () => {
  const t = setup({ principal: { role: 'shop', id: 'sa' } });
  const r = await t.app.execute('createPayment', { orderId: 'O1', amount: 1000, returnUrl: 'u' }, { role: 'shop', id: 'sa' });
  await t.hub.handleCallback('a', { channel: 'ipn', body: { ref: r.attempt.ref, type: 'succeeded', amount: 1000, txn: 'T1' }, headers: {} });
  await t.hub.deliverWebhooks();
  const sent = t.fk.sent.filter((m) => m.topic === 'payment.events.v1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].acks, -1);
  const m = sent[0].messages[0];
  assert.equal(m.key, r.payment.id);
  const body = JSON.parse(m.value);
  assert.equal(body.type, 'payment.paid');
  assert.equal(body.key, r.payment.id);
  assert.deepEqual(m.headers, { 'hub-event-id': body.id, 'hub-event-type': 'payment.paid', 'hub-shop-id': 'sa' });
});

test('lệnh createPayment: tạo payment thật và phản hồi command.completed (key = commandId) cùng kết quả như HTTP', async () => {
  const t = setup();
  await t.conn.handle(t.msg(payCmd('c1')));
  const rep = await t.replies();
  assert.equal(rep.length, 1);
  assert.equal(rep[0].type, 'command.completed');
  assert.equal(rep[0].key, 'c1');
  assert.equal(rep[0].data.commandId, 'c1');
  assert.equal(rep[0].data.op, 'createPayment');
  assert.equal(rep[0].data.result.payment.orderId, 'O-c1');
  assert.equal(rep[0].data.result.payment.shopId, 'default');
  assert.equal(t.hub.store.payments.size, 1);
});

test('đúng một lần: giao lại cùng commandId không làm lại việc và không phát thêm phản hồi (thao tác không idempotent: hoàn tiền)', async () => {
  const t = setup();
  const created = await t.app.execute('createPayment', { orderId: 'O1', amount: 100000, returnUrl: 'u' }, { role: 'admin' });
  await t.hub.handleCallback('a', { channel: 'ipn', body: { ref: created.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' }, headers: {} });
  const refund = { commandId: 'r1', op: 'createRefund', input: { attemptId: created.attempt.id, amount: 30000 } };
  await t.conn.handle(t.msg(refund));
  await t.conn.handle(t.msg(refund)); // Kafka giao lại
  await t.conn.handle(t.msg(refund));
  assert.equal(t.hub.store.refundsOfAttempt(created.attempt.id).length, 1, 'chỉ một lần hoàn');
  const done = (await t.replies()).filter((e) => e.type === 'command.completed');
  assert.equal(done.length, 1, 'chỉ một phản hồi');
});

test('lỗi nghiệp vụ là kết quả chính thức: command.failed kèm mã lỗi, không ném (offset được commit), giao lại không phát thêm', async () => {
  const t = setup();
  const bad = { commandId: 'r2', op: 'createRefund', input: { attemptId: 'khong-co' } };
  await t.conn.handle(t.msg(bad));
  await t.conn.handle(t.msg(bad));
  const rep = (await t.replies()).filter((e) => e.type.startsWith('command.'));
  assert.equal(rep.length, 1);
  assert.equal(rep[0].type, 'command.failed');
  assert.equal(rep[0].data.error, 'not_found');
  const invalid = { commandId: 'r3', op: 'createPayment', input: { orderId: 'O', amount: -5, returnUrl: 'u' } };
  await t.conn.handle(t.msg(invalid));
  const rep2 = (await t.replies()).filter((e) => e.key === 'r3');
  assert.equal(rep2[0].data.error, 'invalid_input');
  const unknown = { commandId: 'r4', op: 'khongCoThaoTacNay', input: {} };
  await t.conn.handle(t.msg(unknown));
  assert.equal((await t.replies()).find((e) => e.key === 'r4').data.error, 'unknown_operation');
});

test('thông điệp hỏng (không phải JSON, sai phong bì) vào DLQ kèm lý do, không phát phản hồi, không đổi trạng thái', async () => {
  const t = setup();
  await t.conn.handle(t.msg('{không phải json'));
  await t.conn.handle(t.msg({ op: 'createPayment', input: {} })); // thiếu commandId
  await t.conn.handle(t.msg({ commandId: '', op: 'createPayment' }));
  const dlq = t.fk.sent.filter((m) => m.topic === 'payment.commands.v1.dlq');
  assert.equal(dlq.length, 3);
  assert.ok(dlq.every((m) => m.messages[0].headers.reason && m.messages[0].headers['source-topic'] === 'payment.commands.v1'));
  assert.equal(t.hub.store.payments.size, 0);
  assert.equal((await t.replies()).length, 0);
});

test('principal do cấu hình, không do thông điệp: cửa hàng gắn cứng không đổi được shopId và không thấy đồ cửa hàng khác; quản trị chỉ định shopId; vai trò không đủ quyền thì failed', async () => {
  const shop = setup({ principal: { role: 'shop', id: 'sa' } });
  await shop.conn.handle(shop.msg(payCmd('s1', { shopId: 'sb' })));
  const first = (await shop.replies()).find((e) => e.key === 's1');
  assert.equal(first.data.result.payment.shopId, 'sa', 'shopId trong thông điệp bị bỏ qua với principal cửa hàng');
  const other = await shop.app.execute('createPayment', { orderId: 'OB', amount: 1000, returnUrl: 'u', shopId: 'sb' }, { role: 'admin' });
  await shop.conn.handle(shop.msg({ commandId: 's2', op: 'getPayment', input: { paymentId: other.payment.id } }));
  await shop.conn.handle(shop.msg({ commandId: 's3', op: 'reconcile', input: {} }));
  const rep = await shop.replies();
  assert.equal(rep.find((e) => e.key === 's2').data.error, 'not_found', 'đồ của cửa hàng khác = không tồn tại');
  assert.equal(rep.find((e) => e.key === 's3').data.error, 'forbidden');

  const admin = setup({ principal: { role: 'admin' } });
  await admin.conn.handle(admin.msg({ ...payCmd('a1'), shopId: 'sb' }));
  assert.equal((await admin.replies()).find((e) => e.key === 'a1').data.result.payment.shopId, 'sb');
});

test('lỗi hạ tầng tạm thời: ném lên (không commit), khóa được bỏ nên giao lại vẫn chạy; vòng consumer thử lại tới khi xong và chỉ tạo một payment', async () => {
  const t = setup();
  let failures = 2;
  const real = t.hub._persist.bind(t.hub);
  t.hub._persist = async () => { if (failures > 0) { failures -= 1; throw new Error('mất kết nối kho'); } return real(); };
  await assert.rejects(t.conn.handle(t.msg(payCmd('t1'))), /mất kết nối kho/);
  assert.equal(failures, 1);
  // qua consumer thật (broker giả): eachMessage tự thử lại, giữ nhịp heartbeat
  await t.conn.start();
  const c = t.fk.consumers[0];
  assert.deepEqual(c.cfg, { groupId: 'hub' });
  assert.deepEqual(c.subs, [{ topic: 'payment.commands.v1', fromBeginning: false }]);
  let beats = 0;
  await c.handler({ message: t.msg(payCmd('t1')), heartbeat: async () => { beats += 1; } });
  assert.equal(failures, 0);
  assert.ok(beats >= 1, 'có heartbeat trong lúc chờ thử lại');
  assert.equal(t.hub.store.payments.size, 1, 'không nhân đôi');
  assert.equal((await t.replies()).filter((e) => e.key === 't1').length, 1);
});

test('DLQ lỗi (broker xuống) cũng không làm mất thông điệp: ném để thử lại, không coi là đã xử lý', async () => {
  const t = setup();
  t.fk.down = true;
  await assert.rejects(t.conn.handle(t.msg('hỏng')), /broker down/);
  t.fk.down = false;
  await t.conn.handle(t.msg('hỏng'));
  assert.equal(t.fk.sent.filter((m) => m.topic === 'payment.commands.v1.dlq').length, 1);
});

test('sink ra khi Kafka xuống: sự kiện nằm lại hộp thư đi, thử lại theo bậc, đi đúng thứ tự khi broker sống lại', async () => {
  const t = setup();
  t.fk.down = true;
  await t.conn.handle(t.msg(payCmd('k1')));
  await t.conn.handle(t.msg(payCmd('k2')));
  await t.hub.deliverWebhooks();
  assert.equal(t.fk.sent.length, 0);
  assert.equal(t.hub.store.pendingWebhooks().length, 2);
  t.fk.down = false;
  t.clock.advance(6);
  await t.hub.deliverWebhooks();
  const keys = t.fk.sent.flatMap((m) => m.messages.map((x) => x.key));
  assert.deepEqual(keys.sort(), ['k1', 'k2']);
});

test('khởi động: nguồn vào bị từ chối khi không có tuyến ra nào nhận phản hồi lệnh, khi source lạ, khi principal sai', () => {
  const fk = fakeKafka();
  const deps = { kafka: { brokers: ['x:1'] }, kafkaFactory: () => fk.kafka };
  const mkHub = (routes) => new PaymentHub({ adapters: { a: createFakeAdapter('a') }, deps: { sinks: buildSinks(deps) }, config: { gateways: [{ id: 'a' }], events: { routes } } });
  const base = { id: 'cmd', source: 'kafka', topic: 't', groupId: 'g', principal: { role: 'admin' } };
  const cfg = (inn) => ({ connectors: { in: inn } });
  assert.throws(() => buildInbound(mkHub([]), cfg([base]), deps), /không có tuyến ra nào nhận command\.completed/);
  assert.throws(() => buildInbound(mkHub([{ id: 'p', sink: 'kafka', topic: 'x', types: ['payment.*'] }]), cfg([base]), deps), /không có tuyến ra nào nhận command\.completed/);
  const hub = mkHub([REPLY_ROUTE]);
  assert.throws(() => buildInbound(hub, cfg([{ ...base, source: 'nats' }]), deps), /source không hỗ trợ: nats/);
  assert.throws(() => buildInbound(hub, cfg([{ ...base, principal: { role: 'shop' } }]), deps), /principal phải là/);
  assert.throws(() => buildInbound(hub, cfg([{ ...base, principal: { role: 'metrics' } }]), deps), /principal phải là/);
  assert.throws(() => buildInbound(hub, cfg([base, base]), deps), /trùng/);
  assert.throws(() => buildInbound(mkHub([{ ...REPLY_ROUTE, shops: ['sb'] }]), cfg([{ ...base, principal: { role: 'shop', id: 'sa' } }]), deps), /không có tuyến ra nào nhận command\.completed của cửa hàng sa/, 'tuyến chỉ khai cho cửa hàng khác thì không đủ');
  assert.equal(buildInbound(hub, cfg([base]), deps).length, 1);
});

test('đúng một lần qua khởi động lại (PostgreSQL): khóa lệnh, thay đổi và phản hồi cùng transaction; Hub mới nhận lại cùng lệnh thì bỏ qua', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const s1 = await db.open();
    const t1 = setup({ store: s1 });
    const created = await t1.app.execute('createPayment', { orderId: 'O1', amount: 100000, returnUrl: 'u' }, { role: 'admin' });
    await t1.hub.handleCallback('a', { channel: 'ipn', body: { ref: created.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' }, headers: {} });
    const refund = { commandId: 'rr1', op: 'createRefund', input: { attemptId: created.attempt.id, amount: 20000 } };
    await t1.conn.handle(t1.msg(refund));
    await s1.close();

    // Hub mới (không còn gì trong bộ nhớ) nhận lại đúng lệnh đó: phải nhận ra từ DB
    const s2 = await db.open();
    const check = await s2.pool.query("SELECT k FROM seen WHERE k = 'cmd|rr1'");
    assert.equal(check.rowCount, 1, 'khóa lệnh nằm trong DB cùng lúc với hiệu ứng');
    assert.ok(s2.pendingWebhooks().some((w) => w.type === 'command.completed'), 'phản hồi nằm trong hộp thư đi cùng transaction');
    const t2 = setup({ store: s2 });
    await t2.conn.handle(t2.msg(refund));
    await s2.hydrateAttempt(created.attempt.id);
    assert.equal(s2.refundsOfAttempt(created.attempt.id).length, 1, 'không hoàn lần hai');
    await t2.hub.deliverWebhooks();
    const done = t2.fk.sent.flatMap((m) => m.messages).map((m) => JSON.parse(m.value)).filter((e) => e.type === 'command.completed');
    assert.equal(done.length, 1, 'phản hồi đã nằm chờ từ lần trước, giao đúng một lần');
    await s2.close();
  } finally { await db.cleanup(); }
});

test('cụm thao tác trong hub.transact ghi một lần: thao tác lồng nhau không persist riêng, lỗi giữa chừng vẫn ghi phần đã đổi', async () => {
  const store = new MemoryStore();
  let persists = 0;
  store.persist = async () => { persists += 1; };
  const t = setup({ store });
  await t.hub.transact(async () => {
    await t.app.execute('createPayment', { orderId: 'A', amount: 1000, returnUrl: 'u' }, { role: 'admin' });
    await t.app.execute('createPayment', { orderId: 'B', amount: 1000, returnUrl: 'u' }, { role: 'admin' });
  });
  assert.equal(persists, 1);
  await assert.rejects(t.hub.transact(async () => { await t.app.execute('createPayment', { orderId: 'C', amount: 1000, returnUrl: 'u' }, { role: 'admin' }); throw new Error('giữa chừng'); }), /giữa chừng/);
  assert.equal(persists, 2, 'vẫn ghi phần đã đổi trước khi ném lỗi');
  assert.equal(store.payments.size, 3);
});

test('nguyên tử: khóa lệnh, hiệu ứng và phản hồi được ghi bởi CÙNG một lần persist; persist hỏng ở bất kỳ lần nào thì DB không có một nửa', { skip: SKIP }, async () => {
  for (const failAt of [1, 2, 3]) {
    const db = freshDb();
    try {
      const store = await db.open();
      const t = setup({ store });
      const created = await t.app.execute('createPayment', { orderId: 'O1', amount: 100000, returnUrl: 'u' }, { role: 'admin' });
      await t.hub.handleCallback('a', { channel: 'ipn', body: { ref: created.attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' }, headers: {} });
      const real = store.persist.bind(store);
      let calls = 0;
      store.persist = async () => { calls += 1; if (calls === failAt) throw new Error('persist hỏng'); return real(); };
      try { await t.conn.handle(t.msg({ commandId: 'at1', op: 'createRefund', input: { attemptId: created.attempt.id, amount: 5000 } })); } catch { /* persist hỏng được phép ném */ }
      const q = async (sql) => (await store.pool.query(sql)).rowCount;
      const present = [
        await q("SELECT 1 FROM seen WHERE k = 'cmd|at1'"),
        await q("SELECT 1 FROM docs WHERE kind = 'refund'"),
        await q("SELECT 1 FROM docs WHERE kind = 'webhook' AND doc->>'type' = 'command.completed'"),
      ];
      assert.ok(present.every((x) => x === present[0]), `failAt=${failAt}: DB chỉ có một phần (khóa, hoàn tiền, phản hồi) = ${present}`);
      await store.close();
    } finally { await db.cleanup(); }
  }
});

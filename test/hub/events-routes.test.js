'use strict';
// spec: PHUB-S-017
// Cổng ra chuẩn nhiều tuyến (PHUB-D-017): mỗi sự kiện một bản giao cho mỗi tuyến khớp, trạng thái riêng từng tuyến,
// thứ tự theo key ở sink ordered, lọc theo loại và cửa hàng, bền vững qua khởi động lại.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { EventOutbox } = require('../../src/events');
const { buildSinks } = require('../../src/connectors/registry');
const { MemoryStore } = require('../../src/store');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

// Sink giả: ghi lại những gì được giao; fail(d, route) quyết định có ném lỗi không.
function fakeSink(kind, { ordered = false, fail = () => false } = {}) {
  const log = [];
  return { kind, ordered, log, fail, validate() {}, async deliver(d, route) { if (this.fail(d, route)) throw new Error('boom'); log.push({ id: d.id, eventId: d.eventId, type: d.type, key: d.key, route: route.id }); return {}; } };
}
const mk = (routes, sinks, extra = {}) => {
  const clock = createClock();
  const store = extra.store || new MemoryStore();
  const ob = new EventOutbox({ store, clock, sinks, metrics: extra.metrics, config: { routes, backoffSeconds: [5, 30], maxAttempts: 3, ...(extra.config || {}) } });
  return { ob, clock, store };
};

test('một sự kiện, hai tuyến: hai bản giao riêng, mã dạng eventId~tuyến, cùng một phong bì (id, type, shopId, key, data)', async () => {
  const bus = fakeSink('bus'); const audit = fakeSink('audit');
  const { ob, store } = mk([{ id: 'bus', sink: 'bus', types: ['payment.*'] }, { id: 'audit', sink: 'audit' }], { bus, audit });
  ob.emit('payment.paid', 'pay_1', 'paid', { paymentId: 'pay_1', amount: 5 }, 'sa');
  ob.emit('anomaly.opened', 'an_1', 'an_1', { anomalyId: 'an_1', type: 'x' }, 'sa');
  assert.equal(store.pendingWebhooks().length, 3, 'paid -> bus + audit, anomaly -> chỉ audit');
  await ob.deliverDue();
  assert.deepEqual(bus.log.map((x) => x.type), ['payment.paid']);
  assert.deepEqual(audit.log.map((x) => x.type).sort(), ['anomaly.opened', 'payment.paid']);
  const paidBus = bus.log[0]; const paidAudit = audit.log.find((x) => x.type === 'payment.paid');
  assert.equal(paidBus.eventId, paidAudit.eventId, 'cùng một sự kiện');
  assert.equal(paidBus.id, `${paidBus.eventId}~bus`);
  assert.equal(paidAudit.id, `${paidAudit.eventId}~audit`);
  const body = JSON.parse((await store.listWebhooks({})).find((w) => w.route === 'bus').body);
  assert.deepEqual(Object.keys(body).sort(), ['createdAt', 'data', 'id', 'key', 'shopId', 'type']);
  assert.equal(body.key, 'pay_1');
  assert.equal(body.shopId, 'sa');
});

test('trạng thái riêng từng tuyến: một đích lỗi không làm đích kia nhận trùng; tuyến lỗi thử lại theo bậc rồi giao', async () => {
  const bus = fakeSink('bus'); const audit = fakeSink('audit');
  let down = true;
  bus.fail = () => down;
  const { ob, clock, store } = mk([{ id: 'bus', sink: 'bus' }, { id: 'audit', sink: 'audit' }], { bus, audit });
  ob.emit('payment.paid', 'pay_1', 'paid', { paymentId: 'pay_1' });
  await ob.deliverDue();
  assert.equal(audit.log.length, 1);
  assert.equal(bus.log.length, 0);
  const all = await store.listWebhooks({});
  assert.deepEqual(all.map((w) => [w.route, w.status]).sort(), [['audit', 'delivered'], ['bus', 'pending']]);
  down = false;
  assert.equal(await ob.deliverDue(), 0, 'chưa đến hạn thử lại');
  clock.advance(5);
  await ob.deliverDue();
  assert.equal(bus.log.length, 1);
  assert.equal(audit.log.length, 1, 'audit không nhận lại');
});

test('lọc theo loại (có ký tự *) và theo cửa hàng; không tuyến nào khớp thì không ghi gì', async () => {
  const a = fakeSink('a');
  const { ob, store } = mk([{ id: 'r1', sink: 'a', types: ['refund.*', 'anomaly.opened'], shops: ['sa'] }], { a });
  ob.emit('payment.paid', 'p1', 'paid', { paymentId: 'p1' }, 'sa');
  ob.emit('refund.updated', 'r1', 'SUCCEEDED', { paymentId: 'p1' }, 'sb');
  assert.equal(store.pendingWebhooks().length, 0);
  ob.emit('refund.updated', 'r2', 'SUCCEEDED', { paymentId: 'p2' }, 'sa');
  ob.emit('anomaly.opened', 'x1', 'x1', {}, 'sa');
  assert.equal(store.pendingWebhooks().length, 2);
  assert.equal(ob.hasRoute('refund.updated', 'sa'), true);
  assert.equal(ob.hasRoute('refund.updated', 'sb'), false);
  assert.equal(ob.hasRoute('payment.paid'), false);
  assert.equal(ob.hasRoute('anomaly.opened'), true, 'bỏ trống cửa hàng: của bất kỳ cửa hàng nào');
});

test('sink ordered: cùng (tuyến, key) đi đúng thứ tự tạo; bản sau chờ bản trước xong hoặc dead; key khác không bị chặn', async () => {
  const k = fakeSink('k', { ordered: true });
  let failFirst = true;
  k.fail = (d) => failFirst && d.key === 'P1' && d.type === 'a.first';
  const { ob, clock } = mk([{ id: 'bus', sink: 'k' }], { k });
  ob.emit('a.first', 'o1', 1, { paymentId: 'P1' });
  ob.emit('a.second', 'o2', 1, { paymentId: 'P1' });
  ob.emit('a.other', 'o3', 1, { paymentId: 'P2' });
  await ob.deliverDue();
  assert.deepEqual(k.log.map((x) => x.type), ['a.other'], 'a.first lỗi nên a.second chưa được đi trước nó');
  assert.equal(await ob.deliverDue(), 0, 'a.first chưa đến hạn thử lại, a.second vẫn chờ');
  clock.advance(5);
  failFirst = false;
  await ob.deliverDue();
  assert.deepEqual(k.log.map((x) => x.type), ['a.other', 'a.first'], 'a.second phải đợi lượt sau, không đi cùng lượt với a.first');
  await ob.deliverDue();
  assert.deepEqual(k.log.map((x) => x.type), ['a.other', 'a.first', 'a.second']);
});

test('sink ordered: bản trước dead thì bản sau đi tiếp (không chặn vĩnh viễn)', async () => {
  const k = fakeSink('k', { ordered: true });
  k.fail = (d) => d.type === 'a.first';
  const { ob, clock } = mk([{ id: 'bus', sink: 'k' }], { k });
  ob.emit('a.first', 'o1', 1, { paymentId: 'P1' });
  ob.emit('a.second', 'o2', 1, { paymentId: 'P1' });
  await ob.deliverDue(); clock.advance(5);
  await ob.deliverDue(); clock.advance(30);
  await ob.deliverDue(); // lần thứ 3: dead
  assert.equal(k.log.length, 0);
  await ob.deliverDue();
  assert.deepEqual(k.log.map((x) => x.type), ['a.second']);
});

test('sink không ordered: không chặn nhau (song song trong cùng lượt)', async () => {
  const w = fakeSink('w');
  w.fail = (d) => d.type === 'a.first';
  const { ob } = mk([{ id: 'hook', sink: 'w' }], { w });
  ob.emit('a.first', 'o1', 1, { paymentId: 'P1' });
  ob.emit('a.second', 'o2', 1, { paymentId: 'P1' });
  await ob.deliverDue();
  assert.deepEqual(w.log.map((x) => x.type), ['a.second']);
});

test('cấu hình tuyến sai thì dừng khi khởi động: sink không có, trùng id, id trùng tên tuyến ngầm, sink từ chối tham số', () => {
  const sinks = { a: fakeSink('a'), kafka: buildSinks({ kafka: { brokers: ['x:1'] } }).kafka, webhook: buildSinks({}).webhook };
  assert.throws(() => mk([{ id: 'r', sink: 'khong-co' }], sinks), /không có sink "khong-co"/);
  assert.throws(() => mk([{ id: 'r', sink: 'a' }, { id: 'r', sink: 'a' }], sinks), /trùng id tuyến r/);
  assert.throws(() => mk([{ id: 'webhook', sink: 'a' }], sinks), /trùng id tuyến webhook/);
  assert.throws(() => mk([{ id: 'Bad Id', sink: 'a' }], sinks), /id không hợp lệ/);
  assert.throws(() => mk([{ id: 'k', sink: 'kafka' }], sinks), /topic không hợp lệ/);
  assert.throws(() => mk([{ id: 'k', sink: 'kafka', topic: 'ok.topic' }], { ...sinks, kafka: buildSinks({}).kafka }), /connectors\.kafka\.brokers/);
  assert.doesNotThrow(() => mk([{ id: 'k', sink: 'kafka', topic: 'ok.topic' }], sinks));
});

test('webhook cũ và tuyến mới sống cạnh nhau: bản giao webhook giữ mã eventId, tuyến mới có hậu tố; metric gắn nhãn tuyến và sink', async () => {
  const clock = createClock();
  const sent = [];
  const fetch = async (url, init) => { sent.push(url); return { status: 200, body: null }; };
  const a = createFakeAdapter('a');
  const bus = fakeSink('bus');
  const hub = new PaymentHub({
    adapters: { a }, clock,
    deps: { sinks: { ...buildSinks({ fetch }), bus } },
    config: { gateways: [{ id: 'a' }], webhooks: { url: 'https://shop.test/h', secret: 's', auto: false }, events: { routes: [{ id: 'bus', sink: 'bus', types: ['payment.*'] }] } },
  });
  const { attempt } = await hub.createPayment({ orderId: 'O1', amount: 1000, returnUrl: 'https://s/r' });
  await hub.handleCallback('a', { channel: 'ipn', body: { ref: attempt.ref, type: 'succeeded', amount: 1000, txn: 'T1' }, headers: {} });
  await hub.deliverWebhooks();
  const list = await hub.listWebhooks({});
  assert.equal(list.length, 2);
  const legacy = list.find((w) => w.route === 'webhook');
  const route = list.find((w) => w.route === 'bus');
  assert.match(legacy.id, /^evt_[0-9a-f]{32}$/);
  assert.equal(route.id, `${legacy.id}~bus`);
  assert.deepEqual(sent, ['https://shop.test/h']);
  assert.equal(bus.log.length, 1);
  const text = hub.metrics.render();
  assert.match(text, /hub_webhook_deliveries_total\{[^}]*route="bus"[^}]*sink="bus"[^}]*\} 1/);
  assert.match(text, /hub_webhook_deliveries_total\{[^}]*route="webhook"[^}]*sink="webhook"[^}]*\} 1/);
});

test('bền vững: bản giao của tuyến sống qua khởi động lại, giao tiếp ở lần khởi động sau, đúng một lần', { skip: SKIP }, async () => {
  const db = freshDb();
  try {
    const cfgRoutes = [{ id: 'bus', sink: 'bus' }];
    const boot = async (sink) => {
      const store = await db.open();
      const ob = new EventOutbox({ store, clock: createClock(), sinks: { bus: sink }, config: { routes: cfgRoutes } });
      return { store, ob };
    };
    const s1 = fakeSink('bus', { ordered: true });
    const r1 = await boot(s1);
    r1.ob.emit('payment.paid', 'p1', 'paid', { paymentId: 'p1' });
    r1.ob.emit('payment.closed', 'p1', 'closed', { paymentId: 'p1' });
    await r1.store.persist();
    await r1.store.close();

    const s2 = fakeSink('bus', { ordered: true });
    const r2 = await boot(s2);
    assert.equal(r2.store.pendingWebhooks().length, 2, 'nạp lại cả hai bản giao chưa giao');
    await r2.ob.deliverDue();
    await r2.ob.deliverDue();
    await r2.store.persist();
    assert.deepEqual(s2.log.map((x) => x.type), ['payment.paid', 'payment.closed'], 'giữ thứ tự tạo sau khởi động lại');
    await r2.store.close();

    const s3 = fakeSink('bus', { ordered: true });
    const r3 = await boot(s3);
    await r3.ob.deliverDue();
    assert.equal(s3.log.length, 0, 'đã giao thì không giao lại');
    await r3.store.close();
  } finally { await db.cleanup(); }
});

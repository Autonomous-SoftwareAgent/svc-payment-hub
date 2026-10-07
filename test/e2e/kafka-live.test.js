'use strict';
// spec: PHUB-S-017
// Kafka THẬT (Redpanda trong docker-compose.yml, 127.0.0.1:19092; đổi bằng HUB_TEST_KAFKA): chứng minh cách dùng kafkajs đúng với giao thức thật,
// không chỉ đúng với broker giả: sự kiện ra đúng key/thứ tự theo partition, lệnh vào đúng một lần, DLQ, phản hồi.
// Bỏ qua (có nêu lý do) khi không có broker. Mỗi lần chạy dùng topic và nhóm riêng nên không đụng dữ liệu cũ.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Kafka, logLevel } = require('kafkajs');
const { PaymentHub } = require('../../src/hub');
const { MemoryStore } = require('../../src/store');
const { createApp } = require('../../src/app/app');
const { buildSinks, inboundKinds } = require('../../src/connectors/registry');
const { createFakeAdapter } = require('../support/fake-adapter');

const BROKER = process.env.HUB_TEST_KAFKA || '127.0.0.1:19092';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('quá thời gian chờ'); await wait(100); } };

async function reachable() {
  const k = new Kafka({ clientId: 'probe', brokers: [BROKER], logLevel: logLevel.NOTHING, connectionTimeout: 2000, retry: { retries: 0 } });
  const admin = k.admin();
  try { await admin.connect(); await admin.disconnect(); return true; } catch { return false; }
}

test('Kafka thật: sự kiện ra giữ thứ tự theo key; lệnh vào đúng một lần; DLQ; phản hồi', async (t) => {
  if (!(await reachable())) return t.skip(`không có broker Kafka tại ${BROKER} (docker compose up -d redpanda redpanda-init)`);
  const run = crypto.randomBytes(4).toString('hex');
  const topics = { events: `t.events.${run}`, commands: `t.commands.${run}`, dlq: `t.commands.${run}.dlq` };
  const kafka = new Kafka({ clientId: 'hub-test', brokers: [BROKER], logLevel: logLevel.NOTHING });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: Object.values(topics).map((topic) => ({ topic, numPartitions: 3 })) });

  const seen = { events: [], dlq: [] };
  const watcher = kafka.consumer({ groupId: `watch-${run}` });
  await watcher.connect();
  await watcher.subscribe({ topics: [topics.events, topics.dlq], fromBeginning: true });
  await watcher.run({ eachMessage: async ({ topic, partition, message }) => { (topic === topics.dlq ? seen.dlq : seen.events).push({ partition, key: message.key.toString(), headers: message.headers, body: topic === topics.dlq ? message.value.toString() : JSON.parse(message.value.toString()) }); } });

  const deps = { kafka: { brokers: [BROKER], clientId: 'hub-under-test' } };
  const sinks = buildSinks(deps);
  const hub = new PaymentHub({
    adapters: { a: createFakeAdapter('a', { caps: { refundable: 'manual' } }) },
    store: new MemoryStore(),
    deps: { sinks },
    config: { gateways: [{ id: 'a' }], webhooks: null, events: { routes: [{ id: 'bus', sink: 'kafka', topic: topics.events, timeoutMs: 15000 }] } },
  });
  const app = createApp({ hub });
  const conn = inboundKinds().get('kafka').create({ app, deps, config: { id: 'cmd', topic: topics.commands, groupId: `hub-${run}`, principal: { role: 'admin' }, dlqTopic: topics.dlq, fromBeginning: true } });
  await conn.start();
  const pump = setInterval(() => { hub.deliverWebhooks().catch(() => {}); }, 100);

  try {
    // (1) thứ tự: 5 key, mỗi key 40 sự kiện, tạo xen kẽ; trên topic mỗi key phải đi đúng thứ tự tạo và nằm trong một partition
    const KEYS = 5; const PER = 40;
    for (let i = 0; i < PER; i++) for (let k = 0; k < KEYS; k++) hub.events.emit('demo.step', `obj-${k}-${i}`, i, { paymentId: `pay-${k}`, step: i });
    await until(() => seen.events.filter((e) => e.body.type === 'demo.step').length === KEYS * PER);
    for (let k = 0; k < KEYS; k++) {
      const mine = seen.events.filter((e) => e.key === `pay-${k}`);
      assert.deepEqual(mine.map((e) => e.body.data.step), Array.from({ length: PER }, (_, i) => i), `key pay-${k} sai thứ tự`);
      assert.equal(new Set(mine.map((e) => e.partition)).size, 1, `key pay-${k} nằm ở nhiều partition`);
      assert.equal(mine[0].headers['hub-event-type'].toString(), 'demo.step');
    }

    // (2) lệnh qua broker thật: tạo payment, hoàn tiền gửi trùng 3 lần (đúng một lần), lệnh lỗi nghiệp vụ, thông điệp hỏng
    const producer = kafka.producer();
    await producer.connect();
    const send = (value, key) => producer.send({ topic: topics.commands, messages: [{ key, value: typeof value === 'string' ? value : JSON.stringify(value) }] });
    await send({ commandId: 'live-1', op: 'createPayment', input: { orderId: 'LIVE-1', amount: 80000, returnUrl: 'https://shop.test/r' } }, 'live-1');
    const reply1 = await until(() => seen.events.find((e) => e.body.type === 'command.completed' && e.key === 'live-1'));
    const created = reply1.body.data.result;
    assert.equal(created.payment.orderId, 'LIVE-1');
    await hub.handleCallback('a', { channel: 'ipn', body: { ref: created.attempt.ref, type: 'succeeded', amount: 80000, txn: 'T-LIVE' }, headers: {} });
    const refund = { commandId: 'live-2', op: 'createRefund', input: { attemptId: created.attempt.id, amount: 10000 } };
    for (let i = 0; i < 3; i++) await send(refund, 'live-2');
    await send({ commandId: 'live-3', op: 'createRefund', input: { attemptId: 'khong-co' } }, 'live-3');
    await send('{không phải json', 'bad-1');
    await until(() => seen.events.some((e) => e.key === 'live-3') && seen.dlq.length >= 1);
    await wait(1500); // chờ các bản giao lại của live-2 (nếu có lỗi) kịp lộ ra
    assert.equal(hub.store.refundsOfAttempt(created.attempt.id).length, 1, 'ba lần giao cùng commandId chỉ hoàn một lần');
    assert.equal(seen.events.filter((e) => e.key === 'live-2' && e.body.type === 'command.completed').length, 1);
    assert.equal(seen.events.find((e) => e.key === 'live-3').body.data.error, 'not_found');
    assert.equal(seen.dlq.length, 1);
    assert.equal(seen.dlq[0].body, '{không phải json');
    assert.ok(seen.dlq[0].headers.reason.toString().length > 0);
    await producer.disconnect();
  } finally {
    clearInterval(pump);
    await conn.stop();
    await watcher.disconnect();
    for (const s of Object.values(sinks)) if (s.close) await s.close();
    await admin.deleteTopics({ topics: Object.values(topics) }).catch(() => {});
    await admin.disconnect();
  }
});

'use strict';
// spec: PHUB-S-032
// Giao tin ra qua Kafka THẬT (Redpanda trong docker-compose.yml) với PostgreSQL thật, khi broker ngừng giữa chừng và Hub khởi động lại:
// hộp thư đi phải không mất tin và giữ đúng thứ tự theo key dù broker bị đóng băng vài giây (docker pause) và Hub bị dựng lại.
// Mock chỉ chứng minh giả định của người viết; test này kiểm giả định về kafkajs và broker thật (producer nối lại sau khi broker tỉnh,
// thứ tự theo key sau các lần gửi lỗi). Giao ít nhất một lần nên cho phép trùng, nhưng không cho mất và không cho đảo thứ tự lần nhận đầu.
// CHỈ CHẠY KHI ĐẶT HUB_TEST_KAFKA_CHAOS=1: test đóng băng broker DÙNG CHUNG, nên chạy cùng lúc với các test Kafka khác (node --test chạy các tệp song song)
// làm chúng hết hạn (đã gặp: kafka-live lỗi khi chạy chung). Chạy riêng: HUB_TEST_KAFKA_CHAOS=1 HUB_TEST_DATABASE_URL=... node --test test/e2e/kafka-delivery-live.test.js
// Bỏ qua (có nêu lý do) khi thiếu cờ, PostgreSQL, broker, hoặc lệnh docker để đóng băng broker. Container broker: HUB_TEST_KAFKA_CONTAINER.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Kafka, logLevel } = require('kafkajs');
const { EventOutbox } = require('../../src/events');
const { buildSinks } = require('../../src/connectors/registry');
const { freshDb, SKIP } = require('../support/pg');

const BROKER = process.env.HUB_TEST_KAFKA || '127.0.0.1:19092';
const CONTAINER = process.env.HUB_TEST_KAFKA_CONTAINER || 'payment-hub-local-redpanda-1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('quá thời gian chờ'); await wait(100); } };

async function reachable() {
  const k = new Kafka({ clientId: 'probe', brokers: [BROKER], logLevel: logLevel.NOTHING, connectionTimeout: 2000, retry: { retries: 0 } });
  const admin = k.admin();
  try { await admin.connect(); await admin.disconnect(); return true; } catch { return false; }
}
function docker(...args) { return execFileSync('docker', args, { stdio: 'pipe', timeout: 20000 }).toString(); }
function canPause() { try { docker('inspect', '-f', '{{.State.Running}}', CONTAINER); return true; } catch { return false; } }

const CHAOS_SKIP = SKIP || (process.env.HUB_TEST_KAFKA_CHAOS === '1' ? false : 'đặt HUB_TEST_KAFKA_CHAOS=1 để chạy riêng: test này đóng băng broker dùng chung, làm các test Kafka khác chạy song song bị hết hạn');

test('Kafka thật + PostgreSQL: broker đóng băng và Hub khởi động lại giữa chừng, không mất tin, đúng thứ tự theo key', { skip: CHAOS_SKIP, timeout: 180000 }, async (t) => {
  if (!(await reachable())) return t.skip(`không có broker Kafka tại ${BROKER} (docker compose up -d redpanda redpanda-init)`);
  if (!canPause()) return t.skip(`không có container ${CONTAINER} để đóng băng (đặt HUB_TEST_KAFKA_CONTAINER)`);
  const run = crypto.randomBytes(4).toString('hex');
  const topic = `t.delivery.${run}`;
  const kafka = new Kafka({ clientId: 'hub-delivery-test', brokers: [BROKER], logLevel: logLevel.NOTHING });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 3 }] });

  const seen = []; // mọi bản ghi nhận được trên topic
  const watcher = kafka.consumer({ groupId: `watch-${run}` });
  await watcher.connect();
  await watcher.subscribe({ topics: [topic], fromBeginning: true });
  await watcher.run({ eachMessage: async ({ partition, message }) => { const b = JSON.parse(message.value.toString()); seen.push({ partition, key: message.key.toString(), id: b.id, step: b.data.step }); } });

  const db = freshDb();
  const clock = { now: () => Date.now() };
  const cfg = { routes: [{ id: 'bus', sink: 'kafka', topic, timeoutMs: 3000, maxAttempts: 200, backoffSeconds: [1] }] };
  let store = await db.open();
  let sinks = buildSinks({ kafka: { brokers: [BROKER], clientId: 'hub-delivery-under-test', requestTimeoutMs: 3000, retries: 1 } });
  let outbox = new EventOutbox({ store, clock, sinks, config: cfg });
  let pumping = true;
  const pump = (async () => { while (pumping) { try { await outbox.deliverDue(); await store.persist(); } catch { /* lần sau thử lại */ } await wait(100); } })();

  const KEYS = 5; const PER = 30; const TOTAL = KEYS * PER;
  const expected = [];
  const emitRange = async (from, to) => {
    for (let i = from; i < to; i++) for (let k = 0; k < KEYS; k++) { outbox.emit('demo.step', `obj-${k}-${i}`, i, { paymentId: `pay-${k}`, step: i }); expected.push({ key: `pay-${k}`, step: i }); }
    await store.persist();
  };
  let paused = false;
  try {
    await emitRange(0, 10);
    await until(() => seen.length >= KEYS * 10, 30000); // phần đầu đi qua bình thường
    // broker đóng băng; tiếp tục phát trong lúc broker không trả lời
    docker('pause', CONTAINER); paused = true;
    await emitRange(10, 20);
    await wait(4000);
    // Hub khởi động lại khi broker còn đóng băng: bản chờ phải sống sót trong PostgreSQL
    pumping = false; await pump;
    await store.persist(); await store.close();
    if (sinks.kafka && sinks.kafka.close) await sinks.kafka.close().catch(() => {});
    store = await db.open();
    sinks = buildSinks({ kafka: { brokers: [BROKER], clientId: 'hub-delivery-under-test-2', requestTimeoutMs: 3000, retries: 1 } });
    outbox = new EventOutbox({ store, clock, sinks, config: cfg });
    pumping = true;
    const pump2 = (async () => { while (pumping) { try { await outbox.deliverDue(); await store.persist(); } catch { /* lần sau thử lại */ } await wait(100); } })();
    await emitRange(20, PER);
    docker('unpause', CONTAINER); paused = false;
    await until(() => store.pendingWebhooks().length === 0 && seen.length >= TOTAL, 90000);
    pumping = false; await pump2;

    // không mất: mọi (key, step) đã phát đều đến topic ít nhất một lần
    const got = new Set(seen.map((e) => `${e.key}#${e.step}`));
    const missing = expected.filter((e) => !got.has(`${e.key}#${e.step}`));
    assert.deepEqual(missing, [], 'tin đã phát mà không đến topic');
    // đúng thứ tự: lần nhận ĐẦU của mỗi (key, step) phải theo thứ tự step tăng trong từng key; mỗi key nằm một partition
    for (let k = 0; k < KEYS; k++) {
      const mine = seen.filter((e) => e.key === `pay-${k}`);
      const first = []; const dup = new Set();
      for (const e of mine) { if (dup.has(e.step)) continue; dup.add(e.step); first.push(e.step); }
      assert.deepEqual(first, Array.from({ length: PER }, (_, i) => i), `key pay-${k}: lần nhận đầu sai thứ tự`);
      assert.equal(new Set(mine.map((e) => e.partition)).size, 1, `key pay-${k} nằm ở nhiều partition`);
    }
    t.diagnostic(`nhận ${seen.length} bản ghi cho ${TOTAL} sự kiện (trùng ${seen.length - TOTAL}, cho phép vì giao ít nhất một lần)`);
  } finally {
    pumping = false;
    if (paused) { try { docker('unpause', CONTAINER); } catch { /* đã tỉnh */ } }
    await watcher.disconnect().catch(() => {});
    await admin.disconnect().catch(() => {});
    if (sinks.kafka && sinks.kafka.close) await sinks.kafka.close().catch(() => {});
    await store.close().catch(() => {});
    await db.cleanup();
  }
});

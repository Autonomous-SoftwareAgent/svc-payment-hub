'use strict';
// spec: PHUB-S-026
// spec: PHUB-S-007
// Tắt tiến trình ĐÚNG giữa lúc ghi bảng và lúc phát sự kiện (P-011, nhóm 2), có chèn điểm dừng chính xác (hub-crash.test.js chỉ giết ngẫu nhiên giữa tải).
// Trạng thái và sự kiện ra (hộp thư đi) được ghi trong MỘT transaction, nên chỉ có hai kết cục hợp lệ:
//   (a) chết TRƯỚC khi COMMIT: không có gì được ghi (đơn chưa PAID, không có sự kiện); cổng gửi lại thông báo thì ghi đúng một lần và phát đúng một sự kiện;
//   (b) chết SAU COMMIT, trước khi giao: đơn PAID và sự kiện nằm sẵn ở hộp thư đi; tiến trình mới giao đúng một lần, không mất, không giao đôi.
// Cần PostgreSQL thật (test/support/pg.js). Điểm dừng chèn ở ranh giới COMMIT của PostgresStore; chưa kiểm chết tiến trình thật giữa hai câu lệnh SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');
const { SKIP, freshDb } = require('../support/pg');

function boot(store, a, clock, sink) {
  return new PaymentHub({
    adapters: { a }, clock, store, deps: { sinks: { cap: sink } },
    config: {
      gateways: [{ id: 'a', priority: 1 }],
      reconcile: { firstAfterSeconds: 60, backoffSeconds: [60], maxAgeSeconds: 3600 },
      paymentTtlSeconds: 1800,
      webhooks: { auto: false }, // giao tay bằng deliverWebhooks để điểm dừng chính xác
      events: { routes: [{ id: 'r1', sink: 'cap', types: ['payment.paid'], maxAttempts: 3 }] },
    },
  });
}
const order = () => ({ orderId: 'O1', amount: 100000, returnUrl: 'https://shop/return' });
const cb = (hub, body) => hub.handleCallback('a', { channel: 'ipn', method: 'GET', query: {}, body, headers: {} });
const mkSink = () => { const got = []; return { got, kind: 'cap', ordered: true, validate() {}, async deliver(d) { got.push(d.id); return {}; } }; };

const withDb = (name, fn) => test(name, { skip: SKIP }, async () => {
  const db = freshDb();
  try { await fn(db); } finally { await db.cleanup(); }
});

withDb('chết ngay trước COMMIT khi ghi nhận tiền: không còn dấu vết nào; cổng gửi lại thì ghi đúng một lần và phát đúng một sự kiện', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock, mkSink());
  const { attempt } = await hub1.createPayment(order());
  // Điểm dừng: từ đây, COMMIT của lần ghi kế tiếp "không bao giờ tới" (tiến trình chết trước COMMIT).
  const realQuery = s1.client.query.bind(s1.client);
  s1.client.query = async (q, ...rest) => {
    if (typeof q === 'string' && q.trim() === 'COMMIT') throw new Error('tiến trình chết trước COMMIT');
    return realQuery(q, ...rest);
  };
  const res = await cb(hub1, { ref: attempt.ref, type: 'succeeded', amount: attempt.amount, txn: 'T1' }).catch((e) => e);
  assert.ok(res instanceof Error, 'ghi không xong thì thao tác phải báo lỗi để cổng gửi lại, không được báo ok');
  await s1.close().catch(() => {});

  // Tiến trình mới trên cùng schema: không thấy gì về tiền.
  const sink = mkSink();
  const s2 = await db.open();
  const hub2 = boot(s2, a, clock, sink);
  const before = await hub2.loadPayment(attempt.paymentId);
  assert.equal(before.payment.status, 'OPEN', 'chưa ghi được thì đơn vẫn mở');
  assert.equal((await s2.listWebhooks({})).length, 0, 'không có sự kiện nào nằm lại không kèm trạng thái');
  // Cổng gửi lại thông báo.
  const retry = await cb(hub2, { ref: attempt.ref, type: 'succeeded', amount: attempt.amount, txn: 'T1' });
  assert.equal(retry.outcome, 'ok', 'lần gửi lại không bị coi là trùng vì lần trước chưa ghi được');
  await hub2.deliverWebhooks();
  await hub2.deliverWebhooks();
  assert.equal(sink.got.length, 1, 'đúng một lần giao payment.paid');
  assert.equal((await hub2.loadPayment(attempt.paymentId)).payment.status, 'PAID');
  assert.equal((await s2.listWebhooks({})).filter((w) => w.type === 'payment.paid').length, 1);
  await s2.close();
});

withDb('chết ngay sau COMMIT, trước khi giao: đơn PAID và sự kiện đã nằm ở hộp thư đi; tiến trình mới giao đúng một lần', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const sink1 = mkSink();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock, sink1);
  const { attempt } = await hub1.createPayment(order());
  const r = await cb(hub1, { ref: attempt.ref, type: 'succeeded', amount: attempt.amount, txn: 'T1' });
  assert.equal(r.outcome, 'ok');
  assert.equal(sink1.got.length, 0, 'auto=false nên chưa giao: đây là điểm dừng "đã COMMIT, chưa giao"');
  await s1.close(); // tiến trình chết ở đây

  const sink2 = mkSink();
  const s2 = await db.open();
  const hub2 = boot(s2, a, clock, sink2);
  assert.equal((await hub2.loadPayment(attempt.paymentId)).payment.status, 'PAID');
  const pending = await s2.listWebhooks({ status: 'pending' });
  assert.equal(pending.length, 1, 'sự kiện không mất: nằm ở hộp thư đi');
  await hub2.deliverWebhooks();
  assert.equal(sink2.got.length, 1);
  await hub2.deliverWebhooks();
  assert.equal(sink2.got.length, 1, 'không giao đôi');
  assert.equal((await s2.listWebhooks({ status: 'delivered' })).length, 1);
  assert.equal(sink1.got.length, 0);
  await s2.close();
});

withDb('chết SAU khi sink đã nhận nhưng TRƯỚC khi ghi "đã giao": giao lại (ít nhất một lần), nhưng cùng một mã sự kiện để người nhận loại trùng', async (db) => {
  const a = createFakeAdapter('a');
  const clock = createClock();
  const sink1 = mkSink();
  const s1 = await db.open();
  const hub1 = boot(s1, a, clock, sink1);
  const { attempt } = await hub1.createPayment(order());
  await cb(hub1, { ref: attempt.ref, type: 'succeeded', amount: attempt.amount, txn: 'T1' });
  // Chết sau khi sink nhận, trước khi lưu kết quả giao: bỏ lần ghi kế tiếp.
  s1.persist = async () => { throw new Error('tiến trình chết trước khi ghi kết quả giao'); };
  await hub1.deliverWebhooks().catch(() => {});
  assert.equal(sink1.got.length, 1);
  await s1.close().catch(() => {});

  const sink2 = mkSink();
  const s2 = await db.open();
  const hub2 = boot(s2, a, clock, sink2);
  clock.advance(10);
  await hub2.deliverWebhooks();
  assert.equal(sink2.got.length, 1, 'giao lại một lần: giới hạn "ít nhất một lần"');
  assert.deepEqual(sink2.got, sink1.got, 'cùng mã sự kiện, người nhận loại trùng được');
  await s2.close();
});

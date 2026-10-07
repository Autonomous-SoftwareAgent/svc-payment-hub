'use strict';
// spec: PHUB-S-030
// spec: PHUB-S-026
// Kịch bản NGẪU NHIÊN giao tin ra trên PostgreSQL thật, có khởi động lại giữa chừng (PHUB-D-026): hộp thư đi phải sống sót qua khởi động lại,
// không mất tin, không gửi lại sau khi đã xác nhận, đúng thứ tự theo key. Chạy rộng hơn: PG_SEEDS=200 PG_STEPS=120; lặp lại: SEED=<số>.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runDelivery } = require('../support/delivery-runner');
const { freshDb, SKIP } = require('../support/pg');

const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(process.env.PG_SEEDS || 40) }, (_, i) => i + 1);
const STEPS = Number(process.env.PG_STEPS || 80);

test(`giao tin ra trên PostgreSQL (${SEEDS.length} seed x ${STEPS} bước, có khởi động lại): không mất tin, đúng thứ tự, không gửi lại sau khi đã xác nhận`, { skip: SKIP, timeout: 600000 }, async () => {
  const failures = [];
  let restarts = 0;
  for (const seed of SEEDS) {
    try { restarts += (await runDelivery(seed, { steps: STEPS, db: freshDb() })).restarts; } catch (err) { failures.push(err.message); if (failures.length >= 3) break; }
  }
  assert.deepEqual(failures, [], `${failures.length} seed lỗi; chạy lại: SEED=<số> HUB_TEST_DATABASE_URL=... node --test test/hub/scenarios-delivery-pg.test.js`);
  assert.ok(restarts > 0, 'bộ chạy phải thực sự khởi động lại');
});

// PHUB-D-030: phát lại cùng (loại, đối tượng, phiên bản) sau khởi động lại. Bản đã delivered hoặc dead không còn trong bộ nhớ, nên kho phải tự
// phát hiện bản cùng mã: không gửi lần hai và không ghi đè bản đã có.
for (const finalStatus of ['delivered', 'dead']) {
  test(`phát lại cùng sự kiện sau khởi động lại (bản cũ ${finalStatus}): không được giao lần hai và không được ghi đè bản đã có`, { skip: SKIP }, async () => {
    const { EventOutbox } = require('../../src/events');
    const { createClock } = require('../support/fake-adapter');
    const db = freshDb();
    const clock = createClock();
    const calls = [];
    const failing = finalStatus === 'dead';
    const sink = { kind: 'ord', ordered: true, validate() {}, async deliver(d) { calls.push(d.id); if (failing) throw new Error('đích hỏng'); return {}; } };
    const cfg = { routes: [{ id: 'r1', sink: 'ord', maxAttempts: 1 }] };
    let store = await db.open();
    try {
      let outbox = new EventOutbox({ store, clock, sinks: { ord: sink }, config: cfg });
      outbox.emit('payment.paid', 'pay_1', 'v1', { paymentId: 'pay_1' });
      await outbox.deliverDue();
      assert.equal(calls.length, 1);
      await store.persist(); await store.close();
      store = await db.open();
      outbox = new EventOutbox({ store, clock, sinks: { ord: sink }, config: cfg });
      outbox.emit('payment.paid', 'pay_1', 'v1', { paymentId: 'pay_1' }); // cùng (loại, đối tượng, phiên bản)
      clock.advance(1);
      await outbox.deliverDue();
      assert.equal(calls.length, 1, 'sink chỉ được nhận một lần');
      await store.persist();
      assert.equal(store.duplicateWebhooks, 1, 'kho phải ghi nhận đã bỏ một bản trùng');
      const rows = await store.listWebhooks({ status: finalStatus });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, finalStatus);
      assert.equal(rows[0].attempts, 1, 'bản đã có không bị ghi đè về attempts 0');
      assert.equal((await store.listWebhooks({ status: 'pending' })).length, 0, 'không được còn bản chờ gửi');
    } finally { await store.close().catch(() => {}); await db.cleanup(); }
  });
}

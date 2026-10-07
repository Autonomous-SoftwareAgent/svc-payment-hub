'use strict';
// spec: PHUB-S-026
// Kịch bản NGẪU NHIÊN cho phía giao tin ra (hộp thư đi), kho bộ nhớ (PHUB-D-026). Bộ chạy: test/support/delivery-runner.js.
// Chạy lại một seed: SEED=123 node --test test/hub/scenarios-delivery.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runDelivery } = require('../support/delivery-runner');

const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(process.env.SEEDS || 300) }, (_, i) => i + 1);
const STEPS = Number(process.env.STEPS || 80);

test(`giao tin ra, ngẫu nhiên (${SEEDS.length} seed x ${STEPS} bước): không mất tin, đúng phạm vi, đúng thứ tự theo key, không gửi lại sau khi đã xác nhận`, async () => {
  const failures = [];
  for (const seed of SEEDS) {
    try { await runDelivery(seed, { steps: STEPS }); } catch (err) { failures.push(err.message); if (failures.length >= 3) break; }
  }
  assert.deepEqual(failures, [], `${failures.length} seed lỗi; chạy lại: SEED=<số> node --test test/hub/scenarios-delivery.test.js`);
});

test('gửi lại thủ công một bản dead cũ khi bản mới hơn cùng key đang chờ: bản cũ phải đi trước (theo thứ tự tạo)', async () => {
  const { EventOutbox } = require('../../src/events');
  const { MemoryStore } = require('../../src/store');
  const { createClock } = require('../support/fake-adapter');
  const clock = createClock();
  const got = [];
  let ok = false;
  const sink = { kind: 'ord', ordered: true, validate() {}, async deliver(d) { if (!ok) throw new Error('hỏng'); got.push(d.type); return {}; } };
  const outbox = new EventOutbox({ store: new MemoryStore(), clock, sinks: { ord: sink }, config: { routes: [{ id: 'r1', sink: 'ord' }], maxAttempts: 1, backoffSeconds: [1] } });
  outbox.emit('payment.paid', 'pay_1', 'v1', { paymentId: 'pay_1' });        // E1
  await outbox.deliverDue();                                                  // thất bại, maxAttempts 1 -> dead
  const e1 = outbox.store.listWebhooks ? (await outbox.store.listWebhooks({})).find((w) => w.type === 'payment.paid') : null;
  assert.equal(e1.status, 'dead');
  clock.advance(1);
  outbox.emit('payment.closed', 'pay_1', 'v2', { paymentId: 'pay_1' });      // E3 cùng key, đang chờ (chưa gửi)
  await outbox.retry(e1.id);                                                  // gửi lại E1 thủ công
  ok = true;
  clock.advance(1);
  for (let i = 0; i < 4; i += 1) { await outbox.deliverDue(); clock.advance(1); }
  assert.deepEqual(got, ['payment.paid', 'payment.closed'], 'bản tạo trước phải đi trước dù được đưa vào hàng chờ sau');
});

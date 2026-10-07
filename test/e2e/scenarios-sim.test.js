'use strict';
// spec: PHUB-S-028
// Kịch bản NGẪU NHIÊN với simulator thật và adapter thật (PHUB-D-028): simulator là sự thật nền về việc cổng đã thu tiền của giao dịch nào.
// Bất biến: tiền cổng đã thu không bao giờ vô hình với Hub, Hub không báo thu khống. Chạy rộng hơn: SIM_SEEDS=50 SIM_STEPS=80; lặp lại: SEED=<số>.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSimSeed } = require('../support/sim-runner');

const COMBOS = [['vnpay'], ['momo'], ['onepay'], ['vnpay', 'momo'], ['momo', 'onepay']];
const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(process.env.SIM_SEEDS || 10) }, (_, i) => i + 1);
const STEPS = Number(process.env.SIM_STEPS || 50);

for (const combo of COMBOS) {
  test(`simulator thật ${combo.join(' + ')} (${SEEDS.length} seed x ${STEPS} bước): tiền cổng đã thu luôn được Hub ghi nhận, không báo thu khống`, { timeout: 600000 }, async () => {
    const failures = [];
    let paid = 0;
    for (const seed of SEEDS) {
      try { paid += (await runSimSeed(seed, { gateways: combo, steps: STEPS })).paidAtGateway; } catch (err) { failures.push(err.message); if (failures.length >= 2) break; }
    }
    assert.deepEqual(failures, [], `${failures.length} seed lỗi; chạy lại: SEED=<số> node --test test/e2e/scenarios-sim.test.js`);
    assert.ok(paid > 0, 'bộ chạy phải thực sự có giao dịch đã thu ở cổng để kiểm');
  });
}

// Cùng bộ chạy trên PostgreSQL thật, có khởi động lại Hub giữa chừng
const { freshDb, SKIP } = require('../support/pg');
test(`simulator thật vnpay + momo trên PostgreSQL có khởi động lại (${Math.min(SEEDS.length, 12)} seed x ${STEPS} bước)`, { skip: SKIP, timeout: 900000 }, async () => {
  const failures = [];
  let restarts = 0;
  for (const seed of SEEDS.slice(0, 12)) {
    try { restarts += (await runSimSeed(seed, { gateways: ['vnpay', 'momo'], steps: STEPS, db: freshDb() })).restarts; } catch (err) { failures.push(err.message); if (failures.length >= 2) break; }
  }
  assert.deepEqual(failures, [], `${failures.length} seed lỗi; chạy lại: SEED=<số> HUB_TEST_DATABASE_URL=... node --test test/e2e/scenarios-sim.test.js`);
  assert.ok(restarts > 0, 'bộ chạy phải thực sự khởi động lại');
});

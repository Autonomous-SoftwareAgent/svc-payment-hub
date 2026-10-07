'use strict';
// spec: PHUB-S-028
// spec: STRP-S-003
// Kịch bản NGẪU NHIÊN với simulator Stripe thật và adapter Stripe thật (P-011, nhóm 3). Bất biến như scenarios-sim: tiền cổng đã thu hoặc đang giữ
// không bao giờ vô hình với Hub, Hub không báo thu khống. Chạy rộng hơn: SIM_SEEDS=50 SIM_STEPS=80; lặp lại: SEED=<số>. CHỈ chạy với simulator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runStripeSeed } = require('../support/stripe-runner');

const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(process.env.SIM_SEEDS || 10) }, (_, i) => i + 1);
const STEPS = Number(process.env.SIM_STEPS || 40);

for (const product of [undefined, 'auth']) {
  const label = product ? 'giữ tiền rồi thu sau (auth)' : 'thu ngay (charge)';
  test(`simulator thật stripe, ${label} (${SEEDS.length} seed x ${STEPS} bước): tiền cổng đã thu hay đang giữ luôn được Hub ghi nhận, không báo thu khống`, { timeout: 600000 }, async () => {
    const failures = [];
    let paid = 0;
    for (const seed of SEEDS) {
      try { paid += (await runStripeSeed(seed, { steps: STEPS, product })).paidAtGateway; } catch (err) { failures.push(err.message); if (failures.length >= 2) break; }
    }
    assert.deepEqual(failures, [], `${failures.length} seed lỗi; chạy lại: SEED=<số> node --test test/e2e/scenarios-stripe.test.js`);
    assert.ok(paid > 0, 'bộ chạy phải thực sự có giao dịch đã thu ở cổng để kiểm');
  });
}

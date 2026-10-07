'use strict';
// spec: PHUB-S-019
// spec: PHUB-S-026
// Kịch bản NGẪU NHIÊN có kiểm bất biến về tiền, kho bộ nhớ (PHUB-D-019). Bộ chạy nằm ở test/support/random-runner.js (dùng chung với bản PostgreSQL).
// Chạy lại một seed: SEED=123 node --test test/hub/scenarios-random.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSeed } = require('../support/random-runner');

const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(process.env.SEEDS || 300) }, (_, i) => i + 1);
const STEPS = Number(process.env.STEPS || 90);

test(`ngẫu nhiên (${SEEDS.length} seed x ${STEPS} bước): bất biến về tiền luôn đúng, mọi khoản tiền được ghi nhận`, async () => {
  const failures = [];
  for (const seed of SEEDS) {
    try { await runSeed(seed, { steps: STEPS }); } catch (err) { failures.push(err.message); if (failures.length >= 3) break; }
  }
  assert.deepEqual(failures, [], `${failures.length} seed lỗi; chạy lại: SEED=<số> node --test test/hub/scenarios-random.test.js`);
});

'use strict';
// spec: PHUB-S-026
// Kịch bản NGẪU NHIÊN trên PostgreSQL thật, có KHỞI ĐỘNG LẠI Hub giữa chừng và ĐẨY bộ nhớ nóng ra (PHUB-D-026): kiểm cả độ trung thực của việc lưu và nạp lại.
// Mỗi seed dùng một schema riêng và tự dọn. Chạy rộng hơn: PG_SEEDS=200 PG_STEPS=150; lặp lại: SEED=<số>.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSeed } = require('../support/random-runner');
const { freshDb, SKIP } = require('../support/pg');

const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(process.env.PG_SEEDS || 30) }, (_, i) => i + 1);
const STEPS = Number(process.env.PG_STEPS || 90);

test(`ngẫu nhiên trên PostgreSQL (${SEEDS.length} seed x ${STEPS} bước, có khởi động lại và evict): bất biến về tiền và độ trung thực lưu/nạp`, { skip: SKIP, timeout: 600000 }, async () => {
  const failures = [];
  let restarts = 0;
  let evictions = 0;
  for (const seed of SEEDS) {
    try { const r = await runSeed(seed, { steps: STEPS, db: freshDb() }); restarts += r.restarts; evictions += r.evictions; } catch (err) { failures.push(err.message); if (failures.length >= 3) break; }
  }
  assert.deepEqual(failures, [], `${failures.length} seed lỗi; chạy lại: SEED=<số> HUB_TEST_DATABASE_URL=... node --test test/hub/scenarios-random-pg.test.js`);
  assert.ok(restarts > 0 && evictions > 0, `bộ chạy phải thực sự khởi động lại (${restarts}) và evict (${evictions})`);
});

'use strict';
// spec: PHUB-S-016
// Giết Hub (SIGKILL, tiến trình thật chạy src/main.js) giữa lúc có tải, khởi động lại trên cùng PostgreSQL, rồi kiểm các bất biến về tiền.
// Simulator MoMo chạy trong tiến trình test; nó gửi IPN về Hub, và gửi lại sau khi tiến đồng hồ ảo của nó (kịch bản IPN bị mất lúc Hub chết).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { startSimulator } = require('../../tools/sim/momo/server.js');
const { PostgresStore } = require('../../src/store-postgres');
const { PG_URL, SKIP } = require('../support/pg');

const ROOT = path.resolve(__dirname, '..', '..');
const TOKEN = 'test-api-token-not-real';
const CREDS = { partnerCode: 'MOMOTEST01', accessKey: 'test-access-key', secretKey: 'test-secret-key-do-not-use' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function waitHealthy(base, child, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }); if (r.ok) return true; } catch { /* chưa lên */ }
    await sleep(100);
  }
  return false;
}

async function scenario(t, how) {
  const schema = `crash_${crypto.randomBytes(4).toString('hex')}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const sim = await startSimulator({ ...CREDS });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubcrash-'));
  const cfgPath = path.join(dir, 'hub.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port, host: '127.0.0.1', publicBaseUrl: base, apiToken: '${HUB_API_TOKEN}', databaseUrl: '${HUB_DATABASE_URL}', databaseSchema: schema, schedulerSeconds: 1, limits: { ratePerSecond: 100000, burst: 100000 },
    hub: { gateways: [{ id: 'momo' }], reconcile: { firstAfterSeconds: 1, backoffSeconds: [1, 1, 2] }, hot: { idleSeconds: 1, evictEverySeconds: 1 } },
    adapters: { momo: { ...CREDS, secretKey: '${MOMO_SECRET}', baseUrl: sim.url } },
  }));
  const env = { ...process.env, HUB_CONFIG: cfgPath, HUB_API_TOKEN: TOKEN, HUB_DATABASE_URL: PG_URL, MOMO_SECRET: CREDS.secretKey };
  let child = null;
  let tail = [];
  const start = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      child = spawn(process.execPath, ['src/main.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const keep = (b) => { tail = tail.concat(String(b).split('\n').filter(Boolean)).slice(-30); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      if (await waitHealthy(base, child)) return;
      child.kill('SIGKILL');
      await sleep(300); // khóa advisory của tiến trình cũ có thể chưa được nhả
    }
    throw new Error(`Hub không khởi động được: ${tail.join(' | ')}`);
  };
  const exited = () => new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  const kill = async () => {
    if (how === 'sigkill') { child.kill('SIGKILL'); await exited(); return; }
    // 'pg': cắt kết nối ghi của Hub tới PostgreSQL (kết nối giữ advisory lock); Hub phải tự thoát để trình điều phối khởi động lại.
    const admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    // Chỉ ngắt kết nối giữ khóa advisory của CHÍNH schema này (khóa = hashtext của store-postgres). Trước đây ngắt mọi khóa advisory trên máy chủ nên làm hỏng
    // các test PostgreSQL khác đang chạy song song, nhất là các bộ ngẫu nhiên chạy lâu.
    try { await admin.query("SELECT pg_terminate_backend(l.pid) FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid <> pg_backend_pid() AND l.objid::bigint = (hashtext($1)::bigint & 4294967295)", [`bsn-payment-hub:${schema}`]); } finally { await admin.end(); }
    const done = await Promise.race([exited().then(() => true), sleep(8000).then(() => false)]);
    if (!done) { child.kill('SIGKILL'); await exited(); throw new Error('Hub không tự thoát khi mất kết nối cơ sở dữ liệu'); }
  };

  const api = (method, p, body) => fetch(base + p, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  const recorded = []; // payment mà khách đã nhận 201
  const stop = { v: false };
  async function worker(w) {
    let i = 0;
    while (!stop.v) {
      const orderId = `C${w}_${i++}`;
      let j;
      try {
        const r = await api('POST', '/payments', { orderId, amount: 150000, returnUrl: 'https://shop.test/r' });
        if (r.status !== 201) continue;
        j = await r.json();
      } catch { continue; } // Hub đang chết: khách không nhận được gì, không ghi nhận
      const rec = { orderId, paymentId: j.payment.id, ref: j.attempt.ref, paid: false };
      recorded.push(rec);
      if (Math.random() < 0.7) {
        try { rec.paid = (await fetch(`${sim.url}/sim/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: rec.ref, outcome: 'success' }) })).status === 200; } catch { /* simulator luôn sống */ }
      }
    }
  }

  try {
    await start();
    const workers = Array.from({ length: 8 }, (_, w) => worker(w));
    await sleep(1200);
    await kill(); // lần 1: giữa tải
    await sleep(400);
    await start();
    await sleep(1000);
    await kill(); // lần 2
    await sleep(300);
    await start();
    await sleep(1500);
    stop.v = true;
    await Promise.all(workers);
    assert.ok(recorded.length >= 20, `chỉ có ${recorded.length} payment: tải quá ít để kiểm chứng`);
    const paidAtSim = recorded.filter((r) => r.paid);
    assert.ok(paidAtSim.length >= 10, `chỉ ${paidAtSim.length} giao dịch đã trả ở cổng`);

    t.diagnostic(`${recorded.length} payment đã nhận 201, ${paidAtSim.length} đã trả ở cổng, Hub bị ngắt 2 lần giữa tải (${how})`);

    // Chờ hệ thống hội tụ: simulator gửi lại IPN (tiến đồng hồ ảo của nó), Hub đối soát mỗi giây.
    const detail = async (r) => (await (await api('GET', `/payments/${r.paymentId}`)).json());
    const settled = async () => {
      const bad = [];
      for (let i = 0; i < paidAtSim.length; i += 20) {
        const ds = await Promise.all(paidAtSim.slice(i, i + 20).map(detail));
        ds.forEach((d, k) => { if (!d.payment || d.payment.status !== 'PAID') bad.push(paidAtSim[i + k]); });
      }
      return bad;
    };
    let pending = paidAtSim;
    for (let round = 0; round < 40 && pending.length; round++) {
      await fetch(`${sim.url}/sim/clock/advance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: 400 }) });
      await sleep(500);
      pending = await settled();
    }
    assert.equal(pending.length, 0, `${pending.length} giao dịch đã được cổng nhận tiền nhưng Hub chưa PAID`);

    // Bất biến 1: mọi payment khách đã nhận 201 đều còn, đúng đơn và số tiền, đúng một attempt ban đầu.
    const all = [];
    for (let i = 0; i < recorded.length; i += 20) all.push(...await Promise.all(recorded.slice(i, i + 20).map(async (r) => ({ r, d: await detail(r) }))));
    for (const { r, d } of all) {
      assert.equal(d.payment.id, r.paymentId, `mất payment ${r.paymentId}`);
      assert.equal(d.payment.orderId, r.orderId);
      assert.equal(d.payment.amount, 150000);
    }
    // Bất biến 2: PAID đúng bằng những khoản cổng đã nhận (không tiền ma), mỗi khoản đúng một attempt SUCCEEDED, đúng số tiền.
    const paidAtHub = all.filter(({ d }) => d.payment.status === 'PAID');
    assert.equal(paidAtHub.length, paidAtSim.length, 'số payment PAID khác số khoản cổng đã nhận');
    const simPaidRefs = new Set(paidAtSim.map((r) => r.ref));
    for (const { r, d } of paidAtHub) {
      assert.ok(simPaidRefs.has(r.ref), `payment ${r.paymentId} PAID mà cổng không nhận tiền`);
      assert.equal(d.attempts.filter((a) => a.status === 'SUCCEEDED').length, 1);
      assert.equal(d.attempts.find((a) => a.status === 'SUCCEEDED').amount, 150000);
    }
    // Bất biến 3: không anomaly (không thu hai lần, không lệch tiền, không thông báo cho mã lạ).
    const an = await (await api('GET', '/anomalies')).json();
    assert.deepEqual(an.anomalies.map((x) => x.type), [], 'không được có anomaly sau khi Hub bị giết và khởi động lại');
    // Mã tham chiếu không trùng.
    assert.equal(new Set(recorded.map((r) => r.ref)).size, recorded.length);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await sim.close();
    await sleep(200);
    await PostgresStore.dropSchema(PG_URL, schema).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NAME = 'không mất payment đã báo 201, mọi khoản cổng đã nhận đều thành PAID, không có tiền ma và không có anomaly';
test(`giết Hub (SIGKILL) hai lần giữa tải rồi khởi động lại: ${NAME}`, { skip: SKIP, timeout: 150000 }, (t) => scenario(t, 'sigkill'));
test(`mất kết nối PostgreSQL hai lần giữa tải (Hub tự thoát, khởi động lại): ${NAME}`, { skip: SKIP, timeout: 150000 }, (t) => scenario(t, 'pg'));

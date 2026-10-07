'use strict';
// spec: PHUB-S-024
// Lệnh kiểm cấu hình mà không chạy Hub (PHUB-D-024): gom mọi lỗi một lần, không mạng, không ghi cơ sở dữ liệu, mã thoát đúng.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkConfig, report, missingEnv } = require('../../src/check-config');
const { buildHub, buildInbound, checkMain } = require('../../src/main');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main.js');
const PG = process.env.HUB_TEST_DATABASE_URL || '';
const SKIP_PG = PG ? false : 'đặt HUB_TEST_DATABASE_URL để chạy test này';

const ENV = { HUB_API_TOKEN: 'tok', HUB_DATABASE_URL: 'postgres://u:p@10.255.255.1:1/none', M_P: 'P', M_A: 'a', M_S: 's' };
const base = (over = {}) => ({
  apiToken: '${HUB_API_TOKEN}', databaseUrl: '${HUB_DATABASE_URL}', publicBaseUrl: 'https://hub.example.com', metricsToken: 'm',
  hub: { gateways: [{ id: 'momo', priority: 1 }] },
  adapters: { momo: { partnerCode: '${M_P}', accessKey: '${M_A}', secretKey: '${M_S}', baseUrl: 'https://payment.momo.vn' } },
  ...over,
});
const check = (raw, env = ENV, opts = {}) => checkConfig(raw, env, { buildHub, buildInbound, discover: require('../../src/adapters/registry').discover, ...opts });

test('cấu hình hợp lệ: ok, tóm tắt cổng và cửa hàng, không có lỗi', async () => {
  const r = await check(base({ shops: [{ id: 's1', apiToken: 'x' }] }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.summary.gateways, ['momo']);
  assert.deepEqual(r.summary.shops, ['s1']);
  assert.equal(report(r, () => {}), 0);
});

test('thiếu biến môi trường: gom MỌI biến thiếu trong một lần chạy, nói rõ dùng ở đâu; cổng tắt không bắt buộc có bí mật', async () => {
  const raw = base({ adapters: { momo: { partnerCode: '${M_P}', accessKey: '${NOPE_A}', secretKey: '${NOPE_B}' }, onepay: { merchant: '${KHONG_BAT_BUOC}' } }, hub: { gateways: [{ id: 'momo' }, { id: 'onepay', enabled: false }] } });
  const r = await check(raw, { HUB_API_TOKEN: 't', HUB_DATABASE_URL: 'x', M_P: 'p' });
  assert.equal(r.ok, false);
  const text = r.errors.join('\n');
  assert.match(text, /NOPE_A \(dùng trong cấu hình adapters\.momo\.accessKey\)/);
  assert.match(text, /NOPE_B \(dùng trong cấu hình adapters\.momo\.secretKey\)/);
  assert.doesNotMatch(text, /KHONG_BAT_BUOC/);
  assert.equal(r.errors.length, 2);
  assert.equal(report(r, () => {}), 1);
});

test('biến có mặc định ${X:-} không bị coi là thiếu', () => {
  assert.deepEqual(missingEnv({ a: '${A:-}', b: '${B:-x}', c: '${C}' }, {}), [{ name: 'C', at: 'c' }]);
});

test('thiếu apiToken, databaseUrl, hub.gateways rỗng: báo từng lỗi', async () => {
  const r = await check({ hub: { gateways: [] } });
  assert.match(r.errors.join('\n'), /hub\.gateways phải là danh sách/);
  assert.match(r.errors.join('\n'), /thiếu apiToken/);
  assert.match(r.errors.join('\n'), /thiếu databaseUrl/);
});

test('mọi thứ làm Hub không khởi động đều được báo: cổng lạ, bảng mã lỗi sai, failover.skipOnFailCodes sai, maxAmount sai, cửa hàng trùng', async () => {
  const cases = [
    [base({ hub: { gateways: [{ id: 'khong-co' }] } }), /cổng không hỗ trợ: khong-co/],
    [base({ adapters: { momo: { partnerCode: 'P', accessKey: 'a', secretKey: 's', failCodeMap: { 1001: 'sai-ma' } } } }), /momo: failCodeMap\[1001\]/],
    [base({ hub: { gateways: [{ id: 'momo' }], failover: { skipOnFailCodes: ['nope'] } } }), /skipOnFailCodes/],
    [base({ hub: { gateways: [{ id: 'momo' }], maxAmount: 0 } }), /maxAmount/],
    [base({ shops: [{ id: 'a' }, { id: 'a' }] }), /shops: trùng id a/],
    [base({ adapters: { momo: {} } }), /momo/],
  ];
  for (const [raw, re] of cases) {
    const r = await check(raw);
    assert.equal(r.ok, false, String(re));
    assert.match(r.errors.join('\n'), re);
  }
});

test('nguồn vào Kafka mà không có tuyến ra nhận command.completed: báo lỗi (Hub sẽ không khởi động)', async () => {
  const raw = base({ connectors: { kafka: { brokers: ['k:9092'] }, in: [{ id: 'cmd', source: 'kafka', topic: 't', groupId: 'g', principal: { role: 'admin' } }] } });
  const r = await check(raw);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /không có tuyến ra nào nhận command\.completed/);
  const ok = await check(base({ connectors: { kafka: { brokers: ['k:9092'] }, out: [{ id: 'bus', sink: 'kafka', topic: 'e', types: ['payment.*', 'command.*'], shops: '*' }], in: [{ id: 'cmd', source: 'kafka', topic: 't', groupId: 'g', principal: { role: 'admin' } }] } }));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.summary.sourcesIn, ['cmd:kafka']);
});

test('không gọi mạng và không kết nối cơ sở dữ liệu khi không có --connect: địa chỉ DB không tới được vẫn ra hợp lệ, nhanh, fetch không bị gọi', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...a) => { calls += 1; return real(...a); };
  const t0 = Date.now();
  try { const r = await check(base()); assert.equal(r.ok, true); } finally { globalThis.fetch = real; }
  assert.equal(calls, 0);
  assert.ok(Date.now() - t0 < 3000, 'không chờ kết nối');
});

test('cảnh báo (không phải lỗi): publicBaseUrl trống hoặc không https, thiếu metricsToken, cổng đang trỏ môi trường thử', async () => {
  const r = await check(base({ publicBaseUrl: '', metricsToken: '', adapters: { momo: { partnerCode: 'P', accessKey: 'a', secretKey: 's', baseUrl: 'https://test-payment.momo.vn' } } }));
  assert.equal(r.ok, true);
  const w = r.warnings.join('\n');
  assert.match(w, /publicBaseUrl trống/);
  assert.match(w, /metricsToken trống/);
  assert.match(w, /cổng momo đang trỏ môi trường thử \(baseUrl\)/);
  const r2 = await check(base({ publicBaseUrl: 'http://hub.example.com' }));
  assert.match(r2.warnings.join('\n'), /không phải https/);
});

test('dòng lệnh: mã thoát 0 khi hợp lệ, 1 khi sai; tệp không đọc được hoặc không phải JSON cũng ra 1; không truyền tệp ra 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chk-'));
  try {
    const good = path.join(dir, 'good.json'); fs.writeFileSync(good, JSON.stringify(base()));
    const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, JSON.stringify(base({ hub: { gateways: [{ id: 'khong-co' }] } })));
    const junk = path.join(dir, 'junk.json'); fs.writeFileSync(junk, '{ không phải json');
    const run = (args, env = {}) => spawnSync(process.execPath, [MAIN, '--check-config', ...args], { env: { ...process.env, ...ENV, ...env }, encoding: 'utf8' });
    const g = run([good]); assert.equal(g.status, 0, g.stdout + g.stderr); assert.match(g.stdout, /OK\s+cấu hình hợp lệ/);
    const b = run([bad]); assert.equal(b.status, 1); assert.match(b.stdout, /LỖI\s+cổng không hỗ trợ/); assert.match(b.stdout, /KHÔNG HỢP LỆ: 1 lỗi/);
    const j = run([junk]); assert.equal(j.status, 1); assert.match(j.stdout, /không đọc được/);
    const n = run([path.join(dir, 'khong-co.json')]); assert.equal(n.status, 1);
    const h = spawnSync(process.execPath, [MAIN, '--check-config'], { env: { PATH: process.env.PATH }, encoding: 'utf8' }); assert.equal(h.status, 1); assert.match(h.stdout, /đặt HUB_CONFIG/);
    const viaEnv = run([], { HUB_CONFIG: good }); assert.equal(viaEnv.status, 0);
    const lines = []; assert.equal(await checkMain([good], ENV, (s) => lines.push(s)), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--connect: thử kết nối PostgreSQL bằng SELECT 1, không tạo schema; sai mật khẩu thì báo lỗi', { skip: SKIP_PG }, async () => {
  const { Client } = require('pg');
  const schema = `chk_${Math.random().toString(36).slice(2, 10)}`;
  const exists = async () => { const c = new Client({ connectionString: PG }); await c.connect(); const r = await c.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema]); await c.end(); return r.rowCount > 0; };
  const ok = await check(base({ databaseSchema: schema }), { ...ENV, HUB_DATABASE_URL: PG }, { connect: true });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.summary.database, 'kết nối được');
  assert.equal(await exists(), false, 'lệnh kiểm không được tạo schema đã khai trong cấu hình');
  const wrong = PG.replace(/:\/\/([^:]+):[^@]*@/, '://$1:mat-khau-sai@');
  const bad = await check(base(), { ...ENV, HUB_DATABASE_URL: wrong }, { connect: true });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /không kết nối được PostgreSQL/);
});

test('cấu hình thiếu khóa của MoMo và SePay bị bắt khi dựng (trước đây Hub khởi động rồi mới lỗi lúc chạy)', async () => {
  const { createMomoAdapter } = require('../../src/adapters/momo');
  const { createSepayAdapter } = require('../../src/adapters/sepay');
  assert.throws(() => createMomoAdapter({}), /momo: thiếu config partnerCode/);
  assert.throws(() => createMomoAdapter({ partnerCode: 'P', accessKey: 'a' }), /momo: thiếu config secretKey/);
  assert.throws(() => createSepayAdapter({}), /sepay: thiếu accountNumber/);
  assert.throws(() => createSepayAdapter({ accountNumber: '1' }), /sepay: thiếu bankName/);
  assert.throws(() => createSepayAdapter({ accountNumber: '1', bankName: 'B', authMode: 'hmac' }), /authMode hmac cần hmacSecret/);
  assert.throws(() => createSepayAdapter({ accountNumber: '1', bankName: 'B', authMode: 'apikey' }), /authMode apikey cần apiKey/);
  assert.throws(() => createSepayAdapter({ accountNumber: '1', bankName: 'B', authMode: 'oauth' }), /authMode không hợp lệ/);
  assert.doesNotThrow(() => createSepayAdapter({ accountNumber: '1', bankName: 'B', authMode: 'hmac', hmacSecret: 'x' }));
  // và qua lệnh kiểm cấu hình
  const r = await check(base({ adapters: { momo: { partnerCode: 'P' } } }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /momo: thiếu config accessKey/);
});

test('cảnh báo SePay: webhook không xác thực (authMode none hoặc bỏ trống) được nêu, có hmac thì không', async () => {
  const sepay = (a) => base({ hub: { gateways: [{ id: 'sepay' }] }, adapters: { sepay: { accountNumber: '1', bankName: 'B', ...a } } });
  assert.match((await check(sepay({}))).warnings.join('\n'), /sepay: authMode none/);
  assert.match((await check(sepay({ authMode: 'none' }))).warnings.join('\n'), /sepay: authMode none/);
  assert.doesNotMatch((await check(sepay({ authMode: 'hmac', hmacSecret: 'x' }))).warnings.join('\n'), /authMode none/);
});

test('adapter cố gọi mạng ngay khi dựng bị chặn: lệnh kiểm báo lỗi chứ không gọi thật', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-net-'));
  try {
    const fake = JSON.stringify(path.join(__dirname, '..', 'support', 'fake-adapter.js'));
    fs.writeFileSync(path.join(dir, 'netty.js'), `const { createFakeAdapter } = require(${fake});\nmodule.exports = { adapter: { id: 'netty', create: (cfg, deps) => { deps.fetch('http://127.0.0.1:1/x'); return createFakeAdapter('netty'); } } };`);
    const r = await check(base({ adapterDirs: [dir], hub: { gateways: [{ id: 'netty' }] }, adapters: { netty: {} } }));
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /check-config không gọi mạng/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

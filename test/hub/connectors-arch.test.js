'use strict';
// spec: PHUB-S-017
// Kiến trúc hai trục độc lập (PHUB-D-017): lớp kết nối dịch vụ không biết phía cổng thanh toán và ngược lại;
// thêm connector mới chỉ là thêm một tệp, không sửa tệp nào đang có.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}
// Các require nội bộ (đường dẫn tương đối) của một tệp, đã chuẩn hóa về đường dẫn tương đối từ src/.
function localRequires(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '');
  const out = [];
  for (const m of text.matchAll(/require\(\s*'(\.[^']*)'\s*\)/g)) out.push(path.relative(SRC, path.resolve(path.dirname(file), m[1])).replace(/\\/g, '/'));
  return out;
}

test('connectors/* chỉ được dùng cổng chuẩn (app/*) và nhau, không import lõi, kho, adapter cổng, guard, contract, events, server, main', () => {
  const FORBIDDEN = /^(hub|store|store-postgres|guard|contract|events|server|main|metrics|index|adapters(\/.*)?)(\.js)?$/;
  const offenders = [];
  for (const f of walk(path.join(SRC, 'connectors'))) {
    for (const r of localRequires(f)) {
      if (FORBIDDEN.test(r)) offenders.push(`${path.relative(SRC, f)} -> ${r}`);
      else if (!/^(app\/|connectors\/)/.test(r)) offenders.push(`${path.relative(SRC, f)} -> ${r} (ngoài app/ và connectors/)`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('lõi và phía cổng thanh toán (hub, events, store, guard, adapters) không import connectors/*, và app/* không import lõi', () => {
  const offenders = [];
  const core = [...['hub.js', 'events.js', 'store.js', 'store-postgres.js', 'guard.js', 'contract.js', 'metrics.js'].map((f) => path.join(SRC, f)), ...walk(path.join(SRC, 'adapters'))];
  for (const f of core) for (const r of localRequires(f)) if (r.startsWith('connectors')) offenders.push(`${path.relative(SRC, f)} -> ${r}`);
  for (const f of walk(path.join(SRC, 'app'))) for (const r of localRequires(f)) if (/^(hub|store|store-postgres|guard|contract|events|server|main|adapters)/.test(r) || r.startsWith('connectors')) offenders.push(`${path.relative(SRC, f)} -> ${r}`);
  assert.deepEqual(offenders, []);
});

test('thêm connector = thêm tệp: sink ra và nguồn vào đặt ở thư mục ngoài được registry nhận, không sửa tệp nào của Hub', () => {
  const { buildSinks, inboundKinds } = require('../../src/connectors/registry');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-conn-'));
  try {
    fs.mkdirSync(path.join(dir, 'out'));
    fs.mkdirSync(path.join(dir, 'in'));
    fs.writeFileSync(path.join(dir, 'out', 'nats.js'), "module.exports = { kind: 'nats', create: () => ({ kind: 'nats', ordered: true, validate() {}, async deliver() { return {}; } }) };");
    fs.writeFileSync(path.join(dir, 'in', 'nats.js'), "module.exports = { kind: 'nats', create: () => ({ kind: 'nats', start() {}, stop() {} }) };");
    const before = Object.keys(buildSinks({}));
    const after = buildSinks({}, { extraDirs: [dir] });
    assert.deepEqual(before.sort(), ['kafka', 'webhook']);
    assert.deepEqual(Object.keys(after).sort(), ['kafka', 'nats', 'webhook']);
    assert.equal(after.nats.ordered, true);
    assert.ok(inboundKinds({ extraDirs: [dir] }).has('nats'));
    // trùng kind với connector sẵn có là lỗi rõ ràng, không ghi đè ngầm
    fs.writeFileSync(path.join(dir, 'out', 'dup.js'), "module.exports = { kind: 'webhook', create: () => ({}) };");
    assert.throws(() => buildSinks({}, { extraDirs: [dir] }), /trùng kind "webhook"/);
    // tệp không đúng hợp đồng bị từ chối
    fs.rmSync(path.join(dir, 'out', 'dup.js'));
    fs.writeFileSync(path.join(dir, 'out', 'bad.js'), 'module.exports = {};');
    assert.throws(() => buildSinks({}, { extraDirs: [dir] }), /phải xuất \{kind, create\}/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('connector mới (tệp ngoài cây mã nguồn) chạy được trọn đường: tuyến cấu hình -> hộp thư đi -> sink', async () => {
  const { buildHub } = require('../../src/main');
  const { MemoryStore } = require('../../src/store');
  const { createFakeAdapter } = require('../support/fake-adapter');
  void createFakeAdapter;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-conn-'));
  try {
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(path.join(dir, 'out', 'memo.js'), "const seen = (globalThis.__memoSink = []); module.exports = { kind: 'memo', create: () => ({ kind: 'memo', ordered: false, validate(r, n) { if (!r.label) throw new Error(n + '.label bắt buộc'); }, async deliver(d, r) { seen.push({ id: d.id, type: d.type, label: r.label }); return {}; } }) };");
    const cfg = (out) => ({ hub: { gateways: [{ id: 'momo' }] }, adapters: { momo: { partnerCode: 'X', accessKey: 'a', secretKey: 'b', endpoint: 'http://127.0.0.1:1' } }, connectors: { dirs: [dir], out }, databaseUrl: 'unused' });
    await assert.rejects(buildHub(cfg([{ id: 'm', sink: 'memo' }]), {}, { store: new MemoryStore() }), /label bắt buộc/);
    const { hub } = await buildHub(cfg([{ id: 'm', sink: 'memo', label: 'L1', types: ['demo.*'] }]), {}, { store: new MemoryStore() });
    hub.events.emit('demo.created', 'o1', 1, { x: 1 });
    hub.events.emit('other.created', 'o2', 1, { x: 1 });
    await hub.deliverWebhooks();
    assert.deepEqual(globalThis.__memoSink.map((x) => [x.type, x.label]), [['demo.created', 'L1']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__memoSink; }
});

test('port có kiểu thật và được kiểm hình dạng: sink thiếu hàm/ordered, sink.kind lệch, nguồn vào thiếu start/stop, hub thiếu hàm đều bị từ chối rõ ràng', async () => {
  const { assertSink, assertHubPort, assertInbound } = require('../../src/app/ports');
  const { createApp } = require('../../src/app/app');
  const { EventOutbox } = require('../../src/events');
  const { MemoryStore } = require('../../src/store');
  const { buildSinks } = require('../../src/connectors/registry');
  const good = { kind: 'x', ordered: false, validate() {}, async deliver() { return {}; } };
  assert.equal(assertSink(good), true);
  assert.throws(() => assertSink({ ...good, deliver: undefined }), /thiếu hàm deliver/);
  assert.throws(() => assertSink({ ...good, validate: undefined }), /thiếu hàm validate/);
  assert.throws(() => assertSink({ ...good, ordered: undefined }), /thiếu ordered/);
  assert.throws(() => assertSink({ ...good, kind: '' }), /thiếu kind/);
  assert.throws(() => assertSink(null), /sink rỗng/);
  // hộp thư đi từ chối sink sai hình dạng ngay khi dựng (không đợi tới lúc có sự kiện)
  const mk = (sink) => new EventOutbox({ store: new MemoryStore(), clock: { now: () => 1 }, sinks: { x: sink }, config: { routes: [{ id: 'r', sink: 'x' }] } });
  assert.doesNotThrow(() => mk(good));
  assert.throws(() => mk({ ...good, deliver: undefined }), /thiếu hàm deliver/);
  // mô-đun connector dựng ra sink lệch kind
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-port-'));
  try {
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(path.join(dir, 'out', 'lech.js'), "module.exports = { kind: 'lech', create: () => ({ kind: 'khac', ordered: false, validate() {}, async deliver() { return {}; } }) };");
    assert.throws(() => buildSinks({}, { extraDirs: [dir] }), /sink\.kind \(khac\) khác kind của mô-đun/);
    fs.rmSync(path.join(dir, 'out', 'lech.js'));
    fs.writeFileSync(path.join(dir, 'out', 'thieu.js'), "module.exports = { kind: 'thieu', create: () => ({ kind: 'thieu', ordered: true, validate() {} }) };");
    assert.throws(() => buildSinks({}, { extraDirs: [dir] }), /connectors\/out\/thieu.*thiếu hàm deliver/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(assertInbound({ start() {}, stop() {} }), true);
  assert.throws(() => assertInbound({ start() {} }), /thiếu hàm stop/);
  // hub không đủ hình dạng HubPort: app từ chối ở lần dùng đầu, nói rõ thiếu gì
  assert.throws(() => assertHubPort({ events: { emit() {} }, store: {} }), /thiếu hàm transact/);
  assert.throws(() => assertHubPort({ store: {} }), /thiếu events\.emit/);
  const app = createApp({ hub: { events: { emit() {} }, store: {} } });
  await assert.rejects(app.execute('getPayment', { paymentId: 'x' }, { role: 'admin' }), /HubPort: thiếu hàm/);
  // PaymentHub thật đúng hình dạng của port
  const { PaymentHub } = require('../../src/hub');
  const { createFakeAdapter } = require('../support/fake-adapter');
  const hub = new PaymentHub({ adapters: { a: createFakeAdapter('a') }, config: { gateways: [{ id: 'a' }] } });
  assert.equal(assertHubPort(hub), true);
});

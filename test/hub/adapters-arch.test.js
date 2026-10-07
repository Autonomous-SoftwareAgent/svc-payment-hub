'use strict';
// spec: PHUB-S-004
// spec: PHUB-S-021
// spec: PHUB-S-023
// spec: PHUB-S-029
// Hướng phụ thuộc (import) của phía cổng thanh toán, một chiều: adapter -> contract <- lõi; chỉ điểm nối (main.js, index.js) biết cả hai.
// Khác với luồng chạy (lõi gọi adapter qua hợp đồng, IPN đi qua adapter về lõi). Test quét import thật trong mã nguồn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
function localRequires(file) {
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const m of text.matchAll(/require\(\s*'(\.[^']*)'\s*\)/g)) out.push(path.relative(SRC, path.resolve(path.dirname(file), m[1])).replace(/\\/g, '/'));
  return out;
}
const rel = (f) => path.relative(SRC, f).replace(/\\/g, '/');

const CORE = ['hub.js', 'routing.js', 'events.js', 'store.js', 'store-postgres.js', 'guard.js', 'metrics.js', 'contract.js'].map((f) => path.join(SRC, f));
const ADAPTER_DIRS = fs.readdirSync(path.join(SRC, 'adapters'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
// Mọi tên cổng lấy từ thư mục adapter (thêm cổng thì tự có mặt ở đây). Dùng String.raw: trong template literal thường, \b là ký tự backspace chứ không phải
// ranh giới từ, biểu thức sẽ không bao giờ khớp và test không giữ được gì (đã từng sai như vậy ở test quét tên cổng của PHUB-S-004).
const GATEWAY_NAMES = new RegExp(String.raw`\b(${ADAPTER_DIRS.join('|')})\b`, 'i');

test('có đủ adapter để kiểm (tránh test rỗng)', () => {
  assert.ok(ADAPTER_DIRS.length >= 4, ADAPTER_DIRS.join(','));
});

test('lõi không import adapter, kết nối dịch vụ, server hay main', () => {
  const offenders = [];
  for (const f of CORE) for (const r of localRequires(f)) if (/^(adapters|connectors|server|main|index)(\/|\.js|$)/.test(r)) offenders.push(`${rel(f)} -> ${r}`);
  assert.deepEqual(offenders, []);
});

test('hợp đồng (contract.js) không import gì: mọi tầng cùng hướng vào nó, nó không hướng vào ai', () => {
  assert.deepEqual(localRequires(path.join(SRC, 'contract.js')), []);
});

test('mỗi adapter chỉ import thư mục của chính nó, bảng mã lỗi dùng chung (fail-codes) và hợp đồng: không import adapter anh em, lõi, kho, bảo vệ, connector, app', () => {
  const offenders = [];
  for (const d of ADAPTER_DIRS) {
    for (const f of walk(path.join(SRC, 'adapters', d))) {
      for (const r of localRequires(f)) {
        const own = r.startsWith(`adapters/${d}/`) || r === `adapters/${d}`;
        const shared = r === 'adapters/fail-codes' || r === 'contract';
        if (!own && !shared) offenders.push(`${rel(f)} -> ${r}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('phần dùng chung giữa các adapter (fail-codes) chỉ phụ thuộc hợp đồng', () => {
  assert.deepEqual(localRequires(path.join(SRC, 'adapters', 'fail-codes.js')), ['contract']);
});

test('chỉ điểm nối (main.js, index.js) import adapter ở ngoài thư mục adapters', () => {
  const importers = walk(SRC).filter((f) => !f.includes(`${path.sep}adapters${path.sep}`)).filter((f) => localRequires(f).some((r) => r.startsWith('adapters/'))).map(rel).sort();
  assert.deepEqual(importers, ['index.js', 'main.js']);
});

test('lõi không có tên cổng nào viết cứng (bỏ chú thích): adapter được đưa vào lúc khởi động, routing chỉ đọc id từ cấu hình', () => {
  const NAMES = GATEWAY_NAMES;
  const offenders = [];
  for (const f of CORE) { const m = stripComments(fs.readFileSync(f, 'utf8')).match(NAMES); if (m) offenders.push(`${rel(f)}: ${m[0]}`); }
  assert.deepEqual(offenders, []);
});

test('registry adapter không import gì trong dự án (chỉ mô-đun có sẵn của Node): nó không biết cổng nào', () => {
  assert.deepEqual(localRequires(path.join(SRC, 'adapters', 'registry.js')), []);
});

test('điểm nối (main.js, index.js) không chứa tên cổng nào viết cứng (bỏ chú thích): thêm cổng không phải sửa chúng', () => {
  const NAMES = GATEWAY_NAMES;
  const offenders = [];
  for (const f of ['main.js', 'index.js'].map((x) => path.join(SRC, x))) { const m = stripComments(fs.readFileSync(f, 'utf8')).match(NAMES); if (m) offenders.push(`${rel(f)}: ${m[0]}`); }
  assert.deepEqual(offenders, []);
});

test('routing là module riêng chỉ biết hợp đồng: không import Hub, kho, bảo vệ, adapter hay connector (nhận adapter và hàm khả dụng từ Hub)', () => {
  assert.deepEqual(localRequires(path.join(SRC, 'routing.js')), ['contract']);
});

// spec: PHUB-S-004
// Lõi và các lớp ngoài adapter không được biết riêng cổng nào: tên cổng viết cứng trong mã (ngoài chú thích) nghĩa là có rẽ nhánh theo cổng.
// Test này bắt cái test import ở trên không bắt được (một chuỗi 'sepay' không phải là import).
test('lõi, app, server, main, check-config và connector không viết cứng tên cổng nào', () => {
  const files = [...CORE, ...['check-config.js', 'main.js', 'server.js', 'index.js'].map((f) => path.join(SRC, f)), ...walk(path.join(SRC, 'app')), ...walk(path.join(SRC, 'connectors'))];
  const ids = GATEWAY_NAMES;
  const offenders = [];
  for (const f of files) {
    stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => { if (ids.test(line)) offenders.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  assert.deepEqual(offenders, []);
});

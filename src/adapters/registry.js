'use strict';
// spec: PHUB-S-023
// Registry adapter (PHUB-D-023): THÊM MỚI, KHÔNG SỬA CŨ, giống registry connector (PHUB-D-017). Mỗi cổng là một thư mục trong
// src/adapters/ có index.js xuất `adapter = {id, create(config, deps)}`; registry quét thư mục nên thêm cổng không phải sửa tệp nào đang có.
// Thư mục ngoài cây mã nguồn (cấu hình adapterDirs) cũng được quét, nhận cả thư mục có index.js lẫn tệp .js đơn.
// Adapter có thể xuất thêm configWarnings(cfg) -> string[]: cảnh báo cấu hình riêng của cổng mà check-config in ra (lõi không biết nội dung).
// deps = {fetch, clock, publicBaseUrl}: điểm nối đưa vào; mỗi adapter tự quyết định dùng gì (ví dụ MoMo lấy ipnUrl mặc định từ publicBaseUrl).

const fs = require('node:fs');
const path = require('node:path');

const SHARED_FILES = new Set(['registry.js', 'fail-codes.js']); // tệp dùng chung ở gốc thư mục adapters, không phải adapter

function load(file, label) {
  const mod = require(file);
  const a = mod && mod.adapter;
  if (!a || typeof a !== 'object') throw new Error(`adapter ${label}: phải xuất adapter = {id, create}`);
  if (typeof a.id !== 'string' || !a.id) throw new Error(`adapter ${label}: adapter.id phải là chuỗi khác rỗng`);
  if (typeof a.create !== 'function') throw new Error(`adapter ${label}: adapter.create phải là hàm`);
  return a;
}

/** @returns {Map<string, {id:string, create:Function, configWarnings?:Function, source:string}>} */
function discover(extraDirs = []) {
  const found = new Map();
  const add = (a, source) => {
    if (found.has(a.id)) throw new Error(`adapter: trùng id "${a.id}" (${source} và ${found.get(a.id).source})`);
    found.set(a.id, { id: a.id, create: a.create, configWarnings: a.configWarnings, source });
  };
  const builtin = __dirname;
  for (const e of fs.readdirSync(builtin, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    const file = path.join(builtin, e.name, 'index.js');
    if (fs.existsSync(file)) add(load(file, e.name), `adapters/${e.name}`);
  }
  for (const d of extraDirs) {
    const dir = path.resolve(d);
    if (!fs.existsSync(dir)) throw new Error(`adapterDirs: không có thư mục ${dir}`);
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      let file = null;
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'index.js'))) file = path.join(dir, e.name, 'index.js');
      else if (e.isFile() && e.name.endsWith('.js') && !SHARED_FILES.has(e.name)) file = path.join(dir, e.name);
      if (file) add(load(file, `${dir}/${e.name}`), `${dir}/${e.name}`);
    }
  }
  return found;
}

module.exports = { discover };

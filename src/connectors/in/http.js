'use strict';
// spec: PHUB-S-017
// Connector vào HTTP (PHUB-D-008, D-017): bảng route sinh từ danh mục thao tác (app.operations()), không viết tay từng route.
// Chỉ làm việc dịch: đường dẫn + query + thân JSON -> {op, input} rồi app.execute; kết quả -> {status, body}.
// Xác thực (Bearer), giới hạn tải, mã yêu cầu, nhật ký truy cập là việc của máy chủ HTTP (server.js) vì dùng chung với /health, /metrics
// và callback của cổng thanh toán (trục cổng, không đi qua danh mục thao tác).
// Không import lõi: chỉ nhận `app` qua tham số.

function compile(path) {
  const names = [];
  const re = new RegExp('^' + path.replace(/\{([A-Za-z]+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { re, names, label: path.replace(/\{[A-Za-z]+\}/g, '{id}') };
}

/** @param {{app: import('../../app/app').App}} o */
function create({ app }) {
  const table = [];
  for (const [name, op] of Object.entries(app.operations())) {
    const b = op.bindings && op.bindings.http;
    if (b) table.push({ name, op, method: b.method, binding: b, ...compile(b.path) });
  }

  /** Tìm thao tác khớp (method, pathname): {name, params, label} hoặc null. Không phụ thuộc xác thực. */
  function match(method, pathname) {
    for (const r of table) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return { name: r.name, label: r.label, route: r, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }

  // Query luôn là chuỗi: ép về số khi schema đầu vào khai báo integer (giá trị hỏng giữ nguyên để schema từ chối).
  function coerce(schema, query) {
    const out = {};
    for (const [k, v] of Object.entries(query)) {
      const t = schema.properties && schema.properties[k] && schema.properties[k].type;
      out[k] = t === 'integer' && /^-?\d+$/.test(v) ? Number(v) : v;
    }
    return out;
  }

  /** Chạy một thao tác đã khớp; trả {status, body}. Lỗi của thao tác được ném nguyên cho máy chủ ánh xạ sang HTTP. */
  async function handle(found, { query = {}, body = {}, principal }) {
    const { op, binding, method } = found.route;
    const input = method === 'GET' ? { ...coerce(op.input, query), ...found.params } : { ...body, ...found.params };
    const out = await app.execute(found.name, input, principal);
    return { status: binding.status ? binding.status(out) : binding.statuses[0], body: out };
  }

  return { kind: 'http', match, handle, routes: table.map((r) => ({ method: r.method, path: r.binding.path, op: r.name })) };
}

/** @type {import('../../app/ports').InboundModule} */
module.exports = { kind: 'http', create };

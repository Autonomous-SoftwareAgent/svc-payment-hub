'use strict';
// Luật: hướng import một chiều của phía cổng thanh toán (CLAUDE.md "Quy tắc riêng", CONVENTIONS.md, test/hub/adapters-arch.test.js).
//   adapter -> contract <- lõi; chỉ main.js và index.js biết cả hai phía.
// Đây là lớp NHẮC SỚM: luật chỉ thấy phần sắp ghi (ctx.action.text), nên một lần Edit không chạm dòng require thì luật không thấy gì.
// Lưới chính vẫn là test/hub/adapters-arch.test.js (đừng sửa test để cho qua).
const path = require('node:path');

const CORE = ['hub.js', 'routing.js', 'events.js', 'store.js', 'store-postgres.js', 'guard.js', 'metrics.js'];
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// Các import nội bộ (đường dẫn tương đối) trong văn bản, đổi sang đường dẫn tính từ src/, bỏ đuôi .js.
function localRequires(file, text) {
  const out = [];
  for (const m of strip(text).matchAll(/require\(\s*['"](\.[^'"]*)['"]\s*\)/g)) {
    const t = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    if (t.startsWith('src/')) out.push(t.slice(4).replace(/\.js$/, ''));
  }
  return out;
}

module.exports = {
  id: 'ranh-gioi-import',
  api: '1.0',
  on: ['before-action'],
  run(ctx) {
    const file = ctx.action.file;
    if (!/^src\/.+\.js$/.test(file) || !ctx.action.text) return null;
    const f = file.slice(4);
    const reqs = localRequires(file, ctx.action.text);
    if (!reqs.length) return null;
    let bad = [];
    let why = '';
    if (f === 'contract.js') {
      bad = reqs;
      why = 'contract.js không import gì trong dự án: mọi tầng cùng hướng vào nó, nó không hướng vào ai.';
    } else if (f === 'adapters/registry.js') {
      bad = reqs;
      why = 'registry adapter không import gì trong dự án: nó không biết cổng nào.';
    } else if (f === 'adapters/fail-codes.js' || f === 'routing.js') {
      bad = reqs.filter((r) => r !== 'contract');
      why = `${f} chỉ phụ thuộc hợp đồng (contract).`;
    } else if (CORE.includes(f)) {
      bad = reqs.filter((r) => /^(adapters|connectors|server|main|index)(\/|$)/.test(r));
      why = 'Lõi không import adapter, connector, server hay main: lõi chỉ biết hợp đồng chuẩn; adapter được đưa vào lúc khởi động.';
    } else if (/^adapters\/[^/]+\//.test(f)) {
      const d = f.split('/')[1];
      bad = reqs.filter((r) => !(r === `adapters/${d}` || r.startsWith(`adapters/${d}/`) || r === 'adapters/fail-codes' || r === 'contract'));
      why = `Adapter ${d} chỉ import thư mục của chính nó, adapters/fail-codes và contract: không import adapter anh em, lõi, kho, bảo vệ, connector hay app.`;
    }
    if (!bad.length) return null;
    return ctx.block(`${file} import trái ranh giới ba lớp (${[...new Set(bad)].map((r) => `src/${r}`).join(', ')}). ${why} Xem docs/agent/CONVENTIONS.md và test/hub/adapters-arch.test.js; đừng sửa test để cho qua.`);
  },
};

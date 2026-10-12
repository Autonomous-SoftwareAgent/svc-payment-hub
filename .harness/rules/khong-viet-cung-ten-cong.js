'use strict';
// Luật: lõi, app, server, main, index, check-config và connector KHÔNG viết cứng tên cổng nào (ngoài chú thích). Viết cứng tên cổng nghĩa là có rẽ nhánh
// theo cổng; thêm cổng là thêm một thư mục adapter, không sửa các tệp này (CLAUDE.md "Quy tắc riêng", test/hub/adapters-arch.test.js).
// Tên cổng lấy từ chính các thư mục trong src/adapters/ lúc chạy, nên cổng mới tự có mặt. Lớp nhắc sớm; luật chỉ thấy phần sắp ghi.
const CORE = ['hub.js', 'routing.js', 'events.js', 'store.js', 'store-postgres.js', 'guard.js', 'metrics.js', 'contract.js', 'check-config.js', 'main.js', 'server.js', 'index.js'];
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

module.exports = {
  id: 'khong-viet-cung-ten-cong',
  api: '1.0',
  on: ['before-action'],
  run(ctx) {
    const file = ctx.action.file;
    if (!/^src\/.+\.js$/.test(file) || !ctx.action.text) return null;
    const f = file.slice(4);
    if (!(CORE.includes(f) || f.startsWith('app/') || f.startsWith('connectors/'))) return null;
    let names = [];
    try { names = ctx.fs.list('src/adapters').filter((n) => !n.includes('.')); } catch { return null; }
    if (!names.length) return null;
    const re = new RegExp(String.raw`\b(${names.map((n) => n.replace(/[^\w-]/g, '')).join('|')})\b`, 'i');
    const hits = [];
    strip(ctx.action.text).split('\n').forEach((line, i) => { const m = re.exec(line); if (m) hits.push(`dòng ${i + 1}: ${m[0]}`); });
    if (!hits.length) return null;
    return ctx.block(`${file} viết cứng tên cổng (${hits.slice(0, 3).join('; ')}). Lõi và các lớp ngoài adapter không được biết riêng cổng nào: đưa phần riêng của cổng vào src/adapters/<cổng>/, hoặc đọc id từ cấu hình. Chú thích thì được. Xem CONVENTIONS.md và test/hub/adapters-arch.test.js.`);
  },
};

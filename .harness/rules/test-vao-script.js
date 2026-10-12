'use strict';
// Luật: script `npm test` liệt kê từng thư mục test; thư mục không có trong đó thì KHÔNG chạy, kể cả ở CI, và lỗi ở đó không bị bắt (đã gặp: P-010, cả test của
// Stripe bị bỏ sót; suýt lặp lại với PayPal). Hai tình huống:
//   - ghi package.json có dòng "test" mà thiếu một thư mục test/<x>: CHẶN;
//   - ghi test/<x>/*.test.js mà script chưa có test/<x>/: NHẮC (thường tạo test trước rồi mới sửa package.json).
// Thư mục test/support chỉ chứa đồ dùng, không phải test.
const script = (text) => { const m = /"test"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text || ''); return m ? m[1] : null; };

module.exports = {
  id: 'test-vao-script',
  api: '1.0',
  on: ['before-action'],
  run(ctx) {
    const file = ctx.action.file;
    if (file === 'package.json') {
      const s = script(ctx.action.text);
      if (s === null) return null;
      let dirs = [];
      try { dirs = ctx.fs.list('test').filter((n) => !n.includes('.') && n !== 'support'); } catch { return null; }
      const missing = dirs.filter((d) => !s.includes(`test/${d}/`));
      if (!missing.length) return null;
      return ctx.block(`Script "test" trong package.json thiếu thư mục test (${missing.map((d) => `test/${d}`).join(', ')}): test ở đó sẽ KHÔNG chạy và lỗi không bị bắt (P-010). Thêm "test/<thư mục>/*.test.js" vào script.`);
    }
    const m = /^test\/([^/]+)\/[^/]+\.test\.js$/.exec(file);
    if (!m || m[1] === 'support') return null;
    let pkg = '';
    try { pkg = ctx.fs.read('package.json'); } catch { return null; }
    const s = script(pkg);
    if (s === null || s.includes(`test/${m[1]}/`)) return null;
    return ctx.note(`Thư mục test/${m[1]} chưa có trong script "test" của package.json: nhớ thêm "test/${m[1]}/*.test.js", không thì test này không chạy (P-010).`);
  },
};

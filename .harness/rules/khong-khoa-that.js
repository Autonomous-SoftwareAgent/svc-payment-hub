'use strict';
// Luật: không ghi khóa thật của cổng hay khóa riêng vào tệp nào của dịch vụ. Chỉ ghi TÊN biến môi trường (ví dụ STRIPE_SECRET_KEY); giá trị nằm ở cấu hình
// của máy chủ. Khóa thử (chứa "test", "not_real", "do_not_use") thì được. Mẫu cố ý ngắn: chặn khóa live và khóa riêng, không đoán mọi loại bí mật.
const PEM = new RegExp('-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----');
const LIVE = /\b[sr]k_live_[A-Za-z0-9]{8,}/;
const WHSEC = /\bwhsec_[A-Za-z0-9]{20,}/;

module.exports = {
  id: 'khong-khoa-that',
  api: '1.0',
  on: ['before-action'],
  run(ctx) {
    const file = ctx.action.file;
    if (!file || file.startsWith('node_modules/') || !ctx.action.text) return null;
    const t = ctx.action.text;
    const kinds = [];
    if (LIVE.test(t)) kinds.push('khóa live của cổng');
    if (WHSEC.test(t)) kinds.push('khóa ký webhook');
    if (PEM.test(t)) kinds.push('khóa riêng (PEM)');
    if (!kinds.length) return null;
    return ctx.block(`${file} có vẻ chứa bí mật thật (${kinds.join(', ')}). Không ghi bí mật vào mã, tài liệu hay nhật ký: chỉ ghi tên biến môi trường, giá trị do người dùng nhập ở máy chủ hoặc Secrets. Khóa dùng cho test phải là khóa giả (ví dụ chứa test, not_real).`);
  },
};

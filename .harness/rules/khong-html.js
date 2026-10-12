'use strict';
// Luật: trong repo của dịch vụ chỉ có Markdown và dữ liệu cho agent, không có HTML. Bản cho người đọc là trang trên cổng do bộ sinh dựng từ mã và tài liệu
// đã commit (CLAUDE.md "Tài liệu của dịch vụ"). Simulator và test dùng chuỗi, không cần tệp HTML.
module.exports = {
  id: 'khong-html',
  api: '1.0',
  on: ['before-action'],
  run(ctx) {
    const hit = ctx.action.writes.filter((p) => /\.html?$/i.test(p) && !p.startsWith('node_modules/'));
    if (!hit.length) return null;
    return ctx.block(`Không đặt HTML trong repo payment-hub (${hit.join(', ')}). Dịch vụ chỉ giữ Markdown và dữ liệu cho agent; trang cho người đọc do cổng dựng từ mã và docs/service.yaml đã commit. Cần đổi trang thì ghi yêu cầu vào docs/handoff/ cho phiên harness.`);
  },
};

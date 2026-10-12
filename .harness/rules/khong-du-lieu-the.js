'use strict';
// Luật: Hub không nhận, không lưu, không chuyển dữ liệu thẻ (số thẻ, CVV, tên chủ thẻ, hạn thẻ). Khách nhập thẻ trên trang của cổng (Checkout, trang PayPal);
// Hub chỉ giữ mã tham chiếu và số tiền (PHUB-S-004, PCI). Trước nay chỉ kiểm bằng quét một lần; luật này chặn từ lúc ghi mã nguồn trong src/.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const CARD = /\b(card_?number|card_?no|cvv2?|cvc2?|card_?holder(_?name)?|pan|exp(iry)?_?(month|year|date))\b/i;

module.exports = {
  id: 'khong-du-lieu-the',
  api: '1.0',
  on: ['before-action'],
  run(ctx) {
    const file = ctx.action.file;
    if (!/^src\/.+\.js$/.test(file) || !ctx.action.text) return null;
    const hits = [];
    strip(ctx.action.text).split('\n').forEach((line, i) => { const m = CARD.exec(line); if (m) hits.push(`dòng ${i + 1}: ${m[0]}`); });
    if (!hits.length) return null;
    return ctx.block(`${file} có trường dữ liệu thẻ (${hits.slice(0, 3).join('; ')}). Hub không nhận hay lưu số thẻ, CVV, tên chủ thẻ, hạn thẻ: dùng trang thanh toán do cổng lưu trữ và chỉ giữ mã tham chiếu (PHUB-S-004). Nếu đây là tên biến khác nghĩa, đổi tên cho khác.`);
  },
};

'use strict';
// spec: PHUB-S-020
// Bảng dịch mã riêng của cổng sang mã lý do thất bại CHUẨN (PHUB-D-020).
// Chỉ quyết định LÝ DO hiển thị và đo đếm, không bao giờ quyết định có tiền hay không: loại sự kiện (succeeded, failed, pending...)
// vẫn do code của adapter quyết định, nên cấu hình sai không thể biến thất bại thành thành công.
// Mã chưa có trong bảng ra 'unknown' (mặc định an toàn), không bao giờ đoán.
const { FAIL_CODES } = require('../contract');

/**
 * @param {string} gateway id adapter (để báo lỗi rõ ràng)
 * @param {Object<string,string>} defaults bảng mặc định của adapter: mã gốc -> mã chuẩn
 * @param {Object<string,string>} [override] adapters.<id>.failCodeMap: ghi đè hoặc bổ sung, thắng bảng mặc định
 * @returns {(code:*)=>import('../contract').FailCode}
 */
function createFailCodeMapper(gateway, defaults, override) {
  if (override !== undefined && (override === null || typeof override !== 'object' || Array.isArray(override))) throw new Error(`${gateway}: failCodeMap phải là đối tượng {mã gốc: mã chuẩn}`);
  const table = new Map();
  for (const [src, label] of [[defaults, 'mặc định'], [override || {}, 'failCodeMap']]) {
    for (const [code, fc] of Object.entries(src)) {
      if (!FAIL_CODES.includes(fc)) throw new Error(`${gateway}: ${label}[${code}]="${fc}" không phải mã chuẩn (${FAIL_CODES.join(', ')})`);
      table.set(String(code), fc);
    }
  }
  return (code) => (code === undefined || code === null ? 'unknown' : table.get(String(code)) || 'unknown');
}

module.exports = { createFailCodeMapper };

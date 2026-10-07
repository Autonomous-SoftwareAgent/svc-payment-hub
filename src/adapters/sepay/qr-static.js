'use strict';
// spec: SEPY-S-001
// spec: SEPY-S-002
// spec: SEPY-S-003
// spec: PHUB-S-029
// Sản phẩm A (product "qr-static"): một tài khoản chung, nội dung chuyển khoản mang mã attempt. Xem SEPY-D-001..003.
// - createPayment không gọi mạng: chỉ trả hướng dẫn chuyển khoản (SEPY-D-003).
// - Khớp giao dịch với attempt CHỈ qua mã trong `code` hoặc `content` (SEPY-D-002 S1, S2, S3); không khớp -> unmatched.
const MAX_LEN = 30;

function createQrStatic(ctx, bank) {
  const { cfg, prefix } = ctx;

  // Các hàng sao kê (thô) thuộc attempt: tìm theo q rồi kiểm cả content theo ranh giới ký tự (BSNABC1 không được khớp nhầm BSNABC12).
  async function collectRows(attemptRef) {
    const want = String(attemptRef || '').toUpperCase();
    if (!/^[A-Z0-9]+$/.test(want)) return { rows: [] }; // không thể là mã do createPayment sinh
    const rows = [];
    for (let page = 1; page <= 20; page += 1) {
      const r = await bank.apiGet('/transactions', { q: attemptRef, per_page: 100, page });
      if (r.error) return { error: true };
      for (const row of r.json.data) {
        const ev = bank.eventFromApiRow(row, 'query');
        if (!ev) continue;
        const byContent = new RegExp(`(^|[^A-Z0-9])${want}($|[^A-Z0-9])`).test(String(row.transaction_content || '').toUpperCase());
        if (ev.attemptRef === want || byContent) rows.push(row);
      }
      const pg = r.json.meta && r.json.meta.pagination;
      if (!pg || !pg.has_more) break;
    }
    return { rows };
  }

  return {
    product: 'qr-static',
    maxLength: MAX_LEN,

    capabilities() {
      // SEPY-D-003
      return {
        hardExpiry: 'none', cancellable: false, queryable: true, refundable: cfg.refundApi ? 'api' : 'manual', refundAsync: true, createCanTimeout: false,
        currencies: ['VND'], regions: ['VN'], methods: ['bank_transfer'],
        referenceFormat: { prefix: cfg.codePrefix, maxLength: MAX_LEN, caseInsensitive: true },
      };
    },

    async createPayment(p) {
      const ref = typeof p.attemptRef === 'string' ? p.attemptRef : '';
      if (!/^[A-Za-z0-9]+$/.test(ref)) return { status: 'rejected', reason: 'attemptRef chỉ được gồm A-Z0-9', failCode: 'invalid_request' };
      if (ref.length > MAX_LEN) return { status: 'rejected', reason: `attemptRef dài quá ${MAX_LEN} ký tự`, failCode: 'invalid_request' };
      if (!ref.toUpperCase().startsWith(prefix) || ref.length <= prefix.length) return { status: 'rejected', reason: `attemptRef phải bắt đầu bằng ${prefix} và có hậu tố`, failCode: 'invalid_request' };
      if (!Number.isInteger(p.amount) || p.amount <= 0) return { status: 'rejected', reason: 'amount phải là số nguyên VND dương', failCode: 'invalid_request' };
      const content = ref.toUpperCase();
      const bankName = cfg.bankName || cfg.bankCode;
      const q = `acc=${encodeURIComponent(cfg.accountNumber)}&bank=${encodeURIComponent(bankName)}&amount=${p.amount}&des=${encodeURIComponent(content)}`;
      return {
        status: 'instructions',
        instructions: {
          bank: bankName, accountNumber: cfg.accountNumber, accountName: cfg.accountName, transferContent: content, amount: p.amount,
          qrUrl: `${cfg.qrBaseUrl}${cfg.qrBaseUrl.includes('?') ? '&' : '?'}${q}`,
        },
      };
    },

    collectRows,

    async query(p) {
      const want = String(p.attemptRef || '').toUpperCase();
      const r = await collectRows(p.attemptRef);
      if (r.error) return { state: 'unknown' };
      const events = r.rows.map((row) => { const ev = bank.eventFromApiRow(row, 'query'); ev.attemptRef = want; delete ev.unmatched; return ev; });
      return events.length ? events : { state: 'not_found' };
    },
  };
}

module.exports = { createQrStatic };

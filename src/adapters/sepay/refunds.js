'use strict';
// spec: SEPY-S-004
// spec: SEPY-S-007
// Hoàn tiền qua Refunds API v2 của SePay cho sản phẩm A và B (chỉ khi cấu hình refundApi; docs: chỉ VietinBank doanh nghiệp đã được SePay mở).
// Mọi chi tiết là docs-only (SEPY-D-004, B9): khóa chống trùng X-Idempotency-Key, ngân sách theo từng khoản thu gốc, trạng thái cuối bất biến.
const { isBlank, toInt } = require('./common');

// 422 mà việc thử lại không giúp được và cần người xử lý
const MANUAL_CODES = new Set(['not_available', 'unsupported_bank', 'transaction_required', 'no_original_transaction', 'not_refundable', 'unsupported_currency', 'invalid_state']);

function mapStatus(s) {
  if (s === 'succeeded') return 'succeeded';
  if (s === 'pending') return 'processing';
  if (s === 'failed' || s === 'rejected') return 'failed';
  return null;
}

// rowsFor(attemptRef, createdAt) -> {rows}|{error}: các hàng sao kê (thô) thuộc attempt, theo thứ tự thời gian tăng dần
function createRefunds(ctx, bank, rowsFor) {
  const { cfg } = ctx;
  const known = new Map(); // refundRef -> {refundId}
  const baId = () => (cfg.va && cfg.va.bankAccountId) || cfg.bankAccountId;

  function choose(rows, p) {
    let ins = rows.filter((r) => r && r.transfer_type === 'in' && Number.isInteger(toInt(r.amount_in)));
    // Hub đưa danh sách khoản thu của attempt (PHUB-D-018, P4): chỉ chọn trong các khoản đó, không đoán từ mọi hàng sao kê của VA/mã.
    if (Array.isArray(p.receipts) && p.receipts.length) {
      const txns = new Set(p.receipts.map((r) => String(r.txn)));
      const mine = ins.filter((r) => txns.has(String(r.reference_number)) || txns.has(String(r.id)));
      if (mine.length) ins = mine;
    }
    if (!isBlank(p.gatewayTxnId)) {
      const hit = ins.find((r) => String(r.reference_number) === String(p.gatewayTxnId) || String(r.id) === String(p.gatewayTxnId));
      if (hit) return hit;
    }
    // Không biết khoản nào: lấy khoản gần nhất đủ lớn để chứa số hoàn (ngân sách tính theo từng khoản)
    const fit = ins.filter((r) => toInt(r.amount_in) >= p.amount);
    return fit.length ? fit[fit.length - 1] : null;
  }

  return {
    async refund(p) {
      if (!cfg.refundApi) return { status: 'manual_required' };
      const found = await rowsFor(p.attemptRef, p.createdAt, p.state);
      if (found.error) throw new Error('sepay refund: không đọc được sao kê'); // Hub: chưa rõ, đối soát sau bằng queryRefund
      const row = choose(found.rows, p);
      if (!row) return { status: 'manual_required' };
      const r = await bank.apiCall('POST', `/transactions/${encodeURIComponent(row.id)}/refund`, {
        headers: { 'x-idempotency-key': `refund-${p.refundRef}`.slice(0, 100) }, body: { refund_amount: p.amount },
      });
      if (r.error) throw new Error('sepay refund: mất phản hồi'); // gửi lại cùng khóa là an toàn; Hub đối soát qua queryRefund
      const code = r.json && r.json.error_code;
      if (r.status === 200 && r.json && r.json.data) {
        known.set(p.refundRef, { refundId: r.json.data.refund_id });
        return { status: mapStatus(r.json.data.status) || 'processing' };
      }
      if (r.status === 422) return { status: MANUAL_CODES.has(code) ? 'manual_required' : 'failed' };
      throw new Error(`sepay refund: HTTP ${r.status}${code ? ` ${code}` : ''}`); // 409, 429, 5xx: chưa chắc, không coi là failed
    },

    async queryRefund(p) {
      if (!cfg.refundApi) return { status: 'manual_required' };
      const ba = baId();
      if (isBlank(ba)) return { status: 'manual_required' };
      let id = known.get(p.refundRef) && known.get(p.refundRef).refundId;
      if (!id) {
        // Mất ánh xạ (khởi động lại hoặc mất phản hồi): SePay không trả lại khóa chống trùng, nên tìm theo các khoản thu của attempt.
        const found = await rowsFor(p.attemptRef, p.createdAt, p.state);
        if (found.error) throw new Error('sepay queryRefund: không đọc được sao kê');
        const refunds = [];
        for (const row of found.rows) {
          const l = await bank.apiGet(`/bank-accounts/${encodeURIComponent(ba)}/refunds`, { transaction: row.id, per_page: 100 });
          if (l.error) throw new Error('sepay queryRefund: không đọc được danh sách hoàn');
          refunds.push(...l.json.data);
        }
        if (refunds.length === 0) return { status: 'failed' }; // SePay không có bản ghi nào: lệnh chưa từng tới nơi
        if (refunds.length > 1) return { status: 'manual_required' }; // không phân biệt được lệnh nào của Hub
        id = refunds[0].refund_id;
        known.set(p.refundRef, { refundId: id });
      }
      const d = await bank.apiCall('GET', `/bank-accounts/${encodeURIComponent(ba)}/refunds/${encodeURIComponent(id)}`);
      if (d.error || d.status !== 200 || !d.json || !d.json.data) throw new Error('sepay queryRefund: không đọc được lệnh hoàn');
      return { status: mapStatus(d.json.data.status) || 'processing' };
    },
  };
}

module.exports = { createRefunds };

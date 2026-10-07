'use strict';
// spec: PHUB-S-037
// spec: PHUB-S-017
// spec: PHUB-S-020
// Lỗi của lớp ứng dụng (PHUB-D-017). Có `code` ổn định để mọi transport tự ánh xạ (HTTP status, phản hồi lệnh Kafka...).
// Lỗi KHÔNG có `code` là lỗi hạ tầng bất ngờ: transport coi là tạm thời, không phải kết quả chính thức.

class AppError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const STATE_CODES = new Set(['attempt_still_live', 'payment_not_open', 'max_attempts', 'failover_disabled', 'failover_not_applicable', 'order_conflict', 'invalid_state', 'capture_rejected', 'void_rejected', 'op_in_progress', 'not_confirmed', 'nothing_to_refund', 'refund_limit']);

/** Ánh xạ mã lỗi ổn định sang HTTP status (dùng cho connector HTTP và OpenAPI). */
function httpStatusFor(code) {
  if (code === 'invalid_input') return 400;
  if (code === 'unauthorized') return 401;
  if (code === 'forbidden') return 403;
  if (code === 'not_found' || code === 'unknown_gateway' || code === 'unknown_operation') return 404;
  if (code === 'invalid_refund_amount' || code === 'not_supported') return 422;
  if (code === 'no_gateway_available' || code === 'gateway_unavailable') return 503;
  if (STATE_CODES.has(code)) return 409;
  return 500;
}

module.exports = { AppError, httpStatusFor };

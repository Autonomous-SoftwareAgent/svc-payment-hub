'use strict';
// spec: MOMO-S-001
// spec: MOMO-S-002
// spec: MOMO-S-003, MOMO-S-001, MOMO-S-002
// spec: PHUB-S-020
// spec: PHUB-S-023
// spec: PHUB-S-024
// spec: PHUB-S-029
// Adapter MoMo (API v2) cho Payment Hub. Chỉ đọc resultCode, không đọc HTTP status (MOMO-D-001).
// Idempotency theo orderId = attemptRef, không dựa requestId (A5). Mã 1005 gộp "hết hạn" với "chưa từng tạo"
// nên query chỉ trả not_found, không bao giờ expired/failed (A7, PHUB-D-002 điểm 3).
const crypto = require('node:crypto');

const SIGN = {
  create: ['accessKey', 'amount', 'extraData', 'ipnUrl', 'orderId', 'orderInfo', 'partnerCode', 'redirectUrl', 'requestId', 'requestType'],
  query: ['accessKey', 'orderId', 'partnerCode', 'requestId'],
  refund: ['accessKey', 'amount', 'description', 'orderId', 'partnerCode', 'requestId', 'transId'],
  refundQuery: ['accessKey', 'orderId', 'partnerCode', 'requestId'],
  ipn: ['accessKey', 'amount', 'extraData', 'message', 'orderId', 'orderInfo', 'orderType', 'partnerCode', 'payType', 'requestId', 'responseTime', 'resultCode', 'transId'],
};

const { createFailCodeMapper } = require('../fail-codes');

// resultCode -> lý do thất bại chuẩn (PHUB-D-020). Nguồn: bảng mã chính thức
// https://developers.momo.vn/v3/docs/payment/api/result-handling/resultcode/ (tải 2026-10-03). 1003 (hủy sau khi đã ủy quyền) để unknown.
// Chỉ ảnh hưởng lý do, không ảnh hưởng có tiền hay không.
const FAIL_CODES = {
  10: 'gateway_error', 11: 'invalid_request', 12: 'invalid_request', 13: 'invalid_request', 20: 'invalid_request', 21: 'invalid_request', 22: 'invalid_request',
  40: 'invalid_request', 41: 'invalid_request', 42: 'invalid_request',
  1001: 'insufficient_funds', 1002: 'declined', 1004: 'declined', 1005: 'expired', 1006: 'user_cancelled', 1007: 'declined',
};
const FINAL_FAIL = ['failed', 'cancelled', 'expired'];
const PENDING_CODES = new Set([1000, 7000, 7002, 9000]); // A9: gồm 7002 và 9000 (nikki-erp coi nhầm là đã chốt)
const NOT_FOUND_CODES = new Set([1005, 42]);              // A7
const CANCELLED_CODE = 1006;
// Mã cho thấy lỗi phía cấu hình/hệ thống, không phải kết quả của giao dịch: không được suy ra failed.
const INCONCLUSIVE_CODES = new Set([10, 11, 12, 13, 20, 21, 22, 40, 41, 43, 99, 11007]);
// Lỗi nghiệp vụ rõ ràng khi tạo: chắc chắn đơn chưa được tạo. unverified: 11, 12, 21 chỉ theo docs.
const CREATE_REJECT_CODES = new Set([11, 12, 13, 20, 21, 22, 11007]);
const REFUND_PROCESSING_CODES = new Set([7002, 1080, 1000, 7000, 9000]);

function sign(secretKey, fields, src) {
  const raw = fields.map((k) => `${k}=${src[k] === undefined || src[k] === null ? '' : src[k]}`).join('&');
  return crypto.createHmac('sha256', secretKey).update(raw).digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || '').toLowerCase());
  const y = Buffer.from(String(b || '').toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function ackResponse(outcome) {
  // MoMo mong HTTP 204 rỗng. unknown_attempt và amount_mismatch cũng 204: Hub đã giữ bằng chứng, và
  // retry của MoMo (nếu có, A4 unverified) không giúp được gì.
  if (outcome === 'invalid_signature') return { status: 400, body: '', contentType: 'text/plain' };
  if (outcome === 'error') return { status: 500, body: '', contentType: 'text/plain' };
  return { status: 204, body: '', contentType: 'text/plain' };
}

function typeForCode(code) {
  if (code === 0) return 'succeeded';
  if (PENDING_CODES.has(code)) return 'pending';
  if (code === CANCELLED_CODE) return 'cancelled';
  return 'failed';
}

function createMomoAdapter(config, deps = {}) {
  const cfg = {
    baseUrl: 'https://test-payment.momo.vn', requestType: 'captureWallet', timeoutMs: 15000, ...config,
  };
  const doFetch = deps.fetch || globalThis.fetch;
  const clock = deps.clock || { now: () => Date.now() };
  for (const k of ['partnerCode', 'accessKey', 'secretKey']) if (!cfg[k]) throw new Error(`momo: thiếu config ${k}`); // thiếu khóa thì mọi yêu cầu bị MoMo từ chối lúc chạy: báo ngay khi dựng
  const failCode = createFailCodeMapper('momo', FAIL_CODES, cfg.failCodeMap);
  const base = cfg.baseUrl.replace(/\/+$/, '');

  // Trả {json} nếu đọc được resultCode, ngược lại {unreadable:true} (lỗi mạng, timeout, phản hồi hỏng).
  async function post(path, body) {
    try {
      const res = await doFetch(base + path, {
        method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const text = await res.text();
      const json = JSON.parse(text);
      if (!json || typeof json !== 'object' || json.resultCode === undefined || json.resultCode === null || Number.isNaN(Number(json.resultCode))) return { unreadable: true };
      json.resultCode = Number(json.resultCode);
      return { json };
    } catch {
      return { unreadable: true };
    }
  }

  const signed = (kind, body) => ({ ...body, signature: sign(cfg.secretKey, SIGN[kind], { ...body, accessKey: cfg.accessKey }) });
  const newRequestId = () => crypto.randomUUID();

  function eventFrom(src, code, attemptRef, fallbackAmount, source, occurredAt, raw) {
    const amount = Number(src.amount !== undefined && src.amount !== null && src.amount !== '' ? src.amount : fallbackAmount);
    const ev = {
      gateway: 'momo', attemptRef, type: typeForCode(code), amount, occurredAt, source, raw,
    };
    const transId = src.transId;
    if (transId !== undefined && transId !== null && String(transId) !== '0' && String(transId) !== '') ev.gatewayTxnId = String(transId);
    if (FINAL_FAIL.includes(ev.type)) { ev.failCode = failCode(code); ev.gatewayCode = String(code); }
    return ev;
  }

  return {
    id: 'momo',

    capabilities() {
      // MOMO-D-003
      return {
        createCanTimeout: true, hardExpiry: 'unknown', cancellable: false, queryable: true, refundable: 'api', refundAsync: true,
        currencies: ['VND'], regions: ['VN'], methods: ['wallet'], // captureWallet: ví MoMo (theo tài liệu, chưa kiểm với cổng thật)
      };
    },

    async createPayment(p) {
      if (!Number.isInteger(p.amount) || p.amount <= 0) return { status: 'rejected', reason: 'amount phải là số nguyên VND dương', failCode: 'invalid_request' };
      const body = signed('create', {
        partnerCode: cfg.partnerCode, requestType: cfg.requestType, ipnUrl: cfg.ipnUrl, redirectUrl: p.returnUrl || cfg.redirectUrl,
        orderId: p.attemptRef, amount: String(p.amount), orderInfo: p.orderInfo, requestId: newRequestId(), extraData: '', lang: 'vi',
      });
      // amount ký ở dạng chuỗi và gửi dạng số (live nhận cả hai, A13)
      body.amount = p.amount;
      const r = await post('/v2/gateway/api/create', body);
      if (r.unreadable) return { status: 'unknown' };
      const j = r.json;
      if (j.resultCode === 0) return j.payUrl ? { status: 'redirect', url: j.payUrl } : { status: 'unknown' };
      // 41 = orderId đã tồn tại: đơn có thể đã được tạo, payUrl đã mất (A5, A6) nên là unknown, không phải rejected.
      if (CREATE_REJECT_CODES.has(j.resultCode)) return { status: 'rejected', reason: `momo ${j.resultCode}: ${j.message || ''}`, failCode: failCode(j.resultCode), gatewayCode: String(j.resultCode) };
      return { status: 'unknown' };
    },

    parseCallback(req) {
      let data = req.channel === 'return' ? req.query : req.body;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
      const ack = (outcome) => ackResponse(outcome);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { valid: false, ack };
      const expected = sign(cfg.secretKey, SIGN.ipn, { ...data, accessKey: cfg.accessKey });
      if (!safeEqualHex(expected, data.signature) || data.partnerCode !== cfg.partnerCode) return { valid: false, ack };
      const code = Number(data.resultCode);
      const amount = Number(data.amount);
      if (!data.orderId || Number.isNaN(code) || !Number.isInteger(amount)) return { valid: false, ack };
      const at = Number(data.responseTime);
      const event = eventFrom(data, code, String(data.orderId), amount, req.channel === 'return' ? 'return' : 'ipn', Number.isFinite(at) && at > 0 ? at : clock.now(), data);
      return { valid: true, event, ack };
    },

    async query(p) {
      const body = signed('query', { partnerCode: cfg.partnerCode, requestId: newRequestId(), orderId: p.attemptRef, lang: 'vi' });
      const r = await post('/v2/gateway/api/query', body);
      if (r.unreadable) return { state: 'unknown' };
      const j = r.json;
      const code = j.resultCode;
      if (NOT_FOUND_CODES.has(code)) return { state: 'not_found' };
      if (INCONCLUSIVE_CODES.has(code)) return { state: 'unknown' };
      return eventFrom(j, code, p.attemptRef, p.amount, 'query', Number(j.responseTime) || clock.now(), j);
    },

    async refund(p) {
      let transId = p.gatewayTxnId;
      if (!transId) {
        const q = await this.query({ attemptRef: p.attemptRef, amount: p.amount });
        if (q && q.gatewayTxnId) transId = q.gatewayTxnId; else return { status: 'manual_required' };
      }
      const body = signed('refund', {
        partnerCode: cfg.partnerCode, orderId: p.refundRef, requestId: newRequestId(), amount: String(p.amount),
        transId: String(transId), lang: 'vi', description: `Refund ${p.attemptRef}`,
      });
      body.amount = p.amount;
      body.transId = Number(transId);
      const r = await post('/v2/gateway/api/refund', body);
      // Mất phản hồi: refund có thể đã chạy, không được coi là failed; đối soát bằng queryRefund.
      if (r.unreadable) return { status: 'processing' };
      return { status: refundStatus(r.json.resultCode, false) };
    },

    async queryRefund(p) {
      const body = signed('refundQuery', { partnerCode: cfg.partnerCode, requestId: newRequestId(), orderId: p.refundRef, lang: 'vi' });
      const r = await post('/v2/gateway/api/refund/query', body);
      if (r.unreadable) return { status: 'processing' };
      const j = r.json;
      if (NOT_FOUND_CODES.has(j.resultCode)) return { status: 'requested' };
      const list = Array.isArray(j.refundTrans) ? j.refundTrans : [];
      const mine = list.find((x) => x && x.orderId === p.refundRef);
      if (mine && mine.resultCode !== undefined) return { status: refundStatus(Number(mine.resultCode), true) };
      if (j.resultCode === 0) return { status: 'processing' }; // có phản hồi nhưng không thấy dòng của refundRef
      return { status: refundStatus(j.resultCode, true) };
    },
    // cancel: không cài (cancellable=false, luồng một bước)
  };
}

function refundStatus(code, isQuery) {
  if (code === 0) return 'succeeded';
  if (REFUND_PROCESSING_CODES.has(code)) return 'processing';
  if (code === 41) return 'processing'; // refundRef đã tồn tại: lần gọi trước có thể đã chạy
  if (isQuery && INCONCLUSIVE_CODES.has(code)) return 'processing';
  return 'failed';
}

// Khai báo cho registry (PHUB-D-023). MoMo nhận ipnUrl và redirectUrl trong từng request tạo đơn: mặc định lấy từ publicBaseUrl của điểm nối.
const adapter = {
  id: 'momo',
  create(config, deps = {}) {
    const cfg = { ...config };
    const base = String(deps.publicBaseUrl || '').replace(/\/+$/, '');
    if (!cfg.ipnUrl && base) cfg.ipnUrl = `${base}/ipn/momo`;
    if (!cfg.redirectUrl && base) cfg.redirectUrl = `${base}/return/momo`;
    return createMomoAdapter(cfg, deps);
  },
};

module.exports = { adapter, createMomoAdapter };

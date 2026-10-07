'use strict';
// spec: OPAY-S-002
// spec: OPAY-S-003
// spec: OPAY-S-001 (luồng, ký), OPAY-S-002 (sổ giả định), OPAY-S-003 (năng lực, adapter)
// spec: PHUB-S-020
// spec: PHUB-S-023
// spec: PHUB-S-029
// Adapter OnePAY (chuyển hướng kiểu VPC, ký HMAC-SHA256). Chỉ nơi này biết vpc_*, mã vpc_TxnResponseCode, cách ký.
// Nguồn sự thật: docs/modules/onepay-sim OPAY-D-001..003. Không phụ thuộc thư viện ngoài.

const crypto = require('node:crypto');
const { createFailCodeMapper } = require('../fail-codes');

const GATEWAY_ID = 'onepay';
const DEFAULT_BASE_URL = 'https://mtf.onepay.vn';
const ACK_CONFIRM = 'responsecode=1&desc=confirm-success'; // A9: docs-only, không client nào quan sát
const ACK_FAIL = 'responsecode=0&desc=confirm-fail'; // unverified: OnePAY không nói ack lỗi trông thế nào

// Hết hạn cứng theo sản phẩm (A12, docs-only): 15 phút quốc tế, 30 phút nội địa.
// Chọn dạng {minutes} thay vì 'gateway-fixed': merchant không đổi được, nhưng docs nêu con số cụ thể
// ("query đến khi đủ 15-30 phút") nên Hub có mốc để biết khi nào kết quả query là cuối. Tiền về SAU mốc
// này là unverified: Hub phải giữ mặc định "có thể về muộn" (PHUB-D-003 câu 1).
// QR: không có tài liệu công khai (ngoài phạm vi) nên 'unknown' => Hub không failover.
const PRODUCTS = {
  DOMESTIC: { hardExpiry: { minutes: 30 }, methods: ['card_domestic'] },
  INTERNATIONAL: { hardExpiry: { minutes: 15 }, methods: ['card_international'] },
  QR: { hardExpiry: 'unknown', methods: ['qr'] },
};

function hmacHex(str, hashKeyHex) {
  return crypto.createHmac('sha256', Buffer.from(hashKeyHex, 'hex')).update(str, 'utf8').digest('hex').toUpperCase();
}

// A1: mọi vpc_* (và user_*) trừ vpc_SecureHash, bỏ giá trị rỗng, sắp ASCII, k=v nối &, giá trị gốc KHÔNG url-encode.
function signString(params) {
  return Object.keys(params)
    .filter((k) => (k.startsWith('vpc_') || k.startsWith('user_')) && k !== 'vpc_SecureHash')
    .filter((k) => params[k] !== undefined && params[k] !== null && String(params[k]) !== '')
    .sort() // sort mặc định = so theo mã UTF-16, đúng thứ tự ASCII với tên tham số
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function sign(params, hashKeyHex) {
  return hmacHex(signString(params), hashKeyHex);
}

function hashEquals(a, b) {
  // A2: so không phân biệt hoa thường (live phía tạo). So bằng timingSafeEqual.
  const x = Buffer.from(String(a).toUpperCase());
  const y = Buffer.from(String(b).toUpperCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Bảng mã -> loại sự kiện chuẩn. 100 và 300 TUYỆT ĐỐI không phải failed (A16 bị bác bỏ bởi docs và probe live).
// 99 và 253 theo bảng mã OnePAY (99 khách hủy, 253 hết hạn); phần còn lại failed. Bảng chi tiết từng thẻ ngoài phạm vi.
// Mã -> lý do thất bại chuẩn (PHUB-D-020). Chỉ hai mã có bằng chứng (99 khách hủy, 253 hết hạn, theo bảng mã OnePAY đã dùng ở mapCode);
// tài liệu chính thức không truy cập được nên mọi mã khác là unknown cho tới khi có bằng chứng (thêm qua adapters.onepay.failCodeMap).
const FAIL_CODES = { 99: 'user_cancelled', 253: 'expired' };
const FINAL_FAIL = ['failed', 'cancelled', 'expired'];

function mapCode(code) {
  const c = String(code);
  if (c === '0') return 'succeeded';
  if (c === '99') return 'cancelled';
  if (c === '253') return 'expired';
  if (c === '100' || c === '300') return 'pending';
  return 'failed';
}

function parseAmount(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n % 100 !== 0) return null; // A3: VND x 100
  return n / 100;
}

function parseForm(text) {
  const out = {};
  for (const [k, v] of new URLSearchParams(String(text))) out[k] = v;
  return out;
}

function createOnepayAdapter(config = {}, deps = {}) {
  const cfg = {
    baseUrl: DEFAULT_BASE_URL,
    product: 'DOMESTIC',
    locale: 'vn',
    ...config,
  };
  const failCode = createFailCodeMapper('onepay', FAIL_CODES, cfg.failCodeMap);
  for (const k of ['merchant', 'accessCode', 'hashKeyHex']) {
    if (!cfg[k]) throw new Error(`onepay: thiếu config ${k}`);
  }
  if (!/^([0-9a-fA-F]{2})+$/.test(cfg.hashKeyHex)) throw new Error('onepay: hashKeyHex phải là chuỗi hex');
  const baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');
  const clock = deps.clock || { now: () => Date.now() };
  const doFetch = deps.fetch || globalThis.fetch;

  function resolveProduct(product) {
    // 'default' (Hub không chỉ định sản phẩm) = sản phẩm mặc định trong config của adapter.
    const p = String(product && product !== 'default' ? product : cfg.product).toUpperCase();
    return PRODUCTS[p] ? p : null;
  }

  function capabilities(product) {
    const p = resolveProduct(product) || String(product && product !== 'default' ? product : cfg.product).toUpperCase();
    const info = PRODUCTS[p];
    return {
      hardExpiry: info ? info.hardExpiry : 'unknown', // sản phẩm lạ: không biết
      cancellable: false, // A20: không có hủy/void nguồn nào
      queryable: true, // A13: QueryDR live, ký hai chiều
      refundable: 'manual', // A19: chỉ qua portal
      refundAsync: true, // khách nhận 7-30 ngày
      createCanTimeout: false, // dựng URL tại chỗ, không gọi mạng
      currencies: ['VND'], regions: ['VN'], methods: info ? info.methods : [], // theo sản phẩm (vpc_CardList); sản phẩm lạ: không khai
    };
  }

  async function createPayment(p) {
    const product = resolveProduct(p.product);
    if (!product) return { status: 'rejected', reason: `product không hỗ trợ: ${p.product}`, failCode: 'invalid_request' };
    if (!p.attemptRef || String(p.attemptRef).length > 40) return { status: 'rejected', reason: 'attemptRef rỗng hoặc dài quá 40 ký tự', failCode: 'invalid_request' };
    if (!Number.isInteger(p.amount) || p.amount <= 0) return { status: 'rejected', reason: 'amount phải là số nguyên VND > 0', failCode: 'invalid_request' };
    if (p.currency && p.currency !== 'VND') return { status: 'rejected', reason: 'chỉ hỗ trợ VND', failCode: 'invalid_request' };
    if (!p.returnUrl) return { status: 'rejected', reason: 'thiếu returnUrl', failCode: 'invalid_request' };
    const orderInfo = String(p.orderInfo || p.attemptRef);
    if (orderInfo.length > 34) return { status: 'rejected', reason: 'orderInfo dài quá 34 ký tự', failCode: 'invalid_request' };

    // Tất cả giá trị là hàm thuần của tham số => cùng tham số cho cùng URL (A17 cần để gửi lại không đổi).
    // expiresAt của Hub bị bỏ qua: OnePAY không có tham số hạn (OPAY-D-003).
    const params = {
      vpc_Version: '2',
      vpc_Command: 'pay',
      vpc_Merchant: cfg.merchant,
      vpc_AccessCode: cfg.accessCode,
      vpc_MerchTxnRef: p.attemptRef, // khóa chống trùng = attemptRef của Hub
      vpc_OrderInfo: orderInfo,
      vpc_Amount: String(p.amount * 100),
      vpc_Currency: 'VND', // A4: ký có vpc_Currency (docs 2.3 + probe /paygate); conflicts với vn-payments quốc tế
      vpc_Locale: cfg.locale,
      vpc_ReturnURL: p.returnUrl,
      vpc_TicketNo: p.clientIp || '127.0.0.1',
      vpc_CardList: product,
    };
    params.vpc_SecureHash = sign(params, cfg.hashKeyHex);
    const qs = Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');
    return { status: 'redirect', url: `${baseUrl}/paygate/vpcpay.op?${qs}` };
  }

  function ackFor(outcome) {
    const text = (status, body) => ({ status, body, contentType: 'text/plain; charset=utf-8' });
    switch (outcome) {
      case 'ok':
      case 'duplicate':
        return text(200, ACK_CONFIRM);
      // Bảo thủ (unverified A10): không xác nhận thì OnePAY (có thể) gửi lại; ack thành công chỉ khi Hub đã ghi nhận.
      case 'invalid_signature':
        return text(400, ACK_FAIL);
      case 'error':
        return text(500, ACK_FAIL);
      case 'unknown_attempt':
      case 'amount_mismatch':
      default:
        return text(200, ACK_FAIL);
    }
  }

  function parseCallback(req) {
    const ack = ackFor;
    const params = { ...(req && req.query) };
    const given = params.vpc_SecureHash;
    // Không bao giờ bỏ qua kiểm hash dù mã nào (A23: vn-payments bỏ qua với code 7, ta không làm vậy).
    if (!given || !hashEquals(given, sign(params, cfg.hashKeyHex))) return { valid: false, reason: 'bad_signature', ack };
    if (params.vpc_Merchant && params.vpc_Merchant !== cfg.merchant) return { valid: false, reason: 'merchant_mismatch', ack };
    if (!params.vpc_MerchTxnRef || params.vpc_TxnResponseCode === undefined) return { valid: false, reason: 'missing_fields', ack };
    const amount = parseAmount(params.vpc_Amount);
    if (amount === null) return { valid: false, reason: 'bad_amount', ack };
    const event = {
      gateway: GATEWAY_ID,
      attemptRef: params.vpc_MerchTxnRef,
      type: mapCode(params.vpc_TxnResponseCode),
      amount,
      occurredAt: clock.now(),
      // A8: return và IPN cùng payload, không có trường đánh dấu kênh; kênh do cách request đến quyết định.
      source: req.channel === 'return' ? 'return' : 'ipn',
      raw: params,
    };
    if (params.vpc_TransactionNo) event.gatewayTxnId = params.vpc_TransactionNo;
    if (FINAL_FAIL.includes(event.type)) { event.failCode = failCode(params.vpc_TxnResponseCode); event.gatewayCode = String(params.vpc_TxnResponseCode); }
    return { valid: true, event, ack };
  }

  async function query(p) {
    const form = {
      vpc_Command: 'queryDR',
      vpc_Version: '1',
      vpc_MerchTxnRef: p.attemptRef,
      vpc_Merchant: cfg.merchant,
      vpc_AccessCode: cfg.accessCode,
      vpc_User: cfg.queryUser || '',
      vpc_Password: cfg.queryPassword || '',
    };
    form.vpc_SecureHash = sign(form, cfg.hashKeyHex);
    let res;
    let text;
    try {
      res = await doFetch(`${baseUrl}/msp/api/v1/vpc/invoices/queries`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
      text = await res.text();
    } catch (_e) {
      return { state: 'unknown' }; // mạng lỗi: chưa biết, đối soát lại sau
    }
    if (res.status !== 200) return { state: 'unknown' }; // 401/405/415/5xx: lỗi của ta hoặc cổng, không phải "không tìm thấy"
    const r = parseForm(text);
    // Phản hồi phải có ký hợp lệ, nếu không không tin (query là trọng tài nên không nhận bừa).
    if (!r.vpc_SecureHash || !hashEquals(r.vpc_SecureHash, sign(r, cfg.hashKeyHex))) return { state: 'unknown' };
    if (r.vpc_MerchTxnRef && r.vpc_MerchTxnRef !== p.attemptRef) return { state: 'unknown' };
    if (r.vpc_DRExists === 'N') return { state: 'not_found' }; // không bao giờ thành failed/expired chắc chắn
    if (r.vpc_DRExists !== 'Y' || r.vpc_TxnResponseCode === undefined) return { state: 'unknown' };
    const type = mapCode(r.vpc_TxnResponseCode);
    let amount = r.vpc_Amount !== undefined ? parseAmount(r.vpc_Amount) : null;
    if (r.vpc_Amount !== undefined && amount === null) return { state: 'unknown' };
    if (amount === null) {
      // Phản hồi pending không mang amount (probe live). Kết quả cuối thiếu amount thì không đủ để ghi tiền.
      if (type !== 'pending' && type !== 'failed' && type !== 'cancelled' && type !== 'expired') return { state: 'unknown' };
      amount = Number.isInteger(p.amount) ? p.amount : 0;
    }
    const event = {
      gateway: GATEWAY_ID,
      attemptRef: p.attemptRef,
      type,
      amount,
      occurredAt: clock.now(),
      source: 'query',
      raw: r,
    };
    if (r.vpc_TransactionNo) event.gatewayTxnId = r.vpc_TransactionNo;
    if (FINAL_FAIL.includes(event.type)) { event.failCode = failCode(r.vpc_TxnResponseCode); event.gatewayCode = String(r.vpc_TxnResponseCode); }
    return event;
  }

  // A19: không có API hoàn tiền công khai, hoàn bằng portal. Hub đưa vào luồng thủ công.
  async function refund() {
    return { status: 'manual_required' };
  }
  async function queryRefund() {
    return { status: 'manual_required' };
  }
  // cancel: cố ý không cài (cancellable=false, A20).

  return { id: GATEWAY_ID, capabilities, createPayment, parseCallback, query, refund, queryRefund };
}

// Khai báo cho registry (PHUB-D-023).
const adapter = { id: 'onepay', create: (config, deps) => createOnepayAdapter(config, deps) };

module.exports = { adapter, createOnepayAdapter, signString, sign, mapCode, ACK_CONFIRM };

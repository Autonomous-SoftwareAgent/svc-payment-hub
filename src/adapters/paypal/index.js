'use strict';
// spec: PYPL-S-001
// spec: PYPL-S-002
// Adapter PayPal (Orders v2), cổng quốc tế thứ hai. Thiết kế: PYPL-D-001 và PYPL-D-002; nghiên cứu: docs/agent/paypal-research.md.
// MỌI hành vi ở đây là documented (qua trang tài liệu) hoặc inferred; CHƯA kiểm với PayPal thật (chưa có sandbox, chưa gọi PayPal lần nào).
// Khác Stripe: khách duyệt xong tiền CHƯA chuyển, adapter phải thu (hoặc giữ) giúp Hub qua kênh return hoặc webhook CHECKOUT.ORDER.APPROVED.
// query() chỉ ĐỌC, không bao giờ thu. Mã giao dịch của Hub là MÃ ORDER (cho cả authorized lẫn succeeded). Gọi HTTP thẳng qua deps.fetch, không dùng SDK.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createFailCodeMapper } = require('../fail-codes');
const { CURRENCY_EXPONENT } = require('../../contract');

const DEFAULT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'SGD', 'HKD'];
// Loại tiền PayPal hỗ trợ (documented, 24 mã) mà lõi cũng có trong bảng ISO. VND KHÔNG nằm trong đó. HUF, RUB, ILS lõi chưa biết.
const PAYPAL_CURRENCIES = ['AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'JPY', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD', 'CHF', 'THB', 'USD', 'TWD'];
const NO_DECIMAL = ['HUF', 'JPY', 'TWD']; // documented: không có phần thập phân (TWD: tóm tắt tài liệu tự mâu thuẫn, mặc định không bật)
const HUB_REFUND_PREFIX = 'HUB:';
const ORDER_TTL_MINUTES = 180; // documented: order sống 3 giờ ở CREATED

const PRODUCTS = {
  charge: { intent: 'CAPTURE', manual: false, operations: ['purchase', 'refund', 'inquire'] },
  auth: { intent: 'AUTHORIZE', manual: true, operations: ['authorize', 'capture', 'void', 'refund', 'inquire'] },
};

// Mã lỗi của PayPal -> lý do thất bại chuẩn (PYPL-D-002; inferred từ tên mã). Chỉ ảnh hưởng lý do hiển thị và đo đếm.
const FAIL_CODES = {
  INSTRUMENT_DECLINED: 'declined', TRANSACTION_REFUSED: 'declined', PAYER_ACCOUNT_RESTRICTED: 'declined', PAYER_ACCOUNT_LOCKED_OR_CLOSED: 'declined', PAYEE_ACCOUNT_RESTRICTED: 'invalid_request',
  CURRENCY_NOT_SUPPORTED: 'invalid_request', DECIMAL_PRECISION: 'invalid_request', DUPLICATE_INVOICE_ID: 'invalid_request',
  ORDER_NOT_APPROVED: 'expired', AUTHORIZATION_EXPIRED: 'expired',
  RATE_LIMIT_REACHED: 'rate_limited',
};

const refundStatus = (s) => ({ COMPLETED: 'succeeded', PENDING: 'processing', FAILED: 'failed', CANCELLED: 'failed' }[s] || 'processing');

/** Đổi số tiền của Hub (đơn vị nhỏ nhất ISO 4217) sang chuỗi thập phân của PayPal. Trả {value} hoặc {error}. */
function toPaypalValue(amount, currency) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return { error: 'amount phải là số nguyên dương' };
  const iso = CURRENCY_EXPONENT[currency];
  if (iso === undefined) return { error: `loại tiền ${currency} lõi chưa biết` };
  const pp = NO_DECIMAL.includes(currency) ? 0 : iso;
  const scale = 10 ** (iso - pp);
  if (iso < pp || amount % scale !== 0) return { error: `${currency}: số tiền phải là bội của ${scale} (PayPal không nhận phần thập phân của loại tiền này)` };
  const units = amount / scale;
  if (pp === 0) return { value: String(units) };
  const f = 10 ** pp;
  return { value: `${Math.floor(units / f)}.${String(units % f).padStart(pp, '0')}` };
}

/** Chiều ngược lại. null khi không đổi được (sai định dạng, quá nhiều chữ số thập phân): không đoán. */
function fromPaypalValue(value, currency) {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null;
  const iso = CURRENCY_EXPONENT[currency];
  if (iso === undefined) return null;
  const pp = NO_DECIMAL.includes(currency) ? 0 : iso;
  const [i, f = ''] = value.split('.');
  if (f.length > pp) return null;
  const units = Number(i) * 10 ** pp + (pp ? Number(f.padEnd(pp, '0')) : 0);
  const out = units * 10 ** (iso - pp);
  return Number.isSafeInteger(out) ? out : null;
}

function ackResponse(outcome) {
  if (outcome === 'invalid_signature') return { status: 400, body: '{"error":"invalid_signature"}', contentType: 'application/json' };
  if (outcome === 'error') return { status: 500, body: '{"error":"retry"}', contentType: 'application/json' };
  return { status: 200, body: '{"received":true}', contentType: 'application/json' }; // unknown_attempt và amount_mismatch cũng 200: Hub đã giữ bằng chứng
}

function notSent(code) {
  const e = new Error(`paypal ${code}: chưa xử lý, gọi lại sau`);
  e.notSent = true;
  e.code = code;
  return e;
}

const linkHref = (obj, rel) => ((obj && Array.isArray(obj.links) && obj.links.find((l) => l && l.rel === rel)) || {}).href;
const lastSegment = (href) => (typeof href === 'string' ? href.split('?')[0].split('/').filter(Boolean).pop() : undefined);

function createPaypalAdapter(config, deps = {}) {
  const cfg = {
    baseUrl: 'https://api-m.paypal.com', timeoutMs: 15000, product: 'charge', currencies: DEFAULT_CURRENCIES, certHosts: ['paypal.com'], certUrlAllowHttp: false, ...config,
  };
  const doFetch = deps.fetch || globalThis.fetch;
  const clock = deps.clock || { now: () => Date.now() };
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('paypal: thiếu config clientId hoặc clientSecret');
  const webhookIds = [].concat(cfg.webhookId || []).filter(Boolean);
  if (!webhookIds.length) throw new Error('paypal: thiếu config webhookId (không có thì không kiểm được chữ ký webhook)');
  if (!PRODUCTS[String(cfg.product).toLowerCase()]) throw new Error(`paypal: product không hợp lệ: ${cfg.product} (${Object.keys(PRODUCTS).join(', ')})`);
  if (!Array.isArray(cfg.currencies) || cfg.currencies.some((c) => !PAYPAL_CURRENCIES.includes(c))) throw new Error(`paypal: currencies phải nằm trong loại tiền PayPal hỗ trợ mà lõi biết (${PAYPAL_CURRENCIES.join(', ')}); VND không được PayPal hỗ trợ`);
  if (!Array.isArray(cfg.certHosts) || !cfg.certHosts.length) throw new Error('paypal: certHosts phải là danh sách tên miền được phép phát chứng chỉ webhook');
  const failCode = createFailCodeMapper('paypal', FAIL_CODES, cfg.failCodeMap);
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const basic = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
  const returnBase = () => String(cfg.returnBaseUrl || deps.publicBaseUrl || '').replace(/\/+$/, '');

  const resolveProduct = (p) => {
    const key = p === undefined || p === null || p === 'default' ? String(cfg.product).toLowerCase() : String(p).toLowerCase();
    return PRODUCTS[key] ? { key, ...PRODUCTS[key] } : null;
  };

  // ---------- HTTP ----------
  let token = null; // {value, exp(ms)}
  async function rawCall(url, init) {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs) });
      const text = await res.text();
      let json = null;
      if (text) { try { json = JSON.parse(text); } catch { /* giữ null */ } }
      if (text && (!json || typeof json !== 'object')) return { unreadable: true, status: res.status };
      return { status: res.status, json: json || {} };
    } catch {
      return { unreadable: true, status: 0 };
    }
  }
  async function getToken() {
    if (token && token.exp > clock.now() + 60000) return token.value;
    const r = await rawCall(`${base}/v1/oauth2/token`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    if (r.unreadable || r.status < 200 || r.status >= 300 || !r.json.access_token) return { fail: r };
    token = { value: r.json.access_token, exp: clock.now() + Number(r.json.expires_in || 0) * 1000 };
    return token.value;
  }
  /** Một lời gọi API có Bearer. unreadable=true khi lỗi mạng, timeout hoặc thân không phải JSON (kết quả CHƯA RÕ nếu là thao tác ghi). Token hết hạn (401) thì lấy lại một lần. */
  async function call(method, path, { json, idem } = {}) {
    for (let again = 0; again < 2; again += 1) {
      const t = await getToken();
      if (t && t.fail) return t.fail.unreadable ? { unreadable: true, status: t.fail.status } : { status: t.fail.status === 401 ? 401 : t.fail.status, json: t.fail.json, tokenFailure: true };
      const headers = { authorization: `Bearer ${t}`, accept: 'application/json' };
      let body;
      if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
      if (idem) headers['paypal-request-id'] = idem;
      const r = await rawCall(base + path, { method, headers, body });
      if (r.status === 401 && again === 0) { token = null; continue; }
      return r;
    }
    return { unreadable: true, status: 0 };
  }

  /** ok | auth (thông tin đăng nhập của ta sai) | rate (429) | reject (4xx còn lại, chắc chắn không xảy ra) | unknown (5xx, mất phản hồi) */
  function classify(r) {
    if (r.unreadable) return 'unknown';
    if (r.status >= 200 && r.status < 300) return 'ok';
    if (r.status === 401 || r.status === 403) return 'auth';
    if (r.status === 429) return 'rate';
    if (r.status >= 400 && r.status < 500) return 'reject';
    return 'unknown';
  }
  const issueOf = (r) => (r.json && Array.isArray(r.json.details) && r.json.details[0] && r.json.details[0].issue) || (r.json && r.json.name) || undefined;
  const reasonOf = (r) => `paypal ${r.status}${issueOf(r) ? ` ${issueOf(r)}` : ''}: ${String((r.json && r.json.message) || '').slice(0, 200)}`;

  const getOrder = (id) => call('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
  const getCapture = (id) => call('GET', `/v2/payments/captures/${encodeURIComponent(id)}`);
  const orderIdOf = (state, txn) => (state && state.order) || (txn && String(txn)) || null;

  function eventBase(attemptRef, type, source, at) {
    return { gateway: 'paypal', attemptRef, type, occurredAt: at, source };
  }
  const amountOfObj = (a) => (a && typeof a === 'object' ? { cur: String(a.currency_code || '').toUpperCase(), amount: fromPaypalValue(a.value, String(a.currency_code || '').toUpperCase()) } : { cur: '', amount: null });

  /** Sự kiện chuẩn từ một order (nguồn sự thật về tiền): dùng chung cho truy vấn và kết quả thu. {unconvertible:true} khi số tiền không đổi được. */
  function eventFromOrder(order, attemptRef, source, at) {
    const pu = (order.purchase_units && order.purchase_units[0]) || {};
    const pay = pu.payments || {};
    const caps = Array.isArray(pay.captures) ? pay.captures : [];
    const auths = Array.isArray(pay.authorizations) ? pay.authorizations : [];
    const done = caps.find((c) => c.status === 'COMPLETED' || c.status === 'PARTIALLY_REFUNDED' || c.status === 'REFUNDED');
    if (done) {
      const { cur, amount } = amountOfObj(done.amount);
      return amount === null ? { unconvertible: true } : { ...eventBase(attemptRef, 'succeeded', source, at), amount, currency: cur, gatewayTxnId: order.id };
    }
    if (caps.some((c) => c.status === 'PENDING')) return { ...eventBase(attemptRef, 'pending', source, at) };
    const bad = caps.find((c) => ['DENIED', 'DECLINED', 'FAILED'].includes(c.status));
    if (bad) {
      const { cur, amount } = amountOfObj(bad.amount);
      return amount === null ? { unconvertible: true } : { ...eventBase(attemptRef, 'failed', source, at), amount, currency: cur, failCode: 'declined', gatewayCode: bad.status, gatewayTxnId: order.id };
    }
    const held = auths.find((a) => a.status === 'CREATED' || a.status === 'PENDING');
    if (held && held.status === 'CREATED') {
      const { cur, amount } = amountOfObj(held.amount);
      return amount === null ? { unconvertible: true } : { ...eventBase(attemptRef, 'authorized', source, at), amount, currency: cur, gatewayTxnId: order.id };
    }
    const gone = auths.find((a) => a.status === 'VOIDED' || a.status === 'EXPIRED' || a.status === 'DENIED');
    if (gone) {
      const { cur, amount } = amountOfObj(gone.amount);
      if (amount === null) return { unconvertible: true };
      const expired = gone.status === 'EXPIRED';
      return { ...eventBase(attemptRef, expired ? 'expired' : (gone.status === 'DENIED' ? 'failed' : 'cancelled'), source, at), amount, currency: cur, failCode: expired ? 'expired' : (gone.status === 'DENIED' ? 'declined' : 'unknown'), gatewayCode: gone.status, gatewayTxnId: order.id };
    }
    if (order.status === 'VOIDED') {
      const { cur, amount } = amountOfObj(pu.amount);
      return amount === null ? { unconvertible: true } : { ...eventBase(attemptRef, 'cancelled', source, at), amount, currency: cur, failCode: 'unknown', gatewayCode: 'VOIDED', gatewayTxnId: order.id };
    }
    return { ...eventBase(attemptRef, 'pending', source, at) }; // CREATED, PAYER_ACTION_REQUIRED, APPROVED, ...: chưa có tiền, không suy thất bại
  }

  /**
   * Khách đã duyệt: thu (intent CAPTURE) hoặc giữ (AUTHORIZE) giúp Hub. Idempotent (PayPal-Request-Id theo attemptRef) nên return và webhook cùng gọi được.
   * Kiểm custom_id của order khớp attemptRef trước khi thu: kênh return không có chữ ký, token trên URL do người gọi đưa.
   * @returns {{event?:Object, retry?:string, ignore?:boolean}}
   */
  async function settleApproved(orderId, attemptRef) {
    if (!orderId || !attemptRef) return { ignore: true };
    const g = await getOrder(orderId);
    const gc = classify(g);
    if (gc === 'reject' && g.status === 404) return { ignore: true };
    if (gc !== 'ok') return { retry: reasonOf(g) };
    const order = g.json;
    const pu = (order.purchase_units && order.purchase_units[0]) || {};
    if (pu.custom_id !== attemptRef) return { ignore: true }; // order không thuộc attempt này
    const at = clock.now();
    const derive = (o) => { const e = eventFromOrder(o, attemptRef, 'query', at); return e.unconvertible ? { retry: 'số tiền không đổi được sang đơn vị của Hub' } : { event: e }; };
    if (order.status !== 'APPROVED') return derive(order); // đã thu, chưa duyệt, hoặc đã nhả: theo trạng thái thật
    const authorize = order.intent === 'AUTHORIZE';
    const r = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/${authorize ? 'authorize' : 'capture'}`, { json: {}, idem: `${attemptRef}:${authorize ? 'authorize' : 'capture'}` });
    const c = classify(r);
    if (c === 'ok') return derive(r.json);
    if (c === 'rate') return { retry: reasonOf(r) };
    if (c === 'reject') {
      const issue = issueOf(r);
      if (issue === 'ORDER_ALREADY_CAPTURED' || issue === 'ORDER_ALREADY_AUTHORIZED') { // đã có người thu: đọc trạng thái thật
        const g2 = await getOrder(orderId);
        return classify(g2) === 'ok' ? derive(g2.json) : { retry: reasonOf(g2) };
      }
      const { cur, amount } = amountOfObj(pu.amount);
      if (amount === null) return { retry: 'số tiền không đổi được sang đơn vị của Hub' };
      // Thu bị từ chối (thẻ, tài khoản người trả): chắc chắn chưa có tiền. Lý do theo mã lỗi.
      return { event: { ...eventBase(attemptRef, 'failed', 'query', at), amount, currency: cur, failCode: failCode(issue), gatewayCode: issue || String(r.status), gatewayTxnId: orderId } };
    }
    return { retry: reasonOf(r) }; // auth hay 5xx hay mất phản hồi: có thể đã thu, hỏi lại sau (idempotent)
  }

  // ---------- chữ ký webhook ----------
  const certCache = new Map(); // url -> {key, exp}
  async function certKey(url) {
    const hit = certCache.get(url);
    if (hit && hit.exp > clock.now()) return hit.key;
    const r = await doFetch(url, { signal: AbortSignal.timeout(cfg.timeoutMs) }).catch(() => null);
    if (!r || !r.ok) return null;
    try {
      const key = crypto.createPublicKey(await r.text()); // chứng chỉ X.509 hoặc khóa công khai PEM
      certCache.set(url, { key, exp: clock.now() + 3600 * 1000 });
      return key;
    } catch { return null; }
  }
  function certUrlAllowed(raw) {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (u.protocol !== 'https:' && !(cfg.certUrlAllowHttp && u.protocol === 'http:')) return false;
    const host = u.hostname.toLowerCase();
    return cfg.certHosts.some((h) => host === String(h).toLowerCase() || host.endsWith(`.${String(h).toLowerCase()}`));
  }
  /** unverified: chưa kiểm với chứng chỉ PayPal thật; chỉ kiểm máy chủ phát chứng chỉ, chưa kiểm chuỗi tin cậy; không có dung sai thời gian (PayPal giao lại 3 ngày). */
  async function verifySignature(raw, h) {
    if (typeof raw !== 'string' || !h) return false;
    const id = h['paypal-transmission-id'];
    const time = h['paypal-transmission-time'];
    const sig = h['paypal-transmission-sig'];
    const url = h['paypal-cert-url'];
    if (!id || !time || !sig || !url || String(h['paypal-auth-algo'] || '').toUpperCase() !== 'SHA256WITHRSA') return false;
    if (!certUrlAllowed(url)) return false;
    const key = await certKey(url);
    if (!key) return false;
    const crc = zlib.crc32(Buffer.from(raw, 'utf8'));
    return webhookIds.some((w) => {
      try { return crypto.verify('sha256', Buffer.from(`${id}|${time}|${w}|${crc}`), key, Buffer.from(sig, 'base64')); } catch { return false; }
    });
  }

  /** Tìm order và attemptRef của một capture khi thông báo không mang đủ: đọc capture rồi order. */
  async function ctxOfCapture(captureId) {
    if (!captureId) return { none: true };
    const r = await getCapture(captureId);
    const c = classify(r);
    if (c === 'reject' && r.status === 404) return { none: true };
    if (c !== 'ok') return { retry: reasonOf(r) };
    const cap = r.json;
    const orderId = (cap.supplementary_data && cap.supplementary_data.related_ids && cap.supplementary_data.related_ids.order_id) || lastSegment(linkHref(cap, 'up'));
    let ref = cap.custom_id;
    if (!ref && orderId) {
      const g = await getOrder(orderId);
      if (classify(g) !== 'ok') return { retry: reasonOf(g) };
      ref = g.json.purchase_units && g.json.purchase_units[0] && g.json.purchase_units[0].custom_id;
    }
    return ref ? { ref, orderId, capture: cap } : { none: true };
  }

  return {
    id: 'paypal',

    capabilities(product) {
      const info = resolveProduct(product);
      return {
        createCanTimeout: true, hardExpiry: { minutes: ORDER_TTL_MINUTES }, cancellable: false, queryable: true, refundable: 'api', refundAsync: true,
        currencies: [...cfg.currencies], regions: ['*'], methods: info ? ['wallet'] : [], operations: info ? [...info.operations] : [],
        partialRefund: true, partialCapture: !!(info && info.manual), threeDs: true,
      };
    },

    async createPayment(p) {
      const info = resolveProduct(p.product);
      if (!info) return { status: 'rejected', reason: `paypal: sản phẩm không hợp lệ: ${p.product}`, failCode: 'invalid_request' };
      const currency = String(p.currency || 'VND').toUpperCase();
      if (!cfg.currencies.includes(currency)) return { status: 'rejected', reason: `paypal: loại tiền ${currency} không được nhận${currency === 'VND' ? ' (PayPal không hỗ trợ VND)' : ' (chưa bật trong cấu hình)'}`, failCode: 'invalid_request' };
      const conv = toPaypalValue(p.amount, currency);
      if (conv.error) return { status: 'rejected', reason: `paypal: ${conv.error}`, failCode: 'invalid_request' };
      const rb = returnBase();
      if (!rb) return { status: 'rejected', reason: 'paypal: thiếu returnBaseUrl (hoặc publicBaseUrl của Hub) để PayPal đưa khách quay về', failCode: 'invalid_request' };
      const returnUrl = `${rb}/return/paypal?ref=${encodeURIComponent(p.attemptRef)}`;
      const json = {
        intent: info.intent,
        purchase_units: [{ reference_id: 'default', custom_id: p.attemptRef, description: String(p.orderInfo || 'Thanh toan').slice(0, 127), amount: { currency_code: currency, value: conv.value } }],
        payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: `${returnUrl}&cancel=1`, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
      };
      const r = await call('POST', '/v2/checkout/orders', { json, idem: `${p.attemptRef}:create` });
      const c = classify(r);
      if (c === 'ok') {
        const id = r.json.id;
        const href = linkHref(r.json, 'payer-action') || linkHref(r.json, 'approve');
        if (!id || !href) return { status: 'unknown' }; // order có thể đã tạo nhưng ta không có đường dẫn: không bỏ attempt
        return { status: 'next_action', nextAction: { type: 'redirect', url: href }, state: { order: id } };
      }
      if (c === 'auth') return { status: 'rejected', reason: reasonOf(r), failCode: 'invalid_request', gatewayCode: String(r.status) };
      if (c === 'rate') return { status: 'rejected', reason: reasonOf(r), failCode: 'rate_limited', gatewayCode: String(r.status) };
      if (c === 'reject') return { status: 'rejected', reason: reasonOf(r), failCode: failCode(issueOf(r)) === 'unknown' ? 'invalid_request' : failCode(issueOf(r)), gatewayCode: issueOf(r) || String(r.status) };
      return { status: 'unknown' }; // 5xx, mất phản hồi: order có thể đã được tạo
    },

    async parseCallback(req) {
      const ack = (o) => ackResponse(o);
      const done = (event) => ({ valid: true, event, ack });
      const ignore = () => ({ valid: true, ack });
      const retry = (reason) => ({ valid: true, retryLater: true, reason, ack });
      const settled = (res) => (res.event ? done(res.event) : (res.retry ? retry(res.retry) : ignore()));

      if (req.channel === 'return') { // khách quay về: không có chữ ký, mọi thứ lấy lại từ PayPal bằng khóa của ta
        const q = req.query || {};
        const ref = q.ref ? String(q.ref) : null;
        if (!ref) return { valid: false, reason: 'return thiếu ref', ack };
        if (q.cancel || !q.token) return { valid: true, event: { ...eventBase(ref, 'pending', 'return', clock.now()) }, ack }; // khách hủy hoặc chưa duyệt: chỉ hiển thị
        return settled(await settleApproved(String(q.token), ref));
      }

      const raw = typeof req.rawBody === 'string' ? req.rawBody : (typeof req.body === 'string' ? req.body : null);
      if (!(await verifySignature(raw, req.headers))) return { valid: false, reason: 'chữ ký không hợp lệ', ack };
      let ev;
      try { ev = JSON.parse(raw); } catch { return { valid: false, reason: 'thân không phải JSON', ack }; }
      const res = ev && ev.resource;
      if (!ev || typeof ev.event_type !== 'string' || !res || typeof res !== 'object') return ignore(); // không mang tin về tiền
      const at = Number.isFinite(Date.parse(ev.create_time)) ? Date.parse(ev.create_time) : clock.now();
      const orderOf = (r) => (r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.order_id) || lastSegment(linkHref(r, 'up'));

      switch (ev.event_type) {
        case 'CHECKOUT.ORDER.APPROVED': {
          const ref = res.purchase_units && res.purchase_units[0] && res.purchase_units[0].custom_id;
          return settled(await settleApproved(res.id, ref));
        }
        case 'PAYMENT.CAPTURE.COMPLETED':
        case 'PAYMENT.CAPTURE.PENDING':
        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.DECLINED': {
          let ref = res.custom_id;
          let orderId = orderOf(res);
          if (!ref || !orderId) {
            const ctx = await ctxOfCapture(res.id);
            if (ctx.retry) return retry(ctx.retry);
            if (ctx.none) return ignore();
            ref = ref || ctx.ref; orderId = orderId || ctx.orderId;
          }
          const { cur, amount } = amountOfObj(res.amount);
          if (ev.event_type === 'PAYMENT.CAPTURE.PENDING') return done({ ...eventBase(ref, 'pending', 'ipn', at) });
          if (amount === null) return retry('số tiền không đổi được sang đơn vị của Hub');
          if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED') return done({ ...eventBase(ref, 'succeeded', 'ipn', at), amount, currency: cur, gatewayTxnId: orderId || res.id });
          return done({ ...eventBase(ref, 'failed', 'ipn', at), amount, currency: cur, failCode: 'declined', gatewayCode: ev.event_type, gatewayTxnId: orderId || res.id });
        }
        case 'PAYMENT.AUTHORIZATION.CREATED':
        case 'PAYMENT.AUTHORIZATION.VOIDED': {
          let ref = res.custom_id;
          const orderId = orderOf(res);
          if (!ref && orderId) {
            const g = await getOrder(orderId);
            if (classify(g) !== 'ok') return retry(reasonOf(g));
            ref = g.json.purchase_units && g.json.purchase_units[0] && g.json.purchase_units[0].custom_id;
          }
          if (!ref || !orderId) return ignore();
          const { cur, amount } = amountOfObj(res.amount);
          if (amount === null) return retry('số tiền không đổi được sang đơn vị của Hub');
          if (ev.event_type === 'PAYMENT.AUTHORIZATION.CREATED') return done({ ...eventBase(ref, 'authorized', 'ipn', at), amount, currency: cur, gatewayTxnId: orderId });
          const expired = res.status === 'EXPIRED';
          return done({ ...eventBase(ref, expired ? 'expired' : 'cancelled', 'ipn', at), amount, currency: cur, failCode: expired ? 'expired' : 'unknown', gatewayCode: res.status || 'VOIDED', gatewayTxnId: orderId });
        }
        case 'PAYMENT.CAPTURE.REFUNDED': {
          if (String(res.custom_id || '').startsWith(HUB_REFUND_PREFIX)) return ignore(); // hoàn do Hub tạo: theo dõi bằng queryRefund
          const ctx = await ctxOfCapture(lastSegment(linkHref(res, 'up')));
          if (ctx.retry) return retry(ctx.retry);
          if (ctx.none) return ignore();
          const { cur, amount } = amountOfObj(res.amount);
          if (amount === null) return retry('số tiền hoàn không đổi được');
          return done({ ...eventBase(ctx.ref, 'reversed', 'ipn', at), amount, currency: cur, gatewayTxnId: res.id }); // hoàn ngoài Hub: tiền đã trả lại người trả
        }
        case 'PAYMENT.CAPTURE.REVERSED': {
          const ctx = await ctxOfCapture(res.id);
          if (ctx.retry) return retry(ctx.retry);
          if (ctx.none) return ignore();
          const { cur, amount } = amountOfObj(res.amount);
          if (amount === null) return retry('số tiền bị đảo không đổi được');
          return done({ ...eventBase(ctx.ref, 'reversed', 'ipn', at), amount, currency: cur, gatewayTxnId: res.id });
        }
        case 'CUSTOMER.DISPUTE.CREATED':
        case 'CUSTOMER.DISPUTE.RESOLVED': {
          const resolved = ev.event_type === 'CUSTOMER.DISPUTE.RESOLVED';
          const code = res.dispute_outcome && res.dispute_outcome.outcome_code;
          const type = !resolved ? 'dispute_opened' : (code === 'RESOLVED_SELLER_FAVOUR' ? 'dispute_won' : (code === 'RESOLVED_BUYER_FAVOUR' ? 'dispute_lost' : null));
          if (!type) return ignore(); // kết quả khác (hủy, hòa): Hub chưa có chuẩn tương ứng
          const tx = res.disputed_transactions && res.disputed_transactions[0] && res.disputed_transactions[0].seller_transaction_id;
          const ctx = await ctxOfCapture(tx);
          if (ctx.retry) return retry(ctx.retry);
          if (ctx.none || !res.dispute_id) return ignore();
          const { cur, amount } = amountOfObj(res.dispute_amount);
          if (amount === null) return retry('số tiền tranh chấp không đổi được');
          return done({ ...eventBase(ctx.ref, type, 'ipn', at), amount, currency: cur, gatewayTxnId: String(res.dispute_id) });
        }
        default: return ignore(); // sự kiện lạ hoặc không cần (CHECKOUT.ORDER.COMPLETED, PAYMENT.REFUND.*): không đoán
      }
    },

    async query(p) {
      const id = orderIdOf(p.state);
      if (!id) return { state: 'unknown' }; // tạo mất phản hồi nên không có mã order: không tìm lại được, chờ webhook
      const r = await getOrder(id);
      const c = classify(r);
      if (c === 'reject' && r.status === 404) return { state: 'not_found' };
      if (c !== 'ok') return { state: 'unknown' };
      const e = eventFromOrder(r.json, p.attemptRef, 'query', clock.now());
      return e.unconvertible ? { state: 'unknown' } : e; // CHỈ ĐỌC: order APPROVED chưa thu vẫn là pending
    },

    async capture(p) {
      const orderId = orderIdOf(p.state, p.gatewayTxnId);
      if (!orderId) return { status: 'rejected', reason: 'paypal: thiếu mã order (gatewayTxnId hoặc state.order)' };
      const currency = String(p.currency || '').toUpperCase();
      const conv = toPaypalValue(p.amount, currency);
      if (conv.error) return { status: 'rejected', reason: `paypal: ${conv.error}` };
      const sameAmount = (a) => amountOfObj(a).amount === p.amount;
      const g = await getOrder(orderId);
      const gc = classify(g);
      if (gc === 'rate') throw notSent('rate_limited');
      if (gc !== 'ok') return gc === 'reject' ? { status: 'rejected', reason: reasonOf(g) } : { status: 'unknown' };
      const pay = (g.json.purchase_units && g.json.purchase_units[0] && g.json.purchase_units[0].payments) || {};
      const done = (pay.captures || []).find((c) => c.status === 'COMPLETED');
      if (done) return sameAmount(done.amount) ? { status: 'captured', gatewayTxnId: orderId } : { status: 'unknown' };
      const auth = (pay.authorizations || [])[0];
      if (!auth) return { status: 'rejected', reason: 'paypal: order chưa có khoản giữ' };
      if (['VOIDED', 'EXPIRED', 'DENIED'].includes(auth.status)) return { status: 'rejected', reason: `paypal: khoản giữ ở trạng thái ${auth.status}` };
      const r = await call('POST', `/v2/payments/authorizations/${encodeURIComponent(auth.id)}/capture`, { json: { amount: { currency_code: currency, value: conv.value }, final_capture: true }, idem: p.idempotencyKey });
      const c = classify(r);
      if (c === 'ok') return r.json.status === 'COMPLETED' ? { status: 'captured', gatewayTxnId: orderId } : { status: 'unknown' }; // PENDING: chưa chắc có tiền
      if (c === 'rate') throw notSent('rate_limited');
      if (c === 'auth') return { status: 'rejected', reason: reasonOf(r) };
      if (c !== 'reject') return { status: 'unknown' };
      if (issueOf(r) === 'AUTHORIZATION_ALREADY_CAPTURED') { // giải quyết bằng trạng thái thật, không đoán
        const g2 = await getOrder(orderId);
        if (classify(g2) !== 'ok') return { status: 'unknown' };
        const cap = ((g2.json.purchase_units[0].payments || {}).captures || []).find((x) => x.status === 'COMPLETED');
        return cap && sameAmount(cap.amount) ? { status: 'captured', gatewayTxnId: orderId } : { status: 'unknown' };
      }
      return { status: 'rejected', reason: reasonOf(r) };
    },

    async void(p) {
      const orderId = orderIdOf(p.state, p.gatewayTxnId);
      if (!orderId) return { status: 'rejected', reason: 'paypal: thiếu mã order (gatewayTxnId hoặc state.order)' };
      const g = await getOrder(orderId);
      const gc = classify(g);
      if (gc === 'rate') throw notSent('rate_limited');
      if (gc !== 'ok') return gc === 'reject' ? { status: 'rejected', reason: reasonOf(g) } : { status: 'unknown' };
      const pay = (g.json.purchase_units && g.json.purchase_units[0] && g.json.purchase_units[0].payments) || {};
      const auth = (pay.authorizations || [])[0];
      if (!auth) return { status: 'rejected', reason: 'paypal: order chưa có khoản giữ' };
      if (auth.status === 'VOIDED' || auth.status === 'EXPIRED') return { status: 'voided' };
      if (auth.status === 'CAPTURED') return { status: 'rejected', reason: 'paypal: khoản giữ đã được thu' };
      const r = await call('POST', `/v2/payments/authorizations/${encodeURIComponent(auth.id)}/void`, { json: {}, idem: p.idempotencyKey });
      const c = classify(r);
      if (c === 'ok') return { status: 'voided' };
      if (c === 'rate') throw notSent('rate_limited');
      if (c === 'auth') return { status: 'rejected', reason: reasonOf(r) };
      if (c !== 'reject') return { status: 'unknown' };
      const issue = issueOf(r);
      if (issue === 'AUTHORIZATION_VOIDED' || issue === 'AUTHORIZATION_EXPIRED') return { status: 'voided' };
      if (issue === 'AUTHORIZATION_ALREADY_CAPTURED') return { status: 'rejected', reason: 'paypal: khoản giữ đã được thu' };
      return { status: 'rejected', reason: reasonOf(r) };
    },

    async refund(p) {
      const orderId = orderIdOf(p.state, p.gatewayTxnId);
      if (!orderId) return { status: 'manual_required' };
      const currency = String(p.currency || '').toUpperCase();
      const conv = toPaypalValue(p.amount, currency);
      if (conv.error) return { status: 'failed' };
      const g = await getOrder(orderId);
      const gc = classify(g);
      if (gc === 'rate') throw notSent('rate_limited');
      if (gc !== 'ok') return gc === 'reject' ? { status: 'failed' } : { status: 'processing' };
      const caps = ((g.json.purchase_units[0] || {}).payments || {}).captures || [];
      const cap = caps.find((c) => c.status === 'COMPLETED' || c.status === 'PARTIALLY_REFUNDED');
      if (!cap) return caps.some((c) => c.status === 'REFUNDED') ? { status: 'failed' } : { status: 'manual_required' }; // đã hoàn đủ: chắc chắn không hoàn thêm được
      const r = await call('POST', `/v2/payments/captures/${encodeURIComponent(cap.id)}/refund`, { json: { amount: { currency_code: currency, value: conv.value }, custom_id: `${HUB_REFUND_PREFIX}${p.refundRef}`, note_to_payer: 'Hoan tien' }, idem: `${p.refundRef}:refund` });
      const c = classify(r);
      if (c === 'ok') return { status: refundStatus(r.json.status) };
      if (c === 'rate') throw notSent('rate_limited');
      if (c === 'unknown') return { status: 'processing' }; // có thể đã chạy: đối soát bằng queryRefund, không coi là failed
      return { status: 'failed' }; // auth, CAPTURE_FULLY_REFUNDED, REFUND_AMOUNT_EXCEEDED...: chắc chắn không hoàn
    },

    async queryRefund(p) {
      const orderId = orderIdOf(p.state);
      if (!orderId) return { status: 'processing' };
      const g = await getOrder(orderId);
      if (classify(g) !== 'ok') return { status: 'processing' };
      const refunds = ((g.json.purchase_units[0] || {}).payments || {}).refunds || [];
      const mine = refunds.find((x) => x && x.custom_id === `${HUB_REFUND_PREFIX}${p.refundRef}`); // inferred: order trả refunds kèm custom_id
      return mine ? { status: refundStatus(mine.status) } : { status: 'requested' };
    },
  };
}

function configWarnings(cfg) {
  const w = [];
  if (cfg && typeof cfg.baseUrl === 'string' && /sandbox/.test(cfg.baseUrl)) w.push('cổng paypal: đang dùng môi trường sandbox (api-m.sandbox.paypal.com)');
  if (cfg && Array.isArray(cfg.currencies) && cfg.currencies.includes('VND')) w.push('cổng paypal: PayPal không hỗ trợ VND, adapter sẽ không nhận được cấu hình này');
  if (cfg && Array.isArray(cfg.currencies) && cfg.currencies.includes('TWD')) w.push('cổng paypal: tài liệu tóm tắt tự mâu thuẫn về TWD (có phần thập phân hay không): kiểm với sandbox trước khi bật');
  if (cfg && String(cfg.product || 'charge').toLowerCase() === 'auth') w.push('cổng paypal: sản phẩm auth giữ tiền tới 29 ngày: đặt reconcile.perGateway.paypal.maxAgeSeconds lớn hơn hạn giữ để Hub không báo authorization_stale sớm');
  w.push('cổng paypal: order chỉ sống 3 giờ ở CREATED; khách duyệt xong mà cả kênh return lẫn webhook CHECKOUT.ORDER.APPROVED mất thì không bị thu tiền và phải thử lại');
  return w;
}

// Khai báo cho registry (PHUB-D-023). Webhook đặt ở trang PayPal trỏ tới ${publicBaseUrl}/ipn/paypal; return_url của order trỏ tới ${publicBaseUrl}/return/paypal.
const adapter = {
  id: 'paypal',
  create: (config, deps) => createPaypalAdapter(config, deps),
  configWarnings,
};

module.exports = { adapter, createPaypalAdapter, toPaypalValue, fromPaypalValue, PRODUCTS, PAYPAL_CURRENCIES, NO_DECIMAL, FAIL_CODES };

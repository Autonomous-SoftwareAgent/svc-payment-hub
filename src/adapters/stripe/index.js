'use strict';
// spec: STRP-S-001
// spec: STRP-S-002
// Adapter Stripe (Checkout hosted + PaymentIntent), cổng quốc tế đầu tiên. Thiết kế: STRP-D-001 và STRP-D-002; nghiên cứu: docs/agent/stripe-research.md.
// MỌI hành vi ở đây là documented hoặc inferred từ tài liệu, mã stripe-node và đặc tả stripe-mock; CHƯA kiểm với Stripe thật (chưa có khóa test).
// Không dùng SDK stripe-node: nó tự thử lại và tự sinh khóa idempotency, che trạng thái "chưa rõ" mà Hub cần thấy. Gọi HTTP thẳng qua deps.fetch.
const crypto = require('node:crypto');
const { createFailCodeMapper } = require('../fail-codes');
const { CURRENCY_EXPONENT } = require('../../contract');

const API_VERSION = '2026-09-30.endive';
const TOLERANCE_SECONDS = 300; // hai chiều (Hub chặt hơn SDK, vốn chỉ chặn timestamp quá cũ)
const DEFAULT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'VND', 'SGD'];
const UNVERIFIED_CURRENCIES = ['UGX', 'BHD', 'JOD', 'KWD', 'OMR', 'TND']; // UGX tài liệu tự mâu thuẫn; tiền ba chữ số cần quy tắc bội 10 (chưa kiểm)
const STRIPE_SCALE = { ISK: 100, UGX: 100 }; // hai chữ số thập phân luôn 00 dù ISO 4217 nói 0

// Sản phẩm theo capabilities(product): thu ngay hoặc giữ rồi thu (STRP-D-001)
const PRODUCTS = {
  charge: { manual: false, operations: ['purchase', 'refund', 'inquire'] },
  auth: { manual: true, operations: ['authorize', 'capture', 'void', 'refund', 'inquire'] },
};

// Mã thẻ của Stripe -> lý do thất bại chuẩn (STRP-D-002, đề xuất: có hàng đoán). Chỉ ảnh hưởng lý do hiển thị và đo đếm.
const FAIL_CODES = {
  insufficient_funds: 'insufficient_funds',
  generic_decline: 'declined', do_not_honor: 'declined', call_issuer: 'declined', pickup_card: 'declined', restricted_card: 'declined', card_not_supported: 'declined', expired_card: 'declined',
  fraudulent: 'fraud', lost_card: 'fraud', stolen_card: 'fraud',
  authentication_required: 'authentication_required',
  processing_error: 'gateway_error', issuer_not_available: 'gateway_error', reenter_transaction: 'gateway_error',
  rate_limit: 'rate_limited',
};

const refundStatus = (s) => ({ succeeded: 'succeeded', pending: 'processing', requires_action: 'manual_required', failed: 'failed', canceled: 'failed' }[s] || 'processing');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || '').toLowerCase());
  const y = Buffer.from(String(b || '').toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Đổi số tiền của Hub (đơn vị nhỏ nhất theo ISO 4217) sang đơn vị của Stripe. Trả {amount} hoặc {error}. */
function toStripeAmount(amount, currency) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return { error: 'amount phải là số nguyên dương' };
  const scale = STRIPE_SCALE[currency] || 1;
  if (CURRENCY_EXPONENT[currency] === 3 && amount % 10 !== 0) return { error: `${currency}: số tiền phải là bội của 10 (Stripe, chưa kiểm)` };
  return { amount: amount * scale };
}

/** Chiều ngược lại. null khi không đổi được (ví dụ ISK không phải bội của 100): không đoán. */
function fromStripeAmount(n, currency) {
  if (!Number.isSafeInteger(n)) return null;
  const scale = STRIPE_SCALE[currency] || 1;
  return n % scale === 0 ? n / scale : null;
}

/** Form-encode lồng nhau kiểu Stripe: a[b][0][c]=v. Bỏ undefined và null. */
function encodeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x !== null && typeof x === 'object' ? encodeForm(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

function ackResponse(outcome) {
  if (outcome === 'invalid_signature') return { status: 400, body: '{"error":"invalid_signature"}', contentType: 'application/json' };
  if (outcome === 'error') return { status: 500, body: '{"error":"retry"}', contentType: 'application/json' };
  return { status: 200, body: '{"received":true}', contentType: 'application/json' }; // unknown_attempt và amount_mismatch cũng 200: Hub đã giữ bằng chứng, giao lại không giúp gì
}

function notSent(code) {
  const e = new Error(`stripe ${code}: chưa xử lý, gọi lại sau`);
  e.notSent = true;
  e.code = code;
  return e;
}

function createStripeAdapter(config, deps = {}) {
  const cfg = {
    baseUrl: 'https://api.stripe.com', apiVersion: API_VERSION, timeoutMs: 15000, product: 'charge', sessionExpiresMinutes: 60, currencies: DEFAULT_CURRENCIES, ...config,
  };
  const doFetch = deps.fetch || globalThis.fetch;
  const clock = deps.clock || { now: () => Date.now() };
  if (!cfg.secretKey) throw new Error('stripe: thiếu config secretKey');
  if (!cfg.webhookSecret || (Array.isArray(cfg.webhookSecret) && !cfg.webhookSecret.length)) throw new Error('stripe: thiếu config webhookSecret (whsec_..., không có thì không kiểm được chữ ký webhook)');
  if (!PRODUCTS[String(cfg.product).toLowerCase()]) throw new Error(`stripe: product không hợp lệ: ${cfg.product} (${Object.keys(PRODUCTS).join(', ')})`);
  if (!Array.isArray(cfg.currencies) || cfg.currencies.some((c) => !Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, c))) throw new Error('stripe: currencies phải là danh sách mã ISO 4217 mà lõi biết');
  const minutes = Number(cfg.sessionExpiresMinutes);
  if (!Number.isInteger(minutes) || minutes < 31 || minutes > 1439) throw new Error('stripe: sessionExpiresMinutes phải là số nguyên từ 31 đến 1439 (Stripe cho phiên sống 30 phút đến 24 giờ)');
  const secrets = Array.isArray(cfg.webhookSecret) ? cfg.webhookSecret : [cfg.webhookSecret];
  const failCode = createFailCodeMapper('stripe', FAIL_CODES, cfg.failCodeMap);
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${cfg.secretKey}:`).toString('base64')}`;

  const resolveProduct = (p) => {
    const key = p === undefined || p === null || p === 'default' ? String(cfg.product).toLowerCase() : String(p).toLowerCase();
    return PRODUCTS[key] ? { key, ...PRODUCTS[key] } : null;
  };

  /** Một lời gọi HTTP. unreadable=true khi lỗi mạng, timeout hoặc thân không phải JSON (kết quả CHƯA RÕ nếu là thao tác ghi). */
  async function call(method, path, { form, query, idem } = {}) {
    const qs = query && Object.keys(query).length ? `?${encodeForm(query).join('&')}` : '';
    const headers = { authorization: auth, 'stripe-version': cfg.apiVersion };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = encodeForm(form).join('&'); }
    if (idem) headers['idempotency-key'] = idem;
    try {
      const res = await doFetch(base + path + qs, { method, headers, body, signal: AbortSignal.timeout(cfg.timeoutMs) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* giữ null */ }
      if (!json || typeof json !== 'object') return { unreadable: true, status: res.status };
      return { status: res.status, json };
    } catch {
      return { unreadable: true, status: 0 };
    }
  }

  /** ok | auth (khóa của ta sai) | rate (429, chưa tác dụng) | conflict (409, đang chạy) | reject (4xx còn lại, chắc chắn không xảy ra) | unknown (5xx, mất phản hồi) */
  function classify(r) {
    if (r.unreadable) return 'unknown';
    if (r.status >= 200 && r.status < 300) return 'ok';
    if (r.status === 401 || r.status === 403) return 'auth';
    if (r.status === 429) return 'rate';
    if (r.status === 409) return 'conflict';
    if (r.status >= 400 && r.status < 500) return 'reject';
    return 'unknown';
  }
  const errOf = (r) => (r.json && r.json.error) || {};
  const reasonOf = (r) => `stripe ${r.status}${errOf(r).code ? ` ${errOf(r).code}` : ''}: ${String(errOf(r).message || '').slice(0, 200)}`;
  const failFor = (r) => (r.status === 402 ? failCode(errOf(r).decline_code || errOf(r).code) : 'invalid_request');

  const getIntent = (pi) => call('GET', `/v1/payment_intents/${encodeURIComponent(pi)}`);
  const getSession = (cs, expand) => call('GET', `/v1/checkout/sessions/${encodeURIComponent(cs)}`, expand ? { query: { 'expand[]': 'payment_intent' } } : {});

  function eventBase(attemptRef, type, source, at) {
    return { gateway: 'stripe', attemptRef, type, occurredAt: at, source };
  }

  /** Sự kiện chuẩn từ một PaymentIntent (nguồn sự thật về tiền): dùng chung cho webhook và truy vấn. null nếu chưa có tin về tiền. */
  function eventFromIntent(pi, attemptRef, source, at) {
    const cur = String(pi.currency || '').toUpperCase();
    if (pi.status === 'succeeded' && pi.amount_received > 0) {
      const amount = fromStripeAmount(pi.amount_received, cur);
      return amount === null ? { unconvertible: true } : { ...eventBase(attemptRef, 'succeeded', source, at), amount, currency: cur, gatewayTxnId: pi.id };
    }
    if (pi.status === 'requires_capture' && pi.amount_capturable > 0) {
      const amount = fromStripeAmount(pi.amount_capturable, cur);
      return amount === null ? { unconvertible: true } : { ...eventBase(attemptRef, 'authorized', source, at), amount, currency: cur, gatewayTxnId: pi.id };
    }
    if (pi.status === 'canceled') {
      const amount = fromStripeAmount(pi.amount, cur);
      if (amount === null) return { unconvertible: true };
      const auto = pi.cancellation_reason === 'automatic'; // unverified: giá trị khi giữ tiền hết hạn
      return { ...eventBase(attemptRef, auto ? 'expired' : 'cancelled', source, at), amount, currency: cur, gatewayTxnId: pi.id, failCode: auto ? 'expired' : (pi.cancellation_reason === 'requested_by_customer' ? 'user_cancelled' : 'unknown'), gatewayCode: pi.cancellation_reason || undefined };
    }
    return null;
  }

  /** Tìm attemptRef của một PaymentIntent không do webhook mang theo (dispute, refund ngoài Hub): GET rồi đọc metadata. */
  async function lookupAttemptRef(piId) {
    if (!piId) return { none: true };
    const r = await getIntent(piId);
    const c = classify(r);
    if (c === 'ok') { const ref = r.json.metadata && r.json.metadata.attemptRef; return ref ? { ref, pi: r.json } : { none: true }; }
    if (c === 'reject' && r.status === 404) return { none: true }; // PaymentIntent không có trong tài khoản này
    return { retry: `${reasonOf(r)}` };
  }

  /** Kiểm Stripe-Signature (STRP-D-001): t= và v1=, HMAC-SHA256 của "t.thân thô", nguyên chuỗi whsec_, hằng thời gian, dung sai hai chiều. */
  function verifySignature(raw, header) {
    if (typeof raw !== 'string' || typeof header !== 'string') return false;
    let t = null;
    const v1 = [];
    for (const part of header.split(',')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k === 't' && t === null) t = v; else if (k === 'v1') v1.push(v);
    }
    if (t === null || !/^\d+$/.test(t) || !v1.length) return false;
    if (Math.abs(Math.floor(clock.now() / 1000) - Number(t)) > TOLERANCE_SECONDS) return false;
    return secrets.some((s) => { const exp = crypto.createHmac('sha256', s).update(`${t}.${raw}`).digest('hex'); return v1.some((x) => safeEqualHex(exp, x)); });
  }

  return {
    id: 'stripe',

    capabilities(product) {
      const info = resolveProduct(product);
      return {
        createCanTimeout: true, hardExpiry: { minutes: minutes }, cancellable: true, queryable: true, refundable: 'api', refundAsync: true,
        currencies: [...cfg.currencies], regions: ['*'], methods: info ? ['card_international'] : [], operations: info ? [...info.operations] : [],
        partialRefund: true, partialCapture: !!(info && info.manual), threeDs: true, extraSchema: { locale: 'string', customerEmail: 'string' },
      };
    },

    async createPayment(p) {
      const info = resolveProduct(p.product);
      if (!info) return { status: 'rejected', reason: `stripe: sản phẩm không hợp lệ: ${p.product}`, failCode: 'invalid_request' };
      const currency = String(p.currency || 'VND').toUpperCase();
      if (!cfg.currencies.includes(currency)) return { status: 'rejected', reason: `stripe: loại tiền ${currency} chưa được bật trong cấu hình`, failCode: 'invalid_request' };
      const conv = toStripeAmount(p.amount, currency);
      if (conv.error) return { status: 'rejected', reason: `stripe: ${conv.error}`, failCode: 'invalid_request' };
      const successUrl = p.returnUrl || cfg.successUrl;
      if (!successUrl) return { status: 'rejected', reason: 'stripe: thiếu returnUrl', failCode: 'invalid_request' };
      const extra = p.extra || {};
      const form = {
        mode: 'payment', success_url: successUrl, cancel_url: p.returnUrl || cfg.cancelUrl || successUrl, client_reference_id: p.attemptRef,
        expires_at: Math.floor(clock.now() / 1000) + minutes * 60,
        line_items: [{ quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: conv.amount, product_data: { name: String(p.orderInfo || 'Thanh toan').slice(0, 250) } } }],
        metadata: { attemptRef: p.attemptRef }, payment_intent_data: { metadata: { attemptRef: p.attemptRef }, ...(info.manual ? { capture_method: 'manual' } : {}) },
        ...(extra.locale ? { locale: extra.locale } : {}), ...(extra.customerEmail ? { customer_email: extra.customerEmail } : {}),
      };
      const r = await call('POST', '/v1/checkout/sessions', { form, idem: `${p.attemptRef}:create` });
      const c = classify(r);
      if (c === 'ok') {
        const s = r.json;
        if (!s.id || !s.url) return { status: 'unknown' }; // phiên có thể đã tạo nhưng ta không có đường dẫn: không bỏ attempt
        return { status: 'next_action', nextAction: { type: 'redirect', url: s.url }, state: { cs: s.id }, ...(Number.isInteger(s.expires_at) ? { expiresAt: s.expires_at * 1000 } : {}) };
      }
      if (c === 'auth') return { status: 'rejected', reason: reasonOf(r), failCode: 'invalid_request', gatewayCode: String(r.status) };
      if (c === 'rate') return { status: 'rejected', reason: reasonOf(r), failCode: 'rate_limited', gatewayCode: String(r.status) };
      if (c === 'reject') return { status: 'rejected', reason: reasonOf(r), failCode: failFor(r), gatewayCode: errOf(r).code || String(r.status) };
      return { status: 'unknown' }; // 409, 5xx, mất phản hồi: phiên có thể đã được tạo
    },

    async parseCallback(req) {
      const ack = (o) => ackResponse(o);
      const raw = typeof req.rawBody === 'string' ? req.rawBody : (typeof req.body === 'string' ? req.body : null);
      if (!verifySignature(raw, req.headers && req.headers['stripe-signature'])) return { valid: false, reason: 'chữ ký không hợp lệ', ack };
      let ev;
      try { ev = JSON.parse(raw); } catch { return { valid: false, reason: 'thân không phải JSON', ack }; }
      const obj = ev && ev.data && ev.data.object;
      if (!ev || typeof ev.type !== 'string' || !obj || typeof obj !== 'object') return { valid: true, ack }; // không mang tin về tiền
      const at = Number.isFinite(Number(ev.created)) && Number(ev.created) > 0 ? Number(ev.created) * 1000 : clock.now();
      const done = (event) => ({ valid: true, event, ack });
      const ignore = () => ({ valid: true, ack });
      const retry = (reason) => ({ valid: true, retryLater: true, reason, ack });
      const fromIntent = (typeFilter) => {
        const ref = obj.metadata && obj.metadata.attemptRef;
        if (!ref) return ignore(); // PaymentIntent không thuộc Hub (tài khoản dùng chung): bỏ qua
        const e = eventFromIntent(obj, ref, 'ipn', at);
        if (!e) return ignore();
        if (e.unconvertible) return retry('số tiền không đổi được sang đơn vị của Hub');
        return typeFilter && !typeFilter.includes(e.type) ? ignore() : done(e);
      };
      switch (ev.type) {
        case 'payment_intent.succeeded': return fromIntent(['succeeded']);
        case 'payment_intent.amount_capturable_updated': return fromIntent(['authorized']);
        case 'payment_intent.canceled': return fromIntent(['cancelled', 'expired']);
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed': {
          const ref = obj.client_reference_id || (obj.metadata && obj.metadata.attemptRef);
          if (!ref) return ignore();
          const cur = String(obj.currency || '').toUpperCase();
          const amount = fromStripeAmount(obj.amount_total, cur);
          if (amount === null) return retry('số tiền không đổi được sang đơn vị của Hub');
          const expired = ev.type === 'checkout.session.expired';
          return done({ ...eventBase(String(ref), expired ? 'expired' : 'failed', 'ipn', at), amount, currency: cur, failCode: expired ? 'expired' : 'unknown', gatewayCode: ev.type, ...(typeof obj.payment_intent === 'string' ? { gatewayTxnId: obj.payment_intent } : {}) });
        }
        case 'charge.dispute.created':
        case 'charge.dispute.closed': {
          const closed = ev.type === 'charge.dispute.closed';
          const type = !closed ? 'dispute_opened' : (obj.status === 'won' ? 'dispute_won' : (obj.status === 'lost' ? 'dispute_lost' : null));
          if (!type) return ignore(); // warning_closed, prevented: Hub chưa có chuẩn tương ứng
          const found = await lookupAttemptRef(obj.payment_intent);
          if (found.retry) return retry(found.retry);
          if (found.none) return ignore();
          const cur = String(obj.currency || '').toUpperCase();
          const amount = fromStripeAmount(obj.amount, cur);
          if (amount === null) return retry('số tiền tranh chấp không đổi được');
          return done({ ...eventBase(found.ref, type, 'ipn', at), amount, currency: cur, gatewayTxnId: obj.id });
        }
        case 'refund.created': {
          if (obj.metadata && obj.metadata.hubRefund) return ignore(); // hoàn do Hub tạo: theo dõi bằng queryRefund
          const found = await lookupAttemptRef(obj.payment_intent);
          if (found.retry) return retry(found.retry);
          if (found.none) return ignore();
          const cur = String(obj.currency || '').toUpperCase();
          const amount = fromStripeAmount(obj.amount, cur);
          if (amount === null) return retry('số tiền hoàn không đổi được');
          return done({ ...eventBase(found.ref, 'reversed', 'ipn', at), amount, currency: cur, gatewayTxnId: obj.id }); // hoàn ngoài Hub (Dashboard): tiền đã trả lại người trả
        }
        default: return ignore(); // sự kiện lạ hoặc không cần: không đoán
      }
    },

    async query(p) {
      const cs = p.state && p.state.cs;
      if (!cs) return { state: 'unknown' }; // tạo mất phản hồi nên không có mã phiên: không tìm lại được, chờ webhook (STRP-D-001)
      const r = await getSession(cs, true);
      const c = classify(r);
      if (c === 'reject' && r.status === 404) return { state: 'not_found' };
      if (c !== 'ok') return { state: 'unknown' };
      const s = r.json;
      const at = clock.now();
      const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
      if (pi) {
        const e = eventFromIntent(pi, p.attemptRef, 'query', at);
        if (e && e.unconvertible) return { state: 'unknown' };
        if (e) return e;
      }
      if (s.status === 'expired') return { ...eventBase(p.attemptRef, 'expired', 'query', at), amount: p.amount, failCode: 'expired', gatewayCode: 'session_expired' };
      if (s.status === 'complete' && s.payment_status === 'paid' && !pi) {
        const cur = String(s.currency || '').toUpperCase();
        const amount = fromStripeAmount(s.amount_total, cur);
        return amount === null ? { state: 'unknown' } : { ...eventBase(p.attemptRef, 'succeeded', 'query', at), amount, currency: cur, gatewayTxnId: typeof s.payment_intent === 'string' ? s.payment_intent : cs };
      }
      return { ...eventBase(p.attemptRef, 'pending', 'query', at) }; // phiên còn mở hoặc đang xử lý: chưa rõ, không suy thất bại
    },

    async cancel(p) {
      const cs = p.state && p.state.cs;
      if (!cs) return { cancelled: false };
      const r = await call('POST', `/v1/checkout/sessions/${encodeURIComponent(cs)}/expire`, { form: {}, idem: `${p.attemptRef}:expire` });
      const c = classify(r);
      if (c === 'ok') return { cancelled: r.json.status === 'expired' };
      if (c === 'reject') { // không còn open: đã hết hạn thì coi là hủy được, đã complete thì khách đã trả
        const g = await getSession(cs, false);
        return { cancelled: classify(g) === 'ok' && g.json.status === 'expired' };
      }
      return { cancelled: false };
    },

    async capture(p) {
      const pi = p.gatewayTxnId;
      if (!pi || !/^pi_/.test(pi)) return { status: 'rejected', reason: 'stripe: thiếu mã PaymentIntent (gatewayTxnId)' };
      const currency = String(p.currency || '').toUpperCase();
      const conv = toStripeAmount(p.amount, currency);
      if (conv.error) return { status: 'rejected', reason: `stripe: ${conv.error}` };
      const sameAmount = (j) => fromStripeAmount(j.amount_received, String(j.currency || '').toUpperCase()) === p.amount;
      const r = await call('POST', `/v1/payment_intents/${encodeURIComponent(pi)}/capture`, { form: { amount_to_capture: conv.amount }, idem: p.idempotencyKey });
      const c = classify(r);
      if (c === 'ok') return r.json.status === 'succeeded' && sameAmount(r.json) ? { status: 'captured', gatewayTxnId: pi } : { status: 'unknown' };
      if (c === 'rate') throw notSent('rate_limited');
      if (c === 'auth') return { status: 'rejected', reason: reasonOf(r) };
      if (c !== 'reject') return { status: 'unknown' };
      const code = errOf(r).code;
      if (code === 'charge_already_captured' || code === 'payment_intent_unexpected_state') { // giải quyết bằng trạng thái thật, không đoán
        const g = await getIntent(pi);
        if (classify(g) !== 'ok') return { status: 'unknown' };
        if (g.json.status === 'succeeded') return sameAmount(g.json) ? { status: 'captured', gatewayTxnId: pi } : { status: 'unknown' };
        if (g.json.status === 'canceled') return { status: 'rejected', reason: 'stripe: khoản giữ đã nhả hoặc hết hạn' };
        return { status: 'unknown' };
      }
      return { status: 'rejected', reason: reasonOf(r) }; // charge_expired_for_capture, amount_too_large, tham số sai...
    },

    async void(p) {
      const pi = p.gatewayTxnId;
      if (!pi || !/^pi_/.test(pi)) return { status: 'rejected', reason: 'stripe: thiếu mã PaymentIntent (gatewayTxnId)' };
      const r = await call('POST', `/v1/payment_intents/${encodeURIComponent(pi)}/cancel`, { form: {}, idem: p.idempotencyKey });
      const c = classify(r);
      if (c === 'ok') return r.json.status === 'canceled' ? { status: 'voided' } : { status: 'unknown' };
      if (c === 'rate') throw notSent('rate_limited');
      if (c === 'auth') return { status: 'rejected', reason: reasonOf(r) };
      if (c !== 'reject') return { status: 'unknown' };
      if (errOf(r).code === 'payment_intent_unexpected_state') {
        const g = await getIntent(pi);
        if (classify(g) !== 'ok') return { status: 'unknown' };
        if (g.json.status === 'canceled') return { status: 'voided' };
        if (g.json.status === 'succeeded') return { status: 'rejected', reason: 'stripe: khoản giữ đã được thu' };
        return { status: 'unknown' };
      }
      return { status: 'rejected', reason: reasonOf(r) };
    },

    async refund(p) {
      let pi = p.gatewayTxnId;
      if (!pi || !/^pi_/.test(pi)) {
        const q = await this.query({ attemptRef: p.attemptRef, amount: p.amount, state: p.state });
        if (q && q.gatewayTxnId && /^pi_/.test(q.gatewayTxnId)) pi = q.gatewayTxnId; else return { status: 'manual_required' };
      }
      const conv = toStripeAmount(p.amount, String(p.currency || '').toUpperCase());
      if (conv.error) return { status: 'failed' };
      const r = await call('POST', '/v1/refunds', { form: { payment_intent: pi, amount: conv.amount, metadata: { hubRefund: p.refundRef, attemptRef: p.attemptRef } }, idem: `${p.refundRef}:refund` });
      const c = classify(r);
      if (c === 'ok') return { status: refundStatus(r.json.status) };
      if (c === 'rate') throw notSent('rate_limited');
      if (c === 'conflict' || c === 'unknown') return { status: 'processing' }; // có thể đã chạy: đối soát bằng queryRefund, không coi là failed
      return { status: 'failed' }; // auth, charge_already_refunded, amount_too_large, charge_disputed...: chắc chắn không hoàn
    },

    async queryRefund(p) {
      const cs = p.state && p.state.cs;
      if (!cs) return { status: 'processing' };
      const s = await getSession(cs, false);
      if (classify(s) !== 'ok') return { status: 'processing' };
      const pi = typeof s.json.payment_intent === 'string' ? s.json.payment_intent : (s.json.payment_intent && s.json.payment_intent.id);
      if (!pi) return { status: 'requested' };
      const r = await call('GET', '/v1/refunds', { query: { payment_intent: pi, limit: 100 } });
      if (classify(r) !== 'ok' || !Array.isArray(r.json.data)) return { status: 'processing' };
      const mine = r.json.data.find((x) => x && x.metadata && x.metadata.hubRefund === p.refundRef);
      return mine ? { status: refundStatus(mine.status) } : { status: 'requested' };
    },
  };
}

function configWarnings(cfg) {
  const w = [];
  if (cfg && typeof cfg.secretKey === 'string' && /_test_/.test(cfg.secretKey)) w.push('cổng stripe: đang dùng khóa test (sk_test_ hoặc rk_test_)');
  const risky = ((cfg && cfg.currencies) || []).filter((c) => UNVERIFIED_CURRENCIES.includes(c));
  if (risky.length) w.push(`cổng stripe: loại tiền ${risky.join(', ')} chưa kiểm với Stripe thật (số mũ hoặc quy tắc làm tròn của Stripe khác ISO 4217): kiểm bằng khóa test trước khi bật`);
  if (cfg && String(cfg.product || 'charge').toLowerCase() === 'auth') w.push('cổng stripe: sản phẩm auth giữ tiền tới 7 ngày: đặt reconcile.perGateway.stripe.maxAgeSeconds lớn hơn hạn giữ để Hub không báo authorization_stale sớm');
  return w;
}

// Khai báo cho registry (PHUB-D-023). Webhook của Stripe đặt ở Dashboard trỏ tới ${publicBaseUrl}/ipn/stripe.
const adapter = {
  id: 'stripe',
  create: (config, deps) => createStripeAdapter(config, deps),
  configWarnings,
};

module.exports = { adapter, createStripeAdapter, toStripeAmount, fromStripeAmount, encodeForm, PRODUCTS, API_VERSION, STRIPE_SCALE, FAIL_CODES };

'use strict';
// spec: PYPL-S-003
// Simulator PayPal (Orders v2 + Payments v2 + webhook + tranh chấp) chạy bằng HTTP, không phụ thuộc thư viện ngoài (PYPL-D-003).
// HÌNH THỨC theo tài liệu developer.paypal.com (xem docs/agent/paypal-research.md): OAuth client_credentials, Bearer, PayPal-Request-Id lưu kết quả,
// trạng thái order, links payer-action, capture, authorize, void, refund, webhook ký RSA-SHA256 trên transmissionId|time|webhookId|crc32(thân thô).
// NGỮ NGHĨA chưa kiểm (khách duyệt rồi đóng tab, capture PENDING kéo dài, hết hạn order và khoản giữ, thứ tự và trùng của webhook, hình dạng resource,
// custom_id có chép sang capture hay không) mô phỏng theo hướng bất lợi và cấu hình được qua POST /sim/control. KHÔNG chứng minh được hành vi của PayPal thật.
// Khóa RSA ký webhook sinh lúc chạy: không có khóa nào nằm trong repo.
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ORDER_TTL_SEC = 3 * 3600;
const CURRENCIES = new Set(['AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'ILS', 'JPY', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RUB', 'SEK', 'SGD', 'CHF', 'THB', 'USD']);
const NO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);

const DEFAULT_CONTROLS = {
  capture_decline: null,        // unverified: mã issue khi thu bị từ chối (ví dụ INSTRUMENT_DECLINED); order vẫn APPROVED
  capture_pending: false,       // unverified: capture ở PENDING, cho tới khi /sim/capture/resolve
  refund_mode: 'sync',          // 'sync' | 'async' (async: PENDING rồi /sim/refund/resolve)
  hold_days: 29,                // documented: thu khoản giữ trong 29 ngày
  reverse_events: false,        // đảo thứ tự các sự kiện sinh ra trong cùng một hành động
  dup_webhooks: 0,              // số lần giao thêm mỗi sự kiện
  drop_types: [],               // loại sự kiện không bao giờ giao
  hold_webhooks: false,         // giữ lại, giao khi /sim/webhook/flush
  retries: 5,                   // giao lại tối đa khi đích không trả 2xx
  bad_signature: false,         // ký bằng khóa khác
  token_ttl_seconds: 32400,
  webhook_timeout_ms: 5000,
  inject: [],                   // [{match: 'POST /v2/checkout/orders', mode, times}]
};

function makeClock(opts) {
  if (opts && opts.clock) return opts.clock;
  let t = Date.now();
  return { now: () => t, advance(sec) { t += sec * 1000; return t; } };
}

const dec = (cur) => (NO_DECIMAL.has(cur) ? /^\d+$/ : /^\d+(\.\d{1,2})?$/);
const num = (s) => Math.round(Number(s) * 100); // so sánh tiền theo phần trăm (đủ cho mô phỏng)
const fmt = (cents, cur) => (NO_DECIMAL.has(cur) ? String(Math.round(cents / 100)) : (cents / 100).toFixed(2));

async function startSimulator(opts = {}) {
  const clientId = opts.clientId || 'sim-client-id';
  const clientSecret = opts.clientSecret || 'sim-client-secret-not-real';
  const webhookId = opts.webhookId || 'WH-SIM-0001';
  const clock = makeClock(opts);
  const controls = { ...DEFAULT_CONTROLS, ...(opts.controls || {}) };
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const state = {
    controls, webhookUrl: opts.webhookUrl || null,
    orders: new Map(), auths: new Map(), captures: new Map(), refunds: new Map(), disputes: new Map(), tokens: new Map(),
    events: [], deliveries: [], held: [], idem: new Map(), requests: [], retryQueue: [], seq: 0,
  };
  const nid = (p) => `${p}${String(++state.seq).padStart(8, '0')}`;
  const sec = () => Math.floor(clock.now() / 1000);
  const iso = () => new Date(clock.now()).toISOString();
  let baseUrl = '';

  // ---------- lỗi (dạng PayPal: name, message, details[].issue) ----------
  const perr = (status, name, issue, description, store = false) => ({ status, store, body: { name, message: description || name, debug_id: nid('dbg'), details: issue ? [{ issue, description: description || issue }] : [], links: [] } });
  const unprocessable = (issue, description) => perr(422, 'UNPROCESSABLE_ENTITY', issue, description);
  const invalid = (issue, description) => perr(400, 'INVALID_REQUEST', issue, description);
  const notFound = (what, id) => perr(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', `${what} ${id} không tồn tại`);

  // ---------- đối tượng ----------
  const amountOf = (cur, cents) => ({ currency_code: cur, value: fmt(cents, cur) });
  const refundsOfCapture = (c) => [...state.refunds.values()].filter((r) => r.capture === c.id);
  const captureObj = (c) => ({ id: c.id, status: c.status, amount: amountOf(c.currency, c.cents), final_capture: true, custom_id: c.custom_id || undefined, invoice_id: c.invoice_id || undefined, create_time: c.created, update_time: iso(), links: [{ rel: 'up', href: `${baseUrl}/v2/checkout/orders/${c.order}`, method: 'GET' }, { rel: 'refund', href: `${baseUrl}/v2/payments/captures/${c.id}/refund`, method: 'POST' }], supplementary_data: { related_ids: { order_id: c.order } } });
  const authObj = (a) => ({ id: a.id, status: a.status, amount: amountOf(a.currency, a.cents), custom_id: a.custom_id || undefined, expiration_time: new Date(a.expires * 1000).toISOString(), create_time: a.created, links: [{ rel: 'capture', href: `${baseUrl}/v2/payments/authorizations/${a.id}/capture`, method: 'POST' }, { rel: 'void', href: `${baseUrl}/v2/payments/authorizations/${a.id}/void`, method: 'POST' }, { rel: 'up', href: `${baseUrl}/v2/checkout/orders/${a.order}`, method: 'GET' }] });
  const refundObj = (r) => ({ id: r.id, status: r.status, amount: amountOf(r.currency, r.cents), custom_id: r.custom_id || undefined, invoice_id: r.invoice_id || undefined, note_to_payer: r.note || undefined, create_time: r.created, update_time: iso(), links: [{ rel: 'up', href: `${baseUrl}/v2/payments/captures/${r.capture}`, method: 'GET' }] });
  const orderObj = (o) => {
    const caps = [...state.captures.values()].filter((c) => c.order === o.id).map(captureObj);
    const auths = [...state.auths.values()].filter((a) => a.order === o.id).map(authObj);
    const refunds = [...state.refunds.values()].filter((r) => state.captures.get(r.capture) && state.captures.get(r.capture).order === o.id).map(refundObj);
    const payments = {};
    if (caps.length) payments.captures = caps;
    if (auths.length) payments.authorizations = auths;
    if (refunds.length) payments.refunds = refunds;
    return {
      id: o.id, status: o.status, intent: o.intent, create_time: o.created,
      purchase_units: [{ reference_id: 'default', custom_id: o.custom_id || undefined, invoice_id: o.invoice_id || undefined, amount: amountOf(o.currency, o.cents), ...(Object.keys(payments).length ? { payments } : {}) }],
      payment_source: { paypal: {} },
      links: [{ rel: 'self', href: `${baseUrl}/v2/checkout/orders/${o.id}`, method: 'GET' }, ...(o.status === 'PAYER_ACTION_REQUIRED' ? [{ rel: 'payer-action', href: `${baseUrl}/checkoutnow?token=${o.id}`, method: 'GET' }] : [])],
    };
  };
  const orderExpired = (o) => sec() >= o.expires;

  // ---------- webhook ----------
  async function post(url, payload, secretKey) {
    const id = nid('WH-DLV-');
    const time = iso();
    const sigText = `${id}|${time}|${webhookId}|${zlib.crc32(Buffer.from(payload))}`;
    const sig = crypto.sign('sha256', Buffer.from(sigText), secretKey).toString('base64');
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'paypal-transmission-id': id, 'paypal-transmission-time': time, 'paypal-transmission-sig': sig, 'paypal-cert-url': `${baseUrl}/certs/sim.pem`, 'paypal-auth-algo': 'SHA256withRSA' }, body: payload, signal: AbortSignal.timeout(controls.webhook_timeout_ms) });
      return r.status;
    } catch { return 0; }
  }
  async function deliver(ev, attemptNo = 1) {
    if (!state.webhookUrl) return;
    const status = await post(state.webhookUrl, JSON.stringify(ev), controls.bad_signature ? wrongKeys.privateKey : keys.privateKey);
    state.deliveries.push({ event: ev.id, type: ev.event_type, attempt: attemptNo, status, at: clock.now() });
    if (!(status >= 200 && status < 300) && attemptNo <= controls.retries) state.retryQueue.push({ ev, attemptNo: attemptNo + 1, due: clock.now() + 60000 * 2 ** (attemptNo - 1) });
  }
  async function emitMany(list) {
    const events = list.map(([type, resource, rtype]) => ({ id: nid('WH-EVT-'), event_version: '1.0', create_time: iso(), resource_type: rtype, event_type: type, summary: type, resource, links: [] }));
    state.events.push(...events);
    const ordered = controls.reverse_events ? [...events].reverse() : events;
    for (const ev of ordered) {
      if (controls.drop_types.includes(ev.event_type)) continue;
      if (controls.hold_webhooks) { state.held.push(ev); continue; }
      for (let i = 0; i <= Number(controls.dup_webhooks || 0); i += 1) await deliver(ev);
    }
  }
  async function runRetries() {
    const due = state.retryQueue.filter((r) => r.due <= clock.now());
    state.retryQueue = state.retryQueue.filter((r) => r.due > clock.now());
    for (const r of due) await deliver(r.ev, r.attemptNo);
  }

  // ---------- idempotency (PayPal-Request-Id) ----------
  async function withIdem(req, path, body, handler) {
    const key = req.headers['paypal-request-id'];
    if (!key) return handler();
    const fp = req.method + path + JSON.stringify(body);
    const rec = state.idem.get(key);
    if (rec) {
      if (rec.fp !== fp) return unprocessable('DUPLICATE_REQUEST_ID', 'PayPal-Request-Id đã dùng cho yêu cầu khác');
      return { ...rec.res, replayed: true };
    }
    const res = await handler();
    if (res.store === false) return res;
    state.idem.set(key, { fp, res });
    return res;
  }
  const keep = (res) => ({ ...res, store: res.status >= 200 && res.status < 300 }); // unverified: PayPal có lưu cả 4xx theo PayPal-Request-Id hay không; simulator chỉ lưu thành công
  function takeInjection(method, path) {
    const i = controls.inject.findIndex((r) => (`${method} ${path}`).includes(r.match) && (r.times === undefined || r.times > 0));
    if (i < 0) return null;
    const rule = controls.inject[i];
    if (rule.times !== undefined) rule.times -= 1;
    return rule;
  }

  // ---------- nghiệp vụ ----------
  function createOrder(body) {
    if (!['CAPTURE', 'AUTHORIZE'].includes(body.intent)) return invalid('INVALID_PARAMETER_VALUE', 'intent phải là CAPTURE hoặc AUTHORIZE');
    const pu = Array.isArray(body.purchase_units) && body.purchase_units[0];
    const amt = pu && pu.amount;
    if (!amt) return invalid('MISSING_REQUIRED_PARAMETER', 'thiếu purchase_units[0].amount');
    const cur = String(amt.currency_code || '');
    if (!CURRENCIES.has(cur)) return unprocessable('CURRENCY_NOT_SUPPORTED', `loại tiền ${cur} không được hỗ trợ`);
    if (!dec(cur).test(String(amt.value)) || !(Number(amt.value) > 0)) return unprocessable(NO_DECIMAL.has(cur) ? 'CURRENCY_NOT_SUPPORTED_DECIMAL' : 'DECIMAL_PRECISION', `giá trị ${amt.value} không hợp lệ cho ${cur}`);
    const ec = body.payment_source && body.payment_source.paypal && body.payment_source.paypal.experience_context;
    if (!ec || !ec.return_url) return invalid('MISSING_REQUIRED_PARAMETER', 'thiếu payment_source.paypal.experience_context.return_url');
    const o = { id: nid('ORD'), status: 'PAYER_ACTION_REQUIRED', intent: body.intent, currency: cur, cents: num(amt.value), custom_id: pu.custom_id, invoice_id: pu.invoice_id, created: iso(), expires: sec() + ORDER_TTL_SEC, return_url: ec.return_url, cancel_url: ec.cancel_url || ec.return_url };
    state.orders.set(o.id, o);
    return { status: 201, store: true, body: orderObj(o) };
  }

  const declined = () => (controls.capture_decline ? unprocessable(controls.capture_decline, 'thu bị từ chối') : null);
  function makeCapture(o, cents, authId) {
    const pending = !!controls.capture_pending;
    const c = { id: nid('CAP'), order: o.id, auth: authId || null, status: pending ? 'PENDING' : 'COMPLETED', currency: o.currency, cents, custom_id: o.custom_id, invoice_id: o.invoice_id, created: iso() };
    state.captures.set(c.id, c);
    return c;
  }

  async function captureOrder(id) {
    const o = state.orders.get(id);
    if (!o) return notFound('order', id);
    if (o.status === 'COMPLETED') return unprocessable('ORDER_ALREADY_CAPTURED', 'order đã được thu');
    if (o.intent !== 'CAPTURE') return unprocessable('ACTION_DOES_NOT_MATCH_INTENT', 'order có intent AUTHORIZE');
    if (o.status !== 'APPROVED' || orderExpired(o)) return unprocessable('ORDER_NOT_APPROVED', 'khách chưa duyệt hoặc order hết hạn');
    const d = declined();
    if (d) return d;
    const c = makeCapture(o, o.cents);
    o.status = 'COMPLETED';
    await emitMany([[c.status === 'PENDING' ? 'PAYMENT.CAPTURE.PENDING' : 'PAYMENT.CAPTURE.COMPLETED', captureObj(c), 'capture']]);
    return { status: 201, store: true, body: orderObj(o) };
  }

  async function authorizeOrder(id) {
    const o = state.orders.get(id);
    if (!o) return notFound('order', id);
    if (o.status === 'COMPLETED') return unprocessable('ORDER_ALREADY_AUTHORIZED', 'order đã được giữ tiền');
    if (o.intent !== 'AUTHORIZE') return unprocessable('ACTION_DOES_NOT_MATCH_INTENT', 'order có intent CAPTURE');
    if (o.status !== 'APPROVED' || orderExpired(o)) return unprocessable('ORDER_NOT_APPROVED', 'khách chưa duyệt hoặc order hết hạn');
    const d = declined();
    if (d) return d;
    const a = { id: nid('AUT'), order: o.id, status: 'CREATED', currency: o.currency, cents: o.cents, custom_id: o.custom_id, created: iso(), expires: sec() + Number(controls.hold_days) * 86400 };
    state.auths.set(a.id, a);
    o.status = 'COMPLETED';
    await emitMany([['PAYMENT.AUTHORIZATION.CREATED', authObj(a), 'authorization']]);
    return { status: 201, store: true, body: orderObj(o) };
  }

  async function captureAuth(id, body) {
    const a = state.auths.get(id);
    if (!a) return notFound('authorization', id);
    if (a.status === 'CAPTURED') return unprocessable('AUTHORIZATION_ALREADY_CAPTURED', 'khoản giữ đã được thu');
    if (a.status === 'VOIDED') return unprocessable('AUTHORIZATION_VOIDED', 'khoản giữ đã nhả');
    if (a.status === 'EXPIRED' || sec() >= a.expires) return unprocessable('AUTHORIZATION_EXPIRED', 'khoản giữ đã hết hạn');
    const want = body.amount ? num(body.amount.value) : a.cents;
    if (!(want > 0) || want > a.cents) return unprocessable('AMOUNT_EXCEEDED', 'số tiền thu vượt khoản giữ');
    const d = declined();
    if (d) return d;
    const o = state.orders.get(a.order);
    const c = makeCapture(o, want, a.id);
    a.status = 'CAPTURED';
    await emitMany([[c.status === 'PENDING' ? 'PAYMENT.CAPTURE.PENDING' : 'PAYMENT.CAPTURE.COMPLETED', captureObj(c), 'capture']]);
    return { status: 201, store: true, body: { id: c.id, status: c.status, links: captureObj(c).links } };
  }

  async function voidAuth(id) {
    const a = state.auths.get(id);
    if (!a) return notFound('authorization', id);
    if (a.status === 'CAPTURED') return unprocessable('AUTHORIZATION_ALREADY_CAPTURED', 'khoản giữ đã được thu');
    if (a.status === 'VOIDED') return unprocessable('AUTHORIZATION_VOIDED', 'khoản giữ đã nhả');
    if (a.status === 'EXPIRED') return unprocessable('AUTHORIZATION_EXPIRED', 'khoản giữ đã hết hạn');
    a.status = 'VOIDED';
    state.orders.get(a.order).status = 'VOIDED';
    await emitMany([['PAYMENT.AUTHORIZATION.VOIDED', authObj(a), 'authorization']]);
    return { status: 204, store: true, body: null };
  }

  async function refundCapture(id, body) {
    const c = state.captures.get(id);
    if (!c) return notFound('capture', id);
    if (c.status === 'REFUNDED') return unprocessable('CAPTURE_FULLY_REFUNDED', 'capture đã hoàn đủ');
    if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(c.status)) return unprocessable('CAPTURE_NOT_REFUNDABLE', `capture ở trạng thái ${c.status}`);
    const reserved = refundsOfCapture(c).filter((r) => r.status !== 'FAILED' && r.status !== 'CANCELLED').reduce((s, r) => s + r.cents, 0);
    const want = body.amount ? num(body.amount.value) : c.cents - reserved;
    if (body.amount && body.amount.currency_code !== c.currency) return unprocessable('REFUND_CURRENCY_MISMATCH', 'khác loại tiền của capture');
    if (!(want > 0) || want + reserved > c.cents) return unprocessable('REFUND_AMOUNT_EXCEEDED', 'vượt số còn hoàn được');
    const async = controls.refund_mode === 'async';
    const r = { id: nid('RFD'), capture: c.id, status: async ? 'PENDING' : 'COMPLETED', currency: c.currency, cents: want, custom_id: body.custom_id, invoice_id: body.invoice_id, note: body.note_to_payer, created: iso() };
    state.refunds.set(r.id, r);
    if (!async) {
      c.status = reserved + want >= c.cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await emitMany([['PAYMENT.CAPTURE.REFUNDED', refundObj(r), 'refund']]);
    }
    return { status: 201, store: true, body: { id: r.id, status: r.status, links: refundObj(r).links } };
  }

  // ---------- route ----------
  async function route(req, path, body) {
    const m = req.method;
    let x;
    if (m === 'POST' && path === '/v2/checkout/orders') return withIdem(req, path, body, async () => createOrder(body));
    if ((x = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path)) && m === 'GET') { const o = state.orders.get(x[1]); return o ? { status: 200, body: orderObj(o) } : notFound('order', x[1]); }
    if ((x = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path)) && m === 'POST') return withIdem(req, path, body, () => captureOrder(x[1]).then(keep));
    if ((x = /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/.exec(path)) && m === 'POST') return withIdem(req, path, body, () => authorizeOrder(x[1]).then(keep));
    if ((x = /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/.exec(path)) && m === 'POST') return withIdem(req, path, body, () => captureAuth(x[1], body).then(keep));
    if ((x = /^\/v2\/payments\/authorizations\/([^/]+)\/void$/.exec(path)) && m === 'POST') return withIdem(req, path, body, () => voidAuth(x[1]).then(keep));
    if ((x = /^\/v2\/payments\/authorizations\/([^/]+)$/.exec(path)) && m === 'GET') { const a = state.auths.get(x[1]); return a ? { status: 200, body: authObj(a) } : notFound('authorization', x[1]); }
    if ((x = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path)) && m === 'POST') return withIdem(req, path, body, () => refundCapture(x[1], body).then(keep));
    if ((x = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path)) && m === 'GET') { const c = state.captures.get(x[1]); return c ? { status: 200, body: captureObj(c) } : notFound('capture', x[1]); }
    if ((x = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(path)) && m === 'GET') { const r = state.refunds.get(x[1]); return r ? { status: 200, body: refundObj(r) } : notFound('refund', x[1]); }
    return null;
  }

  async function simRoute(req, path, body) {
    if (path === '/sim/control') {
      for (const [k, v] of Object.entries(body)) { if (k === 'webhook_url') state.webhookUrl = v; else controls[k] = v; }
      return { status: 200, body: { ok: true, controls } };
    }
    if (path === '/sim/pay') { // khách ở trang PayPal
      const o = state.orders.get(body.order);
      if (!o) return { status: 404, body: { error: 'no order' } };
      if (orderExpired(o) || !['PAYER_ACTION_REQUIRED', 'CREATED'].includes(o.status)) return { status: 409, body: { error: `order ${o.status}` } };
      const sep = (u) => (u.includes('?') ? '&' : '?');
      if (body.outcome === 'cancel') return { status: 200, body: { status: 'cancelled_by_customer', redirect: `${o.cancel_url}${sep(o.cancel_url)}token=${o.id}` } };
      o.status = 'APPROVED';
      await emitMany([['CHECKOUT.ORDER.APPROVED', orderObj(o), 'checkout-order']]);
      return { status: 200, body: { status: 'approved', redirect: `${o.return_url}${sep(o.return_url)}token=${o.id}&PayerID=SIMPAYER1` } };
    }
    if (path === '/sim/capture/resolve') { // capture PENDING thành COMPLETED hoặc DENIED
      const c = state.captures.get(body.id);
      if (!c || c.status !== 'PENDING') return { status: 409, body: { error: 'capture không PENDING' } };
      c.status = body.outcome === 'denied' ? 'DENIED' : 'COMPLETED';
      await emitMany([[c.status === 'DENIED' ? 'PAYMENT.CAPTURE.DENIED' : 'PAYMENT.CAPTURE.COMPLETED', captureObj(c), 'capture']]);
      return { status: 200, body: captureObj(c) };
    }
    if (path === '/sim/refund/resolve') {
      const r = state.refunds.get(body.id);
      if (!r || r.status !== 'PENDING') return { status: 409, body: { error: 'refund không PENDING' } };
      const c = state.captures.get(r.capture);
      if (body.outcome === 'failed') { r.status = 'FAILED'; await emitMany([['PAYMENT.REFUND.FAILED', refundObj(r), 'refund']]); } else {
        r.status = 'COMPLETED';
        const done = refundsOfCapture(c).filter((x) => x.status === 'COMPLETED').reduce((s, x) => s + x.cents, 0);
        c.status = done >= c.cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await emitMany([['PAYMENT.CAPTURE.REFUNDED', refundObj(r), 'refund']]);
      }
      return { status: 200, body: refundObj(r) };
    }
    if (path === '/sim/reverse') { // PayPal đảo một capture (ngoài tranh chấp)
      const c = state.captures.get(body.capture);
      if (!c || !['COMPLETED', 'PARTIALLY_REFUNDED'].includes(c.status)) return { status: 409, body: { error: 'capture không đảo được' } };
      await emitMany([['PAYMENT.CAPTURE.REVERSED', { ...captureObj(c), status: 'REVERSED' }, 'capture']]);
      return { status: 200, body: { ok: true } };
    }
    if (path === '/sim/dispute') {
      const c = state.captures.get(body.capture);
      if (!c || !['COMPLETED', 'PARTIALLY_REFUNDED'].includes(c.status)) return { status: 409, body: { error: 'capture chưa thu' } };
      const d = { dispute_id: nid('PP-D-'), status: 'OPEN', reason: body.reason || 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', dispute_amount: body.amount ? { currency_code: c.currency, value: String(body.amount) } : amountOf(c.currency, c.cents), disputed_transactions: [{ seller_transaction_id: c.id }], create_time: iso() };
      state.disputes.set(d.dispute_id, d);
      await emitMany([['CUSTOMER.DISPUTE.CREATED', d, 'dispute']]);
      return { status: 200, body: d };
    }
    if (path === '/sim/dispute/close') {
      const d = state.disputes.get(body.id);
      if (!d) return { status: 404, body: { error: 'no dispute' } };
      d.status = 'RESOLVED';
      d.dispute_outcome = { outcome_code: body.outcome === 'lost' ? 'RESOLVED_BUYER_FAVOUR' : (body.outcome === 'other' ? 'CANCELED_BY_BUYER' : 'RESOLVED_SELLER_FAVOUR') };
      await emitMany([['CUSTOMER.DISPUTE.RESOLVED', d, 'dispute']]);
      return { status: 200, body: d };
    }
    if (path === '/sim/clock/advance') {
      clock.advance(Number(body.seconds) || 0);
      const out = [];
      for (const a of state.auths.values()) if (a.status === 'CREATED' && sec() >= a.expires) { a.status = 'EXPIRED'; out.push(['PAYMENT.AUTHORIZATION.VOIDED', authObj(a), 'authorization']); } // documented: VOIDED cả khi hết hạn
      if (out.length) await emitMany(out);
      await runRetries();
      return { status: 200, body: { now: clock.now(), events: out.length } };
    }
    if (path === '/sim/webhook/flush') {
      const list = body.reverse ? [...state.held].reverse() : [...state.held];
      state.held = [];
      for (const ev of list) await deliver(ev);
      return { status: 200, body: { delivered: list.length } };
    }
    if (path === '/sim/emit') { // bơm một sự kiện tùy ý (có chữ ký thật) để thử sự kiện lạ, thiếu trường, sai hình dạng
      await emitMany([[String(body.type), body.resource, body.resource_type || 'unknown']]);
      return { status: 200, body: { ok: true } };
    }
    if (path === '/sim/revoke-tokens') { state.tokens.clear(); return { status: 200, body: { ok: true } }; }
    if (path === '/sim/state') return { status: 200, body: { orders: [...state.orders.values()], auths: [...state.auths.values()], captures: [...state.captures.values()], refunds: [...state.refunds.values()], disputes: [...state.disputes.values()], events: state.events.map((e) => ({ id: e.id, type: e.event_type })), deliveries: state.deliveries, requests: state.requests } };
    return null;
  }

  // ---------- OAuth ----------
  function tokenRoute(req, text) {
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    const [id, secret] = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':') : [];
    if (id !== clientId || secret !== clientSecret) return { status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } };
    if (!/grant_type=client_credentials/.test(text)) return { status: 400, body: { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' } };
    const token = `A21AA${crypto.randomBytes(12).toString('hex')}`;
    state.tokens.set(token, sec() + Number(controls.token_ttl_seconds));
    return { status: 200, body: { scope: 'https://uri.paypal.com/services/payments/payment', access_token: token, token_type: 'Bearer', app_id: 'APP-SIM', expires_in: Number(controls.token_ttl_seconds), nonce: 'sim' } };
  }
  const authorized = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const exp = m && state.tokens.get(m[1]);
    return !!exp && exp > sec();
  };

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      const text = Buffer.concat(chunks).toString('utf8');
      const send = (status, obj, extraHeaders = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders }); res.end(obj === null || obj === undefined ? '' : JSON.stringify(obj)); };
      try {
        if (path === '/certs/sim.pem') { res.writeHead(200, { 'content-type': 'application/x-pem-file' }); return res.end(publicPem); }
        if (path.startsWith('/sim/')) {
          const out = await simRoute(req, path, text ? JSON.parse(text) : {});
          return out ? send(out.status, out.body) : send(404, { error: 'no sim route' });
        }
        if (path === '/v1/oauth2/token' && req.method === 'POST') { const out = tokenRoute(req, text); return send(out.status, out.body); }
        if (!path.startsWith('/v2/')) return send(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
        if (!authorized(req)) return send(401, { name: 'AUTHENTICATION_FAILURE', message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.', links: [] });
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { return send(400, { name: 'INVALID_REQUEST', message: 'Request is not well-formed, syntactically incorrect, or violates schema.' }); }
        state.requests.push({ method: req.method, path, key: req.headers['paypal-request-id'] || null, body });
        const rule = takeInjection(req.method, path);
        if (rule && rule.mode === 'delay') await new Promise((r) => setTimeout(r, rule.ms || 50));
        if (rule && rule.mode === 'status429') return send(429, { name: 'RATE_LIMIT_REACHED', message: 'Too many requests. Blocked due to rate limiting.' });
        if (rule && rule.mode === 'status500_before') return send(500, { name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error has occurred.' });
        let out = await route(req, path, body);
        if (!out) return send(404, { name: 'RESOURCE_NOT_FOUND', message: `Unrecognized request ${req.method} ${path}` });
        if (rule && rule.mode === 'status500_after') out = { status: 500, body: { name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error has occurred.' } }; // hiệu ứng ĐÃ xảy ra
        if (rule && rule.mode === 'timeout_after') { req.socket.destroy(); return undefined; } // hiệu ứng đã xảy ra, không có phản hồi
        return send(out.status, out.body, out.replayed ? { 'paypal-replayed': 'true' } : {});
      } catch (e) {
        return send(500, { name: 'INTERNAL_SERVER_ERROR', message: String(e && e.message) });
      }
    });
  });

  await new Promise((resolve) => server.listen(opts.port || 0, opts.host || '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    port: server.address().port, url: baseUrl, clock, state, controls,
    config: { clientId, clientSecret, webhookId },
    setWebhook(url) { state.webhookUrl = url; },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

module.exports = { startSimulator, DEFAULT_CONTROLS, CURRENCIES, NO_DECIMAL };

if (require.main === module) {
  const env = process.env;
  startSimulator({ port: Number(env.SIM_PORT) || 0, host: env.SIM_HOST, clientId: env.SIM_CLIENT_ID, clientSecret: env.SIM_CLIENT_SECRET, webhookId: env.SIM_WEBHOOK_ID, webhookUrl: env.SIM_WEBHOOK_URL })
    .then((s) => { console.log(`PayPal simulator: ${s.url}`); });
}

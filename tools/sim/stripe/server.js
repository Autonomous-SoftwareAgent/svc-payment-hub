'use strict';
// spec: STRP-S-003
// Simulator Stripe (Checkout hosted + PaymentIntent + Refund + Dispute) chạy bằng HTTP, không phụ thuộc thư viện ngoài (STRP-D-003).
// HÌNH THỨC theo bằng chứng đã có: xác thực Basic hoặc Bearer (sai thì 401 với thân {error:{message,type:invalid_request_error}} không có code,
// đã quan sát thật), URL lạ thì 404 "Unrecognized request URL", body form-encode lồng nhau, Idempotency-Key (lưu kết quả kể cả 4xx và 500,
// cùng khóa khác tham số là 400 idempotency_error, đang chạy là 409 idempotency_key_in_use), webhook ký Stripe-Signature (t=,v1=).
// NGỮ NGHĨA chưa kiểm (thẻ hỏng trên hosted Checkout, payment_status khi giữ tiền, hết hạn giữ tiền, hoàn thất bại muộn, thứ tự và trùng của
// webhook) mô phỏng theo hướng bất lợi và cấu hình được qua POST /sim/control. Simulator KHÔNG chứng minh được hành vi của Stripe thật.
const http = require('node:http');
const crypto = require('node:crypto');

const API_VERSION = '2026-09-30.endive';
const SESSION_MIN_SEC = 30 * 60;
const SESSION_MAX_SEC = 24 * 3600;
const MIN_AMOUNT = { usd: 50, eur: 50, gbp: 30, jpy: 50, cad: 50, aud: 50, sgd: 50 };
const CURRENCIES = new Set(['usd', 'eur', 'gbp', 'jpy', 'vnd', 'sgd', 'cad', 'aud', 'isk', 'kwd', 'ugx', 'mga']);

const DEFAULT_CONTROLS = {
  pi_on_create: false,                  // unverified: session.payment_intent có sẵn lúc tạo (tài liệu ví dụ cho null)
  hold_payment_status: 'unpaid',        // unverified: payment_status của session khi mới GIỮ tiền (paid hoặc unpaid)
  emit_payment_failed: true,            // unverified: thẻ hỏng trên hosted Checkout có phát payment_intent.payment_failed hay không
  hold_days: 7,                         // documented: thẻ online giữ 7 ngày
  double_capture_code: 'payment_intent_unexpected_state', // unverified: charge_already_captured hoặc payment_intent_unexpected_state
  capture_after_expiry_code: 'charge_expired_for_capture', // documented trong tài liệu lỗi
  refund_mode: 'sync',                  // 'sync' | 'async' (async: pending rồi /sim/refund/resolve)
  reverse_events: false,                // đảo thứ tự các sự kiện sinh ra trong cùng một hành động (Stripe không đảm bảo thứ tự)
  dup_webhooks: 0,                      // số lần giao thêm mỗi sự kiện
  drop_types: [],                       // loại sự kiện không bao giờ giao
  hold_webhooks: false,                 // giữ lại, giao khi /sim/webhook/flush
  retries: 5,                           // giao lại tối đa khi đích trả không phải 2xx
  sign_with: null,                      // đặt secret khác để mô phỏng chữ ký sai
  timestamp_skew_seconds: 0,            // lệch t= so với giờ của simulator
  webhook_timeout_ms: 5000,
  inject: [],                           // [{match: 'POST /v1/payment_intents/', mode, times}]
};

function makeClock(opts) {
  if (opts && opts.clock) return opts.clock;
  let t = Date.now();
  return { now: () => t, advance(sec) { t += sec * 1000; return t; } };
}

// "a[b][0][c]=v" thành {a:{b:[{c:'v'}]}}
function parseForm(text) {
  const out = {};
  for (const pair of String(text || '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const key = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const val = decodeURIComponent((i < 0 ? '' : pair.slice(i + 1)).replace(/\+/g, ' '));
    const parts = key.replace(/\]/g, '').split('[');
    let cur = out;
    parts.forEach((p, idx) => {
      const last = idx === parts.length - 1;
      const next = parts[idx + 1];
      if (last) { if (p === '') { if (!Array.isArray(cur)) throw new Error('mảng rỗng'); cur.push(val); } else cur[p] = val; return; }
      if (cur[p] === undefined) cur[p] = /^\d+$/.test(next) || next === '' ? [] : {};
      cur = cur[p];
    });
  }
  return out;
}

const sortObj = (o) => (Array.isArray(o) ? o.map(sortObj) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortObj(o[k])])) : o);

async function startSimulator(opts = {}) {
  const secretKey = opts.secretKey || 'sk_test_simulatorkey';
  const clock = makeClock(opts);
  const controls = { ...DEFAULT_CONTROLS, ...(opts.controls || {}) };
  const state = {
    controls, webhookUrl: opts.webhookUrl || null, webhookSecret: opts.webhookSecret || 'whsec_simulatorsecret',
    sessions: new Map(), intents: new Map(), refunds: new Map(), disputes: new Map(),
    events: [], deliveries: [], held: [], idem: new Map(), requests: [], seq: 0,
  };
  const nid = (p) => `${p}_${String(++state.seq).padStart(6, '0')}`;
  const sec = () => Math.floor(clock.now() / 1000);
  let baseUrl = '';

  // ---------- lỗi ----------
  const err = (status, type, message, extra = {}, store = false) => ({ status, store, body: { error: { message, type, ...extra } } });
  const invalid = (message, param, code) => err(400, 'invalid_request_error', message, { ...(param ? { param } : {}), ...(code ? { code } : {}) });
  const missing = (what, id) => err(404, 'invalid_request_error', `No such ${what}: '${id}'`, { code: 'resource_missing', param: what.split('.')[0] }, false);

  // ---------- đối tượng trả ra ----------
  const sessionObj = (s, expand) => ({
    id: s.id, object: 'checkout.session', status: s.status, payment_status: s.payment_status, mode: 'payment', url: s.status === 'open' ? s.url : null,
    client_reference_id: s.client_reference_id, metadata: s.metadata, amount_total: s.amount_total, currency: s.currency, expires_at: s.expires_at, created: s.created,
    payment_intent: s.payment_intent ? (expand ? intentObj(state.intents.get(s.payment_intent)) : s.payment_intent) : null,
  });
  const intentObj = (p) => ({
    id: p.id, object: 'payment_intent', status: p.status, amount: p.amount, currency: p.currency, amount_received: p.amount_received, amount_capturable: p.amount_capturable,
    capture_method: p.capture_method, metadata: p.metadata, cancellation_reason: p.cancellation_reason || null, latest_charge: p.charge, created: p.created,
    last_payment_error: p.last_payment_error || null,
  });
  const refundObj = (r) => ({ id: r.id, object: 'refund', status: r.status, amount: r.amount, currency: r.currency, payment_intent: r.payment_intent, metadata: r.metadata, failure_reason: r.failure_reason || null, created: r.created });
  const disputeObj = (d) => ({ id: d.id, object: 'dispute', status: d.status, amount: d.amount, currency: d.currency, payment_intent: d.payment_intent, charge: d.charge, reason: d.reason, metadata: {}, created: d.created });

  // ---------- webhook ----------
  const signature = (payload, t, secret) => crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  async function post(url, payload, t, secret, timeoutMs) {
    const sig = `t=${t},v1=${signature(payload, t, secret)}`;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': sig, 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)' }, body: payload, signal: AbortSignal.timeout(timeoutMs) });
      return r.status;
    } catch { return 0; }
  }
  async function deliver(ev, attemptNo = 1) {
    if (!state.webhookUrl) return;
    const payload = JSON.stringify(ev);
    const t = sec() + Number(controls.timestamp_skew_seconds || 0);
    const status = await post(state.webhookUrl, payload, t, controls.sign_with || state.webhookSecret, controls.webhook_timeout_ms);
    state.deliveries.push({ event: ev.id, type: ev.type, attempt: attemptNo, status, at: clock.now() });
    if (!(status >= 200 && status < 300) && attemptNo <= controls.retries) state.retryQueue.push({ ev, attemptNo: attemptNo + 1, due: clock.now() + 60000 * 2 ** (attemptNo - 1) });
  }
  state.retryQueue = [];
  async function emitMany(list) {
    const events = list.map(([type, object]) => ({ id: nid('evt'), object: 'event', api_version: API_VERSION, created: sec(), type, livemode: false, pending_webhooks: 1, data: { object } }));
    state.events.push(...events);
    const ordered = controls.reverse_events ? [...events].reverse() : events;
    for (const ev of ordered) {
      if (controls.drop_types.includes(ev.type)) continue;
      if (controls.hold_webhooks) { state.held.push(ev); continue; }
      for (let i = 0; i <= Number(controls.dup_webhooks || 0); i += 1) await deliver(ev);
    }
  }
  async function runRetries() {
    const due = state.retryQueue.filter((r) => r.due <= clock.now());
    state.retryQueue = state.retryQueue.filter((r) => r.due > clock.now());
    for (const r of due) await deliver(r.ev, r.attemptNo);
  }

  // ---------- idempotency ----------
  async function withIdem(req, path, body, handler) {
    const key = req.headers['idempotency-key'];
    if (!key) return handler();
    const fp = req.method + path + JSON.stringify(sortObj(body));
    const rec = state.idem.get(key);
    if (rec) {
      if (rec.fp !== fp) return err(400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than "' + key + '" if you meant to execute a different request.');
      if (rec.inflight) return err(409, 'invalid_request_error', 'There is currently another in-progress request using this Stripe idempotency key.', { code: 'idempotency_key_in_use' });
      return { ...rec.res, replayed: true };
    }
    state.idem.set(key, { fp, inflight: true });
    let res;
    try { res = await handler(); } catch (e) { state.idem.delete(key); throw e; }
    if (res.store === false) state.idem.delete(key); else state.idem.set(key, { fp, res });
    return res;
  }

  function takeInjection(method, path) {
    const i = controls.inject.findIndex((r) => (`${method} ${path}`).includes(r.match) && (r.times === undefined || r.times > 0));
    if (i < 0) return null;
    const rule = controls.inject[i];
    if (rule.times !== undefined) rule.times -= 1;
    return rule;
  }

  // ---------- nghiệp vụ ----------
  function validateAmount(currency, amount) {
    if (!CURRENCIES.has(currency)) return invalid(`Invalid currency: ${currency}.`, 'line_items[0][price_data][currency]', 'parameter_invalid_enum');
    if (!/^\d+$/.test(String(amount)) || Number(amount) <= 0) return invalid('Invalid integer: ' + amount, 'line_items[0][price_data][unit_amount]');
    const n = Number(amount);
    if (MIN_AMOUNT[currency] && n < MIN_AMOUNT[currency]) return err(400, 'invalid_request_error', 'Amount must convert to at least 50 cents.', { code: 'amount_too_small' });
    if (currency === 'isk' && n % 100 !== 0) return invalid('Invalid amount for ISK: must be a multiple of 100.', 'line_items[0][price_data][unit_amount]'); // documented: ISK hai chữ số thập phân luôn 00
    if (currency === 'kwd' && n % 10 !== 0) return invalid('Invalid amount for KWD: must be a multiple of 10.', 'line_items[0][price_data][unit_amount]'); // unverified: quy tắc bội 10
    return null;
  }

  async function createSession(body) {
    if (body.mode !== 'payment') return invalid('Invalid mode: must be one of payment, setup, or subscription.', 'mode');
    if (!body.success_url) return invalid('Missing required param: success_url.', 'success_url');
    const item = body.line_items && body.line_items[0];
    const pd = item && item.price_data;
    if (!pd) return invalid('Missing required param: line_items[0][price_data].', 'line_items');
    const currency = String(pd.currency || '').toLowerCase();
    const bad = validateAmount(currency, pd.unit_amount);
    if (bad) return bad;
    const qty = Number(item.quantity || 1);
    const now = sec();
    const expires = body.expires_at === undefined ? now + SESSION_MAX_SEC : Number(body.expires_at);
    if (!Number.isInteger(expires) || expires < now + SESSION_MIN_SEC || expires > now + SESSION_MAX_SEC) return invalid('Invalid expires_at: expires_at must be between 30 minutes and 24 hours from now.', 'expires_at');
    if (body.client_reference_id && body.client_reference_id.length > 200) return invalid('client_reference_id must be at most 200 characters.', 'client_reference_id');
    const pid = body.payment_intent_data || {};
    const method = pid.capture_method || 'automatic';
    if (!['automatic', 'automatic_async', 'manual'].includes(method)) return invalid('Invalid capture_method.', 'payment_intent_data[capture_method]');
    const id = nid('cs_test');
    const s = {
      id, status: 'open', payment_status: 'unpaid', url: `${baseUrl}/pay/${id}`, client_reference_id: body.client_reference_id || null, metadata: body.metadata || {},
      amount_total: Number(pd.unit_amount) * qty, currency, expires_at: expires, created: now, capture_method: method, pi_metadata: pid.metadata || {}, payment_intent: null,
      success_url: body.success_url, cancel_url: body.cancel_url || null,
    };
    state.sessions.set(id, s);
    if (controls.pi_on_create) s.payment_intent = newIntent(s, 'requires_payment_method').id;
    return { status: 200, body: sessionObj(s, false) };
  }

  function newIntent(s, status) {
    const id = nid('pi');
    const p = {
      id, status, amount: s.amount_total, currency: s.currency, amount_received: 0, amount_capturable: 0, capture_method: s.capture_method, metadata: s.pi_metadata,
      created: sec(), charge: null, session: s.id, refunded: 0,
    };
    state.intents.set(id, p);
    s.payment_intent = id;
    return p;
  }

  async function expireSession(s) {
    if (s.status !== 'open') return err(400, 'invalid_request_error', 'Only Checkout Sessions with a status in (open) can be expired.', {}, true);
    s.status = 'expired';
    await emitMany([['checkout.session.expired', sessionObj(s, false)]]);
    return { status: 200, body: sessionObj(s, false) };
  }

  async function capture(p, body) {
    if (p.status === 'succeeded') return err(400, 'invalid_request_error', 'This PaymentIntent could not be captured because it has already been captured.', { code: controls.double_capture_code }, true);
    if (p.status === 'canceled') return err(400, 'invalid_request_error', 'This PaymentIntent could not be captured because it has a status of canceled.', { code: p.cancellation_reason === 'automatic' ? controls.capture_after_expiry_code : 'payment_intent_unexpected_state' }, true);
    if (p.status !== 'requires_capture') return err(400, 'invalid_request_error', `This PaymentIntent could not be captured because it has a status of ${p.status}.`, { code: 'payment_intent_unexpected_state' }, true);
    const amt = body.amount_to_capture === undefined ? p.amount_capturable : Number(body.amount_to_capture);
    if (!Number.isInteger(amt) || amt <= 0 || amt > p.amount_capturable) return err(400, 'invalid_request_error', 'Amount to capture is greater than the amount that can be captured.', { code: 'amount_too_large', param: 'amount_to_capture' }, true);
    p.status = 'succeeded';
    p.amount_received = amt;
    p.amount_capturable = 0;
    await emitMany([['charge.captured', { id: p.charge, object: 'charge', payment_intent: p.id, amount: amt }], ['payment_intent.succeeded', intentObj(p)]]);
    return { status: 200, body: intentObj(p) };
  }

  async function cancelIntent(p) {
    if (p.status !== 'requires_capture' && p.status !== 'requires_payment_method') return err(400, 'invalid_request_error', `You cannot cancel this PaymentIntent because it has a status of ${p.status}.`, { code: 'payment_intent_unexpected_state' }, true);
    p.status = 'canceled';
    p.cancellation_reason = 'requested_by_customer';
    p.amount_capturable = 0;
    await emitMany([['payment_intent.canceled', intentObj(p)]]);
    return { status: 200, body: intentObj(p) };
  }

  async function createRefund(body) {
    const p = state.intents.get(body.payment_intent);
    if (!body.payment_intent || !p) return missing('payment_intent', body.payment_intent);
    if (p.status !== 'succeeded') return err(400, 'invalid_request_error', 'This PaymentIntent has not been captured: cancel it instead of refunding.', { code: 'payment_intent_unexpected_state' }, true);
    if ([...state.disputes.values()].some((d) => d.payment_intent === p.id && ['needs_response', 'under_review'].includes(d.status))) return err(400, 'invalid_request_error', 'This charge is disputed and cannot be refunded.', { code: 'charge_disputed' }, true);
    const remaining = p.amount_received - p.refunded;
    if (remaining <= 0) return err(400, 'invalid_request_error', 'Charge has already been refunded.', { code: 'charge_already_refunded' }, true);
    const amt = body.amount === undefined ? remaining : Number(body.amount);
    if (!Number.isInteger(amt) || amt <= 0 || amt > remaining) return err(400, 'invalid_request_error', `Refund amount (${amt}) is greater than unrefunded amount on charge (${remaining}).`, { code: 'amount_too_large' }, true);
    const r = { id: nid('re'), status: controls.refund_mode === 'async' ? 'pending' : 'succeeded', amount: amt, currency: p.currency, payment_intent: p.id, metadata: body.metadata || {}, created: sec() };
    if (r.status === 'succeeded') p.refunded += amt;
    state.refunds.set(r.id, r);
    await emitMany([['refund.created', refundObj(r)], ...(r.status === 'succeeded' ? [['charge.refunded', { id: p.charge, object: 'charge', payment_intent: p.id, amount_refunded: p.refunded }]] : [])]);
    return { status: 200, body: refundObj(r) };
  }

  // ---------- định tuyến API ----------
  async function route(req, path, query, body) {
    let m;
    if (req.method === 'POST' && path === '/v1/checkout/sessions') return withIdem(req, path, body, () => createSession(body));
    if (req.method === 'GET' && (m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path))) {
      const s = state.sessions.get(m[1]);
      return s ? { status: 200, body: sessionObj(s, (query.getAll('expand[]') || []).includes('payment_intent')) } : missing('checkout.session', m[1]);
    }
    if (req.method === 'POST' && (m = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path))) {
      const s = state.sessions.get(m[1]);
      return s ? withIdem(req, path, body, () => expireSession(s)) : missing('checkout.session', m[1]);
    }
    if (req.method === 'GET' && (m = /^\/v1\/payment_intents\/([^/]+)$/.exec(path))) {
      const p = state.intents.get(m[1]);
      return p ? { status: 200, body: intentObj(p) } : missing('payment_intent', m[1]);
    }
    if (req.method === 'POST' && (m = /^\/v1\/payment_intents\/([^/]+)\/(capture|cancel)$/.exec(path))) {
      const p = state.intents.get(m[1]);
      if (!p) return missing('payment_intent', m[1]);
      return withIdem(req, path, body, () => (m[2] === 'capture' ? capture(p, body) : cancelIntent(p)));
    }
    if (req.method === 'POST' && path === '/v1/refunds') return withIdem(req, path, body, () => createRefund(body));
    if (req.method === 'GET' && path === '/v1/refunds') {
      const pi = query.get('payment_intent');
      const data = [...state.refunds.values()].filter((r) => !pi || r.payment_intent === pi).map(refundObj);
      return { status: 200, body: { object: 'list', data, has_more: false, url: '/v1/refunds' } };
    }
    if (req.method === 'GET' && (m = /^\/v1\/refunds\/([^/]+)$/.exec(path))) {
      const r = state.refunds.get(m[1]);
      return r ? { status: 200, body: refundObj(r) } : missing('refund', m[1]);
    }
    return null;
  }

  function authorized(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7) === secretKey;
    if (h.startsWith('Basic ')) return Buffer.from(h.slice(6), 'base64').toString('utf8').split(':')[0] === secretKey;
    return false;
  }

  // ---------- điều khiển và hành động của khách (không cần khóa) ----------
  async function simRoute(req, path, body) {
    if (path === '/sim/control') {
      for (const [k, v] of Object.entries(body)) {
        if (k === 'webhook_url') state.webhookUrl = v; else if (k === 'webhook_secret') state.webhookSecret = v; else controls[k] = v;
      }
      return { status: 200, body: { ok: true, controls } };
    }
    if (path === '/sim/pay') {
      const s = state.sessions.get(body.session);
      if (!s) return { status: 404, body: { error: 'no session' } };
      if (s.status !== 'open' || s.expires_at <= sec()) return { status: 409, body: { error: `session ${s.status}` } };
      const outcome = body.outcome || 'success';
      if (outcome === 'cancel') return { status: 200, body: { status: 'cancelled_by_customer', session_status: s.status } }; // inferred: phiên vẫn mở, không có sự kiện
      let p = s.payment_intent ? state.intents.get(s.payment_intent) : newIntent(s, 'requires_payment_method');
      if (outcome === 'decline') {
        p.last_payment_error = { code: 'card_declined', decline_code: body.decline_code || 'generic_decline', type: 'card_error' };
        if (controls.emit_payment_failed) await emitMany([['payment_intent.payment_failed', intentObj(p)]]);
        return { status: 200, body: { status: 'declined', session_status: s.status } };
      }
      p.charge = nid('ch');
      s.status = 'complete';
      const events = [['checkout.session.completed', null]];
      if (s.capture_method === 'manual') {
        p.status = 'requires_capture';
        p.amount_capturable = p.amount;
        p.hold_expires_at = clock.now() + controls.hold_days * 86400000;
        s.payment_status = controls.hold_payment_status;
        events.push(['payment_intent.amount_capturable_updated', intentObj(p)]);
      } else {
        p.status = 'succeeded';
        p.amount_received = p.amount;
        s.payment_status = 'paid';
        events.push(['payment_intent.succeeded', intentObj(p)], ['charge.succeeded', { id: p.charge, object: 'charge', payment_intent: p.id, amount: p.amount }]);
      }
      events[0][1] = sessionObj(s, false);
      await emitMany(events);
      return { status: 200, body: { status: 'paid', payment_intent: p.id, session_status: s.status } };
    }
    if (path === '/sim/clock/advance') {
      clock.advance(Number(body.seconds) || 0);
      const out = [];
      for (const s of state.sessions.values()) {
        if (s.status === 'open' && s.expires_at <= sec()) { s.status = 'expired'; out.push(['checkout.session.expired', sessionObj(s, false)]); }
      }
      for (const p of state.intents.values()) {
        if (p.status === 'requires_capture' && p.hold_expires_at <= clock.now()) {
          p.status = 'canceled'; p.cancellation_reason = 'automatic'; p.amount_capturable = 0; // unverified: giá trị cancellation_reason khi giữ hết hạn
          out.push(['charge.expired', { id: p.charge, object: 'charge', payment_intent: p.id }], ['payment_intent.canceled', intentObj(p)]);
        }
      }
      if (out.length) await emitMany(out);
      await runRetries();
      return { status: 200, body: { now: clock.now(), events: out.length } };
    }
    if (path === '/sim/dispute') {
      const p = state.intents.get(body.payment_intent);
      if (!p || p.status !== 'succeeded') return { status: 409, body: { error: 'payment_intent chưa thu' } };
      const d = { id: nid('du'), status: 'needs_response', amount: Number(body.amount) || p.amount_received, currency: p.currency, payment_intent: p.id, charge: p.charge, reason: body.reason || 'fraudulent', created: sec() };
      state.disputes.set(d.id, d);
      await emitMany([['charge.dispute.created', disputeObj(d)], ['charge.dispute.funds_withdrawn', disputeObj(d)]]);
      return { status: 200, body: disputeObj(d) };
    }
    if (path === '/sim/dispute/close') {
      const d = state.disputes.get(body.id);
      if (!d) return { status: 404, body: { error: 'no dispute' } };
      d.status = body.outcome === 'lost' ? 'lost' : body.outcome === 'warning_closed' ? 'warning_closed' : 'won';
      await emitMany([['charge.dispute.closed', disputeObj(d)], ...(d.status === 'won' ? [['charge.dispute.funds_reinstated', disputeObj(d)]] : [])]);
      return { status: 200, body: disputeObj(d) };
    }
    if (path === '/sim/refund/resolve') {
      const r = state.refunds.get(body.id);
      if (!r || r.status !== 'pending') return { status: 409, body: { error: 'refund không pending' } };
      const p = state.intents.get(r.payment_intent);
      if (body.outcome === 'failed') { r.status = 'failed'; r.failure_reason = 'expired_or_canceled_card'; await emitMany([['refund.updated', refundObj(r)], ['refund.failed', refundObj(r)]]); } else { r.status = 'succeeded'; p.refunded += r.amount; await emitMany([['refund.updated', refundObj(r)]]); }
      return { status: 200, body: refundObj(r) };
    }
    if (path === '/sim/webhook/flush') {
      const list = body.reverse ? [...state.held].reverse() : [...state.held];
      state.held = [];
      for (const ev of list) await deliver(ev);
      return { status: 200, body: { delivered: list.length } };
    }
    if (path === '/sim/state') return { status: 200, body: { sessions: [...state.sessions.values()], intents: [...state.intents.values()], refunds: [...state.refunds.values()], disputes: [...state.disputes.values()], events: state.events.map((e) => ({ id: e.id, type: e.type })), deliveries: state.deliveries, requests: state.requests } };
    return null;
  }

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      const text = Buffer.concat(chunks).toString('utf8');
      const send = (status, obj, extraHeaders = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders }); res.end(JSON.stringify(obj)); };
      try {
        if (path.startsWith('/sim/')) {
          const out = await simRoute(req, path, text ? JSON.parse(text) : {});
          return out ? send(out.status, out.body) : send(404, { error: 'no sim route' });
        }
        if (!path.startsWith('/v1/')) return send(404, { error: { message: 'Unrecognized request URL', type: 'invalid_request_error' } });
        let body = {};
        try { body = text ? parseForm(text) : {}; } catch { return send(400, { error: { message: 'Invalid request body', type: 'invalid_request_error' } }); }
        if (!authorized(req)) {
          const m = (req.headers.authorization || '').replace(/^(Bearer|Basic) /, '');
          return send(401, { error: { message: m ? `Invalid API Key provided: ${m.slice(0, 7)}********${m.slice(-4)}` : 'You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. \'Authorization: Bearer YOUR_SECRET_KEY\').', type: 'invalid_request_error' } }, { 'www-authenticate': 'Bearer realm="Stripe"' });
        }
        state.requests.push({ method: req.method, path, key: req.headers['idempotency-key'] || null, version: req.headers['stripe-version'] || null, body });
        const reqId = nid('req');
        const rule = takeInjection(req.method, path + (url.search || ''));
        if (rule && rule.mode === 'delay') await new Promise((r) => setTimeout(r, rule.ms || 50));
        if (rule && rule.mode === 'status429') return send(429, { error: { message: 'Too many requests', type: 'invalid_request_error', code: 'rate_limit' } }, { 'stripe-rate-limited-reason': 'global-rate', 'request-id': reqId });
        if (rule && rule.mode === 'status409') return send(409, { error: { message: 'There is currently another in-progress request using this Stripe idempotency key.', type: 'invalid_request_error', code: 'idempotency_key_in_use' } }, { 'request-id': reqId });
        if (rule && rule.mode === 'status429_lock') return send(429, { error: { message: 'lock_timeout: could not obtain lock', type: 'invalid_request_error', code: 'lock_timeout' } });
        if (rule && rule.mode === 'status500_before') return send(500, { error: { message: 'An unknown error occurred', type: 'api_error' } }, { 'request-id': reqId });
        let out = await route(req, path, url.searchParams, body);
        if (!out) return send(404, { error: { message: 'Unrecognized request URL (' + req.method + ': ' + path + ').', type: 'invalid_request_error' } });
        if (rule && rule.mode === 'status500_after') { // hiệu ứng ĐÃ xảy ra, nhưng khách nhận 500 và kết quả 500 được lưu theo khóa (documented)
          out = { status: 500, store: true, body: { error: { message: 'An unknown error occurred', type: 'api_error' } } };
          const key = req.headers['idempotency-key'];
          if (key && state.idem.has(key)) state.idem.set(key, { ...state.idem.get(key), res: out });
        }
        if (rule && rule.mode === 'timeout_after') { req.socket.destroy(); return undefined; } // hiệu ứng đã xảy ra, không có phản hồi
        return send(out.status, out.body, { 'request-id': reqId, 'stripe-version': API_VERSION, ...(out.replayed ? { 'idempotent-replayed': 'true' } : {}) });
      } catch (e) {
        return send(500, { error: { message: String(e && e.message), type: 'api_error' } });
      }
    });
  });

  await new Promise((resolve) => server.listen(opts.port || 0, opts.host || '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    port, url: baseUrl, clock, state, controls,
    config: { secretKey, webhookSecret: state.webhookSecret },
    setWebhook(url, secret) { state.webhookUrl = url; if (secret) state.webhookSecret = secret; },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

module.exports = { startSimulator, parseForm, DEFAULT_CONTROLS, API_VERSION };

if (require.main === module) {
  const env = process.env;
  startSimulator({
    port: Number(env.SIM_PORT) || 0, host: env.SIM_HOST, secretKey: env.SIM_SECRET_KEY, webhookSecret: env.SIM_WEBHOOK_SECRET, webhookUrl: env.SIM_WEBHOOK_URL,
  }).then((s) => { console.log(`Stripe simulator: ${s.url}`); });
}

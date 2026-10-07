'use strict';
// spec: MOMO-S-002
// spec: MOMO-S-003
// spec: MOMO-S-001, MOMO-S-002
// Simulator MoMo (API v2) chạy bằng HTTP, không phụ thuộc thư viện ngoài.
// Định dạng và quy tắc kiểm tra theo probe sandbox thật (MOMO-D-002 A1, A12, A13, A14, A16);
// ngữ nghĩa "unverified" (IPN retry, hết hạn, tiền về muộn, refund bất đồng bộ) mô phỏng theo hướng
// bất lợi và cấu hình được qua POST /sim/control.
const http = require('node:http');
const crypto = require('node:crypto');

const SIGN_FIELDS = {
  create: ['accessKey', 'amount', 'extraData', 'ipnUrl', 'orderId', 'orderInfo', 'partnerCode', 'redirectUrl', 'requestId', 'requestType'],
  query: ['accessKey', 'orderId', 'partnerCode', 'requestId'],
  refund: ['accessKey', 'amount', 'description', 'orderId', 'partnerCode', 'requestId', 'transId'],
  refundQuery: ['accessKey', 'orderId', 'partnerCode', 'requestId'],
  confirm: ['accessKey', 'amount', 'description', 'orderId', 'partnerCode', 'requestId', 'requestType'],
  ipn: ['accessKey', 'amount', 'extraData', 'message', 'orderId', 'orderInfo', 'orderType', 'partnerCode', 'payType', 'requestId', 'responseTime', 'resultCode', 'transId'],
};
const REQUEST_TYPES = ['captureWallet', 'payWithMethod', 'payWithATM', 'payWithCC'];
const ORDER_ID_RE = /^[0-9a-zA-Z]+([-_.:]+[0-9a-zA-Z]+)*$/; // live: cho phép ":" (A14)
const HTTP_400_CODES = new Set([20, 13, 11007, 22]); // A12, A16

const DEFAULT_CONTROLS = {
  expire_after_seconds: 900,        // unverified (A18): docs không nêu
  paid_after_expiry: true,          // unverified (A18): bất lợi, tiền vẫn về sau khi đơn bị coi hết hạn
  allow_retry_after_failure: true,  // unverified (A17): khách thử lại trên cùng payUrl
  ipn_retry_count: 5,               // unverified (A4): số lần gửi lại sau lần đầu
  ipn_retry_interval_seconds: 300,  // unverified (A4)
  ipn_timeout_ms: 15000,            // docs: MoMo mong 204 trong 15 giây
  refund_mode: 'sync',              // 'sync' | 'async' (A10, A19 unverified)
  refund_async_final: 'success',    // 'success' | 'failed'
  refund_async_delay_seconds: 3600,
};

function hmac(secret, fields, source) {
  const raw = fields.map((k) => `${k}=${source[k] === undefined || source[k] === null ? '' : source[k]}`).join('&');
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function makeClock(opts) {
  if (opts && opts.clock) return opts.clock;
  let t = Date.now();
  return { now: () => t, advance(sec) { t += sec * 1000; return t; } };
}

async function startSimulator(opts = {}) {
  const partnerCode = opts.partnerCode || 'MOMOSIM01';
  const accessKey = opts.accessKey || 'sim-access-key';
  const secretKey = opts.secretKey || 'sim-secret-key';
  const clock = makeClock(opts);
  const state = {
    transactions: new Map(),
    refunds: new Map(),
    controls: { global: { ...DEFAULT_CONTROLS, ...(opts.controls || {}) }, byOrder: {} },
    ipnQueue: [],
    ipnLog: [],
    transSeq: 0,
  };
  const ctl = (orderId) => ({ ...state.controls.global, ...(state.controls.byOrder[orderId] || {}) });

  // ---------- helpers ----------
  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const momoReply = (res, requestId, resultCode, message, extra = {}) =>
    send(res, HTTP_400_CODES.has(resultCode) ? 400 : 200, { ...extra, requestId, responseTime: clock.now(), resultCode, message });

  const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

  const effStatus = (t) => (t.status === 'initiated' && clock.now() >= t.createdAt + ctl(t.orderId).expire_after_seconds * 1000 ? 'expired' : t.status);

  const refundCode = (r) => {
    if (r.mode === 'sync') return 0;
    return clock.now() >= r.finalAt ? r.finalCode : 7002;
  };
  const refundedSum = (t) => [...state.refunds.values()].filter((r) => r.parent === t.orderId && refundCode(r) !== 1004).reduce((s, r) => s + r.amount, 0);

  function ipnPayload(t, c) {
    const p = {
      partnerCode, orderId: t.orderId, requestId: t.requestId,
      amount: c.ipn_wrong_amount ? t.amount + 1000 : t.amount,
      orderInfo: t.orderInfo, orderType: 'momo_wallet', transId: t.transId || 0,
      resultCode: t.resultCode, message: t.message, payType: t.payType || '',
      responseTime: clock.now(), extraData: t.extraData || '',
    };
    p.signature = hmac(secretKey, SIGN_FIELDS.ipn, { ...p, accessKey });
    if (c.ipn_bad_signature) p.signature = p.signature.slice(0, -4) + (p.signature.endsWith('0000') ? '1111' : '0000');
    return p;
  }

  function returnUrlFor(t) {
    const p = ipnPayload(t, {});
    return `${t.redirectUrl || ''}${(t.redirectUrl || '').includes('?') ? '&' : '?'}${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString()}`;
  }

  async function deliver(entry) {
    const t = state.transactions.get(entry.orderId);
    const url = opts.ipnUrl || (t && t.ipnUrl);
    const log = { orderId: entry.orderId, attempt: entry.attempt, at: clock.now(), resultCode: entry.payload.resultCode };
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry.payload),
        signal: AbortSignal.timeout(ctl(entry.orderId).ipn_timeout_ms),
      });
      await r.text();
      log.httpStatus = r.status;
    } catch (e) { log.error = String(e && e.message || e); }
    state.ipnLog.push(log);
    // MoMo mong 204; khác 204 hoặc lỗi mạng thì retry (A4 unverified)
    if (log.httpStatus !== 204 && entry.attempt <= ctl(entry.orderId).ipn_retry_count) {
      state.ipnQueue.push({ ...entry, attempt: entry.attempt + 1, due: clock.now() + ctl(entry.orderId).ipn_retry_interval_seconds * 1000 });
    }
    return log;
  }

  async function pump() {
    const now = clock.now();
    const due = state.ipnQueue.filter((e) => e.due <= now);
    state.ipnQueue = state.ipnQueue.filter((e) => e.due > now);
    for (const e of due) await deliver(e);
  }

  function scheduleIpn(t) {
    const c = ctl(t.orderId);
    if (c.ipn_drop) { state.ipnLog.push({ orderId: t.orderId, at: clock.now(), dropped: true }); return; }
    const times = c.ipn_duplicate ? 2 : 1;
    for (let i = 0; i < times; i++) {
      state.ipnQueue.push({ orderId: t.orderId, attempt: 1, due: clock.now() + (c.ipn_delay_seconds || 0) * 1000, payload: ipnPayload(t, c) });
    }
  }

  // ---------- validation chung: 20 -> 13 -> 11007 ----------
  function baseCheck(res, body, kind, required) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return momoReply(res, crypto.randomUUID(), 20, 'Bad format request.'), false;
    const subErrors = required.filter((k) => isBlank(body[k])).map((field) => ({ field, message: 'Invalid value. Field must not be blank' }));
    if (subErrors.length) return momoReply(res, body.requestId || crypto.randomUUID(), 20, 'Bad format request.', { subErrors }), false;
    return true;
  }
  function merchantAndSig(res, body, kind) {
    if (body.partnerCode !== partnerCode) return momoReply(res, body.requestId, 13, 'The merchant configuration is incorrect or the account is inactive.'), false;
    const expected = hmac(secretKey, SIGN_FIELDS[kind], { ...body, accessKey });
    if (body.signature !== expected) return momoReply(res, body.requestId, 11007, 'Invalid signature. Check raw signature before signed.'), false;
    return true;
  }
  const parseAmount = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v);
    return NaN;
  };

  // ---------- handlers MoMo ----------
  function handleCreate(req, res, body) {
    if (!baseCheck(res, body, 'create', ['partnerCode', 'orderId', 'requestId', 'orderInfo', 'ipnUrl', 'requestType', 'signature'])) return;
    const amount = parseAmount(body.amount);
    const fmtErrors = [];
    if (body.extraData === undefined || body.extraData === null) fmtErrors.push({ field: 'extraData', message: 'Invalid value. Field must not be null' });
    if (!ORDER_ID_RE.test(String(body.orderId))) fmtErrors.push({ field: 'orderId', message: `must match "${ORDER_ID_RE.source}"` });
    if (!REQUEST_TYPES.includes(body.requestType)) fmtErrors.push({ field: 'requestType', message: 'Invalid value' });
    if (Number.isNaN(amount)) fmtErrors.push({ field: 'amount', message: 'Invalid value' });
    if (fmtErrors.length) return momoReply(res, body.requestId, 20, 'Bad format request.', { subErrors: fmtErrors });
    if (!merchantAndSig(res, body, 'create')) return;
    if (amount < 1000 || amount > 50000000) {
      return momoReply(res, body.requestId, 22, 'Request rejected due to the transaction amount is either lower than the allowed minimum of 1000 VND or higher than the allowed maximum of 50000000 VND.');
    }
    const c = ctl(body.orderId);
    if (c.force_result_code) return momoReply(res, body.requestId, Number(c.force_result_code), 'Forced result code.');
    // A6: orderId trùng trả 41 và KHÔNG trả lại payUrl; A5: requestId không bị ép duy nhất
    if (state.transactions.has(body.orderId)) {
      return momoReply(res, body.requestId, 41, 'Request rejected due to duplicated orderId.', { partnerCode, orderId: body.orderId });
    }
    const t = {
      orderId: body.orderId, requestId: body.requestId, amount, orderInfo: body.orderInfo, extraData: body.extraData,
      ipnUrl: body.ipnUrl, redirectUrl: body.redirectUrl || '', status: 'initiated', resultCode: 1000,
      message: 'Transaction is initiated, waiting for user confirmation.', createdAt: clock.now(), lastUpdated: clock.now(),
      transId: 0, payType: '',
    };
    state.transactions.set(t.orderId, t);
    if (c.create_drop_response) { req.socket.destroy(); return; } // đã tạo đơn nhưng mất phản hồi
    const payUrl = `${baseUrl()}/v2/gateway/pay?t=${Buffer.from(`${partnerCode}|${t.orderId}`).toString('base64url')}`;
    momoReply(res, body.requestId, 0, 'Successful.', {
      partnerCode, orderId: t.orderId, amount, payUrl, deeplink: `momo://pay?o=${t.orderId}`, qrCodeUrl: `momo://qr?o=${t.orderId}`,
    });
  }

  function handleQuery(res, body) {
    if (!baseCheck(res, body, 'query', ['partnerCode', 'orderId', 'requestId', 'signature'])) return;
    if (!merchantAndSig(res, body, 'query')) return;
    const c = ctl(body.orderId);
    if (c.force_result_code) return momoReply(res, body.requestId, Number(c.force_result_code), 'Forced result code.', { partnerCode, orderId: body.orderId });
    const t = state.transactions.get(body.orderId);
    // A7: đơn lạ hoặc hết hạn đều là 1005 (gộp), không có chữ ký trong phản hồi (A11)
    if (!t) return momoReply(res, body.requestId, 1005, 'Transaction expired or did not exist.', { partnerCode, orderId: body.orderId });
    const st = effStatus(t);
    if (st === 'expired') return momoReply(res, body.requestId, 1005, 'Transaction expired or did not exist.', { partnerCode, orderId: body.orderId });
    const refundTrans = [...state.refunds.values()].filter((r) => r.parent === t.orderId).map(refundEntry);
    momoReply(res, body.requestId, t.resultCode, t.message, {
      partnerCode, orderId: t.orderId, extraData: t.extraData, amount: t.amount, transId: t.transId, payType: t.payType,
      refundTrans, lastUpdated: t.lastUpdated,
    });
  }

  const refundEntry = (r) => ({ orderId: r.orderId, amount: r.amount, resultCode: refundCode(r), transId: r.transId, createdTime: r.createdAt });

  function handleRefund(res, body) {
    if (!baseCheck(res, body, 'refund', ['partnerCode', 'orderId', 'requestId', 'amount', 'transId', 'signature'])) return;
    const amount = parseAmount(body.amount);
    if (Number.isNaN(amount) || !/^\d+$/.test(String(body.transId))) return momoReply(res, body.requestId, 20, 'Bad format request.');
    if (!merchantAndSig(res, body, 'refund')) return;
    if (amount < 1000 || amount > 50000000) return momoReply(res, body.requestId, 22, 'Request rejected due to the transaction amount is out of range.');
    const c = ctl(body.orderId);
    if (c.force_result_code) return momoReply(res, body.requestId, Number(c.force_result_code), 'Forced result code.');
    const t = [...state.transactions.values()].find((x) => x.transId && String(x.transId) === String(body.transId) && x.status === 'success');
    if (!t) return momoReply(res, body.requestId, 43, 'Request rejected due to conflicted transaction process.'); // probe B13
    if (state.refunds.has(body.orderId) || state.transactions.has(body.orderId)) {
      return momoReply(res, body.requestId, 41, 'Request rejected due to duplicated orderId.', { partnerCode, orderId: body.orderId });
    }
    if (refundedSum(t) + amount > t.amount) return momoReply(res, body.requestId, 43, 'Request rejected due to conflicted transaction process.');
    const async = c.refund_mode === 'async';
    const r = {
      orderId: body.orderId, requestId: body.requestId, parent: t.orderId, amount, transId: 3000000000 + ++state.transSeq,
      createdAt: clock.now(), mode: async ? 'async' : 'sync',
      finalAt: clock.now() + c.refund_async_delay_seconds * 1000, finalCode: c.refund_async_final === 'failed' ? 1004 : 0,
    };
    state.refunds.set(r.orderId, r);
    const code = refundCode(r);
    momoReply(res, body.requestId, code, code === 0 ? 'Successful.' : 'Refund is being processed.', { partnerCode, orderId: r.orderId, amount, transId: r.transId });
  }

  function handleRefundQuery(res, body) {
    if (!baseCheck(res, body, 'refundQuery', ['partnerCode', 'orderId', 'requestId', 'signature'])) return;
    if (!merchantAndSig(res, body, 'refundQuery')) return;
    const r = state.refunds.get(body.orderId);
    if (!r) return momoReply(res, body.requestId, 42, 'Refund transaction not found.', { partnerCode, orderId: body.orderId });
    momoReply(res, body.requestId, 0, 'Successful.', { partnerCode, orderId: body.orderId, refundTrans: [refundEntry(r)] });
  }

  async function handleConfirm(res, body) {
    if (!baseCheck(res, body, 'confirm', ['partnerCode', 'orderId', 'requestId', 'requestType', 'signature'])) return;
    if (!merchantAndSig(res, body, 'confirm')) return;
    const t = state.transactions.get(body.orderId);
    if (!t || effStatus(t) !== 'authorized') return momoReply(res, body.requestId, 43, 'Request rejected due to conflicted transaction process.'); // probe B14
    if (body.requestType === 'capture') applyOutcome(t, 'success'); else { t.status = 'voided'; t.resultCode = 1017; t.message = 'Transaction cancelled by merchant.'; t.lastUpdated = clock.now(); }
    scheduleIpn(t);
    momoReply(res, body.requestId, 0, 'Successful.', { partnerCode, orderId: t.orderId, amount: t.amount, transId: t.transId });
    await pump();
  }

  function applyOutcome(t, outcome) {
    t.lastUpdated = clock.now();
    if (outcome === 'success') {
      t.status = 'success'; t.resultCode = 0; t.message = 'Successful.'; t.payType = 'qr'; t.transId = t.transId || 2147000000 + ++state.transSeq;
    } else if (outcome === 'failed') {
      t.status = 'failed'; t.resultCode = 1001; t.message = 'Transaction failed.';
    } else if (outcome === 'cancel') {
      t.status = 'cancelled'; t.resultCode = 1006; t.message = 'Transaction denied by user.';
    } else if (outcome === 'authorized') {
      t.status = 'authorized'; t.resultCode = 9000; t.message = 'Transaction authorized.';
      t.transId = t.transId || 2147000000 + ++state.transSeq;
    }
  }

  // ---------- route giả lập ----------
  async function handleSim(req, res, path, body) {
    if (req.method === 'POST' && path === '/sim/clock/advance') {
      if (typeof clock.advance !== 'function') return send(res, 400, { error: 'clock không hỗ trợ advance' });
      clock.advance(Number(body.seconds) || 0);
      await pump();
      return send(res, 200, { now: clock.now() });
    }
    if (req.method === 'GET' && path === '/sim/transactions') {
      return send(res, 200, {
        now: clock.now(),
        transactions: [...state.transactions.values()].map((t) => ({ ...t, effectiveStatus: effStatus(t) })),
        refunds: [...state.refunds.values()].map((r) => ({ ...r, resultCode: refundCode(r) })),
        ipnLog: state.ipnLog, ipnQueue: state.ipnQueue.map((e) => ({ orderId: e.orderId, attempt: e.attempt, due: e.due })),
        controls: state.controls,
      });
    }
    if (req.method === 'POST' && path === '/sim/control') {
      const { orderId, ...settings } = body || {};
      if (orderId) state.controls.byOrder[orderId] = { ...(state.controls.byOrder[orderId] || {}), ...settings };
      else Object.assign(state.controls.global, settings);
      return send(res, 200, { ok: true, controls: state.controls });
    }
    if (req.method === 'POST' && path === '/sim/pay') {
      const t = state.transactions.get(body && body.orderId);
      if (!t) return send(res, 404, { error: 'order not found' });
      const outcome = body.outcome;
      if (!['success', 'failed', 'cancel', 'authorized'].includes(outcome)) return send(res, 400, { error: 'outcome không hợp lệ' });
      const c = ctl(t.orderId);
      const st = effStatus(t);
      if (st === 'success') return send(res, 409, { error: 'already succeeded' });
      if (st === 'expired' && !c.paid_after_expiry) return send(res, 409, { error: 'expired' });
      if (['failed', 'cancelled'].includes(st) && !c.allow_retry_after_failure) return send(res, 409, { error: 'closed' });
      const afterExpiry = st === 'expired';
      applyOutcome(t, outcome);
      if (afterExpiry) t.paidAfterExpiry = true;
      scheduleIpn(t);
      await pump();
      return send(res, 200, { orderId: t.orderId, status: t.status, resultCode: t.resultCode, transId: t.transId, paidAfterExpiry: !!t.paidAfterExpiry, returnUrl: returnUrlFor(t) });
    }
    const m = /^\/sim\/ipn\/([^/]+)\/resend$/.exec(path);
    if (req.method === 'POST' && m) {
      const t = state.transactions.get(decodeURIComponent(m[1]));
      if (!t) return send(res, 404, { error: 'order not found' });
      const log = await deliver({ orderId: t.orderId, attempt: 1, payload: ipnPayload(t, ctl(t.orderId)) });
      return send(res, 200, log);
    }
    return send(res, 404, { error: 'unknown sim route' });
  }

  // ---------- server ----------
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      try {
        const path = new URL(req.url, 'http://x').pathname;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (path.startsWith('/sim/')) {
          let b = {};
          if (raw) { try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad json' }); } }
          return await handleSim(req, res, path, b);
        }
        const handlers = {
          '/v2/gateway/api/create': (b) => handleCreate(req, res, b),
          '/v2/gateway/api/query': (b) => handleQuery(res, b),
          '/v2/gateway/api/refund': (b) => handleRefund(res, b),
          '/v2/gateway/api/refund/query': (b) => handleRefundQuery(res, b),
          '/v2/gateway/api/confirm': (b) => handleConfirm(res, b),
        };
        const h = handlers[path];
        if (!h) return send(res, 404, { error: 'not found' });
        // probe A1: GET trả 405 kèm resultCode 20
        if (req.method !== 'POST') return send(res, 405, { requestId: crypto.randomUUID(), responseTime: clock.now(), resultCode: 20, message: 'Bad format request.' });
        let body;
        try { body = JSON.parse(raw); } catch { return momoReply(res, crypto.randomUUID(), 20, 'Bad format request.'); }
        return await h(body);
      } catch (e) {
        if (!res.headersSent) send(res, 500, { error: String(e && e.message || e) });
      }
    });
  });

  await new Promise((resolve) => server.listen(opts.port || 0, opts.host || '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  function baseUrl() { return url; }

  return {
    port, url, clock, state,
    config: { partnerCode, accessKey, secretKey },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startSimulator, SIGN_FIELDS, DEFAULT_CONTROLS };

if (require.main === module) {
  const env = process.env;
  startSimulator({
    port: Number(env.SIM_PORT) || 0,
    host: env.SIM_HOST, // trong container đặt 0.0.0.0
    partnerCode: env.SIM_PARTNER_CODE, accessKey: env.SIM_ACCESS_KEY, secretKey: env.SIM_SECRET_KEY, ipnUrl: env.SIM_IPN_URL,
  }).then((s) => {
    console.log(`MoMo simulator: ${s.url} (partnerCode=${s.config.partnerCode})`);
  });
}

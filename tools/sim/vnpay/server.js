'use strict';
// spec: VNPS-S-010
// spec: VNPS-S-001
// spec: VNPS-S-002
// spec: VNPS-S-003
// spec: VNPS-S-004
// spec: VNPS-S-005
// spec: VNPS-S-006
// spec: VNPS-S-007
// spec: PHUB-S-022
// Simulator VNPay: khong phu thuoc thu vien. Format theo bang chung (probe live, sample, golden);
// ngu nghia chua xac minh (VNPS-D-009 A8..A14) mo phong theo huong bat loi va cau hinh duoc.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

// ---------- Thoi gian GMT+7 (yyyyMMddHHmmss) ----------
const TZ_MS = 7 * 3600e3;
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtDate(ms) {
  const d = new Date(ms + TZ_MS);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{14}$/.test(s)) return NaN;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) - TZ_MS;
}

// ---------- Chu ky (VNPS-S-002, S-006) ----------
// urlencode kieu PHP: khoang trang thanh '+', ma hoa ca ! ' ( ) * ~
const phpEncode = (s) => encodeURIComponent(String(s)).replace(/%20/g, '+')
  .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
// Chuoi canonical: tham so vnp_*, bo hash, bo gia tri rong, sap xep theo ten.
function canonicalQuery(params) {
  return Object.keys(params)
    .filter((k) => k.startsWith('vnp_') && k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType')
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${phpEncode(k)}=${phpEncode(params[k])}`)
    .join('&');
}
const hmac512 = (secret, data) => crypto.createHmac('sha512', secret).update(data, 'utf8').digest('hex');
const signParams = (secret, params) => hmac512(secret, canonicalQuery(params));
function hashEquals(a, b) {
  const x = Buffer.from(String(a).toLowerCase()), y = Buffer.from(String(b).toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Chuoi noi bang '|' cho API querydr/refund
const SIGN_FIELDS = {
  querydrReq: ['RequestId', 'Version', 'Command', 'TmnCode', 'TxnRef', 'TransactionDate', 'CreateDate', 'IpAddr', 'OrderInfo'],
  querydrRes: ['ResponseId', 'Command', 'ResponseCode', 'Message', 'TmnCode', 'TxnRef', 'Amount', 'BankCode', 'PayDate', 'TransactionNo', 'TransactionType', 'TransactionStatus', 'OrderInfo', 'PromotionCode', 'PromotionAmount'],
  refundReq: ['RequestId', 'Version', 'Command', 'TmnCode', 'TransactionType', 'TxnRef', 'Amount', 'TransactionNo', 'TransactionDate', 'CreateBy', 'CreateDate', 'IpAddr', 'OrderInfo'],
  refundRes: ['ResponseId', 'Command', 'ResponseCode', 'Message', 'TmnCode', 'TxnRef', 'Amount', 'BankCode', 'PayDate', 'TransactionNo', 'TransactionType', 'TransactionStatus', 'OrderInfo'],
};
const pipeData = (obj, fields) => fields.map((f) => { const v = obj['vnp_' + f]; return v === undefined || v === null ? '' : String(v); }).join('|');

// ---------- Dong ho ao + bo lap lich (VNPS-S-001) ----------
function createClock({ startAt, frozen = false } = {}) {
  let offset = 0;
  let cur = startAt ?? Date.now();
  if (!frozen && startAt != null) offset = startAt - Date.now();
  const now = () => (frozen ? cur : Date.now() + offset);
  const set = (t) => { if (frozen) cur = t; else offset = t - Date.now(); };
  const jobs = [];
  let chain = Promise.resolve();
  const locked = (fn) => { chain = chain.then(fn, fn); return chain; };
  function takeNext(limit) {
    let best = -1;
    jobs.forEach((j, i) => { if (j.at <= limit && (best < 0 || j.at < jobs[best].at)) best = i; });
    return best < 0 ? null : jobs.splice(best, 1)[0];
  }
  async function drain(limit, moveClock) {
    for (let j = takeNext(limit()); j; j = takeNext(limit())) {
      if (moveClock && j.at > now()) set(j.at); // dung dung thoi diem den han de lich retry lien tiep dung
      try { await j.fn(); } catch (e) { /* loi cua viec den han khong duoc lam hong dong ho */ }
    }
  }
  const clock = {
    now,
    schedule(at, fn) { const job = { at, fn }; jobs.push(job); return job; },
    pending: () => jobs.length,
    runDue: () => locked(() => drain(now, false)),
    // Tang gio ao roi chay moi viec den han (ke ca viec moi sinh ra trong luc chay)
    advance(seconds) {
      return locked(async () => {
        const target = now() + seconds * 1000;
        await drain(() => target, true);
        set(target);
      });
    },
  };
  return clock;
}

// ---------- Ma loi (bang Error.html, chi cho trang loi luc tao URL, VNPS-D-009 A6) ----------
const ERROR_MESSAGES = {
  '03': 'Invalid data format', '15': 'Transaction time expired. Please try again', '21': 'Currency is not supported',
  '32': 'Invalid transaction amount. Amount rangle is from 5.000 to 1.000.000.000 VND', '70': 'Invalid signature',
  '72': 'The terminal (website) not found', '99': 'An error occurred. Please try again later.',
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Kich ban mac dinh (tat het) ----------
const SCENARIO_KEYS = ['ipn_delay_seconds', 'ipn_duplicate', 'ipn_drop', 'ipn_wrong_amount', 'ipn_bad_signature',
  'force_response_code', 'return_never', 'paid_after_expiry', 'refund_outcome', 'refund_delay_seconds'];

function startSimulator(opts = {}) {
  const cfg = {
    tmnCode: opts.tmnCode || 'SIMTMN01',
    hashSecret: opts.hashSecret || 'sim-hash-secret-not-real',
    ipnUrl: opts.ipnUrl || null,
    ipnMethod: String(opts.ipnMethod || 'GET').toUpperCase(),
    ipnRetry: { maxAttempts: 10, intervalSeconds: 300, ...(opts.ipnRetry || {}) }, // tuning, chua xac minh (A8)
    ipnTimeoutMs: opts.ipnTimeoutMs ?? 5000,
    refund: { delaySeconds: 60, outcome: 'success', ...(opts.refund || {}) },
    duplicateWindowSeconds: 300, // querydr/refund trung trong 5 phut -> 94
  };
  const cards = opts.cards || require(path.join(__dirname, 'cards.json')).cards;
  const clock = createClock(opts.clock || {});
  const state = {
    transactions: new Map(),
    ipnLog: [],
    control: { global: {}, txn: {} },
    requestIds: new Map(),
    seq: 0,
    warnings: [],
  };
  if (cfg.ipnUrl && cfg.ipnUrl.startsWith('http:') && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(cfg.ipnUrl)) {
    state.warnings.push('IPN URL that yeu cau HTTPS; simulator cho phep HTTP cuc bo');
  }
  let publicBase = opts.publicBaseUrl || null;

  // ----- Kich ban (VNPS-S-007) -----
  const scenarioFor = (txnRef) => ({ ...state.control.global, ...(state.control.txn[txnRef] || {}) });
  const logScenario = (txn, behavior, detail) => txn.scenarioLog.push({ at: clock.now(), behavior, detail });

  // ----- Tang 1 + 2 kiem tra yeu cau thanh toan (VNPS-S-002) -----
  function validatePay(q) {
    const required = ['vnp_Version', 'vnp_Command', 'vnp_TmnCode', 'vnp_Amount', 'vnp_CreateDate', 'vnp_CurrCode', 'vnp_IpAddr',
      'vnp_Locale', 'vnp_OrderInfo', 'vnp_OrderType', 'vnp_ReturnUrl', 'vnp_TxnRef', 'vnp_SecureHash'];
    for (const k of required) if (!q[k]) return '03';
    if (q.vnp_Version !== '2.1.0') return '03';
    if (!/^-?\d+$/.test(q.vnp_Amount)) return '03';
    const amount = Number(q.vnp_Amount);
    if (amount <= 0) return '32';
    if (q.vnp_Amount.length > 12 || amount < 500000) return '72'; // < 5.000 VND (probe)
    if (q.vnp_Command !== 'pay') return '72';
    if (!/^[A-Z0-9]{8}$/.test(q.vnp_TmnCode)) return '72';
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(q.vnp_TxnRef)) return '72';
    if (!/^https?:\/\/\S+$/.test(q.vnp_ReturnUrl) || q.vnp_ReturnUrl.length < 10 || q.vnp_ReturnUrl.length > 255) return '72';
    if (q.vnp_IpAddr.length < 7 || q.vnp_IpAddr.length > 45) return '72';
    if (!['vn', 'en'].includes(q.vnp_Locale)) return '72';
    if (!/^[\x20-\x7E]{1,255}$/.test(q.vnp_OrderInfo)) return '72'; // khong dau
    if (/^[A-Z]{3}$/.test(q.vnp_CurrCode) && !['VND', 'USD'].includes(q.vnp_CurrCode)) return '21';
    if (q.vnp_CurrCode !== 'VND') return '72';
    const now = clock.now();
    const created = parseDate(q.vnp_CreateDate); // sai dinh dang van qua (probe)
    if (!Number.isNaN(created) && Math.abs(now - created) > 86400e3) return '72';
    if (q.vnp_ExpireDate) { // thieu thi khong bi chan
      const exp = parseDate(q.vnp_ExpireDate);
      if (Number.isNaN(exp)) return '72';
      if (exp <= now || (!Number.isNaN(created) && exp < created)) return '15';
      if (exp - now >= 30 * 86400e3) return '72';
    }
    // Tang 2: tra TmnCode roi kiem tra chu ky
    if (q.vnp_TmnCode !== cfg.tmnCode) return '72';
    if (!hashEquals(signParams(cfg.hashSecret, q), q.vnp_SecureHash)) return '70'; // ma khi sai chu ky: unverified (A4)
    return null;
  }

  // ----- Ket qua giao dich (VNPS-S-003) -----
  const isExpired = (txn) => txn.expireAt != null && clock.now() > txn.expireAt;
  function resolveResult(txn, { outcome, card }) {
    const sc = scenarioFor(txn.txnRef);
    let code; let status;
    if (outcome === 'cancel') { code = '24'; status = '02'; } else {
      const wanted = outcome === 'success' ? cards[0]?.number : outcome === 'insufficient' ? '9704195798459170488' : card;
      const row = cards.find((c) => c.number === (card || wanted));
      if (!row) return { error: 'card_rejected' };
      code = row.responseCode; status = row.transactionStatus;
    }
    if (isExpired(txn)) {
      if (sc.paid_after_expiry && code === '00') logScenario(txn, 'paid_after_expiry', 'tra sau han van ghi nhan thanh cong');
      else { code = '11'; status = '02'; }
    }
    if (sc.force_response_code) {
      code = String(sc.force_response_code);
      status = code === '00' ? '00' : code === '07' ? '07' : '02'; // 07: tru tien nhung bi nghi ngo, TransactionStatus cung la 07
      logScenario(txn, 'force_response_code', code);
    }
    return { code, status };
  }

  function applyResult(txn, { code, status }) {
    const now = clock.now();
    txn.responseCode = code;
    txn.transactionStatus = status;
    txn.status = code === '00' && status === '00' ? 'paid' : code === '24' ? 'cancelled' : code === '11' ? 'expired' : 'failed';
    const ok = txn.status === 'paid';
    txn.transactionNo = ok ? String(14000000 + (++state.seq)) : '0';
    txn.bankTranNo = ok ? `VNP${txn.transactionNo}` : '';
    txn.cardType = ok ? 'ATM' : '';
    txn.bankCode = 'NCB';
    txn.payDate = fmtDate(now);
    txn.finishedAt = now;
  }

  // Tham so ket qua dung cho return va IPN
  function resultParams(txn, { forIpn, sc = {} }) {
    const p = {
      vnp_TmnCode: cfg.tmnCode,
      vnp_Amount: String(txn.amount * 100),
      vnp_BankCode: txn.bankCode,
      vnp_BankTranNo: txn.bankTranNo,
      vnp_CardType: txn.cardType,
      vnp_PayDate: txn.payDate,
      vnp_OrderInfo: txn.orderInfo,
      vnp_TransactionNo: txn.transactionNo,
      vnp_ResponseCode: txn.responseCode,
      vnp_TransactionStatus: txn.transactionStatus,
      vnp_TxnRef: txn.txnRef,
    };
    if (forIpn && sc.ipn_wrong_amount) p.vnp_Amount = String(txn.amount * 100 + 10000); // lech 100 VND, ky dung
    let hash = signParams(cfg.hashSecret, p);
    if (forIpn && sc.ipn_bad_signature) hash = (hash[0] === '0' ? '1' : '0') + hash.slice(1);
    p.vnp_SecureHash = hash;
    return p;
  }
  const queryString = (p) => Object.keys(p).map((k) => `${phpEncode(k)}=${phpEncode(p[k])}`).join('&');

  // ----- IPN (VNPS-S-005) -----
  async function sendIpn(txn, kind, attempt, sc) {
    const params = resultParams(txn, { forIpn: true, sc });
    const entry = { at: clock.now(), txnRef: txn.txnRef, kind, attempt, method: cfg.ipnMethod, url: cfg.ipnUrl, httpStatus: null, rspCode: null, message: null, error: null, ok: false };
    if (sc.ipn_wrong_amount) logScenario(txn, 'ipn_wrong_amount', params.vnp_Amount);
    if (sc.ipn_bad_signature) logScenario(txn, 'ipn_bad_signature', kind);
    try {
      if (!cfg.ipnUrl) throw new Error('chua cau hinh ipnUrl');
      const qs = queryString(params);
      const init = { method: cfg.ipnMethod, signal: AbortSignal.timeout(cfg.ipnTimeoutMs) };
      let url = cfg.ipnUrl;
      if (cfg.ipnMethod === 'POST') {
        init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
        init.body = qs;
      } else url += (url.includes('?') ? '&' : '?') + qs;
      const res = await fetch(url, init);
      entry.httpStatus = res.status;
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        entry.rspCode = j.RspCode == null ? null : String(j.RspCode);
        entry.message = j.Message ?? null;
      } catch (e) { entry.error = 'phan hoi khong phai JSON'; }
      // 00 va 02 la dung; moi truong hop khac (HTTP != 200, khong JSON, 01/04/97/99) phai thu lai
      entry.ok = res.status === 200 && (entry.rspCode === '00' || entry.rspCode === '02');
    } catch (e) {
      entry.error = String(e && e.message || e);
    }
    state.ipnLog.push(entry);
    txn.ipn.log.push(entry);
    return entry;
  }

  async function deliverPrimary(txn, gen, attempt) {
    if (txn.ipn.gen !== gen) return; // da co ket qua moi, bo lich cu
    const sc = scenarioFor(txn.txnRef);
    const entry = await sendIpn(txn, attempt === 1 ? 'initial' : 'retry', attempt, sc);
    txn.ipn.attempts = attempt;
    if (entry.ok) txn.ipn.state = 'done';
    else if (attempt >= cfg.ipnRetry.maxAttempts) txn.ipn.state = 'ipn_exhausted';
    else {
      txn.ipn.state = 'retrying';
      clock.schedule(clock.now() + cfg.ipnRetry.intervalSeconds * 1000, () => deliverPrimary(txn, gen, attempt + 1));
    }
    if (attempt === 1 && sc.ipn_duplicate > 1) { // gui trung: them N-1 ban sao, khong anh huong lich retry
      logScenario(txn, 'ipn_duplicate', sc.ipn_duplicate);
      for (let i = 1; i < sc.ipn_duplicate; i++) await sendIpn(txn, 'duplicate', attempt, sc);
    }
  }

  async function startIpn(txn, { wait }) {
    const gen = (txn.ipn?.gen || 0) + 1;
    txn.ipn = { gen, state: 'pending', attempts: 0, log: txn.ipn?.log || [] };
    const sc = scenarioFor(txn.txnRef);
    if (sc.ipn_drop) { txn.ipn.state = 'dropped'; logScenario(txn, 'ipn_drop', 'khong gui IPN'); return; }
    const delay = Number(sc.ipn_delay_seconds) || 0;
    if (delay > 0) {
      logScenario(txn, 'ipn_delay_seconds', delay);
      clock.schedule(clock.now() + delay * 1000, () => deliverPrimary(txn, gen, 1));
      return;
    }
    const p = deliverPrimary(txn, gen, 1);
    if (wait) await p; else p.catch(() => {});
  }

  // Khach hang thanh toan / huy (thay cho trang nhap the)
  async function customerPays(txn, input, { wait = true } = {}) {
    if (txn.status === 'paid') return { error: 'already_paid' };
    const r = resolveResult(txn, input);
    if (r.error) return r;
    applyResult(txn, r);
    const sc = scenarioFor(txn.txnRef);
    let returnUrl = null;
    if (sc.return_never) logScenario(txn, 'return_never', 'khach dong trinh duyet');
    else {
      const rp = resultParams(txn, { forIpn: false });
      returnUrl = txn.returnUrl + (txn.returnUrl.includes('?') ? '&' : '?') + queryString(rp);
    }
    await startIpn(txn, { wait });
    return { txn, returnUrl };
  }

  // ----- API querydr / refund (VNPS-S-006) -----
  function apiReply(res, req_, command, code, message, extra = {}, signedWith = null) {
    const body = { vnp_ResponseId: crypto.randomUUID().replace(/-/g, ''), vnp_Command: command, vnp_ResponseCode: code, vnp_Message: message, ...extra };
    if (signedWith) body.vnp_SecureHash = hmac512(cfg.hashSecret, pipeData(body, SIGN_FIELDS[signedWith]));
    return json(res, 200, body);
  }
  const duplicateRequest = (id) => {
    const now = clock.now();
    const prev = state.requestIds.get(id);
    state.requestIds.set(id, now);
    return prev !== undefined && now - prev < cfg.duplicateWindowSeconds * 1000;
  };

  function handleApi(req, res, raw) {
    if (req.method !== 'POST') return json(res, 405, { Message: "The requested resource does not support http method 'GET'." });
    let b;
    try { b = JSON.parse(raw); if (!b || typeof b !== 'object') throw new Error('x'); } catch (e) {
      res.writeHead(500, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body>Error</body></html>');
    }
    const cmd = b.vnp_Command;
    if (cmd !== 'querydr' && cmd !== 'refund') return json(res, 200, { vnp_ResponseCode: '99', vnp_Message: 'Command not support' });
    const need = cmd === 'querydr'
      ? ['RequestId', 'Version', 'Command', 'TmnCode', 'TxnRef', 'OrderInfo', 'TransactionDate', 'CreateDate', 'IpAddr', 'SecureHash']
      : ['RequestId', 'Version', 'Command', 'TmnCode', 'TransactionType', 'TxnRef', 'Amount', 'TransactionDate', 'CreateBy', 'CreateDate', 'IpAddr', 'OrderInfo', 'SecureHash'];
    if (need.some((k) => b['vnp_' + k] === undefined || b['vnp_' + k] === null || b['vnp_' + k] === '')) {
      return json(res, 200, { vnp_ResponseCode: '99', vnp_Message: 'Parameter required' });
    }
    if (b.vnp_TmnCode !== cfg.tmnCode) return apiReply(res, b, cmd, '02', 'Website not found'); // truoc khi kiem chu ky (probe)
    const expect = hmac512(cfg.hashSecret, pipeData(b, SIGN_FIELDS[cmd === 'querydr' ? 'querydrReq' : 'refundReq']));
    if (!hashEquals(expect, b.vnp_SecureHash)) return apiReply(res, b, cmd, '97', 'Checksum failed');
    return cmd === 'querydr' ? handleQuery(res, b) : handleRefund(res, b);
  }

  function handleQuery(res, b) {
    if (duplicateRequest(b.vnp_RequestId)) return apiReply(res, b, 'querydr', '94', 'Request is duplicated');
    const txn = state.transactions.get(b.vnp_TxnRef);
    // Don chua co ket qua thanh toan (chua qua cong ngan hang) coi nhu khong tim thay (bat loi, A12)
    if (!txn || !txn.responseCode) return apiReply(res, b, 'querydr', '91', 'Unable to find the requested transaction');
    const extra = {
      vnp_TmnCode: cfg.tmnCode, vnp_TxnRef: txn.txnRef, vnp_Amount: String(txn.amount * 100), vnp_BankCode: txn.bankCode,
      vnp_PayDate: txn.payDate, vnp_TransactionNo: txn.transactionNo, vnp_TransactionType: '01',
      vnp_TransactionStatus: txn.transactionStatus, vnp_OrderInfo: txn.orderInfo, vnp_PromotionCode: '', vnp_PromotionAmount: '',
    };
    return apiReply(res, b, 'querydr', '00', 'QueryDR Success', extra, 'querydrRes');
  }

  function handleRefund(res, b) {
    const reply = (code, msg, txn, rf) => {
      const extra = txn ? {
        vnp_TmnCode: cfg.tmnCode, vnp_TxnRef: txn.txnRef, vnp_Amount: String((rf ? rf.amount : txn.amount) * 100), vnp_BankCode: txn.bankCode,
        vnp_PayDate: txn.payDate, vnp_TransactionNo: txn.transactionNo, vnp_TransactionType: rf ? rf.type : b.vnp_TransactionType,
        vnp_TransactionStatus: rf ? '05' : '', vnp_OrderInfo: b.vnp_OrderInfo,
      } : { vnp_TmnCode: cfg.tmnCode, vnp_TxnRef: b.vnp_TxnRef };
      return apiReply(res, b, 'refund', code, msg, extra, 'refundRes');
    };
    if (duplicateRequest(b.vnp_RequestId)) return reply('94', 'Request is duplicated');
    const txn = state.transactions.get(b.vnp_TxnRef);
    if (!txn || !txn.responseCode) return reply('91', 'Unable to find the requested transaction');
    if (txn.status !== 'paid') return reply('95', 'Original transaction was not successful', txn);
    const active = txn.refunds.filter((r) => r.status !== 'rejected');
    if (txn.refunds.some((r) => r.status === 'processing')) return reply('94', 'Refund request is being processed', txn);
    const type = String(b.vnp_TransactionType);
    const amount = Number(b.vnp_Amount) / 100;
    if (!['02', '03'].includes(type)) return reply('99', 'Unknown error', txn);
    if (type === '02' && active.length > 0) return reply('04', 'Cannot full refund after partial refund', txn);
    const refunded = active.reduce((s, r) => s + r.amount, 0);
    // Ma loi khi hoan qua so tien: tai lieu mau thuan (02 hay 93); chon 93 theo spec S-006 (A14, unverified)
    if (!Number.isInteger(amount) || amount <= 0 || (type === '02' && amount !== txn.amount) || amount > txn.amount - refunded) {
      return reply('93', 'Invalid refund amount', txn);
    }
    const sc = scenarioFor(txn.txnRef);
    const rf = { requestId: b.vnp_RequestId, type, amount, status: 'processing', createdAt: clock.now() };
    txn.refunds.push(rf);
    const delay = Number(sc.refund_delay_seconds ?? cfg.refund.delaySeconds);
    const outcome = sc.refund_outcome || cfg.refund.outcome;
    // Hoan tien bat dong bo: 05 (dang xu ly) roi ket qua cuoi sau 'delay' giay ao (vong doi chua xac minh, A14)
    clock.schedule(clock.now() + delay * 1000, async () => { rf.status = outcome === 'reject' ? 'rejected' : 'succeeded'; rf.resolvedAt = clock.now(); });
    return reply('00', 'Refund Success', txn, rf);
  }

  // ----- Trang thanh toan (VNPS-S-003) -----
  function payPageHtml(txn) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>VNPay Simulator</title></head><body>
<h2>VNPay Simulator (sandbox gia lap)</h2>
<p>Ma don: <b>${esc(txn.txnRef)}</b> | So tien: <b>${txn.amount}</b> VND | ${esc(txn.orderInfo)}</p>
<p>Chi cac the trong cards.json moi dung duoc.</p>
<form method="POST" action="${esc(publicBase)}/paymentv2/pay">
<input type="hidden" name="txnRef" value="${esc(txn.txnRef)}">
<label>So the <input name="card" value="${esc(cards[0]?.number || '')}"></label>
<button name="action" value="pay">Thanh toan</button>
<button name="action" value="cancel">Huy giao dich</button>
</form></body></html>`;
  }
  const errorRedirect = (res, code) => {
    res.writeHead(302, { location: `/paymentv2/Transaction/Error.html?code=${code}` });
    res.end();
  };

  function handlePayPage(url, res) {
    const q = Object.fromEntries(url.searchParams);
    const err = validatePay(q);
    if (err) return errorRedirect(res, err);
    let txn = state.transactions.get(q.vnp_TxnRef);
    if (txn && txn.status === 'paid') return errorRedirect(res, '99'); // TxnRef da thanh toan: ma that chua ro (unverified)
    if (!txn) {
      txn = {
        txnRef: q.vnp_TxnRef, amount: Number(q.vnp_Amount) / 100, orderInfo: q.vnp_OrderInfo, returnUrl: q.vnp_ReturnUrl,
        createDate: q.vnp_CreateDate, createdAt: clock.now(), expireAt: q.vnp_ExpireDate ? parseDate(q.vnp_ExpireDate) : null,
        status: 'created', responseCode: null, transactionStatus: null, refunds: [], scenarioLog: [], ipn: null,
      };
      state.transactions.set(txn.txnRef, txn);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(payPageHtml(txn));
  }

  async function handleFormPay(raw, res) {
    const f = Object.fromEntries(new URLSearchParams(raw));
    const txn = state.transactions.get(f.txnRef);
    if (!txn) return errorRedirect(res, '99');
    const r = await customerPays(txn, f.action === 'cancel' ? { outcome: 'cancel' } : { outcome: 'card', card: f.card }, { wait: false });
    if (r.error) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end(r.error); }
    if (!r.returnUrl) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<p>Giao dich ket thuc (return_never: khong chuyen huong).</p>'); }
    res.writeHead(302, { location: r.returnUrl });
    return res.end();
  }

  // ----- Route /sim/* -----
  const publicTxn = (t) => ({
    txnRef: t.txnRef, amount: t.amount, status: t.status, responseCode: t.responseCode, transactionStatus: t.transactionStatus,
    transactionNo: t.transactionNo, payDate: t.payDate, createdAt: t.createdAt, expireAt: t.expireAt, finishedAt: t.finishedAt,
    ipn: t.ipn ? { state: t.ipn.state, attempts: t.ipn.attempts, log: t.ipn.log } : null,
    scenarioLog: t.scenarioLog, refunds: t.refunds,
  });

  async function handleSim(req, res, url, raw) {
    const p = url.pathname;
    const body = () => (raw ? JSON.parse(raw) : {});
    if (req.method === 'POST' && p === '/sim/clock/advance') {
      await clock.advance(Number(body().seconds) || 0);
      return json(res, 200, { now: clock.now(), nowGmt7: fmtDate(clock.now()) });
    }
    if (req.method === 'GET' && p === '/sim/transactions') {
      const ref = url.searchParams.get('txnRef');
      const list = [...state.transactions.values()].filter((t) => !ref || t.txnRef === ref).map(publicTxn);
      return json(res, 200, { transactions: list, ipnLog: state.ipnLog, warnings: state.warnings });
    }
    if (p === '/sim/control') {
      if (req.method === 'GET') return json(res, 200, state.control);
      const b = body();
      const target = b.scope === 'txn' ? (state.control.txn[b.txnRef] ||= {}) : state.control.global;
      if (b.scope === 'txn' && !b.txnRef) return json(res, 400, { error: 'thieu txnRef' });
      if (b.reset) for (const k of Object.keys(target)) delete target[k];
      for (const k of SCENARIO_KEYS) if (k in b) { if (b[k] === false || b[k] === null || b[k] === 0) delete target[k]; else target[k] = b[k]; }
      return json(res, 200, state.control);
    }
    if (req.method === 'POST' && p === '/sim/pay') {
      const b = body();
      const txn = state.transactions.get(b.txnRef);
      if (!txn) return json(res, 404, { error: 'txn_not_found' });
      if (!['success', 'insufficient', 'cancel', 'card'].includes(b.outcome)) return json(res, 400, { error: 'outcome khong hop le' });
      const r = await customerPays(txn, b, { wait: b.wait !== false });
      if (r.error) return json(res, r.error === 'already_paid' ? 409 : 400, { error: r.error });
      return json(res, 200, { status: txn.status, responseCode: txn.responseCode, transactionStatus: txn.transactionStatus, returnUrl: r.returnUrl });
    }
    const m = p.match(/^\/sim\/ipn\/([^/]+)\/resend$/);
    if (req.method === 'POST' && m) {
      const txn = state.transactions.get(decodeURIComponent(m[1]));
      if (!txn || !txn.responseCode) return json(res, 404, { error: 'txn_not_found_or_no_result' });
      const sc = { ...scenarioFor(txn.txnRef), ipn_drop: false, ipn_delay_seconds: 0 }; // gui lai thu cong: bo qua drop/delay
      const entry = await sendIpn(txn, 'resend', (txn.ipn?.attempts || 0), sc);
      if (entry.ok && txn.ipn) txn.ipn.state = 'done';
      return json(res, 200, entry);
    }
    return json(res, 404, { error: 'not_found' });
  }

  // ----- HTTP server -----
  function json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;
        if (req.method === 'GET' && p === '/paymentv2/vpcpay.html') return handlePayPage(url, res);
        if (req.method === 'POST' && p === '/paymentv2/pay') return await handleFormPay(raw, res);
        if (req.method === 'GET' && p === '/paymentv2/Transaction/Error.html') {
          const code = url.searchParams.get('code') || '99';
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-sim-error-code': code });
          return res.end(`<!DOCTYPE html><html><body><h3>Error code=<span id="code">${esc(code)}</span></h3><p>${esc(ERROR_MESSAGES[code] || ERROR_MESSAGES['99'])}</p></body></html>`);
        }
        if (p === '/merchant_webapi/api/transaction') return handleApi(req, res, raw);
        if (p.startsWith('/sim/')) return await handleSim(req, res, url, raw);
        return json(res, 404, { error: 'not_found' });
      } catch (e) {
        return json(res, 500, { error: String(e && e.message || e) });
      }
    });
  });

  let timer = null;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;
      publicBase = publicBase || url;
      if (!opts.clock?.frozen) timer = setInterval(() => clock.runDue(), 500).unref();
      resolve({
        port, url, clock, state, config: cfg,
        close: () => new Promise((r) => {
          if (timer) clearInterval(timer);
          server.close(() => r());
          server.closeAllConnections();
        }),
      });
    });
  });
}

module.exports = { startSimulator, signParams, canonicalQuery, phpEncode, fmtDate, parseDate };

// Chay truc tiep: node tools/sim/vnpay/server.js (doc env SIM_*)
if (require.main === module) {
  const env = process.env;
  startSimulator({
    port: Number(env.SIM_PORT || 8081),
    tmnCode: env.SIM_TMN_CODE,
    hashSecret: env.SIM_HASH_SECRET,
    ipnUrl: env.SIM_IPN_URL,
    ipnMethod: env.SIM_IPN_METHOD,
    publicBaseUrl: env.SIM_PUBLIC_BASE_URL,
  }).then((s) => {
    console.log(`VNPay simulator: ${s.url} (tmnCode=${s.config.tmnCode})`);
    s.state.warnings.forEach((w) => console.warn('CANH BAO:', w));
  });
}

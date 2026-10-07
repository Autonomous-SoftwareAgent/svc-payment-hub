'use strict';
// spec: OPAY-S-002
// spec: OPAY-S-003
// spec: OPAY-S-001 (luồng, ký, simulator), OPAY-S-002 (sổ giả định: hành vi unverified mô phỏng bất lợi, cấu hình được)
// Simulator OnePAY chạy bằng HTTP, không phụ thuộc thư viện. Định dạng theo bằng chứng (live/golden), ngữ nghĩa theo hướng bất lợi.
//   node tools/sim/onepay/server.js     (env SIM_PORT, SIM_MERCHANT, SIM_ACCESS_CODE, SIM_HASH_KEY_HEX, SIM_IPN_URL,
//                                        SIM_QUERY_USER, SIM_QUERY_PASSWORD)

const http = require('node:http');
const crypto = require('node:crypto');

const ACK = 'responsecode=1&desc=confirm-success'; // A9
const EXPIRY_MINUTES = { DOMESTIC: 30, INTERNATIONAL: 15, QR: 30 }; // A12 (docs-only)
const CONTROL_KEYS = [
  'ipn_delay_seconds', 'ipn_duplicate', 'ipn_drop', 'ipn_wrong_amount', 'ipn_bad_signature',
  'force_response_code', 'return_never', 'paid_after_expiry', 'ipn_retry_max', 'ipn_retry_interval_seconds',
];

function hmac(str, keyHex) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(str, 'utf8').digest('hex').toUpperCase();
}
function signString(params) {
  return Object.keys(params)
    .filter((k) => (k.startsWith('vpc_') || k.startsWith('user_')) && k !== 'vpc_SecureHash')
    .filter((k) => params[k] !== undefined && params[k] !== null && String(params[k]) !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}
const encodeQs = (o) => Object.keys(o).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(o[k])}`).join('&');

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startSimulator(opts = {}) {
  const merchant = opts.merchant || 'TESTSIM';
  const accessCode = opts.accessCode || 'SIMCODE1';
  const keyHex = opts.hashKeyHex || '00112233445566778899AABBCCDDEEFF';

  // Đồng hồ ảo: mọi hết hạn, delay, retry tính theo đồng hồ này.
  let nowMs = typeof opts.clock === 'number' ? opts.clock : (opts.clock && opts.clock.start) || Date.now();
  const clock = {
    now: () => nowMs,
    advance(seconds) { nowMs += seconds * 1000; return nowMs; },
  };

  const state = {
    ipnUrl: opts.ipnUrl || null,
    queryUser: opts.queryUser || null,
    queryPassword: opts.queryPassword || null,
    // A14 conflicts: merchant test không kiểm vpc_User/Password. true = kiểm (mô phỏng merchant thật, unverified).
    strictQueryCredentials: !!opts.strictQueryCredentials,
    // A10/A11 unverified: số lần retry IPN khi ack sai/lỗi, khoảng cách (giây ảo).
    controls: {
      ipn_retry_max: opts.ipnRetryMax !== undefined ? opts.ipnRetryMax : 3,
      ipn_retry_interval_seconds: opts.ipnRetryIntervalSeconds !== undefined ? opts.ipnRetryIntervalSeconds : 60,
    },
    refControls: {}, // merchTxnRef -> override
    invoices: new Map(), // merchTxnRef -> invoice
    jobs: [], // hàng đợi IPN theo đồng hồ ảo
    ipnLog: [],
  };

  const ctl = (ref, key) => {
    const per = state.refControls[ref];
    if (per && per[key] !== undefined) return per[key];
    return state.controls[key];
  };

  const expiryMs = (inv) => (EXPIRY_MINUTES[inv.product] || 30) * 60 * 1000;

  // Trạng thái hiệu lực: open quá hạn thì thành expired (mã 253). paid sau hạn vẫn là paid.
  function effective(inv) {
    if (inv.status === 'open' && clock.now() >= inv.createdAt + expiryMs(inv)) {
      inv.status = 'expired';
      inv.responseCode = '253';
      inv.finalAt = inv.createdAt + expiryMs(inv);
    }
    return inv.status;
  }

  function reportedCode(inv) {
    const forced = ctl(inv.merchTxnRef, 'force_response_code');
    if (forced !== undefined && forced !== null && forced !== '') return String(forced);
    return inv.status === 'open' ? '100' : inv.responseCode;
  }

  function resultParams(inv, { wrongAmount = false } = {}) {
    const code = reportedCode(inv);
    const amount = wrongAmount ? inv.amount + 100 * 100 : inv.amount;
    const p = {
      vpc_Version: '2',
      vpc_Command: 'pay',
      vpc_Merchant: merchant,
      vpc_Locale: inv.locale,
      vpc_MerchTxnRef: inv.merchTxnRef,
      vpc_OrderInfo: inv.orderInfo,
      vpc_Amount: String(amount),
      vpc_TxnResponseCode: code,
      vpc_Message: code === '0' ? 'Approved' : code === '99' ? 'User cancel' : code === '253' ? 'Transaction expired' : `Failed code ${code}`,
    };
    if (code === '0') { // A6: số tham số đổi theo trạng thái
      p.vpc_TransactionNo = inv.transactionNo;
      p.vpc_Card = inv.product === 'INTERNATIONAL' ? 'VC' : '970436';
      p.vpc_AdditionData = '970436';
    }
    return p;
  }

  const signed = (p) => ({ ...p, vpc_SecureHash: hmac(signString(p), keyHex) });

  // ---------- IPN ----------
  async function deliverIpn(inv, job) {
    const p = resultParams(inv, { wrongAmount: !!ctl(inv.merchTxnRef, 'ipn_wrong_amount') });
    const full = signed(p);
    if (ctl(inv.merchTxnRef, 'ipn_bad_signature')) full.vpc_SecureHash = full.vpc_SecureHash.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    const entry = { ref: inv.merchTxnRef, kind: job.kind, at: clock.now(), attempt: ++inv.ipnAttempts, status: null, body: null, acked: false };
    state.ipnLog.push(entry);
    if (!state.ipnUrl) { entry.error = 'no_ipn_url'; return entry; }
    const url = state.ipnUrl + (state.ipnUrl.includes('?') ? '&' : '?') + encodeQs(full);
    try {
      const res = await fetch(url, { method: 'GET' });
      entry.status = res.status;
      entry.body = await res.text();
      // Ack khác đúng chuỗi coi như chưa nhận (A9, A10).
      entry.acked = res.status === 200 && entry.body.trim() === ACK;
    } catch (e) {
      entry.error = String(e.message || e);
    }
    if (entry.acked) inv.ipnAcked = true;
    return entry;
  }

  function scheduleIpn(inv) {
    const ref = inv.merchTxnRef;
    if (ctl(ref, 'ipn_drop')) { inv.ipnDropped = true; return Promise.resolve(); } // IPN mất hẳn (A11)
    const delay = Number(ctl(ref, 'ipn_delay_seconds')) || 0;
    const dueAt = clock.now() + delay * 1000;
    state.jobs.push({ ref, dueAt, kind: 'initial' });
    if (ctl(ref, 'ipn_duplicate')) state.jobs.push({ ref, dueAt, kind: 'duplicate' });
    return processJobs();
  }

  let processing = Promise.resolve();
  function processJobs() {
    // Tuần tự hóa để hai lần gọi không chạy chồng.
    processing = processing.then(async () => {
      for (;;) {
        const due = state.jobs.filter((j) => j.dueAt <= clock.now()).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!due) return;
        state.jobs.splice(state.jobs.indexOf(due), 1);
        const inv = state.invoices.get(due.ref);
        if (!inv) continue;
        if (due.kind === 'retry' && inv.ipnAcked) continue;
        const entry = await deliverIpn(inv, due);
        if (!entry.acked && due.kind !== 'duplicate' && due.kind !== 'resend') {
          const max = Number(ctl(due.ref, 'ipn_retry_max')) || 0;
          const retries = (due.retryNo || 0) + 1;
          if (retries <= max) {
            const interval = Number(ctl(due.ref, 'ipn_retry_interval_seconds')) || 60;
            state.jobs.push({ ref: due.ref, dueAt: due.dueAt + interval * 1000, kind: 'retry', retryNo: retries });
          }
        }
      }
    });
    return processing;
  }

  // ---------- helpers HTTP ----------
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json' });
  const redirect = (res, location) => send(res, 302, '', { location });
  const errorPage = (origin, name, p) =>
    `${origin}/paygate/payment-error?error_name=${name}&locale=vi&merchant_name=&order_info=${encodeURIComponent(p.vpc_OrderInfo || '')}&merch_txn_ref=${encodeURIComponent(p.vpc_MerchTxnRef || '')}`;

  const REQUIRED = ['vpc_Version', 'vpc_Command', 'vpc_Merchant', 'vpc_AccessCode', 'vpc_MerchTxnRef', 'vpc_OrderInfo', 'vpc_Amount', 'vpc_ReturnURL', 'vpc_Locale'];

  function handleCreate(req, res, url, origin) {
    const p = Object.fromEntries(url.searchParams);
    const bad = (name) => redirect(res, errorPage(origin, name, p));
    // A18: sai chữ ký, merchant lạ, AccessCode sai: cùng một trang INVALID_INVOICE, không phân biệt nguyên nhân.
    // A2: so hash không phân biệt hoa thường.
    const given = String(p.vpc_SecureHash || '').toUpperCase();
    if (!given || given !== hmac(signString(p), keyHex) || p.vpc_Merchant !== merchant || p.vpc_AccessCode !== accessCode) return bad('INVALID_INVOICE');
    // Thứ tự kiểm tra (hash trước, trường sau) là giả định (unverified).
    for (const k of REQUIRED) if (!p[k]) return bad('VALIDATION_ERROR');
    if (p.vpc_Command !== 'pay' || !/^[1-9]\d*$/.test(p.vpc_Amount) || p.vpc_MerchTxnRef.length > 40 || p.vpc_OrderInfo.length > 34) return bad('VALIDATION_ERROR');
    const ref = p.vpc_MerchTxnRef;
    const existing = state.invoices.get(ref);
    if (existing) {
      // A17: cùng tham số -> invoice cũ; đổi amount hoặc OrderInfo -> INVALID_INVOICE (chỉ kiểm khi chưa trả).
      // Sau khi đã có kết quả cuối: unverified, chọn bảo thủ là INVALID_INVOICE.
      if (effective(existing) !== 'open') return bad('INVALID_INVOICE');
      if (existing.amount !== Number(p.vpc_Amount) || existing.orderInfo !== p.vpc_OrderInfo) return bad('INVALID_INVOICE');
      return redirect(res, `${origin}/paygate/generalv2/?id=${existing.id}&locale=vi`);
    }
    const cardList = String(p.vpc_CardList || 'DOMESTIC').toUpperCase();
    const inv = {
      id: `INV-${crypto.randomBytes(16).toString('base64url')}`,
      merchTxnRef: ref,
      orderInfo: p.vpc_OrderInfo,
      amount: Number(p.vpc_Amount),
      returnUrl: p.vpc_ReturnURL,
      locale: p.vpc_Locale,
      product: EXPIRY_MINUTES[cardList] ? cardList : 'DOMESTIC', // mã BIN coi như nội địa
      createdAt: clock.now(),
      status: 'open',
      responseCode: null,
      transactionNo: null,
      ipnAttempts: 0,
      ipnAcked: false,
      paidAfterExpiry: false,
    };
    state.invoices.set(ref, inv);
    return redirect(res, `${origin}/paygate/generalv2/?id=${inv.id}&locale=vi`);
  }

  async function handleQuery(req, res) {
    const unauthorized = () => json(res, 401, { name: 'UNAUTHORIZED', message: 'Unauthorized', information_link: '', details: 'Unauthorized' });
    if (req.method !== 'POST') return send(res, 405, '');
    if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return send(res, 415, '');
    const q = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const given = String(q.vpc_SecureHash || '').toUpperCase();
    if (!given || given !== hmac(signString(q), keyHex) || q.vpc_Merchant !== merchant || q.vpc_AccessCode !== accessCode) return unauthorized();
    if (state.strictQueryCredentials && (q.vpc_User !== state.queryUser || q.vpc_Password !== state.queryPassword)) return unauthorized();
    const out = { vpc_Command: 'queryDR', vpc_MerchTxnRef: q.vpc_MerchTxnRef || '', vpc_Merchant: merchant, vpc_Version: q.vpc_Version || '1' };
    const inv = state.invoices.get(q.vpc_MerchTxnRef);
    if (!inv) {
      Object.assign(out, { vpc_DRExists: 'N', vpc_TxnResponseCode: '5' });
    } else {
      effective(inv);
      const code = reportedCode(inv);
      out.vpc_DRExists = 'Y';
      out.vpc_TxnResponseCode = code;
      if (code === '100') {
        out.vpc_Message = 'Txn is processing'; // probe live: không có Amount/OrderInfo
      } else {
        out.vpc_Message = code === '0' ? 'Approved' : `Result code ${code}`;
        out.vpc_OrderInfo = inv.orderInfo;
        out.vpc_Amount = String(inv.amount);
        if (code === '0') out.vpc_TransactionNo = inv.transactionNo;
      }
    }
    const body = encodeQs(signed(out));
    return send(res, 200, body, { 'content-type': 'text/html' });
  }

  async function handleSim(req, res, url) {
    const path = url.pathname;
    let data = {};
    if (req.method === 'POST') {
      const raw = await readBody(req);
      try { data = raw ? JSON.parse(raw) : {}; } catch (_e) { return json(res, 400, { error: 'bad_json' }); }
    }
    if (req.method === 'POST' && path === '/sim/clock/advance') {
      clock.advance(Number(data.seconds) || 0);
      await processJobs();
      for (const inv of state.invoices.values()) effective(inv);
      return json(res, 200, { now: clock.now(), pendingJobs: state.jobs.length });
    }
    if (req.method === 'GET' && path === '/sim/transactions') {
      const list = [...state.invoices.values()].map((inv) => {
        effective(inv);
        return { ...inv, code: reportedCode(inv), ipnLog: state.ipnLog.filter((l) => l.ref === inv.merchTxnRef) };
      });
      return json(res, 200, { now: clock.now(), transactions: list });
    }
    if (req.method === 'POST' && path === '/sim/control') {
      const target = data.merchTxnRef ? (state.refControls[data.merchTxnRef] = state.refControls[data.merchTxnRef] || {}) : state.controls;
      if (data.reset) for (const k of Object.keys(target)) delete target[k];
      for (const k of CONTROL_KEYS) if (k in data) target[k] = data[k];
      return json(res, 200, { controls: state.controls, refControls: state.refControls });
    }
    if (req.method === 'POST' && path === '/sim/pay') {
      const inv = state.invoices.get(data.merchTxnRef);
      if (!inv) return json(res, 404, { error: 'unknown_invoice' });
      const st = effective(inv);
      const outcome = data.outcome;
      if (!['success', 'failed', 'cancel'].includes(outcome)) return json(res, 400, { error: 'bad_outcome' });
      if (st === 'expired' && outcome === 'success' && ctl(inv.merchTxnRef, 'paid_after_expiry')) {
        // Tiền về muộn (A12 unverified): vẫn thành công sau hết hạn.
        inv.paidAfterExpiry = true;
      } else if (st !== 'open') {
        return json(res, st === 'expired' ? 410 : 409, { error: st === 'expired' ? 'invoice_expired' : 'invoice_closed', status: st });
      }
      if (outcome === 'success') {
        inv.status = 'paid';
        inv.responseCode = '0';
        inv.transactionNo = String(1000000 + state.invoices.size * 7 + Math.floor(Math.random() * 1000));
      } else if (outcome === 'failed') {
        inv.status = 'failed';
        inv.responseCode = '1';
      } else {
        inv.status = 'cancelled';
        inv.responseCode = '99';
      }
      inv.finalAt = clock.now();
      let returnUrl = null;
      if (!ctl(inv.merchTxnRef, 'return_never')) {
        const rp = signed(resultParams(inv));
        returnUrl = inv.returnUrl + (inv.returnUrl.includes('?') ? '&' : '?') + encodeQs(rp);
      }
      await scheduleIpn(inv);
      return json(res, 200, { status: inv.status, code: inv.responseCode, returnUrl, paidAfterExpiry: inv.paidAfterExpiry });
    }
    const m = /^\/sim\/ipn\/([^/]+)\/resend$/.exec(path);
    if (req.method === 'POST' && m) {
      const inv = state.invoices.get(decodeURIComponent(m[1]));
      if (!inv) return json(res, 404, { error: 'unknown_invoice' });
      if (effective(inv) === 'open') return json(res, 409, { error: 'no_result_yet' });
      const entry = await deliverIpn(inv, { kind: 'resend' });
      return json(res, 200, entry);
    }
    return json(res, 404, { error: 'not_found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host}`;
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (path === '/paygate/vpcpay.op') return req.method === 'GET' ? handleCreate(req, res, url, origin) : send(res, 405, '');
      if (path === '/msp/api/v1/vpc/invoices/queries') return await handleQuery(req, res);
      if (path.startsWith('/sim/')) return await handleSim(req, res, url);
      if (path.startsWith('/paygate/generalv2')) {
        const inv = [...state.invoices.values()].find((i) => i.id === url.searchParams.get('id'));
        if (!inv) return send(res, 404, 'not found');
        return send(res, 200, `<html><body><h1>OnePAY sim</h1><p>${inv.merchTxnRef} - ${inv.amount / 100} VND (${inv.product})</p></body></html>`, { 'content-type': 'text/html' });
      }
      if (path === '/paygate/payment-error') {
        return send(res, 200, `<html><body><h1>Error</h1><p>${url.searchParams.get('error_name')}</p></body></html>`, { 'content-type': 'text/html' });
      }
      return send(res, 404, 'not found');
    } catch (e) {
      return send(res, 500, String(e && e.message));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        clock,
        state,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { startSimulator, signString, hmac };

if (require.main === module) {
  const e = process.env;
  startSimulator({
    port: Number(e.SIM_PORT) || 8089,
    merchant: e.SIM_MERCHANT,
    accessCode: e.SIM_ACCESS_CODE,
    hashKeyHex: e.SIM_HASH_KEY_HEX,
    ipnUrl: e.SIM_IPN_URL,
    queryUser: e.SIM_QUERY_USER,
    queryPassword: e.SIM_QUERY_PASSWORD,
  }).then((s) => console.log(`OnePAY simulator at ${s.url}`));
}

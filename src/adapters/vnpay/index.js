'use strict';
// spec: VNPS-S-001
// spec: VNPS-S-003
// spec: VNPS-S-005
// spec: VNPS-S-007
// spec: VNPS-S-010
// spec: VNPS-S-002
// spec: VNPS-S-004
// spec: VNPS-S-006
// spec: PHUB-S-020
// spec: PHUB-S-022
// spec: PHUB-S-023
// spec: PHUB-S-029
// Adapter VNPay cho Payment Hub. Noi duy nhat biet format, chu ky, ma loi cua VNPay.
const crypto = require('node:crypto');
const signing = require('./signing');
const { createFailCodeMapper } = require('../fail-codes');

const GATEWAY = 'vnpay';
const TZ_MS = 7 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(ms) {
  const d = new Date(ms + TZ_MS);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{14}$/.test(s)) return NaN;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) - TZ_MS;
}

// OrderInfo: khong dau, chi ky tu an toan (probe: dau/ky tu dac biet bi tu choi)
function sanitizeOrderInfo(s) {
  return String(s || 'Thanh toan').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ,.:_-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 255) || 'Thanh toan';
}

// ack(outcome) -> JSON {RspCode, Message} theo bang 00/01/02/04/97/99 (VNPS-S-005)
const ACKS = {
  ok: ['00', 'Confirm Success'],
  duplicate: ['02', 'Order already confirmed'],
  unknown_attempt: ['01', 'Order not found'],
  amount_mismatch: ['04', 'Invalid amount'],
  invalid_signature: ['97', 'Invalid signature'],
  error: ['99', 'Unknown error'],
};
function ack(outcome) {
  const [RspCode, Message] = ACKS[outcome] || ACKS.error;
  return { status: 200, body: JSON.stringify({ RspCode, Message }), contentType: 'application/json' };
}

// Chuan hoa vnp_Amount (VND x 100) -> VND nguyen; null neu khong hop le
function parseAmount(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (!/^\d+$/.test(String(v))) return null;
  const n = Number(v);
  if (n % 100 !== 0 || !Number.isSafeInteger(n)) return null;
  return n / 100;
}

// Ma ket qua thanh toan (vnp_ResponseCode) -> ly do that bai chuan (PHUB-D-020). Nguon: bang ma ket qua chinh thuc
// https://sandbox.vnpayment.vn/apis/docs/bang-ma-loi/ (tai 2026-10-03). 99 (loi khac) va ma la -> unknown. Chi anh huong ly do, khong anh huong co tien hay khong.
// 07 ("Tru tien thanh cong. Giao dich bi nghi ngo") KHONG co o day: tien co the da bi tru nen khong phai that bai, mapResult tra pending.
const FAIL_CODES = {
  '09': 'declined', '10': 'declined', '11': 'expired', '12': 'declined', '13': 'declined',
  '24': 'user_cancelled', '51': 'insufficient_funds', '65': 'declined', '75': 'gateway_error', '79': 'declined',
};
const FINAL_FAIL = ['failed', 'cancelled', 'expired'];

// Map ma VNPay -> loai su kien chuan (A3: thanh cong = ResponseCode 00 VA TransactionStatus 00).
// Khong ro, thieu truong, hoac mau thuan (co the da mat tien) -> pending, khong bao gio failed.
function mapResult(rc, ts) {
  if (rc === '00' && ts === '00') return 'succeeded';
  if (!rc || !ts) return 'pending';
  if (ts === '00' || ts === '04' || ts === '01') return 'pending'; // 04: giao dich dao, khach co the da bi tru tien
  if (rc === '07' || ts === '07') return 'pending'; // 07: da tru tien nhung giao dich bi nghi ngo (chua ro ket qua cuoi), khong bao gio failed
  if (rc === '00') return 'pending';
  if (rc === '24') return 'cancelled';
  if (rc === '11') return 'expired';
  return 'failed';
}

function createVnpayAdapter(config, deps = {}) {
  if (!config || !config.tmnCode || !config.hashSecret) throw new Error('vnpay: thieu tmnCode/hashSecret');
  const baseUrl = String(config.baseUrl || 'https://sandbox.vnpayment.vn').replace(/\/+$/, '');
  const fetchFn = deps.fetch || globalThis.fetch;
  const clock = deps.clock || { now: () => Date.now() };
  const timeoutMs = config.timeoutMs || 15000;
  const defaultExpireMinutes = config.defaultExpireMinutes || 15;
  const serverIp = config.serverIp || '127.0.0.1';
  const secret = config.hashSecret;
  const createDates = new Map(); // attemptRef -> vnp_CreateDate (querydr can TransactionDate; hop dong thieu, xem bao cao)
  const refundStates = new Map(); // refundRef -> trang thai cuoi cung biet (chi trong bo nho)
  const failCode = createFailCodeMapper('vnpay', FAIL_CODES, config.failCodeMap);

  // Tra cho Hub: nang luc + muc bang chung (VNPS-D-010). Cac co unverified duoc giu bao thu.
  function capabilities() {
    return {
      hardExpiry: 'unknown', // A13 unverified: tien co the ve sau het han
      cancellable: false, // khong co API huy
      queryable: true, // querydr (documented)
      refundable: 'api',
      refundAsync: true, // A14: conflicts + unverified, gia dinh bat dong bo
      createCanTimeout: false, // dung URL tai cho, khong goi mang
      currencies: ['VND'], regions: ['VN'], methods: ['card_domestic', 'qr'], // trang thanh toan VNPay: the ATM noi dia va VNPAY-QR (theo tai lieu, chua kiem voi cong that); the quoc te can hop dong rieng: them bang hub.gateways[].methods
      evidence: { hardExpiry: 'unverified', queryable: 'documented', refundable: 'conflicts+unverified', refundAsync: 'unverified', cancellable: 'documented' },
    };
  }

  async function createPayment(p) {
    const now = clock.now();
    if (!Number.isInteger(p.amount) || p.amount < 5000) return { status: 'rejected', reason: 'amount phai la so nguyen VND >= 5000', failCode: 'invalid_request' };
    if (p.currency && p.currency !== 'VND') return { status: 'rejected', reason: 'chi ho tro VND', failCode: 'invalid_request' };
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(p.attemptRef || '')) return { status: 'rejected', reason: 'attemptRef khong hop le (1-100, A-Za-z0-9_.-)', failCode: 'invalid_request' };
    if (!p.returnUrl || p.returnUrl.length < 10) return { status: 'rejected', reason: 'returnUrl khong hop le', failCode: 'invalid_request' };
    const expireMs = p.expiresAt != null ? p.expiresAt : now + defaultExpireMinutes * 60e3;
    if (expireMs <= now) return { status: 'rejected', reason: 'expiresAt da qua', failCode: 'invalid_request' };
    const expireDate = fmtDate(expireMs);
    const createDate = fmtDate(now);
    const params = {
      vnp_Version: '2.1.0', vnp_Command: 'pay', vnp_TmnCode: config.tmnCode,
      vnp_Amount: String(p.amount * 100), vnp_CreateDate: createDate, vnp_CurrCode: 'VND',
      vnp_IpAddr: p.clientIp || '127.0.0.1', vnp_Locale: 'vn', vnp_OrderInfo: sanitizeOrderInfo(p.orderInfo),
      vnp_OrderType: 'other', vnp_ReturnUrl: p.returnUrl, vnp_TxnRef: p.attemptRef, vnp_ExpireDate: expireDate,
    };
    const hash = signing.sign(secret, params);
    createDates.set(p.attemptRef, createDate);
    const url = `${baseUrl}/paymentv2/vpcpay.html?${signing.canonicalQuery(params)}&vnp_SecureHash=${hash}`;
    return { status: 'redirect', url, expiresAt: parseDate(expireDate) };
  }

  // Gop tham so tu query + body (IPN POST co the la object JSON hoac chuoi urlencoded)
  function collectParams(req) {
    let params = { ...(req.query || {}) };
    let body = req.body;
    if (typeof body === 'string' && body) body = Object.fromEntries(new URLSearchParams(body));
    if (body && typeof body === 'object') params = { ...params, ...body };
    return params;
  }

  function parseCallback(req) {
    const source = req.channel === 'return' ? 'return' : 'ipn';
    const params = collectParams(req);
    if (!signing.verify(secret, params)) return { valid: false, reason: 'invalid_signature', ack };
    const amount = parseAmount(params.vnp_Amount);
    if (!params.vnp_TxnRef || amount === null) return { valid: false, reason: 'malformed', ack };
    const rc = params.vnp_ResponseCode, ts = params.vnp_TransactionStatus;
    const payDate = parseDate(params.vnp_PayDate);
    const txnNo = params.vnp_TransactionNo;
    const event = {
      gateway: GATEWAY, attemptRef: params.vnp_TxnRef, type: mapResult(rc, ts), amount,
      occurredAt: Number.isNaN(payDate) ? clock.now() : payDate, source,
      raw: { vnp_ResponseCode: rc, vnp_TransactionStatus: ts },
    };
    if (txnNo && txnNo !== '0') event.gatewayTxnId = txnNo;
    if (FINAL_FAIL.includes(event.type)) { event.failCode = failCode(rc); if (rc) event.gatewayCode = String(rc); }
    return { valid: true, event, ack };
  }

  // Goi API querydr/refund (POST JSON). Loi mang, timeout, khong JSON -> null (khong ro)
  async function callApi(body) {
    try {
      const res = await fetchFn(`${baseUrl}/merchant_webapi/api/transaction`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) return null;
      return await res.json();
    } catch (e) { return null; }
  }
  const requestId = () => crypto.randomUUID().replace(/-/g, '');

  async function query(p) {
    const now = clock.now();
    const req = {
      vnp_RequestId: requestId(), vnp_Version: '2.1.0', vnp_Command: 'querydr', vnp_TmnCode: config.tmnCode,
      vnp_TxnRef: p.attemptRef, vnp_OrderInfo: sanitizeOrderInfo('Truy van GD ma:' + p.attemptRef),
      vnp_TransactionDate: p.createdAt ? fmtDate(p.createdAt) : (createDates.get(p.attemptRef) || fmtDate(now)),
      vnp_CreateDate: fmtDate(now), vnp_IpAddr: serverIp,
    };
    req.vnp_SecureHash = signing.signPipe(secret, 'querydrReq', req);
    const r = await callApi(req);
    if (!r) return { state: 'unknown' };
    if (r.vnp_ResponseCode === '91') return { state: 'not_found' }; // khong bao gio coi la failed/expired chac chan
    if (r.vnp_ResponseCode !== '00') return { state: 'unknown' }; // 02, 94, 97, 99...
    if (!signing.verifyPipe(secret, 'querydrRes', r)) return { state: 'unknown' };
    const amount = parseAmount(r.vnp_Amount);
    if (r.vnp_TxnRef !== p.attemptRef || amount === null || (r.vnp_TransactionType && r.vnp_TransactionType !== '01')) return { state: 'unknown' };
    const ts = r.vnp_TransactionStatus;
    // querydr chi co TransactionStatus: 00 thanh cong, 02 loi; moi gia tri khac (01, 04, 07...) -> pending
    const type = ts === '00' ? 'succeeded' : ts === '02' ? 'failed' : 'pending';
    const payDate = parseDate(r.vnp_PayDate);
    const ev = { gateway: GATEWAY, attemptRef: p.attemptRef, type, amount, occurredAt: Number.isNaN(payDate) ? now : payDate, source: 'query', raw: { vnp_TransactionStatus: ts } };
    if (r.vnp_TransactionNo && r.vnp_TransactionNo !== '0') ev.gatewayTxnId = r.vnp_TransactionNo;
    if (FINAL_FAIL.includes(ev.type)) { ev.failCode = 'unknown'; ev.gatewayCode = `ts:${ts}`; } // querydr chi co TransactionStatus, khong co ma ket qua
    return ev;
  }

  // Hoan tien: vong doi 05/06/09 chua xac minh (A14) nen ket qua bao thu
  async function refund(p) {
    const now = clock.now();
    if (!Number.isInteger(p.amount) || p.amount <= 0) return { status: 'failed' };
    const rid = /^[A-Za-z0-9]{1,32}$/.test(p.refundRef) ? p.refundRef : crypto.createHash('sha1').update(String(p.refundRef)).digest('hex').slice(0, 32);
    const req = {
      vnp_RequestId: rid, vnp_Version: '2.1.0', vnp_Command: 'refund', vnp_TmnCode: config.tmnCode,
      // 02 toan phan chi khi biet so tien goc; khong biet thi 03 (hop dong thieu originalAmount)
      vnp_TransactionType: p.originalAmount === p.amount ? '02' : '03', vnp_TxnRef: p.attemptRef, vnp_Amount: String(p.amount * 100),
      vnp_TransactionNo: p.gatewayTxnId || '', vnp_TransactionDate: p.createdAt ? fmtDate(p.createdAt) : (createDates.get(p.attemptRef) || fmtDate(now)),
      vnp_CreateBy: config.refundCreateBy || 'bsn-hub', vnp_CreateDate: fmtDate(now), vnp_IpAddr: serverIp,
      vnp_OrderInfo: sanitizeOrderInfo('Hoan tien ' + p.attemptRef),
    };
    req.vnp_SecureHash = signing.signPipe(secret, 'refundReq', req);
    const r = await callApi(req);
    let status = 'manual_required'; // khong ro (mang, 02, 97, 99...): nguoi van hanh kiem tra o portal
    if (r) {
      const rc = r.vnp_ResponseCode;
      if (rc === '00' && signing.verifyPipe(secret, 'refundRes', r)) {
        const ts = r.vnp_TransactionStatus;
        status = ts === '00' ? 'succeeded' : (ts === '05' || ts === '06') ? 'processing' : 'requested';
      } else if (['04', '13', '91', '93', '95'].includes(rc)) status = 'failed'; // tu choi chac chan
      else if (rc === '94') status = 'processing'; // da gui truoc do
    }
    refundStates.set(p.refundRef, status);
    return { status };
  }

  // Khong biet API truy van hoan tien (A14): tra trang thai da biet cuoi cung, mac dinh manual_required
  async function queryRefund(p) {
    const s = refundStates.get(p.refundRef);
    return { status: s && s !== 'processing' && s !== 'requested' ? s : 'manual_required' };
  }

  return { id: GATEWAY, capabilities, createPayment, parseCallback, query, refund, queryRefund };
}

// Khai báo cho registry (PHUB-D-023): thêm cổng = thêm thư mục có khai báo này, không sửa tệp nào đang có.
const adapter = { id: 'vnpay', create: (config, deps) => createVnpayAdapter(config, deps) };

module.exports = { adapter, createVnpayAdapter, mapResult, ack };

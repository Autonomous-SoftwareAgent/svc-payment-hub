'use strict';
// spec: VNPS-S-001
// spec: VNPS-S-003
// spec: VNPS-S-004
// spec: VNPS-S-005
// spec: VNPS-S-006
// spec: VNPS-S-007
// spec: VNPS-S-010
// spec: VNPS-S-002, VNPS-S-006
// Ky/kiem chu ky VNPay (HMAC-SHA512). Bang chung: sample chinh thuc + golden vector settlebook (VNPS-D-009 A1).
const crypto = require('node:crypto');

// urlencode kieu PHP: khoang trang -> '+', ma hoa ca ! ' ( ) * ~
function phpEncode(s) {
  return encodeURIComponent(String(s)).replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const HASH_KEYS = new Set(['vnp_SecureHash', 'vnp_SecureHashType']);

// Chuoi canonical: chi tham so vnp_*, bo hash, bo gia tri rong, sap xep tang dan theo ten
function canonicalQuery(params) {
  return Object.keys(params)
    .filter((k) => k.startsWith('vnp_') && !HASH_KEYS.has(k))
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${phpEncode(k)}=${phpEncode(params[k])}`)
    .join('&');
}

const hmac512 = (secret, data) => crypto.createHmac('sha512', secret).update(data, 'utf8').digest('hex');

function sign(secret, params) {
  return hmac512(secret, canonicalQuery(params));
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a).toLowerCase());
  const y = Buffer.from(String(b).toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verify(secret, params) {
  const h = params.vnp_SecureHash;
  if (!h) return false;
  return safeEqualHex(sign(secret, params), h);
}

// API querydr/refund: chuoi noi bang '|' theo thu tu tai lieu (thieu -> chuoi rong)
const FIELDS = {
  querydrReq: ['RequestId', 'Version', 'Command', 'TmnCode', 'TxnRef', 'TransactionDate', 'CreateDate', 'IpAddr', 'OrderInfo'],
  querydrRes: ['ResponseId', 'Command', 'ResponseCode', 'Message', 'TmnCode', 'TxnRef', 'Amount', 'BankCode', 'PayDate', 'TransactionNo', 'TransactionType', 'TransactionStatus', 'OrderInfo', 'PromotionCode', 'PromotionAmount'],
  refundReq: ['RequestId', 'Version', 'Command', 'TmnCode', 'TransactionType', 'TxnRef', 'Amount', 'TransactionNo', 'TransactionDate', 'CreateBy', 'CreateDate', 'IpAddr', 'OrderInfo'],
  refundRes: ['ResponseId', 'Command', 'ResponseCode', 'Message', 'TmnCode', 'TxnRef', 'Amount', 'BankCode', 'PayDate', 'TransactionNo', 'TransactionType', 'TransactionStatus', 'OrderInfo'],
};

function pipeData(kind, obj) {
  return FIELDS[kind].map((f) => {
    const v = obj['vnp_' + f];
    return v === undefined || v === null ? '' : String(v);
  }).join('|');
}
const signPipe = (secret, kind, obj) => hmac512(secret, pipeData(kind, obj));
const verifyPipe = (secret, kind, obj) => !!obj.vnp_SecureHash && safeEqualHex(signPipe(secret, kind, obj), obj.vnp_SecureHash);

module.exports = { phpEncode, canonicalQuery, sign, verify, signPipe, verifyPipe, pipeData };

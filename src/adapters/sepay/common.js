'use strict';
// spec: SEPY-S-001
// spec: SEPY-S-004
// spec: SEPY-S-005
// Tiện ích dùng chung cho ba sản phẩm SePay (không chứa luật của riêng sản phẩm nào).
const crypto = require('node:crypto');

const ok = { status: 200, body: '{"success":true}', contentType: 'application/json' };

function ackResponse(outcome) {
  // Mọi outcome đã ghi nhận (kể cả unknown_attempt, amount_mismatch): tiền đã vào, từ chối chỉ gây retry vô ích.
  if (outcome === 'invalid_signature') return { status: 401, body: '{"success":false}', contentType: 'application/json' };
  if (outcome === 'error') return { status: 500, body: '{"success":false}', contentType: 'application/json' };
  return { ...ok };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  // so sánh hằng thời gian: đệm về cùng độ dài trước khi so, rồi mới xét độ dài
  const len = Math.max(x.length, y.length, 1);
  const px = Buffer.alloc(len); const py = Buffer.alloc(len);
  x.copy(px); y.copy(py);
  return crypto.timingSafeEqual(px, py) && x.length === y.length;
}

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

// "YYYY-MM-DD HH:mm:ss" giờ VN -> ms epoch (A6)
function parseVnDate(s) {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(s.trim());
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}+07:00`);
}

const pad2 = (n) => String(n).padStart(2, '0');
// ms epoch -> "YYYY-MM-DD HH:mm:ss" giờ VN không offset (dạng SePay dùng cho tham số lọc ngày)
function formatVnDate(ms) {
  const d = new Date(ms + 7 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// Số tiền nguyên VND: số nguyên, chuỗi số nguyên, hoặc chuỗi thập phân có phần lẻ bằng 0 ("50000.00", dạng IPN của cổng, C2)
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return NaN;
}
function toMoney(v) {
  if (typeof v === 'string' && /^\d+\.0+$/.test(v.trim())) return Number(v.trim().split('.')[0]);
  return toInt(v);
}

// Client HTTP mỏng cho API của SePay. Trả {status, json, text} hoặc {error:true} (không có token, mạng, timeout).
function makeHttp(doFetch, timeoutMs) {
  return async function request(method, url, { headers = {}, body, params } = {}) {
    try {
      let target = url;
      if (params) {
        const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        if (qs) target += `?${qs}`;
      }
      const h = { accept: 'application/json', ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await doFetch(target, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* không phải JSON */ }
      return { status: res.status, json, text };
    } catch {
      return { error: true };
    }
  };
}

module.exports = { crypto, ackResponse, safeEqual, isBlank, parseVnDate, formatVnDate, toInt, toMoney, makeHttp };

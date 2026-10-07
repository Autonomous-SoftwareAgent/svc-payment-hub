'use strict';
// spec: SEPY-S-001
// spec: SEPY-S-002
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
const { CREDS } = require('./helpers.js');

const NOW = 1790000000000;
const mk = (authMode) => createSepayAdapter({ ...CREDS, authMode }, { clock: { now: () => NOW } });
const payload = {
  id: 92704, gateway: 'MBBank', transactionDate: '2026-10-02 11:08:33', accountNumber: '0123456789', subAccount: '',
  code: 'BSNABC123', content: 'BSNABC123 chuyen tien', transferType: 'in', description: 'x', transferAmount: 150000, accumulated: 0, referenceCode: 'FT1',
};
const raw = JSON.stringify(payload);
const sigHeaders = (ts, body = raw, secret = CREDS.hmacSecret) => ({
  'x-sepay-timestamp': String(ts),
  // tính độc lập bằng crypto trong test, không dùng code của adapter
  'x-sepay-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex'),
});
const req = (headers, body = raw, rawBody = raw) => ({ channel: 'ipn', method: 'POST', query: {}, body: typeof body === 'string' ? JSON.parse(body) : body, rawBody, headers });

test('HMAC: chữ ký tính độc lập khớp adapter', () => {
  const a = mk('hmac');
  const r = a.parseCallback(req(sigHeaders(Math.floor(NOW / 1000))));
  assert.equal(r.valid, true);
  assert.equal(r.event.gatewayTxnId, 'FT1'); // referenceCode là khóa chống trùng chung hai kênh (A12)
});

test('HMAC: ký trên raw body, đổi khoảng trắng trong body thì sai', () => {
  const a = mk('hmac');
  const ts = Math.floor(NOW / 1000);
  const pretty = JSON.stringify(payload, null, 2);
  const r = a.parseCallback(req(sigHeaders(ts, raw), pretty, pretty));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'bad_signature');
});

test('HMAC: sai secret, thiếu header, thiếu rawBody đều bị từ chối', () => {
  const a = mk('hmac');
  const ts = Math.floor(NOW / 1000);
  assert.equal(a.parseCallback(req(sigHeaders(ts, raw, 'other-secret'))).valid, false);
  assert.equal(a.parseCallback(req({})).reason, 'missing_signature');
  const noRaw = { channel: 'ipn', method: 'POST', query: {}, body: payload, headers: sigHeaders(ts) };
  assert.equal(a.parseCallback(noRaw).reason, 'missing_raw_body');
});

test('HMAC: timestamp lệch quá 300s bị từ chối dù chữ ký đúng; trong dung sai thì nhận', () => {
  const a = mk('hmac');
  const now = Math.floor(NOW / 1000);
  const old = a.parseCallback(req(sigHeaders(now - 301)));
  assert.equal(old.valid, false); assert.equal(old.reason, 'timestamp_skew');
  assert.equal(a.parseCallback(req(sigHeaders(now + 301))).valid, false);
  assert.equal(a.parseCallback(req(sigHeaders(now - 299))).valid, true);
});

test('Apikey: header phải đúng nguyên chuỗi "Apikey KEY"', () => {
  const a = mk('apikey');
  assert.equal(a.parseCallback(req({ authorization: `Apikey ${CREDS.apiKey}` })).valid, true);
  assert.equal(a.parseCallback(req({ authorization: CREDS.apiKey })).valid, false);
  assert.equal(a.parseCallback(req({ authorization: `Bearer ${CREDS.apiKey}` })).valid, false);
  assert.equal(a.parseCallback(req({ authorization: 'Apikey wrong' })).valid, false);
  assert.equal(a.parseCallback(req({})).valid, false);
});

test('authMode none: không kiểm xác thực', () => {
  assert.equal(mk('none').parseCallback(req({})).valid, true);
});

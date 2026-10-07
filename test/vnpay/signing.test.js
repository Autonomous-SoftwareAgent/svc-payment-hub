'use strict';
// spec: VNPS-S-002
const test = require('node:test');
const assert = require('node:assert');
const signing = require('../../src/adapters/vnpay/signing');
const sim = require('../../tools/sim/vnpay/server.js');

const SECRET = 'test-hash-secret-not-a-real-key';
const CANON = 'vnp_Amount=15000000&vnp_Command=pay&vnp_CreateDate=20260929003000&vnp_CurrCode=VND&vnp_ExpireDate=20260929004500&vnp_IpAddr=127.0.0.1&vnp_Locale=vn&vnp_OrderInfo=Thanh+toan+don+hang+0f8fad5bd9cb469fa165708e9a2b3c4d&vnp_OrderType=other&vnp_ReturnUrl=http%3A%2F%2Flocalhost%3A8080%2Fapi%2Fvnpay%2Freturn&vnp_TmnCode=TESTTMN1&vnp_TxnRef=0f8fad5bd9cb469fa165708e9a2b3c4d&vnp_Version=2.1.0';
const HASH = 'd9c109c7c1f2b840cc10b4482983cafcb1f1db0aacb23dde0f43b3144671fe4edfc80cf39a1b28eca3c5fff827a5da461fbb6ccbb7eee230b2ebb0df2da7aaac';
const golden = () => ({
  vnp_Version: '2.1.0', vnp_Command: 'pay', vnp_TmnCode: 'TESTTMN1', vnp_Amount: '15000000', vnp_CurrCode: 'VND',
  vnp_TxnRef: '0f8fad5bd9cb469fa165708e9a2b3c4d', vnp_OrderInfo: 'Thanh toan don hang 0f8fad5bd9cb469fa165708e9a2b3c4d',
  vnp_OrderType: 'other', vnp_Locale: 'vn', vnp_ReturnUrl: 'http://localhost:8080/api/vnpay/return', vnp_IpAddr: '127.0.0.1',
  vnp_CreateDate: '20260929003000', vnp_ExpireDate: '20260929004500', vnp_BankCode: '',
});

test('adapter ky khop golden vector settlebook', () => {
  assert.strictEqual(signing.canonicalQuery(golden()), CANON);
  assert.strictEqual(signing.sign(SECRET, golden()), HASH);
});
test('simulator ky khop golden vector (cai dat doc lap)', () => {
  assert.strictEqual(sim.canonicalQuery(golden()), CANON);
  assert.strictEqual(sim.signParams(SECRET, golden()), HASH);
});
test('bo hash, gia tri rong, tham so la; hash hoa/thuong; sai thi tu choi', () => {
  const p = { ...golden(), vnp_SecureHash: HASH.toUpperCase(), vnp_SecureHashType: 'HMACSHA512', other: 'x' };
  assert.ok(signing.verify(SECRET, p));
  assert.ok(!signing.verify(SECRET, { ...p, vnp_Amount: '15000100' }));
  assert.ok(!signing.verify('khac', p));
  assert.ok(!signing.verify(SECRET, golden()));
});

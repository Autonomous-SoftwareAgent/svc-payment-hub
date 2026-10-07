'use strict';
// spec: OPAY-S-001
// 3 vector hash từ URL demo OnePAY (tái hiện từ test của vn-payments) + hash tính độc lập (không dùng code của ta).
// Key demo công khai chỉ dùng ở file này.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { signString, sign } = require('../../src/adapters/onepay/index.js');

const DOM_KEY = 'A3EFDFABA8653DF2342E8DAC29B51AF0';
const INTL_KEY = '6D0870CDE5F24F34F3915FB0045120DB';

// Tính độc lập: tự sắp, tự nối, không lọc.
const indep = (o, key) => crypto.createHmac('sha256', Buffer.from(key, 'hex'))
  .update(Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('&')).digest('hex').toUpperCase();

function vpcFromUrl(u) {
  const o = {};
  for (const [k, v] of new URL(u).searchParams) if (k.startsWith('vpc_') && k !== 'vpc_SecureHash') o[k] = v;
  return o;
}

test('golden 1: URL tạo đơn nội địa (demo OnePAY)', () => {
  const u = 'https://mtf.onepay.vn/onecomm-pay/vpc.op?Title=onepay+paygate&vpc_AccessCode=D67342C2&vpc_Amount=100&vpc_Command=pay&vpc_Currency=VND&vpc_Customer_Email=support%40onepay.vn&vpc_Customer_Id=thanhvt&vpc_Customer_Phone=840904280949&vpc_Locale=vn&vpc_MerchTxnRef=2018-01-11T14%3A46%3A11.115Z&vpc_Merchant=ONEPAY&vpc_OrderInfo=2018-01-11T14%3A46%3A11.115Z&vpc_ReturnURL=http%3A%2F%2Flocalhost%2F%7Ethanh%2Fnoidia_php%2Fdr.php&vpc_SHIP_City=Ha+Noi&vpc_SHIP_Country=Viet+Nam&vpc_SHIP_Provice=Hoan+Kiem&vpc_SHIP_Street01=39A+Ngo+Quyen&vpc_TicketNo=127.0.0.1&vpc_Version=2';
  const want = 'DDC85640D5B2D72AC46A16FBCD3E0DF7B4E05DB1818E2A0A423C2A31FAFF39E4';
  const o = vpcFromUrl(u); // Title không vào chuỗi ký (không có tiền tố vpc_)
  assert.strictEqual(sign(o, DOM_KEY), want);
  assert.strictEqual(indep(o, DOM_KEY), want);
});

test('golden 2: tham số return nội địa (demo OnePAY)', () => {
  const r = { vpc_AdditionData: '970436', vpc_Amount: '90000000', vpc_Command: 'pay', vpc_CurrencyCode: 'VND', vpc_Locale: 'vn', vpc_MerchTxnRef: 'node-2018-01-15T10:19:55.541Z', vpc_Merchant: 'ONEPAY', vpc_OrderInfo: 'node-2018-01-15T10:19:55.541Z', vpc_TransactionNo: '1617996', vpc_TxnResponseCode: '0', vpc_Version: '2' };
  const want = '8B720A26C295F225FCF57F9619562341914649C07F9C9FD359A514C2905D67C2';
  assert.strictEqual(sign(r, DOM_KEY), want);
  assert.strictEqual(indep(r, DOM_KEY), want);
  // Dùng khóa như chuỗi utf8 (không giải mã hex) thì KHÔNG ra hash này.
  const wrong = crypto.createHmac('sha256', DOM_KEY).update(signString(r)).digest('hex').toUpperCase();
  assert.notStrictEqual(wrong, want);
});

test('golden 3: URL quốc tế (demo OnePAY), AVS_*/AgainLink/Title không vào chuỗi ký, không có vpc_Currency', () => {
  const u = 'https://mtf.onepay.vn/vpcpay/vpcpay.op?AVS_City=Hanoi&AVS_Country=VN&AVS_PostCode=10000&AVS_StateProv=Hoan+Kiem&AVS_Street01=194+Tran+Quang+Khai&AgainLink=http%253A%252F%252Flocalhost%252F%257Ethanh%252Fquocte_php%252F&Title=VPC+3-Party&vpc_AccessCode=6BEB2546&vpc_Amount=1000000&vpc_Command=pay&vpc_Customer_Email=support%40onepay.vn&vpc_Customer_Id=thanhvt&vpc_Customer_Phone=840904280949&vpc_Locale=en&vpc_MerchTxnRef=2018011121565445977757&vpc_Merchant=TESTONEPAY&vpc_OrderInfo=JSECURETEST01&vpc_ReturnURL=http%3A%2F%2Flocalhost%2F%7Ethanh%2Fquocte_php%2Fdr.php&vpc_SHIP_City=Ha+Noi&vpc_SHIP_Country=Viet+Nam&vpc_SHIP_Provice=Hoan+Kiem&vpc_SHIP_Street01=39A+Ngo+Quyen&vpc_TicketNo=%3A%3A1&vpc_Version=2';
  const want = '6A1F6F957E74559083B97D38DF109E5E18292D8516785CA7E794FBB59717A654';
  const o = vpcFromUrl(u);
  assert.strictEqual(sign(o, INTL_KEY), want);
  assert.strictEqual(indep(o, INTL_KEY), want);
});

test('golden live: phản hồi QueryDR của sandbox (probe, giá trị đã giải mã) khớp công thức', () => {
  const q = { vpc_Command: 'queryDR', vpc_MerchTxnRef: 'BSNP21790915311188', vpc_Merchant: 'TESTONEPAY', vpc_Version: '1', vpc_DRExists: 'Y', vpc_TxnResponseCode: '100', vpc_Message: 'Txn is processing' };
  assert.strictEqual(sign(q, INTL_KEY), '10C4DCC51EFC3E567A2AB9F9E0AB81D51AA985E278B1448479FC079FA2DC87F6');
});

test('signString: bỏ giá trị rỗng, sắp ASCII, không encode, loại vpc_SecureHash', () => {
  const s = signString({ vpc_b: 'x y&z', vpc_a: '', vpc_SecureHash: 'ZZ', vpc_A: '1', other: 'no', user_k: '2' });
  assert.strictEqual(s, 'user_k=2&vpc_A=1&vpc_b=x y&z');
});

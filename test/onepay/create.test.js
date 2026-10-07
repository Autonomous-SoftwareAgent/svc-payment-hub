'use strict';
// spec: OPAY-S-001, OPAY-S-003
const test = require('node:test');
const assert = require('node:assert');
const { setup, open, create, CFG, KEY } = require('./helpers.js');
const { createOnepayAdapter, sign } = require('../../src/adapters/onepay/index.js');
const { assertAdapterShape } = require('../../src/contract.js');
const { hmac, signString } = require('../../tools/sim/onepay/server.js');

test('adapter đúng hình dạng contract, capabilities theo sản phẩm', () => {
  const a = createOnepayAdapter(CFG);
  assertAdapterShape(a);
  assert.strictEqual(a.cancel, undefined);
  const d = a.capabilities('DOMESTIC');
  const i = a.capabilities('INTERNATIONAL');
  assert.deepStrictEqual(d.hardExpiry, { minutes: 30 });
  assert.deepStrictEqual(i.hardExpiry, { minutes: 15 });
  for (const c of [d, i]) {
    assert.strictEqual(c.cancellable, false);
    assert.strictEqual(c.queryable, true);
    assert.strictEqual(c.refundable, 'manual');
    assert.strictEqual(c.refundAsync, true);
    assert.strictEqual(c.createCanTimeout, false);
  }
  assert.strictEqual(a.capabilities('LA').hardExpiry, 'unknown');
  assert.deepStrictEqual(a.capabilities().hardExpiry, { minutes: 30 }); // mặc định DOMESTIC
});

test('URL: baseUrl mặc định mtf.onepay.vn, amount x100, MerchTxnRef = attemptRef, CardList theo product, hash hoa và đúng', async () => {
  const a = createOnepayAdapter(CFG);
  const r = await a.createPayment({ attemptRef: 'ATT-9', amount: 150000, orderInfo: 'Don hang 9', returnUrl: 'http://h/r?x=1&y=2', product: 'INTERNATIONAL', clientIp: '1.2.3.4' });
  assert.strictEqual(r.status, 'redirect');
  const u = new URL(r.url);
  assert.strictEqual(u.origin + u.pathname, 'https://mtf.onepay.vn/paygate/vpcpay.op');
  const p = Object.fromEntries(u.searchParams);
  assert.strictEqual(p.vpc_Amount, '15000000');
  assert.strictEqual(p.vpc_MerchTxnRef, 'ATT-9');
  assert.strictEqual(p.vpc_CardList, 'INTERNATIONAL');
  assert.strictEqual(p.vpc_ReturnURL, 'http://h/r?x=1&y=2');
  assert.strictEqual(p.vpc_TicketNo, '1.2.3.4');
  assert.match(p.vpc_SecureHash, /^[0-9A-F]{64}$/);
  assert.strictEqual(p.vpc_SecureHash, sign(p, KEY));
  const d = Object.fromEntries(new URL((await a.createPayment({ attemptRef: 'A', amount: 1000, orderInfo: 'o', returnUrl: 'http://h/r' })).url).searchParams);
  assert.strictEqual(d.vpc_CardList, 'DOMESTIC');
});

test('XÁC ĐỊNH: cùng tham số cho đúng cùng URL; đổi amount thì URL đổi', async () => {
  const a = createOnepayAdapter(CFG);
  const p = { attemptRef: 'ATT-1', amount: 50000, orderInfo: 'x', returnUrl: 'http://h/r' };
  const u1 = (await a.createPayment(p)).url;
  const u2 = (await a.createPayment({ ...p })).url;
  assert.strictEqual(u1, u2);
  assert.notStrictEqual((await a.createPayment({ ...p, amount: 50001 })).url, u1);
});

test('rejected: amount lẻ/âm/0, product lạ, attemptRef quá dài, orderInfo quá dài, thiếu returnUrl, tiền tệ khác VND', async () => {
  const a = createOnepayAdapter(CFG);
  const ok = { attemptRef: 'A', amount: 1000, orderInfo: 'o', returnUrl: 'http://h/r' };
  const bads = [{ amount: 10.5 }, { amount: -1 }, { amount: 0 }, { product: 'ZZZ' }, { attemptRef: 'x'.repeat(41) }, { orderInfo: 'x'.repeat(35) }, { returnUrl: '' }, { currency: 'USD' }];
  for (const bad of bads) {
    assert.strictEqual((await a.createPayment({ ...ok, ...bad })).status, 'rejected', JSON.stringify(bad));
  }
});

test('config thiếu hoặc khóa không phải hex thì ném lỗi', () => {
  assert.throws(() => createOnepayAdapter({ merchant: 'M', accessCode: 'A' }));
  assert.throws(() => createOnepayAdapter({ ...CFG, hashKeyHex: 'not-hex' }));
});

test('simulator: URL hợp lệ -> 302 tới invoice /paygate/generalv2/?id=INV-', async () => {
  const t = await setup();
  try {
    const { r } = await create(t.adapter);
    const o = await open(r.url);
    assert.strictEqual(o.status, 302);
    assert.match(o.location, /\/paygate\/generalv2\/\?id=INV-[\w-]+&locale=vi$/);
  } finally { await t.close(); }
});

test('INVALID_INVOICE chung cho sai chữ ký, merchant lạ, AccessCode sai, amount sửa (không phân biệt nguyên nhân)', async () => {
  const t = await setup();
  try {
    const { r } = await create(t.adapter);
    const good = new URL(r.url);
    const tamper = (fn) => { const u = new URL(good); fn(u.searchParams); return u.toString(); };
    const variants = [
      tamper((s) => s.set('vpc_SecureHash', 'A'.repeat(64))), // sai chữ ký
      tamper((s) => s.set('vpc_Amount', '1')), // amount sửa mà không ký lại
    ];
    const other = createOnepayAdapter({ ...CFG, merchant: 'STRANGER', baseUrl: t.sim.url }); // merchant lạ, ký đúng
    variants.push((await other.createPayment({ attemptRef: 'ATT-2', amount: 1000, orderInfo: 'o', returnUrl: 'http://h/r' })).url);
    const wrongCode = createOnepayAdapter({ ...CFG, accessCode: 'BADCODE0', baseUrl: t.sim.url });
    variants.push((await wrongCode.createPayment({ attemptRef: 'ATT-3', amount: 1000, orderInfo: 'o', returnUrl: 'http://h/r' })).url);
    for (const v of variants) {
      const o = await open(v);
      assert.strictEqual(o.status, 302);
      assert.match(o.location, /\/paygate\/payment-error\?error_name=INVALID_INVOICE&/);
    }
    assert.strictEqual(t.sim.state.invoices.size, 0);
  } finally { await t.close(); }
});

test('VALIDATION_ERROR khi thiếu trường bắt buộc nhưng ký đúng', async () => {
  const t = await setup();
  try {
    const p = { vpc_Version: '2', vpc_Command: 'pay', vpc_Merchant: CFG.merchant, vpc_AccessCode: CFG.accessCode, vpc_MerchTxnRef: 'R1', vpc_Amount: '1000', vpc_ReturnURL: 'http://h/r', vpc_Locale: 'vn' }; // thiếu OrderInfo
    p.vpc_SecureHash = hmac(signString(p), KEY);
    const o = await open(`${t.sim.url}/paygate/vpcpay.op?${new URLSearchParams(p)}`);
    assert.match(o.location, /error_name=VALIDATION_ERROR/);
  } finally { await t.close(); }
});

test('hash chữ thường vẫn được tạo invoice (A2)', async () => {
  const t = await setup();
  try {
    const { r } = await create(t.adapter);
    const u = new URL(r.url);
    u.searchParams.set('vpc_SecureHash', u.searchParams.get('vpc_SecureHash').toLowerCase());
    assert.match((await open(u.toString())).location, /generalv2/);
  } finally { await t.close(); }
});

test('cùng merchTxnRef cùng tham số -> đúng invoice cũ; đổi amount hoặc OrderInfo -> INVALID_INVOICE', async () => {
  const t = await setup();
  try {
    const { r } = await create(t.adapter);
    const l1 = (await open(r.url)).location;
    const l2 = (await open((await create(t.adapter)).r.url)).location;
    assert.strictEqual(l1, l2);
    assert.strictEqual(t.sim.state.invoices.size, 1);
    const diffAmount = (await create(t.adapter, { amount: 200000 })).r.url;
    assert.match((await open(diffAmount)).location, /INVALID_INVOICE/);
    const diffInfo = (await create(t.adapter, { orderInfo: 'Order 2' })).r.url;
    assert.match((await open(diffInfo)).location, /INVALID_INVOICE/);
    assert.strictEqual(t.sim.state.invoices.size, 1);
  } finally { await t.close(); }
});

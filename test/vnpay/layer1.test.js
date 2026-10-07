'use strict';
// spec: VNPS-S-002, VNPS-S-001
const test = require('node:test');
const assert = require('node:assert');
const { startHarness, TMN, SECRET } = require('./helpers');
const signing = require('../../src/adapters/vnpay/signing');
const { fmtDate } = require('../../tools/sim/vnpay/server.js');

function base(h, over = {}) {
  const now = h.sim.clock.now();
  const p = {
    vnp_Version: '2.1.0', vnp_Command: 'pay', vnp_TmnCode: TMN, vnp_Amount: '1000000', vnp_CreateDate: fmtDate(now), vnp_CurrCode: 'VND',
    vnp_IpAddr: '127.0.0.1', vnp_Locale: 'vn', vnp_OrderInfo: 'Thanh toan thu', vnp_OrderType: 'other',
    vnp_ReturnUrl: 'http://localhost:3000/return', vnp_TxnRef: 'T1', vnp_ExpireDate: fmtDate(now + 900e3), ...over,
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  p.vnp_SecureHash = signing.sign(SECRET, p);
  return p;
}
const hit = async (h, p) => {
  const r = await fetch(`${h.sim.url}/paymentv2/vpcpay.html?${new URLSearchParams(p)}`, { redirect: 'manual' });
  return { status: r.status, loc: r.headers.get('location') || '' };
};

test('kiem tra tang 1: 03/72/32/15/21; tang 2: TmnCode va chu ky', async () => {
  const h = await startHarness();
  try {
    const code = async (over) => (await hit(h, base(h, over))).loc.match(/code=(\d+)/)?.[1];
    assert.strictEqual((await hit(h, base(h))).status, 200);
    assert.strictEqual(await code({ vnp_TxnRef: undefined }), '03');
    assert.strictEqual(await code({ vnp_Amount: 'abc' }), '03');
    assert.strictEqual(await code({ vnp_Version: '1.0' }), '03');
    assert.strictEqual(await code({ vnp_Amount: '0' }), '32');
    assert.strictEqual(await code({ vnp_Amount: '-100' }), '32');
    assert.strictEqual(await code({ vnp_Amount: '499900' }), '72');
    assert.strictEqual(await code({ vnp_Locale: 'xx' }), '72');
    assert.strictEqual(await code({ vnp_OrderInfo: 'Thanh toán' }), '72');
    assert.strictEqual(await code({ vnp_ReturnUrl: 'localhost' }), '72');
    assert.strictEqual(await code({ vnp_ExpireDate: '20200101000000' }), '15');
    assert.strictEqual(await code({ vnp_CurrCode: 'XYZ' }), '21');
    assert.strictEqual(await code({ vnp_CurrCode: 'USD' }), '72');
    // thieu ExpireDate khong bi chan
    assert.strictEqual((await hit(h, base(h, { vnp_ExpireDate: undefined, vnp_TxnRef: 'T2' }))).status, 200);
    // tang 2
    assert.strictEqual(await code({ vnp_TmnCode: 'OTHERTMN' }), '72');
    const bad = base(h); bad.vnp_Amount = '2000000';
    assert.strictEqual((await hit(h, bad)).loc.match(/code=(\d+)/)[1], '70');
    // gia tri rong khong anh huong chu ky
    assert.strictEqual((await hit(h, base(h, { vnp_BankCode: '', vnp_TxnRef: 'T3' }))).status, 200);
  } finally { await h.close(); }
});

test('don het han theo dong ho ao: advance 16 phut -> tra 11 du nhap the dung', async () => {
  const h = await startHarness();
  try {
    await h.create('EXP1');
    await h.sim.clock.advance(16 * 60);
    const r = await h.post('/sim/pay', { txnRef: 'EXP1', outcome: 'success' });
    assert.strictEqual(r.responseCode, '11');
    assert.strictEqual(r.status, 'expired');
  } finally { await h.close(); }
});

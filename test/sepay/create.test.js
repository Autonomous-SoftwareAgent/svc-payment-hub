'use strict';
// spec: SEPY-S-003
// spec: SEPY-S-002
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
const { assertAdapterShape } = require('../../src/contract.js');
const { CREDS, setup } = require('./helpers.js');

const adapter = createSepayAdapter({ ...CREDS, qrBaseUrl: 'https://qr.example.test/img' }, { clock: { now: () => 1 } });
const mkParams = (attemptRef, amount = 150000) => ({ attemptRef, amount, orderInfo: 'x', returnUrl: 'http://x' });

test('adapter đúng hình dạng hợp đồng, capabilities theo SEPY-D-003', () => {
  assert.equal(assertAdapterShape(adapter), true);
  assert.deepEqual(adapter.capabilities('qr-static'), {
    hardExpiry: 'none', cancellable: false, queryable: true, refundable: 'manual', refundAsync: true, createCanTimeout: false, currencies: ['VND'], regions: ['VN'], methods: ['bank_transfer'],
    referenceFormat: { prefix: 'BSN', maxLength: 30, caseInsensitive: true },
  });
  assert.equal(adapter.cancel, undefined);
});

test('createPayment trả instructions, không gọi mạng', async () => {
  let called = 0;
  const a = createSepayAdapter(CREDS, { fetch: () => { called += 1; throw new Error('no network'); } });
  const r = await a.createPayment(mkParams('bsnabc123', 150000));
  assert.equal(called, 0);
  assert.equal(r.status, 'instructions');
  const i = r.instructions;
  assert.equal(i.bank, 'MBBank'); assert.equal(i.accountNumber, '0123456789'); assert.equal(i.accountName, 'CONG TY BSN TEST');
  assert.equal(i.transferContent, 'BSNABC123'); assert.equal(i.amount, 150000);
  const u = new URL(i.qrUrl);
  assert.equal(u.origin + u.pathname, 'https://vietqr.app/img');
  assert.deepEqual(Object.fromEntries(u.searchParams), { acc: '0123456789', bank: 'MBBank', amount: '150000', des: 'BSNABC123' });
});

test('createPayment từ chối attemptRef sai định dạng và amount không hợp lệ', async () => {
  for (const ref of ['ABC123', 'BSN', 'BSN-123', 'BSN 123', 'BSNÀ1', 'BSN' + 'A'.repeat(28), '', undefined]) {
    const r = await adapter.createPayment(mkParams(ref));
    assert.equal(r.status, 'rejected', `phải từ chối ${ref}`);
  }
  assert.equal((await adapter.createPayment(mkParams('BSN' + 'A'.repeat(27)))).status, 'instructions'); // đúng 30 ký tự
  for (const amount of [0, -5, 1.5, '1000', NaN]) assert.equal((await adapter.createPayment(mkParams('BSNOK1', amount))).status, 'rejected');
});

test('refund và queryRefund báo manual_required', async () => {
  assert.deepEqual(await adapter.refund({ attemptRef: 'BSN1', refundRef: 'R1', amount: 1 }), { status: 'manual_required' });
  assert.deepEqual(await adapter.queryRefund({ refundRef: 'R1', attemptRef: 'BSN1' }), { status: 'manual_required' });
});

test('QR từ simulator: URL đúng trả image/png, thiếu tham số vẫn 200 text/html', async () => {
  const t = await setup();
  try {
    const r = await t.adapter.createPayment(mkParams('BSNQR001'));
    const ok = await fetch(r.instructions.qrUrl);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await ok.arrayBuffer());
    assert.equal(buf.subarray(1, 4).toString(), 'PNG');
    const bad = await fetch(`${t.sim.url}/img?bank=MBBank`);
    assert.equal(bad.status, 200); assert.match(bad.headers.get('content-type'), /text\/html/);
  } finally { await t.teardown(); }
});

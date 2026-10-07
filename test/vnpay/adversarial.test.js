'use strict';
// spec: VNPS-S-007, VNPS-S-005, VNPS-S-010
const test = require('node:test');
const assert = require('node:assert');
const { startHarness } = require('./helpers');
const { mapResult } = require('../../src/adapters/vnpay');

const parseIpn = (h, r) => h.adapter.parseCallback({ channel: 'ipn', method: r.method, query: r.query, body: r.body, headers: r.headers });
const rsp = (code) => ({ status: 200, body: JSON.stringify({ RspCode: code, Message: 'x' }), contentType: 'application/json' });

test('IPN trung 3 lan: nhan 3 ban giong nhau, hub idempotent theo attemptRef', async () => {
  const h = await startHarness();
  try {
    await h.post('/sim/control', { scope: 'global', ipn_duplicate: 3 });
    await h.create('D1');
    await h.post('/sim/pay', { txnRef: 'D1', outcome: 'success' });
    assert.strictEqual(h.received.length, 3);
    const evs = h.received.map((r) => parseIpn(h, r).event);
    assert.ok(evs.every((e) => e.type === 'succeeded' && e.attemptRef === 'D1' && e.gatewayTxnId === evs[0].gatewayTxnId));
    assert.ok((await h.txn('D1')).scenarioLog.some((s) => s.behavior === 'ipn_duplicate'));
  } finally { await h.close(); }
});

test('IPN bi drop: khong nhan gi, query van ra succeeded', async () => {
  const h = await startHarness();
  try {
    await h.post('/sim/control', { scope: 'txn', txnRef: 'L1', ipn_drop: true });
    await h.create('L1', { amount: 90000 });
    await h.post('/sim/pay', { txnRef: 'L1', outcome: 'success' });
    await h.sim.clock.advance(3600);
    assert.strictEqual(h.received.length, 0);
    assert.strictEqual((await h.txn('L1')).ipn.state, 'dropped');
    const ev = await h.adapter.query({ attemptRef: 'L1' });
    assert.strictEqual(ev.type, 'succeeded');
    assert.strictEqual(ev.amount, 90000);
  } finally { await h.close(); }
});

test('IPN tre 20 phut ao: chua co IPN, query dung, sau advance moi toi', async () => {
  const h = await startHarness();
  try {
    await h.post('/sim/control', { scope: 'global', ipn_delay_seconds: 1200 });
    await h.create('T1');
    await h.post('/sim/pay', { txnRef: 'T1', outcome: 'success' });
    assert.strictEqual(h.received.length, 0);
    assert.strictEqual((await h.adapter.query({ attemptRef: 'T1' })).type, 'succeeded');
    await h.sim.clock.advance(1199);
    assert.strictEqual(h.received.length, 0);
    await h.sim.clock.advance(1);
    assert.strictEqual(h.received.length, 1);
  } finally { await h.close(); }
});

test('IPN sai so tien: chu ky dung, amount khac so tien don', async () => {
  const h = await startHarness();
  try {
    await h.post('/sim/control', { scope: 'global', ipn_wrong_amount: true });
    await h.create('W1', { amount: 100000 });
    await h.post('/sim/pay', { txnRef: 'W1', outcome: 'success' });
    const cb = parseIpn(h, h.received[0]);
    assert.ok(cb.valid);
    assert.notStrictEqual(cb.event.amount, 100000);
    assert.strictEqual(cb.event.amount, 100100);
    // query (trong tai) van tra dung so tien
    assert.strictEqual((await h.adapter.query({ attemptRef: 'W1' })).amount, 100000);
  } finally { await h.close(); }
});

test('IPN sai chu ky: valid=false va ack 97', async () => {
  const h = await startHarness();
  try {
    await h.post('/sim/control', { scope: 'global', ipn_bad_signature: true });
    await h.create('B1');
    await h.post('/sim/pay', { txnRef: 'B1', outcome: 'success' });
    const cb = parseIpn(h, h.received[0]);
    assert.strictEqual(cb.valid, false);
    assert.strictEqual(cb.event, undefined);
    assert.strictEqual(JSON.parse(cb.ack('invalid_signature').body).RspCode, '97');
    assert.strictEqual(JSON.parse(h.received.length ? '{"x":1}' : '{}').x, 1);
  } finally { await h.close(); }
});

test('IPN retry khi hub tra 97: dem theo dong ho ao, roi ipn_exhausted', async () => {
  const h = await startHarness({ simOpts: { ipnRetry: { maxAttempts: 4, intervalSeconds: 300 } }, respond: () => rsp('97') });
  try {
    await h.create('RT1');
    await h.post('/sim/pay', { txnRef: 'RT1', outcome: 'success' });
    assert.strictEqual(h.received.length, 1);
    await h.sim.clock.advance(299);
    assert.strictEqual(h.received.length, 1);
    await h.sim.clock.advance(1);
    assert.strictEqual(h.received.length, 2);
    await h.sim.clock.advance(3600);
    assert.strictEqual(h.received.length, 4);
    const t = await h.txn('RT1');
    assert.strictEqual(t.ipn.state, 'ipn_exhausted');
    assert.strictEqual(t.ipn.log.length, 4);
  } finally { await h.close(); }
});

test('IPN: 00 dung sau 1 lan, 02 dung, non-JSON va HTTP 500 thi thu lai; resend thu cong', async () => {
  for (const [name, out, expectCalls] of [['00', rsp('00'), 1], ['02', rsp('02'), 1], ['non-json', { status: 200, body: 'ok', contentType: 'text/plain' }, 3], ['500', { status: 500, body: '{}', contentType: 'application/json' }, 3]]) {
    const h = await startHarness({ simOpts: { ipnRetry: { maxAttempts: 3, intervalSeconds: 60 } }, respond: () => out });
    try {
      await h.create('S1');
      await h.post('/sim/pay', { txnRef: 'S1', outcome: 'success' });
      await h.sim.clock.advance(1000);
      assert.strictEqual(h.received.length, expectCalls, name);
    } finally { await h.close(); }
  }
  const h = await startHarness({ simOpts: { ipnRetry: { maxAttempts: 1, intervalSeconds: 60 } }, respond: () => rsp('99') });
  try {
    await h.create('S2');
    await h.post('/sim/pay', { txnRef: 'S2', outcome: 'success' });
    assert.strictEqual((await h.txn('S2')).ipn.state, 'ipn_exhausted');
    const e = await h.post('/sim/ipn/S2/resend');
    assert.strictEqual(e.kind, 'resend');
    assert.strictEqual(h.received.length, 2);
  } finally { await h.close(); }
});

test('paid_after_expiry: khach tra sau han van thanh cong; sim ghi kich ban', async () => {
  const h = await startHarness();
  try {
    await h.post('/sim/control', { scope: 'global', paid_after_expiry: true });
    const c = await h.create('LATE1');
    await h.sim.clock.advance(20 * 60);
    assert.ok(h.sim.clock.now() > c.expiresAt);
    await h.post('/sim/pay', { txnRef: 'LATE1', outcome: 'success' });
    assert.strictEqual(parseIpn(h, h.received[0]).event.type, 'succeeded');
    assert.ok((await h.txn('LATE1')).scenarioLog.some((s) => s.behavior === 'paid_after_expiry'));
  } finally { await h.close(); }
});

test('return_never va force_response_code; ket qua mau thuan -> pending', async () => {
  const h = await startHarness();
  try {
    await h.post('/sim/control', { scope: 'global', return_never: true, force_response_code: '75' });
    await h.create('FR1');
    const r = await h.post('/sim/pay', { txnRef: 'FR1', outcome: 'success' });
    assert.strictEqual(r.returnUrl, null);
    assert.strictEqual(r.responseCode, '75');
    assert.strictEqual(parseIpn(h, h.received[0]).event.type, 'failed');
    // mau thuan / thieu truong khong bao gio la failed
    assert.strictEqual(mapResult('51', '00'), 'pending');
    assert.strictEqual(mapResult('00', '02'), 'pending');
    assert.strictEqual(mapResult('51', '04'), 'pending');
    assert.strictEqual(mapResult(undefined, '02'), 'pending');
    assert.strictEqual(mapResult('51', undefined), 'pending');
    assert.strictEqual(mapResult('99', '02'), 'failed');
  } finally { await h.close(); }
});

test('amount khong nguyen / thieu truong -> valid=false; return khong du chu ky', async () => {
  const h = await startHarness();
  try {
    const { sign } = require('../../src/adapters/vnpay/signing');
    const p = { vnp_TxnRef: 'A1', vnp_Amount: '1050', vnp_ResponseCode: '00', vnp_TransactionStatus: '00' };
    p.vnp_SecureHash = sign('test-hash-secret-not-a-real-key', p);
    const cb = h.adapter.parseCallback({ channel: 'ipn', method: 'GET', query: p, body: null, headers: {} });
    assert.strictEqual(cb.valid, false);
    const q = { vnp_TxnRef: 'A2', vnp_Amount: '1000000' };
    q.vnp_SecureHash = sign('test-hash-secret-not-a-real-key', q);
    const cb2 = h.adapter.parseCallback({ channel: 'ipn', method: 'GET', query: q, body: null, headers: {} });
    assert.strictEqual(cb2.event.type, 'pending');
  } finally { await h.close(); }
});

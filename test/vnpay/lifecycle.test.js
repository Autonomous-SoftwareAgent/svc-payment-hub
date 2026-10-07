'use strict';
// spec: VNPS-S-010, VNPS-S-004, VNPS-S-005, VNPS-S-006
const test = require('node:test');
const assert = require('node:assert');
const { startHarness } = require('./helpers');
const { assertAdapterShape, assertEvent } = require('../../src/contract');

const parseIpn = (h, r) => h.adapter.parseCallback({ channel: 'ipn', method: r.method, query: r.query, body: r.body, headers: r.headers });

test('adapter dung hop dong va nang luc bao thu', async () => {
  const h = await startHarness();
  try {
    assert.ok(assertAdapterShape(h.adapter));
    const c = h.adapter.capabilities();
    assert.strictEqual(c.hardExpiry, 'unknown');
    assert.strictEqual(c.cancellable, false);
    assert.strictEqual(c.queryable, true);
    assert.strictEqual(h.adapter.cancel, undefined);
    const r = await h.adapter.createPayment({ attemptRef: 'X', amount: 100.5, orderInfo: 'a', returnUrl: 'http://localhost/r' });
    assert.strictEqual(r.status, 'rejected');
  } finally { await h.close(); }
});

test('thanh cong: create -> pay -> IPN -> succeeded dung amount; return cung chu ky', async () => {
  const h = await startHarness();
  try {
    const c = await h.create('OK1', { amount: 250000 });
    assert.strictEqual(c.status, 'redirect');
    assert.ok(c.expiresAt > h.sim.clock.now());
    const r = await h.post('/sim/pay', { txnRef: 'OK1', outcome: 'success' });
    assert.strictEqual(r.status, 'paid');
    assert.strictEqual(h.received.length, 1);
    const cb = parseIpn(h, h.received[0]);
    assert.ok(cb.valid);
    assertEvent(cb.event);
    assert.strictEqual(cb.event.type, 'succeeded');
    assert.strictEqual(cb.event.amount, 250000);
    assert.strictEqual(cb.event.source, 'ipn');
    assert.ok(cb.event.gatewayTxnId);
    // return URL: cung du lieu, source=return
    const u = new URL(r.returnUrl);
    const ret = h.adapter.parseCallback({ channel: 'return', method: 'GET', query: Object.fromEntries(u.searchParams), body: null, headers: {} });
    assert.ok(ret.valid);
    assert.strictEqual(ret.event.source, 'return');
    assert.strictEqual(ret.event.type, 'succeeded');
    assert.strictEqual((await h.txn('OK1')).ipn.state, 'done');
  } finally { await h.close(); }
});

test('IPN bang POST (form) van parse duoc', async () => {
  const h = await startHarness({ simOpts: { ipnMethod: 'POST' } });
  try {
    await h.create('P1');
    await h.post('/sim/pay', { txnRef: 'P1', outcome: 'success' });
    assert.strictEqual(h.received[0].method, 'POST');
    assert.strictEqual(parseIpn(h, h.received[0]).event.type, 'succeeded');
  } finally { await h.close(); }
});

test('that bai (51), huy (24), het han (11) map dung su kien chuan', async () => {
  const h = await startHarness();
  try {
    await h.create('F1'); await h.create('C1'); await h.create('E1');
    await h.post('/sim/pay', { txnRef: 'F1', outcome: 'insufficient' });
    await h.post('/sim/pay', { txnRef: 'C1', outcome: 'cancel' });
    await h.sim.clock.advance(16 * 60);
    await h.post('/sim/pay', { txnRef: 'E1', outcome: 'success' });
    const types = Object.fromEntries(h.received.map((r) => { const e = parseIpn(h, r).event; return [e.attemptRef, e.type]; }));
    assert.deepStrictEqual(types, { F1: 'failed', C1: 'cancelled', E1: 'expired' });
  } finally { await h.close(); }
});

test('query: thanh cong, chua tra tien -> not_found, don la -> not_found', async () => {
  const h = await startHarness();
  try {
    await h.create('Q1', { amount: 123000 }); await h.create('Q2');
    await h.post('/sim/pay', { txnRef: 'Q1', outcome: 'success' });
    const ev = await h.adapter.query({ attemptRef: 'Q1' });
    assertEvent(ev);
    assert.strictEqual(ev.type, 'succeeded');
    assert.strictEqual(ev.amount, 123000);
    assert.strictEqual(ev.source, 'query');
    assert.deepStrictEqual(await h.adapter.query({ attemptRef: 'Q2' }), { state: 'not_found' });
    assert.deepStrictEqual(await h.adapter.query({ attemptRef: 'NOPE' }), { state: 'not_found' });
    // that bai -> failed
    await h.create('Q3'); await h.post('/sim/pay', { txnRef: 'Q3', outcome: 'insufficient' });
    assert.strictEqual((await h.adapter.query({ attemptRef: 'Q3' })).type, 'failed');
  } finally { await h.close(); }
});

test('query: sai chu ky tra ve 97 -> unknown; sai secret phia adapter', async () => {
  const h = await startHarness();
  try {
    await h.create('Q9');
    const { createVnpayAdapter } = require('../../src/adapters/vnpay');
    const bad = createVnpayAdapter({ tmnCode: 'TESTTMN1', hashSecret: 'sai-secret', baseUrl: h.sim.url }, { fetch, clock: h.sim.clock });
    assert.deepStrictEqual(await bad.query({ attemptRef: 'Q9' }), { state: 'unknown' });
    const down = createVnpayAdapter({ tmnCode: 'TESTTMN1', hashSecret: 'x', baseUrl: 'http://127.0.0.1:1' }, { fetch, clock: h.sim.clock });
    assert.deepStrictEqual(await down.query({ attemptRef: 'Q9' }), { state: 'unknown' });
  } finally { await h.close(); }
});

test('hoan tien: toan phan bat dong bo, qua so tien bi tu choi, hoan lap, don khong thanh cong', async () => {
  const h = await startHarness();
  try {
    await h.create('R1', { amount: 100000 }); await h.create('R2', { amount: 100000 });
    await h.post('/sim/pay', { txnRef: 'R1', outcome: 'success' });
    await h.post('/sim/pay', { txnRef: 'R2', outcome: 'insufficient' });
    const ev = await h.adapter.query({ attemptRef: 'R1' });
    assert.strictEqual((await h.adapter.refund({ attemptRef: 'R1', refundRef: 'RF1', amount: 200000, originalAmount: 100000, gatewayTxnId: ev.gatewayTxnId })).status, 'failed');
    assert.strictEqual((await h.adapter.refund({ attemptRef: 'R1', refundRef: 'RF2', amount: 100000, originalAmount: 100000, gatewayTxnId: ev.gatewayTxnId })).status, 'processing');
    assert.strictEqual((await h.adapter.refund({ attemptRef: 'R1', refundRef: 'RF3', amount: 100000, originalAmount: 100000 })).status, 'processing'); // 94: dang xu ly
    assert.strictEqual((await h.adapter.refund({ attemptRef: 'R2', refundRef: 'RF4', amount: 100000 })).status, 'failed'); // 95
    assert.strictEqual((await h.adapter.queryRefund({ refundRef: 'RF2', attemptRef: 'R1' })).status, 'manual_required'); // vong doi chua ro
    await h.sim.clock.advance(61);
    assert.strictEqual((await h.txn('R1')).refunds[0].status, 'succeeded');
  } finally { await h.close(); }
});

'use strict';
// spec: MOMO-S-003, MOMO-S-001
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers.js');
const { assertAdapterShape, assertEvent } = require('../../src/contract.js');

const asCallback = (rcvd) => ({ channel: 'ipn', method: 'POST', query: {}, body: rcvd.body, headers: rcvd.headers });

test('adapter đúng hình dạng hợp đồng và năng lực theo MOMO-D-003', async () => {
  const h = await setup();
  try {
    assert.equal(assertAdapterShape(h.adapter), true);
    assert.deepEqual(h.adapter.capabilities(), {
      createCanTimeout: true, hardExpiry: 'unknown', cancellable: false, queryable: true, refundable: 'api', refundAsync: true, currencies: ['VND'], regions: ['VN'], methods: ['wallet'],
    });
    assert.equal(h.adapter.cancel, undefined);
  } finally { await h.teardown(); }
});

test('create -> pay success -> IPN -> parseCallback succeeded đúng amount', async () => {
  const h = await setup();
  try {
    const c = await h.create('LIFE-OK', 150000);
    assert.equal(c.status, 'redirect'); assert.match(c.url, /\/v2\/gateway\/pay\?t=/);
    const p = await h.pay('LIFE-OK', 'success');
    assert.equal(p.json.resultCode, 0);
    assert.equal(h.ipn.received.length, 1);
    const r = h.adapter.parseCallback(asCallback(h.ipn.received[0]));
    assert.equal(r.valid, true); assertEvent(r.event);
    assert.equal(r.event.type, 'succeeded'); assert.equal(r.event.amount, 150000);
    assert.equal(r.event.attemptRef, 'LIFE-OK'); assert.equal(r.event.source, 'ipn');
    assert.equal(r.event.gatewayTxnId, String(p.json.transId));
    assert.equal(r.ack('ok').status, 204);
    // return URL (GET) -> channel 'return'
    const u = new URL(p.json.returnUrl);
    const rr = h.adapter.parseCallback({ channel: 'return', method: 'GET', query: Object.fromEntries(u.searchParams), body: undefined, headers: {} });
    assert.equal(rr.valid, true); assert.equal(rr.event.source, 'return'); assert.equal(rr.event.type, 'succeeded');
  } finally { await h.teardown(); }
});

test('thất bại và khách hủy', async () => {
  const h = await setup();
  try {
    await h.create('LIFE-F'); await h.create('LIFE-C');
    await h.pay('LIFE-F', 'failed'); await h.pay('LIFE-C', 'cancel');
    const f = h.adapter.parseCallback(asCallback(h.ipn.received[0]));
    const c = h.adapter.parseCallback(asCallback(h.ipn.received[1]));
    assert.equal(f.event.type, 'failed'); assert.equal(f.event.gatewayTxnId, undefined);
    assert.equal(c.event.type, 'cancelled');
  } finally { await h.teardown(); }
});

test('query: pending (1000), succeeded, not_found (1005 KHÔNG thành expired)', async () => {
  const h = await setup();
  try {
    await h.create('Q-1', 200000);
    let q = await h.adapter.query({ attemptRef: 'Q-1', amount: 200000 });
    assert.equal(q.type, 'pending'); assert.equal(q.source, 'query'); assert.equal(q.amount, 200000);
    assert.deepEqual(await h.adapter.query({ attemptRef: 'NEVER-CREATED', amount: 1000 }), { state: 'not_found' });
    await h.pay('Q-1', 'success');
    q = await h.adapter.query({ attemptRef: 'Q-1', amount: 200000 });
    assert.equal(q.type, 'succeeded'); assert.ok(q.gatewayTxnId); assertEvent(q);
    // đơn hết hạn (chưa trả) cũng chỉ là not_found, không bao giờ expired/failed
    await h.create('Q-2');
    h.sim.clock.advance(901);
    const e = await h.adapter.query({ attemptRef: 'Q-2', amount: 150000 });
    assert.deepEqual(e, { state: 'not_found' });
  } finally { await h.teardown(); }
});

test('9000 (authorized) -> pending; query trả pending', async () => {
  const h = await setup();
  try {
    await h.create('AUTH-1');
    await h.pay('AUTH-1', 'authorized');
    const cb = h.adapter.parseCallback(asCallback(h.ipn.received[0]));
    assert.equal(cb.valid, true); assert.equal(cb.event.type, 'pending');
    assert.equal((await h.adapter.query({ attemptRef: 'AUTH-1', amount: 150000 })).type, 'pending');
  } finally { await h.teardown(); }
});

test('ack(outcome)', async () => {
  const h = await setup();
  try {
    const { ack } = h.adapter.parseCallback({ channel: 'ipn', method: 'POST', query: {}, body: 'garbage', headers: {} });
    for (const o of ['ok', 'duplicate', 'unknown_attempt', 'amount_mismatch']) {
      assert.deepEqual(ack(o), { status: 204, body: '', contentType: 'text/plain' }, o);
    }
    assert.equal(ack('invalid_signature').status, 400);
    assert.equal(ack('error').status, 500);
    assert.equal(ack('invalid_signature').body, '');
  } finally { await h.teardown(); }
});

test('createPayment: rejected cho lỗi nghiệp vụ rõ ràng; requestId mới mỗi lần', async () => {
  const h = await setup();
  try {
    assert.equal((await h.create('REJ-1', 999)).status, 'rejected');          // 22
    assert.equal((await h.create('bad id!', 1000)).status, 'rejected');       // 20
    const wrong = require('../../src/adapters/momo/index.js').createMomoAdapter(
      { partnerCode: 'NOPE', accessKey: 'a', secretKey: 's', baseUrl: h.sim.url, ipnUrl: h.ipn.url, redirectUrl: 'x' }, {});
    assert.equal((await wrong.createPayment({ attemptRef: 'REJ-2', amount: 1000, orderInfo: 'x', returnUrl: 'x' })).status, 'rejected'); // 13
    const bad = require('../../src/adapters/momo/index.js').createMomoAdapter(
      { partnerCode: h.sim.config.partnerCode, accessKey: h.sim.config.accessKey, secretKey: 'wrong', baseUrl: h.sim.url, ipnUrl: h.ipn.url, redirectUrl: 'x' }, {});
    assert.equal((await bad.createPayment({ attemptRef: 'REJ-3', amount: 1000, orderInfo: 'x', returnUrl: 'x' })).status, 'rejected'); // 11007
    const ids = [];
    const spy = require('../../src/adapters/momo/index.js').createMomoAdapter(
      { ...h.sim.config, baseUrl: h.sim.url, ipnUrl: h.ipn.url, redirectUrl: 'x' },
      { fetch: async (u, o) => { ids.push(JSON.parse(o.body).requestId); return fetch(u, o); } });
    await spy.createPayment({ attemptRef: 'RID-1', amount: 1000, orderInfo: 'x', returnUrl: 'x' });
    await spy.createPayment({ attemptRef: 'RID-1', amount: 1000, orderInfo: 'x', returnUrl: 'x' });
    assert.equal(new Set(ids).size, 2);
  } finally { await h.teardown(); }
});

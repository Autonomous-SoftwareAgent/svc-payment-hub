'use strict';
// spec: PHUB-S-025
// Nạp lại bộ đệm VA của SePay B khi Hub khởi động (PHUB-D-025): bộ nhớ đệm trong tiến trình mất khi khởi động lại trong khi attempt vẫn còn sống ở kho.
// Không có adopt thì webhook đầu tiên phải quét danh sách đơn của SePay (rate limit 3 request/giây); có adopt thì khớp VA ngay, không gọi mạng.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupProducts } = require('./helpers');
const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
const { PaymentHub } = require('../../src/hub');
const { MemoryStore } = require('../../src/store');

// Adapter "sau khi khởi động lại": cùng cấu hình, bộ nhớ đệm trống, đếm số lần GET danh sách đơn.
function cold(t) {
  const hits = { list: 0 };
  const fetch = (url, init) => { if ((!init || !init.method || init.method === 'GET') && /\/bank-accounts\/[^/]+\/orders(\?|$)/.test(String(url))) hits.list += 1; return globalThis.fetch(url, init); };
  return { a: createSepayAdapter({ ...t.cfg }, { fetch, clock: t.sim.clock }), hits };
}
const replay = (a, r) => a.parseCallback({ channel: 'ipn', method: 'POST', query: {}, body: JSON.parse(r.rawBody), rawBody: r.rawBody, headers: r.headers });

test('webhook VA sau khởi động lại: không adopt thì phải quét danh sách đơn, có adopt thì khớp ngay không gọi mạng', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank' });
  try {
    const res = await t.va('BSNADOPT001', 5000);
    assert.equal(res.status, 'instructions');
    assert.ok(res.state && res.state.orderId, 'createPayment trả state để Hub lưu');
    await t.toVa(res, 5000);
    const req = t.rcv.requests[0];

    const c1 = cold(t);
    const r1 = await replay(c1.a, req);
    assert.equal(r1.event.attemptRef, 'BSNADOPT001');
    assert.ok(c1.hits.list >= 1, 'không adopt: phải quét danh sách đơn để tìm VA');

    const c2 = cold(t);
    const n = c2.a.adopt({ attempts: [{ attemptRef: 'BSNADOPT001', product: 'va-order', state: res.state, createdAt: 0 }] });
    assert.equal(n, 1);
    const r2 = await replay(c2.a, req);
    assert.equal(r2.event.attemptRef, 'BSNADOPT001');
    assert.equal(r2.event.gatewayTxnId, r1.event.gatewayTxnId);
    assert.equal(c2.hits.list, 0, 'đã adopt: khớp VA từ bộ đệm, không quét');
  } finally { await t.teardown(); }
});

test('adopt bỏ qua attempt không có state hoặc sản phẩm khác, không ném lỗi; khôi phục gợi ý sản phẩm để hủy đúng đường', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank' });
  try {
    const { a } = cold(t);
    assert.equal(a.adopt({ attempts: [] }), 0);
    assert.equal(a.adopt({}), 0);
    assert.equal(a.adopt({ attempts: [{ attemptRef: 'BSNNOSTATE01', product: 'va-order', createdAt: 0 }, { attemptRef: 'BSNQR0000001', product: 'qr-static', state: { orderId: 'x' }, createdAt: 0 }, { attemptRef: 'BSNLA0000001', product: 'khong-co', createdAt: 0 }] }), 0);
    // đơn đã tạo, rồi adapter nguội + adopt: hủy qua state tới đúng đơn, không phải dò B rồi C
    const res = await t.va('BSNADOPT002', 5000);
    const c = cold(t);
    c.a.adopt({ attempts: [{ attemptRef: 'BSNADOPT002', product: 'va-order', state: res.state, createdAt: 0 }] });
    assert.deepEqual(await c.a.cancel({ attemptRef: 'BSNADOPT002', state: res.state }), { cancelled: true });
    assert.equal(c.hits.list, 0, 'hủy theo state, không quét');
  } finally { await t.teardown(); }
});

test('Hub khởi động lại trên cùng kho: adoptAdapters nạp bộ đệm của adapter mới từ attempt còn sống; webhook đầu tiên PAID không quét', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank' });
  try {
    const store = new MemoryStore();
    const mk = (adapter) => new PaymentHub({ adapters: { sepay: adapter }, store, config: { gateways: [{ id: 'sepay' }] } });
    const hub1 = mk(t.adapter);
    const { payment, attempt } = await hub1.createPayment({ orderId: 'O-ADOPT', amount: 5000, returnUrl: 'https://s/r', product: 'va-order' });
    assert.equal(attempt.product, 'va-order');
    assert.ok(attempt.state && attempt.state.orderId, 'Hub đã lưu state của adapter trên attempt');
    await t.toVa({ instructions: attempt.instructions }, 5000);
    const req = t.rcv.requests[0];

    const c = cold(t); // tiến trình mới: adapter mới, kho giữ nguyên
    const hub2 = mk(c.a);
    assert.deepEqual(await hub2.adoptAdapters(), { sepay: 1 });
    const r = await hub2.handleCallback('sepay', { channel: 'ipn', method: 'POST', query: {}, body: JSON.parse(req.rawBody), rawBody: req.rawBody, headers: req.headers });
    assert.equal(r.outcome, 'ok');
    assert.equal(payment.status, 'PAID');
    assert.equal(c.hits.list, 0);
  } finally { await t.teardown(); }
});

test('adapter không có adopt thì bị bỏ qua; adopt ném lỗi thì Hub ghi adopt_error và vẫn chạy', async () => {
  const { createFakeAdapter } = require('../support/fake-adapter');
  const plain = createFakeAdapter('plain');
  const boom = createFakeAdapter('boom');
  boom.adopt = () => { throw new Error('hỏng bộ đệm'); };
  const good = createFakeAdapter('good');
  let got = null;
  good.adopt = ({ attempts }) => { got = attempts; };
  const hub = new PaymentHub({ adapters: { plain, boom, good }, config: { gateways: [{ id: 'plain', priority: 1 }, { id: 'boom', priority: 2 }, { id: 'good', priority: 3 }] } });
  const { attempt } = await hub.createPayment({ orderId: 'O1', amount: 1000, returnUrl: 'https://s/r' }); // vào cổng plain
  assert.equal(attempt.gateway, 'plain');
  const report = await hub.adoptAdapters();
  assert.deepEqual(report, { boom: 'error', good: 0 });
  assert.deepEqual(got, [], 'chỉ nhận attempt của cổng mình');
  assert.ok(hub.store.events.some((e) => e.outcome === 'adopt_error' && e.gateway === 'boom' && /hỏng bộ đệm/.test(e.detail)));
});

test('main() gọi adoptAdapters TRƯỚC khi mở cổng nhận request: callback đầu tiên có thể đến ngay sau listen', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const a = src.indexOf('hub.adoptAdapters()');
  const l = src.indexOf('api.listen(');
  assert.ok(a > 0 && l > 0 && a < l, `adoptAdapters ở ${a}, listen ở ${l}`);
});

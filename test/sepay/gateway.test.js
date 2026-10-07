'use strict';
// spec: SEPY-S-007
// spec: SEPY-S-005
// Sản phẩm C (cổng pay.sepay.vn): adapter + simulator. Simulator và test này chỉ chứng minh adapter khớp GIẢ ĐỊNH ghi trong SEPY-D-005
// (docs-only, trừ C0), không chứng minh hành vi thật của SePay. Chữ ký được tính lại độc lập trong test theo cách đọc docs, chưa phải golden vector thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { assertAdapterShape, assertEvent } = require('../../src/contract.js');
const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
const { setupProducts, CREDS } = require('./helpers.js');

const SECRET = 'test-pg-secret-not-real';
const MERCHANT = 'MERCHANT_TEST';

// Chữ ký theo cách đọc docs, viết độc lập với adapter
function docsSignature(fields) {
  const order = ['order_amount', 'merchant', 'currency', 'operation', 'order_description', 'order_invoice_number', 'customer_id', 'payment_method', 'success_url', 'error_url', 'cancel_url'];
  const str = order.filter((k) => fields[k] !== undefined).map((k) => `${k}=${fields[k]}`).join(',');
  return crypto.createHmac('sha256', SECRET).update(str).digest('base64');
}

const create = (t, ref, amount = 150000, extra = {}) => t.adapter.createPayment({ product: 'gateway', attemptRef: ref, amount, orderInfo: 'Thanh toan don hang', returnUrl: 'https://shop.test/return', ...extra });
// Trình duyệt của khách POST form tới SePay (tạo đơn phía SePay)
const submit = async (res) => fetch(res.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(res.fields).toString(), redirect: 'manual' });
async function open(t, ref, amount = 150000) {
  const res = await create(t, ref, amount);
  const r = await submit(res);
  assert.equal(r.status, 302);
  return res;
}
const pay = (t, ref, body = {}) => t.call('POST', '/sim/pg/pay', { invoice: ref, ...body });
const pgOrder = (t, ref) => t.sim.state.pgOrders.find((o) => o.invoice === ref);

test('capabilities của C; adapter đúng hình dạng hợp đồng', async () => {
  const t = await setupProducts({ pg: true });
  try {
    assert.equal(assertAdapterShape(t.adapter), true);
    assert.deepEqual(t.adapter.capabilities('gateway'), {
      hardExpiry: 'unknown', cancellable: true, queryable: true, refundable: 'manual', refundAsync: true, createCanTimeout: false, currencies: ['VND'], regions: ['VN'], methods: ['card_international', 'qr', 'bank_transfer'],
      referenceFormat: { prefix: 'BSN' },
    });
    assert.equal(typeof t.adapter.cancel, 'function');
  } finally { await t.teardown(); }
});

test('createPayment: không gọi mạng, trả form POST đã ký (thứ tự trường cố định, chữ ký base64 HMAC-SHA256)', async () => {
  let called = 0;
  const a = createSepayAdapter({ pg: { merchantId: MERCHANT, secretKey: SECRET, returnBaseUrl: 'https://hub.test/return/sepay', paymentMethod: 'BANK_TRANSFER' }, authMode: 'none' }, { fetch: () => { called += 1; throw new Error('no network'); } });
  const r = await a.createPayment({ product: 'gateway', attemptRef: 'BSNGW000001', amount: 150000, orderInfo: 'Don hang #12345', returnUrl: 'https://shop.test/x' });
  assert.equal(called, 0);
  assert.equal(r.status, 'redirect'); assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://pay.sepay.vn/v1/checkout/init');
  assert.deepEqual(Object.keys(r.fields), ['order_amount', 'merchant', 'currency', 'operation', 'order_description', 'order_invoice_number', 'payment_method', 'success_url', 'error_url', 'cancel_url', 'signature']);
  assert.equal(r.fields.order_amount, '150000'); assert.equal(r.fields.currency, 'VND'); assert.equal(r.fields.operation, 'PURCHASE');
  assert.equal(r.fields.order_invoice_number, 'BSNGW000001');
  assert.equal(r.fields.success_url, 'https://hub.test/return/sepay?ref=BSNGW000001&r=success');
  assert.equal(r.fields.signature, docsSignature(r.fields));
  // đổi một trường thì chữ ký khác (kiểm tra không ký cố định)
  const r2 = await a.createPayment({ product: 'gateway', attemptRef: 'BSNGW000002', amount: 150000, orderInfo: 'Don hang #12345', returnUrl: 'x' });
  assert.notEqual(r.fields.signature, r2.fields.signature);
});

test('createPayment: từ chối mã/số tiền sai và cấu hình thiếu, product chưa cấu hình', async () => {
  const a = createSepayAdapter({ pg: { merchantId: MERCHANT, secretKey: SECRET }, authMode: 'none' }, {});
  const base = { product: 'gateway', orderInfo: 'x', returnUrl: 'https://shop.test/r' };
  for (const ref of ['BSN,1', 'BSN=1', 'BSN 1', 'BSN&1', '', undefined, 'A'.repeat(101)]) assert.equal((await a.createPayment({ ...base, attemptRef: ref, amount: 1000 })).status, 'rejected', String(ref));
  for (const amount of [0, -1, 1.5, '1000']) assert.equal((await a.createPayment({ ...base, attemptRef: 'BSNOK0001', amount })).status, 'rejected');
  assert.equal((await a.createPayment({ ...base, attemptRef: 'BSNOK0001', amount: 1000 })).status, 'redirect', 'thiếu returnBaseUrl thì dùng returnUrl của đơn');
  assert.equal((await a.createPayment({ ...base, returnUrl: '', attemptRef: 'BSNOK0001', amount: 1000 })).status, 'rejected');
  assert.equal((await a.createPayment({ ...base, product: 'va-order', attemptRef: 'BSNOK0001', amount: 1000 })).status, 'rejected');
  assert.throws(() => createSepayAdapter({ pg: { merchantId: 'M' } }, {}), /secretKey/);
});

test('simulator: form đúng -> 302 và đơn AUTHENTICATION_NOT_NEEDED; sai chữ ký/merchant vẫn HTTP 200 text/html (C0, live)', async () => {
  const t = await setupProducts({ pg: true });
  try {
    const res = await create(t, 'BSNINIT0001');
    const ok = await submit(res);
    assert.equal(ok.status, 302); assert.match(ok.headers.get('location'), /^\/v1\/checkout\?.*order_id=SEPAY-/);
    assert.equal(pgOrder(t, 'BSNINIT0001').status, 'AUTHENTICATION_NOT_NEEDED');
    for (const bad of [{ ...res.fields, signature: 'ZmFrZQ==' }, { ...res.fields, merchant: 'KHAC' }, { ...res.fields, order_amount: '1' }]) {
      const r = await fetch(res.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(bad).toString(), redirect: 'manual' });
      assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/); assert.match(await r.text(), /Lỗi không xác định/);
    }
    assert.equal(t.sim.state.pgOrders.length, 1);
  } finally { await t.teardown(); }
});

test('thứ tự ký (C1 conflicts): form theo thứ tự SDK (merchant ở cuối) bị server mô phỏng nhạy thứ tự từ chối; chỉ chấp nhận khi server không nhạy', async () => {
  const t = await setupProducts({ pg: true });
  try {
    const res = await create(t, 'BSNORDER001');
    const sdk = { ...res.fields }; delete sdk.signature; delete sdk.merchant; sdk.merchant = MERCHANT;
    const sdkStr = Object.keys(sdk).filter((k) => k !== 'signature').map((k) => `${k}=${sdk[k]}`).join(',');
    sdk.signature = crypto.createHmac('sha256', SECRET).update(sdkStr).digest('base64');
    const post = (f) => fetch(res.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f).toString(), redirect: 'manual' });
    assert.equal((await post(sdk)).status, 200, 'server nhạy thứ tự theo danh sách docs: chữ ký kiểu SDK bị từ chối');
    await t.control({ pg_sign_order: 'form' });
    assert.equal((await post(sdk)).status, 302, 'server ký theo thứ tự form: chữ ký kiểu SDK được chấp nhận');
    const res2 = await create(t, 'BSNORDER002');
    assert.equal((await post(res2.fields)).status, 302, 'form của adapter khớp cả hai cách vì danh sách docs và thứ tự phát form giống nhau');
  } finally { await t.teardown(); }
});

test('khách trả thành công: IPN (X-Secret-Key) -> sự kiện succeeded với số tiền thật, id giao dịch, thời điểm', async () => {
  const t = await setupProducts({ pg: true });
  try {
    await open(t, 'BSNPAY00001', 150000);
    const r = await pay(t, 'BSNPAY00001');
    assert.equal(r.json.redirect, 'https://hub.example.test/return/sepay?ref=BSNPAY00001&r=success');
    assert.equal(t.rcv.events.length, 1);
    const ev = t.rcv.events[0];
    assertEvent(ev);
    assert.equal(ev.type, 'succeeded'); assert.equal(ev.attemptRef, 'BSNPAY00001'); assert.equal(ev.amount, 150000); assert.equal(ev.source, 'ipn');
    assert.match(ev.gatewayTxnId, /^68ba/);
    assert.equal(t.rcv.requests[0].headers['x-secret-key'], SECRET);
    assert.equal(t.rcv.results[0].ack('ok').status, 200);
    assert.equal(pgOrder(t, 'BSNPAY00001').status, 'CAPTURED');
    // order_amount của IPN có phần thập phân "150000.00" (C2): vẫn là số nguyên đúng
    assert.equal(t.rcv.results[0].event.raw.order.order_amount, '150000.00');
  } finally { await t.teardown(); }
});

test('IPN sai xác thực bị từ chối (401), không có sự kiện; kiểu none và apikey cũng chạy', async () => {
  const t = await setupProducts({ pg: true, controls: { webhook_bad_auth: true, webhook_retry_max_attempts: 1 } });
  try {
    await open(t, 'BSNAUTH0001');
    await pay(t, 'BSNAUTH0001');
    assert.equal(t.rcv.results[0].valid, false); assert.equal(t.rcv.results[0].reason, 'bad_secret_key');
    assert.equal(t.rcv.requests.length, 1); assert.equal(t.rcv.events.length, 0);
    const att = t.sim.state.pgNotes[0].webhook.attempts[0];
    assert.equal(att.httpStatus, 401); assert.equal(att.ok, false);
  } finally { await t.teardown(); }
  const none = await setupProducts({ pg: true, ipnAuth: 'none' });
  try {
    await open(none, 'BSNAUTH0002');
    await pay(none, 'BSNAUTH0002');
    assert.equal(none.rcv.events.length, 1);
    assert.equal(none.rcv.requests[0].headers['x-secret-key'], undefined);
  } finally { await none.teardown(); }
  const a = createSepayAdapter({ pg: { merchantId: MERCHANT, secretKey: SECRET, ipnAuth: 'apikey' }, apiKey: 'k1', authMode: 'none' }, {});
  const body = { notification_type: 'ORDER_PAID', order: { order_invoice_number: 'BSNK1', order_status: 'CAPTURED', order_amount: '1000.00' }, transaction: { transaction_id: 'T1', transaction_type: 'PAYMENT', transaction_status: 'APPROVED', transaction_amount: '1000' } };
  assert.equal(a.parseCallback({ channel: 'ipn', headers: {}, body }).valid, false);
  assert.equal(a.parseCallback({ channel: 'ipn', headers: { authorization: 'Apikey k1' }, body }).valid, true);
});

test('DECLINED không bao giờ là kết quả cuối: sự kiện pending; thử lại thành công thì succeeded', async () => {
  const t = await setupProducts({ pg: true, controls: { pg_ipn_on_decline: true } });
  try {
    await open(t, 'BSNDECL0001', 50000);
    const d = await pay(t, 'BSNDECL0001', { outcome: 'declined' });
    assert.equal(d.json.redirect, 'https://hub.example.test/return/sepay?ref=BSNDECL0001&r=error');
    assert.equal(t.rcv.events.length, 1); assert.equal(t.rcv.events[0].type, 'pending'); assert.equal(t.rcv.events[0].amount, undefined);
    assertEvent(t.rcv.events[0]);
    await pay(t, 'BSNDECL0001');
    assert.equal(t.rcv.events[1].type, 'succeeded');
    assert.ok(t.rcv.events.every((e) => e.type !== 'failed'));
  } finally { await t.teardown(); }
});

test('void thẻ: IPN TRANSACTION_VOID -> reversed kèm số tiền và khoản gốc (PHUB-D-018, P5); query chỉ báo reversed, không báo succeeded', async () => {
  const t = await setupProducts({ pg: true });
  try {
    await open(t, 'BSNVOID0001', 80000);
    await pay(t, 'BSNVOID0001', { method: 'CARD' });
    const v = await t.call('POST', '/sim/pg/void', { invoice: 'BSNVOID0001' });
    assert.equal(v.status, 200);
    assert.deepEqual(t.rcv.events.map((e) => e.type), ['succeeded', 'reversed']);
    assert.equal(t.rcv.events[1].amount, 80000); assertEvent(t.rcv.events[1]);
    assert.equal(t.rcv.events[1].gatewayTxnId, 'void:BSNVOID0001', 'mã ổn định theo đơn');
    const q = await t.adapter.query({ product: 'gateway', attemptRef: 'BSNVOID0001' });
    assert.deepEqual(q.map((e) => e.type), ['reversed'], 'đã thu rồi bị void: tiền ròng bằng không, không báo succeeded');
    assert.equal(q[0].amount, 80000); assert.equal(q[0].gatewayTxnId, t.rcv.events[1].gatewayTxnId, 'IPN và truy vấn cùng mã: Hub không cộng hai lần');
    assert.equal((await t.call('POST', '/sim/pg/void', { invoice: 'BSNVOID0001' })).status, 200, 'void hai lần là chuyện của cổng; adapter không can thiệp');
  } finally { await t.teardown(); }
});

test('IPN lạ: REFUND và loại chưa biết hợp lệ nhưng không có sự kiện; thiếu invoice thì chỉ ORDER_PAID thành công mới thành khoản chưa rõ chủ; thân hỏng bị từ chối', async () => {
  const a = createSepayAdapter({ pg: { merchantId: MERCHANT, secretKey: SECRET, ipnAuth: 'none' }, authMode: 'none' }, { clock: { now: () => 1 } });
  const mk = (over = {}, tx = {}, kind = 'ORDER_PAID') => ({
    notification_type: kind, timestamp: 1757058220,
    order: { id: 'u', order_id: 'SEPAY-1', order_status: 'CAPTURED', order_amount: '50000.00', order_invoice_number: 'BSNLA0001', order_description: 'mo ta', ...over },
    transaction: { id: 'tu', transaction_id: 'TX9', transaction_type: 'PAYMENT', transaction_status: 'APPROVED', transaction_amount: '50000', transaction_date: '2025-09-05 14:03:40', ...tx },
  });
  const p = (body) => a.parseCallback({ channel: 'ipn', headers: {}, body });
  assert.equal(p(mk()).event.type, 'succeeded');
  assert.equal(p(mk()).event.occurredAt, Date.parse('2025-09-05T14:03:40+07:00'));
  assert.equal(p(mk({}, { transaction_type: 'REFUND' })).valid, true); assert.equal(p(mk({}, { transaction_type: 'REFUND' })).event, undefined);
  assert.equal(p(mk({}, {}, 'SOMETHING_NEW')).event, undefined);
  const noInv = p(mk({ order_invoice_number: null }));
  assert.equal(noInv.event.unmatched, true); assert.equal(noInv.event.type, 'received'); assert.equal(noInv.event.amount, 50000);
  assert.equal(p(mk({ order_invoice_number: '' }, {}, 'TRANSACTION_VOID')).event, undefined);
  const v = p(mk({}, {}, 'TRANSACTION_VOID')).event;
  assert.equal(v.type, 'reversed'); assert.equal(v.amount, 50000); assert.equal(v.gatewayTxnId, 'void:BSNLA0001'); assert.equal(v.attemptRef, 'BSNLA0001');
  assert.equal(p(mk({ order_invoice_number: '' }, { transaction_status: 'DECLINED' })).event, undefined);
  // dữ liệu mâu thuẫn: ORDER_PAID + APPROVED nhưng đơn chưa CAPTURED -> không kết luận thành công
  assert.equal(p(mk({ order_status: 'AUTHENTICATION_NOT_NEEDED' })).event.type, 'pending');
  // số tiền: phần thập phân khác 0, âm, thiếu
  for (const bad of ['100.5', '-5', 'abc', '0']) assert.equal(p(mk({}, { transaction_amount: bad })).valid, false, bad);
  // thiếu transaction_amount: lùi về order_amount
  const t2 = mk(); delete t2.transaction.transaction_amount;
  assert.equal(p(t2).event.amount, 50000);
  assert.equal(p({ notification_type: 'ORDER_PAID' }).valid, false);
  assert.equal(p('khong phai json').valid, false);
  assert.equal(p(null).valid, false);
});

test('số tiền khách trả khác đơn: adapter báo đúng số tiền thật đã chuyển (Hub tự đánh amount_mismatch)', async () => {
  const t = await setupProducts({ pg: true });
  try {
    await open(t, 'BSNMISM0001', 150000);
    await pay(t, 'BSNMISM0001', { amount: 120000 });
    assert.equal(t.rcv.events[0].type, 'succeeded'); assert.equal(t.rcv.events[0].amount, 120000);
    assert.equal(t.rcv.results[0].event.raw.order.order_amount, '150000.00');
  } finally { await t.teardown(); }
});

test('IPN trùng, đảo thứ tự/trễ, mất, thử lại: adapter không giấu; query và gửi lại cứu được', async () => {
  const t = await setupProducts({ pg: true, controls: { webhook_duplicate: 3 } });
  try {
    await open(t, 'BSNDUP00001', 10000);
    await pay(t, 'BSNDUP00001');
    assert.equal(t.rcv.events.length, 3); assert.equal(new Set(t.rcv.events.map((e) => e.gatewayTxnId)).size, 1);
    await t.control({ webhook_duplicate: 1, webhook_delay_seconds: 120 });
    await open(t, 'BSNDLY00001', 10000);
    await pay(t, 'BSNDLY00001');
    assert.equal(t.rcv.events.length, 3);
    await t.advance(119); assert.equal(t.rcv.events.length, 3);
    await t.advance(1); assert.equal(t.rcv.events.length, 4);
    // IPN mất hẳn: query thấy đơn đã CAPTURED
    await t.control({ webhook_delay_seconds: 0, webhook_drop: true });
    await open(t, 'BSNLOST0001', 20000);
    await pay(t, 'BSNLOST0001');
    await t.advance(3600 * 3);
    assert.equal(t.rcv.events.length, 4);
    const q = await t.adapter.query({ product: 'gateway', attemptRef: 'BSNLOST0001' });
    assert.equal(q[0].type, 'succeeded'); assert.equal(q[0].amount, 20000); assert.equal(q[0].source, 'query');
    assertEvent(q[0]);
    // gửi lại thủ công
    await t.control({ webhook_drop: false });
    const note = t.sim.state.pgNotes.at(-1);
    const re = await t.call('POST', `/sim/ipn/${note.id}/resend`);
    assert.equal(re.json.ok, true); assert.equal(t.rcv.events.length, 5);
  } finally { await t.teardown(); }
});

test('IPN: Hub trả 500 thì SePay thử lại theo lịch (mô phỏng), thành công thì dừng', async () => {
  const t = await setupProducts({ pg: true, controls: { webhook_retry_max_attempts: 3, webhook_retry_intervals_minutes: [2] } });
  try {
    t.rcv.failFirst = 1;
    await open(t, 'BSNRETRY001');
    await pay(t, 'BSNRETRY001');
    assert.equal(t.rcv.requests.length, 1); assert.equal(t.rcv.events.length, 0);
    await t.advance(119); assert.equal(t.rcv.requests.length, 1);
    await t.advance(1); assert.equal(t.rcv.events.length, 1);
    await t.advance(3600); assert.equal(t.rcv.requests.length, 2);
  } finally { await t.teardown(); }
});

test('query: chưa trả -> pending; đã trả -> succeeded; hủy -> cancelled; chưa mở form -> not_found', async () => {
  const t = await setupProducts({ pg: true });
  try {
    const q = (ref) => t.adapter.query({ product: 'gateway', attemptRef: ref });
    assert.deepEqual(await q('BSNQ0000001'), { state: 'not_found' }, 'khách chưa mở form: SePay chưa có đơn');
    await open(t, 'BSNQ0000001', 30000);
    const pending = await q('BSNQ0000001');
    assert.equal(pending[0].type, 'pending'); assertEvent(pending[0]);
    await pay(t, 'BSNQ0000001');
    const paid = await q('BSNQ0000001');
    assert.equal(paid[0].type, 'succeeded'); assert.equal(paid[0].amount, 30000);
    await open(t, 'BSNQ0000002', 1000);
    await pay(t, 'BSNQ0000002', { outcome: 'cancel' });
    const c = await q('BSNQ0000002');
    assert.equal(c[0].type, 'cancelled'); assert.equal(c[0].amount, 1000);
    assert.deepEqual(await q('BSN,XYZ'), { state: 'not_found' });
  } finally { await t.teardown(); }
});

test('query: khóa tra chi tiết là order_id (docs) thay vì invoice (SDK): lùi về danh sách q; danh sách không kèm giao dịch thì lấy chi tiết', async () => {
  const t = await setupProducts({ pg: true, controls: { pg_detail_key: 'order_id' } });
  try {
    await open(t, 'BSNKEY00001', 45000);
    await pay(t, 'BSNKEY00001');
    const q = await t.adapter.query({ product: 'gateway', attemptRef: 'BSNKEY00001' });
    assert.equal(q[0].type, 'succeeded'); assert.equal(q[0].amount, 45000);
    // CS4: id giao dịch của API chi tiết (transactions[].id) khác transaction_id của IPN: hai kênh không có khóa chung
    assert.equal(q[0].gatewayTxnId, '1'); assert.notEqual(q[0].gatewayTxnId, t.rcv.events[0].gatewayTxnId);
    // vẫn không bao giờ khớp nhầm đơn khác có tiền tố giống
    await open(t, 'BSNKEY000010', 1);
    assert.equal((await t.adapter.query({ product: 'gateway', attemptRef: 'BSNKEY00001' }))[0].amount, 45000);
    assert.deepEqual(await t.adapter.query({ product: 'gateway', attemptRef: 'BSNKEY0000' }), { state: 'not_found' });
  } finally { await t.teardown(); }
});

test('query: 401, 429, 503, mạng hỏng, phản hồi hỏng -> unknown, không bao giờ not_found hay thất bại', async () => {
  const t = await setupProducts({ pg: true });
  try {
    await open(t, 'BSNERR00001');
    const bad = t.newAdapter({ pg: { ...t.cfg.pg, secretKey: 'sai' } });
    assert.deepEqual(await bad.query({ product: 'gateway', attemptRef: 'BSNERR00001' }), { state: 'unknown' });
    for (const mode of ['fail_503', 'rate_limit']) {
      await t.control({ pg_api_mode: mode });
      assert.deepEqual(await t.adapter.query({ product: 'gateway', attemptRef: 'BSNERR00001' }), { state: 'unknown' }, mode);
      assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNERR00001' }), { cancelled: false }, mode);
    }
    const down = createSepayAdapter({ ...t.cfg, pg: { ...t.cfg.pg, apiBaseUrl: 'http://127.0.0.1:1/v1' }, timeoutMs: 300 }, { clock: t.sim.clock });
    assert.deepEqual(await down.query({ product: 'gateway', attemptRef: 'BSNERR00001' }), { state: 'unknown' });
    // đơn có trạng thái lạ
    await t.control({ pg_api_mode: 'ok' });
    pgOrder(t, 'BSNERR00001').status = 'MOT_TRANG_THAI_MOI';
    assert.deepEqual(await t.adapter.query({ product: 'gateway', attemptRef: 'BSNERR00001' }), { state: 'unknown' });
  } finally { await t.teardown(); }
});

test('hủy đơn: chỉ đơn chưa trả hủy được; đã CAPTURED, đã hủy, đơn chưa tồn tại, lỗi API: cancelled=false', async () => {
  const t = await setupProducts({ pg: true });
  try {
    await open(t, 'BSNCAN00001');
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCAN00001' }), { cancelled: true });
    assert.equal(pgOrder(t, 'BSNCAN00001').status, 'CANCELLED');
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCAN00001' }), { cancelled: false });
    await open(t, 'BSNCAN00002');
    await pay(t, 'BSNCAN00002');
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCAN00002' }), { cancelled: false }, 'đã CAPTURED');
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNKHONGCO3' }), { cancelled: false });
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'a,b' }), { cancelled: false });
    // đã hủy mà khách vẫn trả được (docs-silent, simulator mô phỏng xấu): tiền vẫn được báo
    await open(t, 'BSNCAN00004');
    await t.adapter.cancel({ attemptRef: 'BSNCAN00004' });
    assert.equal((await pay(t, 'BSNCAN00004')).status, 422);
    await t.control({ pg_pay_after_cancel: true });
    assert.equal((await pay(t, 'BSNCAN00004')).status, 200);
    assert.equal(t.rcv.events.at(-1).type, 'succeeded'); assert.equal(t.rcv.events.at(-1).attemptRef, 'BSNCAN00004');
  } finally { await t.teardown(); }
});

test('trình duyệt quay về (channel return): chỉ là sự kiện pending nguồn return, không phải bằng chứng; thiếu ref thì không hợp lệ', async () => {
  const a = createSepayAdapter({ pg: { merchantId: MERCHANT, secretKey: SECRET }, authMode: 'none' }, { clock: { now: () => 5 } });
  const r = a.parseCallback({ channel: 'return', method: 'GET', query: { ref: 'BSNRET00001', r: 'success' }, headers: {} });
  assert.equal(r.valid, true); assert.equal(r.event.type, 'pending'); assert.equal(r.event.source, 'return'); assert.equal(r.event.attemptRef, 'BSNRET00001');
  assertEvent(r.event);
  assert.equal(a.parseCallback({ channel: 'return', method: 'GET', query: {}, headers: {} }).valid, false);
  assert.equal(a.parseCallback({ channel: 'return', method: 'GET', query: { ref: 'a,b' }, headers: {} }).valid, false);
  // adapter không có sản phẩm C thì không nhận return
  const noPg = createSepayAdapter({ ...CREDS, authMode: 'none' }, {});
  assert.equal(noPg.parseCallback({ channel: 'return', method: 'GET', query: { ref: 'BSNX1' }, headers: {} }).valid, false);
});

test('hoàn tiền cổng: manual_required (docs không có API hoàn cho đơn cổng)', async () => {
  const t = await setupProducts({ pg: true, adapterConfig: { refundApi: true } });
  try {
    await open(t, 'BSNRFD00001');
    await pay(t, 'BSNRFD00001');
    assert.deepEqual(await t.adapter.refund({ attemptRef: 'BSNRFD00001', refundRef: 'RF1', amount: 1000 }), { status: 'manual_required' });
  } finally { await t.teardown(); }
});

'use strict';
// spec: SEPY-S-007
// spec: SEPY-S-004
// Sản phẩm B (VA theo đơn): adapter + simulator. Simulator và test này chỉ chứng minh adapter khớp GIẢ ĐỊNH đã ghi trong SEPY-D-004
// (docs-only, chưa có live), không chứng minh hành vi thật của SePay.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertAdapterShape, assertEvent } = require('../../src/contract.js');
const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
const { setupProducts, startReceiver, CREDS } = require('./helpers.js');

const orderOf = (t, ref) => t.sim.state.orders.find((o) => o.order_code === ref.toUpperCase());
const vaTx = (t) => t.sim.state.transactions.filter((x) => x.va);

test('capabilities của B theo cấu hình: hạn cứng, hoàn tiền, định dạng mã', async () => {
  const t = await setupProducts({ vaBank: 'Vietcombank', adapterConfig: { refundApi: true, va: { durationSeconds: 900 } } });
  try {
    assert.equal(assertAdapterShape(t.adapter), true);
    assert.deepEqual(t.adapter.capabilities('va-order'), {
      hardExpiry: { minutes: 15 }, cancellable: true, queryable: true, refundable: 'api', refundAsync: true, createCanTimeout: true, currencies: ['VND'], regions: ['VN'], methods: ['virtual_account'],
      referenceFormat: { prefix: 'BSN', maxLength: 15, caseInsensitive: true },
    });
    assert.equal(typeof t.adapter.cancel, 'function');
    assert.equal(typeof t.adapter.reconcileFeed, 'function');
  } finally { await t.teardown(); }
  const t2 = await setupProducts({ vaBank: 'BIDV' });
  try {
    const caps = t2.adapter.capabilities('va-order');
    assert.equal(caps.hardExpiry, 'none'); assert.equal(caps.refundable, 'manual'); assert.equal(caps.referenceFormat.maxLength, 50);
  } finally { await t2.teardown(); }
});

test('createPayment: mỗi ngân hàng gửi đúng tham số theo docs và trả hướng dẫn chuyển vào VA', async () => {
  for (const [bank, expectKeys] of [['BIDV', []], ['Sacombank', ['va_prefix']], ['Vietcombank', ['tid']], ['VietinBank', []]]) {
    const t = await setupProducts({ vaBank: bank, adapterConfig: { va: { durationSeconds: 900 } } });
    try {
      const r = await t.va('BSNABC123456', 150000);
      assert.equal(r.status, 'instructions', bank);
      const i = r.instructions;
      assert.equal(i.bank, bank);
      assert.match(i.accountNumber, /^963\d+$/); // số VA, không phải tài khoản chính
      assert.notEqual(i.accountNumber, '0123456789');
      assert.equal(i.amount, 150000); assert.equal(i.transferContent, undefined, 'VA nhận diện đơn: không có transferContent (PHUB-D-018, P3)'); assert.equal(i.orderCode, 'BSNABC123456');
      assert.equal(typeof r.state.orderId, 'string'); assert.deepEqual(r.state.vas, [i.accountNumber]); assert.ok(JSON.stringify(r.state).length < 2048);
      assert.match(i.qrUrl, /^https:\/\/vietqr\.app\/img\?acc=963/);
      const sent = orderOf(t, 'BSNABC123456').request;
      assert.equal(sent.order_code, 'BSNABC123456'); assert.equal(sent.amount, 150000); assert.equal(sent.with_qrcode, '1');
      for (const k of ['tid', 'va_prefix']) assert.equal(k in sent, expectKeys.includes(k), `${bank} ${k}`);
      if (bank === 'BIDV') assert.equal(r.expiresAt, undefined); // BIDV: expired_at null (docs-only)
      else {
        assert.ok(Number.isFinite(r.expiresAt)); assert.equal(sent.duration, 900);
        const left = Math.round((r.expiresAt - t.sim.clock.now()) / 1000);
        assert.ok(left >= 899 && left <= 900, `còn ${left}s`); // expired_at cắt xuống giây
      }
    } finally { await t.teardown(); }
  }
});

test('createPayment: thiếu tid/va_prefix bị SePay từ chối 4xx -> rejected (chắc chắn chưa tạo đơn)', async () => {
  const t = await setupProducts({ vaBank: 'Vietcombank', adapterConfig: { va: { tid: undefined, orderCodeMaxLength: 15 } } });
  try {
    t.cfg.va.tid = undefined;
    const a = t.newAdapter({ va: { bankAccountId: t.cfg.va.bankAccountId } });
    const r = await a.createPayment({ product: 'va-order', attemptRef: 'BSNMISSING01', amount: 1000 });
    assert.equal(r.status, 'rejected'); assert.match(r.reason, /422/);
    assert.equal(t.sim.state.orders.length, 0);
    const badTid = t.newAdapter({ va: { bankAccountId: t.cfg.va.bankAccountId, tid: '99999999' } });
    assert.match((await badTid.createPayment({ product: 'va-order', attemptRef: 'BSNBADTID01', amount: 1000 })).reason, /invalid_tid/);
    const uuidTid = t.newAdapter({ va: { bankAccountId: t.cfg.va.bankAccountId, tid: 'f9e8d7c6-b5a4-3210-fedc-ba0987654321' } });
    assert.match((await uuidTid.createPayment({ product: 'va-order', attemptRef: 'BSNUUIDTID1', amount: 1000 })).reason, /invalid_tid_format/);
  } finally { await t.teardown(); }
  const s = await setupProducts({ vaBank: 'Sacombank' });
  try {
    const a = s.newAdapter({ va: { bankAccountId: s.cfg.va.bankAccountId, vaPrefix: 'KHONG_CO' } });
    assert.equal((await a.createPayment({ product: 'va-order', attemptRef: 'BSNPREFIX01', amount: 1000 })).status, 'rejected');
  } finally { await s.teardown(); }
});

test('createPayment: kiểm tra mã và số tiền trước khi gọi mạng', async () => {
  const t = await setupProducts({ vaBank: 'Vietcombank' });
  try {
    for (const ref of ['ABC123456', 'BSN12', 'BSN-123456', 'BSN' + 'A'.repeat(13), '', undefined]) {
      const r = await t.va(ref, 1000);
      assert.equal(r.status, 'rejected', `phải từ chối ${ref}`);
    }
    for (const amount of [0, -5, 1.5, '1000', NaN]) assert.equal((await t.va('BSNOK12345', amount)).status, 'rejected');
    assert.equal(t.sim.state.orders.length, 0, 'không có request nào tới SePay');
    assert.equal((await t.va('BSN' + 'A'.repeat(12), 1000)).status, 'instructions'); // đúng 15 ký tự (Vietcombank)
  } finally { await t.teardown(); }
});

test('createPayment: trùng order_code (409) trả lại đúng hướng dẫn cũ, không tạo đơn thứ hai', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank' });
  try {
    const a = await t.va('BSNDUPE0001', 5000);
    const fresh = t.newAdapter(); // không có bộ nhớ đệm: phải tìm lại qua API
    const b = await fresh.createPayment({ product: 'va-order', attemptRef: 'BSNDUPE0001', amount: 5000 });
    assert.equal(b.status, 'instructions');
    assert.equal(b.instructions.accountNumber, a.instructions.accountNumber);
    assert.equal(t.sim.state.orders.length, 1);
  } finally { await t.teardown(); }
});

test('createPayment: SePay lỗi 5xx hoặc mất phản hồi -> unknown; đơn có thể đã tạo và vẫn tìm lại được', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank' });
  try {
    await t.control({ va_create_mode: 'fail_503' });
    assert.deepEqual(await t.va('BSNFAIL0001', 5000), { status: 'unknown' });
    assert.equal(t.sim.state.orders.length, 0);
    await t.control({ va_create_mode: 'lost_response' });
    assert.deepEqual(await t.va('BSNLOST0001', 5000), { status: 'unknown' });
    assert.equal(t.sim.state.orders.length, 1, 'đơn đã được tạo dù adapter không nhận được phản hồi');
    // Chưa có tiền: query không kết luận gì về tiền, nhưng cũng không nói "thất bại"
    assert.deepEqual(await t.adapter.query({ product: 'va-order', attemptRef: 'BSNLOST0001', createdAt: t.sim.clock.now() - 1000 }), { state: 'not_found' });
    await t.control({ va_create_mode: 'ok' });
    const again = await t.va('BSNLOST0001', 5000); // gửi lại cùng mã: nhận lại đơn cũ
    assert.equal(again.status, 'instructions'); assert.equal(t.sim.state.orders.length, 1);
    // tiền vào VA của đơn "bị mất phản hồi" vẫn nhận ra được
    await t.toVa(again, 5000);
    assert.equal(t.rcv.events.length, 1); assert.equal(t.rcv.events[0].attemptRef, 'BSNLOST0001');
  } finally { await t.teardown(); }
});

test('createPayment: 401 (token sai), 429 (rate limit), không có token -> rejected, không phải unknown', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', controls: { api_rate_limit: 1 } });
  try {
    assert.equal((await t.va('BSNRATE0001', 5000)).status, 'instructions');
    const r = await t.va('BSNRATE0002', 5000); // cùng giây ảo
    assert.equal(r.status, 'rejected'); assert.match(r.reason, /429/);
    const bad = t.newAdapter({ apiToken: 'sai' });
    assert.match((await bad.createPayment({ product: 'va-order', attemptRef: 'BSNRATE0003', amount: 1 })).reason, /401/);
    const none = t.newAdapter({ apiToken: '' });
    assert.equal((await none.createPayment({ product: 'va-order', attemptRef: 'BSNRATE0004', amount: 1000 })).status, 'rejected');
    assert.equal(t.sim.state.orders.length, 1);
  } finally { await t.teardown(); }
});

test('khách chuyển vào VA: webhook mang subAccount = VA, adapter gắn đúng attemptRef dù code là gì (docs mâu thuẫn về code)', async () => {
  for (const mode of ['null', 'order_code']) {
    const t = await setupProducts({ vaBank: 'VietinBank', controls: { va_code_mode: mode } });
    try {
      const r = await t.va('BSNPAYVA001', 150000);
      const tx = (await t.toVa(r, 150000, { content: 'noi dung bat ky cua khach' })).json.transaction;
      assert.equal(tx.subAccount, r.instructions.accountNumber);
      assert.equal(tx.code, mode === 'null' ? null : 'BSNPAYVA001');
      assert.equal(t.rcv.events.length, 1);
      const ev = t.rcv.events[0];
      assertEvent(ev);
      assert.equal(ev.attemptRef, 'BSNPAYVA001'); assert.equal(ev.amount, 150000); assert.equal(ev.type, 'received');
      assert.equal(ev.gatewayTxnId, tx.referenceCode);
      assert.equal(orderOf(t, 'BSNPAYVA001').status, 'Paid');
    } finally { await t.teardown(); }
  }
});

test('VA thắng nội dung: nội dung chuyển khoản ghi mã của đơn KHÁC vẫn tính cho đơn sở hữu VA', async () => {
  const t = await setupProducts({ vaBank: 'BIDV' });
  try {
    const a = await t.va('BSNOWNER001', 1000);
    await t.va('BSNOTHER001', 1000);
    await t.toVa(a, 1000, { content: 'BSNOTHER001 chuyen nham' });
    assert.equal(t.rcv.events[0].attemptRef, 'BSNOWNER001');
  } finally { await t.teardown(); }
});

test('sau khi khởi động lại (bộ nhớ đệm trống) webhook vẫn tìm ra đơn bằng cách quét danh sách, rồi đệm; quét lỗi thì retryLater', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', authMode: 'none', controls: { api_rate_limit: 1000 } });
  try {
    const r = await t.va('BSNRESTART1', 150000);
    const body = (id) => ({ id, gateway: 'x', transactionDate: '2026-10-02 10:00:00', accountNumber: '1', subAccount: r.instructions.accountNumber, code: null, content: 'x', transferType: 'in', description: '', transferAmount: 150000, accumulated: 0, referenceCode: `FT${id}` });
    const hook = (a, id) => a.parseCallback({ channel: 'ipn', method: 'POST', query: {}, headers: {}, body: body(id) });
    const cold = t.newAdapter(); // như sau khi khởi động lại
    const before = t.sim.state.apiCalls;
    assert.equal((await hook(cold, 1)).event.attemptRef, 'BSNRESTART1');
    assert.ok(t.sim.state.apiCalls > before, 'phải tra qua API');
    const after = t.sim.state.apiCalls;
    assert.equal((await hook(cold, 2)).event.attemptRef, 'BSNRESTART1');
    assert.equal(t.sim.state.apiCalls, after, 'lần hai dùng bộ nhớ đệm, không gọi thêm');
    // đệm trống và API đang quá tải: không đoán, ném lỗi
    const cold2 = t.newAdapter();
    await t.control({ api_rate_limit: 1 });
    t.sim.state.apiRequests.push(t.sim.clock.now()); // hạn mức của giây này đã dùng hết
    const later = await hook(cold2, 3);
    assert.equal(later.valid, true); assert.equal(later.retryLater, true); assert.equal(later.event, undefined, 'không đoán sự kiện khi chưa tra được VA');
    assert.equal(later.ack('error').status, 500, 'ack lỗi để SePay gửi lại');
  } finally { await t.teardown(); }
});

test('webhook gặp lỗi tra cứu tạm thời: adapter báo retryLater (Hub trả ack lỗi), SePay gửi lại theo lịch Fibonacci và lần sau thành công', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', controls: { api_rate_limit: 1 } });
  const cold = t.newAdapter(); // bên nhận dùng adapter có đệm trống
  const rcv2 = await startReceiver(cold);
  try {
    const r = await t.va('BSNRETRY001', 150000);
    t.sim.setWebhookUrl(rcv2.url);
    await t.advance(1);
    t.sim.state.apiRequests.push(t.sim.clock.now()); // API quá tải đúng lúc webhook đến
    await t.toVa(r, 150000);
    assert.equal(rcv2.errors.length, 1); assert.equal(rcv2.events.length, 0);
    const tx = vaTx(t)[0];
    assert.equal(tx.webhook.status, 'retrying');
    await t.advance(60); // lần gửi lại đầu tiên sau 1 phút
    assert.equal(rcv2.events.length, 1); assert.equal(rcv2.events[0].attemptRef, 'BSNRETRY001');
    assert.equal(tx.webhook.status, 'success');
  } finally { await rcv2.close(); await t.teardown(); }
});

test('VA lạ hoặc VA của đơn không phải của Hub: unmatched, không đoán từ nội dung; tra cứu âm được đệm', async () => {
  const t = await setupProducts({ vaBank: 'BIDV', authMode: 'none' });
  try {
    await t.va('BSNOWNVA001', 1000);
    // đơn do hệ thống khác tạo trên cùng tài khoản: order_code không mang tiền tố của Hub
    const r = await fetch(`${t.sim.url}/v2/bank-accounts/${t.sim.config.bankAccountId}/orders`, {
      method: 'POST', headers: { authorization: `Bearer ${CREDS.apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ order_code: 'OTHERSYS01', amount: 2000 }),
    });
    const foreign = (await r.json()).data.va_number;
    // khách chuyển vào VA của đơn khác nhưng ghi mã của Hub vào nội dung: vẫn là tiền của đơn khác
    await t.toVa({ instructions: { accountNumber: foreign } }, 2000, { content: 'BSNOWNVA001 ghi nham' });
    assert.equal(t.rcv.events.length, 1);
    assert.equal(t.rcv.events[0].unmatched, true); assert.equal(t.rcv.events[0].attemptRef, null);
    assert.equal(t.rcv.events[0].amount, 2000, 'tiền vẫn được ghi để Hub giữ làm khoản chưa rõ chủ');
    // subAccount không có trong danh sách đơn nào (ví dụ VA memo): rơi về code/nội dung, không có thì unmatched
    const hook = (id, content, sub = '963999999999') => t.adapter.parseCallback({ channel: 'ipn', headers: {}, body: { id, gateway: 'x', transactionDate: '2026-10-02 10:00:00', accountNumber: '1', subAccount: sub, code: null, content, transferType: 'in', description: '', transferAmount: 777, accumulated: 0, referenceCode: `FT${id}` } });
    assert.equal((await hook(5, 'khong co ma')).event.unmatched, true);
    const calls = t.sim.state.apiCalls;
    assert.equal((await hook(6, 'BSNOWNVA001 chuyen')).event.attemptRef, 'BSNOWNVA001', 'VA không thuộc đơn nào: cách của sản phẩm A');
    assert.equal(t.sim.state.apiCalls, calls, 'lần hai dùng kết quả âm đã đệm');
  } finally { await t.teardown(); }
});

test('VietinBank: trả thiếu -> Partially, bù đủ -> Paid; mỗi khoản một event received riêng', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank' });
  try {
    const r = await t.va('BSNPART0001', 150000);
    await t.toVa(r, 100000); await t.toVa(r, 50000);
    assert.deepEqual(t.rcv.events.map((e) => e.amount), [100000, 50000]);
    assert.ok(t.rcv.events.every((e) => e.attemptRef === 'BSNPART0001'));
    assert.equal(new Set(t.rcv.events.map((e) => e.gatewayTxnId)).size, 2);
    const o = orderOf(t, 'BSNPART0001');
    assert.equal(o.status, 'Paid'); assert.equal(o.paid_amount, 150000);
    const q = await t.adapter.query({ product: 'va-order', attemptRef: 'BSNPART0001', createdAt: t.sim.clock.now() - 1000 });
    assert.equal(q.length, 2); q.forEach(assertEvent);
  } finally { await t.teardown(); }
});

test('VietinBank: chuyển lớn hơn amount KHÔNG khớp VA (docs); webhook không có VA -> unmatched, có VA -> gắn attempt (cả hai đều ghi tiền)', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank' });
  try {
    const r = await t.va('BSNOVER0001', 100000);
    await t.toVa(r, 130000);
    const o = orderOf(t, 'BSNOVER0001');
    assert.equal(o.status, 'Pending', 'đơn không tự chuyển Paid');
    assert.equal(t.rcv.events.length, 1); assert.equal(t.rcv.events[0].unmatched, true, 'webhook không mang VA, nội dung rỗng: chưa rõ chủ');
    assert.equal(t.rcv.events[0].amount, 130000);
    await t.control({ va_unmatched_subaccount: 'va' });
    await t.toVa(r, 130000);
    assert.equal(t.rcv.events[1].attemptRef, 'BSNOVER0001'); assert.equal(t.rcv.events[1].amount, 130000);
  } finally { await t.teardown(); }
});

test('Sacombank/Vietcombank chỉ nhận đúng số tiền: chuyển sai thì ngân hàng từ chối (reject) hoặc tiền vẫn vào nhưng đơn không đổi (land)', async () => {
  for (const bank of ['Sacombank', 'Vietcombank']) {
    const t = await setupProducts({ vaBank: bank, controls: { va_mismatch_mode: 'reject' } });
    try {
      const r = await t.va('BSNEXACT001', 150000);
      const rejected = await t.toVa(r, 100000);
      assert.equal(rejected.status, 422); assert.equal(t.rcv.events.length, 0); assert.equal(vaTx(t).length, 0);
      await t.control({ va_mismatch_mode: 'land', va_unmatched_subaccount: 'va' });
      await t.toVa(r, 100000);
      assert.equal(orderOf(t, 'BSNEXACT001').status, 'Pending', bank);
      assert.equal(t.rcv.events[0].attemptRef, 'BSNEXACT001'); assert.equal(t.rcv.events[0].amount, 100000, 'adapter không biết "đủ hay thiếu": đó là việc của Hub');
      await t.toVa(r, 150000);
      assert.equal(orderOf(t, 'BSNEXACT001').status, 'Paid');
    } finally { await t.teardown(); }
  }
});

test('BIDV: đơn mở (không amount) nhận mọi số tiền; có amount thì Partially rồi Paid', async () => {
  const t = await setupProducts({ vaBank: 'BIDV' });
  try {
    const fetchOpen = await fetch(`${t.sim.url}/v2/bank-accounts/${t.sim.config.bankAccountId}/orders`, {
      method: 'POST', headers: { authorization: `Bearer ${CREDS.apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ order_code: 'BSNOPEN0001' }),
    });
    const open = await fetchOpen.json();
    assert.equal(open.data.amount, null);
    await t.toVa({ instructions: { accountNumber: open.data.va_number } }, 12345);
    assert.equal(orderOf(t, 'BSNOPEN0001').status, 'Paid');
    const r = await t.va('BSNBIDV0001', 100000);
    await t.toVa(r, 40000);
    assert.equal(orderOf(t, 'BSNBIDV0001').status, 'Partially');
    await t.toVa(r, 60000);
    assert.equal(orderOf(t, 'BSNBIDV0001').status, 'Paid');
  } finally { await t.teardown(); }
});

test('VA hết hạn hoặc đã hủy: ngân hàng từ chối (docs VietinBank) hoặc tiền vẫn vào (docs-silent các ngân hàng khác): tiền về muộn không bị mất', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', adapterConfig: { va: { durationSeconds: 600 } } });
  try {
    const r = await t.va('BSNEXPIRE01', 150000);
    assert.equal(t.adapter.capabilities('va-order').hardExpiry.minutes, 10);
    await t.advance(601);
    const rejected = await t.toVa(r, 150000);
    assert.equal(rejected.status, 422); assert.equal(t.rcv.events.length, 0);
    await t.control({ va_closed_mode: 'land', va_unmatched_subaccount: 'va' });
    await t.toVa(r, 150000);
    assert.equal(t.rcv.events.length, 1); assert.equal(t.rcv.events[0].attemptRef, 'BSNEXPIRE01');
    assert.equal(t.rcv.events[0].amount, 150000);
    assert.equal(orderOf(t, 'BSNEXPIRE01').status, 'Pending', 'đơn phía SePay không đổi trạng thái');
    // query không bao giờ nói "hết hạn"
    const q = await t.adapter.query({ product: 'va-order', attemptRef: 'BSNEXPIRE01', createdAt: t.sim.clock.now() - 700000 });
    assert.ok(Array.isArray(q) && q.every((e) => e.type === 'received'));
  } finally { await t.teardown(); }
});

test('hủy đơn: Pending hủy được; đã có tiền, Vietcombank từ chối, đơn lạ: cancelled=false (không bao giờ đoán)', async () => {
  const t = await setupProducts({ vaBank: 'Vietcombank' });
  try {
    const a = await t.va('BSNCANCEL01', 1000);
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCANCEL01' }), { cancelled: true });
    assert.equal(orderOf(t, 'BSNCANCEL01').status, 'Cancelled'); assert.equal(orderOf(t, 'BSNCANCEL01').va[0].status, 'Cancelled');
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCANCEL01' }), { cancelled: false }, 'đã hủy rồi: invalid_state');
    const b = await t.va('BSNCANCEL02', 1000);
    await t.toVa(b, 1000);
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCANCEL02' }), { cancelled: false }, 'đã trả tiền');
    const c = await t.va('BSNCANCEL03', 1000);
    await t.control({ va_vcb_cancel_refuse: true });
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNCANCEL03' }), { cancelled: false });
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'BSNKHONGCO1' }), { cancelled: false });
    assert.deepEqual(await t.adapter.cancel({ attemptRef: 'abc' }), { cancelled: false });
    // đã hủy mà tiền vẫn tới (ngân hàng không chặn): vẫn nhận ra
    await t.control({ va_closed_mode: 'land', va_unmatched_subaccount: 'va' });
    await t.toVa(a, 1000);
    assert.equal(t.rcv.events.at(-1).attemptRef, 'BSNCANCEL01');
    assert.ok(c);
  } finally { await t.teardown(); }
});

test('query: không có tiền -> not_found; có tiền -> các khoản; API lỗi -> unknown; đơn báo Paid mà sao kê không có -> unknown', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', controls: { api_rate_limit: 5 } });
  try {
    const r = await t.va('BSNQUERY001', 100000);
    const created = t.sim.clock.now() - 1000;
    await t.advance(1);
    assert.deepEqual(await t.adapter.query({ product: 'va-order', attemptRef: 'BSNQUERY001', createdAt: created }), { state: 'not_found' });
    assert.deepEqual(await t.adapter.query({ product: 'va-order', attemptRef: 'BSNKHONGCO2', createdAt: created }), { state: 'not_found' });
    await t.toVa(r, 100000);
    await t.advance(1);
    const q = await t.adapter.query({ product: 'va-order', attemptRef: 'BSNQUERY001', createdAt: created });
    assert.equal(q.length, 1); assert.equal(q[0].source, 'query'); assert.equal(q[0].amount, 100000);
    // sai token / mạng
    const bad = t.newAdapter({ apiToken: 'sai' });
    assert.deepEqual(await bad.query({ product: 'va-order', attemptRef: 'BSNQUERY001', createdAt: created }), { state: 'unknown' });
    const down = createSepayAdapter({ ...t.cfg, apiBaseUrl: 'http://127.0.0.1:1/v2', timeoutMs: 300 }, { clock: t.sim.clock });
    assert.deepEqual(await down.query({ product: 'va-order', attemptRef: 'BSNQUERY001', createdAt: created }), { state: 'unknown' });
    // dữ liệu không nhất quán: đơn Paid, sao kê không có khoản nào của VA
    const r2 = await t.va('BSNQUERY002', 5000);
    const o2 = orderOf(t, 'BSNQUERY002'); o2.status = 'Paid'; o2.paid_amount = 5000;
    await t.advance(1);
    assert.deepEqual(await t.adapter.query({ product: 'va-order', attemptRef: 'BSNQUERY002', createdAt: created }), { state: 'unknown' });
    assert.ok(r2);
  } finally { await t.teardown(); }
});

test('webhook mất: reconcileFeed tìm ra khoản VA (phân giải VA qua danh sách đơn); tiền ra và khoản không VA cũng có mặt đúng loại', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', controls: { webhook_drop: true, api_rate_limit: 1000 } });
  try {
    const r = await t.va('BSNFEED0001', 150000);
    await t.toVa(r, 150000);
    await t.sim.transfer({ content: 'khong co ma', amount: 3000 });
    await t.sim.transfer({ content: 'rut', amount: 1000, transferType: 'out' });
    assert.equal(t.rcv.requests.length, 0);
    const cold = t.newAdapter(); // đệm trống
    const feed = await cold.reconcileFeed({ now: t.sim.clock.now() });
    assert.equal(feed.events.length, 2);
    feed.events.forEach(assertEvent);
    assert.equal(feed.events[0].attemptRef, 'BSNFEED0001'); assert.equal(feed.events[1].unmatched, true);
  } finally { await t.teardown(); }
});

test('reconcileFeed: không phân giải được VA (API quá tải) thì dừng đúng ở hàng đó, con trỏ không đi qua; thử lại sau thì đủ', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', controls: { webhook_drop: true, api_rate_limit: 1 } });
  try {
    const r = await t.va('BSNFEED0002', 100000);
    await t.advance(1);
    await t.sim.transfer({ content: 'a', amount: 1000 }); // hàng đầu: không VA, không cần phân giải
    await t.toVa(r, 100000);
    const cold = t.newAdapter();
    await t.advance(1);
    // hạn mức 1 request/giây: trang sao kê dùng hết, quét đơn bị 429
    const first = await cold.reconcileFeed({ now: 0 });
    assert.equal(first.events.length, 1); assert.equal(first.events[0].unmatched, true);
    const cursor = first.nextCursor;
    assert.equal(cursor, String(t.sim.state.transactions[0].id), 'con trỏ dừng sau hàng không-VA, trước hàng VA');
    await t.advance(1);
    await assert.rejects(cold.reconcileFeed({ cursor, now: 0 }), /không tra được VA/, 'chưa phân giải được và chưa có tiến triển: ném lỗi để Hub thử lại, con trỏ giữ nguyên');
    await t.control({ api_rate_limit: 1000 });
    const third = await cold.reconcileFeed({ cursor, now: 0 });
    assert.equal(third.events.length, 1); assert.equal(third.events[0].attemptRef, 'BSNFEED0002');
  } finally { await t.teardown(); }
});

test('webhook VA trùng, gửi lại, và retry không làm đếm đôi (cùng gatewayTxnId)', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', controls: { webhook_duplicate: 3 } });
  try {
    const r = await t.va('BSNDUPEVA01', 50000);
    await t.toVa(r, 50000);
    assert.equal(t.rcv.events.length, 3);
    assert.equal(new Set(t.rcv.events.map((e) => e.gatewayTxnId)).size, 1);
    assert.ok(t.rcv.events.every((e) => e.attemptRef === 'BSNDUPEVA01'));
    const q = await t.adapter.query({ product: 'va-order', attemptRef: 'BSNDUPEVA01', createdAt: t.sim.clock.now() - 1000 });
    assert.equal(q[0].gatewayTxnId, t.rcv.events[0].gatewayTxnId, 'webhook và sao kê cùng khóa (referenceCode)');
  } finally { await t.teardown(); }
});

test('Refunds API (VietinBank): hoàn qua khoản thu gốc, khóa chống trùng theo refundRef, pending -> succeeded khi hết thời gian xử lý', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', adapterConfig: { refundApi: true } });
  try {
    assert.equal(t.adapter.capabilities('va-order').refundable, 'api');
    const r = await t.va('BSNREFUND01', 150000);
    await t.toVa(r, 100000); await t.toVa(r, 50000);
    const [t1, t2] = vaTx(t);
    const res = await t.adapter.refund({ attemptRef: 'BSNREFUND01', refundRef: 'RFAAAA01', amount: 50000, gatewayTxnId: t2.referenceCode, createdAt: t.sim.clock.now() - 1000 });
    assert.deepEqual(res, { status: 'processing' });
    assert.equal(t.sim.state.refunds.length, 1);
    assert.equal(t.sim.state.refunds[0].tx, t2.id, 'hoàn đúng khoản thu được chỉ định');
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RFAAAA01', attemptRef: 'BSNREFUND01' }), { status: 'processing' });
    await t.advance(61);
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RFAAAA01', attemptRef: 'BSNREFUND01' }), { status: 'succeeded' });
    // ngân sách theo từng khoản: không hoàn quá số đã thu của khoản đó
    const over = await t.adapter.refund({ attemptRef: 'BSNREFUND01', refundRef: 'RFAAAA02', amount: 60000, gatewayTxnId: t2.referenceCode, createdAt: t.sim.clock.now() - 100000 });
    assert.deepEqual(over, { status: 'failed' });
    // không chỉ định khoản: lấy khoản gần nhất đủ lớn
    const auto = await t.adapter.refund({ attemptRef: 'BSNREFUND01', refundRef: 'RFAAAA03', amount: 90000, createdAt: t.sim.clock.now() - 100000 });
    assert.deepEqual(auto, { status: 'processing' });
    assert.equal(t.sim.state.refunds.at(-1).tx, t1.id);
    // không khoản nào đủ lớn: giao người xử lý
    assert.deepEqual(await t.adapter.refund({ attemptRef: 'BSNREFUND01', refundRef: 'RFAAAA04', amount: 150000, createdAt: t.sim.clock.now() - 100000 }), { status: 'manual_required' });
  } finally { await t.teardown(); }
});

test('Refunds API: kết cục failed/rejected, cổng chặn (not_available, unsupported_bank), tắt refundApi -> manual_required', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', adapterConfig: { refundApi: true }, controls: { refund_final: 'rejected', refund_settle_seconds: 5 } });
  try {
    const r = await t.va('BSNREFUND02', 10000);
    await t.toVa(r, 10000);
    const base = { attemptRef: 'BSNREFUND02', amount: 10000, createdAt: t.sim.clock.now() - 1000 };
    assert.deepEqual(await t.adapter.refund({ ...base, refundRef: 'RFBBBB01' }), { status: 'processing' });
    await t.advance(6);
    assert.deepEqual(await t.adapter.queryRefund({ refundRef: 'RFBBBB01', attemptRef: 'BSNREFUND02' }), { status: 'failed' }, 'rejected là kết cục cuối: Hub coi là failed');
    await t.control({ refund_gate: 'not_available' });
    assert.deepEqual(await t.adapter.refund({ ...base, refundRef: 'RFBBBB02' }), { status: 'manual_required' });
    await t.control({ refund_gate: 'unsupported_bank' });
    assert.deepEqual(await t.adapter.refund({ ...base, refundRef: 'RFBBBB03' }), { status: 'manual_required' });
  } finally { await t.teardown(); }
  const off = await setupProducts({ vaBank: 'VietinBank' });
  try {
    const r = await off.va('BSNREFUND03', 10000);
    await off.toVa(r, 10000);
    assert.deepEqual(await off.adapter.refund({ attemptRef: 'BSNREFUND03', refundRef: 'RF1', amount: 10000 }), { status: 'manual_required' });
    assert.deepEqual(await off.adapter.queryRefund({ refundRef: 'RF1', attemptRef: 'BSNREFUND03' }), { status: 'manual_required' });
    assert.equal(off.sim.state.refunds.length, 0);
  } finally { await off.teardown(); }
});

test('Refunds API: mất phản hồi sau khi SePay đã tạo lệnh -> refund ném lỗi (không coi là failed), queryRefund tìm lại bản ghi, kể cả sau khởi động lại', async () => {
  for (const mode of ['lost_after_create', 'drop_response']) {
    const t = await setupProducts({ vaBank: 'VietinBank', adapterConfig: { refundApi: true }, controls: { refund_mode: mode } });
    try {
      const r = await t.va('BSNREFUND04', 20000);
      await t.toVa(r, 20000);
      const base = { attemptRef: 'BSNREFUND04', refundRef: 'RFCCCC01', amount: 20000, createdAt: t.sim.clock.now() - 1000 };
      await assert.rejects(t.adapter.refund(base), /sepay refund/);
      assert.equal(t.sim.state.refunds.length, 1, 'SePay đã có lệnh hoàn dù adapter không nhận được phản hồi');
      await t.control({ refund_mode: 'ok' });
      const restarted = t.newAdapter({ refundApi: true });
      assert.deepEqual(await restarted.queryRefund({ refundRef: 'RFCCCC01', attemptRef: 'BSNREFUND04', createdAt: base.createdAt }), { status: 'processing' });
      // gửi lại cùng khóa (cùng refundRef): không tạo lệnh thứ hai
      assert.deepEqual(await t.adapter.refund(base), { status: 'processing' });
      assert.equal(t.sim.state.refunds.length, 1);
    } finally { await t.teardown(); }
  }
  const busy = await setupProducts({ vaBank: 'VietinBank', adapterConfig: { refundApi: true }, controls: { refund_mode: 'busy_503' } });
  try {
    const r = await busy.va('BSNREFUND05', 20000);
    await busy.toVa(r, 20000);
    const base = { attemptRef: 'BSNREFUND05', refundRef: 'RFDDDD01', amount: 20000, createdAt: busy.sim.clock.now() - 1000 };
    await assert.rejects(busy.adapter.refund(base), /503/);
    assert.equal(busy.sim.state.refunds.length, 0);
    assert.deepEqual(await busy.adapter.queryRefund({ refundRef: 'RFDDDD01', attemptRef: 'BSNREFUND05', createdAt: base.createdAt }), { status: 'failed' }, 'SePay không có bản ghi: lệnh chưa từng tới nơi');
  } finally { await busy.teardown(); }
});

// ---------- P2/P4 (PHUB-D-018, SEPY-D-007): state và receipts ----------

test('P2: có state thì query/cancel/refund vào thẳng đơn, không quét danh sách đơn; không có state vẫn chạy bằng đường quét', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', adapterConfig: { refundApi: true }, controls: { api_rate_limit: 1000 } });
  try {
    const r = await t.va('BSNSTATE001', 150000);
    assert.ok(r.state && r.state.orderId && r.state.vas.length === 1);
    await t.toVa(r, 150000);
    const cold = t.newAdapter({ refundApi: true }); // như sau khi khởi động lại: đệm trống
    const cold2 = t.newAdapter({ refundApi: true });
    const q = { product: 'va-order', attemptRef: 'BSNSTATE001', createdAt: t.sim.clock.now() - 5000 };
    const c0 = t.sim.state.apiCalls;
    const withState = await cold.query({ ...q, state: r.state });
    const used = t.sim.state.apiCalls - c0;
    const c1 = t.sim.state.apiCalls;
    const without = await cold2.query(q);
    const usedScan = t.sim.state.apiCalls - c1;
    assert.equal(withState[0].type, 'received'); assert.equal(without[0].type, 'received');
    assert.equal(withState[0].gatewayTxnId, without[0].gatewayTxnId, 'cùng kết quả');
    assert.ok(used < usedScan, `có state phải ít request hơn (có ${used}, không ${usedScan})`);
    // refund có state trên adapter mới: hoàn đúng khoản
    const rf = await cold.refund({ attemptRef: 'BSNSTATE001', refundRef: 'RFSTATE01', amount: 1000, state: r.state, createdAt: t.sim.clock.now() - 5000 });
    assert.equal(rf.status, 'processing');
    // hủy với state trên đơn đã có tiền: SePay từ chối, adapter báo chưa hủy
    assert.deepEqual(await cold.cancel({ attemptRef: 'BSNSTATE001', state: r.state }), { cancelled: false });
  } finally { await t.teardown(); }
});

test('P2: query có state làm ấm bộ đệm VA -> mã, nên webhook sau khởi động lại không phải quét danh sách', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', authMode: 'none', controls: { api_rate_limit: 1000 } });
  try {
    const r = await t.va('BSNWARM0001', 150000);
    const cold = t.newAdapter();
    await cold.query({ product: 'va-order', attemptRef: 'BSNWARM0001', state: r.state, createdAt: t.sim.clock.now() - 5000 });
    const before = t.sim.state.apiCalls;
    const hook = await cold.parseCallback({ channel: 'ipn', method: 'POST', query: {}, headers: {}, body: { id: 77, gateway: 'x', transactionDate: '2026-10-02 10:00:00', accountNumber: '1', subAccount: r.instructions.accountNumber, code: null, content: 'x', transferType: 'in', description: '', transferAmount: 150000, accumulated: 0, referenceCode: 'FT77' } });
    assert.equal(hook.event.attemptRef, 'BSNWARM0001');
    assert.equal(t.sim.state.apiCalls, before, 'không gọi API nào để tra VA');
  } finally { await t.teardown(); }
});

test('P4: refund chỉ chọn trong các khoản thu Hub đưa (receipts), kể cả khi sao kê có khoản khác cùng VA', async () => {
  const t = await setupProducts({ vaBank: 'VietinBank', adapterConfig: { refundApi: true } });
  try {
    const r = await t.va('BSNRCPT0001', 300000);
    await t.toVa(r, 100000); await t.toVa(r, 200000);
    const [t1, t2] = vaTx(t);
    // Hub chỉ biết khoản đầu: phải hoàn trên khoản đầu dù khoản sau đủ lớn và gần nhất
    const res = await t.adapter.refund({ attemptRef: 'BSNRCPT0001', refundRef: 'RFRCPT01', amount: 50000, state: r.state, receipts: [{ txn: t1.referenceCode, amount: 100000 }], createdAt: t.sim.clock.now() - 1000 });
    assert.equal(res.status, 'processing');
    assert.equal(t.sim.state.refunds.at(-1).tx, t1.id);
    // receipts chứa khoản sau: chọn khoản sau
    await t.adapter.refund({ attemptRef: 'BSNRCPT0001', refundRef: 'RFRCPT02', amount: 150000, state: r.state, receipts: [{ txn: t2.referenceCode, amount: 200000 }], createdAt: t.sim.clock.now() - 1000 });
    assert.equal(t.sim.state.refunds.at(-1).tx, t2.id);
    // receipts không khớp hàng nào: lùi về cách cũ, không từ chối oan
    const fb = await t.adapter.refund({ attemptRef: 'BSNRCPT0001', refundRef: 'RFRCPT03', amount: 10000, receipts: [{ txn: 'KHONG-CO', amount: 1 }], createdAt: t.sim.clock.now() - 1000 });
    assert.equal(fb.status, 'processing');
  } finally { await t.teardown(); }
});

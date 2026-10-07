'use strict';
// spec: SEPY-S-001
// spec: SEPY-S-002
// spec: SEPY-S-003
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertEvent, ACK_OUTCOMES } = require('../../src/contract.js');
const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
const { setup, CREDS } = require('./helpers.js');

test('webhook trùng: hai event cùng gatewayTxnId (Hub phải khử trùng, adapter không giấu)', async () => {
  const t = await setup({ controls: { webhook_duplicate: 3 } });
  try {
    await t.transfer('BSNDUP001', 5000);
    assert.equal(t.rcv.events.length, 3);
    assert.equal(new Set(t.rcv.events.map((e) => e.gatewayTxnId)).size, 1);
  } finally { await t.teardown(); }
});

test('webhook gửi lại thủ công: cùng id', async () => {
  const t = await setup();
  try {
    const tx = await t.transfer('BSNRS001', 5000);
    const r = await t.call('POST', `/sim/webhook/${tx.id}/resend`);
    assert.equal(r.json.ok, true);
    assert.equal(t.rcv.events.length, 2);
    assert.equal(t.rcv.events[0].gatewayTxnId, t.rcv.events[1].gatewayTxnId);
  } finally { await t.teardown(); }
});

test('webhook mất hẳn: reconcileFeed và query tìm lại; tiền ra có trong sao kê nhưng không thành event; unmatched có mặt', async () => {
  const t = await setup({ controls: { webhook_drop: true } });
  try {
    const a = await t.transfer('BSNLOST01', 20000);
    await t.transfer('khong co ma', 3000);
    await t.transfer('rut', 1000, { transferType: 'out' });
    assert.equal(t.rcv.requests.length, 0);
    assert.equal(a.webhook.status, 'dropped');
    await t.advance(3600 * 5); // dù đợi lâu cũng không có
    assert.equal(t.rcv.requests.length, 0);

    const q = await t.adapter.query({ attemptRef: 'BSNLOST01' });
    assert.equal(q.length, 1); assert.equal(q[0].amount, 20000); assert.equal(q[0].gatewayTxnId, a.referenceCode);

    const feed = await t.adapter.reconcileFeed({ now: t.sim.clock.now() });
    assert.equal(feed.events.length, 2);
    feed.events.forEach(assertEvent);
    assert.equal(feed.events[0].attemptRef, 'BSNLOST01');
    assert.equal(feed.events[1].unmatched, true); assert.equal(feed.events[1].attemptRef, null);
  } finally { await t.teardown(); }
});

test('reconcileFeed phân trang đến hết và nhớ con trỏ', async () => {
  const t = await setup({ controls: { webhook_drop: true } });
  try {
    for (let i = 0; i < 205; i += 1) await t.sim.transfer({ content: `BSNP${i}`, amount: 1000 + i });
    const feed = await t.adapter.reconcileFeed({ now: 0 });
    assert.equal(feed.events.length, 205);
    assert.equal(new Set(feed.events.map((e) => e.gatewayTxnId)).size, 205);
    await t.sim.transfer({ content: 'BSNNEW1', amount: 5000 });
    const next = await t.adapter.reconcileFeed({ cursor: feed.nextCursor, now: 0 });
    assert.equal(next.events.length, 1); assert.equal(next.events[0].attemptRef, 'BSNNEW1');
  } finally { await t.teardown(); }
});

test('đảo thứ tự: giao dịch cũ đến sau giao dịch mới, adapter vẫn phát đủ hai event', async () => {
  const t = await setup({ controls: { webhook_reorder: true } });
  try {
    const first = await t.transfer('BSNORDA', 1000);
    assert.equal(t.rcv.events.length, 0); // đang bị giữ
    const second = await t.transfer('BSNORDB', 2000);
    assert.deepEqual(t.rcv.events.map((e) => e.gatewayTxnId), [second.referenceCode, first.referenceCode]);
    const third = await t.transfer('BSNORDC', 3000); // bị giữ, giải phóng bằng flush
    await t.call('POST', '/sim/webhook/flush');
    assert.equal(t.rcv.events.at(-1).gatewayTxnId, third.referenceCode);
  } finally { await t.teardown(); }
});

test('thiếu/thừa/nhiều khoản cho một mã: mỗi khoản một event received riêng, không gom', async () => {
  const t = await setup();
  try {
    await t.transfer('BSNMULTI1', 100000); // thiếu (giả sử cần 150000)
    await t.transfer('BSNMULTI1', 60000);  // bù, tổng thừa
    await t.transfer('bsnmulti1 lan 3', 150000);
    assert.equal(t.rcv.events.length, 3);
    assert.deepEqual(t.rcv.events.map((e) => e.amount), [100000, 60000, 150000]);
    assert.ok(t.rcv.events.every((e) => e.attemptRef === 'BSNMULTI1'));
    assert.equal(new Set(t.rcv.events.map((e) => e.gatewayTxnId)).size, 3);
    const q = await t.adapter.query({ attemptRef: 'BSNMULTI1' });
    assert.equal(q.length, 3);
  } finally { await t.teardown(); }
});

test('query không khớp nhầm mã có tiền tố trùng (BSNAB1 vs BSNAB12)', async () => {
  const t = await setup();
  try {
    await t.transfer('BSNAB12', 1000);
    assert.deepEqual(await t.adapter.query({ attemptRef: 'BSNAB1' }), { state: 'not_found' });
  } finally { await t.teardown(); }
});

test('ngân hàng sửa nội dung: lowercase, bỏ gạch, thêm tiền tố vẫn khớp; cắt ngắn gây mã sai hoặc unmatched', async () => {
  const t = await setup();
  try {
    await t.control({ content_mangle: 'lowercase' });
    await t.transfer('BSNMG001', 1000);
    await t.control({ content_mangle: 'strip_dashes' });
    await t.transfer('BSNMG002 DH-77', 1000);
    await t.control({ content_mangle: 'prefix:CK ' });
    await t.transfer('BSNMG003', 1000);
    assert.deepEqual(t.rcv.events.map((e) => e.attemptRef), ['BSNMG001', 'BSNMG002', 'BSNMG003']);
    assert.equal(t.rcv.events[0].content, 'bsnmg001');
    assert.equal(t.rcv.events[2].content, 'CK BSNMG003');

    await t.control({ content_mangle: 'truncate:6' }); // BSNMG0 : mã cụt, adapter không thể biết -> Hub gặp attempt lạ
    await t.transfer('BSNMG004', 1000);
    assert.equal(t.rcv.events[3].attemptRef, 'BSNMG0');
    await t.control({ content_mangle: 'truncate:3' }); // chỉ còn tiền tố: unmatched
    await t.transfer('BSNMG005', 1000);
    assert.equal(t.rcv.events[4].unmatched, true);
  } finally { await t.teardown(); }
});

test('ack_mode docs: 200 + sai body bị tính thất bại và retry; any2xx coi là xong', async () => {
  const t = await setup({ controls: { ack_mode: 'docs' } });
  try {
    t.rcv.mode = 'wrong_body';
    const tx = await t.transfer('BSNACK001', 1000);
    assert.equal(tx.webhook.status, 'retrying');
    assert.equal(tx.webhook.attempts.length, 1); assert.equal(tx.webhook.attempts[0].httpStatus, 200); assert.equal(tx.webhook.attempts[0].ok, false);
    await t.control({ ack_mode: 'any2xx' });
    const tx2 = await t.transfer('BSNACK002', 1000);
    assert.equal(tx2.webhook.status, 'success'); assert.equal(tx2.webhook.attempts.length, 1);
  } finally { await t.teardown(); }
});

test('retry Fibonacci theo đồng hồ ảo: 8 lần gửi tại 0,1,2,4,7,12,20,33 phút rồi failed; reconcile cứu được', async () => {
  const t = await setup();
  try {
    t.rcv.mode = 'fail';
    const tx = await t.transfer('BSNRET001', 1000);
    const t0 = tx.createdAt;
    await t.advance(59); assert.equal(t.rcv.requests.length, 1);
    await t.advance(1); assert.equal(t.rcv.requests.length, 2);
    await t.advance(3600); // cuộn hết lịch
    const st = (await t.call('GET', '/sim/transactions')).json;
    const attempts = st.transactions[0].webhook.attempts;
    assert.equal(attempts.length, 8);
    assert.deepEqual(attempts.map((a) => (a.at - t0) / 60000), [0, 1, 2, 4, 7, 12, 20, 33]);
    assert.equal(st.transactions[0].webhook.status, 'failed');
    assert.equal(st.queue.length, 0);
    assert.equal(t.rcv.events.length, 0);
    const feed = await t.adapter.reconcileFeed({ now: t.sim.clock.now() });
    assert.equal(feed.events[0].attemptRef, 'BSNRET001');
  } finally { await t.teardown(); }
});

test('retry thành công giữa chừng thì dừng, số lần và khoảng cấu hình được', async () => {
  const t = await setup({ controls: { webhook_retry_max_attempts: 3, webhook_retry_intervals_minutes: [2] } });
  try {
    t.rcv.failFirst = 1;
    await t.transfer('BSNRET002', 1000);
    await t.advance(119); assert.equal(t.rcv.requests.length, 1);
    await t.advance(1);
    assert.equal(t.rcv.requests.length, 2); assert.equal(t.rcv.events.length, 1);
    await t.advance(3600); assert.equal(t.rcv.requests.length, 2);
  } finally { await t.teardown(); }
});

test('webhook trễ: không có gì đến trước hạn, đến đúng hạn sau khi tua đồng hồ', async () => {
  const t = await setup({ controls: { webhook_delay_seconds: 120 } });
  try {
    await t.transfer('BSNDL001', 1000);
    assert.equal(t.rcv.requests.length, 0);
    await t.advance(119); assert.equal(t.rcv.requests.length, 0);
    await t.advance(1); assert.equal(t.rcv.events.length, 1);
  } finally { await t.teardown(); }
});

test('webhook sai xác thực (khóa/chữ ký sai, timestamp lệch): adapter từ chối, ack 401, không có event', async () => {
  for (const authMode of ['apikey', 'hmac']) {
    const t = await setup({ authMode, controls: { webhook_bad_auth: true, webhook_retry_max_attempts: 1 } });
    try {
      const tx = await t.transfer('BSNBAD001', 1000);
      assert.equal(t.rcv.results[0].valid, false);
      assert.equal(tx.webhook.attempts[0].httpStatus, 401);
      assert.equal(t.rcv.events.length, 0);
    } finally { await t.teardown(); }
  }
  const t = await setup({ authMode: 'hmac', controls: { hmac_timestamp_skew_seconds: -400, webhook_retry_max_attempts: 1 } });
  try {
    await t.transfer('BSNBAD002', 1000);
    assert.equal(t.rcv.results[0].reason, 'timestamp_skew');
    assert.equal(t.rcv.events.length, 0);
  } finally { await t.teardown(); }
});

test('API: token sai (401), vượt 3 request/giây (429) -> query trả unknown, không bao giờ not_found', async () => {
  const t = await setup({ controls: { api_rate_limit: 3 } });
  try {
    await t.transfer('BSNAPI001', 1000);
    // 401: simulator trả đúng dạng đã thấy ở probe
    const noAuth = await fetch(`${t.sim.url}/v2/transactions`);
    assert.equal(noAuth.status, 401); assert.equal(noAuth.headers.get('x-ratelimit-limit'), '3');
    assert.deepEqual(await noAuth.json(), { status: 'error', message: 'Missing Authorization header', error_code: 'unauthorized' });
    const badTok = await fetch(`${t.sim.url}/v2/transactions`, { headers: { authorization: 'Bearer nope' } });
    assert.equal((await badTok.json()).message, 'Invalid Auth token');
    const wrong = createSepayAdapter({ ...CREDS, apiToken: 'wrong', apiBaseUrl: `${t.sim.url}/v2`, authMode: 'none' }, { clock: t.sim.clock });
    assert.deepEqual(await wrong.query({ attemptRef: 'BSNAPI001' }), { state: 'unknown' });
    await assert.rejects(wrong.reconcileFeed({ now: 0 }));
    const noTok = createSepayAdapter({ ...CREDS, apiToken: '', apiBaseUrl: `${t.sim.url}/v2`, authMode: 'none' }, { clock: t.sim.clock });
    assert.deepEqual(await noTok.query({ attemptRef: 'BSNAPI001' }), { state: 'unknown' });

    // 429: đồng hồ ảo đứng yên nên bốn request liên tiếp cùng một giây
    const r = [];
    for (let i = 0; i < 4; i += 1) r.push(await t.adapter.query({ attemptRef: 'BSNAPI001' }));
    assert.ok(Array.isArray(r[0]) && Array.isArray(r[2]));
    assert.deepEqual(r[3], { state: 'unknown' });
    const raw = await fetch(`${t.sim.url}/v2/transactions`, { headers: { authorization: `Bearer ${CREDS.apiToken}` } });
    assert.equal(raw.status, 429); assert.equal(raw.headers.get('retry-after'), '1');
    await t.advance(1);
    assert.ok(Array.isArray(await t.adapter.query({ attemptRef: 'BSNAPI001' })));
  } finally { await t.teardown(); }
});

test('mạng hỏng: query unknown, reconcileFeed ném lỗi', async () => {
  const a = createSepayAdapter({ ...CREDS, apiBaseUrl: 'http://127.0.0.1:1/v2', timeoutMs: 500 }, { clock: { now: () => 0 } });
  assert.deepEqual(await a.query({ attemptRef: 'BSNX1' }), { state: 'unknown' });
  await assert.rejects(a.reconcileFeed({ now: 0 }));
});

test('rủi ro A12: id API là UUID khác id webhook; adapter dùng referenceCode nên gatewayTxnId hai kênh vẫn trùng', async () => {
  const t = await setup({ controls: { api_id_format: 'uuid' } });
  try {
    await t.transfer('BSNUU001', 1000);
    const q = await t.adapter.query({ attemptRef: 'BSNUU001' });
    assert.equal(q[0].gatewayTxnId, t.rcv.events[0].gatewayTxnId);
    assert.match(q[0].gatewayTxnId, /^FT/);
    // cursor kiểu UUID vẫn chạy được
    const feed = await t.adapter.reconcileFeed({ now: 0 });
    assert.equal((await t.adapter.reconcileFeed({ cursor: feed.nextCursor, now: 0 })).events.length, 0);
  } finally { await t.teardown(); }
});

test('ack(outcome) cho mọi outcome của hợp đồng', () => {
  const a = createSepayAdapter({ ...CREDS, authMode: 'none' }, { clock: { now: () => 0 } });
  const { ack } = a.parseCallback({ channel: 'ipn', headers: {}, body: { id: 1, transferType: 'out', transferAmount: 5 } });
  for (const o of ['ok', 'duplicate', 'unknown_attempt', 'amount_mismatch']) {
    assert.deepEqual(ack(o), { status: 200, body: '{"success":true}', contentType: 'application/json' }, o);
  }
  assert.deepEqual(ack('invalid_signature'), { status: 401, body: '{"success":false}', contentType: 'application/json' });
  assert.deepEqual(ack('error'), { status: 500, body: '{"success":false}', contentType: 'application/json' });
  for (const o of ACK_OUTCOMES) assert.ok(ack(o).status >= 200, o);
  // ack trả về cũng có trên kết quả sai xác thực
  const bad = createSepayAdapter({ ...CREDS, authMode: 'apikey' }, { clock: { now: () => 0 } }).parseCallback({ channel: 'ipn', headers: {}, body: {} });
  assert.equal(bad.valid, false); assert.equal(bad.ack('invalid_signature').status, 401);
});

test('A12 khi referenceCode rỗng và id hai kênh khác nhau: gatewayTxnId lệch (rủi ro còn lại, chưa kiểm chứng)', async () => {
  const t = await setup({ controls: { api_id_format: 'uuid', reference_code_empty: true } });
  try {
    await t.transfer('BSNUU002', 1000);
    const q = await t.adapter.query({ attemptRef: 'BSNUU002' });
    assert.notEqual(q[0].gatewayTxnId, t.rcv.events[0].gatewayTxnId);
  } finally { await t.teardown(); }
});

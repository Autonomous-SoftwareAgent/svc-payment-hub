'use strict';
// spec: STRP-S-001
// Chữ ký webhook (STRP-D-001): "t=<giây>,v1=<hex>", HMAC-SHA256 của "t.thân thô" với NGUYÊN chuỗi whsec_..., so sánh hằng thời gian,
// dung sai 300 giây HAI CHIỀU. Golden vector tự tính bằng Node (không phải vector chính thức của Stripe): xem docs/agent/stripe-research.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStripeAdapter } = require('../../src/adapters/stripe/index.js');

const SECRET = 'whsec_test_secret';
const T = 1600000000;
const PAYLOAD = '{"id":"evt_test","object":"event"}';
const GOLDEN = '3c0fbe55485b76c3981997cefaa60839fa2293573bbe6629c70388927aee6b82';
const sign = (secret, t, raw) => crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
const mk = (webhookSecret = SECRET, now = T * 1000) => createStripeAdapter({ secretKey: 'sk_test_x', webhookSecret }, { clock: { now: () => now }, fetch: async () => { throw new Error('không gọi mạng'); } });
const check = (adapter, raw, header) => adapter.parseCallback({ channel: 'ipn', method: 'POST', query: {}, body: raw, rawBody: raw, headers: { 'stripe-signature': header } });

test('golden vector: chữ ký tự tính khớp hằng số đã ghi (bắt đổi nhầm thuật toán hoặc chuỗi được ký)', () => {
  assert.equal(sign(SECRET, T, PAYLOAD), GOLDEN);
});

test('chữ ký đúng (sự kiện không mang tin về tiền): valid=true, không có event', async () => {
  const r = await check(mk(), PAYLOAD, `t=${T},v1=${GOLDEN}`);
  assert.equal(r.valid, true);
  assert.equal(r.event, undefined);
});

test('từ chối: thân bị sửa, secret sai, thiếu t, thiếu v1, chỉ có v0, header rỗng, không phải chuỗi', async () => {
  const a = mk();
  const bad = [
    [PAYLOAD + ' ', `t=${T},v1=${GOLDEN}`],
    [PAYLOAD, `t=${T},v1=${sign('whsec_khac', T, PAYLOAD)}`],
    [PAYLOAD, `v1=${GOLDEN}`],
    [PAYLOAD, `t=${T}`],
    [PAYLOAD, `t=${T},v0=${GOLDEN}`],
    [PAYLOAD, `t=abc,v1=${GOLDEN}`],
    [PAYLOAD, ''],
    [PAYLOAD, undefined],
    [null, `t=${T},v1=${GOLDEN}`],
  ];
  for (const [raw, h] of bad) assert.equal((await check(a, raw, h)).valid, false, String(h));
});

test('dung sai 300 giây HAI chiều: cũ quá hoặc ở tương lai quá đều bị từ chối; sát ngưỡng vẫn nhận', async () => {
  const header = `t=${T},v1=${GOLDEN}`;
  assert.equal((await check(mk(SECRET, (T + 300) * 1000), PAYLOAD, header)).valid, true);
  assert.equal((await check(mk(SECRET, (T + 301) * 1000), PAYLOAD, header)).valid, false); // quá cũ
  assert.equal((await check(mk(SECRET, (T - 300) * 1000), PAYLOAD, header)).valid, true);
  assert.equal((await check(mk(SECRET, (T - 301) * 1000), PAYLOAD, header)).valid, false); // ở tương lai (SDK không chặn, Hub chặn)
});

test('nhiều v1 trong một header (xoay khóa): chỉ cần một cái khớp; nhiều secret cấu hình: khớp secret nào cũng được', async () => {
  const a = mk();
  assert.equal((await check(a, PAYLOAD, `t=${T},v1=${'0'.repeat(64)},v1=${GOLDEN}`)).valid, true);
  const rot = mk(['whsec_cu', SECRET]);
  assert.equal((await check(rot, PAYLOAD, `t=${T},v1=${GOLDEN}`)).valid, true);
  assert.equal((await check(rot, PAYLOAD, `t=${T},v1=${sign('whsec_cu', T, PAYLOAD)}`)).valid, true);
  assert.equal((await check(rot, PAYLOAD, `t=${T},v1=${sign('whsec_khac', T, PAYLOAD)}`)).valid, false);
});

test('khóa là NGUYÊN chuỗi whsec_ (không bỏ tiền tố, không giải base64)', async () => {
  const wrongInterpretation = sign(SECRET.replace(/^whsec_/, ''), T, PAYLOAD);
  assert.notEqual(wrongInterpretation, GOLDEN);
  assert.equal((await check(mk(), PAYLOAD, `t=${T},v1=${wrongInterpretation}`)).valid, false);
});

test('chữ ký đúng nhưng thân không phải JSON: không hợp lệ (lỗi phía gửi); thiếu secret khi dựng adapter: báo lỗi ngay', async () => {
  const raw = 'khong-phai-json';
  assert.equal((await check(mk(), raw, `t=${T},v1=${sign(SECRET, T, raw)}`)).valid, false);
  assert.throws(() => createStripeAdapter({ secretKey: 'sk_test_x' }), /thiếu config webhookSecret/);
  assert.throws(() => createStripeAdapter({ webhookSecret: 'x' }), /thiếu config secretKey/);
});

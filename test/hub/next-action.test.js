'use strict';
// spec: PHUB-S-035
// Bước tiếp theo cho khách dạng dữ liệu chuẩn (PHUB-D-035): redirect, post_redirect, challenge (3DS), poll, qr, deeplink, transfer.
// Bốn adapter hiện có không đổi: Hub suy nextAction từ trường cũ; adapter mới khai thẳng bằng status 'next_action'.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentHub } = require('../../src/hub');
const { checkNextAction, checkCreateResult, NEXT_ACTION_TYPES } = require('../../src/contract');
const { attemptView } = require('../../src/app/views');
const { createFakeAdapter, createClock } = require('../support/fake-adapter');

const hubOf = (adapter) => new PaymentHub({ adapters: { [adapter.id]: adapter }, clock: createClock(), config: { gateways: [{ id: adapter.id }] } });
const order = (o = {}) => ({ orderId: `O${Math.random().toString(36).slice(2, 8)}`, amount: 100000, returnUrl: 'https://s/r', ...o });
const transfer = { bank: 'TESTBANK', accountNumber: '0123456789', amount: 100000 };

test('checkNextAction: mỗi loại cần đúng trường; loại lạ và sai hình dạng bị từ chối', () => {
  const ok = [
    { type: 'redirect', url: 'https://x/pay' },
    { type: 'post_redirect', url: 'https://x/pay', fields: { a: '1' } },
    { type: 'challenge', url: 'https://acs.test/3ds' },
    { type: 'deeplink', url: 'app://pay' },
    { type: 'poll' },
    { type: 'poll', afterSeconds: 5 },
    { type: 'qr', data: '000201...' },
    { type: 'qr', imageUrl: 'https://x/qr.png' },
    { type: 'transfer', instructions: transfer },
  ];
  for (const na of ok) assert.equal(checkNextAction(na), null, JSON.stringify(na));
  const bad = [
    null, 'redirect', [], {}, { type: 'teleport' },
    { type: 'redirect' }, { type: 'challenge', url: '' }, { type: 'deeplink' },
    { type: 'post_redirect', url: 'https://x' }, { type: 'post_redirect', url: 'https://x', fields: { a: 1 } },
    { type: 'poll', afterSeconds: 0 }, { type: 'poll', afterSeconds: 1.5 },
    { type: 'qr' }, { type: 'transfer' }, { type: 'transfer', instructions: { bank: 'B' } }, { type: 'transfer', instructions: { ...transfer, amount: 1.5 } },
  ];
  for (const na of bad) assert.equal(typeof checkNextAction(na), 'string', JSON.stringify(na));
  assert.deepEqual(NEXT_ACTION_TYPES, ['redirect', 'post_redirect', 'challenge', 'poll', 'qr', 'deeplink', 'transfer']);
});

test('checkCreateResult: kết quả next_action sai hình dạng bị bắt', () => {
  assert.equal(checkCreateResult({ status: 'next_action', nextAction: { type: 'challenge', url: 'https://acs/3ds' } }), null);
  assert.match(checkCreateResult({ status: 'next_action', nextAction: { type: 'challenge' } }), /thiếu url/);
  assert.match(checkCreateResult({ status: 'next_action' }), /nextAction rỗng/);
});

test('adapter khai next_action challenge (3DS): attempt AWAITING, lưu nextAction, không có trường cũ nào được bịa ra', async () => {
  const a = createFakeAdapter('a');
  a.createMode = 'next_action';
  a.nextAction = { type: 'challenge', url: 'https://acs.test/3ds?t=1' };
  const { attempt } = await hubOf(a).createPayment(order());
  assert.equal(attempt.status, 'AWAITING');
  assert.deepEqual(attempt.nextAction, a.nextAction);
  assert.equal(attempt.url, null);
  assert.equal(attempt.instructions, undefined);
  assert.deepEqual(attemptView(attempt).nextAction, a.nextAction);
  assert.equal(attemptView(attempt).url, null); // cửa hàng cũ không thấy gì sai
});

test('next_action kiểu tương đương trường cũ thì điền cả trường cũ: cửa hàng cũ vẫn dùng được', async () => {
  const a = createFakeAdapter('a');
  a.createMode = 'next_action';
  a.nextAction = { type: 'post_redirect', url: 'https://x/pay', fields: { sig: 'S' } };
  const { attempt } = await hubOf(a).createPayment(order());
  const v = attemptView(attempt);
  assert.equal(v.url, 'https://x/pay');
  assert.equal(v.method, 'POST');
  assert.deepEqual(v.fields, { sig: 'S' });
  assert.deepEqual(v.nextAction, a.nextAction);

  a.nextAction = { type: 'transfer', instructions: transfer };
  const t = await hubOf(a).createPayment(order());
  assert.deepEqual(attemptView(t.attempt).instructions, transfer);
});

test('nextAction sai hình dạng: cổng có thể đã tạo giao dịch nên attempt thành UNKNOWN (không bỏ), có ghi sự kiện', async () => {
  const a = createFakeAdapter('a');
  a.createMode = 'next_action';
  a.nextAction = { type: 'challenge' }; // thiếu url
  const hub = hubOf(a);
  const { attempt } = await hub.createPayment(order());
  assert.equal(attempt.status, 'UNKNOWN');
  assert.equal(attempt.nextAction, undefined);
  assert.ok(hub.store.events.some((e) => e.outcome === 'bad_create_result' && /thiếu url/.test(e.detail)));
});

test('attemptView suy nextAction từ bốn adapter hiện có (trường cũ), null khi không có bước nào', async () => {
  const redirect = createFakeAdapter('a');
  const r = await hubOf(redirect).createPayment(order());
  assert.deepEqual(attemptView(r.attempt).nextAction, { type: 'redirect', url: r.attempt.url });

  const post = createFakeAdapter('a');
  post.createMode = 'post_form';
  const p = await hubOf(post).createPayment(order());
  assert.deepEqual(attemptView(p.attempt).nextAction, { type: 'post_redirect', url: p.attempt.url, fields: p.attempt.fields });

  const ins = createFakeAdapter('a');
  ins.createMode = 'instructions';
  const i = await hubOf(ins).createPayment(order());
  assert.equal(attemptView(i.attempt).nextAction.type, 'transfer');
  assert.deepEqual(attemptView(i.attempt).nextAction.instructions, i.attempt.instructions);

  assert.equal(attemptView({ id: 'x', status: 'FAILED' }).nextAction, null);
});

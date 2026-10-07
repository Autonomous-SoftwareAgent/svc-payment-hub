'use strict';
// spec: PYPL-S-002
// Chữ ký webhook PayPal: RSA-SHA256 trên transmissionId|time|webhookId|crc32(thân thô), chứng chỉ từ paypal-cert-url chỉ từ máy chủ được phép.
// Chữ ký ở đây do simulator ký bằng khóa sinh lúc chạy: chưa kiểm với chứng chỉ PayPal thật.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { createPaypalAdapter } = require('../../src/adapters/paypal');

async function oneWebhook(t) {
  const c = await t.create('REF1');
  await t.control({ drop_types: [] });
  await t.approve(c); // sinh CHECKOUT.ORDER.APPROVED
  return t.rcv.received[0];
}

test('chữ ký đúng được nhận, sai một byte của thân thì không', async () => {
  const t = await setup();
  try {
    const d = await oneWebhook(t);
    assert.equal((await t.parse(d)).valid, true);
    const tampered = { ...d, raw: d.raw.replace('REF1', 'REF2') };
    const r = await t.parse(tampered);
    assert.equal(r.valid, false);
    assert.equal(r.ack('invalid_signature').status, 400);
    assert.equal((await t.parse({ ...d, raw: `${d.raw} ` })).valid, false, 'crc32 tính trên thân thô: thêm khoảng trắng cũng sai');
  } finally { await t.teardown(); }
});

test('sai id, thời gian, chữ ký, thuật toán hoặc thiếu header: không hợp lệ', async () => {
  const t = await setup();
  try {
    const d = await oneWebhook(t);
    const h = d.headers;
    for (const [name, v] of [['paypal-transmission-id', 'khac'], ['paypal-transmission-time', '2020-01-01T00:00:00Z'], ['paypal-transmission-sig', Buffer.from('x').toString('base64')], ['paypal-auth-algo', 'SHA1withRSA']]) {
      assert.equal((await t.parse(d, { ...h, [name]: v })).valid, false, name);
    }
    for (const name of ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo']) {
      const { [name]: _drop, ...rest } = h;
      assert.equal((await t.parse(d, rest)).valid, false, `thiếu ${name}`);
    }
    assert.equal((await t.parse({ raw: d.raw }, undefined)).valid, false);
  } finally { await t.teardown(); }
});

test('webhookId của ta khác: không hợp lệ; nhiều webhookId thì khớp một trong số đó', async () => {
  const t = await setup({ adapter: { webhookId: 'WH-KHAC' } });
  try {
    const d = await oneWebhook(t);
    assert.equal((await t.parse(d)).valid, false);
    const ok = createPaypalAdapter({ clientId: 'a', clientSecret: 'b', webhookId: ['WH-KHAC', t.sim.config.webhookId], certHosts: ['127.0.0.1'], certUrlAllowHttp: true, baseUrl: t.sim.url }, { fetch: globalThis.fetch, clock: t.sim.clock });
    assert.equal((await ok.parseCallback({ channel: 'ipn', body: d.raw, rawBody: d.raw, headers: d.headers, query: {} })).valid, true);
  } finally { await t.teardown(); }
});

test('khóa ký khác (kẻ giả mạo): không hợp lệ, và không sinh sự kiện tiền', async () => {
  const t = await setup({ controls: { bad_signature: true } });
  try {
    const d = await oneWebhook(t);
    const r = await t.parse(d);
    assert.equal(r.valid, false);
    assert.equal(r.event, undefined);
    assert.equal((await t.state()).captures.length, 0, 'thông báo giả không khiến adapter thu tiền');
  } finally { await t.teardown(); }
});

test('paypal-cert-url ở máy chủ lạ hoặc http: bị từ chối TRƯỚC khi tải gì (không bị dẫn tới địa chỉ tùy ý)', async () => {
  const t = await setup();
  try {
    const d = await oneWebhook(t);
    const seen = [];
    const spy = async (url, init) => { seen.push(String(url)); return globalThis.fetch(url, init); };
    const mk = (extra) => createPaypalAdapter({ clientId: 'a', clientSecret: 'b', webhookId: t.sim.config.webhookId, baseUrl: t.sim.url, ...extra }, { fetch: spy, clock: t.sim.clock });
    const strict = mk({ certHosts: ['paypal.com'] }); // mặc định: chỉ paypal.com và https
    for (const url of ['http://127.0.0.1/x.pem', 'https://evil.example.com/cert.pem', 'https://paypal.com.evil.example/c.pem', 'https://notpaypal.com/c.pem', 'not a url', 'file:///etc/passwd']) {
      const r = await strict.parseCallback({ channel: 'ipn', body: d.raw, rawBody: d.raw, headers: { ...d.headers, 'paypal-cert-url': url }, query: {} });
      assert.equal(r.valid, false, url);
    }
    assert.deepEqual(seen, [], 'không tải gì từ địa chỉ không được phép');
    const loose = mk({ certHosts: ['127.0.0.1'] }); // http không được phép nếu không bật certUrlAllowHttp
    assert.equal((await loose.parseCallback({ channel: 'ipn', body: d.raw, rawBody: d.raw, headers: d.headers, query: {} })).valid, false);
    assert.deepEqual(seen, []);
  } finally { await t.teardown(); }
});

test('chứng chỉ được lưu đệm: nhiều webhook chỉ tải một lần; tải hỏng thì không hợp lệ (không mở cửa)', async () => {
  const t = await setup();
  try {
    const d = await oneWebhook(t);
    const seen = [];
    const spy = async (url, init) => { seen.push(String(url)); return globalThis.fetch(url, init); };
    const a = createPaypalAdapter({ clientId: 'a', clientSecret: 'b', webhookId: t.sim.config.webhookId, baseUrl: t.sim.url, certHosts: ['127.0.0.1'], certUrlAllowHttp: true }, { fetch: spy, clock: t.sim.clock });
    const req = { channel: 'ipn', body: d.raw, rawBody: d.raw, headers: d.headers, query: {} };
    assert.equal((await a.parseCallback(req)).valid, true);
    assert.equal((await a.parseCallback(req)).valid, true);
    assert.equal(seen.filter((u) => u.includes('/certs/')).length, 1);
    const dead = createPaypalAdapter({ clientId: 'a', clientSecret: 'b', webhookId: t.sim.config.webhookId, baseUrl: t.sim.url, certHosts: ['127.0.0.1'], certUrlAllowHttp: true }, { fetch: async () => { throw new Error('mạng'); }, clock: t.sim.clock });
    assert.equal((await dead.parseCallback(req)).valid, false);
  } finally { await t.teardown(); }
});

test('cấu hình thiếu hoặc sai bị từ chối ngay lúc dựng adapter, VND không bật được', () => {
  const base = { clientId: 'a', clientSecret: 'b', webhookId: 'w' };
  assert.throws(() => createPaypalAdapter({ ...base, clientId: undefined }), /clientId/);
  assert.throws(() => createPaypalAdapter({ ...base, webhookId: undefined }), /webhookId/);
  assert.throws(() => createPaypalAdapter({ ...base, product: 'xx' }), /product/);
  assert.throws(() => createPaypalAdapter({ ...base, currencies: ['VND'] }), /VND/);
  assert.throws(() => createPaypalAdapter({ ...base, currencies: ['USD', 'ZZZ'] }), /currencies/);
  assert.throws(() => createPaypalAdapter({ ...base, certHosts: [] }), /certHosts/);
  assert.equal(createPaypalAdapter(base).capabilities().currencies.includes('VND'), false);
});

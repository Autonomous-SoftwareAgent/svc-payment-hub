'use strict';
// spec: PHUB-S-023
// Registry adapter (PHUB-D-023): thêm cổng = thêm một thư mục hoặc tệp, không sửa tệp nào đang có; trùng id hoặc sai khai báo thì dừng rõ ràng.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover } = require('../../src/adapters/registry');
const { buildHub } = require('../../src/main');
const { MemoryStore } = require('../../src/store');

const FAKE = JSON.stringify(path.join(__dirname, '..', 'support', 'fake-adapter.js'));
const stub = (id, extra = '') => `const { createFakeAdapter } = require(${FAKE});\nmodule.exports = { adapter: { id: '${id}', create: (cfg, deps) => { ${extra} const a = createFakeAdapter('${id}'); a.receivedCfg = cfg; a.receivedDeps = deps; return a; } } };`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-adp-'));
const cfg = (gw, extra = {}) => ({ hub: { gateways: gw }, databaseUrl: 'unused', ...extra });

test('sáu cổng sẵn có (bốn nội địa, Stripe và PayPal) được registry nhận từ thư mục src/adapters, không liệt kê tay', () => {
  assert.deepEqual([...discover().keys()].sort(), ['momo', 'onepay', 'paypal', 'sepay', 'stripe', 'vnpay']);
});

test('thêm cổng = thêm tệp: thư mục có index.js và tệp .js đơn ở thư mục ngoài đều được nhận, tên bắt đầu bằng _ hoặc . bị bỏ qua', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'acme'));
    fs.writeFileSync(path.join(dir, 'acme', 'index.js'), stub('acme'));
    fs.writeFileSync(path.join(dir, 'zeta.js'), stub('zeta'));
    fs.writeFileSync(path.join(dir, '_ignored.js'), 'throw new Error("không được nạp");');
    fs.writeFileSync(path.join(dir, 'ghi-chu.txt'), 'x');
    assert.deepEqual([...discover([dir]).keys()].sort(), ['acme', 'momo', 'onepay', 'paypal', 'sepay', 'stripe', 'vnpay', 'zeta']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trùng id (với cổng sẵn có hoặc giữa hai thư mục ngoài) là lỗi rõ ràng, không ghi đè ngầm', () => {
  const a = tmp(); const b = tmp();
  try {
    fs.writeFileSync(path.join(a, 'x.js'), stub('vnpay'));
    assert.throws(() => discover([a]), /trùng id "vnpay"/);
    fs.rmSync(path.join(a, 'x.js'));
    fs.writeFileSync(path.join(a, 'p.js'), stub('same'));
    fs.writeFileSync(path.join(b, 'q.js'), stub('same'));
    assert.throws(() => discover([a, b]), /trùng id "same"/);
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test('sai khai báo bị từ chối và nói rõ: thiếu adapter, thiếu id, thiếu create, thư mục không tồn tại', () => {
  const dir = tmp();
  try {
    // mỗi ca một tệp riêng: Node nhớ (cache) mô-đun theo đường dẫn
    const cases = [
      ['thieu-adapter.js', 'module.exports = {};', /phải xuất adapter = {id, create}/],
      ['thieu-id.js', 'module.exports = { adapter: { create() {} } };', /adapter.id phải là chuỗi/],
      ['thieu-create.js', "module.exports = { adapter: { id: 'a' } };", /adapter.create phải là hàm/],
    ];
    for (const [name, code, re] of cases) {
      const d = path.join(dir, name.replace('.js', ''));
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, name), code);
      assert.throws(() => discover([d]), re, name);
    }
    assert.throws(() => discover([path.join(dir, 'khong-co')]), /không có thư mục/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cổng mới ở thư mục ngoài chạy trọn đường: cấu hình adapterDirs, Hub dựng, tạo thanh toán, callback, PAID; không sửa tệp nào của Hub', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'acme.js'), stub('acme'));
    const { hub } = await buildHub(cfg([{ id: 'acme' }], { adapterDirs: [dir], publicBaseUrl: 'https://hub.test/', adapters: { acme: { token: 't' } } }), {}, { store: new MemoryStore() });
    const { payment, attempt } = await hub.createPayment({ orderId: 'O1', amount: 100000, returnUrl: 'https://s/r' });
    assert.equal(attempt.gateway, 'acme');
    assert.equal(hub.rawAdapters.acme.receivedCfg.token, 't', 'adapters.acme được chuyển nguyên cho create()');
    assert.equal(hub.rawAdapters.acme.receivedDeps.publicBaseUrl, 'https://hub.test', 'publicBaseUrl đã bỏ dấu / cuối');
    const r = await hub.handleCallback('acme', { channel: 'ipn', method: 'GET', query: {}, body: { ref: attempt.ref, type: 'succeeded', amount: 100000, txn: 'T1' }, headers: {} });
    assert.equal(r.outcome, 'ok');
    assert.equal(payment.status, 'PAID');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cổng không có trong registry hoặc adapter dựng ra id khác khai báo: Hub không khởi động, nói rõ', async () => {
  const dir = tmp();
  try {
    await assert.rejects(buildHub(cfg([{ id: 'khong-co' }], {}), {}, { store: new MemoryStore() }), /cổng không hỗ trợ: khong-co \(có: momo, onepay, paypal, sepay, stripe, vnpay\)/);
    fs.writeFileSync(path.join(dir, 'lech.js'), `const { createFakeAdapter } = require(${FAKE});\nmodule.exports = { adapter: { id: 'lech', create: () => createFakeAdapter('khac') } };`);
    await assert.rejects(buildHub(cfg([{ id: 'lech' }], { adapterDirs: [dir] }), {}, { store: new MemoryStore() }), /id của adapter dựng ra \(khac\) khác id khai báo/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MoMo lấy ipnUrl mặc định từ publicBaseUrl (trước đây nằm ở main.js), cấu hình tường minh vẫn thắng', async () => {
  const seen = [];
  // chặn lời gọi mạng để đọc body gửi đi; fetch được đưa vào qua deps của buildHub, đúng đường điểm nối dùng
  const fetch = async (url, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ resultCode: 0, payUrl: 'https://pay.test/x' }), { status: 200 }); };
  const mk = async (adapters) => (await buildHub(cfg([{ id: 'momo' }], { publicBaseUrl: 'https://hub.test/', adapters: { momo: { partnerCode: 'P', accessKey: 'a', secretKey: 's', ...adapters } } }), {}, { store: new MemoryStore(), fetch })).hub;
  await (await mk({})).createPayment({ orderId: 'O1', amount: 100000, returnUrl: 'https://s/r' });
  await (await mk({ ipnUrl: 'https://tuong-minh.test/ipn' })).createPayment({ orderId: 'O2', amount: 100000, returnUrl: 'https://s/r' });
  assert.equal(seen[0].ipnUrl, 'https://hub.test/ipn/momo');
  assert.equal(seen[0].redirectUrl, 'https://s/r', 'returnUrl của đơn hàng được ưu tiên; redirectUrl mặc định chỉ dùng khi đơn không có returnUrl');
  assert.equal(seen[1].ipnUrl, 'https://tuong-minh.test/ipn');
});

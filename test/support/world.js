'use strict';
// spec: PHUB-S-001
// spec: SEPY-S-006
// spec: STRP-S-003
// Dựng "thế giới" cho test tích hợp: Hub + HTTP server nhận callback + adapter thật + simulator thật.
// Mỗi cổng có một driver với cùng giao diện nhỏ để viết kịch bản dùng chung cho mọi cổng.
const { PaymentHub } = require('../../src/hub');
const { createHubServer } = require('../../src/server');
const { createClock } = require('./fake-adapter');

const KEY_HEX = '00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF'; // hex giả

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Server nhận IPN/return chính là server HTTP thật của Hub (src/server.js).
async function startHubServer(getHub) {
  const api = createHubServer({ getHub, apiToken: 'test-api-token-not-real' });
  const { url } = await api.listen(0);
  return { base: url, close: () => api.close() };
}

// ---------- drivers: mỗi cổng một bản, cùng giao diện ----------
// pay(attempt, outcome): khách trả; control(settings, attempt?): kịch bản lỗi; advance(sec): đồng hồ ảo của simulator;
// land(attempt): khách mở URL thanh toán (một số cổng chỉ tạo giao dịch khi URL được mở).

async function momoDriver(hubBase, opts = {}) { // opts.adapter: cấu hình thêm cho adapter (ví dụ failCodeMap)
  const { startSimulator } = require('../../tools/sim/momo/server.js');
  const { createMomoAdapter } = require('../../src/adapters/momo/index.js');
  const creds = { partnerCode: 'MOMOTEST01', accessKey: 'test-access-key', secretKey: 'test-secret-key-do-not-use' };
  const sim = await startSimulator({ ...creds });
  const adapter = createMomoAdapter(
    { ...creds, baseUrl: sim.url, ipnUrl: `${hubBase}/ipn/momo`, redirectUrl: `${hubBase}/return/momo`, timeoutMs: 1500, ...(opts.adapter || {}) },
    { fetch: globalThis.fetch, clock: { now: () => Date.now() } },
  );
  return {
    id: 'momo',
    adapter,
    sim,
    capsOverride: {},
    land: async () => {},
    pay: (a, outcome) => postJson(`${sim.url}/sim/pay`, { orderId: a.ref, outcome }),
    control: (settings, a) => postJson(`${sim.url}/sim/control`, a ? { orderId: a.ref, ...settings } : settings),
    advance: (sec) => postJson(`${sim.url}/sim/clock/advance`, { seconds: sec }),
    transactions: async () => (await (await fetch(`${sim.url}/sim/transactions`)).json()),
    close: () => sim.close(),
  };
}

async function onepayDriver(hubBase, opts = {}) { // opts.adapter: cấu hình thêm cho adapter (ví dụ failCodeMap)
  const { startSimulator } = require('../../tools/sim/onepay/server.js');
  const { createOnepayAdapter } = require('../../src/adapters/onepay/index.js');
  const cfg = { merchant: 'TESTSIM', accessCode: 'SIMCODE1', hashKeyHex: KEY_HEX, queryUser: 'u', queryPassword: 'p' };
  const sim = await startSimulator({ ...cfg });
  sim.state.ipnUrl = `${hubBase}/ipn/onepay`;
  const adapter = createOnepayAdapter({ ...cfg, baseUrl: sim.url, ...(opts.adapter || {}) }, { clock: sim.clock });
  return {
    id: 'onepay',
    adapter,
    sim,
    land: async (a) => { await fetch(a.url, { redirect: 'manual' }); }, // khách mở URL: simulator tạo invoice
    pay: (a, outcome) => postJson(`${sim.url}/sim/pay`, { merchTxnRef: a.ref, outcome }),
    control: (settings, a) => postJson(`${sim.url}/sim/control`, a ? { merchTxnRef: a.ref, ...settings } : settings),
    advance: (sec) => postJson(`${sim.url}/sim/clock/advance`, { seconds: sec }),
    close: () => sim.close(),
  };
}

// opts (SePay, ba sản phẩm trong một adapter, SEPY-D-006): vaBank (BIDV|Sacombank|Vietcombank|VietinBank) bật sản phẩm "va-order",
// pg:true bật "gateway"; refundApi, defaultProduct, orderCodeMaxLength, durationSeconds, controls (điều khiển ban đầu của simulator).
async function sepayDriver(hubBase, opts = {}) {
  const { startSimulator } = require('../../tools/sim/sepay/server.js');
  const { createSepayAdapter } = require('../../src/adapters/sepay/index.js');
  const cfg = {
    accountNumber: '0123456789', bankName: 'MBBank', accountName: 'CONG TY BSN TEST', codePrefix: 'DH',
    apiKey: 'test-api-key-not-real', hmacSecret: 'test-hmac-secret-not-real', apiToken: 'test-api-token-not-real', authMode: 'hmac',
  };
  const simOpts = { ...cfg, controls: { api_rate_limit: 1000, ...(opts.controls || {}) } };
  if (opts.vaBank) simOpts.vaBank = opts.vaBank;
  if (opts.pg) Object.assign(simOpts, { pgMerchantId: 'MERCHANT_TEST', pgSecretKey: 'test-pg-secret-not-real' });
  const sim = await startSimulator(simOpts);
  sim.setWebhookUrl(`${hubBase}/ipn/sepay`);
  const adapterCfg = { ...cfg, apiBaseUrl: `${sim.url}/v2`, qrBaseUrl: `${sim.url}/img`, timeoutMs: 3000 };
  if (opts.refundApi) adapterCfg.refundApi = true;
  if (opts.defaultProduct) adapterCfg.defaultProduct = opts.defaultProduct;
  if (opts.vaBank) {
    adapterCfg.va = { bankAccountId: sim.config.bankAccountId, ...(sim.config.vaBank === 'Vietcombank' ? { tid: sim.config.vcbTid, orderCodeMaxLength: 15 } : {}), ...(sim.config.vaBank === 'Sacombank' ? { vaPrefix: sim.config.vaPrefix } : {}), ...(opts.va || {}) };
  }
  if (opts.pg) {
    adapterCfg.pg = { merchantId: 'MERCHANT_TEST', secretKey: 'test-pg-secret-not-real', checkoutUrl: `${sim.url}/v1/checkout/init`, apiBaseUrl: `${sim.url}/v1`, returnBaseUrl: `${hubBase}/return/sepay`, ...(opts.pg === true ? {} : opts.pg) };
  }
  const adapter = createSepayAdapter(adapterCfg, { fetch: globalThis.fetch, clock: sim.clock });
  // Form POST của cổng (C): lõi Hub chưa lưu method/fields (SEPY-D-006, P1) nên driver ghi lại kết quả createPayment để mô phỏng trình duyệt của khách.
  const forms = new Map();
  const rawCreate = adapter.createPayment.bind(adapter);
  adapter.createPayment = async (p) => { const r = await rawCreate(p); if (r.status === 'redirect' && r.fields) forms.set(p.attemptRef, r); return r; };
  const call = async (path, body) => {
    const r = await fetch(sim.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const isVa = (attempt) => attempt.product === 'va-order';
  const isPg = (attempt) => attempt.product === 'gateway';
  const driver = {
    id: 'sepay',
    adapter,
    sim,
    forms,
    // Khách mở trang thanh toán: với cổng, trình duyệt POST form đã ký tới SePay (tạo đơn phía SePay)
    land: async (attempt) => {
      const f = attempt && isPg(attempt) && forms.get(attempt.ref);
      if (!f) return undefined;
      return fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f.fields).toString(), redirect: 'manual' });
    },
    // Khách chuyển khoản: mặc định đúng nội dung (A) hoặc đúng số VA (B) và đủ số tiền.
    transfer: (attempt, extra = {}) => {
      if (isVa(attempt)) return call('/sim/transfer', { va: attempt.instructions.accountNumber, amount: attempt.amount, content: 'thanh toan', ...extra });
      return call('/sim/transfer', { content: attempt.instructions.transferContent, amount: attempt.amount, ...extra });
    },
    // Cổng (C): khách trả trên trang SePay, rồi trình duyệt quay về URL của Hub (nếu follow !== false)
    pgPay: async (attempt, body = {}, follow = true) => {
      const r = await call('/sim/pg/pay', { invoice: attempt.ref, ...body });
      if (follow && r.body && r.body.redirect) await fetch(r.body.redirect, { redirect: 'manual' });
      return r;
    },
    pay: (attempt, outcome) => {
      if (isPg(attempt)) return driver.pgPay(attempt, { outcome: outcome === 'success' ? 'success' : outcome });
      if (outcome !== 'success') throw new Error('SePay chuyển khoản/VA chỉ có chuyển khoản; không có thất bại/hủy do khách');
      return driver.transfer(attempt);
    },
    control: (settings) => call('/sim/control', settings),
    advance: (sec) => call('/sim/clock/advance', { seconds: sec }),
    close: () => sim.close(),
  };
  return driver;
}

// Stripe (STRP-S-003): driver riêng, KHÔNG nằm trong DRIVERS vì các kịch bản chung dùng điều khiển của simulator kiểu IPN (ipn_drop, ipn_dup...) mà Stripe không có.
// opts.adapter: cấu hình thêm cho adapter (ví dụ product: 'auth'); opts.controls: điều khiển ban đầu của simulator.
async function stripeDriver(hubBase, opts = {}) {
  const { startSimulator } = require('../../tools/sim/stripe/server.js');
  const { createStripeAdapter } = require('../../src/adapters/stripe/index.js');
  const creds = { secretKey: 'sk_test_world_key_not_real', webhookSecret: 'whsec_world_secret_not_real' };
  const sim = await startSimulator({ ...creds, webhookUrl: `${hubBase}/ipn/stripe`, controls: opts.controls });
  const adapter = createStripeAdapter({ ...creds, baseUrl: sim.url, timeoutMs: 1500, currencies: ['USD', 'JPY', 'VND'], ...(opts.adapter || {}) }, { fetch: globalThis.fetch, clock: sim.clock });
  const call = async (path, body) => {
    const r = await fetch(sim.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return {
    id: 'stripe',
    adapter,
    sim,
    land: async () => {},
    pay: (a, outcome = 'success', extra = {}) => call('/sim/pay', { session: a.state.cs, outcome, ...extra }),
    control: (settings) => call('/sim/control', settings),
    advance: (sec) => call('/sim/clock/advance', { seconds: sec }),
    post: call,
    close: () => sim.close(),
  };
}

// PayPal (PYPL-S-003): driver riêng như Stripe. Khách duyệt trên trang PayPal rồi trình duyệt quay về /return/paypal của Hub (adapter thu giúp Hub ở đó
// hoặc ở webhook duyệt). opts.adapter: cấu hình thêm cho adapter (ví dụ product: 'auth'); opts.controls: điều khiển ban đầu của simulator.
async function paypalDriver(hubBase, opts = {}) {
  const { startSimulator } = require('../../tools/sim/paypal/server.js');
  const { createPaypalAdapter } = require('../../src/adapters/paypal/index.js');
  const sim = await startSimulator({ webhookUrl: `${hubBase}/ipn/paypal`, controls: opts.controls });
  const adapter = createPaypalAdapter({
    ...sim.config, baseUrl: sim.url, returnBaseUrl: hubBase, certHosts: ['127.0.0.1'], certUrlAllowHttp: true, timeoutMs: 1500, currencies: ['USD', 'EUR', 'JPY', 'GBP'], ...(opts.adapter || {}),
  }, { fetch: globalThis.fetch, clock: sim.clock });
  const call = async (path, body) => {
    const r = await fetch(sim.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return {
    id: 'paypal',
    adapter,
    sim,
    land: async () => {},
    // outcome: success (duyệt, quay về) | decline (duyệt nhưng thu bị từ chối) | cancel (khách hủy) | approve_only (duyệt, KHÔNG quay về: đóng tab)
    pay: async (a, outcome = 'success', extra = {}) => {
      const order = a.state.order;
      if (outcome === 'decline') await call('/sim/control', { capture_decline: extra.issue || 'INSTRUMENT_DECLINED' });
      const r = await call('/sim/pay', { order, outcome: outcome === 'cancel' ? 'cancel' : 'approve' });
      if (r.body && r.body.redirect && outcome !== 'approve_only') await fetch(r.body.redirect, { redirect: 'manual' });
      if (outcome === 'decline') await call('/sim/control', { capture_decline: null });
      return r;
    },
    control: (settings) => call('/sim/control', settings),
    advance: (sec) => call('/sim/clock/advance', { seconds: sec }),
    post: call,
    close: () => sim.close(),
  };
}

const DRIVERS = { momo: momoDriver, onepay: onepayDriver, sepay: sepayDriver };
try { DRIVERS.vnpay = require('./vnpay-driver').vnpayDriver; } catch { /* chưa có driver VNPay */ }

/**
 * @param {string[]} gateways thứ tự = priority
 */
async function createWorld(gateways, hubOpts = {}, extra = {}) {
  const hubClock = createClock(Date.now());
  let hub;
  const server = await startHubServer(() => hub);
  const drivers = {};
  for (const g of gateways) drivers[g] = await ({ stripe: stripeDriver, paypal: paypalDriver }[g] || DRIVERS[g])(server.base, extra[g]);
  // extra.db = freshDb() (test/support/pg.js): Hub chạy trên PostgreSQL thật và restart() mở lại đúng schema đó.
  const makeHub = async () => new PaymentHub({
    adapters: Object.fromEntries(gateways.map((g) => [g, drivers[g].adapter])),
    clock: hubClock,
    store: extra.db ? await extra.db.open() : undefined,
    config: {
      gateways: gateways.map((g, i) => ({ id: g, priority: i + 1 })),
      reconcile: { firstAfterSeconds: 60, backoffSeconds: [60, 120, 300], maxAgeSeconds: 86400 },
      paymentTtlSeconds: 1800,
      ...hubOpts,
    },
  });
  try {
    hub = await makeHub();
  } catch (err) { // cấu hình Hub sai: dọn simulator và server đã dựng để tiến trình test không treo
    for (const d of Object.values(drivers)) await d.close();
    await server.close();
    throw err;
  }
  const world = {
    hub,
    clock: hubClock,
    drivers,
    base: server.base,
    // Tiến đồng hồ của Hub và của mọi simulator.
    async advance(sec) {
      hubClock.advance(sec);
      for (const d of Object.values(drivers)) await d.advance(sec);
    },
    // Mô phỏng khởi động lại tiến trình Hub trên cùng cơ sở dữ liệu (chỉ khi có extra.db).
    async restart() {
      await hub.store.close();
      hub = await makeHub();
      world.hub = hub;
      return hub;
    },
    async close() {
      if (hub.store.close) await hub.store.close();
      for (const d of Object.values(drivers)) await d.close();
      await server.close();
    },
  };
  return world;
}

const order = (o = {}) => ({ orderId: `ORD${Math.random().toString(36).slice(2, 8)}`, amount: 150000, returnUrl: 'https://shop.test/return', ...o });

module.exports = { createWorld, order, DRIVERS };

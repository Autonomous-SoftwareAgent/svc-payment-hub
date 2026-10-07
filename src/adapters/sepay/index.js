'use strict';
// spec: SEPY-S-001
// spec: SEPY-S-002
// spec: SEPY-S-003
// spec: SEPY-S-004
// spec: SEPY-S-005
// spec: SEPY-S-006
// spec: SEPY-S-007
// spec: PHUB-S-020
// spec: PHUB-S-023
// spec: PHUB-S-024
// spec: PHUB-S-025
// Adapter SePay: một adapter, ba sản phẩm chọn theo `product` mà Hub truyền (SEPY-D-006):
//  "qr-static" (A, qr-static.js)  QR tĩnh + webhook biến động số dư, kiểu chuyển khoản do khách chủ động (SEPY-D-001..003).
//  "va-order"  (B, va-order.js)   VA theo đơn hàng qua API v2 (SEPY-D-004).
//  "gateway"   (C, gateway.js)    cổng pay.sepay.vn, form ký + redirect + IPN (SEPY-D-005).
// A và B dùng chung bank.js (webhook biến động số dư và sao kê); C có đường riêng (IPN, API cổng).
// Giả định chưa kiểm chứng của từng sản phẩm: xem đầu file sản phẩm và sổ giả định trong docs/modules/sepay-sim.
const { ackResponse } = require('./common');
const { createFailCodeMapper } = require('../fail-codes');
const { createBank } = require('./bank');
const { createQrStatic } = require('./qr-static');
const { createVaOrder } = require('./va-order');
const { createGateway } = require('./gateway');
const { createRefunds } = require('./refunds');

const PRODUCTS = ['qr-static', 'va-order', 'gateway'];

function createSepayAdapter(config, deps = {}) {
  const cfg = {
    codePrefix: 'BSN', authMode: 'none', hmacToleranceSeconds: 300,
    apiBaseUrl: 'https://userapi.sepay.vn/v2', qrBaseUrl: 'https://vietqr.app/img', timeoutMs: 15000, ...config,
  };
  // Chưa có bằng chứng nào về mã lỗi của SePay: bảng mặc định rỗng, mọi mã là unknown cho tới khi cấu hình failCodeMap (PHUB-D-020).
  const ctx = {
    failCode: createFailCodeMapper('sepay', {}, cfg.failCodeMap),
    cfg, doFetch: deps.fetch || globalThis.fetch, clock: deps.clock || { now: () => Date.now() }, prefix: String(cfg.codePrefix).toUpperCase(),
  };
  // Kiểm cấu hình ngay khi dựng: thiếu khóa thì webhook luôn bị từ chối hoặc không dựng được hướng dẫn chuyển khoản, chỉ lộ ra lúc chạy.
  if (!['none', 'apikey', 'hmac'].includes(cfg.authMode)) throw new Error(`sepay: authMode không hợp lệ: ${cfg.authMode} (none, apikey hoặc hmac)`);
  if (cfg.authMode === 'apikey' && !cfg.apiKey) throw new Error('sepay: authMode apikey cần apiKey');
  if (cfg.authMode === 'hmac' && !cfg.hmacSecret) throw new Error('sepay: authMode hmac cần hmacSecret');
  const bank = createBank(ctx);

  // Sản phẩm nào có cấu hình thì bật. A bật khi có accountNumber, hoặc khi không cấu hình B và C (tương thích bản chỉ có A).
  const modules = {};
  if (cfg.accountNumber !== undefined || (!cfg.va && !cfg.pg)) {
    if (!cfg.accountNumber) throw new Error('sepay: thiếu accountNumber cho sản phẩm qr-static');
    if (!cfg.bankName && !cfg.bankCode) throw new Error('sepay: thiếu bankName (hoặc bankCode) cho sản phẩm qr-static');
    modules['qr-static'] = createQrStatic(ctx, bank);
  }
  if (cfg.va) {
    if (!cfg.va.bankAccountId) throw new Error('sepay: va.bankAccountId là bắt buộc cho sản phẩm va-order');
    modules['va-order'] = createVaOrder(ctx, bank);
    bank.setResolver(modules['va-order'].resolver);
  }
  if (cfg.pg) {
    if (!cfg.pg.merchantId || !cfg.pg.secretKey) throw new Error('sepay: pg.merchantId và pg.secretKey là bắt buộc cho sản phẩm gateway');
    modules.gateway = createGateway(ctx, bank);
  }
  if (cfg.defaultProduct && !modules[cfg.defaultProduct]) throw new Error(`sepay: defaultProduct ${cfg.defaultProduct} chưa được cấu hình`);
  const defaultProduct = cfg.defaultProduct || PRODUCTS.find((p) => modules[p]);
  const hasBank = !!(modules['qr-static'] || modules['va-order']);

  // Hub truyền 'default' hoặc không truyền: dùng sản phẩm mặc định. Product lạ hoặc chưa cấu hình: không có module.
  const moduleOf = (product) => modules[!product || product === 'default' ? defaultProduct : product];

  // Hoàn tiền và hủy không mang product trong hợp đồng: dò theo bằng chứng, B trước (đơn có VA), rồi A.
  const rowsFor = async (ref, createdAt, state) => {
    if (modules['va-order']) {
      const r = await modules['va-order'].collectRows(ref, createdAt, state);
      if (r.error || r.rows.length) return r;
    }
    if (modules['qr-static']) return modules['qr-static'].collectRows(ref);
    return { rows: [] };
  };
  const refunds = createRefunds(ctx, bank, rowsFor);
  const hint = new Map(); // attemptRef -> product, chỉ là gợi ý trong bộ nhớ để hủy đúng sản phẩm

  const adapter = {
    id: 'sepay',

    capabilities(product) {
      const m = moduleOf(product) || moduleOf(undefined);
      return m.capabilities();
    },

    async createPayment(p) {
      const m = moduleOf(p.product);
      if (!m) return { status: 'rejected', reason: `sepay: product ${p.product} chưa được cấu hình`, failCode: 'invalid_request' };
      const res = await m.createPayment(p);
      if (res && res.status !== 'rejected' && typeof p.attemptRef === 'string') hint.set(p.attemptRef.toUpperCase(), m.product);
      return res;
    },

    parseCallback(req) {
      const gw = modules.gateway;
      if (req.channel === 'return') return gw ? gw.parseCallback(req) : { valid: false, reason: 'return_unsupported', ack: ackResponse };
      if (gw) {
        // IPN của cổng mang notification_type; webhook biến động số dư thì không. Chỉ dùng để chọn đường xử lý, xác thực nằm ở từng đường.
        const peek = bank.parseBody(req.body !== undefined && req.body !== null ? req.body : bank.rawOf(req));
        if (peek && typeof peek.notification_type === 'string') return gw.parseCallback(req);
      }
      if (!hasBank) return { valid: false, reason: 'bank_webhook_not_configured', ack: ackResponse };
      return bank.parseWebhook(req);
    },

    async query(p) {
      const m = moduleOf(p.product);
      if (!m) return { state: 'unknown' };
      return m.query(p);
    },

    // Hub gọi một lần lúc khởi động với các attempt còn sống của cổng này (PHUB-D-025): nạp lại bộ nhớ đệm trong tiến trình, không gọi mạng.
    // Trả số attempt đã nạp được bộ đệm.
    adopt({ attempts = [] } = {}) {
      let n = 0;
      for (const a of attempts) {
        const m = moduleOf(a.product);
        if (!m) continue;
        if (typeof a.attemptRef === 'string') hint.set(a.attemptRef.toUpperCase(), m.product);
        if (typeof m.adopt === 'function') n += m.adopt(a);
      }
      return n;
    },

    async refund(p) { return refunds.refund(p); }, // không có API hoàn riêng cho C: manual (SEPY-D-005)
    async queryRefund(p) { return refunds.queryRefund(p); },
  };

  if (hasBank) adapter.reconcileFeed = (p) => bank.reconcileFeed(p);

  if (modules['va-order'] || modules.gateway) {
    adapter.cancel = async (p) => {
      const ref = String(p.attemptRef || '').toUpperCase();
      const hinted = hint.get(ref);
      const order = hinted ? [hinted] : ['va-order', 'gateway'];
      for (const name of order) {
        const m = modules[name];
        if (m && typeof m.cancel === 'function') {
          const r = await m.cancel(p);
          if (r.cancelled) return r;
        }
      }
      return { cancelled: false };
    };
  }

  return adapter;
}

// Khai báo cho registry (PHUB-D-023).
// configWarnings: webhook không xác thực thì ai biết địa chỉ cũng có thể báo "đã trả" (Hub vẫn đối chiếu bằng truy vấn, nhưng đây là điểm yếu cần biết).
const configWarnings = (cfg) => (!cfg || cfg.authMode === undefined || cfg.authMode === 'none' ? ['cổng sepay: authMode none, webhook không được xác thực (nên dùng hmac hoặc apikey)'] : []);
const adapter = { id: 'sepay', create: (config, deps) => createSepayAdapter(config, deps), configWarnings };

module.exports = { adapter, createSepayAdapter, PRODUCTS };

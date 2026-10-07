'use strict';
// spec: PHUB-S-033
// spec: PHUB-S-035
// spec: PHUB-S-036
// spec: PHUB-S-037
// spec: PHUB-S-038
// spec: STRP-S-002
// spec: PHUB-S-003
// spec: PHUB-S-001
// spec: PHUB-S-002
// spec: PHUB-S-006
// spec: PHUB-S-007
// spec: PHUB-S-008
// spec: PHUB-S-009
// spec: PHUB-S-010
// spec: PHUB-S-011
// spec: PHUB-S-005
// spec: PHUB-S-012
// spec: PHUB-S-013
// spec: PHUB-S-014
// spec: PHUB-S-015
// spec: PHUB-S-017
// spec: PHUB-S-018
// spec: PHUB-S-019
// spec: PHUB-S-020
// spec: PHUB-S-025
// spec: PHUB-S-027
// spec: PHUB-S-029
// Lõi Payment Hub: routing, máy trạng thái attempt/payment/refund, xử lý callback, đối soát.
// Lõi chỉ làm việc với sự kiện chuẩn (contract.js); mọi chi tiết cổng nằm trong adapter.

const crypto = require('node:crypto');
const { MemoryStore } = require('./store');
const { assertAdapterShape, assertEvent, checkCreateResult, FAIL_CODES, METHODS, CURRENCY_EXPONENT, checkExtra, DISPUTE_TYPES } = require('./contract');
const routing = require('./routing');
const { guardAdapter } = require('./guard');
const { EventOutbox } = require('./events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Metrics } = require('./metrics');

const LIVE = ['CREATED', 'AWAITING', 'UNKNOWN', 'AUTHORIZED']; // AUTHORIZED: cổng đang giữ tiền, chưa thu; vẫn có thể thành tiền nên không được tạo attempt khác (PHUB-D-037)
const TYPE_TO_STATE = { succeeded: 'SUCCEEDED', failed: 'FAILED', cancelled: 'CANCELLED', expired: 'EXPIRED' };
const REFUND_STATE = { requested: 'REQUESTED', processing: 'PROCESSING', succeeded: 'SUCCEEDED', failed: 'FAILED', manual_required: 'MANUAL_REQUIRED' };
const REFUND_OPEN = ['REQUESTED', 'PROCESSING'];
// Anomaly có bằng chứng từ thông báo, cần cổng xác nhận bằng query trước khi hoàn tiền hoặc áp dụng (PHUB-D-002 mục 9).
const ARBITRATED = ['late_success', 'duplicate_charge', 'conflicting_result'];

const MAX_AMOUNT_LIMIT = Math.floor(Number.MAX_SAFE_INTEGER / 1000); // chừa hệ số nhân của cổng (x100) mà vẫn là số nguyên an toàn

const DEFAULTS = {
  paymentTtlSeconds: 1800,
  maxAmount: 1_000_000_000_000, // trần số tiền một payment (VND); trần thật của từng cổng đặt ở gateways[].maxAmount
  // skipOnFailCodes: mã lý do thất bại chuẩn (contract.FAIL_CODES) mà sau đó KHÔNG cho chuyển cổng (reason failover); mặc định rỗng = không đổi hành vi (PHUB-D-020).
  failover: { enabled: true, maxAttempts: 3, skipOnFailCodes: [] },
  reconcile: {
    firstAfterSeconds: 60, backoffSeconds: [60, 120, 300, 600, 1800], maxAgeSeconds: 86400, hardExpiryGraceSeconds: 60, feedIntervalSeconds: 60,
    concurrency: 10, // số lần hỏi cổng chạy song song trong một vòng đối soát
    refundBackoffSeconds: [60, 300, 1800, 7200, 21600, 43200, 86400], // hoàn tiền có thể mất nhiều ngày: lịch dài hơn
    // Attempt đã đóng KHÔNG thành công (failed, cancelled, expired) vẫn có thể nhận tiền muộn nếu khách trả lại trên URL cũ; nếu thông báo (IPN) mất hẳn thì Hub
    // không bao giờ biết. Hỏi lại cổng ở các mốc này (giây kể từ lúc đóng); tìm thấy tiền thì ghi anomaly late_success. [] = tắt (PHUB-D-027).
    closedRecheckSeconds: [3600, 86400],
    perGateway: {}, // ghi đè theo cổng: { vnpay: { backoffSeconds: [...], maxAgeSeconds: ... } }
  },
  refund: { maxPerAttempt: 10, maxAgeDays: 365 },
  protection: { enabled: true, perGateway: {} }, // tham số mặc định của lớp bảo vệ: xem guard.js DEFAULTS
  webhooks: null, // { url, secret, ... }: webhook tới cửa hàng, xem events.js
  events: null, // { routes: [...] }: các tuyến ra khác (Kafka...), xem events.js
  // Bộ nhớ nóng (PHUB-D-012): giao dịch đã đóng nhàn rỗi quá idleSeconds được đẩy ra khỏi bộ nhớ; khóa idempotency trong DB giữ seenTtlDays ngày.
  hot: { idleSeconds: 120, evictEverySeconds: 10, seenTtlDays: 90 },
};

class HubError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

class PaymentHub {
  /**
   * @param {{adapters:Object<string,import('./contract').Adapter>, config:Object, store?:MemoryStore,
   *          clock?:{now:()=>number}, newRef?:(prefix:string)=>string}} o
   */
  constructor({ adapters, config, store, clock, newRef, deps = {} }) {
    for (const a of Object.values(adapters)) assertAdapterShape(a);
    this.rawAdapters = adapters;
    this.config = {
      ...DEFAULTS,
      ...config,
      failover: { ...DEFAULTS.failover, ...(config.failover || {}) },
      reconcile: { ...DEFAULTS.reconcile, ...(config.reconcile || {}) },
      refund: { ...DEFAULTS.refund, ...(config.refund || {}) },
      protection: { ...DEFAULTS.protection, ...(config.protection || {}) },
      hot: { ...DEFAULTS.hot, ...(config.hot || {}) },
    };
    PaymentHub.validateRouting(this.config, adapters);
    const skip = this.config.failover.skipOnFailCodes;
    if (!Array.isArray(skip) || skip.some((c) => !FAIL_CODES.includes(c))) throw new Error(`failover.skipOnFailCodes phải là danh sách mã chuẩn trong: ${FAIL_CODES.join(', ')}`);
    if (!Number.isSafeInteger(this.config.maxAmount) || this.config.maxAmount < 1 || this.config.maxAmount > MAX_AMOUNT_LIMIT) throw new Error(`maxAmount phải là số nguyên từ 1 đến ${MAX_AMOUNT_LIMIT}`);
    this.store = store || new MemoryStore();
    this.clock = clock || { now: () => Date.now() };
    this.metrics = new Metrics();
    // Lớp bảo vệ khi gọi cổng (PHUB-D-010): timeout, giới hạn đồng thời, circuit breaker, nhật ký gọi.
    this.guards = {};
    this.adapters = {};
    for (const [id, a] of Object.entries(adapters)) {
      if (this.config.protection.enabled === false) { this.adapters[id] = a; continue; }
      const { perGateway, enabled, ...common } = this.config.protection;
      const g = guardAdapter(a, {
        ...common, ...(perGateway[id] || {}), clock: this.clock,
        onCall: (e) => {
          this.store.addCall(e);
          this.metrics.inc('hub_gateway_calls_total', { gateway: e.gateway, method: e.method, outcome: e.outcome });
          this.metrics.observe('hub_gateway_call_duration_seconds', { gateway: e.gateway, method: e.method }, e.ms / 1000);
        },
        onChange: (st) => { this.store.extra.breakers = { ...(this.store.extra.breakers || {}), [id]: st }; }, // lưu cùng transaction ghi kế tiếp (PHUB-D-014)
      });
      this.adapters[id] = g.adapter;
      this.guards[id] = g.guard;
      const saved = this.store.extra.breakers && this.store.extra.breakers[id];
      if (saved) g.guard.restore(saved);
    }
    // Cổng ra chuẩn (PHUB-D-017): lõi chỉ gọi this.events.emit; các sink (webhook, Kafka...) do composition root tiêm vào deps.sinks.
    this.events = new EventOutbox({ store: this.store, config: { ...(this.config.webhooks || {}), routes: (this.config.events && this.config.events.routes) || [] }, clock: this.clock, sinks: deps.sinks, metrics: this.metrics });
    this._tx = new AsyncLocalStorage();
    this._initMetrics();
    // Mã tham chiếu chỉ gồm chữ-số, ngắn, không đoán được, mỗi attempt một mã.
    // Sau mỗi thao tác công khai, lưu mọi thay đổi (kể cả khi thao tác ném lỗi giữa chừng).
    // Lỗi của thao tác gốc được ưu tiên; lỗi lưu (nếu có) vẫn được ném khi thao tác gốc thành công.
    for (const name of ['createPayment', 'createAttempt', 'handleCallback', 'reconcile', 'refund', 'capturePayment', 'voidPayment', 'resolveAnomaly', 'markRefundDone']) {
      const orig = this[name].bind(this);
      this[name] = async (...args) => {
        const t0 = process.hrtime.bigint();
        let result;
        let failure = null;
        try { result = await orig(...args); } catch (err) { failure = err; }
        if (!this._tx.getStore()) { // trong transact(): thao tác lồng nhau không ghi riêng, transact ghi một lần cho cả cụm
          try { await this._persist(); } catch (err) { failure = failure || err; }
          this._kickWebhooks();
        }
        this.metrics.observe('hub_op_duration_seconds', { op: name }, Number(process.hrtime.bigint() - t0) / 1e9);
        this.metrics.inc('hub_ops_total', { op: name, result: failure ? (failure.code || 'error') : 'ok' });
        if (name === 'handleCallback' && result) this.metrics.inc('hub_callbacks_total', { gateway: this.adapters[args[0]] ? args[0] : 'unknown', outcome: result.outcome });
        if (failure) throw failure;
        return result;
      };
    }
    this.newRef = newRef || ((prefix) => prefix + crypto.randomBytes(8).toString('hex'));
  }

  now() { return this.clock.now(); }

  /**
   * Chạy một cụm thao tác như MỘT transaction: mọi thay đổi trạng thái và sự kiện phát ra trong fn được ghi bằng một lần persist.
   * Thao tác công khai gọi bên trong không ghi riêng. Lỗi của fn vẫn ghi phần đã đổi rồi ném lên (như thao tác công khai).
   */
  async transact(fn) {
    if (this._tx.getStore()) return fn();
    let result;
    let failure = null;
    try { result = await this._tx.run({}, fn); } catch (err) { failure = err; }
    try { await this._persist(); } catch (err) { failure = failure || err; }
    this._kickWebhooks();
    if (failure) throw failure;
    return result;
  }

  async _persist() {
    if (typeof this.store.persist !== 'function') return;
    const t0 = process.hrtime.bigint();
    try { await this.store.persist(); } catch (err) { this.metrics.inc('hub_persist_errors_total'); throw err; } finally { this.metrics.observe('hub_persist_duration_seconds', {}, Number(process.hrtime.bigint() - t0) / 1e9); }
  }

  // Số đo (PHUB-D-013): counter/histogram được tăng tại chỗ; gauge tính lúc đọc từ trạng thái hiện tại.
  _initMetrics() {
    const m = this.metrics;
    m.define('hub_ops_total', 'counter', 'Thao tác công khai của Hub theo kết quả');
    m.define('hub_op_duration_seconds', 'histogram', 'Thời gian một thao tác công khai (gồm lưu)');
    m.define('hub_callbacks_total', 'counter', 'Thông báo của cổng theo kết quả xử lý');
    m.define('hub_closed_rechecks_total', 'counter', 'Lần hỏi lại attempt đã đóng không thành công theo kết quả (found_money, nothing, error)');
    m.define('hub_attempt_failures_total', 'counter', 'Attempt kết thúc không thành công theo cổng, trạng thái và lý do chuẩn (none = do Hub tự hủy)');
    m.define('hub_gateway_calls_total', 'counter', 'Lời gọi tới cổng theo kết quả (ok, error, timeout, not_sent)');
    m.define('hub_gateway_call_duration_seconds', 'histogram', 'Thời gian một lời gọi tới cổng');
    m.define('hub_persist_duration_seconds', 'histogram', 'Thời gian một lần ghi xuống kho');
    m.define('hub_persist_errors_total', 'counter', 'Số lần ghi xuống kho thất bại');
    m.define('hub_webhook_deliveries_total', 'counter', 'Kết quả gửi webhook (delivered, retry, dead)');
    m.define('hub_http_requests_total', 'counter', 'Request HTTP theo route mẫu, phương thức, mã trạng thái');
    m.define('hub_http_request_duration_seconds', 'histogram', 'Thời gian xử lý request HTTP');
    const c = () => this.store.counts();
    m.gauge('hub_payments_in_memory', 'Payment đang nằm trong bộ nhớ', () => c().payments);
    m.gauge('hub_attempts_in_memory', 'Attempt đang nằm trong bộ nhớ', () => c().attempts);
    m.gauge('hub_attempts_live', 'Attempt còn có thể nhận tiền', () => c().liveAttempts);
    m.gauge('hub_payments_open', 'Payment đang mở', () => c().openPayments);
    m.gauge('hub_refunds_open', 'Hoàn tiền chưa xong', () => c().openRefunds);
    m.gauge('hub_store_dirty_entities', 'Thực thể đã đổi nhưng chưa ghi', () => c().dirty);
    m.gauge('hub_seen_keys_in_memory', 'Khóa idempotency trong bộ nhớ', () => c().seen);
    m.gauge('hub_anomalies_open', 'Anomaly đang mở theo loại', () => {
      const by = {};
      for (const a of this.store.openAnomalies()) by[a.type] = (by[a.type] || 0) + 1;
      return Object.entries(by).map(([type, value]) => ({ labels: { type }, value }));
    });
    m.gauge('hub_webhooks_pending', 'Webhook chưa giao', () => c().pendingWebhooks);
    m.gauge('hub_webhook_oldest_pending_age_seconds', 'Tuổi của webhook chờ lâu nhất', () => {
      const now = this.now();
      let oldest = 0;
      for (const w of this.store.pendingWebhooks()) if (w.status === 'pending') oldest = Math.max(oldest, (now - w.createdAt) / 1000);
      return oldest;
    });
    const STATE = { closed: 0, half_open: 1, open: 2 };
    m.gauge('hub_gateway_breaker_state', 'Breaker từng cổng: 0 đóng, 1 nửa mở, 2 mở', () => Object.values(this.guards).map((g) => ({ labels: { gateway: g.gateway }, value: STATE[g.state] })));
    m.gauge('hub_gateway_inflight', 'Lời gọi đang chạy tới từng cổng', () => Object.values(this.guards).map((g) => ({ labels: { gateway: g.gateway }, value: g.inflight })));
    m.gauge('hub_gateway_queued', 'Lời gọi đang chờ chỗ tới từng cổng', () => Object.values(this.guards).map((g) => ({ labels: { gateway: g.gateway }, value: g.queue.length })));
    m.gauge('process_resident_memory_bytes', 'RSS của tiến trình', () => process.memoryUsage().rss);
    m.gauge('process_heap_used_bytes', 'Heap đang dùng', () => process.memoryUsage().heapUsed);
  }

  /** Chủ sở hữu (cửa hàng) của một đối tượng, nạp từ DB nếu cần. undefined nếu không tồn tại. */
  async shopOf({ paymentId, attemptId, refundId }) {
    if (attemptId) await this.store.hydrateAttempt(attemptId);
    if (refundId) await this.store.hydrateRefund(refundId);
    let pid = paymentId;
    if (!pid && attemptId) { const a = this.store.getAttempt(attemptId); pid = a && a.paymentId; }
    if (!pid && refundId) { const r = this.store.getRefund(refundId); pid = r && r.paymentId; }
    if (!pid) return undefined;
    await this.store.hydratePayment(pid);
    const p = this.store.getPayment(pid);
    return p ? (p.shopId || 'default') : undefined;
  }

  // Kiểm tra cấu hình khi nạp (PHUB-D-009): lỗi cấu hình phải dừng khởi động, không để lộ lúc có giao dịch. Phần cổng do module routing kiểm.
  static validateRouting(config, adapters) {
    const seen = routing.validateGateways(config.gateways, adapters);
    for (const id of Object.keys(config.reconcile.perGateway || {})) if (!seen.has(id)) throw new Error(`cấu hình đối soát: cổng không tồn tại ${id}`);
    for (const [where, rc] of [['reconcile', config.reconcile], ...Object.entries(config.reconcile.perGateway || {}).map(([id, v]) => [`reconcile.perGateway.${id}`, v])]) {
      const s = rc.closedRecheckSeconds;
      if (s !== undefined && (!Array.isArray(s) || s.some((x, i) => !(Number.isFinite(x) && x > 0) || (i > 0 && x <= s[i - 1])))) throw new Error(`${where}.closedRecheckSeconds phải là danh sách số giây dương tăng dần (hoặc [] để tắt)`);
    }
  }

  /** Khóa của một mục routing: id, hoặc id/adapterProduct khi mục chọn sản phẩm của adapter. */
  static routeKey(g) { return routing.routeKey(g); }

  // Product adapter dùng cho attempt tạo qua mục g: mục khai adapterProduct thì dùng khi payment không đòi product cụ thể.
  _productFor(g, payment) { return routing.productFor(g, payment); }

  // Lịch đối soát của một cổng: mặc định chung, ghi đè theo cổng.
  _rc(gateway) { return { ...this.config.reconcile, ...(this.config.reconcile.perGateway[gateway] || {}) }; }

  // Gửi webhook đến hạn ở nền, không chặn thao tác công khai.
  _kickWebhooks() {
    if (!this.events.enabled || this.events.cfg.auto === false || this._delivering) return;
    // Không quét hộp thư đi sau mỗi thao tác: tối đa một lần mỗi 250ms (vòng lập lịch lo phần còn lại).
    const t = Date.now();
    if (t - (this._lastKick || 0) < 250) return;
    this._lastKick = t;
    if (!this.events.due(this.now()).length) return;
    this._delivering = true;
    setImmediate(() => { this.deliverWebhooks().catch(() => {}).finally(() => { this._delivering = false; }); });
  }

  async deliverWebhooks() {
    const n = await this.events.deliverDue();
    if (n) await this._persist();
    return { delivered: n };
  }

  async retryWebhook(id) {
    const cur = this.store.getWebhook(id) || await this.store.loadWebhook(id);
    if (!cur) throw new HubError('not_found', `không có webhook ${id}`);
    if (!['dead', 'pending'].includes(cur.status)) throw new HubError('invalid_state', 'chỉ gửi lại được webhook dead hoặc pending');
    const w = await this.events.retry(id);
    await this._persist();
    this._kickWebhooks();
    return w;
  }

  async webhookShop(id) {
    const w = this.store.getWebhook(id) || await this.store.loadWebhook(id);
    return w ? (w.shopId || 'default') : undefined;
  }

  listWebhooks(filter = {}) { return this.store.listWebhooks(filter); } // filter: {status, limit, shopId}
  listCalls(filter = {}) { return this.store.listCalls(filter); }

  gatewayStatus() {
    return Object.keys(this.adapters).map((id) => (this.guards[id] ? this.guards[id].status() : { gateway: id, state: 'unguarded' }));
  }

  _available(gatewayId) { return !this.guards[gatewayId] || this.guards[gatewayId].available(); }

  // Anomaly mới luôn đi kèm sự kiện webhook anomaly.opened.
  _addAnomaly(an) {
    const a = this.store.addAnomaly(an);
    this.events.emit('anomaly.opened', a.id, a.id, { anomalyId: a.id, type: a.type, paymentId: a.paymentId || null, attemptId: a.attemptId || null, gateway: a.gateway || null, amount: a.amount ?? null, gatewayTxnId: a.gatewayTxnId || null }, a.paymentId ? (this.store.getPayment(a.paymentId) || {}).shopId : undefined);
    return a;
  }

  _emitPaid(payment, attempt) {
    this.events.emit('payment.paid', payment.id, 'paid', { paymentId: payment.id, orderId: payment.orderId, amount: payment.amount, currency: payment.currency, status: payment.status, paidAt: payment.paidAt, attemptId: attempt.id, gateway: attempt.gateway, gatewayTxnId: attempt.gatewayTxnId || null }, payment.shopId);
  }

  _setRefund(r, status) {
    if (r.status === status) return;
    r.status = status;
    if (['SUCCEEDED', 'FAILED', 'MANUAL_REQUIRED'].includes(status)) {
      const p = this.store.getPayment(r.paymentId);
      this.events.emit('refund.updated', r.id, status, { refundId: r.id, paymentId: r.paymentId, attemptId: r.attemptId, amount: r.amount, status }, p && p.shopId);
    }
  }

  // ---------- bộ lập lịch đối soát ----------

  // Gọi reconcile() định kỳ; không chồng lấn; timer không giữ tiến trình sống; lỗi không làm chết vòng lặp.
  startScheduler({ everySeconds = 30, onError } = {}) {
    if (this._timer) return;
    this._ticking = false;
    const tick = async () => {
      if (this._ticking) return;
      this._ticking = true;
      try {
        await this.reconcile();
      } catch (err) {
        if (onError) onError(err);
        else this.store.addEvent({ at: this.now(), outcome: 'scheduler_error', detail: err.message });
      } finally {
        this._ticking = false;
      }
    };
    this._timer = setInterval(tick, everySeconds * 1000);
    this._timer.unref();
    // Webhook đến hạn gửi lại: kiểm tra thường xuyên hơn vòng đối soát.
    this._hookTimer = setInterval(() => this._kickWebhooks(), Math.min(everySeconds, 2) * 1000);
    this._hookTimer.unref();
    // Đẩy giao dịch đã đóng ra khỏi bộ nhớ; dọn khóa idempotency quá hạn mỗi giờ.
    const hot = this.config.hot;
    this._evictTimer = setInterval(() => {
      try { this.store.evictIdle(hot.idleSeconds * 1000); } catch (err) { if (onError) onError(err); }
      if (typeof this.store.purgeSeen === 'function' && Date.now() - (this._lastPurge || 0) > 3600000) {
        this._lastPurge = Date.now();
        this.store.purgeSeen(hot.seenTtlDays).catch((err) => { if (onError) onError(err); });
      }
    }, hot.evictEverySeconds * 1000);
    this._evictTimer.unref();
  }

  stopScheduler() {
    if (this._timer) clearInterval(this._timer);
    if (this._hookTimer) clearInterval(this._hookTimer);
    if (this._evictTimer) clearInterval(this._evictTimer);
    this._evictTimer = null;
    this._timer = null;
    this._hookTimer = null;
  }

  // ---------- tạo thanh toán, routing, failover ----------

  async createPayment(input) {
    const { orderId, amount, orderInfo, returnUrl } = input;
    if (!orderId) throw new HubError('invalid_input', 'thiếu orderId');
    // Số nguyên an toàn và có trần: cổng nhân hệ số (VNPay, OnePAY nhân 100) nên số quá lớn mất chính xác hoặc thành dạng 1e+23 trong chữ ký (PHUB-D-019).
    const currency = input.currency === undefined || input.currency === null ? 'VND' : input.currency;
    if (typeof currency !== 'string' || !Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, currency)) throw new HubError('invalid_input', `currency phải là mã ISO 4217 trong: ${Object.keys(CURRENCY_EXPONENT).join(', ')}`);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new HubError('invalid_input', currency === 'VND' ? 'amount phải là số nguyên VND > 0' : `amount phải là số nguyên > 0 theo đơn vị nhỏ nhất của ${currency}`);
    if (amount > this.config.maxAmount) throw new HubError('invalid_input', `amount vượt trần ${this.config.maxAmount} VND`);
    if (input.method !== undefined && input.method !== null && !METHODS.includes(input.method)) throw new HubError('invalid_input', `method phải là một trong: ${METHODS.join(', ')}`);
    if (!returnUrl) throw new HubError('invalid_input', 'thiếu returnUrl');
    this._checkExtra(input.extra);
    const shopId = input.shopId || 'default';
    await this.store.hydrateOrder(orderId, shopId); // payment của đơn có thể đã được đẩy ra khỏi bộ nhớ: không được tạo trùng
    // Idempotent theo (cửa hàng, orderId) (PHUB-D-008, D-015): cửa hàng gọi lại khi timeout không được tạo thêm một lần thu tiền.
    const existing = this.store.findPaymentByOrderId(orderId, shopId);
    if (existing && existing.status !== 'CLOSED') {
      if (existing.amount !== amount || (existing.currency || 'VND') !== currency) throw new HubError('order_conflict', `đơn ${orderId} đã có payment với số tiền khác`);
      const attempts = this.store.attemptsOfPayment(existing.id);
      return { payment: existing, attempt: attempts[attempts.length - 1], existing: true };
    }
    const now = this.now();
    const payment = this.store.putPayment({
      id: this.store.nextId('pay'),
      shopId,
      orderId,
      amount,
      currency,
      orderInfo: orderInfo || `Thanh toan don hang ${orderId}`,
      product: input.product || 'default',
      method: input.method || null, // phương án thanh toán chuẩn cửa hàng yêu cầu; null = cổng nào cũng được (PHUB-D-029)
      extra: input.extra || null, // { <idCổng>: {...} }: lõi chỉ lưu và chuyển tiếp phần của cổng được chọn, không đọc giá trị (PHUB-D-016)
      returnUrl,
      clientIp: input.clientIp || '127.0.0.1',
      status: 'OPEN',
      createdAt: now,
      expiresAt: input.expiresAt || now + this.config.paymentTtlSeconds * 1000,
      paidByAttempt: null,
    });
    return this._startAttempt(payment, { exclude: [] });
  }

  // Tạo attempt mới cho payment đang mở. reason: 'customer_retry' | 'failover'.
  async createAttempt(paymentId, { reason = 'customer_retry', cancelLive = false } = {}) {
    await this.store.hydratePayment(paymentId);
    const payment = this.store.getPayment(paymentId);
    if (!payment) throw new HubError('not_found', `không có payment ${paymentId}`);
    if (payment.status !== 'OPEN') throw new HubError('payment_not_open', `payment ${payment.status}`);
    if (reason === 'failover' && !this.config.failover.enabled) throw new HubError('failover_disabled');
    const prior = this.store.attemptsOfPayment(paymentId);
    if (reason === 'failover') {
      // Chuyển cổng chỉ đọc lý do chuẩn của attempt cuối, không biết mã riêng của cổng nào (PHUB-D-020).
      const last = prior[prior.length - 1];
      if (last && last.failCode && this.config.failover.skipOnFailCodes.includes(last.failCode)) throw new HubError('failover_not_applicable', `attempt trước thất bại vì ${last.failCode}: không chuyển cổng (dùng customer_retry nếu khách muốn thử lại)`);
    }
    if (prior.length >= this.config.failover.maxAttempts) throw new HubError('max_attempts', 'quá số attempt cho phép');

    // Chỉ tạo attempt mới khi attempt cũ chắc chắn không thể nhận tiền (PHUB-D-002 mục 6).
    for (const a of prior.filter((x) => LIVE.includes(x.status) && x.status !== 'AUTHORIZED')) {
      const adapter = this.adapters[a.gateway];
      if (cancelLive && typeof adapter.cancel === 'function' && adapter.capabilities(a.product).cancellable) {
        const r = await adapter.cancel({ attemptRef: a.ref, state: a.state });
        if (r && r.cancelled) this._finalize(a, 'CANCELLED', 'cancelled_by_hub');
      }
    }
    if (prior.some((x) => this.canTakeMoney(x))) throw new HubError('attempt_still_live', 'còn attempt có thể nhận tiền');

    const exclude = reason === 'failover' ? prior.flatMap((a) => [a.gateway, `${a.gateway}/${a.product}`]) : [];
    return this._startAttempt(payment, { exclude });
  }

  canTakeMoney(attempt) { return LIVE.includes(attempt.status); }

  // Chọn cổng do module routing làm (PHUB-D-029); Hub chỉ cho biết cổng nào đang khả dụng (breaker, quá tải: chưa gọi nên chắc chắn chưa nhận tiền, PHUB-D-010).
  _candidates(payment, exclude) {
    return routing.candidates({ gateways: this.config.gateways, adapters: this.adapters, payment, exclude, isAvailable: (id) => this._available(id) });
  }

  // Mã tham chiếu: mặc định tiền tố BSN + hex; cổng có referenceFormat thì cắt độ dài / viết hoa theo yêu cầu.
  _refFor(fmt) {
    let r = this.newRef((fmt && fmt.prefix) || 'BSN');
    if (fmt && fmt.maxLength) r = r.slice(0, fmt.maxLength);
    if (fmt && fmt.caseInsensitive) r = r.toUpperCase();
    return r;
  }

  /** extra = { <idCổng>: {khóa: giá trị} }: mỗi phần phải khớp extraSchema của adapter đó; cổng lạ hoặc khóa lạ bị từ chối ngay (không bỏ qua im lặng). */
  _checkExtra(extra) {
    if (extra === undefined || extra === null) return;
    if (typeof extra !== 'object' || Array.isArray(extra)) throw new HubError('invalid_input', 'extra phải là đối tượng {idCổng: {khóa: giá trị}}');
    for (const [gw, part] of Object.entries(extra)) {
      const adapter = this.adapters[gw];
      if (!adapter) throw new HubError('invalid_input', `extra.${gw}: không có cổng này`);
      let schema;
      try { schema = adapter.capabilities().extraSchema; } catch { schema = undefined; }
      const bad = checkExtra(part, schema);
      if (bad) throw new HubError('invalid_input', `extra.${gw}: ${bad}`);
    }
  }

  async _startAttempt(payment, { exclude }) {
    const candidates = this._candidates(payment, exclude);
    if (!candidates.length) throw new HubError('no_gateway_available', 'không có cổng phù hợp');
    const tried = [];
    for (const g of candidates) {
      const adapter = this.adapters[g.id];
      const product = this._productFor(g, payment);
      const caps = adapter.capabilities(product);
      const now = this.now();
      const attempt = this.store.putAttempt({
        id: this.store.nextId('att'),
        ref: this._refFor(caps.referenceFormat),
        paymentId: payment.id,
        gateway: g.id,
        product,
        amount: payment.amount,
        status: 'CREATED',
        url: null,
        createdAt: now,
        expiresAt: payment.expiresAt,
        gatewayTxnId: null,
        failReason: null,
        checks: 0,
        nextCheckAt: caps.queryable ? now + this._rc(g.id).firstAfterSeconds * 1000 : null,
        needsOperator: false,
      });
      let res;
      try {
        res = await adapter.createPayment({
          attemptRef: attempt.ref,
          amount: payment.amount,
          currency: payment.currency,
          orderInfo: payment.orderInfo,
          returnUrl: payment.returnUrl,
          product,
          clientIp: payment.clientIp,
          expiresAt: payment.expiresAt,
          ...(payment.extra && payment.extra[g.id] ? { extra: payment.extra[g.id] } : {}),
        });
      } catch (err) {
        // Chưa gửi (breaker mở, quá tải): chắc chắn chưa nhận tiền, chuyển cổng được.
        // Đã gửi mà mất phản hồi: tiền có thể đã bị thu, không failover.
        if (err && err.notSent) res = { status: 'rejected', reason: err.code };
        else res = caps.createCanTimeout ? { status: 'unknown' } : { status: 'rejected', reason: `adapter_error: ${err.message}` };
      }
      // Kết quả sai hình dạng (state quá lớn, instructions thiếu trường): cổng có thể đã tạo giao dịch nên coi là unknown, không bỏ attempt.
      const bad = checkCreateResult(res);
      if (bad) {
        this.store.addEvent({ at: this.now(), attemptId: attempt.id, gateway: g.id, outcome: 'bad_create_result', detail: bad });
        res = { status: 'unknown' };
      }
      if (res.state !== undefined) attempt.state = res.state;
      // Thông báo của cổng đến TRƯỚC khi lời gọi tạo trả về (P-012): attempt đã rời CREATED (thu tiền, thất bại...). Kết quả tạo đến muộn không được
      // ghi đè trạng thái đó (trạng thái cuối bất biến); chỉ giữ state của cổng để truy vấn và hoàn tiền về sau.
      if (attempt.status !== 'CREATED') {
        this.store.addEvent({ at: this.now(), attemptId: attempt.id, gateway: g.id, outcome: 'create_result_after_callback', detail: `${res.status}; attempt đang ${attempt.status}` });
        return { payment, attempt };
      }
      if (res.status === 'redirect') {
        attempt.status = 'AWAITING';
        attempt.url = res.url;
        // Cổng bắt khách gửi form POST (đã ký) thay vì mở URL GET: giữ method và fields để cửa hàng dựng form.
        if (res.method && res.method !== 'GET') { attempt.method = res.method; attempt.fields = res.fields || {}; }
        if (res.expiresAt) attempt.expiresAt = res.expiresAt;
        return { payment, attempt };
      }
      if (res.status === 'instructions') {
        // Kiểu chuyển khoản: khách tự chuyển theo hướng dẫn, không có URL chuyển hướng.
        attempt.status = 'AWAITING';
        attempt.instructions = res.instructions;
        if (res.expiresAt) attempt.expiresAt = res.expiresAt;
        return { payment, attempt };
      }
      if (res.status === 'next_action') {
        // Bước tiếp theo dạng dữ liệu chuẩn (PHUB-D-035). Kiểu tương đương với trường cũ thì điền cả trường cũ để cửa hàng cũ vẫn dùng được.
        attempt.status = 'AWAITING';
        const na = res.nextAction;
        attempt.nextAction = na;
        if (na.type === 'redirect') attempt.url = na.url;
        else if (na.type === 'post_redirect') { attempt.url = na.url; attempt.method = 'POST'; attempt.fields = na.fields; }
        else if (na.type === 'transfer') attempt.instructions = na.instructions;
        if (res.expiresAt) attempt.expiresAt = res.expiresAt;
        return { payment, attempt };
      }
      if (res.status === 'unknown') {
        attempt.status = 'UNKNOWN';
        return { payment, attempt };
      }
      // rejected: chắc chắn chưa có giao dịch, thử cổng kế tiếp.
      this._finalize(attempt, 'FAILED', res.reason || 'rejected', { failCode: res.failCode, gatewayCode: res.gatewayCode, neverCreated: true });
      tried.push(g.id);
    }
    throw new HubError('no_gateway_available', `tất cả cổng từ chối: ${tried.join(', ')}`);
  }

  // ---------- callback ----------

  /**
   * @returns {{ack:Object, outcome:string, attempt?:Object}}
   */
  async handleCallback(gatewayId, req) {
    const adapter = this.adapters[gatewayId];
    if (!adapter) throw new HubError('unknown_gateway', gatewayId);
    let res;
    try {
      res = await adapter.parseCallback(req);
    } catch (err) {
      this.store.addEvent({ at: this.now(), gateway: gatewayId, outcome: 'parse_error', detail: err.message });
      return { ack: { status: 500, body: 'error', contentType: 'text/plain' }, outcome: 'error' };
    }
    if (!res.valid) {
      this.store.addEvent({ at: this.now(), gateway: gatewayId, outcome: 'invalid_signature' });
      return { ack: res.ack('invalid_signature'), outcome: 'invalid_signature' };
    }
    if (res.retryLater) {
      // Chữ ký hợp lệ nhưng chưa gắn được sự kiện vì lỗi tra cứu tạm thời: không đổi gì, để cổng gửi lại (PHUB-D-018, P7).
      this.store.addEvent({ at: this.now(), gateway: gatewayId, outcome: 'retry_later', detail: res.reason });
      return { ack: res.ack('error'), outcome: 'retry_later' };
    }
    if (!res.event) {
      // Hợp lệ nhưng không mang tin về tiền cần xử lý (ví dụ tiền ra): ghi nhận và bỏ qua.
      this.store.addEvent({ at: this.now(), gateway: gatewayId, outcome: 'ignored' });
      return { ack: res.ack('ok'), outcome: 'ok' };
    }
    let outcome;
    let attempt;
    try {
      await this.store.prepareEvent(gatewayId, res.event); // attempt cũ có thể đang nằm ở DB
      outcome = this._route(gatewayId, res.event);
      attempt = res.event.attemptRef ? this.store.findAttemptByRef(gatewayId, res.event.attemptRef) : undefined;
    } catch (err) {
      this.store.addEvent({ at: this.now(), gateway: gatewayId, outcome: 'apply_error', detail: err.message });
      outcome = 'error';
    }
    return { ack: res.ack(outcome), outcome, attempt };
  }

  // Định tuyến một sự kiện chuẩn: tiền chưa rõ chủ, attempt lạ, hoặc áp lên attempt.
  _route(gatewayId, ev) {
    assertEvent(ev);
    if (ev.unmatched || !ev.attemptRef) return this._recordUnmatched(gatewayId, ev);
    const attempt = this.store.findAttemptByRef(gatewayId, ev.attemptRef);
    if (!attempt) {
      const seen = this.store.anomaliesOfRef(gatewayId, ev.attemptRef).find((x) => x.type === 'unknown_attempt' && x.gatewayTxnId === (ev.gatewayTxnId || null) && x.amount === ev.amount);
      if (!seen) this._addAnomaly({ type: 'unknown_attempt', gateway: gatewayId, attemptRef: ev.attemptRef, amount: ev.amount, gatewayTxnId: ev.gatewayTxnId || null, at: this.now(), detail: ev.type });
      return 'unknown_attempt';
    }
    return this._applyEvent(attempt, ev);
  }

  // Tiền vào mà không gắn được attempt nào: giữ lại làm anomaly để xử lý thủ công (tiền thắng).
  _recordUnmatched(gatewayId, ev) {
    const key = [gatewayId, 'unmatched', ev.gatewayTxnId || '', ev.amount].join('|');
    if (this.store.markSeen(key)) return 'duplicate';
    this._addAnomaly({ type: 'unmatched_funds', gateway: gatewayId, amount: ev.amount, gatewayTxnId: ev.gatewayTxnId || null, at: this.now(), detail: { content: ev.content || null, occurredAt: ev.occurredAt } });
    return 'ok';
  }

  // Áp một sự kiện chuẩn lên attempt. Trả outcome để adapter dựng phản hồi cho cổng.
  _applyEvent(attempt, ev) {
    const now = this.now();
    const key = [ev.gateway, ev.attemptRef, ev.gatewayTxnId || '', ev.type, ev.source, ...(ev.type === 'reversed' || DISPUTE_TYPES.includes(ev.type) ? [ev.amount] : [])].join('|'); // đảo từng phần cùng một khoản gốc là các sự kiện khác nhau
    const dup = this.store.markSeen(key);
    this.store.addEvent({ at: now, attemptId: attempt.id, type: ev.type, source: ev.source, amount: ev.amount, duplicate: dup });
    if (dup) return 'duplicate';
    if (ev.source === 'return') return 'ok'; // chỉ để hiển thị
    const payment = this.store.getPayment(attempt.paymentId);

    if (ev.type === 'received') return this._applyReceived(attempt, payment, ev, now);
    if (ev.type === 'reversed') return this._applyReversed(attempt, payment, ev);
    if (DISPUTE_TYPES.includes(ev.type)) return this._applyDispute(attempt, payment, ev);
    if (ev.type === 'authorized') return this._applyAuthorized(attempt, payment, ev, now, key);

    if (ev.type === 'succeeded' && (ev.amount !== attempt.amount || (ev.currency !== undefined && ev.currency !== (payment.currency || 'VND')))) {
      this.store.forget(key); // lần gửi lại vẫn phải báo mismatch, không phải duplicate
      this._anomaly('amount_mismatch', attempt, ev, { expected: attempt.amount });
      return 'amount_mismatch';
    }

    if (!LIVE.includes(attempt.status)) {
      if (TYPE_TO_STATE[ev.type] === attempt.status) {
        // Cùng trạng thái thường là thông báo gửi lại. Nhưng nếu CÙNG một kênh báo "thành công" lần hai với mã giao dịch KHÁC thì đó là
        // một khoản thu thêm (PHUB-D-019). Khác kênh thì không kết luận: mã giao dịch giữa IPN và truy vấn của một số cổng có thể khác nhau.
        const first = ev.type === 'succeeded' && ev.gatewayTxnId && attempt.txnBySource && attempt.txnBySource[ev.source];
        if (first && first !== ev.gatewayTxnId) {
          this._anomaly('duplicate_charge', attempt, ev, { attemptStatus: attempt.status, paymentStatus: payment.status, sameAttempt: true, firstTxn: first });
          return 'ok';
        }
        return 'duplicate';
      }
      if (ev.type === 'succeeded') {
        const dupCharge = payment.status === 'PAID' && payment.paidByAttempt !== attempt.id;
        this._anomaly(dupCharge ? 'duplicate_charge' : 'late_success', attempt, ev, { attemptStatus: attempt.status, paymentStatus: payment.status });
      } else if (ev.type !== 'pending' && attempt.status === 'SUCCEEDED') {
        this._anomaly('conflicting_result', attempt, ev, { attemptStatus: attempt.status });
      }
      return 'ok';
    }

    if (ev.type === 'pending') {
      if (attempt.status !== 'AWAITING' && attempt.status !== 'AUTHORIZED') attempt.status = 'AWAITING';
      return 'ok';
    }
    if (ev.type === 'succeeded') {
      attempt.gatewayTxnId = ev.gatewayTxnId || null;
      if (ev.gatewayTxnId) attempt.txnBySource = { [ev.source]: ev.gatewayTxnId }; // để nhận ra khoản thu thứ hai cùng kênh (PHUB-D-019)
      this._finalize(attempt, 'SUCCEEDED', null);
      this._markPaid(attempt, payment, ev, now);
      return 'ok';
    }
    this._finalize(attempt, TYPE_TO_STATE[ev.type], ev.type, ev);
    this._maybeClosePayment(payment);
    return 'ok';
  }

  // Tiền bị cổng đảo lại (PHUB-D-018, P5): KHÔNG tự đổi trạng thái (đơn có thể đã giao); ghi lại, báo người vận hành, giảm phần còn hoàn được.
  _applyReversed(attempt, payment, ev) {
    attempt.reversedTotal = (attempt.reversedTotal || 0) + ev.amount;
    attempt.needsOperator = true;
    this._anomaly('funds_reversed', attempt, ev, { attemptStatus: attempt.status, paymentStatus: payment.status, reversedTotal: attempt.reversedTotal });
    return 'ok';
  }

  // Cổng GIỮ tiền cho attempt, chưa thu (PHUB-D-037). Số tiền hoặc loại tiền khác attempt thì giữ lại như amount_mismatch (như succeeded). Attempt đã đóng
  // mà cổng vẫn giữ tiền, hoặc đơn đã PAID/CLOSED, thì khoản giữ này không còn ai thu: ghi late_authorization để người vận hành nhả (void) ở cổng.
  _applyAuthorized(attempt, payment, ev, now, key) {
    if (ev.amount !== attempt.amount || (ev.currency !== undefined && ev.currency !== (payment.currency || 'VND'))) {
      this.store.forget(key); // lần gửi lại vẫn phải báo mismatch, không phải duplicate
      this._anomaly('amount_mismatch', attempt, ev, { expected: attempt.amount, stage: 'authorized' });
      return 'amount_mismatch';
    }
    if (attempt.status === 'AUTHORIZED') return 'duplicate';
    if (!LIVE.includes(attempt.status)) {
      // Cổng không đảm bảo thứ tự: 'authorized' cùng giao dịch đến SAU khi chính giao dịch đó đã được thu (SUCCEEDED) hoặc đã nhả/hết hạn (CANCELLED, EXPIRED)
      // là sự kiện đến muộn, không còn khoản giữ nào, không phải anomaly. FAILED thì giữ thận trọng (không biết khoản giữ còn hay không). Khác giao dịch là khoản giữ khác: vẫn là anomaly.
      if (ev.gatewayTxnId && ((attempt.status === 'SUCCEEDED' && attempt.gatewayTxnId === ev.gatewayTxnId) || (['CANCELLED', 'EXPIRED'].includes(attempt.status) && attempt.closedTxn === ev.gatewayTxnId))) return 'duplicate';
      attempt.needsOperator = true;
      this._anomaly('late_authorization', attempt, ev, { attemptStatus: attempt.status, paymentStatus: payment.status });
      return 'ok';
    }
    attempt.status = 'AUTHORIZED';
    attempt.authorizedAt = now;
    attempt.gatewayTxnId = ev.gatewayTxnId;
    attempt.op = null;
    if (attempt.nextCheckAt == null) attempt.nextCheckAt = now + this._rc(attempt.gateway).firstAfterSeconds * 1000; // vẫn hỏi lại cổng định kỳ: khoản giữ có thể được thu hay nhả ngoài Hub
    if (payment.status !== 'OPEN') {
      attempt.needsOperator = true;
      this._anomaly('late_authorization', attempt, ev, { attemptStatus: attempt.status, paymentStatus: payment.status });
    }
    return 'ok';
  }

  // Tranh chấp (chargeback) mở, thắng, thua (PHUB-D-036): KHÔNG tự đổi trạng thái (đơn có thể đã giao, tiền có thể mất); ghi anomaly cùng tên, báo người vận hành.
  _applyDispute(attempt, payment, ev) {
    attempt.needsOperator = true;
    this._anomaly(ev.type, attempt, ev, { attemptStatus: attempt.status, paymentStatus: payment.status, stage: ev.type.slice('dispute_'.length) });
    return 'ok';
  }

  // Attempt vừa SUCCEEDED: payment OPEN thì PAID; PAID bởi attempt khác thì thu hai lần; đã đóng thì tiền về muộn.
  _markPaid(attempt, payment, ev, now) {
    if (payment.status === 'OPEN') {
      payment.status = 'PAID';
      payment.paidByAttempt = attempt.id;
      payment.paidAt = now;
      this._emitPaid(payment, attempt);
    } else if (payment.status === 'PAID') {
      this._anomaly('duplicate_charge', attempt, ev, { paymentStatus: 'PAID' });
    } else {
      this._anomaly('late_success', attempt, ev, { paymentStatus: payment.status });
    }
  }

  // Kiểu chuyển khoản: mỗi khoản nhận cộng dồn vào attempt. Đủ hoặc thừa thì SUCCEEDED; thiếu thì giữ AWAITING + anomaly underpaid.
  _applyReceived(attempt, payment, ev, now) {
    attempt.receipts = attempt.receipts || [];
    if (attempt.receipts.some((r) => r.txn === ev.gatewayTxnId)) return 'duplicate'; // cùng khoản qua kênh khác
    attempt.receipts.push({ txn: ev.gatewayTxnId, amount: ev.amount, at: ev.occurredAt, source: ev.source });
    attempt.receivedTotal = (attempt.receivedTotal || 0) + ev.amount;

    if (!LIVE.includes(attempt.status)) {
      // Attempt đã có kết quả cuối: khoản này là tiền về muộn hoặc thu thêm, luôn giữ lại.
      if (attempt.status === 'SUCCEEDED') this._anomaly('duplicate_charge', attempt, ev, { attemptStatus: attempt.status });
      else this._anomaly(payment.status === 'PAID' && payment.paidByAttempt !== attempt.id ? 'duplicate_charge' : 'late_success', attempt, ev, { attemptStatus: attempt.status, paymentStatus: payment.status });
      return 'ok';
    }
    const total = attempt.receivedTotal;
    if (total >= attempt.amount) {
      attempt.gatewayTxnId = ev.gatewayTxnId;
      this._finalize(attempt, 'SUCCEEDED', null);
      this._markPaid(attempt, payment, { ...ev, amount: attempt.amount }, now);
      if (total > attempt.amount) this._anomaly('overpaid', attempt, { ...ev, amount: total - attempt.amount }, { expected: attempt.amount, received: total });
      for (const an of this.store.anomaliesOfAttempt(attempt.id)) if (an.type === 'underpaid' && an.status === 'open') an.status = 'superseded';
    } else {
      if (attempt.status !== 'AWAITING' && attempt.status !== 'AUTHORIZED') attempt.status = 'AWAITING';
      const open = this.store.anomaliesOfAttempt(attempt.id).find((an) => an.type === 'underpaid' && an.status === 'open');
      if (open) { open.amount = total; open.detail = { expected: attempt.amount, received: total }; }
      else this._addAnomaly({ type: 'underpaid', paymentId: attempt.paymentId, attemptId: attempt.id, gateway: attempt.gateway, amount: total, gatewayTxnId: ev.gatewayTxnId, at: now, detail: { expected: attempt.amount, received: total } });
    }
    return 'ok';
  }

  // info (failed/cancelled/expired do cổng báo hoặc từ chối lúc tạo): lý do chuẩn và mã gốc của cổng (PHUB-D-020). Không có info = Hub tự kết thúc.
  _finalize(attempt, state, reason, info) {
    attempt.status = state;
    if (info && info.gatewayTxnId) attempt.closedTxn = info.gatewayTxnId; // mã giao dịch của sự kiện đóng attempt: nhận ra sự kiện cùng giao dịch đến muộn do đảo thứ tự (PHUB-D-038)
    attempt.op = null; // thao tác thu/nhả đang chờ không còn ý nghĩa khi attempt đã có kết quả cuối
    attempt.failReason = reason;
    if (state !== 'SUCCEEDED') {
      const fc = info ? (FAIL_CODES.includes(info.failCode) ? info.failCode : 'unknown') : null;
      attempt.failCode = fc;
      attempt.gatewayCode = (info && info.gatewayCode) || null;
      this.metrics.inc('hub_attempt_failures_total', { gateway: attempt.gateway, status: state, fail_code: fc || 'none' });
    }
    attempt.finalizedAt = this.now();
    attempt.nextCheckAt = null;
    if (state !== 'SUCCEEDED') this._scheduleRecheck(attempt, info); // sau khi đã có finalizedAt: các mốc hỏi lại tính từ lúc đóng
  }

  // Đặt lịch hỏi lại một attempt vừa đóng không thành công (PHUB-D-027). Bỏ qua khi: tắt, attempt chưa từng được tạo ở cổng (cổng từ chối lúc tạo),
  // cổng không truy vấn được theo mã, hoặc cổng đã có sao kê đối soát (reconcileFeed) bắt tiền về muộn.
  _scheduleRecheck(attempt, info) {
    attempt.recheckAt = null;
    const schedule = this._rc(attempt.gateway).closedRecheckSeconds || [];
    if (!schedule.length || (info && info.neverCreated)) return;
    const adapter = this.adapters[attempt.gateway];
    if (!adapter || typeof adapter.reconcileFeed === 'function' || !adapter.capabilities(attempt.product).queryable) return;
    attempt.rechecks = 0;
    attempt.recheckAt = attempt.finalizedAt + schedule[0] * 1000;
  }

  _anomaly(type, attempt, ev, detail = {}) {
    const same = this.store.anomaliesOfAttempt(attempt.id).find((x) => x.type === type && x.amount === ev.amount && x.gatewayTxnId === (ev.gatewayTxnId || null));
    if (same) return same; // cùng bằng chứng gửi lại, không tạo thêm
    return this._addAnomaly({
      type,
      paymentId: attempt.paymentId,
      attemptId: attempt.id,
      gateway: attempt.gateway,
      amount: ev.amount,
      gatewayTxnId: ev.gatewayTxnId || null,
      at: this.now(),
      detail,
    });
  }

  _maybeClosePayment(payment) {
    if (payment.status !== 'OPEN') return;
    if (this.now() < payment.expiresAt) return;
    if (this.store.attemptsOfPayment(payment.id).some((a) => this.canTakeMoney(a))) return;
    payment.status = 'CLOSED';
    this.events.emit('payment.closed', payment.id, 'closed', { paymentId: payment.id, orderId: payment.orderId, amount: payment.amount, status: 'CLOSED' }, payment.shopId);
  }

  // ---------- đối soát ----------

  // Chạy một việc cho mỗi phần tử, song song tối đa n (guard.js giới hạn thêm theo từng cổng).
  async _pool(list, n, fn) {
    let i = 0;
    const worker = async () => { while (i < list.length) { const item = list[i++]; await fn(item); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(n, list.length)) }, worker));
  }

  async reconcile() {
    const now = this.now();
    const base = this.config.reconcile;
    let queried = 0;
    const due = [];
    for (const a of this.store.liveAttempts()) {
      const rc = this._rc(a.gateway);
      const since = a.status === 'AUTHORIZED' ? (a.authorizedAt || a.createdAt) : a.createdAt; // giữ tiền quá lâu mà không ai thu hay nhả: báo người vận hành, Hub không tự thu hay nhả
      if (now - since > rc.maxAgeSeconds * 1000 && !a.needsOperator) {
        a.needsOperator = true;
        this._addAnomaly({ type: a.status === 'AUTHORIZED' ? 'authorization_stale' : 'stale_attempt', paymentId: a.paymentId, attemptId: a.id, gateway: a.gateway, at: now, detail: { status: a.status } });
      }
      const adapter = this.adapters[a.gateway];
      // Qua hạn cứng của cổng (+ thời gian đệm): bắt buộc hỏi lại một lần cuối, không chờ lịch.
      const caps = adapter.capabilities(a.product);
      const hardMs = caps.hardExpiry && typeof caps.hardExpiry === 'object' ? caps.hardExpiry.minutes * 60000 : null;
      const finalDue = a.status !== 'AUTHORIZED' && hardMs != null && caps.queryable && !a.finalQueryDone && now >= a.createdAt + hardMs + rc.hardExpiryGraceSeconds * 1000;
      if (!finalDue && (a.nextCheckAt == null || a.nextCheckAt > now)) continue;
      due.push({ a, adapter, rc, finalDue });
    }
    await this._pool(due, base.concurrency, async ({ a, adapter, rc, finalDue }) => {
      if (!LIVE.includes(a.status)) return; // đã có kết quả cuối trong lúc chờ lượt
      let res = null;
      try {
        res = await adapter.query({ attemptRef: a.ref, amount: a.amount, product: a.product, createdAt: a.createdAt, state: a.state });
      } catch (err) {
        this.store.addEvent({ at: now, attemptId: a.id, outcome: 'query_error', detail: err.message });
        if (err && err.notSent) { a.nextCheckAt = now + 10000; return; } // chưa gọi được (breaker mở): không tính là một lần hỏi
      }
      queried += 1;
      a.checks += 1;
      const step = rc.backoffSeconds[Math.min(a.checks - 1, rc.backoffSeconds.length - 1)];
      a.nextCheckAt = now + step * 1000;
      const events = Array.isArray(res) ? res : res && res.type ? [res] : [];
      for (const e of events) {
        assertEvent(e);
        this._applyEvent(a, { ...e, source: 'query' });
      }
      // Thu hoặc nhả bị mất phản hồi: nếu cổng nói khoản giữ vẫn còn thì thao tác đó chưa xảy ra, cho phép làm lại. Cổng báo đã thu/nhả thì sự kiện ở trên đã đóng attempt.
      if (a.op && a.op.status === 'UNKNOWN' && a.status === 'AUTHORIZED' && events.some((e) => e.type === 'authorized')) a.op = null;
      // not_found / unknown: không đổi trạng thái (không bao giờ suy ra failed hoặc expired).
      if (finalDue) {
        a.finalQueryDone = true;
        if (LIVE.includes(a.status)) {
          // Cổng đã hết hạn cứng mà vẫn chưa có kết quả cuối: không tự kết luận, báo người vận hành sớm.
          a.needsOperator = true;
          this._addAnomaly({ type: 'expiry_unresolved', paymentId: a.paymentId, attemptId: a.id, gateway: a.gateway, at: now, detail: { status: a.status } });
        }
      }
    });
    await this.reconcileClosed(now);
    await this.reconcileFeeds(now);
    await this.arbitrateOpenAnomalies(now);
    for (const p of this.store.openPayments()) this._maybeClosePayment(p);
    await this.reconcileRefunds();
    return { queried };
  }

  // Hỏi lại các attempt đã đóng không thành công theo lịch closedRecheckSeconds (PHUB-D-027). Kết quả đi qua đúng đường xử lý sự kiện: tiền về muộn
  // trên attempt đã đóng thành anomaly late_success (hoặc duplicate_charge), trạng thái cuối không đổi. Lỗi gọi cổng thì thử lại sau, tối đa 5 lần liên tiếp.
  async reconcileClosed(now) {
    const due = this.store.recheckAttempts().filter((a) => a.recheckAt != null && a.recheckAt <= now);
    if (!due.length) return;
    await this._pool(due, this.config.reconcile.concurrency, async (a) => {
      const adapter = this.adapters[a.gateway];
      const schedule = this._rc(a.gateway).closedRecheckSeconds || [];
      let res = null;
      try {
        res = await adapter.query({ attemptRef: a.ref, amount: a.amount, product: a.product, createdAt: a.createdAt, state: a.state });
      } catch (err) {
        this.store.addEvent({ at: now, attemptId: a.id, outcome: 'recheck_error', detail: err.message });
        a.recheckErrors = (a.recheckErrors || 0) + 1;
        this.metrics.inc('hub_closed_rechecks_total', { gateway: a.gateway, outcome: 'error' });
        if (a.recheckErrors >= 5) { a.recheckAt = null; this._addAnomaly({ type: 'recheck_failed', paymentId: a.paymentId, attemptId: a.id, gateway: a.gateway, at: now, detail: { error: err.message } }); } else a.recheckAt = now + 600000;
        return;
      }
      a.recheckErrors = 0;
      const events = Array.isArray(res) ? res : res && res.type ? [res] : [];
      const before = this.store.anomaliesOfAttempt(a.id).length;
      for (const e of events) { assertEvent(e); this._applyEvent(a, { ...e, source: 'query' }); }
      const found = this.store.anomaliesOfAttempt(a.id).length > before;
      this.metrics.inc('hub_closed_rechecks_total', { gateway: a.gateway, outcome: found ? 'found_money' : 'nothing' });
      a.rechecks = (a.rechecks || 0) + 1;
      const next = schedule[a.rechecks];
      a.recheckAt = next != null ? a.finalizedAt + next * 1000 : null;
    });
  }

  // ---------- phân xử bằng query (PHUB-D-002 mục 9) ----------

  // Hỏi lại cổng về attempt của một anomaly; ghi verdict: success | failure | pending | unknown.
  // Thông báo (IPN/return) là bằng chứng yếu hơn truy vấn trực tiếp: query là trọng tài, nhưng không bao giờ đổi trạng thái cuối.
  async _arbitrate(an) {
    const attempt = this.store.getAttempt(an.attemptId);
    const adapter = attempt && this.adapters[attempt.gateway];
    let verdict = 'unknown';
    if (adapter && adapter.capabilities(attempt.product).queryable) {
      try {
        const res = await adapter.query({ attemptRef: attempt.ref, amount: attempt.amount, product: attempt.product, createdAt: attempt.createdAt, state: attempt.state });
        const events = Array.isArray(res) ? res : res && res.type ? [res] : [];
        const same = (e) => !an.gatewayTxnId || !e.gatewayTxnId || e.gatewayTxnId === an.gatewayTxnId;
        if (events.some((e) => ['succeeded', 'received'].includes(e.type) && same(e))) verdict = 'success';
        else if (events.some((e) => ['failed', 'cancelled', 'expired'].includes(e.type))) verdict = 'failure';
        else if (events.some((e) => e.type === 'pending')) verdict = 'pending';
      } catch (err) {
        this.store.addEvent({ at: this.now(), attemptId: attempt.id, outcome: 'arbitrate_error', detail: err.message });
      }
    }
    an.arbiter = { verdict, at: this.now() };
    // Cổng không xác nhận thành công mà ta đã ghi SUCCEEDED (thông báo mâu thuẫn): cần người xem.
    if (an.type === 'conflicting_result' && verdict !== 'success' && attempt) attempt.needsOperator = true;
    return verdict;
  }

  async arbitrateOpenAnomalies(now) {
    const wait = this.config.reconcile.firstAfterSeconds * 1000;
    for (const an of this.store.openAnomalies()) {
      if (an.status !== 'open' || !ARBITRATED.includes(an.type)) continue;
      const v = an.arbiter && an.arbiter.verdict;
      if (v === 'success' || v === 'failure') continue;
      if (an.arbiter && now - an.arbiter.at < wait) continue;
      await this._arbitrate(an);
    }
  }

  // Cổng không truy vấn được theo mã: kéo sao kê theo con trỏ, mọi khoản (kể cả chưa rõ chủ) đi qua cùng đường xử lý.
  async reconcileFeeds(now) {
    const every = this.config.reconcile.feedIntervalSeconds * 1000;
    for (const [gid, adapter] of Object.entries(this.adapters)) {
      if (typeof adapter.reconcileFeed !== 'function') continue;
      if (this.store.feedAt[gid] != null && now - this.store.feedAt[gid] < every) continue;
      this.store.feedAt[gid] = now;
      try {
        const r = await adapter.reconcileFeed({ cursor: this.store.cursors[gid], now });
        for (const ev of r.events || []) {
          try { await this.store.prepareEvent(gid, ev); this._route(gid, { ...ev, source: 'query' }); } catch (err) { this.store.addEvent({ at: now, gateway: gid, outcome: 'feed_event_error', detail: err.message }); }
        }
        if (r.nextCursor != null) this.store.cursors[gid] = r.nextCursor;
      } catch (err) {
        this.store.addEvent({ at: now, gateway: gid, outcome: 'feed_error', detail: err.message });
      }
    }
  }

  // ---------- hoàn tiền ----------

  // force: chỉ người vận hành, bỏ yêu cầu cổng xác nhận khi hoàn khoản nằm trong cảnh báo (đã tự kiểm tra ngoài hệ thống).
  async refund({ attemptId, amount, reason, force = false }) {
    await this.store.hydrateAttempt(attemptId);
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt) throw new HubError('not_found', `không có attempt ${attemptId}`);
    const held = this.store.anomaliesOfAttempt(attemptId).find((x) => ['late_success', 'duplicate_charge'].includes(x.type));
    if (attempt.status !== 'SUCCEEDED' && !held) throw new HubError('nothing_to_refund', 'attempt chưa nhận tiền');
    // Khoản nằm trong cảnh báo (tiền về muộn, thu hai lần) chỉ dựa vào MỘT thông báo chưa kiểm: phải được cổng xác nhận tiền đã về trước khi hoàn, như đường xử lý cảnh báo (PHUB-D-038).
    if (attempt.status !== 'SUCCEEDED' && held && !force) {
      if (!held.arbiter || held.arbiter.verdict !== 'success') await this._arbitrate(held);
      if (held.arbiter.verdict !== 'success') throw new HubError('not_confirmed', `cổng chưa xác nhận tiền đã về (verdict=${held.arbiter.verdict})`);
    }
    const txnId = attempt.gatewayTxnId || (held && held.gatewayTxnId) || null;
    const reversed = attempt.reversedTotal || 0; // phần cổng đã đảo lại thì không hoàn lần nữa
    const paid = (attempt.status === 'SUCCEEDED' ? (attempt.receivedTotal || attempt.amount) : held.amount) - reversed;
    if (paid <= 0) throw new HubError('nothing_to_refund', 'toàn bộ số tiền đã bị cổng đảo lại');
    const live = this.store.refundsOfAttempt(attemptId).filter((r) => r.status !== 'FAILED');
    const already = live.reduce((s, r) => s + r.amount, 0);
    // Trần hoàn tiền (PHUB-D-009): số lần và tuổi tối đa của giao dịch gốc.
    const cap = this.config.refund;
    if (live.length >= cap.maxPerAttempt) throw new HubError('refund_limit', `đã đạt ${cap.maxPerAttempt} lần hoàn cho attempt này`);
    if (this.now() - attempt.createdAt > cap.maxAgeDays * 86400000) throw new HubError('refund_limit', `giao dịch gốc quá ${cap.maxAgeDays} ngày`);
    const amt = amount == null ? paid - already : amount;
    if (!Number.isInteger(amt) || amt <= 0 || amt + already > paid) throw new HubError('invalid_refund_amount', `còn hoàn được ${paid - already}`);

    const adapter = this.adapters[attempt.gateway];
    const caps = adapter.capabilities(attempt.product);
    const now = this.now();
    const refund = this.store.putRefund({
      id: this.store.nextId('ref'),
      ref: this.newRef('RF'),
      attemptId,
      paymentId: attempt.paymentId,
      amount: amt,
      reason: reason || null,
      status: 'REQUESTED',
      createdAt: now,
      nextCheckAt: null,
      checks: 0,
    });
    if (caps.refundable !== 'api') {
      this._setRefund(refund, 'MANUAL_REQUIRED');
      return refund;
    }
    try {
      const r = await adapter.refund({ attemptRef: attempt.ref, refundRef: refund.ref, amount: amt, currency: (this.store.getPayment(attempt.paymentId) || {}).currency || 'VND', gatewayTxnId: txnId, originalAmount: paid, createdAt: attempt.createdAt, state: attempt.state, receipts: this._receiptsOf(attempt, held) });
      this._setRefund(refund, REFUND_STATE[r.status] || 'REQUESTED');
    } catch (err) {
      refund.lastError = err.message;
      // Chưa gửi (breaker mở, quá tải): chắc chắn chưa hoàn, cho phép gọi lại. Còn lại: không rõ, đối soát sau, không coi là failed.
      this._setRefund(refund, err && err.notSent ? 'FAILED' : 'REQUESTED');
    }
    if (REFUND_OPEN.includes(refund.status)) refund.nextCheckAt = now + this.config.reconcile.firstAfterSeconds * 1000;
    return refund;
  }

  // ---------- giữ tiền rồi thu sau (PHUB-D-037) ----------

  // Thu khoản đã giữ. Chỉ thu ĐỦ số đã giữ (thu một phần chưa hỗ trợ). Kết quả đi qua đúng đường sự kiện 'succeeded' nên đơn PAID theo quy tắc cũ.
  async capturePayment({ paymentId }) {
    const { payment, attempt } = await this._heldAttempt(paymentId, null, true);
    return this._heldOp(payment, attempt, 'capture');
  }

  // Nhả khoản đã giữ (void). Nhiều attempt cùng giữ tiền thì phải nêu attemptId.
  async voidPayment({ paymentId, attemptId }) {
    const { payment, attempt } = await this._heldAttempt(paymentId, attemptId, false);
    return this._heldOp(payment, attempt, 'void');
  }

  async _heldAttempt(paymentId, attemptId, needOpen) {
    await this.store.hydratePayment(paymentId);
    const payment = this.store.getPayment(paymentId);
    if (!payment) throw new HubError('not_found', `không có payment ${paymentId}`);
    if (needOpen && payment.status !== 'OPEN') throw new HubError('payment_not_open', 'payment không còn mở, không thu được');
    let held = this.store.attemptsOfPayment(paymentId).filter((a) => a.status === 'AUTHORIZED');
    if (attemptId) held = held.filter((a) => a.id === attemptId);
    if (!held.length) throw new HubError('invalid_state', 'không có attempt nào đang giữ tiền');
    if (held.length > 1) throw new HubError('invalid_state', 'nhiều attempt đang giữ tiền: nêu attemptId');
    return { payment, attempt: held[0] };
  }

  async _heldOp(payment, attempt, kind) {
    const adapter = this.adapters[attempt.gateway];
    const caps = adapter.capabilities(attempt.product);
    if (!(caps.operations || []).includes(kind) || typeof adapter[kind] !== 'function') throw new HubError('not_supported', `cổng ${attempt.gateway} không hỗ trợ ${kind}`);
    if (attempt.op) throw new HubError('op_in_progress', attempt.op.status === 'UNKNOWN' ? `đang chờ cổng xác nhận lần ${attempt.op.type} trước` : `đang ${attempt.op.type}`);
    const now = this.now();
    attempt.op = { type: kind, status: 'IN_FLIGHT', at: now }; // đặt đồng bộ trước khi gọi cổng: lời gọi thứ hai cùng lúc bị chặn
    let res;
    try {
      res = await adapter[kind]({ attemptRef: attempt.ref, amount: attempt.amount, currency: payment.currency || 'VND', gatewayTxnId: attempt.gatewayTxnId || null, state: attempt.state, idempotencyKey: `${attempt.id}:${kind}` });
    } catch (err) {
      // Chưa gửi (breaker mở, quá tải): chắc chắn chưa làm gì, cho phép gọi lại. Còn lại: không rõ, KHÔNG coi là thất bại.
      res = err && err.notSent ? { status: 'not_sent', reason: err.code } : { status: 'unknown', error: err && err.message };
    }
    try {
      if (res && res.status === 'not_sent') { attempt.op = null; throw new HubError('gateway_unavailable', `cổng ${attempt.gateway} chưa nhận lời gọi (${res.reason}), gọi lại sau`); }
      if (res && (res.status === 'captured' || res.status === 'voided') && res.status === (kind === 'capture' ? 'captured' : 'voided')) {
        attempt.op = null;
        if (kind === 'capture') {
          const ev = { gateway: attempt.gateway, attemptRef: attempt.ref, type: 'succeeded', amount: attempt.amount, currency: payment.currency || 'VND', gatewayTxnId: res.gatewayTxnId || attempt.gatewayTxnId, occurredAt: now, source: 'query' };
          assertEvent(ev);
          this._applyEvent(attempt, ev);
          return { outcome: 'captured', payment, attempt };
        }
        this._finalize(attempt, 'CANCELLED', 'voided_by_hub');
        this._maybeClosePayment(payment);
        return { outcome: 'voided', payment, attempt };
      }
      if (res && res.status === 'rejected') {
        attempt.op = null;
        this.store.addEvent({ at: now, attemptId: attempt.id, gateway: attempt.gateway, outcome: `${kind}_rejected`, detail: res.reason || null });
        throw new HubError(`${kind}_rejected`, res.reason || `cổng từ chối ${kind}`);
      }
      // unknown, hoặc kết quả sai hình dạng: tiền có thể đã thu hay nhả. Không đoán; hỏi lại cổng ngay lượt đối soát kế tiếp.
      attempt.op = { type: kind, status: 'UNKNOWN', at: now };
      this.store.addEvent({ at: now, attemptId: attempt.id, gateway: attempt.gateway, outcome: `${kind}_unknown`, detail: (res && res.error) || null });
      attempt.nextCheckAt = Math.min(attempt.nextCheckAt == null ? Infinity : attempt.nextCheckAt, now + this._rc(attempt.gateway).firstAfterSeconds * 1000);
      return { outcome: 'unknown', payment, attempt };
    } catch (err) {
      if (attempt.op && attempt.op.status === 'IN_FLIGHT') attempt.op = { ...attempt.op, status: 'UNKNOWN' };
      throw err;
    }
  }

  // Các khoản thu của attempt cho adapter chọn khoản gốc (PHUB-D-018, P4): kiểu received có danh sách đủ; kiểu succeeded chỉ có một khoản.
  _receiptsOf(attempt, held) {
    if (attempt.receipts && attempt.receipts.length) return attempt.receipts.map((r) => ({ txn: r.txn, amount: r.amount, at: r.at }));
    if (attempt.status === 'SUCCEEDED' && attempt.gatewayTxnId) return [{ txn: attempt.gatewayTxnId, amount: attempt.receivedTotal || attempt.amount }];
    if (held && held.gatewayTxnId) return [{ txn: held.gatewayTxnId, amount: held.amount }];
    return [];
  }

  async reconcileRefunds() {
    const now = this.now();
    const rc = this.config.reconcile;
    const due = this.store.openRefunds().filter((r) => r.nextCheckAt != null && r.nextCheckAt <= now);
    await this._pool(due, rc.concurrency, async (r) => {
      const attempt = this.store.getAttempt(r.attemptId);
      let notSent = false;
      try {
        const res = await this.adapters[attempt.gateway].queryRefund({ refundRef: r.ref, attemptRef: attempt.ref, createdAt: attempt.createdAt, state: attempt.state });
        if (REFUND_STATE[res.status]) this._setRefund(r, REFUND_STATE[res.status]);
      } catch (err) {
        r.lastError = err.message;
        notSent = !!(err && err.notSent);
      }
      if (notSent) { r.nextCheckAt = now + 10000; return; }
      r.checks += 1;
      const sched = this._rc(attempt.gateway).refundBackoffSeconds || rc.refundBackoffSeconds;
      r.nextCheckAt = REFUND_OPEN.includes(r.status) ? now + sched[Math.min(r.checks, sched.length - 1)] * 1000 : null;
    });
  }

  // Người vận hành xác nhận đã hoàn thủ công (cổng không có API hoàn).
  async markRefundDone(refundId) {
    await this.store.hydrateRefund(refundId);
    const r = this.store.getRefund(refundId);
    if (!r || r.status !== 'MANUAL_REQUIRED') throw new HubError('invalid_state', 'chỉ xác nhận được refund MANUAL_REQUIRED');
    this._setRefund(r, 'SUCCEEDED');
    r.nextCheckAt = null;
    return r;
  }

  // ---------- xử lý anomaly (tiền đang giữ) ----------

  // force: bỏ qua yêu cầu cổng xác nhận (người vận hành tự chịu trách nhiệm, đã kiểm tra ngoài hệ thống).
  async resolveAnomaly(anomalyId, { action, note, force = false }) {
    await this.store.hydrateAnomaly(anomalyId);
    const an = this.store.getAnomaly(anomalyId);
    if (!an || an.status !== 'open') throw new HubError('invalid_state', 'anomaly không mở');
    if ((an.type === 'funds_reversed' || an.type === 'late_authorization' || DISPUTE_TYPES.includes(an.type)) && action !== 'ignore') throw new HubError('invalid_state', `${an.type} chỉ xử lý bằng ignore kèm ghi chú (đã đối chiếu với cổng): Hub không tự đổi trạng thái đơn`);
    // Khoản thu thứ hai trên cùng attempt: API hoàn của cổng nhắm vào mã giao dịch của khoản đầu, Hub không nhắm được khoản thứ hai (PHUB-D-019).
    if (action === 'refund' && an.detail && an.detail.sameAttempt) throw new HubError('invalid_state', `khoản thu thứ hai ${an.gatewayTxnId} trên cùng attempt: hoàn tại cổng theo mã giao dịch rồi ignore kèm ghi chú (Hub hoàn theo mã ${an.detail.firstTxn})`);
    if (['refund', 'apply'].includes(action) && ARBITRATED.includes(an.type) && !force) {
      // Chỉ hoàn tiền hoặc áp dụng khi cổng xác nhận tiền đã về, tránh hoàn cho thông báo giả hoặc cũ.
      if (!an.arbiter || an.arbiter.verdict !== 'success') await this._arbitrate(an);
      if (an.arbiter.verdict !== 'success') throw new HubError('not_confirmed', `cổng chưa xác nhận tiền đã về (verdict=${an.arbiter.verdict})`);
    }
    if (action === 'refund') {
      const refund = await this.refund({ attemptId: an.attemptId, amount: an.amount, reason: `anomaly ${an.type}`, force });
      an.status = 'refunding';
      an.refundId = refund.id;
    } else if (action === 'apply') {
      const p = this.store.getPayment(an.paymentId);
      if (an.type !== 'late_success' || p.status !== 'OPEN' || an.amount !== p.amount) throw new HubError('invalid_state', 'không áp dụng được cho payment này');
      p.status = 'PAID';
      p.paidByAttempt = an.attemptId;
      p.paidAt = this.now();
      this._emitPaid(p, this.store.getAttempt(an.attemptId));
      an.status = 'applied';
    } else if (action === 'ignore') {
      an.status = 'ignored';
    } else {
      throw new HubError('invalid_input', `action không hợp lệ: ${action}`);
    }
    an.note = note || null;
    return an;
  }

  // Gọi một lần lúc khởi động (PHUB-D-025): đưa các attempt còn sống cho adapter nào có adopt() để nạp lại bộ nhớ đệm riêng, vì bộ nhớ đệm
  // trong tiến trình mất khi khởi động lại trong khi attempt vẫn còn sống ở kho. Lỗi của adapter không làm Hub dừng: ghi sự kiện adopt_error.
  async adoptAdapters() {
    const live = this.store.liveAttempts();
    const report = {};
    for (const [id, adapter] of Object.entries(this.adapters)) {
      if (typeof adapter.adopt !== 'function') continue;
      const mine = live.filter((a) => a.gateway === id).map((a) => ({ attemptRef: a.ref, product: a.product, state: a.state, createdAt: a.createdAt }));
      try {
        const n = await adapter.adopt({ attempts: mine });
        report[id] = Number.isInteger(n) ? n : mine.length;
      } catch (err) {
        this.store.addEvent({ at: this.now(), gateway: id, outcome: 'adopt_error', detail: err.message });
        report[id] = 'error';
      }
    }
    return report;
  }

  // ---------- truy vấn ----------

  getPayment(id) {
    const payment = this.store.getPayment(id);
    if (!payment) return undefined;
    const attempts = this.store.attemptsOfPayment(id);
    const refunds = attempts.flatMap((a) => this.store.refundsOfAttempt(a.id));
    const anomalies = [...this.store.anomaliesOfPayment(id)];
    return { payment, attempts, refunds, anomalies };
  }

  // Như getPayment nhưng nạp từ DB nếu payment đã được đẩy ra khỏi bộ nhớ.
  async loadPayment(id) {
    await this.store.hydratePayment(id);
    return this.getPayment(id);
  }

  // Anomaly theo bộ lọc, gồm cả phần đã đẩy ra khỏi bộ nhớ.
  findAnomalies(filter = {}) { return this.store.findAnomalies(filter); }

  listAnomalies(filter = {}) {
    return this.store.anomalies.filter((a) => (!filter.type || a.type === filter.type) && (!filter.status || a.status === filter.status));
  }
}

module.exports = { PaymentHub, HubError, LIVE, DEFAULTS, ARBITRATED, REFUND_STATE, TYPE_TO_STATE };

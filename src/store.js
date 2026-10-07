'use strict';
// spec: PHUB-S-037
// spec: PHUB-S-030
// spec: PHUB-S-001
// spec: PHUB-S-002
// spec: PHUB-S-006
// spec: PHUB-S-007
// spec: PHUB-S-009
// spec: PHUB-S-011
// spec: PHUB-S-012
// spec: PHUB-S-014
// spec: PHUB-S-015
// spec: PHUB-S-017
// spec: PHUB-S-010
// spec: PHUB-S-027
// spec: PHUB-S-026
// Kho dữ liệu trong bộ nhớ của lõi Hub, có chỉ mục và theo dõi thay đổi (PHUB-D-009).
// Thực thể trả ra từ store được bọc (Proxy) để ghi nhận mọi chỗ bị sửa, kể cả trường lồng nhau;
// store bền vững chỉ ghi các thực thể bẩn thay vì quét toàn bộ. Lõi Hub chỉ dùng các hàm dưới đây.
// Giao dịch đã đóng (PHUB-D-012): payment PAID/CLOSED, không còn attempt sống, hoàn tiền mở, anomaly mở, đã lưu xong và
// nhàn rỗi đủ lâu thì được đẩy ra khỏi bộ nhớ (evictIdle) và nạp lại theo yêu cầu (hydrate*, chỉ store bền vững có nghĩa).
// MemoryStore không bao giờ lưu nên mọi thực thể luôn bẩn và không bao giờ bị đẩy ra.

const LIVE_STATES = ['CREATED', 'AWAITING', 'UNKNOWN', 'AUTHORIZED']; // AUTHORIZED: cổng đang giữ tiền, chưa thu (PHUB-D-037)
const FINAL_WEBHOOK = ['delivered', 'dead'];

class MemoryStore {
  constructor() {
    this.payments = new Map();
    this.attempts = new Map();
    this.refunds = new Map();
    this.webhooks = new Map(); // chỉ webhook còn phải gửi (store bền vững bỏ webhook đã xong khỏi bộ nhớ)
    this._trackNew = false; // store bền vững bật: nhớ webhook mới tạo chưa được ghi xuống để kiểm trùng với bản đã giao (PHUB-D-030)
    this._newWebhooks = new Set();
    this.anomalies = [];
    this.events = []; // store bền vững chỉ giữ phần đuôi
    this.calls = []; // nhật ký gọi cổng, cùng cách giữ đuôi
    this.seen = new Set();
    this.cursors = {}; // gateway -> con trỏ sao kê
    this.feedAt = {}; // gateway -> lần kéo sao kê gần nhất
    this.seq = 0;
    this.extra = {}; // dữ liệu nhỏ cần sống qua khởi động lại (trạng thái breaker...); lưu cùng transaction

    this.dirty = new Set(); // `${kind}:${id}` của thực thể đã đổi từ lần lưu cuối
    this._proxies = new WeakMap();
    this._anomalyById = new Map();
    this._attemptByRef = new Map(); // `${gateway}|${ref}` -> attempt
    this._attemptByRefLower = new Map(); // `${gateway}|${ref thường}` -> attempt[]
    this._attemptsOfPayment = new Map();
    this._refundsOfAttempt = new Map();
    this._paymentByOrder = new Map(); // orderId -> payment mới nhất của đơn
    this._anomaliesBy = new Map(); // `a:${attemptId}` | `p:${paymentId}` | `r:${gateway}|${ref}` -> anomaly[]
    this._live = new Set(); // id attempt còn có thể nhận tiền
    this._recheck = new Set(); // id attempt đã đóng không thành công nhưng còn lịch hỏi lại cổng (PHUB-D-027)
    this._open = new Set(); // id payment đang OPEN
    this._openAnomalies = new Set(); // id anomaly đang mở
    this._pendingWebhooks = new Set();
    this.nowMs = () => Date.now();
    this._touched = new Map(); // paymentId -> lần đổi/dùng gần nhất (ms)
    this._closedPayments = new Set(); // id payment PAID hoặc CLOSED còn trong bộ nhớ (ứng viên đẩy ra)
    this._seenByPrefix = new Map(); // `${cổng}|${mã}` -> tập khóa idempotency của attempt đó
    this._openRefunds = new Set(); // id refund còn REQUESTED hoặc PROCESSING
  }

  // Số thứ tự tăng đơn điệu, dùng chung bộ đếm đã được lưu (PostgreSQL nạp lại khi khởi động): không phụ thuộc đồng hồ, nên đồng hồ lùi hay khởi động lại
  // không làm đảo thứ tự (hộp thư đi dùng làm thứ tự tạo, PHUB-D-026).
  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  nextId(prefix) {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  // ---------- theo dõi thay đổi ----------

  _wrap(target, onChange) {
    if (target === null || typeof target !== 'object') return target;
    const cached = this._proxies.get(target);
    if (cached) return cached;
    const self = this;
    const p = new Proxy(target, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        return v !== null && typeof v === 'object' ? self._wrap(v, onChange) : v;
      },
      set(t, k, v, r) { const ok = Reflect.set(t, k, v, r); onChange(); return ok; },
      deleteProperty(t, k) { const ok = Reflect.deleteProperty(t, k); onChange(); return ok; },
    });
    this._proxies.set(target, p);
    return p;
  }

  _tracked(kind, obj, reindex) {
    const key = `${kind}:${obj.id}`;
    const pid = kind === 'payment' ? obj.id : obj.paymentId;
    const onChange = () => { this.dirty.add(key); if (pid) this._touched.set(pid, this.nowMs()); if (reindex) reindex(p); };
    const p = this._wrap(obj, onChange);
    this.dirty.add(key);
    if (pid) this._touched.set(pid, this.nowMs());
    if (reindex) reindex(p);
    return p;
  }

  // Nạp từ nơi lưu (không đánh dấu bẩn). Dùng bởi store bền vững khi khởi động.
  adopt(kind, obj) {
    const p = this._adoptTracked(kind, obj);
    this.dirty.delete(`${kind}:${obj.id}`);
    if (kind === 'webhook') this._newWebhooks.delete(obj.id);
    return p;
  }

  _adoptTracked(kind, obj) {
    if (kind === 'payment') return this.putPayment(obj);
    if (kind === 'attempt') return this.putAttempt(obj);
    if (kind === 'refund') return this.putRefund(obj);
    if (kind === 'webhook') return this.putWebhook(obj);
    if (kind === 'anomaly') return this._addAnomalyObj(obj);
    throw new Error(`kind không hợp lệ: ${kind}`);
  }

  // Lấy đối tượng gốc theo khóa bẩn để lưu: `${kind}:${id}` -> đối tượng hoặc undefined.
  dirtyObject(key) {
    const i = key.indexOf(':');
    const kind = key.slice(0, i);
    const id = key.slice(i + 1);
    if (kind === 'payment') return this.payments.get(id);
    if (kind === 'attempt') return this.attempts.get(id);
    if (kind === 'refund') return this.refunds.get(id);
    if (kind === 'webhook') return this.webhooks.get(id);
    if (kind === 'anomaly') return this._anomalyById.get(id);
    return undefined;
  }

  _push(map, key, v) {
    const list = map.get(key);
    if (list) { if (!list.includes(v)) list.push(v); } else map.set(key, [v]);
  }

  // ---------- payment ----------

  putPayment(p) {
    const first = !this.payments.has(p.id);
    const proxy = this._tracked('payment', p, (x) => {
      if (x.status === 'OPEN') this._open.add(x.id); else this._open.delete(x.id);
      if (x.status === 'PAID' || x.status === 'CLOSED') this._closedPayments.add(x.id); else this._closedPayments.delete(x.id);
    });
    this.payments.set(p.id, proxy);
    if (first) {
      const key = this._orderKey(p.orderId, p.shopId);
      const prev = this._paymentByOrder.get(key);
      // payment mới nhất của đơn (trong phạm vi cửa hàng): id tăng dần theo thứ tự tạo
      if (!prev || this._idNum(proxy.id) >= this._idNum(prev.id)) this._paymentByOrder.set(key, proxy);
    }
    return proxy;
  }

  _idNum(id) { return Number(String(id).split('_')[1]) || 0; }

  getPayment(id) { return this.payments.get(id); }
  _orderKey(orderId, shopId) { return `${shopId || 'default'}|${orderId}`; }
  findPaymentByOrderId(orderId, shopId = 'default') { return this._paymentByOrder.get(this._orderKey(orderId, shopId)); }
  openPayments() { return [...this._open].map((id) => this.payments.get(id)).filter(Boolean); }

  // ---------- attempt ----------

  putAttempt(a) {
    const first = !this.attempts.has(a.id);
    const proxy = this._tracked('attempt', a, (x) => {
      if (LIVE_STATES.includes(x.status)) this._live.add(x.id); else this._live.delete(x.id);
      if (x.recheckAt != null) this._recheck.add(x.id); else this._recheck.delete(x.id);
    });
    this.attempts.set(a.id, proxy);
    if (first) {
      this._attemptByRef.set(`${a.gateway}|${a.ref}`, proxy);
      this._push(this._attemptByRefLower, `${a.gateway}|${String(a.ref).toLowerCase()}`, proxy);
      this._push(this._attemptsOfPayment, a.paymentId, proxy);
    }
    return proxy;
  }

  getAttempt(id) { return this.attempts.get(id); }

  findAttemptByRef(gateway, ref) {
    const exact = this._attemptByRef.get(`${gateway}|${ref}`);
    if (exact) return exact;
    // Một số cổng đổi chữ hoa/thường của mã (ví dụ nội dung chuyển khoản): thử lại không phân biệt hoa thường.
    const hits = this._attemptByRefLower.get(`${gateway}|${String(ref).toLowerCase()}`) || [];
    return hits.length === 1 ? hits[0] : undefined;
  }

  attemptsOfPayment(paymentId) { return [...(this._attemptsOfPayment.get(paymentId) || [])]; }
  liveAttempts() { return [...this._live].map((id) => this.attempts.get(id)).filter(Boolean); }
  recheckAttempts() { return [...this._recheck].map((id) => this.attempts.get(id)).filter(Boolean); }

  // ---------- refund ----------

  putRefund(r) {
    const first = !this.refunds.has(r.id);
    const proxy = this._tracked('refund', r, (x) => {
      if (x.status === 'REQUESTED' || x.status === 'PROCESSING') this._openRefunds.add(x.id); else this._openRefunds.delete(x.id);
    });
    this.refunds.set(r.id, proxy);
    if (first) this._push(this._refundsOfAttempt, r.attemptId, proxy);
    return proxy;
  }

  getRefund(id) { return this.refunds.get(id); }
  openRefunds() { return [...this._openRefunds].map((id) => this.refunds.get(id)).filter(Boolean); }
  refundsOfAttempt(attemptId) { return [...(this._refundsOfAttempt.get(attemptId) || [])]; }

  // ---------- anomaly ----------

  addAnomaly(an) {
    an.id = this.nextId('an');
    an.status = an.status || 'open';
    return this._addAnomalyObj(an);
  }

  _addAnomalyObj(an) {
    const proxy = this._tracked('anomaly', an, (x) => {
      if (x.status === 'open') this._openAnomalies.add(x.id); else this._openAnomalies.delete(x.id);
    });
    if (!this._anomalyById.has(an.id)) {
      this.anomalies.push(proxy);
      if (an.attemptId) this._push(this._anomaliesBy, `a:${an.attemptId}`, proxy);
      if (an.paymentId) this._push(this._anomaliesBy, `p:${an.paymentId}`, proxy);
      if (!an.attemptId && an.attemptRef) this._push(this._anomaliesBy, `r:${an.gateway}|${an.attemptRef}`, proxy);
    }
    this._anomalyById.set(an.id, proxy);
    return proxy;
  }

  getAnomaly(id) { return this._anomalyById.get(id); }
  anomaliesOfAttempt(attemptId) { return this._anomaliesBy.get(`a:${attemptId}`) || []; }
  anomaliesOfPayment(paymentId) { return this._anomaliesBy.get(`p:${paymentId}`) || []; }
  anomaliesOfRef(gateway, ref) { return this._anomaliesBy.get(`r:${gateway}|${ref}`) || []; }
  openAnomalies() { return [...this._openAnomalies].map((id) => this._anomalyById.get(id)).filter(Boolean); }

  // ---------- webhook đi (hộp thư đi) ----------

  putWebhook(w) {
    const proxy = this._tracked('webhook', w, (x) => {
      if (FINAL_WEBHOOK.includes(x.status)) this._pendingWebhooks.delete(x.id); else this._pendingWebhooks.add(x.id);
    });
    this.webhooks.set(w.id, proxy);
    if (this._trackNew) this._newWebhooks.add(w.id);
    return proxy;
  }

  /** Webhook vừa tạo trong tiến trình này và chưa được ghi xuống kho (chỉ store bền vững theo dõi). */
  isNewWebhook(id) { return this._newWebhooks.has(id); }

  getWebhook(id) { return this.webhooks.get(id); }
  async loadWebhook(id) { return this.webhooks.get(id); }
  pendingWebhooks() { return [...this._pendingWebhooks].map((id) => this.webhooks.get(id)).filter(Boolean); }

  /** Số lượng thực thể trong bộ nhớ (cho metrics). */
  counts() {
    return { payments: this.payments.size, attempts: this.attempts.size, liveAttempts: this._live.size, openPayments: this._open.size, openRefunds: this._openRefunds.size, openAnomalies: this._openAnomalies.size, pendingWebhooks: this._pendingWebhooks.size, dirty: this.dirty.size, seen: this.seen.size };
  }

  /** Danh sách webhook theo trạng thái (store bền vững đọc cả phần đã bỏ khỏi bộ nhớ). */
  async listWebhooks({ status, limit = 100, shopId } = {}) {
    return [...this.webhooks.values()].filter((w) => (!status || w.status === status) && (!shopId || (w.shopId || 'default') === shopId)).slice(-limit);
  }

  // ---------- nhật ký ----------

  addEvent(e) { this.events.push(e); return e; }

  addCall(c) { this.calls.push(c); return c; }

  /** Nhật ký gọi cổng, mới nhất trước. */
  async listCalls({ gateway, ref, limit = 100 } = {}) {
    return this.calls.filter((c) => (!gateway || c.gateway === gateway) && (!ref || c.ref === ref)).slice(-limit).reverse();
  }

  _prefixOf(key) { const a = key.indexOf('|'); const b = a < 0 ? -1 : key.indexOf('|', a + 1); return b < 0 ? key : key.slice(0, b); }

  _seenAddKey(key) {
    this.seen.add(key);
    const pre = this._prefixOf(key);
    const set = this._seenByPrefix.get(pre);
    if (set) set.add(key); else this._seenByPrefix.set(pre, new Set([key]));
  }

  forget(key) {
    this.seen.delete(key);
    const set = this._seenByPrefix.get(this._prefixOf(key));
    if (set) set.delete(key);
  }

  // Trả true nếu khóa đã thấy từ trước (idempotency của callback).
  markSeen(key) {
    if (this.seen.has(key)) return true;
    this._seenAddKey(key);
    return false;
  }

  // Nạp khóa idempotency đã lưu (không phải khóa mới: store bền vững không ghi lại).
  adoptSeen(keys) { for (const k of keys) if (!this.seen.has(k)) this._seenAddKey(k); }

  // ---------- nạp theo yêu cầu (no-op ở MemoryStore; PostgresStore ghi đè) ----------

  async hydratePayment() { /* mọi thứ đã nằm trong bộ nhớ */ }
  async hydrateOrder() {}
  async hydrateByRef() {}
  async hydrateAttempt() {}
  async hydrateRefund() {}
  async hydrateSeen() {} // khóa idempotency của lệnh nhận qua broker (PostgresStore tra DB nếu khóa không còn trong bộ nhớ)
  async hydrateAnomaly() {}
  /** Chuẩn bị bộ nhớ cho một sự kiện chuẩn sắp được xử lý: nạp attempt (và khóa idempotency) hoặc khóa của tiền chưa rõ chủ. */
  async prepareEvent() {}
  async findAnomalies(filter = {}) {
    return this.anomalies.filter((a) => (!filter.type || a.type === filter.type) && (!filter.status || a.status === filter.status));
  }

  // ---------- đẩy giao dịch đã đóng ra khỏi bộ nhớ ----------

  /**
   * Bỏ khỏi bộ nhớ các payment đã đóng, đã lưu xong và nhàn rỗi quá idleMs, cùng attempt, refund, anomaly và khóa idempotency của chúng.
   * Chỉ bỏ khi không còn gì có thể thay đổi: không attempt sống, không refund mở, không anomaly mở, không thực thể bẩn.
   * Trả số payment đã bỏ.
   */
  evictIdle(idleMs, now = this.nowMs()) {
    const cut = now - idleMs;
    let n = 0;
    const droppedAnomalies = new Set();
    for (const pid of [...this._closedPayments]) {
      const t = this._touched.get(pid);
      if (t == null || t > cut) continue;
      const attempts = this._attemptsOfPayment.get(pid) || [];
      if (attempts.some((a) => this._live.has(a.id) || this._recheck.has(a.id))) continue; // còn lịch hỏi lại cổng thì chưa đẩy ra
      const refunds = attempts.flatMap((a) => this._refundsOfAttempt.get(a.id) || []);
      if (refunds.some((r) => this._openRefunds.has(r.id))) continue;
      const anomalies = this._anomaliesBy.get(`p:${pid}`) || [];
      if (anomalies.some((x) => this._openAnomalies.has(x.id))) continue;
      const keys = [`payment:${pid}`, ...attempts.map((a) => `attempt:${a.id}`), ...refunds.map((r) => `refund:${r.id}`), ...anomalies.map((x) => `anomaly:${x.id}`)];
      if (keys.some((k) => this.dirty.has(k))) continue;

      const payment = this.payments.get(pid);
      for (const a of attempts) {
        this.attempts.delete(a.id);
        this._attemptByRef.delete(`${a.gateway}|${a.ref}`);
        const lowKey = `${a.gateway}|${String(a.ref).toLowerCase()}`;
        const low = (this._attemptByRefLower.get(lowKey) || []).filter((x) => x !== a);
        if (low.length) this._attemptByRefLower.set(lowKey, low); else this._attemptByRefLower.delete(lowKey);
        const pre = this._seenByPrefix.get(`${a.gateway}|${a.ref}`);
        if (pre) { for (const k of pre) this.seen.delete(k); this._seenByPrefix.delete(`${a.gateway}|${a.ref}`); }
        this._refundsOfAttempt.delete(a.id);
        this._anomaliesBy.delete(`a:${a.id}`);
      }
      for (const r of refunds) this.refunds.delete(r.id);
      for (const x of anomalies) { this._anomalyById.delete(x.id); this._openAnomalies.delete(x.id); droppedAnomalies.add(x); }
      this._anomaliesBy.delete(`p:${pid}`);
      this._attemptsOfPayment.delete(pid);
      this.payments.delete(pid);
      this._closedPayments.delete(pid);
      this._open.delete(pid);
      this._touched.delete(pid);
      const okey = payment && this._orderKey(payment.orderId, payment.shopId);
      if (payment && this._paymentByOrder.get(okey) === payment) this._paymentByOrder.delete(okey);
      n += 1;
    }
    if (droppedAnomalies.size) this.anomalies = this.anomalies.filter((x) => !droppedAnomalies.has(x));
    return n;
  }
}

module.exports = { MemoryStore, LIVE_STATES, FINAL_WEBHOOK };

'use strict';
// spec: PHUB-S-030
// spec: PHUB-S-011
// spec: PHUB-S-015
// spec: PHUB-S-017
// spec: PHUB-S-026
// Cổng ra chuẩn của Hub (PHUB-D-011, D-015, D-017): lõi chỉ gọi emit(type, objectId, version, data, shopId); mọi thứ về đích nằm ở đây
// và ở các sink (src/connectors/out/*), được tiêm từ ngoài (composition root), nên file này không biết sink cụ thể nào.
//
// Hộp thư đi bền vững: sự kiện ghi vào store trong cùng transaction với thay đổi trạng thái gây ra nó (store.putWebhook đánh dấu bẩn,
// persist() của thao tác công khai ghi chung). Mỗi sự kiện sinh MỘT BẢN GIAO cho mỗi tuyến khớp; mỗi bản giao có trạng thái, số lần thử,
// lịch thử lại, dead và gửi lại thủ công riêng, nên một đích chết không làm đích khác nhận trùng.
//
// Tuyến:
//   - "webhook" (ngầm): cấu hình webhook cũ (url/secret chung và theo từng cửa hàng); mã bản giao = eventId.
//   - tuyến khai báo trong config.routes: {id, sink, shops: '*' | [...], types: '*' | ['payment.*', ...], ...tham số sink};
//     mã bản giao = eventId + '~' + route.id.
// Sink: {kind, ordered, validate(route, name), deliver(delivery, route) -> {status?}} (ném lỗi nếu không giao được).
// Sink ordered: bản giao cùng (tuyến, key) được gửi theo thứ tự tạo; bản sau chờ bản trước xong hoặc dead.

const crypto = require('node:crypto');
const { assertSink } = require('./app/ports');

const DEFAULTS = {
  timeoutMs: 5000,
  maxAttempts: 16,
  backoffSeconds: [5, 30, 120, 600, 1800, 3600, 10800, 21600],
  concurrency: 10,
};
const LEGACY = 'webhook';

const eventId = (type, objectId, version) => 'evt_' + crypto.createHash('sha256').update([type, objectId, version].join('|')).digest('hex').slice(0, 32);

const matcher = (spec) => {
  if (spec === undefined || spec === '*') return () => true;
  const list = [].concat(spec);
  return (v) => list.some((p) => (p === '*' ? true : p.endsWith('*') ? v.startsWith(p.slice(0, -1)) : p === v));
};

// So sánh theo thứ tự tạo. Bản giao tạo trước khi có ord (nâng cấp) luôn đi trước bản có ord.
const byCreation = (a, b) => {
  const ao = a.ord != null; const bo = b.ord != null;
  if (ao && bo) return a.ord - b.ord;
  if (ao !== bo) return ao ? 1 : -1;
  return (a.seq || a.createdAt * 1000) - (b.seq || b.createdAt * 1000);
};

class EventOutbox {
  /**
   * config: {url, secret, timeoutMs, maxAttempts, backoffSeconds, concurrency, auto, shops: {shopId: {url, secret, ...ghi đè}}, routes: [...]}
   * url/secret ở gốc là endpoint webhook của cửa hàng "default" và của sự kiện không gắn cửa hàng.
   * @param {{store:Object, config?:Object, clock:{now:()=>number}, sinks?:Object<string, import('./app/ports').Sink>, metrics?:Object}} o  sinks: {kind: Sink} (port Sink: src/app/ports.js)
   */
  constructor({ store, config, clock, sinks = {}, metrics }) {
    this.store = store;
    this.clock = clock;
    this.sinks = sinks;
    this.metrics = metrics;
    const { shops = {}, routes = [], ...base } = config || {};
    this.cfg = { ...DEFAULTS, ...base };
    this.shops = shops;
    this.legacy = !!this.cfg.url || Object.values(shops).some((ep) => ep && ep.url);
    if (this.legacy) this._sinkOf(LEGACY, 'webhooks');
    if (this.cfg.url) this._checkRoute(LEGACY, this.cfg, 'webhooks');
    for (const [id, ep] of Object.entries(shops)) if (ep && ep.url) this._checkRoute(LEGACY, ep, `webhooks.shops.${id}`);
    const ids = new Set([LEGACY]);
    this.routes = routes.map((r, i) => {
      const name = `connectors.out[${i}]`;
      if (!r || !/^[a-z0-9_-]{1,32}$/.test(r.id || '')) throw new Error(`${name}.id không hợp lệ`);
      if (ids.has(r.id)) throw new Error(`${name}: trùng id tuyến ${r.id}`);
      ids.add(r.id);
      this._sinkOf(r.sink, name);
      this._checkRoute(r.sink, r, name);
      return { ...this.cfg, url: undefined, secret: undefined, ...r, _shops: matcher(r.shops), _types: matcher(r.types) };
    });
    this.enabled = this.legacy || this.routes.length > 0;
    this.ordered = this.routes.some((r) => this.sinks[r.sink].ordered);
    this._sending = new Set();
    this._counter = 0;
  }

  _sinkOf(kind, name) {
    const s = this.sinks[kind];
    if (!s) throw new Error(`${name}: không có sink "${kind}" (đã đăng ký: ${Object.keys(this.sinks).join(', ') || 'không có'})`);
    assertSink(s, name); // đúng hình dạng của port Sink trước khi dùng
    return s;
  }

  _checkRoute(kind, route, name) { this.sinks[kind].validate(route, name); }

  /** Endpoint webhook (đã gộp tùy chọn chung) của một cửa hàng; null nếu cửa hàng không nhận webhook. */
  endpointFor(shopId) {
    const sid = shopId || 'default';
    const shop = this.shops[sid];
    if (shop && shop.url) return { ...this.cfg, url: undefined, secret: undefined, ...shop };
    if (sid === 'default' && this.cfg.url) return this.cfg;
    return null;
  }

  /** Có tuyến nào nhận sự kiện loại này (của cửa hàng này; bỏ trống shopId = của bất kỳ cửa hàng nào) không. */
  hasRoute(type, shopId) {
    if (this.legacy && (shopId === undefined ? true : !!this.endpointFor(shopId))) return true;
    return this.routes.some((r) => r._types(type) && (shopId === undefined || r._shops(shopId)));
  }

  /** Cấu hình hiệu lực của một bản giao đã lưu (tra theo cấu hình lúc gửi: secret không nằm trong tài liệu đã lưu). */
  _routeOf(w) {
    if (!w.route || w.route === LEGACY) return { kind: LEGACY, route: this.endpointFor(w.shopId) };
    const r = this.routes.find((x) => x.id === w.route);
    return { kind: r ? r.sink : w.sink, route: r || null };
  }

  /**
   * Ghi sự kiện vào hộp thư đi (chưa gửi): một bản giao cho mỗi tuyến khớp. Trùng mã, hoặc không tuyến nào khớp, thì bỏ qua.
   * opts.key: khóa thứ tự (mặc định paymentId trong data, hoặc objectId).
   */
  emit(type, objectId, version, data, shopId, opts = {}) {
    if (!this.enabled) return null;
    const sid = shopId || 'default';
    const targets = [];
    if (this.legacy && this.endpointFor(sid)) targets.push({ route: LEGACY, sink: LEGACY });
    for (const r of this.routes) if (r._types(type) && r._shops(sid)) targets.push({ route: r.id, sink: r.sink });
    if (!targets.length) return null;
    const evId = eventId(type, objectId, version);
    const now = this.clock.now();
    const key = opts.key || (data && data.paymentId) || objectId;
    const body = JSON.stringify({ id: evId, type, createdAt: now, shopId: sid, key, data });
    let first = null;
    for (const t of targets) {
      const id = t.route === LEGACY ? evId : `${evId}~${t.route}`;
      if (this.store.getWebhook(id)) continue;
      const w = this.store.putWebhook({ id, eventId: evId, type, objectId, shopId: sid, route: t.route, sink: t.sink, key, body, status: 'pending', attempts: 0, nextAt: now, createdAt: now, seq: now * 1000 + (this._counter++ % 1000), ord: this.store.nextSeq ? this.store.nextSeq() : undefined, lastError: null, lastStatus: null, deliveredAt: null });
      first = first || w;
    }
    return first;
  }

  /** Bản giao đến hạn. Sink ordered: bản sau không đi trước bản trước (đang chờ thử lại hoặc đang gửi) của cùng tuyến và key. */
  due(now) {
    const out = [];
    const blocked = new Set();
    // Sink có thứ tự: duyệt theo thứ tự TẠO (seq), không theo thứ tự vào tập chờ. Bản cũ gửi lại thủ công được đưa về cuối tập chờ, nếu duyệt theo
    // tập thì bản mới hơn cùng key đi trước nó (PHUB-D-026).
    // Thứ tự tạo: bản có ord (bộ đếm lưu cùng kho, không đảo khi đồng hồ lùi hay khởi động lại) sau mọi bản cũ chưa có ord, bản cũ theo seq.
    const pending = this.ordered ? [...this.store.pendingWebhooks()].sort(byCreation) : this.store.pendingWebhooks();
    for (const w of pending) {
      if (w.status !== 'pending') continue;
      const { kind } = this._routeOf(w);
      const ordered = !!(this.sinks[kind] && this.sinks[kind].ordered);
      const slot = ordered ? `${w.route}|${w.key}` : null;
      if (slot && blocked.has(slot)) continue;
      if (slot) blocked.add(slot);
      if (w.nextAt <= now && !this._sending.has(w.id)) out.push(w);
    }
    return out;
  }

  /** Gửi mọi bản giao đến hạn, song song tối đa `concurrency`. Trả số đã thử. */
  async deliverDue() {
    if (!this.enabled) return 0;
    const list = this.due(this.clock.now());
    let i = 0;
    const worker = async () => { while (i < list.length) { const w = list[i++]; await this._send(w); } };
    await Promise.all(Array.from({ length: Math.min(this.cfg.concurrency, list.length) }, worker));
    return list.length;
  }

  async _send(w) {
    // Bản mới tạo phải được ghi xuống kho trước khi gửi: kho phát hiện sự kiện đã có bản cùng mã (phát lại sau khởi động lại) và bỏ bản mới, khi đó không gửi (PHUB-D-030).
    if (typeof this.store.isNewWebhook === 'function' && this.store.isNewWebhook(w.id)) {
      await this.store.persist();
      if (this.store.getWebhook(w.id) !== w) return;
    }
    this._sending.add(w.id);
    const { kind, route } = this._routeOf(w);
    let ok = false;
    let status = null;
    let error = null;
    try {
      if (!route) throw new Error(w.route === LEGACY ? 'cửa hàng không còn endpoint webhook trong cấu hình' : `tuyến ${w.route} không còn trong cấu hình`);
      const r = await this.sinks[kind].deliver({ ...w, eventId: w.eventId || w.id }, route, { now: () => this.clock.now() });
      ok = true;
      status = (r && r.status) || null;
    } catch (err) {
      error = String(err && err.message).slice(0, 200);
      status = (err && err.status) || null;
    } finally {
      this._sending.delete(w.id);
    }
    const now = this.clock.now();
    const eff = route || this.cfg;
    const max = eff.maxAttempts;
    const backoff = eff.backoffSeconds;
    w.attempts += 1;
    w.lastStatus = status;
    w.lastError = ok ? null : error;
    let outcome;
    if (ok) { w.status = 'delivered'; w.deliveredAt = now; w.nextAt = null; outcome = 'delivered'; }
    else if (w.attempts >= max) { w.status = 'dead'; w.nextAt = null; outcome = 'dead'; }
    else { w.nextAt = now + backoff[Math.min(w.attempts - 1, backoff.length - 1)] * 1000; outcome = 'retry'; }
    if (this.metrics) this.metrics.inc('hub_webhook_deliveries_total', { outcome, shop: w.shopId || 'default', route: w.route || LEGACY, sink: w.sink || LEGACY });
  }

  /** Gửi lại thủ công: đưa về pending, đến hạn ngay, đếm lại số lần. */
  async retry(id) {
    const w = this.store.getWebhook(id) || (typeof this.store.loadWebhook === 'function' ? await this.store.loadWebhook(id) : undefined);
    if (!w) return undefined;
    w.status = 'pending';
    w.attempts = 0;
    w.nextAt = this.clock.now();
    return w;
  }
}

module.exports = { EventOutbox, eventId, DEFAULTS };

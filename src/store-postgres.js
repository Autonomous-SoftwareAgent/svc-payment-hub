'use strict';
// spec: PHUB-S-037
// spec: PHUB-S-030
// spec: PHUB-S-007
// spec: PHUB-S-009
// spec: PHUB-S-011
// spec: PHUB-S-012
// spec: PHUB-S-014
// spec: PHUB-S-015
// spec: PHUB-S-017
// spec: PHUB-S-010
// spec: PHUB-S-027
// Store bền vững bằng PostgreSQL (thư viện `pg`). Cơ sở dữ liệu duy nhất của dự án (DECISIONS D-004).
// Cách làm: lõi Hub giữ thực thể trong bộ nhớ như MemoryStore (có chỉ mục và theo dõi thay đổi, PHUB-D-009);
// persist() ghi các thực thể đã đổi, nhật ký mới, khóa idempotency, con trỏ sao kê và bộ đếm id trong MỘT transaction
// (mỗi loại một câu lệnh nhiều dòng; lỗi thì rollback và đánh dấu bẩn lại để lần lưu sau ghi lại).
// Các lần persist chạy chồng nhau được xếp hàng và tự gộp: lần chạy sau ghi mọi thứ bẩn tại thời điểm đó.
// Khởi động chỉ nạp phần còn hoạt động (payment mở, attempt sống, hoàn tiền mở, anomaly mở); giao dịch đã đóng nằm ở DB và được
// nạp lại theo yêu cầu khi có thông báo muộn, truy vấn hay hoàn tiền (PHUB-D-012). Khóa idempotency có hạn dùng (purgeSeen).
// Khởi động nạp lại trạng thái. Chỉ MỘT tiến trình Hub được ghi trên một schema: store giữ advisory lock suốt phiên,
// tiến trình thứ hai bị từ chối ngay khi mở (tránh hai bản Hub cùng ghi trạng thái trong bộ nhớ của riêng mình).

const { Client, Pool } = require('pg');
const { MemoryStore, FINAL_WEBHOOK } = require('./store');

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const TAIL = 1000; // số sự kiện và lần gọi cổng gần nhất giữ trong bộ nhớ

class PostgresStore extends MemoryStore {
  /**
   * @param {string} connectionString  ví dụ postgres://user:pass@host:5432/db
   * @param {{schema?:string}} [opts]  schema riêng (mặc định public); dùng cho test cô lập
   * @returns {Promise<PostgresStore>}
   */
  static async open(connectionString, { schema = 'public' } = {}) {
    if (!IDENT.test(schema)) throw new Error(`tên schema không hợp lệ: ${schema}`);
    const client = new Client({ connectionString });
    await client.connect();
    const store = new PostgresStore(client, schema, connectionString);
    try {
      await store._init();
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    return store;
  }

  /** Xóa schema (chỉ dùng trong test hoặc dọn dẹp). */
  static async dropSchema(connectionString, schema) {
    if (!IDENT.test(schema)) throw new Error(`tên schema không hợp lệ: ${schema}`);
    const c = new Client({ connectionString });
    await c.connect();
    try { await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await c.end(); }
  }

  constructor(client, schema, connectionString) {
    super();
    this._trackNew = true;
    this.duplicateWebhooks = 0; // số webhook mới bị bỏ vì đã có bản cùng mã (đã giao hoặc đã chết) trong kho
    this.client = client; // kết nối ghi: giữ advisory lock, chạy transaction của persist
    // Đọc (nạp theo yêu cầu, liệt kê) đi qua pool riêng: không chen vào transaction đang ghi, nhiều lần đọc song song được.
    this.pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
    this.pool.on('error', () => {}); // lỗi kết nối nhàn rỗi của pool không làm chết tiến trình; lần đọc kế tiếp tự mở lại
    this.schema = schema;
    this.broken = null;
    this.closing = false;
    this.onBroken = null; // gọi khi mất kết nối; main.js dùng để thoát tiến trình cho trình điều phối khởi động lại
    const markBroken = (err) => {
      if (this.closing || this.broken) return;
      this.broken = err;
      if (this.onBroken) this.onBroken(err);
    };
    client.on('error', markBroken);
    client.on('end', () => markBroken(new Error('kết nối cơ sở dữ liệu đã đóng')));
    this._seenAdd = new Set();
    this._seenDel = new Set();
    this._eventsBase = 0; // số sự kiện đã bỏ khỏi đầu mảng bộ nhớ (đã nằm trong DB)
    this._eventsSaved = 0; // chỉ số trong mảng bộ nhớ: các phần tử trước đó đã lưu
    this._callsPending = [];
    this._metaSaved = '';
    this._queue = Promise.resolve();
    this._next = null;
    this._hydrating = new Map();
  }

  async _init() {
    const c = this.client;
    const s = `"${this.schema}"`;
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`SET search_path TO ${s}`);
    const lock = await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`bsn-payment-hub:${this.schema}`]);
    if (!lock.rows[0].ok) throw new Error(`một tiến trình Hub khác đang dùng schema "${this.schema}" của cơ sở dữ liệu này; chỉ được chạy một tiến trình Hub cho mỗi schema`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS docs (n BIGINT GENERATED ALWAYS AS IDENTITY, kind TEXT NOT NULL, id TEXT NOT NULL, doc JSONB NOT NULL, PRIMARY KEY (kind, id));
      CREATE INDEX IF NOT EXISTS docs_webhook_status ON docs ((doc->>'status'), n) WHERE kind = 'webhook';
      CREATE TABLE IF NOT EXISTS events (n BIGINT PRIMARY KEY, doc JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (n BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at BIGINT NOT NULL, gateway TEXT NOT NULL, method TEXT NOT NULL, ref TEXT, doc JSONB NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_ref ON calls (ref, n);
      CREATE INDEX IF NOT EXISTS calls_gateway ON calls (gateway, n);
      CREATE INDEX IF NOT EXISTS docs_by_payment ON docs (kind, (doc->>'paymentId'));
      CREATE INDEX IF NOT EXISTS docs_live ON docs (kind, (doc->>'status')) WHERE doc->>'status' IN ('CREATED', 'AWAITING', 'UNKNOWN', 'OPEN', 'REQUESTED', 'PROCESSING', 'open');
      CREATE INDEX IF NOT EXISTS docs_live2 ON docs (kind, (doc->>'status')) WHERE doc->>'status' IN ('CREATED', 'AWAITING', 'UNKNOWN', 'AUTHORIZED', 'OPEN', 'REQUESTED', 'PROCESSING', 'open');
      CREATE INDEX IF NOT EXISTS docs_payment_order ON docs ((coalesce(doc->>'shopId', 'default')), (doc->>'orderId'), n) WHERE kind = 'payment';
      CREATE INDEX IF NOT EXISTS docs_attempt_ref ON docs ((doc->>'gateway'), (lower(doc->>'ref'))) WHERE kind = 'attempt';
      CREATE TABLE IF NOT EXISTS seen (k TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now());
      ALTER TABLE seen ADD COLUMN IF NOT EXISTS at TIMESTAMPTZ NOT NULL DEFAULT now();
      CREATE INDEX IF NOT EXISTS seen_prefix ON seen (k text_pattern_ops);
      CREATE INDEX IF NOT EXISTS seen_at ON seen (at);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    await this._load();
  }

  // Nạp phần còn hoạt động. Anomaly không gắn payment (tiền chưa rõ chủ, mã lạ) luôn nằm trong bộ nhớ vì cần để chống trùng.
  async _load() {
    const c = this.pool;
    const active = (await c.query(`
      SELECT id AS pid FROM docs WHERE kind = 'payment' AND doc->>'status' = 'OPEN'
      UNION SELECT doc->>'paymentId' FROM docs WHERE kind = 'attempt' AND doc->>'status' IN ('CREATED', 'AWAITING', 'UNKNOWN', 'AUTHORIZED')
      UNION SELECT doc->>'paymentId' FROM docs WHERE kind = 'attempt' AND doc->>'recheckAt' IS NOT NULL
      UNION SELECT doc->>'paymentId' FROM docs WHERE kind = 'refund' AND doc->>'status' IN ('REQUESTED', 'PROCESSING')
      UNION SELECT doc->>'paymentId' FROM docs WHERE kind = 'anomaly' AND doc->>'status' = 'open' AND doc->>'paymentId' IS NOT NULL`)).rows.map((r) => r.pid).filter(Boolean);
    for (const pid of active) await this.hydratePayment(pid);
    for (const row of (await c.query("SELECT doc FROM docs WHERE kind = 'anomaly' AND doc->>'paymentId' IS NULL ORDER BY n")).rows) this.adopt('anomaly', row.doc);
    for (const row of (await c.query("SELECT doc FROM docs WHERE kind = 'webhook' AND doc->>'status' NOT IN ('delivered', 'dead') ORDER BY n")).rows) this.adopt('webhook', row.doc);
    const tail = (await c.query('SELECT n, doc FROM events ORDER BY n DESC LIMIT $1', [TAIL])).rows.reverse();
    for (const row of tail) this.events.push(row.doc);
    this._eventsBase = tail.length ? Number(tail[tail.length - 1].n) - tail.length : 0;
    this._eventsSaved = this.events.length;
    // Khóa idempotency của tiền chưa rõ chủ (không thuộc attempt nào) nạp hết; của attempt nào thì nạp theo attempt (hydratePayment).
    this.adoptSeen((await c.query("SELECT k FROM seen WHERE k LIKE '%|unmatched|%'")).rows.map((r) => r.k));
    const meta = Object.fromEntries((await c.query('SELECT k, v FROM meta')).rows.map((r) => [r.k, r.v]));
    if (meta.seq) this.seq = Number(meta.seq);
    if (meta.cursors) this.cursors = JSON.parse(meta.cursors);
    if (meta.feedAt) this.feedAt = JSON.parse(meta.feedAt);
    if (meta.extra) this.extra = JSON.parse(meta.extra);
    this._metaSaved = this._metaText();
  }

  // ---------- nạp theo yêu cầu ----------

  _escapeLike(x) { return String(x).replace(/[\\%_]/g, (m) => '\\' + m); }

  async hydratePayment(id) {
    if (!id) return undefined;
    if (!this.payments.has(id)) {
      let pending = this._hydrating.get(id);
      if (!pending) {
        pending = this._loadPayment(id).finally(() => this._hydrating.delete(id));
        this._hydrating.set(id, pending);
      }
      await pending;
    }
    const p = this.payments.get(id);
    if (p) this._touched.set(id, this.nowMs());
    return p;
  }

  async _loadPayment(id) {
    const c = this.pool;
    const rows = (await c.query(
      "SELECT kind, doc FROM docs WHERE (kind = 'payment' AND id = $1) OR (kind IN ('attempt', 'refund', 'anomaly') AND doc->>'paymentId' = $1) ORDER BY n",
      [id],
    )).rows;
    if (this.payments.has(id)) return; // đã được nạp trong lúc chờ
    const order = { payment: 0, attempt: 1, refund: 2, anomaly: 3 };
    rows.sort((x, y) => order[x.kind] - order[y.kind]);
    const patterns = [];
    for (const row of rows) {
      this.adopt(row.kind, row.doc);
      if (row.kind === 'attempt') patterns.push(`${this._escapeLike(row.doc.gateway + '|' + row.doc.ref)}|%`);
    }
    if (patterns.length) this.adoptSeen((await c.query('SELECT k FROM seen WHERE k LIKE ANY($1::text[])', [patterns])).rows.map((r) => r.k));
  }

  // payment mới nhất của đơn: chỉ cần hỏi DB khi trong bộ nhớ chưa có payment còn sống của đơn đó
  async hydrateOrder(orderId, shopId = 'default') {
    const mem = this.findPaymentByOrderId(orderId, shopId);
    if (mem && mem.status !== 'CLOSED') return;
    const row = (await this.pool.query("SELECT id FROM docs WHERE kind = 'payment' AND coalesce(doc->>'shopId', 'default') = $1 AND doc->>'orderId' = $2 ORDER BY n DESC LIMIT 1", [shopId, orderId])).rows[0];
    if (row) await this.hydratePayment(row.id);
  }

  async hydrateByRef(gateway, ref) {
    if (this.findAttemptByRef(gateway, ref)) { const a = this.findAttemptByRef(gateway, ref); this._touched.set(a.paymentId, this.nowMs()); return; }
    const rows = (await this.pool.query("SELECT DISTINCT doc->>'paymentId' AS pid FROM docs WHERE kind = 'attempt' AND doc->>'gateway' = $1 AND lower(doc->>'ref') = lower($2)", [gateway, String(ref)])).rows;
    for (const r of rows) await this.hydratePayment(r.pid);
  }

  async _hydrateVia(kind, id) {
    const row = (await this.pool.query("SELECT doc->>'paymentId' AS pid FROM docs WHERE kind = $1 AND id = $2", [kind, id])).rows[0];
    if (row && row.pid) await this.hydratePayment(row.pid);
  }

  async hydrateAttempt(id) { if (!this.attempts.has(id)) await this._hydrateVia('attempt', id); }
  async hydrateRefund(id) { if (!this.refunds.has(id)) await this._hydrateVia('refund', id); }
  async hydrateAnomaly(id) { if (!this._anomalyById.has(id)) await this._hydrateVia('anomaly', id); }

  async prepareEvent(gateway, ev) {
    if (ev.unmatched || !ev.attemptRef) return; // khóa của tiền chưa rõ chủ đã nạp hết khi khởi động
    await this.hydrateByRef(gateway, ev.attemptRef);
  }

  // Anomaly theo bộ lọc, gồm cả phần đã đẩy ra khỏi bộ nhớ (bản trong bộ nhớ được ưu tiên).
  async findAnomalies({ type, status, limit = 1000 } = {}) {
    await this._queue.catch(() => {});
    const rows = (await this.pool.query(
      "SELECT doc FROM docs WHERE kind = 'anomaly' AND ($1::text IS NULL OR doc->>'type' = $1) AND ($2::text IS NULL OR doc->>'status' = $2) ORDER BY n DESC LIMIT $3",
      [type || null, status || null, limit],
    )).rows.map((r) => r.doc);
    const mem = new Map(this.anomalies.map((a) => [a.id, a]));
    const out = rows.map((r) => mem.get(r.id) || r).filter((a) => (!type || a.type === type) && (!status || a.status === status));
    for (const a of mem.values()) if ((!type || a.type === type) && (!status || a.status === status) && !rows.some((r) => r.id === a.id)) out.push(a);
    return out.slice(0, limit);
  }

  // Xóa khóa idempotency quá hạn trong DB (khóa của attempt đang trong bộ nhớ không bị ảnh hưởng cho tới khi bị đẩy ra).
  async purgeSeen(ttlDays) {
    await this._queue.catch(() => {});
    const r = await this.pool.query("DELETE FROM seen WHERE at < now() - ($1::int * interval '1 day')", [ttlDays]);
    return r.rowCount;
  }

  _metaText() {
    return JSON.stringify([this.seq, this.cursors, this.feedAt, this.extra]);
  }

  markSeen(key) {
    const had = super.markSeen(key);
    if (!had) { this._seenAdd.add(key); this._seenDel.delete(key); }
    if (key.startsWith('cmd|')) (this._cmdKeys = this._cmdKeys || new Set()).add(key);
    return had;
  }

  // Khóa của lệnh nhận qua broker (commandId) tra DB khi không còn trong bộ nhớ: hiệu ứng đúng một lần không phụ thuộc bộ nhớ.
  async hydrateSeen(key) {
    if (this.seen.has(key)) return;
    if ((await this.pool.query('SELECT 1 FROM seen WHERE k = $1', [key])).rowCount) this.adoptSeen([key]);
  }

  // Giữ tối đa max khóa lệnh trong bộ nhớ (cũ nhất ra trước, không xóa trong DB; hydrateSeen nạp lại khi cần).
  trimCommandKeys(max = 50000) {
    const keys = this._cmdKeys;
    if (!keys) return;
    for (const k of keys) {
      if (keys.size <= max) break;
      keys.delete(k);
      MemoryStore.prototype.forget.call(this, k);
    }
  }

  evictIdle(idleMs, now) {
    const n = super.evictIdle(idleMs, now);
    this.trimCommandKeys();
    return n;
  }

  forget(key) {
    super.forget(key);
    this._seenDel.add(key);
    this._seenAdd.delete(key);
  }

  addCall(c) {
    super.addCall(c);
    this._callsPending.push(c);
    if (this.calls.length > TAIL * 2) this.calls.splice(0, this.calls.length - TAIL);
    return c;
  }

  // Ghi mọi thay đổi trong một transaction. Các lần gọi chạy chồng nhau được xếp hàng, mỗi lần tự tính thay đổi lúc chạy.
  // Nhóm commit: nếu đã có một lần ghi được xếp hàng nhưng chưa bắt đầu, dùng chung lần đó (nó sẽ chạy sau thay đổi của người gọi).
  persist() {
    if (this._next) return this._next;
    const run = this._queue.then(() => { this._next = null; return this._persistNow(); });
    this._next = run;
    this._queue = run.catch(() => {});
    return run;
  }

  async _persistNow() {
    if (this.broken) throw new Error(`mất kết nối cơ sở dữ liệu: ${this.broken.message}`);
    const c = this.client;
    const keys = [...this.dirty];
    const docs = { kind: [], id: [], doc: [] };
    const webhookKeys = [];
    const fresh = { id: [], doc: [] }; // webhook mới tạo: chỉ chèn nếu chưa có, không ghi đè bản đã có (PHUB-D-030)
    for (const key of keys) {
      const obj = this.dirtyObject(key);
      if (!obj) continue;
      const i = key.indexOf(':');
      if (key.startsWith('webhook:')) {
        webhookKeys.push(key);
        if (this._newWebhooks.has(obj.id)) { fresh.id.push(obj.id); fresh.doc.push(JSON.stringify(obj)); continue; }
      }
      docs.kind.push(key.slice(0, i));
      docs.id.push(key.slice(i + 1));
      docs.doc.push(JSON.stringify(obj));
    }
    const eventsTotal = this.events.length;
    const events = { n: [], doc: [] };
    for (let i = this._eventsSaved; i < eventsTotal; i++) { events.n.push(this._eventsBase + i + 1); events.doc.push(JSON.stringify(this.events[i])); }
    const calls = this._callsPending.slice();
    const seenAdd = [...this._seenAdd];
    const seenDel = [...this._seenDel];
    const metaText = this._metaText();
    if (!docs.id.length && !fresh.id.length && !events.n.length && !calls.length && !seenAdd.length && !seenDel.length && metaText === this._metaSaved) return;

    this.dirty.clear(); // thay đổi xảy ra trong lúc đang ghi sẽ đánh dấu bẩn lại
    await c.query('BEGIN');
    let inserted = new Set();
    try {
      if (fresh.id.length) {
        const r = await c.query("INSERT INTO docs (kind, id, doc) SELECT 'webhook', id, doc::jsonb FROM unnest($1::text[], $2::text[]) AS t(id, doc) ON CONFLICT (kind, id) DO NOTHING RETURNING id", [fresh.id, fresh.doc]);
        inserted = new Set(r.rows.map((x) => x.id));
      }
      if (docs.id.length) {
        await c.query('INSERT INTO docs (kind, id, doc) SELECT kind, id, doc::jsonb FROM unnest($1::text[], $2::text[], $3::text[]) AS t(kind, id, doc) ON CONFLICT (kind, id) DO UPDATE SET doc = EXCLUDED.doc', [docs.kind, docs.id, docs.doc]);
      }
      if (events.n.length) await c.query('INSERT INTO events (n, doc) SELECT n, doc::jsonb FROM unnest($1::bigint[], $2::text[]) AS t(n, doc)', [events.n, events.doc]);
      if (calls.length) {
        await c.query('INSERT INTO calls (at, gateway, method, ref, doc) SELECT at, gateway, method, ref, doc::jsonb FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[]) AS t(at, gateway, method, ref, doc)',
          [calls.map((x) => x.at), calls.map((x) => x.gateway), calls.map((x) => x.method), calls.map((x) => x.ref || null), calls.map((x) => JSON.stringify(x))]);
      }
      if (seenAdd.length) await c.query('INSERT INTO seen (k) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [seenAdd]);
      if (seenDel.length) await c.query('DELETE FROM seen WHERE k = ANY($1::text[])', [seenDel]);
      if (metaText !== this._metaSaved) {
        await c.query('INSERT INTO meta (k, v) SELECT k, v FROM unnest($1::text[], $2::text[]) AS t(k, v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v',
          [['seq', 'cursors', 'feedAt', 'extra'], [String(this.seq), JSON.stringify(this.cursors), JSON.stringify(this.feedAt), JSON.stringify(this.extra)]]);
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      for (const k of keys) this.dirty.add(k); // lần lưu sau ghi lại phần chưa lưu được
      throw err;
    }
    // Webhook mới đã có bản cùng mã trong kho (sự kiện phát lại sau khởi động lại): bỏ bản mới, giữ bản cũ nguyên vẹn.
    for (const id of fresh.id) {
      this._newWebhooks.delete(id);
      if (inserted.has(id)) continue;
      this.webhooks.delete(id);
      this._pendingWebhooks.delete(id);
      this.dirty.delete(`webhook:${id}`);
      this.duplicateWebhooks += 1;
    }
    // Chỉ cập nhật trạng thái "đã lưu" sau khi COMMIT thành công.
    this._eventsSaved = eventsTotal;
    if (this.events.length > TAIL * 2) {
      const drop = this.events.length - TAIL;
      this.events.splice(0, drop);
      this._eventsBase += drop;
      this._eventsSaved -= drop;
    }
    this._callsPending.splice(0, calls.length);
    for (const k of seenAdd) this._seenAdd.delete(k);
    for (const k of seenDel) this._seenDel.delete(k);
    this._metaSaved = metaText;
    // Webhook đã giao xong (hoặc dead) và đã lưu thì bỏ khỏi bộ nhớ, trừ khi lại bị sửa trong lúc ghi.
    for (const key of webhookKeys) {
      const w = this.dirtyObject(key);
      if (w && !this.dirty.has(key) && FINAL_WEBHOOK.includes(w.status)) this.webhooks.delete(w.id);
    }
  }

  async listWebhooks({ status, limit = 100, shopId } = {}) {
    await this._queue.catch(() => {});
    const rows = (await this.pool.query(
      `SELECT doc FROM docs WHERE kind = 'webhook' AND ($1::text IS NULL OR doc->>'status' = $1) AND ($3::text IS NULL OR coalesce(doc->>'shopId', 'default') = $3) ORDER BY n DESC LIMIT $2`,
      [status || null, limit, shopId || null],
    )).rows.map((r) => r.doc);
    const inMemory = new Map([...this.webhooks.values()].map((w) => [w.id, w]));
    const match = (w) => (!status || w.status === status) && (!shopId || (w.shopId || 'default') === shopId);
    const merged = rows.map((r) => inMemory.get(r.id) || r);
    for (const w of inMemory.values()) if (match(w) && !rows.some((r) => r.id === w.id)) merged.unshift(w);
    return merged.slice(0, limit);
  }

  async loadWebhook(id) {
    const mem = this.webhooks.get(id);
    if (mem) return mem;
    await this._queue.catch(() => {});
    const row = (await this.pool.query("SELECT doc FROM docs WHERE kind = 'webhook' AND id = $1", [id])).rows[0];
    return row ? this.adopt('webhook', row.doc) : undefined;
  }

  async listCalls({ gateway, ref, limit = 100 } = {}) {
    await this._queue.catch(() => {});
    const rows = (await this.pool.query(
      'SELECT doc FROM calls WHERE ($1::text IS NULL OR gateway = $1) AND ($2::text IS NULL OR ref = $2) ORDER BY n DESC LIMIT $3',
      [gateway || null, ref || null, limit],
    )).rows;
    return rows.map((r) => r.doc);
  }

  async close() {
    this.closing = true;
    await this._queue.catch(() => {});
    await this.pool.end().catch(() => {});
    await this.client.end();
  }
}

module.exports = { PostgresStore };

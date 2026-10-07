'use strict';
// spec: SEPY-S-007
// spec: SEPY-S-001
// spec: SEPY-S-002
// spec: SEPY-S-004
// Phần dùng chung của hai sản phẩm nhận tiền bằng chuyển khoản vào tài khoản ngân hàng đã liên kết SePay (A: QR tĩnh, B: VA theo đơn):
// webhook biến động số dư, sao kê GET /v2/transactions và cách trích mã attempt. Giả định chưa kiểm chứng: xem SEPY-D-002 (A) và SEPY-D-004 (B).
const { crypto, ackResponse, safeEqual, isBlank, parseVnDate, toInt, makeHttp } = require('./common');

function createBank(ctx) {
  const { cfg, clock, prefix } = ctx;
  const http = makeHttp(ctx.doFetch, cfg.timeoutMs);
  const apiBase = cfg.apiBaseUrl.replace(/\/+$/, '');
  const refRe = new RegExp(`${prefix}[A-Z0-9]+`, 'i');
  const codeRe = new RegExp(`^${prefix}[A-Z0-9]+$`, 'i');
  let resolver = null; // B: ánh xạ số VA -> attemptRef (SEPY-D-004)

  // ---- trích attemptRef ----
  function extractRef(code, content) {
    if (!isBlank(code) && codeRe.test(String(code).trim())) return String(code).trim().toUpperCase();
    // code rỗng (hoặc lạ): tìm mã trong nội dung, không phân biệt hoa thường (S3)
    const m = refRe.exec(String(content == null ? '' : content));
    return m ? m[0].toUpperCase() : null;
  }

  // forcedRef: mã đã biết chắc (từ VA hoặc từ chính câu truy vấn); thắng cách trích theo code/nội dung.
  // noExtract: biết chắc đây là tiền vào VA của đơn KHÔNG phải của Hub, không được đoán mã từ code/nội dung.
  function receivedEvent({ code, content, amount, txnId, at, source, raw, forcedRef, noExtract }) {
    const attemptRef = forcedRef || (noExtract ? null : extractRef(code, content));
    const ev = {
      gateway: 'sepay', type: 'received', attemptRef, amount, gatewayTxnId: String(txnId),
      occurredAt: Number.isFinite(at) ? at : clock.now(), source, content: content == null ? '' : String(content), raw,
    };
    if (attemptRef === null) ev.unmatched = true;
    return ev;
  }

  // ---- xác thực webhook (mode: none | apikey | hmac) ----
  function authenticate(req, rawBody, mode = cfg.authMode) {
    const h = req.headers || {};
    if (mode === 'none') return null;
    if (mode === 'apikey') {
      return safeEqual(h.authorization, `Apikey ${cfg.apiKey}`) ? null : 'bad_apikey';
    }
    if (mode === 'hmac') {
      if (rawBody === null) return 'missing_raw_body';
      const ts = h['x-sepay-timestamp'];
      const sig = h['x-sepay-signature'];
      if (isBlank(ts) || isBlank(sig)) return 'missing_signature';
      const expected = `sha256=${crypto.createHmac('sha256', cfg.hmacSecret).update(`${ts}.${rawBody}`).digest('hex')}`;
      if (!safeEqual(String(sig).toLowerCase(), expected)) return 'bad_signature';
      const t = Number(ts);
      if (!Number.isFinite(t) || Math.abs(clock.now() / 1000 - t) > cfg.hmacToleranceSeconds) return 'timestamp_skew';
      return null;
    }
    return 'unknown_auth_mode';
  }

  // body có thể là object JSON, chuỗi JSON hoặc chuỗi form-urlencoded (A3); form: mọi giá trị là chuỗi
  function parseBody(body) {
    if (body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body)) return body;
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    if (typeof text !== 'string' || !text.trim()) return null;
    const t = text.trim();
    if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return null; } }
    const o = {};
    for (const [k, v] of new URLSearchParams(t)) o[k] = v;
    return Object.keys(o).length ? o : null;
  }

  const rawOf = (req) => (typeof req.rawBody === 'string' ? req.rawBody : (typeof req.body === 'string' ? req.body : null));

  // ---- webhook biến động số dư ----
  // Đồng bộ khi không cần tra VA (sản phẩm A); trả Promise khi phải phân giải số VA (sản phẩm B).
  function parseWebhook(req) {
    const ack = (outcome) => ackResponse(outcome);
    const rawBody = rawOf(req);
    const reason = authenticate(req, rawBody);
    if (reason) return { valid: false, reason, ack };
    const data = parseBody(req.body !== undefined && req.body !== null ? req.body : rawBody);
    if (!data) return { valid: false, reason: 'bad_body', ack };
    const type = String(data.transferType || '').toLowerCase();
    if (type === 'out') return { valid: true, ack }; // tiền ra: bỏ qua (S19)
    if (type !== 'in') return { valid: false, reason: 'bad_transfer_type', ack };
    const amount = toInt(data.transferAmount);
    const id = toInt(data.id);
    if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(id)) return { valid: false, reason: 'bad_body', ack };
    const build = (res) => receivedEvent({
      code: data.code, content: data.content, amount, txnId: isBlank(data.referenceCode) ? id : data.referenceCode,
      at: parseVnDate(data.transactionDate), source: 'ipn', raw: data, forcedRef: res && res.ref, noExtract: !!(res && res.foreign),
    });
    const va = isBlank(data.subAccount) ? null : String(data.subAccount).trim();
    // Lỗi tra cứu tạm thời (PHUB-D-018, P7): chữ ký đã hợp lệ nhưng chưa gắn được VA vào đơn: báo Hub thử lại sau, không ném lỗi.
    if (va && resolver) return resolver.refForVa(va).then((res) => ({ valid: true, event: build(res), ack }), () => ({ valid: true, retryLater: true, reason: 'va_lookup_failed', ack }));
    return { valid: true, event: build(null), ack };
  }

  // ---- API v2 (Bearer) ----
  // Trả {json} hoặc {error:true}. 401/429/lỗi mạng/phản hồi hỏng đều là error (kết luận 'unknown', không bao giờ 'not_found').
  async function apiGet(path, params) {
    if (isBlank(cfg.apiToken)) return { error: true };
    const r = await http('GET', `${apiBase}${path}`, { headers: { authorization: `Bearer ${cfg.apiToken}` }, params });
    if (r.error) return { error: true };
    if (r.status !== 200) return { error: true, status: r.status };
    const json = r.json;
    if (!json || json.status !== 'success' || !Array.isArray(json.data)) return { error: true };
    return { json };
  }

  // Gọi API v2 với phương thức bất kỳ; giữ nguyên status để người gọi tự phân loại lỗi.
  async function apiCall(method, path, { body, headers, params } = {}) {
    if (isBlank(cfg.apiToken)) return { error: true };
    return http(method, `${apiBase}${path}`, { headers: { authorization: `Bearer ${cfg.apiToken}`, ...(headers || {}) }, body, params });
  }

  function eventFromApiRow(row, source, forcedRef, noExtract) {
    if (!row || row.transfer_type !== 'in') return null;
    const amount = toInt(row.amount_in);
    if (!Number.isInteger(amount) || amount <= 0 || isBlank(row.id)) return null;
    const ev = receivedEvent({
      code: row.code, content: row.transaction_content, amount, txnId: isBlank(row.reference_number) ? row.id : row.reference_number, at: parseVnDate(row.transaction_date), source, raw: row, noExtract,
    });
    if (forcedRef) { ev.attemptRef = forcedRef; delete ev.unmatched; }
    return ev;
  }

  // Kéo sao kê theo con trỏ since_id; với hàng có số VA (sản phẩm B) thì phân giải VA trước.
  // Không phân giải được (API lỗi) thì dừng đúng ở hàng đó: con trỏ không đi qua hàng chưa xử lý.
  async function reconcileFeed(p = {}) {
    const events = [];
    let nextCursor = p.cursor;
    for (let page = 1; page <= 100; page += 1) {
      const r = await apiGet('/transactions', {
        since_id: p.cursor || undefined, per_page: 100, page, transaction_date_sort: 'asc',
      });
      if (r.error) {
        if (page === 1) throw new Error('sepay reconcileFeed: không đọc được sao kê'); // chưa có tiến triển: để Hub thử lại
        break; // đã đọc được một phần: trả phần đó, con trỏ dừng ở hàng cuối đã xử lý
      }
      for (const row of r.json.data) {
        let ev = null;
        try {
          const va = row && !isBlank(row.va) ? String(row.va).trim() : null;
          const res = va && resolver && row.transfer_type === 'in' ? await resolver.refForVa(va) : null;
          ev = eventFromApiRow(row, 'query', res && res.ref, !!(res && res.foreign));
        } catch (err) {
          if (!events.length && nextCursor === p.cursor) throw err;
          return { events, nextCursor };
        }
        if (ev) events.push(ev);
        if (!isBlank(row && row.id)) nextCursor = String(row.id);
      }
      const pg = r.json.meta && r.json.meta.pagination;
      if (!pg || !pg.has_more || r.json.data.length === 0) break;
    }
    return { events, nextCursor };
  }

  return {
    extractRef, receivedEvent, authenticate, parseBody, rawOf, parseWebhook, apiGet, apiCall, eventFromApiRow, reconcileFeed,
    setResolver(r) { resolver = r; },
  };
}

module.exports = { createBank };

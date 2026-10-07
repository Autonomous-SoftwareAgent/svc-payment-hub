'use strict';
// spec: SEPY-S-004
// spec: SEPY-S-007
// spec: PHUB-S-025
// spec: PHUB-S-029
// Sản phẩm B (product "va-order"): mỗi đơn một tài khoản ảo (VA) do ngân hàng cấp, tạo qua API v2 POST /bank-accounts/{ba}/orders.
// Xem SEPY-D-004. Mọi chi tiết dưới đây là giả định từ docs (chưa có live ngoài lỗi 401, mục B0):
//  * Danh sách đơn không lọc được theo order_code hay VA nên adapter quét danh sách (mới nhất trước) và đệm kết quả (B4).
//  * Số VA trong hàng sao kê nằm ở trường `va`; chi tiết đơn không trả va_id nên lọc phía client (B5).
//  * Webhook giao dịch VA mang subAccount = số VA; trường code mâu thuẫn giữa hai trang docs nên không dựa vào code khi VA khớp (B6).
const { isBlank, parseVnDate, formatVnDate, toInt } = require('./common');

function createVaOrder(ctx, bank) {
  const { cfg, prefix, clock } = ctx;
  const va = cfg.va;
  const ba = encodeURIComponent(va.bankAccountId);
  const maxLen = Math.min(50, Number(va.orderCodeMaxLength) || 50);
  const MIN_LEN = 6;
  const maxPages = Number(va.scanMaxPages) || 20;
  const shape = new RegExp(`^${prefix}[A-Z0-9]+$`);
  const negativeTtlMs = 60000;
  const SLACK_MS = 10 * 60 * 1000; // đơn tạo sớm hơn mốc tìm kiếm chừng này vẫn được xem xét (lệch đồng hồ, đơn tạo trước khi attempt ghi nhận)

  const byCode = new Map(); // ORDER_CODE -> {id, code, vas:Set}
  const codeByVa = new Map();
  const negative = new Map();

  function remember(row) {
    if (!row || isBlank(row.order_code) || isBlank(row.id)) return null;
    const code = String(row.order_code).toUpperCase();
    const entry = byCode.get(code) || { id: String(row.id), code, vas: new Set() };
    entry.id = String(row.id);
    const nums = [];
    if (!isBlank(row.va_number)) nums.push(String(row.va_number));
    for (const v of Array.isArray(row.va) ? row.va : []) if (v && !isBlank(v.va_number)) nums.push(String(v.va_number));
    for (const n of nums) { entry.vas.add(n); codeByVa.set(n, code); negative.delete(n); }
    byCode.set(code, entry);
    return entry;
  }

  // Quét danh sách đơn (mới nhất trước). stop(row) = true thì dừng. Trả {complete, error}.
  async function scan(onRow, stop) {
    for (let page = 1; page <= maxPages; page += 1) {
      const r = await bank.apiGet(`/bank-accounts/${ba}/orders`, { created_at_sort: 'desc', per_page: 100, page });
      if (r.error) return { error: true };
      for (const row of r.json.data) {
        remember(row);
        if (onRow(row)) return { complete: false, hit: true };
        if (stop && stop(row)) return { complete: true };
      }
      const pg = r.json.meta && r.json.meta.pagination;
      if (!pg || !pg.has_more) return { complete: true };
    }
    return { complete: false };
  }

  // Trạng thái nhỏ Hub giữ trên attempt (PHUB-D-018, P2): id đơn và các số VA, để khỏi quét danh sách đơn (rate limit 3 request/giây).
  function stateOf(code) {
    const e = byCode.get(code);
    return e ? { orderId: e.id, vas: [...e.vas] } : undefined;
  }

  // Tìm đơn theo order_code. Có state thì vào thẳng (và làm ấm bộ đệm VA -> mã cho webhook sau khởi động lại). Trả {entry} | {state:'not_found'|'unknown'}.
  async function locate(code, createdAt, state) {
    if (state && !isBlank(state.orderId)) {
      const entry = remember({ id: state.orderId, order_code: code, va: (Array.isArray(state.vas) ? state.vas : []).map((n) => ({ va_number: n })) });
      if (entry) return { entry };
    }
    const hit = byCode.get(code);
    if (hit) return { entry: hit };
    const stop = Number.isFinite(createdAt) ? (row) => parseVnDate(row.created_at) < createdAt - SLACK_MS : null;
    const r = await scan((row) => !isBlank(row.order_code) && String(row.order_code).toUpperCase() === code, stop);
    if (r.error) return { state: 'unknown' };
    const found = byCode.get(code);
    return found ? { entry: found } : { state: 'not_found' };
  }

  async function detail(entry) {
    const r = await bank.apiCall('GET', `/bank-accounts/${ba}/orders/${encodeURIComponent(entry.id)}`);
    if (r.error || r.status !== 200 || !r.json || r.json.status !== 'success' || !r.json.data) return null;
    remember(r.json.data);
    return r.json.data;
  }

  // Các hàng sao kê (thô) vào các VA của đơn kể từ lúc tạo.
  async function rowsOfVas(vas, createdAt) {
    const rows = [];
    for (let page = 1; page <= 50; page += 1) {
      const r = await bank.apiGet('/transactions', {
        transaction_date_from: Number.isFinite(createdAt) ? formatVnDate(createdAt - SLACK_MS) : undefined,
        transaction_date_sort: 'asc', transfer_type: 'in', per_page: 100, page,
      });
      if (r.error) return { error: true };
      for (const row of r.json.data) if (row && !isBlank(row.va) && vas.has(String(row.va).trim()) && row.transfer_type === 'in') rows.push(row);
      const pg = r.json.meta && r.json.meta.pagination;
      if (!pg || !pg.has_more) break;
    }
    return { rows };
  }

  async function collectRows(attemptRef, createdAt, state) {
    const want = String(attemptRef || '').toUpperCase();
    if (!shape.test(want)) return { rows: [] };
    const loc = await locate(want, createdAt, state);
    if (!loc.entry) return loc.state === 'unknown' ? { error: true } : { rows: [] };
    return rowsOfVas(loc.entry.vas, createdAt);
  }

  function instructionsFrom(d, p) {
    const vaNumber = d.va_number || (Array.isArray(d.va) && d.va[0] && d.va[0].va_number) || null;
    if (!vaNumber) return null;
    const exp = parseVnDate(d.expired_at);
    const out = {
      status: 'instructions',
      instructions: {
        bank: d.bank_name, accountNumber: String(vaNumber), accountName: d.va_holder_name || d.account_holder_name,
        // VA nhận diện đơn nên không có transferContent (PHUB-D-018, P3); orderCode chỉ là gợi ý và đường dự phòng nếu khách ghi vào nội dung
        amount: Number.isInteger(d.amount) ? d.amount : p.amount, qrUrl: d.qr_code_url, orderCode: String(d.order_code || '').toUpperCase(), orderId: d.id,
      },
    };
    if (Number.isFinite(exp)) out.expiresAt = exp;
    return out;
  }

  return {
    product: 'va-order',
    maxLength: maxLen,

    capabilities() {
      return {
        hardExpiry: Number(va.durationSeconds) > 0 ? { minutes: Math.ceil(Number(va.durationSeconds) / 60) } : 'none',
        cancellable: true, queryable: true, refundable: cfg.refundApi ? 'api' : 'manual', refundAsync: true, createCanTimeout: true,
        currencies: ['VND'], regions: ['VN'], methods: ['virtual_account'],
        referenceFormat: { prefix: cfg.codePrefix, maxLength: maxLen, caseInsensitive: true },
      };
    },

    async createPayment(p) {
      const ref = typeof p.attemptRef === 'string' ? p.attemptRef : '';
      if (!/^[A-Za-z0-9]+$/.test(ref)) return { status: 'rejected', reason: 'attemptRef chỉ được gồm A-Z0-9', failCode: 'invalid_request' };
      if (ref.length < MIN_LEN || ref.length > maxLen) return { status: 'rejected', reason: `attemptRef phải dài ${MIN_LEN}-${maxLen} ký tự`, failCode: 'invalid_request' };
      if (!ref.toUpperCase().startsWith(prefix) || ref.length <= prefix.length) return { status: 'rejected', reason: `attemptRef phải bắt đầu bằng ${prefix} và có hậu tố`, failCode: 'invalid_request' };
      if (!Number.isInteger(p.amount) || p.amount <= 0) return { status: 'rejected', reason: 'amount phải là số nguyên VND dương', failCode: 'invalid_request' };
      const body = { order_code: ref.toUpperCase(), amount: p.amount, with_qrcode: '1', qrcode_template: 'compact' };
      if (Number(va.durationSeconds) > 0) body.duration = Number(va.durationSeconds);
      if (!isBlank(va.tid)) body.tid = String(va.tid);
      if (!isBlank(va.vaPrefix)) body.va_prefix = String(va.vaPrefix);
      const r = await bank.apiCall('POST', `/bank-accounts/${ba}/orders`, { body });
      if (r.error) return isBlank(cfg.apiToken) ? { status: 'rejected', reason: 'thiếu apiToken', failCode: 'invalid_request' } : { status: 'unknown' }; // mất phản hồi: đơn có thể đã tạo
      if ((r.status === 201 || r.status === 200) && r.json && r.json.data) {
        remember({ ...r.json.data, order_code: r.json.data.order_code || body.order_code });
        const res = instructionsFrom(r.json.data, p);
        return res ? { ...res, state: stateOf(body.order_code) } : { status: 'unknown' };
      }
      if (r.status === 409) { // trùng order_code: đơn đã có (gửi lại sau mất phản hồi), lấy lại hướng dẫn
        const loc = await locate(body.order_code, undefined);
        const d = loc.entry && await detail(loc.entry);
        const res = d && instructionsFrom({ ...d, bank_name: d.bank_name }, p);
        return res ? { ...res, state: stateOf(body.order_code) } : { status: 'unknown' };
      }
      if ([400, 401, 403, 404, 422, 429].includes(r.status)) {
        const code = r.json && (r.json.error_code || r.json.message);
        return { status: 'rejected', reason: `sepay ${r.status}${code ? `: ${code}` : ''}` }; // chắc chắn chưa tạo đơn
      }
      return { status: 'unknown' };
    },

    // Phân giải số VA (SEPY-D-004). Trả {ref} nếu là VA của đơn do Hub tạo, {foreign:true} nếu là VA của đơn khác (không đoán mã),
    // {} nếu không biết VA này. Ném lỗi khi không tra được để Hub trả 500 và SePay gửi lại.
    resolver: {
      async refForVa(vaNumber) {
        const key = String(vaNumber).trim();
        const hit = codeByVa.get(key);
        if (hit) return shape.test(hit) ? { ref: hit } : { foreign: true };
        const neg = negative.get(key);
        if (neg && neg > clock.now()) return {};
        const r = await scan((row) => codeByVa.has(key));
        const code = codeByVa.get(key);
        if (code) return shape.test(code) ? { ref: code } : { foreign: true };
        if (r.error) throw new Error('sepay: không tra được VA, thử lại sau');
        if (r.complete) negative.set(key, clock.now() + negativeTtlMs);
        return {};
      },
    },

    collectRows,

    // Nạp lại bộ đệm VA -> mã từ state đã lưu trên attempt còn sống, không gọi mạng (PHUB-D-025). Trả 1 nếu nạp được, 0 nếu attempt không có state.
    adopt(a) {
      const st = a && a.state;
      if (!st || isBlank(st.orderId) || isBlank(a.attemptRef)) return 0;
      return remember({ id: st.orderId, order_code: String(a.attemptRef).toUpperCase(), va: (Array.isArray(st.vas) ? st.vas : []).map((n) => ({ va_number: n })) }) ? 1 : 0;
    },

    async query(p) {
      const want = String(p.attemptRef || '').toUpperCase();
      if (!shape.test(want)) return { state: 'not_found' };
      const loc = await locate(want, p.createdAt, p.state);
      if (!loc.entry) return { state: loc.state };
      const d = await detail(loc.entry);
      if (!d) return { state: 'unknown' };
      const rows = await rowsOfVas(loc.entry.vas, p.createdAt);
      if (rows.error) return { state: 'unknown' };
      const events = [];
      for (const row of rows.rows) { const ev = bank.eventFromApiRow(row, 'query', want); if (ev) events.push(ev); }
      if (events.length) return events;
      // Đơn báo đã có tiền mà sao kê không thấy khoản nào: dữ liệu chưa nhất quán, không kết luận và không tự dựng khoản tiền.
      if (['Paid', 'Partially'].includes(d.status) || toInt(d.paid_amount) > 0) return { state: 'unknown' };
      return { state: 'not_found' };
    },

    async cancel(p) {
      const want = String(p.attemptRef || '').toUpperCase();
      if (!shape.test(want)) return { cancelled: false };
      const loc = await locate(want, undefined, p.state);
      if (!loc.entry) return { cancelled: false };
      const r = await bank.apiCall('DELETE', `/bank-accounts/${ba}/orders/${encodeURIComponent(loc.entry.id)}`);
      // Chỉ 204/200 mới là đã hủy; mọi lỗi (422 invalid_state do đã có tiền, 403 của Vietcombank, mạng) coi là chưa hủy được.
      return { cancelled: !r.error && (r.status === 204 || r.status === 200) };
    },
  };
}

module.exports = { createVaOrder };

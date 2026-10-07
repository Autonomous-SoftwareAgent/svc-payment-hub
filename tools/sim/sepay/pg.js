'use strict';
// spec: SEPY-S-005
// Mô phỏng sản phẩm C của SePay (cổng pay.sepay.vn / pgapi.sepay.vn). Xem SEPY-D-005.
// FORMAT theo bằng chứng: lỗi 401 của API cổng và "form lỗi vẫn HTTP 200 text/html" là live (C0); chữ ký form, IPN, API đơn hàng theo docs và
// SDK chính thức (docs-only). SEMANTIC (unverified) mô phỏng bất lợi, cấu hình được qua POST /sim/control.

const PG_CONTROLS = {
  pg_sign_order: 'docs',        // docs | form | either: thứ tự trường mà "server SePay" dùng khi kiểm chữ ký (C1 conflicts)
  pg_detail_key: 'invoice',     // invoice (SDK chính thức) | order_id (docs): khóa tra GET /v1/order/detail/{key} (C5 conflicts)
  pg_list_has_transactions: false, // dòng danh sách đơn có kèm transactions[] hay không
  pg_ipn_on_decline: false,     // gửi IPN cho giao dịch bị từ chối (docs-silent, CS1)
  pg_pay_after_cancel: false,   // đơn đã hủy vẫn nhận tiền (docs-silent, CS5)
  pg_api_mode: 'ok',            // ok | fail_503 | rate_limit (API đơn hàng lỗi tạm thời)
  pg_amount_decimals: true,     // order_amount dạng "50000.00" như ví dụ IPN (C2)
};

const SIGNED = ['order_amount', 'merchant', 'currency', 'operation', 'order_description', 'order_invoice_number', 'customer_id', 'payment_method', 'success_url', 'error_url', 'cancel_url'];

function installPg(ctx) {
  const { state, clock, c, opts, sendJson, vnDate, crypto, dispatch } = ctx;
  const merchantId = opts.pgMerchantId || 'SIMMERCHANT';
  const secretKey = opts.pgSecretKey || 'sim-pg-secret-key';
  const ipnAuth = opts.pgIpnAuth || 'secret_key';
  const ipnSecret = opts.pgIpnSecret || secretKey;
  state.pgOrders = []; // theo thứ tự tạo
  let seq = 0; let txSeq = 0; let noteSeq = 0;

  const hex = (n) => crypto.randomBytes(n).toString('hex').toUpperCase();
  const uuid = () => crypto.randomUUID();
  const html = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
  // Lỗi của form vẫn là HTTP 200 text/html (C0, live)
  const formError = (res) => html(res, 200, '<!DOCTYPE html><html><body><h1>Lỗi không xác định</h1><p>Đã có lỗi xảy ra trong quá trình thực hiện, vui lòng liên hệ nhà bán hàng để được hỗ trợ.</p></body></html>');

  const signOf = (fields, order) => {
    const keys = order === 'form' ? Object.keys(fields).filter((k) => SIGNED.includes(k)) : SIGNED.filter((k) => k in fields);
    const str = keys.map((k) => `${k}=${fields[k]}`).join(',');
    return crypto.createHmac('sha256', secretKey).update(str).digest('base64');
  };

  const money = (n) => (c().pg_amount_decimals ? `${n}.00` : String(n));
  const txView = (t) => ({ id: t.id, payment_method: t.payment_method, transaction_type: t.transaction_type, transaction_amount: String(t.amount), transaction_currency: 'VND', transaction_status: t.transaction_status, authentication_status: 'AUTHENTICATION_SUCCESSFUL', transaction_date: t.date, transaction_last_updated_date: t.date });
  const orderView = (o, withTx) => {
    const v = {
      id: o.internalId, customer_id: o.customer_id, order_id: o.order_id, order_invoice_number: o.invoice, order_status: o.status, order_amount: money(o.amount),
      order_currency: 'VND', order_description: o.description, authentication_status: 'AUTHENTICATION_SUCCESSFUL', created_at: o.created_at, updated_at: o.updated_at,
    };
    if (withTx) v.transactions = o.transactions.map(txView);
    return v;
  };

  // ---------- thông báo IPN (đi qua cùng cơ chế giao/thử lại của webhook) ----------
  function ipnBody(o, t, kind) {
    return {
      timestamp: Math.floor(clock.now() / 1000), notification_type: kind,
      order: {
        id: o.uuid, order_id: o.order_id, order_status: o.status, order_currency: 'VND', order_amount: money(o.amount), order_invoice_number: o.invoice,
        custom_data: [], user_agent: 'Mozilla/5.0', ip_address: '14.0.0.1', order_description: o.description,
      },
      transaction: {
        id: t.uuid, payment_method: t.payment_method, transaction_id: t.transaction_id, transaction_type: t.transaction_type, transaction_date: t.date,
        transaction_status: t.transaction_status, transaction_amount: String(t.amount), transaction_currency: 'VND',
      },
      customer: { id: uuid(), customer_id: o.customer_id },
    };
  }

  async function notify(o, t, kind) {
    noteSeq += 1;
    const note = { id: noteSeq, createdAt: clock.now(), invoice: o.invoice, body: ipnBody(o, t, kind), webhook: { status: 'pending', attempts: [] } };
    state.pgNotes.push(note);
    await dispatch(note, 'ipn');
    return note;
  }

  function ipnRequest(note) {
    const headers = { 'content-type': 'application/json' };
    if (ipnAuth === 'secret_key') headers['x-secret-key'] = c().webhook_bad_auth ? `${ipnSecret}-wrong` : ipnSecret;
    return { body: JSON.stringify(note.body), headers };
  }

  // ---------- checkout ----------
  function handleInit(req, res, raw) {
    const fields = Object.fromEntries(new URLSearchParams(raw));
    const mode = c().pg_sign_order;
    const okSig = fields.signature && (mode === 'either'
      ? [signOf(fields, 'docs'), signOf(fields, 'form')].includes(fields.signature)
      : signOf(fields, mode === 'form' ? 'form' : 'docs') === fields.signature);
    const amount = Number(fields.order_amount);
    if (fields.merchant !== merchantId || !okSig || !Number.isInteger(amount) || amount <= 0 || !fields.order_invoice_number || fields.currency !== 'VND' || !fields.order_description) return formError(res);
    if (state.pgOrders.some((o) => o.invoice === fields.order_invoice_number)) return formError(res); // trùng invoice (docs: phải duy nhất; kết quả cụ thể docs-silent)
    seq += 1;
    const now = vnDate(clock.now());
    const order = {
      internalId: String(seq), uuid: uuid(), order_id: `SEPAY-${hex(6)}`, invoice: fields.order_invoice_number, amount, status: 'AUTHENTICATION_NOT_NEEDED',
      description: fields.order_description, method: fields.payment_method || 'BANK_TRANSFER', customer_id: fields.customer_id || null,
      urls: { success: fields.success_url, error: fields.error_url, cancel: fields.cancel_url }, created_at: now, updated_at: now, transactions: [],
    };
    state.pgOrders.push(order);
    const q = new URLSearchParams({ merchant: merchantId, payment_method: order.method, operation: 'PURCHASE', order_id: order.order_id, order_amount: String(amount), order_invoice_number: order.invoice });
    res.writeHead(302, { location: `/v1/checkout?${q}` });
    return res.end();
  }

  // ---------- khách trả tiền trên trang của SePay (điều khiển từ test) ----------
  async function pay(body) {
    const o = state.pgOrders.find((x) => x.invoice === body.invoice);
    if (!o) throw Object.assign(new Error('đơn không tồn tại (khách chưa mở form?)'), { code: 404 });
    const outcome = body.outcome || 'success';
    const urls = o.urls;
    if (outcome === 'cancel') {
      o.status = 'CANCELLED'; o.updated_at = vnDate(clock.now());
      return { order: orderView(o, true), redirect: urls.cancel || null };
    }
    if (outcome === 'error') return { order: orderView(o, true), redirect: urls.error || null };
    if (o.status === 'CANCELLED' && !c().pg_pay_after_cancel) throw Object.assign(new Error('đơn đã hủy'), { code: 422 });
    txSeq += 1;
    const amount = body.amount === undefined ? o.amount : Number(body.amount);
    const t = {
      id: String(txSeq), uuid: uuid(), transaction_id: `68ba${hex(5).toLowerCase()}`, payment_method: body.method || o.method, transaction_type: 'PAYMENT',
      transaction_status: outcome === 'declined' ? 'DECLINED' : 'APPROVED', amount, date: vnDate(clock.now()),
    };
    o.transactions.push(t);
    if (outcome === 'declined') {
      if (c().pg_ipn_on_decline) await notify(o, t, 'ORDER_PAID');
      return { order: orderView(o, true), redirect: urls.error || null };
    }
    o.status = 'CAPTURED'; o.updated_at = vnDate(clock.now());
    await notify(o, t, 'ORDER_PAID');
    return { order: orderView(o, true), redirect: urls.success || null };
  }

  async function voidTx(body) {
    const o = state.pgOrders.find((x) => x.invoice === body.invoice);
    const paid = o && o.transactions.find((t) => t.transaction_type === 'PAYMENT' && t.transaction_status === 'APPROVED');
    if (!o || !paid || o.status !== 'CAPTURED') throw Object.assign(new Error('chỉ void được đơn CAPTURED'), { code: 422 });
    txSeq += 1;
    const t = { id: String(txSeq), uuid: uuid(), transaction_id: paid.transaction_id, payment_method: paid.payment_method, transaction_type: 'VOID', transaction_status: 'APPROVED', amount: paid.amount, date: vnDate(clock.now()) };
    o.transactions.push(t);
    await notify(o, t, 'TRANSACTION_VOID');
    return { order: orderView(o, true) };
  }

  // ---------- API đơn hàng (Basic merchant:secret) ----------
  function apiAuth(req, res) {
    const want = `Basic ${Buffer.from(`${merchantId}:${secretKey}`).toString('base64')}`;
    if (req.headers.authorization !== want) { sendJson(res, 401, { status: 401, error: 401, messages: { error: 'Unauthorized' } }); return false; } // dạng lỗi live (C0)
    const mode = c().pg_api_mode;
    if (mode === 'fail_503') { sendJson(res, 503, { message: 'Service Unavailable' }); return false; }
    if (mode === 'rate_limit') { sendJson(res, 429, { message: 'Too Many Requests' }); return false; }
    return true;
  }

  function meta(total, perPage, page) {
    return { per_page: perPage, total, has_more: page * perPage < total, current_page: page, page_count: Math.max(1, Math.ceil(total / perPage)) };
  }

  async function handle(req, res, u, raw) {
    const path = u.pathname;
    const q = u.searchParams;
    if (req.method === 'POST' && path === '/v1/checkout/init') return handleInit(req, res, raw);
    if (req.method === 'GET' && path === '/v1/checkout') return html(res, 200, `<!DOCTYPE html><html><body>Trang thanh toan SePay (mo phong): ${u.search}</body></html>`);
    let m;
    if (req.method === 'GET' && (m = /^\/v1\/order\/detail\/([^/]+)$/.exec(path))) {
      if (!apiAuth(req, res)) return undefined;
      const key = decodeURIComponent(m[1]);
      const o = state.pgOrders.find((x) => (c().pg_detail_key === 'order_id' ? x.order_id : x.invoice) === key);
      if (!o) return sendJson(res, 404, { message: 'Không tìm thấy đơn hàng' });
      return sendJson(res, 200, { data: orderView(o, true) });
    }
    if (req.method === 'GET' && path === '/v1/order') {
      if (!apiAuth(req, res)) return undefined;
      let rows = state.pgOrders.slice();
      if ((q.get('sort') || 'created_at:desc') !== 'created_at:asc') rows.reverse();
      if (q.get('order_status')) rows = rows.filter((o) => o.status === q.get('order_status'));
      const s = q.get('q');
      if (s) rows = rows.filter((o) => [o.invoice, o.order_id, o.description].some((f) => String(f).toLowerCase().includes(s.toLowerCase())));
      const perPage = Math.min(100, Math.max(1, Number(q.get('per_page')) || 20));
      const page = Math.max(1, Number(q.get('page')) || 1);
      return sendJson(res, 200, { data: rows.slice((page - 1) * perPage, page * perPage).map((o) => orderView(o, c().pg_list_has_transactions)), meta: meta(rows.length, perPage, page) });
    }
    if (req.method === 'POST' && path === '/v1/order/cancel') {
      if (!apiAuth(req, res)) return undefined;
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { message: 'bad json' }); }
      const o = state.pgOrders.find((x) => x.invoice === body.order_invoice_number);
      if (!o) return sendJson(res, 404, { message: 'Không tìm thấy đơn hàng' });
      if (!['BANK_TRANSFER', 'NAPAS_BANK_TRANSFER'].includes(o.method)) return sendJson(res, 422, { message: 'Chỉ hủy được đơn chuyển khoản' });
      if (o.status !== 'AUTHENTICATION_NOT_NEEDED') return sendJson(res, 422, { message: 'Đơn không ở trạng thái hủy được' });
      o.status = 'CANCELLED'; o.updated_at = vnDate(clock.now());
      return sendJson(res, 200, { message: 'Đã hủy đơn hàng thành công' });
    }
    return sendJson(res, 404, { message: 'not found' });
  }

  async function handleSim(req, res, path, body) {
    if (req.method === 'POST' && path === '/sim/pg/pay') {
      try { return sendJson(res, 200, await pay(body)), true; } catch (e) { return sendJson(res, e.code === 404 || e.code === 422 ? e.code : 500, { error: String(e.message) }), true; }
    }
    if (req.method === 'POST' && path === '/sim/pg/void') {
      try { return sendJson(res, 200, await voidTx(body)), true; } catch (e) { return sendJson(res, e.code === 422 ? 422 : 500, { error: String(e.message) }), true; }
    }
    return false;
  }

  return {
    handle, handleSim, ipnRequest, SIGNED,
    view: () => ({ pgOrders: state.pgOrders.map((o) => ({ ...orderView(o, true), method: o.method, urls: o.urls })), pgNotes: state.pgNotes }),
    config: { pgMerchantId: merchantId, pgSecretKey: secretKey, pgIpnAuth: ipnAuth },
  };
}

module.exports = { installPg, PG_CONTROLS };

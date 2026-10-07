'use strict';
// spec: SEPY-S-004
// Mô phỏng sản phẩm B của SePay (VA theo đơn hàng, API v2) + ngân hàng cấp VA. Xem SEPY-D-004.
// FORMAT theo docs (docs-only, chưa có live ngoài lỗi 401 chung của v2): body/phản hồi tạo đơn, danh sách, chi tiết, hủy, Refunds API.
// SEMANTIC (unverified): chuyển sai số tiền, vào VA đã đóng, hủy, hoàn tiền: mô phỏng bất lợi, cấu hình được qua POST /sim/control.

const VA_CONTROLS = {
  va_create_mode: 'ok',            // ok | fail_503 (không tạo đơn) | lost_response (đơn được tạo nhưng phản hồi bị mất)
  va_mismatch_mode: 'land',        // BIDV/Sacombank/Vietcombank/VietinBank đòi đúng số tiền mà khách chuyển khác: reject (ngân hàng từ chối) | land (tiền vẫn vào, đơn không đổi) (BS2, unverified)
  va_closed_mode: 'reject',        // chuyển vào VA đã hết hạn/đã trả/đã hủy: reject | land (BS3, unverified)
  va_unmatched_subaccount: 'empty',// webhook của khoản tiền vào mà đơn không khớp: subAccount là "va" (số VA) hoặc "empty" (BS: VietinBank vượt amount, unverified)
  va_code_mode: 'null',            // trường code của webhook giao dịch VA: order_code (trang Order VA) | null (trang webhook) (B6 conflicts)
  va_vcb_cancel_refuse: false,     // Vietcombank từ chối hủy (403 vcb_cancel_not_allowed) (BS4)
  refund_gate: 'open',             // open (Sandbox) | not_available | unsupported_bank (B9)
  refund_mode: 'ok',               // ok | busy_503 (không tạo bản ghi) | lost_after_create (tạo bản ghi pending, trả 503) | drop_response (tạo bản ghi, mất phản hồi)
  refund_final: 'succeeded',       // kết cục khi hết refund_settle_seconds: succeeded | failed | rejected
  refund_settle_seconds: 60,
};

const BANKS = ['BIDV', 'Sacombank', 'Vietcombank', 'VietinBank'];
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function installVa(ctx) {
  const { state, clock, c, opts, sendJson, apiId, v2Guard, recordTransfer, dispatch, vnDate } = ctx;
  const bank = BANKS.includes(opts.vaBank) ? opts.vaBank : 'BIDV';
  const vaPrefix = opts.vaPrefix || 'SEP200001WEB';
  const vcbTid = opts.vcbTid || '20933557';
  const exactOnly = bank === 'Sacombank' || bank === 'Vietcombank';
  state.orders = [];   // đơn VA theo thứ tự tạo
  state.refunds = [];
  state.refundKeys = new Map();
  let seq = 0; let refundSeq = 0;

  const err = (res, status, code, message) => sendJson(res, status, { status: 'error', message: message || code, error_code: code });
  const nowVn = () => vnDate(clock.now());
  const vnMs = (s) => Date.parse(`${s.replace(' ', 'T')}+07:00`);

  const vaView = (v) => ({ va_number: v.va_number, va_holder_name: v.va_holder_name, amount: v.amount, status: v.status, expired_at: v.expired_at, paid_at: v.paid_at });
  const orderView = (o) => ({
    id: o.id, order_code: o.order_code, amount: o.amount, paid_amount: o.paid_amount, status: o.status, refund_status: o.refund_status,
    created_at: o.created_at, updated_at: o.updated_at, bank_name: o.bank_name, account_number: o.account_number, account_holder_name: o.account_holder_name,
    va: o.va.map(vaView),
  });

  function paginate(rows, q) {
    const perPage = Math.min(100, Math.max(1, Number(q.get('per_page')) || 20));
    const page = Math.max(1, Number(q.get('page')) || 1);
    const lastPage = Math.max(1, Math.ceil(rows.length / perPage));
    return { data: rows.slice((page - 1) * perPage, page * perPage), meta: { pagination: { total: rows.length, per_page: perPage, current_page: page, last_page: lastPage, has_more: page < lastPage } } };
  }

  // ---------- tạo đơn ----------
  function createOrder(body, res) {
    const mode = c().va_create_mode;
    if (mode === 'fail_503') return err(res, 503, 'vcb_connection_error', 'service temporarily unavailable');
    let code = body.order_code;
    const maxLen = bank === 'Vietcombank' ? 15 : 50;
    if (code !== undefined && code !== null && code !== '') {
      if (typeof code !== 'string' || !/^[A-Za-z0-9]+$/.test(code) || code.length < 6 || code.length > maxLen) return err(res, 422, 'validation_error', 'order_code không hợp lệ');
      code = code.toUpperCase();
    } else code = crypto10();
    let amount = body.amount;
    if (amount === undefined || amount === null) {
      if (bank !== 'BIDV') return err(res, 422, 'validation_error', 'amount là bắt buộc');
      amount = null;
    } else if (!Number.isInteger(amount) || amount <= 0 || String(amount).length > 12) return err(res, 422, 'validation_error', 'amount không hợp lệ');
    if (bank === 'Vietcombank') {
      if (!body.tid) return err(res, 422, 'validation_error', 'tid là bắt buộc');
      if (/^[0-9a-f-]{36}$/i.test(String(body.tid))) return err(res, 422, 'invalid_tid_format', 'tid là UUID');
      if (String(body.tid) !== vcbTid) return err(res, 422, 'invalid_tid', 'tid không thuộc tài khoản');
    }
    if (bank === 'Sacombank' && body.va_prefix !== vaPrefix) return err(res, 400, 'bad_request', 'va_prefix không tồn tại hoặc đã bị hủy');
    if (state.orders.some((o) => o.order_code === code)) return err(res, 409, 'duplicate', 'Trùng order_code');
    seq += 1;
    const created = nowVn();
    const duration = Number(body.duration) > 0 && bank !== 'BIDV' ? Number(body.duration) : null; // BIDV: không hạn (expired_at null, docs-only)
    const expired = duration ? vnDate(clock.now() + duration * 1000) : null;
    const number = `963${String(seq).padStart(9, '0')}`;
    const order = {
      id: uuid(1000 + seq), order_code: code, amount, paid_amount: 0, status: 'Pending', refund_status: null, created_at: created, updated_at: created,
      bank_name: bank, account_number: '1234567890', account_holder_name: 'CONG TY BSN TEST',
      va: [{ id: uuid(5000 + seq), va_number: number, va_holder_name: 'CONG TY BSN TEST', amount, status: 'Unpaid', expired_at: expired, paid_at: null }],
    };
    order.request = body;
    state.orders.push(order);
    if (mode === 'lost_response') { res.socket.destroy(); return undefined; }
    const withQr = String(body.with_qrcode) === '1';
    const data = {
      id: order.id, order_code: code, va_number: number, va_holder_name: order.va[0].va_holder_name, amount, status: 'Pending', bank_name: bank,
      account_holder_name: order.account_holder_name, account_number: order.account_number, expired_at: expired,
    };
    if (bank === 'Vietcombank') data.va = order.va.map(vaView);
    if (withQr) { data.qr_code = 'data:image/png;base64,iVBORw0KGgo='; data.qr_code_url = `https://vietqr.app/img?acc=${number}&bank=${bank}${amount ? `&amount=${amount}` : ''}&template=compact`; }
    return sendJson(res, 201, { status: 'success', message: 'Order created successfully', data });
  }
  const crypto10 = () => Array.from({ length: 10 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

  // ---------- chuyển khoản vào một VA (khách -> ngân hàng -> SePay) ----------
  async function transferToVa(b) {
    const order = state.orders.find((o) => o.va.some((v) => v.va_number === b.va));
    if (!order) throw Object.assign(new Error('bank_rejected: VA không tồn tại'), { code: 422 });
    const v = order.va.find((x) => x.va_number === b.va);
    const amount = Number(b.amount);
    const cc = c();
    const expired = v.expired_at && vnMs(v.expired_at) <= clock.now();
    const closed = order.status === 'Cancelled' || v.status !== 'Unpaid' || expired;
    let matched = true;
    let why = null;
    if (closed) { matched = false; why = 'closed'; } else if (exactOnly) {
      if (amount !== order.amount) { matched = false; why = 'amount'; }
    } else if (bank === 'VietinBank') {
      if (amount > v.amount) { matched = false; why = 'over'; }
    }
    if (!matched) {
      const mode = why === 'closed' ? cc.va_closed_mode : (why === 'over' ? 'land' : cc.va_mismatch_mode);
      if (mode === 'reject') throw Object.assign(new Error(`bank_rejected: ${why}`), { code: 422 });
    }
    const content = b.content === undefined ? '' : b.content;
    const base = { ...b, content, va: b.va };
    let tx;
    if (matched) {
      order.paid_amount += amount;
      const full = order.amount === null || order.paid_amount >= order.amount;
      order.status = full ? 'Paid' : 'Partially';
      if (full) { v.status = 'Paid'; v.paid_at = nowVn(); }
      order.updated_at = nowVn();
      tx = recordTransfer({ ...base, code: cc.va_code_mode === 'order_code' ? order.order_code : null });
    } else {
      // Tiền vào tài khoản thật nhưng đơn không đổi trạng thái
      tx = recordTransfer({ ...base, code: null, subAccount: cc.va_unmatched_subaccount === 'va' ? b.va : '' });
    }
    tx.vaId = v.id;
    tx.matched = matched;
    tx.orderId = order.id;
    await dispatch(tx);
    return tx;
  }

  // ---------- Refunds API ----------
  const txById = (id) => state.transactions.find((t) => apiId(t) === id || String(t.id) === id);
  const settle = (r) => {
    if (r.status === 'pending' && clock.now() >= r.settle_at) r.status = r.final;
    return r;
  };
  const refundView = (r) => {
    settle(r);
    return { refund_id: r.refund_id, order_type: r.order_type, order_id: r.order_id, order_code: r.order_code, xid: r.xid, transaction_id: r.transaction_id, original_reference: r.original_reference, amount: r.amount, currency: 'VND', scope: r.scope, status: r.status, created_at: r.created_at };
  };

  function createRefund(req, res, txId, body) {
    const key = req.headers['x-idempotency-key'];
    if (!key || key.length > 100) return err(res, 422, 'idempotency_key_required', 'X-Idempotency-Key bắt buộc, tối đa 100 ký tự');
    const gate = c().refund_gate;
    if (gate === 'unsupported_bank') return err(res, 422, 'unsupported_bank', 'bank không hỗ trợ hoàn tiền');
    if (gate === 'not_available') return err(res, 422, 'not_available', 'chưa mở hoàn tiền');
    const tx = txById(txId);
    if (!tx) return err(res, 404, 'not_found', 'transaction not found');
    const payload = JSON.stringify({ t: String(tx.id), a: body.refund_amount === undefined ? null : body.refund_amount });
    const prior = state.refundKeys.get(key);
    if (prior) {
      if (prior.payload !== payload) return err(res, 409, 'idempotency_key_reused', 'khóa đã dùng cho lệnh khác');
      return sendJson(res, 200, { status: 'success', data: refundView(prior.refund) });
    }
    if (tx.transferType !== 'in') return err(res, 422, 'not_refundable', 'chỉ hoàn khoản thu');
    const used = state.refunds.filter((r) => r.tx === tx.id && ['pending', 'succeeded'].includes(settle(r).status)).reduce((s2, r) => s2 + r.amount, 0);
    const remaining = tx.amount - used;
    if (remaining <= 0) return err(res, 422, 'already_refunded', 'khoản thu đã hoàn hết');
    const amount = body.refund_amount === undefined ? remaining : body.refund_amount;
    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) return err(res, 422, 'validation_error', 'refund_amount không hợp lệ hoặc vượt phần còn lại');
    if (c().refund_mode === 'busy_503') return err(res, 503, 'refund_busy', 'đang có lệnh hoàn khác cho khoản này');
    refundSeq += 1;
    const order = state.orders.find((o) => o.id === tx.orderId);
    const r = {
      refund_id: `RF-SIM${String(refundSeq).padStart(4, '0')}-TEST`, order_type: order ? 'va_order' : null, order_id: order ? order.id : null, order_code: order ? order.order_code : null,
      xid: uuid(9000 + refundSeq), transaction_id: apiId(tx), original_reference: tx.referenceCode, amount, scope: used + amount === tx.amount ? 'full' : 'partial',
      status: 'pending', created_at: nowVn(), tx: tx.id, final: c().refund_final, settle_at: clock.now() + Number(c().refund_settle_seconds) * 1000,
    };
    state.refunds.push(r);
    state.refundKeys.set(key, { payload, refund: r });
    if (c().refund_mode === 'lost_after_create') return err(res, 503, 'vietinbank_map_connection_error', 'không kết nối được ngân hàng');
    if (c().refund_mode === 'drop_response') { res.socket.destroy(); return undefined; }
    return sendJson(res, 200, { status: 'success', data: refundView(r) });
  }

  // ---------- route công khai /v2 ----------
  async function handle(req, res, u, raw) {
    const path = u.pathname;
    const q = u.searchParams;
    let m;
    const isOrders = /^\/v2\/bank-accounts\/[^/]+\/(orders|refunds)/.test(path) || /^\/v2\/transactions\/[^/]+\/refund$/.test(path);
    if (!isOrders) return false;
    if (v2Guard(req, res)) return true;
    let body = {};
    if (raw) { try { body = JSON.parse(raw); } catch { err(res, 422, 'validation_error', 'bad json'); return true; } }
    const ba = /^\/v2\/bank-accounts\/([^/]+)/.exec(path);
    if (ba && ctx.bankAccountId && ba[1] !== ctx.bankAccountId) { err(res, 404, 'not_found', 'Bank account not found'); return true; }
    if (req.method === 'POST' && /^\/v2\/bank-accounts\/[^/]+\/orders$/.test(path)) { createOrder(body, res); return true; }
    if (req.method === 'GET' && /^\/v2\/bank-accounts\/[^/]+\/orders$/.test(path)) {
      let rows = state.orders.slice();
      if (q.get('created_at_sort') !== 'asc') rows = rows.reverse();
      const p = paginate(rows.map(orderView), q);
      sendJson(res, 200, { status: 'success', data: p.data, meta: p.meta });
      return true;
    }
    if ((m = /^\/v2\/bank-accounts\/[^/]+\/orders\/([^/]+)$/.exec(path))) {
      const o = state.orders.find((x) => x.id === m[1]);
      if (!o) { err(res, 404, 'not_found', 'Order not found'); return true; }
      if (req.method === 'GET') { sendJson(res, 200, { status: 'success', data: orderView(o) }); return true; }
      if (req.method === 'DELETE') {
        if (o.status !== 'Pending') { err(res, 422, 'invalid_state', 'Chỉ hủy được đơn Pending'); return true; }
        if (bank === 'Vietcombank' && c().va_vcb_cancel_refuse) { err(res, 403, 'vcb_cancel_not_allowed', 'invoice đã thanh toán hoặc đã hủy'); return true; }
        o.status = 'Cancelled'; o.updated_at = nowVn();
        for (const v of o.va) if (v.status === 'Unpaid') v.status = 'Cancelled';
        res.writeHead(204); res.end();
        return true;
      }
    }
    if (req.method === 'POST' && (m = /^\/v2\/transactions\/([^/]+)\/refund$/.exec(path))) { createRefund(req, res, decodeURIComponent(m[1]), body); return true; }
    if (req.method === 'GET' && /^\/v2\/bank-accounts\/[^/]+\/refunds$/.test(path)) {
      let rows = state.refunds.map(settle).slice().reverse();
      if (q.get('transaction')) rows = rows.filter((r) => r.transaction_id === q.get('transaction') || String(r.tx) === q.get('transaction'));
      if (q.get('order')) rows = rows.filter((r) => r.order_id === q.get('order'));
      if (q.get('status')) rows = rows.filter((r) => r.status === q.get('status'));
      const p = paginate(rows.map(refundView), q);
      sendJson(res, 200, { status: 'success', data: p.data, meta: p.meta });
      return true;
    }
    if (req.method === 'GET' && (m = /^\/v2\/bank-accounts\/[^/]+\/refunds\/([^/]+)$/.exec(path))) {
      const r = state.refunds.find((x) => x.refund_id === m[1]);
      if (!r) { err(res, 404, 'not_found', 'Refund not found'); return true; }
      sendJson(res, 200, { status: 'success', data: refundView(r) });
      return true;
    }
    err(res, 404, 'not_found', 'unknown route');
    return true;
  }

  // Điều khiển nội bộ của simulator (không phải API của SePay)
  async function handleSim() { return false; }

  return {
    handle, handleSim, transferToVa,
    view: () => ({ orders: state.orders, refunds: state.refunds }),
    config: { vaBank: bank, vaPrefix, vcbTid },
  };
}

module.exports = { installVa, VA_CONTROLS, BANKS };

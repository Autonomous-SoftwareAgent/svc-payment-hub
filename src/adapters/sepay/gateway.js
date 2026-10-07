'use strict';
// spec: SEPY-S-007
// spec: SEPY-S-005
// spec: PHUB-S-020
// spec: PHUB-S-029
// Sản phẩm C (product "gateway"): cổng pay.sepay.vn, kiểu redirect + IPN. Xem SEPY-D-005. Giả định chưa kiểm chứng (docs-only, trừ C0):
//  * Chữ ký form: base64(HMAC-SHA256(secret, "k=v,k=v")) theo danh sách trường cố định của trang tạo form (C1: thứ tự mâu thuẫn với SDK chính thức).
//  * IPN xác thực bằng header X-Secret-Key, không có chữ ký trên body (C3). DECLINED không bao giờ là kết quả cuối (CS1).
//  * Khóa tra chi tiết đơn: invoice (SDK) hay order_id (docs): thử invoice rồi lùi về danh sách q (C5).
const { crypto, ackResponse, safeEqual, isBlank, parseVnDate, toMoney, makeHttp } = require('./common');

const SIGNED_FIELDS = [
  'order_amount', 'merchant', 'currency', 'operation', 'order_description', 'order_invoice_number',
  'customer_id', 'payment_method', 'success_url', 'error_url', 'cancel_url',
];

function createGateway(ctx, bank) {
  const { cfg, clock } = ctx;
  const pg = cfg.pg;
  const http = makeHttp(ctx.doFetch, cfg.timeoutMs);
  const apiBase = String(pg.apiBaseUrl || 'https://pgapi.sepay.vn/v1').replace(/\/+$/, '');
  const checkoutUrl = pg.checkoutUrl || 'https://pay.sepay.vn/v1/checkout/init';
  const ipnAuth = pg.ipnAuth || 'secret_key';
  const ipnSecret = pg.ipnSecret || pg.secretKey;
  const invoicePrefix = pg.invoicePrefix || 'BSN';
  const refShape = /^[A-Za-z0-9_-]{1,100}$/; // không có dấu phẩy, bằng, và: tránh mơ hồ trong chuỗi ký

  const basic = () => `Basic ${Buffer.from(`${pg.merchantId}:${pg.secretKey}`).toString('base64')}`;

  function sign(fields) {
    const parts = [];
    for (const k of SIGNED_FIELDS) if (fields[k] !== undefined && fields[k] !== null) parts.push(`${k}=${fields[k]}`);
    return crypto.createHmac('sha256', pg.secretKey).update(parts.join(',')).digest('base64');
  }

  function returnUrl(base, ref, result) {
    const u = new URL(base);
    u.searchParams.set('ref', ref);
    u.searchParams.set('r', result);
    return u.toString();
  }

  // Trả {json} hoặc {error:true,status}. 401/429/5xx/mạng/hỏng đều là error (kết luận 'unknown').
  async function pgCall(method, path, { body, params } = {}) {
    if (isBlank(pg.merchantId) || isBlank(pg.secretKey)) return { error: true };
    const r = await http(method, `${apiBase}${path}`, { headers: { authorization: basic() }, body, params });
    if (r.error) return { error: true };
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') return { error: true, status: r.status };
    return { json: r.json };
  }

  const txOf = (o) => (Array.isArray(o.transactions) ? o.transactions : []);

  // Dựng sự kiện chuẩn từ một đơn của API (chi tiết hoặc dòng danh sách)
  function eventsFromOrder(o, ref) {
    const at = parseVnDate(o.updated_at);
    const base = { gateway: 'sepay', attemptRef: ref, source: 'query', occurredAt: Number.isFinite(at) ? at : clock.now(), raw: o };
    const status = String(o.order_status || '');
    const tx = txOf(o);
    const paid = tx.find((t) => t.transaction_type === 'PAYMENT' && t.transaction_status === 'APPROVED');
    const voided = tx.find((t) => t.transaction_type === 'VOID' && t.transaction_status === 'APPROVED');
    const orderAmount = toMoney(o.order_amount);
    if (status === 'CAPTURED') {
      const amount = paid ? toMoney(paid.transaction_amount) : orderAmount; // thiếu chi tiết giao dịch: lùi về số tiền đơn (unverified)
      if (!Number.isInteger(amount)) return { state: 'unknown' };
      const txnId = paid ? (paid.transaction_id || paid.id) : o.id;
      // Đã thu rồi bị VOID: tiền ròng bằng không. Chỉ báo reversed (PHUB-D-018, P5), không báo succeeded: để Hub không đánh dấu PAID rồi mới đảo.
      // gatewayTxnId của reversed phải ổn định giữa các kênh (IPN và truy vấn): mã giao dịch của hai kênh có thể khác nhau, nên dùng mã theo đơn.
      if (voided) return [{ ...base, type: 'reversed', amount, gatewayTxnId: `void:${ref}` }];
      return [{ ...base, type: 'succeeded', amount, gatewayTxnId: String(txnId) }];
    }
    if (status === 'CANCELLED') {
      if (!Number.isInteger(orderAmount)) return { state: 'unknown' };
      return [{ ...base, type: 'cancelled', amount: orderAmount, failCode: ctx.failCode('CANCELLED'), gatewayCode: 'CANCELLED' }];
    }
    if (status === 'AUTHENTICATION_NOT_NEEDED') return [{ ...base, type: 'pending' }];
    return { state: 'unknown' };
  }

  return {
    product: 'gateway',

    capabilities() {
      return {
        hardExpiry: 'unknown', cancellable: true, queryable: true, refundable: 'manual', refundAsync: true, createCanTimeout: false,
        currencies: ['VND'], regions: ['VN'], methods: ['card_international', 'qr', 'bank_transfer'], // trang thanh toán SePay: thẻ, QR ngân hàng, NAPAS (theo tài liệu, chưa kiểm với cổng thật)
        referenceFormat: { prefix: invoicePrefix },
      };
    },

    // Không gọi mạng: dựng form đã ký để trình duyệt của khách POST tới SePay. Lõi Hub hiện chỉ giữ url (SEPY-D-006, P1).
    async createPayment(p) {
      const ref = typeof p.attemptRef === 'string' ? p.attemptRef : '';
      if (!refShape.test(ref)) return { status: 'rejected', reason: 'attemptRef chỉ được gồm A-Z a-z 0-9 _ -', failCode: 'invalid_request' };
      if (!Number.isInteger(p.amount) || p.amount <= 0) return { status: 'rejected', reason: 'amount phải là số nguyên VND dương', failCode: 'invalid_request' };
      if (isBlank(pg.merchantId) || isBlank(pg.secretKey)) return { status: 'rejected', reason: 'thiếu merchantId/secretKey', failCode: 'invalid_request' };
      const back = pg.returnBaseUrl || p.returnUrl;
      if (isBlank(back)) return { status: 'rejected', reason: 'thiếu returnBaseUrl', failCode: 'invalid_request' };
      const description = String(p.orderInfo || `Thanh toan ${ref}`).replace(/[\r\n]+/g, ' ').slice(0, 200);
      const fields = {
        order_amount: String(p.amount), merchant: pg.merchantId, currency: 'VND', operation: 'PURCHASE',
        order_description: description, order_invoice_number: ref,
      };
      if (!isBlank(pg.paymentMethod)) fields.payment_method = pg.paymentMethod;
      fields.success_url = returnUrl(back, ref, 'success');
      fields.error_url = returnUrl(back, ref, 'error');
      fields.cancel_url = returnUrl(back, ref, 'cancel');
      fields.signature = sign(fields);
      return { status: 'redirect', url: checkoutUrl, method: 'POST', fields };
    },

    // IPN (channel ipn) hoặc trình duyệt quay về (channel return, chỉ để hiển thị)
    parseCallback(req) {
      const ack = (outcome) => ackResponse(outcome);
      if (req.channel === 'return') {
        const q = req.query || {};
        if (isBlank(q.ref) || !refShape.test(String(q.ref))) return { valid: false, reason: 'bad_return', ack };
        const event = { gateway: 'sepay', type: 'pending', attemptRef: String(q.ref), source: 'return', occurredAt: clock.now(), raw: { result: q.r } };
        return { valid: true, event, ack };
      }
      const rawBody = bank.rawOf(req);
      let reason = null;
      if (ipnAuth === 'secret_key') reason = safeEqual((req.headers || {})['x-secret-key'], ipnSecret) ? null : 'bad_secret_key';
      else if (ipnAuth !== 'none') reason = bank.authenticate(req, rawBody, ipnAuth);
      if (reason) return { valid: false, reason, ack };
      const data = bank.parseBody(req.body !== undefined && req.body !== null ? req.body : rawBody);
      if (!data || typeof data.notification_type !== 'string' || !data.order || typeof data.order !== 'object' || !data.transaction || typeof data.transaction !== 'object') {
        return { valid: false, reason: 'bad_body', ack };
      }
      const { order, transaction: tx } = data;
      const kind = data.notification_type;
      if (kind !== 'ORDER_PAID' && kind !== 'TRANSACTION_VOID') return { valid: true, ack }; // loại thông báo chưa biết: ghi nhận, bỏ qua
      if (String(tx.transaction_type || '').toUpperCase() === 'REFUND') return { valid: true, ack }; // hoàn tiền do Hub yêu cầu (hoặc người vận hành làm tay): Hub đã biết, không báo reversed để khỏi trừ hai lần
      const amount = toMoney(isBlank(tx.transaction_amount) ? order.order_amount : tx.transaction_amount);
      if (!Number.isInteger(amount) || amount <= 0) return { valid: false, reason: 'bad_amount', ack };
      const at = parseVnDate(tx.transaction_date);
      const tsec = Number(data.timestamp);
      const occurredAt = Number.isFinite(at) ? at : (Number.isFinite(tsec) && tsec > 0 ? tsec * 1000 : clock.now());
      const invoice = isBlank(order.order_invoice_number) ? null : String(order.order_invoice_number);
      const txnId = !isBlank(tx.transaction_id) ? tx.transaction_id : (!isBlank(tx.id) ? tx.id : order.order_id);
      let type;
      if (kind === 'TRANSACTION_VOID') type = 'reversed';
      else if (tx.transaction_status === 'APPROVED' && order.order_status === 'CAPTURED') type = 'succeeded';
      else type = 'pending'; // DECLINED hoặc dữ liệu mâu thuẫn: không bao giờ kết luận thành công hay thất bại (CS1)
      const event = { gateway: 'sepay', type, attemptRef: invoice, source: 'ipn', occurredAt, raw: data };
      if (type !== 'pending') { event.amount = amount; event.gatewayTxnId = type === 'reversed' ? `void:${invoice}` : String(txnId); }
      if (!invoice) {
        if (type !== 'succeeded') return { valid: true, ack }; // pending/void không mang tiền vào
        event.unmatched = true; event.type = 'received'; // tiền đã vào nhưng không biết đơn nào: giữ lại làm khoản chưa rõ chủ
        event.content = String(order.order_description || '');
      }
      return { valid: true, event, ack };
    },

    async query(p) {
      const inv = String(p.attemptRef || '');
      if (!refShape.test(inv)) return { state: 'not_found' };
      let order = null;
      const d = await pgCall('GET', `/order/detail/${encodeURIComponent(inv)}`);
      if (d.json && d.json.data && typeof d.json.data === 'object') order = d.json.data;
      else if (d.status !== 404) return { state: 'unknown' };
      if (!order) { // detail 404: khóa tra có thể là order_id của SePay, thử danh sách theo từ khóa
        const l = await pgCall('GET', '/order', { params: { q: inv, per_page: 100 } });
        if (l.error || !Array.isArray(l.json.data)) return { state: 'unknown' };
        const row = l.json.data.find((o) => o && o.order_invoice_number === inv);
        if (!row) return { state: 'not_found' };
        order = row;
        if (!Array.isArray(row.transactions) && !isBlank(row.order_id)) {
          const d2 = await pgCall('GET', `/order/detail/${encodeURIComponent(row.order_id)}`);
          if (d2.json && d2.json.data && typeof d2.json.data === 'object') order = d2.json.data;
        }
      }
      if (order.order_invoice_number && order.order_invoice_number !== inv) return { state: 'unknown' };
      return eventsFromOrder(order, inv);
    },

    async cancel(p) {
      const inv = String(p.attemptRef || '');
      if (!refShape.test(inv)) return { cancelled: false };
      const r = await pgCall('POST', '/order/cancel', { body: { order_invoice_number: inv } });
      return { cancelled: !r.error }; // chỉ 200 mới là đã hủy; lỗi (đã CAPTURED, mạng, 401) coi là chưa hủy được
    },
  };
}

module.exports = { createGateway, SIGNED_FIELDS };

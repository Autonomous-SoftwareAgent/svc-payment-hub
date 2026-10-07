'use strict';
// spec: PHUB-S-033
// spec: PHUB-S-037
// spec: PHUB-S-038
// spec: PHUB-S-017
// spec: PHUB-S-020
// spec: PHUB-S-029
// Danh mục thao tác của Hub (PHUB-D-017): MỘT nguồn sự thật cho kiểm quyền, kiểm schema, đầu ra và OpenAPI.
// Mỗi thao tác: tên (operationId), vai trò được gọi, schema đầu vào/đầu ra, mã lỗi có thể gặp, hàm chạy trên lõi.
// `bindings.http` chỉ là metadata cho connector HTTP (đường dẫn, mã trạng thái); connector khác (Kafka) gọi theo tên thao tác.
// Thêm thao tác = thêm một mục ở đây; không connector nào phải sửa.

const { AppError } = require('./errors');
const { attemptView, refundView, anomalyView, paymentView, deliveryView, detailView } = require('./views');

const SHOP_ID = /^[a-z0-9_-]{1,32}$/;
const str = { type: 'string' };
const bool = { type: 'boolean' };
const int = { type: 'integer' };
// Phương án thanh toán chuẩn (app/ không import contract nên khai báo lại; test đối chiếu với contract.METHODS)
const METHOD = { ...str, enum: ['wallet', 'qr', 'bank_transfer', 'virtual_account', 'card_domestic', 'card_international'], description: 'Phương án thanh toán chuẩn khách yêu cầu; bỏ trống = cổng nào cũng được' };

// Cửa hàng chỉ thấy đối tượng của mình; của người khác (hoặc không tồn tại) đều là not_found để không lộ sự tồn tại.
function own(principal, shopId) {
  if (principal.role === 'shop' && shopId !== principal.id) throw new AppError('not_found');
}
const limitOf = (v) => Math.min(Number(v) || 100, 1000);

const ADMIN = ['admin'];
const BOTH = ['shop', 'admin'];

const operations = {
  createPayment: {
    summary: 'Tạo thanh toán cho một đơn (idempotent theo cửa hàng + orderId)',
    roles: BOTH,
    input: {
      type: 'object', required: ['orderId', 'amount', 'returnUrl'],
      properties: {
        orderId: { ...str, minLength: 1 }, amount: { ...int, minimum: 1, description: 'Số nguyên theo đơn vị nhỏ nhất của currency (VND: đồng; USD: cent)' }, returnUrl: { ...str, minLength: 1 },
        orderInfo: str, product: str, method: METHOD, clientIp: str, currency: { ...str, description: 'ISO 4217; vắng = VND' }, expiresAt: int,
        extra: { type: 'object', description: 'Tham số riêng của từng cổng: {idCổng: {khóa: giá trị}}, đúng extraSchema của cổng đó; Hub chỉ chuyển tiếp' },
        shopId: { ...str, description: 'Chỉ token quản trị dùng được; token cửa hàng luôn lấy shopId từ chính token' },
      },
    },
    output: { $ref: 'CreatePaymentResult' },
    errors: ['invalid_input', 'order_conflict', 'no_gateway_available'],
    bindings: { http: { method: 'POST', path: '/payments', statuses: [201, 200], status: (r) => (r.existing ? 200 : 201) } },
    async run({ hub, input, principal }) {
      const shopId = principal.role === 'shop' ? principal.id : (input.shopId || 'default');
      if (!SHOP_ID.test(String(shopId))) throw new AppError('invalid_input', 'shopId không hợp lệ');
      const r = await hub.createPayment({ ...input, shopId });
      return { existing: !!r.existing, ...detailView({ payment: r.payment, attempts: hub.store.attemptsOfPayment(r.payment.id), refunds: [], anomalies: [] }), attempt: r.attempt ? attemptView(r.attempt) : null };
    },
  },
  getPayment: {
    summary: 'Xem một payment cùng các attempt, hoàn tiền và anomaly của nó',
    roles: BOTH,
    input: { type: 'object', required: ['paymentId'], properties: { paymentId: str } },
    output: { $ref: 'PaymentDetail' },
    errors: ['not_found'],
    bindings: { http: { method: 'GET', path: '/payments/{paymentId}', statuses: [200] } },
    async run({ hub, input, principal }) {
      const d = await hub.loadPayment(input.paymentId);
      if (!d) throw new AppError('not_found');
      own(principal, d.payment.shopId || 'default');
      return detailView(d);
    },
  },
  createAttempt: {
    summary: 'Tạo attempt mới cho payment đang mở (khách thử lại hoặc chuyển cổng)',
    roles: BOTH,
    input: { type: 'object', required: ['paymentId'], properties: { paymentId: str, reason: { ...str, description: 'customer_retry (mặc định) hoặc failover' }, cancelLive: bool } },
    output: { type: 'object', required: ['attempt', 'payment'], properties: { attempt: { $ref: 'Attempt' }, payment: { $ref: 'Payment' } } },
    errors: ['not_found', 'attempt_still_live', 'payment_not_open', 'max_attempts', 'failover_disabled', 'failover_not_applicable', 'no_gateway_available'],
    bindings: { http: { method: 'POST', path: '/payments/{paymentId}/attempts', statuses: [201] } },
    async run({ hub, input, principal }) {
      if (principal.role === 'shop') own(principal, await hub.shopOf({ paymentId: input.paymentId }));
      const r = await hub.createAttempt(input.paymentId, { reason: input.reason || 'customer_retry', cancelLive: !!input.cancelLive });
      return { attempt: attemptView(r.attempt), payment: paymentView(r.payment) };
    },
  },
  capturePayment: {
    summary: 'Thu khoản tiền cổng đang giữ (authorize) của một payment; chỉ thu đủ số đã giữ',
    roles: BOTH,
    input: { type: 'object', required: ['paymentId'], properties: { paymentId: str } },
    output: { type: 'object', required: ['outcome', 'payment', 'attempt'], properties: { outcome: { ...str, enum: ['captured', 'unknown'], description: 'unknown = cổng mất phản hồi, có thể đã thu: Hub đối soát, xem lại sau (không thu lại ngay)' }, payment: { $ref: 'Payment' }, attempt: { $ref: 'Attempt' } } },
    errors: ['not_found', 'payment_not_open', 'invalid_state', 'not_supported', 'op_in_progress', 'capture_rejected', 'gateway_unavailable'],
    bindings: { http: { method: 'POST', path: '/payments/{paymentId}/capture', statuses: [200, 202], status: (r) => (r.outcome === 'captured' ? 200 : 202) } },
    async run({ hub, input, principal }) {
      if (principal.role === 'shop') own(principal, await hub.shopOf({ paymentId: input.paymentId }));
      const r = await hub.capturePayment({ paymentId: input.paymentId });
      return { outcome: r.outcome, payment: paymentView(r.payment), attempt: attemptView(r.attempt) };
    },
  },
  voidPayment: {
    summary: 'Nhả khoản tiền cổng đang giữ (void) của một payment',
    roles: BOTH,
    input: { type: 'object', required: ['paymentId'], properties: { paymentId: str, attemptId: { ...str, description: 'Chỉ cần khi nhiều attempt cùng giữ tiền' } } },
    output: { type: 'object', required: ['outcome', 'payment', 'attempt'], properties: { outcome: { ...str, enum: ['voided', 'unknown'], description: 'unknown = cổng mất phản hồi, có thể đã nhả: Hub đối soát' }, payment: { $ref: 'Payment' }, attempt: { $ref: 'Attempt' } } },
    errors: ['not_found', 'invalid_state', 'not_supported', 'op_in_progress', 'void_rejected', 'gateway_unavailable'],
    bindings: { http: { method: 'POST', path: '/payments/{paymentId}/void', statuses: [200, 202], status: (r) => (r.outcome === 'voided' ? 200 : 202) } },
    async run({ hub, input, principal }) {
      if (principal.role === 'shop') own(principal, await hub.shopOf({ paymentId: input.paymentId }));
      const r = await hub.voidPayment({ paymentId: input.paymentId, attemptId: input.attemptId });
      return { outcome: r.outcome, payment: paymentView(r.payment), attempt: attemptView(r.attempt) };
    },
  },
  createRefund: {
    summary: 'Yêu cầu hoàn tiền một attempt đã nhận tiền',
    roles: BOTH,
    input: { type: 'object', required: ['attemptId'], properties: { attemptId: str, amount: { ...int, minimum: 1, description: 'Bỏ trống = hoàn phần còn lại' }, reason: str, force: { ...bool, description: 'Chỉ quản trị: hoàn khoản nằm trong cảnh báo mà cổng chưa xác nhận tiền đã về' } } },
    output: { $ref: 'Refund' },
    errors: ['not_found', 'nothing_to_refund', 'refund_limit', 'invalid_refund_amount', 'not_confirmed', 'forbidden'],
    bindings: { http: { method: 'POST', path: '/refunds', statuses: [201] } },
    async run({ hub, input, principal }) {
      if (principal.role === 'shop') own(principal, await hub.shopOf({ attemptId: input.attemptId }));
      if (input.force && principal.role !== 'admin') throw new AppError('forbidden', 'chỉ quản trị được ép hoàn khoản chưa được cổng xác nhận');
      return refundView(await hub.refund({ attemptId: input.attemptId, amount: input.amount, reason: input.reason, force: !!input.force }));
    },
  },
  markRefundDone: {
    summary: 'Xác nhận hoàn tiền thủ công đã làm xong',
    roles: ADMIN,
    input: { type: 'object', required: ['refundId'], properties: { refundId: str } },
    output: { $ref: 'Refund' },
    errors: ['not_found', 'invalid_state'],
    bindings: { http: { method: 'POST', path: '/refunds/{refundId}/done', statuses: [200] } },
    async run({ hub, input }) { return refundView(await hub.markRefundDone(input.refundId)); },
  },
  listAnomalies: {
    summary: 'Danh sách tiền bất thường',
    roles: ADMIN,
    input: { type: 'object', properties: { type: str, status: str } },
    output: { type: 'object', required: ['anomalies'], properties: { anomalies: { type: 'array', items: { $ref: 'Anomaly' } } } },
    errors: [],
    bindings: { http: { method: 'GET', path: '/anomalies', statuses: [200] } },
    async run({ hub, input }) { return { anomalies: (await hub.findAnomalies({ type: input.type || undefined, status: input.status || undefined })).map(anomalyView) }; },
  },
  resolveAnomaly: {
    summary: 'Phân xử một anomaly (hoàn tiền, áp vào payment, hoặc bỏ qua)',
    roles: ADMIN,
    input: { type: 'object', required: ['anomalyId', 'action'], properties: { anomalyId: str, action: { ...str, description: 'refund | apply | ignore' }, note: str, force: bool } },
    output: { $ref: 'Anomaly' },
    errors: ['not_found', 'invalid_state', 'not_confirmed', 'invalid_input'],
    bindings: { http: { method: 'POST', path: '/anomalies/{anomalyId}/resolve', statuses: [200] } },
    async run({ hub, input }) { return anomalyView(await hub.resolveAnomaly(input.anomalyId, { action: input.action, note: input.note, force: input.force === true })); },
  },
  reconcile: {
    summary: 'Chạy đối soát ngay',
    roles: ADMIN,
    input: { type: 'object', properties: {} },
    output: { type: 'object' },
    errors: [],
    bindings: { http: { method: 'POST', path: '/reconcile', statuses: [200] } },
    async run({ hub }) { return hub.reconcile(); },
  },
  listGateways: {
    summary: 'Tình trạng từng cổng (breaker, số lời gọi đang chạy)',
    roles: ADMIN,
    input: { type: 'object', properties: {} },
    output: { type: 'object', required: ['gateways'], properties: { gateways: { type: 'array', items: { type: 'object' } } } },
    errors: [],
    bindings: { http: { method: 'GET', path: '/gateways', statuses: [200] } },
    async run({ hub }) { return { gateways: hub.gatewayStatus() }; },
  },
  listCalls: {
    summary: 'Nhật ký lời gọi tới cổng',
    roles: ADMIN,
    input: { type: 'object', properties: { gateway: str, ref: str, limit: { ...int, description: 'Tối đa 1000, mặc định 100' } } },
    output: { type: 'object', required: ['calls'], properties: { calls: { type: 'array', items: { type: 'object' } } } },
    errors: [],
    bindings: { http: { method: 'GET', path: '/calls', statuses: [200] } },
    async run({ hub, input }) { return { calls: await hub.listCalls({ gateway: input.gateway || undefined, ref: input.ref || undefined, limit: limitOf(input.limit) }) }; },
  },
  listWebhooks: {
    summary: 'Danh sách bản giao sự kiện ra ngoài (mọi tuyến: webhook, kafka...)',
    roles: BOTH,
    input: { type: 'object', properties: { status: { ...str, enum: ['pending', 'delivered', 'dead'] }, limit: { ...int, description: 'Tối đa 1000, mặc định 100' }, shopId: str } },
    output: { type: 'object', required: ['webhooks'], properties: { webhooks: { type: 'array', items: { $ref: 'Delivery' } } } },
    errors: [],
    bindings: { http: { method: 'GET', path: '/webhooks', statuses: [200] } },
    async run({ hub, input, principal }) {
      const shopId = principal.role === 'shop' ? principal.id : (input.shopId || undefined);
      return { webhooks: (await hub.listWebhooks({ status: input.status || undefined, limit: limitOf(input.limit), shopId })).map(deliveryView) };
    },
  },
  retryWebhook: {
    summary: 'Gửi lại thủ công một bản giao đã dead hoặc đang chờ',
    roles: BOTH,
    input: { type: 'object', required: ['webhookId'], properties: { webhookId: str } },
    output: { $ref: 'Delivery' },
    errors: ['not_found', 'invalid_state'],
    bindings: { http: { method: 'POST', path: '/webhooks/{webhookId}/retry', statuses: [200] } },
    async run({ hub, input, principal }) {
      if (principal.role === 'shop') own(principal, await hub.webhookShop(input.webhookId));
      return deliveryView(await hub.retryWebhook(input.webhookId));
    },
  },
};

module.exports = { operations, SHOP_ID };

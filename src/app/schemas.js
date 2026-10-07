'use strict';
// spec: PHUB-S-017
// spec: PHUB-S-020
// spec: PHUB-S-035
// spec: PHUB-S-029
// Schema đặt tên dùng chung (PHUB-D-017): đối tượng trả ra, phong bì sự kiện, dữ liệu từng loại sự kiện, phong bì lệnh.
// Là nguồn sự thật cho kiểm đầu vào/đầu ra, test hợp đồng và OpenAPI. Trường có thể vắng trong JSON không nằm trong required.

const str = { type: 'string' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const nstr = { type: ['string', 'null'] };
const nint = { type: ['integer', 'null'] };
const obj = { type: 'object' };
const nobj = { type: ['object', 'null'] };
const ref = (name) => ({ $ref: name });
const arr = (items) => ({ type: 'array', items });

const schemas = {
  Error: { type: 'object', required: ['error'], properties: { error: { ...str, description: 'Mã lỗi ổn định' }, message: str } },
  Payment: {
    type: 'object', required: ['id', 'shopId', 'orderId', 'amount', 'status'],
    properties: { id: str, shopId: str, orderId: str, amount: int, currency: str, status: { ...str, enum: ['OPEN', 'PAID', 'CLOSED'] }, product: str, method: { ...nstr, description: 'Phương án thanh toán chuẩn khách hàng đã yêu cầu (null = cổng nào cũng được)' }, createdAt: int, expiresAt: int, paidAt: nint, paidByAttempt: nstr },
  },
  Attempt: {
    type: 'object', required: ['id', 'gateway', 'status', 'amount'],
    properties: {
      id: str, ref: str, gateway: str, product: str, status: str, amount: int,
      url: { ...nstr, description: 'Địa chỉ để đưa khách đi thanh toán (cổng chuyển hướng)' },
      method: { ...str, enum: ['GET', 'POST'] },
      fields: { ...nobj, description: 'Trường form khi method là POST' },
      instructions: { ...nobj, description: 'Hướng dẫn chuyển khoản (cổng kiểu chuyển khoản)' },
      createdAt: int, expiresAt: nint, gatewayTxnId: nstr, failReason: nstr,
      failCode: { ...nstr, description: 'Lý do thất bại chuẩn: user_cancelled, expired, insufficient_funds, declined, gateway_error, invalid_request, unknown (null khi chưa thất bại hoặc do Hub tự hủy)' },
      gatewayCode: { ...nstr, description: 'Mã gốc của cổng, chỉ để tra cứu' },
      receivedTotal: int, needsOperator: bool,
      nextAction: { ...nobj, description: 'Bước tiếp theo dạng chuẩn: {type: redirect|post_redirect|challenge|poll|qr|deeplink|transfer, ...}; null khi không có. Thêm cạnh url, method, fields, instructions (cửa hàng cũ vẫn dùng được các trường đó)' },
    },
  },
  Refund: { type: 'object', required: ['id', 'attemptId', 'amount', 'status'], properties: { id: str, ref: str, attemptId: str, paymentId: str, amount: int, status: str, reason: nstr, createdAt: int } },
  Anomaly: {
    type: 'object', required: ['id', 'type', 'status'],
    properties: { id: str, type: str, status: str, paymentId: nstr, attemptId: nstr, gateway: nstr, amount: nint, gatewayTxnId: nstr, arbiter: { ...nobj, description: 'Kết quả hỏi cổng: {verdict, at}' }, at: int, detail: { type: ['string', 'object', 'null'] }, refundId: nstr },
  },
  PaymentDetail: {
    type: 'object', required: ['payment', 'attempts', 'refunds', 'anomalies'],
    properties: { payment: ref('Payment'), attempts: arr(ref('Attempt')), refunds: arr(ref('Refund')), anomalies: arr(ref('Anomaly')) },
  },
  CreatePaymentResult: {
    type: 'object', required: ['existing', 'payment', 'attempts'],
    properties: { existing: { ...bool, description: 'true khi đơn đã có payment chưa đóng (gọi lại idempotent)' }, payment: ref('Payment'), attempts: arr(ref('Attempt')), refunds: arr(ref('Refund')), anomalies: arr(ref('Anomaly')), attempt: { oneOf: [ref('Attempt'), { type: 'null' }] } },
  },
  Delivery: {
    type: 'object', required: ['id', 'type', 'status', 'route', 'sink'],
    properties: { id: str, shopId: str, type: str, objectId: str, route: str, sink: str, status: { ...str, enum: ['pending', 'delivered', 'dead'] }, attempts: int, nextAt: nint, createdAt: int, deliveredAt: nint, lastStatus: nint, lastError: nstr },
  },

  // ----- sự kiện đi ra (cổng ra chuẩn) -----
  Event: {
    type: 'object', required: ['id', 'type', 'createdAt', 'key', 'data'],
    properties: {
      id: { ...str, description: 'Định danh ổn định của sự kiện; người nhận loại trùng theo trường này (giao ít nhất một lần)' },
      type: str, createdAt: { ...int, description: 'Mili giây từ epoch' }, shopId: str,
      key: { ...str, description: 'Khóa thứ tự: các sự kiện cùng key đến đúng thứ tự tạo ở đích có thứ tự (Kafka dùng làm khóa phân vùng)' },
      data: obj,
    },
  },
  PaymentPaidData: { type: 'object', required: ['paymentId', 'orderId', 'amount'], properties: { paymentId: str, orderId: str, amount: int, currency: str, status: str, paidAt: nint, attemptId: str, gateway: str, gatewayTxnId: nstr } },
  PaymentClosedData: { type: 'object', required: ['paymentId', 'orderId'], properties: { paymentId: str, orderId: str, amount: int, status: str } },
  RefundUpdatedData: { type: 'object', required: ['refundId', 'paymentId', 'status'], properties: { refundId: str, paymentId: str, attemptId: str, amount: int, status: { ...str, enum: ['SUCCEEDED', 'FAILED', 'MANUAL_REQUIRED'] } } },
  AnomalyOpenedData: { type: 'object', required: ['anomalyId', 'type'], properties: { anomalyId: str, type: str, paymentId: nstr, attemptId: nstr, gateway: nstr, amount: nint, gatewayTxnId: nstr } },
  CommandCompletedData: { type: 'object', required: ['commandId', 'op', 'result'], properties: { commandId: str, op: str, result: { description: 'Kết quả đúng như phản hồi HTTP tương ứng' } } },
  CommandFailedData: { type: 'object', required: ['commandId', 'op', 'error'], properties: { commandId: str, op: str, error: str, message: str } },

  // ----- lệnh đi vào qua broker -----
  Command: {
    type: 'object', required: ['commandId', 'op'],
    properties: {
      commandId: { ...str, minLength: 1, description: 'Do bên gửi tạo; hiệu ứng đúng một lần theo mã này' },
      op: { ...str, description: 'Tên thao tác trong danh mục (xem các đường dẫn của OpenAPI, operationId)' },
      input: { ...obj, description: 'Đầu vào của thao tác, cùng schema với thân/query HTTP' },
      shopId: { ...str, description: 'Chỉ có tác dụng khi nguồn vào cấu hình principal quản trị tin cậy' },
    },
  },
};

// Loại sự kiện: schema dữ liệu và mô tả. Thêm loại mới = thêm một dòng ở đây và gọi events.emit ở lõi.
const eventTypes = {
  'payment.paid': { data: 'PaymentPaidData', summary: 'Một payment đã nhận đủ tiền' },
  'payment.closed': { data: 'PaymentClosedData', summary: 'Payment hết hạn hoặc đóng mà chưa nhận tiền' },
  'refund.updated': { data: 'RefundUpdatedData', summary: 'Hoàn tiền đạt trạng thái cuối (thành công, thất bại, cần xử lý tay)' },
  'anomaly.opened': { data: 'AnomalyOpenedData', summary: 'Có tiền bất thường cần xem (tiền về muộn, trùng, sai số...)' },
  'command.completed': { data: 'CommandCompletedData', summary: 'Lệnh nhận qua broker đã thực hiện xong' },
  'command.failed': { data: 'CommandFailedData', summary: 'Lệnh nhận qua broker bị từ chối với lỗi nghiệp vụ' },
};

module.exports = { schemas, eventTypes };

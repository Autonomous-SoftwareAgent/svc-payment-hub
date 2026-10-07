'use strict';
// spec: PHUB-S-038
// spec: PHUB-S-037
// spec: PHUB-S-017
// Các PORT của lớp kết nối dịch vụ (PHUB-D-017), khai báo thành kiểu thật như contract.js làm cho adapter cổng thanh toán.
// Lõi và connector chỉ phụ thuộc vào các kiểu này, không phụ thuộc nhau:
//   - Sink (cổng ra): cài đặt ở src/connectors/out/*.js, được events.js gọi qua sink.deliver(...)
//   - InboundConnector (cổng vào chạy nền): cài đặt ở src/connectors/in/*.js, do main.js khởi động
//   - HubPort: phần PaymentHub mà src/app/ dùng (app không import hub.js nên khai kiểu ở đây)
// Chú thích @implements ở từng connector trỏ về các kiểu này để công cụ và người đọc lần được từ lời gọi tới cài đặt.

/**
 * Một bản giao đã chuẩn hóa mà hộp thư đi đưa cho sink.
 * @typedef {Object} Delivery
 * @property {string} id         mã bản giao (eventId, hoặc eventId~tuyến)
 * @property {string} eventId    mã sự kiện, ổn định: người nhận loại trùng theo mã này
 * @property {string} type       loại sự kiện, ví dụ 'payment.paid'
 * @property {string} [shopId]
 * @property {string} key        khóa thứ tự (paymentId hoặc commandId)
 * @property {string} body       phong bì sự kiện đã tuần tự hóa JSON: {id, type, createdAt, shopId, key, data}
 * @property {number} attempts   số lần đã thử
 * @property {number} createdAt
 */

/**
 * Cấu hình một tuyến ra (connectors.out[i] hoặc endpoint webhook ngầm), đã gộp tùy chọn chung.
 * @typedef {Object} Route
 * @property {string} [id]
 * @property {string} [sink]
 * @property {number} timeoutMs
 * @property {number} maxAttempts
 * @property {number[]} backoffSeconds
 * @property {string} [url]      sink webhook
 * @property {string} [secret]   sink webhook
 * @property {string} [topic]    sink kafka
 */

/**
 * Cổng ra. Giao ít nhất một lần: ném lỗi nếu không giao được (Hub thử lại theo bậc), trả về khi đã giao.
 * @typedef {Object} Sink
 * @property {string} kind
 * @property {boolean} ordered    true: bản giao cùng (tuyến, key) đi đúng thứ tự tạo
 * @property {(route: Route, name: string) => void} validate   ném lỗi khi cấu hình tuyến sai (Hub không khởi động)
 * @property {(delivery: Delivery, route: Route, ctx: {now: () => number}) => Promise<{status?: number}>} deliver
 * @property {() => Promise<void>} [close]
 */

/**
 * Mô-đun connector ra: tệp trong src/connectors/out xuất đúng dạng này.
 * @typedef {Object} OutboundModule
 * @property {string} kind
 * @property {(deps: Object) => Sink} create
 */

/**
 * Nguồn vào chạy nền (ví dụ nhận lệnh từ Kafka). handle() là lõi kiểm thử được.
 * @typedef {Object} InboundConnector
 * @property {string} kind
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(message: Object) => Promise<void>} [handle]
 */

/**
 * Mô-đun connector vào: tệp trong src/connectors/in xuất đúng dạng này.
 * @typedef {Object} InboundModule
 * @property {string} kind
 * @property {(o: {app: import('./app').App, config: Object, deps: Object, log?: Function}) => (InboundConnector|Object)} create
 */

/**
 * Phần PaymentHub mà src/app/ dùng. Cài đặt: src/hub.js (PaymentHub). Kiểm hình dạng ở assertHubPort.
 * @typedef {Object} HubPort
 * @property {{emit: (type: string, objectId: string, version: string|number, data: Object, shopId?: string, opts?: {key?: string}) => (Object|null)}} events
 * @property {Object} store
 * @property {<T>(fn: () => Promise<T>) => Promise<T>} transact
 * @property {(input: Object) => Promise<Object>} createPayment
 * @property {(paymentId: string, o?: Object) => Promise<Object>} createAttempt
 * @property {(o: {attemptId: string, amount?: number, reason?: string, force?: boolean}) => Promise<Object>} refund
 * @property {(o: {paymentId: string}) => Promise<Object>} capturePayment
 * @property {(o: {paymentId: string, attemptId?: string}) => Promise<Object>} voidPayment
 * @property {(id: string) => Promise<Object>} markRefundDone
 * @property {(id: string, o: Object) => Promise<Object>} resolveAnomaly
 * @property {(id: string) => Promise<Object|undefined>} loadPayment
 * @property {(filter?: Object) => Promise<Object[]>} findAnomalies
 * @property {() => Promise<Object>} reconcile
 * @property {() => Object[]} gatewayStatus
 * @property {(filter?: Object) => Promise<Object[]>} listCalls
 * @property {(filter?: Object) => Promise<Object[]>} listWebhooks
 * @property {(id: string) => Promise<Object>} retryWebhook
 * @property {(id: string) => Promise<string|undefined>} webhookShop
 * @property {(o: {paymentId?: string, attemptId?: string, refundId?: string}) => Promise<string|undefined>} shopOf
 */

const SINK_FUNCS = ['validate', 'deliver'];
const HUB_FUNCS = ['transact', 'createPayment', 'createAttempt', 'refund', 'capturePayment', 'voidPayment', 'markRefundDone', 'resolveAnomaly', 'loadPayment', 'findAnomalies', 'reconcile', 'gatewayStatus', 'listCalls', 'listWebhooks', 'retryWebhook', 'webhookShop', 'shopOf'];

/** Kiểm một sink có đủ hình dạng của port Sink (lỗi cấu hình/cài đặt phải dừng khi khởi động, không lộ lúc có sự kiện). */
function assertSink(sink, name = 'sink') {
  if (!sink || typeof sink !== 'object') throw new Error(`${name}: sink rỗng`);
  if (typeof sink.kind !== 'string' || !sink.kind) throw new Error(`${name}: sink thiếu kind`);
  if (typeof sink.ordered !== 'boolean') throw new Error(`${name} (${sink.kind}): sink thiếu ordered (true/false)`);
  for (const f of SINK_FUNCS) if (typeof sink[f] !== 'function') throw new Error(`${name} (${sink.kind}): sink thiếu hàm ${f}`);
  return true;
}

/** Kiểm đối tượng có đủ hình dạng của HubPort (app.createApp gọi khi có hub; getHub thì kiểm lần đầu dùng). */
function assertHubPort(hub) {
  if (!hub || typeof hub !== 'object') throw new Error('HubPort: hub rỗng');
  if (!hub.events || typeof hub.events.emit !== 'function') throw new Error('HubPort: thiếu events.emit');
  if (!hub.store || typeof hub.store !== 'object') throw new Error('HubPort: thiếu store');
  for (const f of HUB_FUNCS) if (typeof hub[f] !== 'function') throw new Error(`HubPort: thiếu hàm ${f}`);
  return true;
}

/** Kiểm nguồn vào đã dựng. */
function assertInbound(c, name = 'inbound') {
  if (!c || typeof c !== 'object') throw new Error(`${name}: connector vào rỗng`);
  for (const f of ['start', 'stop']) if (typeof c[f] !== 'function') throw new Error(`${name}: connector vào thiếu hàm ${f}`);
  return true;
}

module.exports = { assertSink, assertHubPort, assertInbound, SINK_FUNCS, HUB_FUNCS };

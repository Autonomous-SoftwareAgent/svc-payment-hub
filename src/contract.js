'use strict';
// spec: PHUB-S-001
// spec: PHUB-S-003
// spec: PHUB-S-005
// spec: PHUB-S-018
// spec: PHUB-S-020
// spec: PHUB-S-025
// spec: PHUB-S-029
// spec: PHUB-S-033
// spec: PHUB-S-035
// spec: PHUB-S-036
// spec: STRP-S-002
// spec: PHUB-S-037
// Hợp đồng giữa lõi Hub và adapter cổng thanh toán (xem docs/modules/payment-hub, PHUB-D-005).
// Lõi chỉ thấy các kiểu dưới đây; mọi chi tiết riêng của cổng nằm trong adapter.

/**
 * @typedef {'succeeded'|'failed'|'cancelled'|'expired'|'pending'|'received'|'reversed'|'authorized'|'dispute_opened'|'dispute_won'|'dispute_lost'} EventType
 * 'authorized' = cổng đã GIỮ tiền cho attempt nhưng chưa thu (PHUB-D-037); amount là số tiền giữ (phải bằng amount của attempt), gatewayTxnId bắt buộc.
 *   Attempt thành AUTHORIZED, đơn vẫn OPEN. Thu bằng adapter.capture, nhả bằng adapter.void. Với attempt đang AUTHORIZED, 'failed'|'cancelled'|'expired'
 *   nghĩa là khoản giữ ĐÃ được giải phóng (chắc chắn): adapter không được phát 'failed' chỉ vì một lần thu thất bại mà khoản giữ vẫn còn.
 * 'dispute_opened'|'dispute_won'|'dispute_lost' = tranh chấp (chargeback) mở, thắng, thua; amount là phần tiền bị tranh chấp, gatewayTxnId bắt buộc và PHUB ổn định
 *   giữa các kênh (cùng một tranh chấp ra cùng mã). Giống 'reversed': Hub KHÔNG đổi trạng thái đơn hay attempt, chỉ ghi anomaly cùng tên cho người vận hành (PHUB-D-036).
 * 'reversed' = tiền đã được cổng trả lại cho người trả (void, hoàn từ phía cổng, chargeback); amount là phần bị đảo.
 *   gatewayTxnId bắt buộc và PHẢI ổn định: cùng một lần đảo phải ra cùng mã ở mọi kênh (IPN, truy vấn, sao kê), vì Hub cộng dồn
 *   phần bị đảo theo (attempt, mã, số tiền); mã khác nhau giữa các kênh sẽ bị tính hai lần. Hub không tự đổi trạng thái,
 *   chỉ ghi anomaly funds_reversed cho người vận hành (PHUB-D-018).
 * 'received' = một khoản tiền nhận được (kiểu chuyển khoản: một attempt có thể nhận nhiều khoản, thiếu/đủ/thừa);
 *   amount là riêng khoản đó, gatewayTxnId bắt buộc. Hub tự gom các khoản thành trạng thái attempt.
 * @typedef {'ipn'|'return'|'query'} EventSource
 *
 * @typedef {'wallet'|'qr'|'bank_transfer'|'virtual_account'|'card_domestic'|'card_international'} Method
 * Phương án thanh toán CHUẨN (PHUB-D-029): wallet = ví điện tử; qr = quét mã QR; bank_transfer = chuyển khoản theo nội dung;
 *   virtual_account = tài khoản ảo theo đơn; card_domestic = thẻ nội địa (ATM); card_international = thẻ quốc tế.
 *   Cửa hàng yêu cầu một phương án (createPayment.method), routing chỉ chọn cổng phục vụ phương án đó; không nói gì thì cổng nào cũng được.
 *
 * @typedef {'user_cancelled'|'expired'|'insufficient_funds'|'declined'|'gateway_error'|'invalid_request'|'authentication_required'|'fraud'|'rate_limited'|'unknown'} FailCode
 * Lý do thất bại CHUẨN (PHUB-D-020). Adapter dịch mã riêng của cổng sang mã này; lõi và routing chỉ đọc mã chuẩn.
 *   user_cancelled = khách hủy; expired = hết hạn chờ; insufficient_funds = thiếu tiền; declined = ngân hàng/phát hành từ chối
 *   (sai OTP, thẻ khóa, quá hạn mức, nghi ngờ gian lận...); gateway_error = cổng hoặc ngân hàng lỗi/bảo trì;
 *   invalid_request = yêu cầu của ta bị từ chối vì cấu hình hoặc dữ liệu (số tiền ngoài khoảng, sai merchant);
 *   authentication_required = cần khách xác thực thêm (3DS, OTP) mà luồng này không làm được; fraud = cổng hoặc ngân hàng nghi gian lận;
 *   rate_limited = cổng giới hạn tần suất gọi của ta (thử lại sau được); unknown = chưa biết.
 *   Mã chưa có trong bảng PHẢI là 'unknown' (mặc định an toàn), không bao giờ đoán.
 *
 * @typedef {Object} CanonicalEvent
 * @property {string} gateway          id adapter
 * @property {string|null} attemptRef  mã tham chiếu attempt do Hub sinh; null khi không gắn được (kèm unmatched=true)
 * @property {boolean} [unmatched]     tiền vào mà không xác định được attempt (Hub ghi anomaly unmatched_funds)
 * @property {string} [content]        nội dung gốc (ví dụ nội dung chuyển khoản), chỉ để đối chiếu thủ công
 * @property {EventType} type
 * @property {FailCode} [failCode]      chỉ cho failed|cancelled|expired; vắng = unknown
 * @property {string} [gatewayCode]    mã gốc của cổng (để tra cứu), chỉ để hiển thị
 * @property {number} [amount]         số nguyên theo ĐƠN VỊ NHỎ NHẤT của `currency` (VND: đồng; USD: cent; JPY: yên) đã bỏ hệ số của cổng; bắt buộc trừ sự kiện pending
 * @property {string} [currency]       ISO 4217; vắng = VND (bốn adapter hiện có). Có và khác tiền của payment thì Hub coi là amount_mismatch
 * @property {string} [gatewayTxnId]   mã giao dịch phía cổng (có khi thành công)
 * @property {number} occurredAt       ms epoch
 * @property {EventSource} source      'return' chỉ để hiển thị, Hub không đổi trạng thái
 * @property {Object} [raw]
 *
 * @typedef {Object} Capabilities
 * @property {{minutes:number}|'gateway-fixed'|'unknown'|'none'} hardExpiry   'none' = cổng không bao giờ đóng (tiền về bất cứ lúc nào)
 * @property {boolean} cancellable
 * @property {boolean} queryable
 * @property {'api'|'manual'|'none'} refundable
 * @property {boolean} refundAsync
 * @property {boolean} createCanTimeout   thao tác tạo là gọi mạng, có thể mất phản hồi
 * @property {Method[]} [methods]       phương án thanh toán chuẩn mà (cổng, sản phẩm) này phục vụ; vắng hoặc rỗng = không khai (chỉ nhận payment không đòi phương án). Operator ghi đè bằng hub.gateways[].methods.
 * @property {{prefix?:string, maxLength?:number, caseInsensitive?:boolean}} [referenceFormat]  ràng buộc định dạng attemptRef (khi mã phải nằm trong nội dung chuyển khoản)
 * @property {string[]} [currencies]    loại tiền ISO 4217 (contract.CURRENCY_EXPONENT) mà (cổng, sản phẩm) này nhận; VẮNG = chỉ VND (an toàn: không bao giờ đoán một cổng nhận tiền lạ). Operator ghi đè bằng hub.gateways[].currencies.
 * @property {string[]} [regions]       nước (ISO 3166-1 alpha-2, hoặc '*') cổng phục vụ; chỉ KHAI BÁO để tài liệu và routing sau này dùng, Hub chưa lọc theo nó
 * @property {Operation[]} [operations] thao tác chuẩn cổng hỗ trợ (contract.OPERATIONS); vắng = chưa khai
 * @property {boolean} [partialRefund]  hoàn một phần được
 * @property {boolean} [partialCapture] thu một phần được (sau authorize)
 * @property {boolean} [threeDs]        có bước xác thực 3DS (thông tin cho vận hành; luồng xử lý do adapter trả NextAction sau này)
 * @property {Object<string,'string'|'number'|'boolean'>} [extraSchema]  các khóa extra adapter nhận và kiểu của từng khóa; vắng = adapter không nhận extra nào. Khóa lạ hoặc sai kiểu bị Hub từ chối lúc tạo payment (không bỏ qua im lặng)
 * @property {{min?:number, max?:number}} [amountLimits]  giới hạn số tiền (đơn vị nhỏ nhất) cổng chấp nhận
 * @typedef {'purchase'|'authorize'|'capture'|'void'|'refund'|'inquire'} Operation
 *
 * @typedef {'ok'|'duplicate'|'unknown_attempt'|'amount_mismatch'|'invalid_signature'|'error'} AckOutcome
 * @typedef {{status:number, body:string, contentType:string}} AckResponse
 *
 * @typedef {Object} CallbackRequest
 * @property {'ipn'|'return'} channel
 * @property {string} method
 * @property {Object<string,string>} query
 * @property {*} body      đã parse nếu JSON, nếu không là chuỗi thô
 * @property {string} [rawBody]   thân request nguyên văn (cần cho chữ ký HMAC trên body thô)
 * @property {Object<string,string>} headers   khóa viết thường
 *
 * @typedef {Object} CallbackResult
 * @property {boolean} valid               chữ ký hợp lệ
 * @property {string} [reason]             lý do khi valid=false (chỉ để log)
 * @property {CanonicalEvent} [event]      có khi valid và thông báo mang tin về tiền; vắng khi hợp lệ nhưng cần bỏ qua (ví dụ tiền ra)
 * @property {boolean} [retryLater]       hợp lệ nhưng chưa gắn được sự kiện vì lỗi tra cứu tạm thời: Hub không đổi gì, trả ack('error') để cổng gửi lại
 * @property {(outcome:AckOutcome)=>AckResponse} ack
 *
 * @typedef {Object} CreateParams
 * @property {string} attemptRef
 * @property {number} amount
 * @property {string} [currency]
 * @property {string} orderInfo
 * @property {string} returnUrl
 * @property {string} [product]   'default' = Hub không chỉ định; adapter dùng sản phẩm mặc định trong config của nó
 * @property {string} [clientIp]
 * @property {number} [expiresAt]   ms epoch, hạn Hub mong muốn (adapter bỏ qua nếu cổng không hỗ trợ)
 * @property {Object<string,string|number|boolean>} [extra]  tham số RIÊNG của cổng này, đúng schema adapter khai ở capabilities.extraSchema; lõi chỉ chuyển tiếp, không bao giờ đọc giá trị (PHUB-D-016)
 *
 * @typedef {{bank:string, accountNumber:string, accountName?:string, transferContent?:string, amount:number, qrUrl?:string}} TransferInstructions  transferContent chỉ cần với kiểu chuyển khoản theo nội dung (tài khoản ảo theo đơn không cần)
 * @typedef {Object<string,*>} AdapterState  JSON thuần, tối đa STATE_MAX_BYTES, không chứa bí mật; Hub lưu trên attempt và trả lại cho query/refund/queryRefund/cancel
 * @typedef {{txn:string, amount:number, at?:number}} Receipt  một khoản thu của attempt
 * @typedef {{status:'captured', gatewayTxnId?:string}|{status:'rejected', reason:string, failCode?:FailCode}|{status:'unknown'}} CaptureResult
 *   captured = cổng xác nhận đã thu đủ; rejected = cổng CHẮC CHẮN không thu (khoản giữ vẫn còn hoặc đã hết); unknown = mất phản hồi, có thể đã thu (Hub không coi là thất bại, hỏi lại).
 * @typedef {{status:'voided'}|{status:'rejected', reason:string}|{status:'unknown'}} VoidResult
 * @typedef {'redirect'|'post_redirect'|'challenge'|'poll'|'qr'|'deeplink'|'transfer'} NextActionType
 * Bước khách (hoặc cửa hàng) phải làm tiếp để hoàn tất thanh toán, dạng DỮ LIỆU chuẩn (PHUB-D-035): redirect {url}; post_redirect {url, fields};
 *   challenge {url} (xác thực thêm, ví dụ 3DS); poll {afterSeconds?} (chờ rồi hỏi lại); qr {data|imageUrl}; deeplink {url} (mở ứng dụng); transfer {instructions}.
 * @typedef {{type:NextActionType, url?:string, fields?:Object<string,string>, afterSeconds?:number, data?:string, imageUrl?:string, instructions?:TransferInstructions}} NextAction
 * @typedef {{status:'next_action', nextAction:NextAction, expiresAt?:number, state?:AdapterState}|{status:'redirect', url:string, method?:'GET'|'POST', fields?:Object<string,string>, expiresAt?:number, state?:AdapterState}|{status:'instructions', instructions:TransferInstructions, expiresAt?:number, state?:AdapterState}|{status:'unknown'}|{status:'rejected', reason:string, failCode?:FailCode, gatewayCode?:string}} CreateResult
 * @typedef {{state:'not_found'|'unknown'}} QueryMiss
 * @typedef {'requested'|'processing'|'succeeded'|'failed'|'manual_required'} RefundStatus
 *
 * @typedef {Object} Adapter
 * @property {string} id
 * @property {(product?:string)=>Capabilities} capabilities
 * @property {(p:CreateParams)=>Promise<CreateResult>} createPayment
 * @property {(req:CallbackRequest)=>Promise<CallbackResult>|CallbackResult} parseCallback
 * @property {(p:{attemptRef:string, amount?:number, product?:string, createdAt?:number, state?:AdapterState})=>Promise<CanonicalEvent|CanonicalEvent[]|QueryMiss>} query
 * @property {(p:{cursor?:string, now:number})=>Promise<{events:CanonicalEvent[], nextCursor?:string}>} [reconcileFeed]  cho cổng không truy vấn được theo mã: kéo sao kê theo con trỏ, gồm cả tiền chưa rõ chủ
 * @property {(p:{attemptRef:string, refundRef:string, amount:number, currency:string, gatewayTxnId?:string, originalAmount?:number, createdAt?:number, state?:AdapterState, receipts?:Receipt[]})=>Promise<{status:RefundStatus}>} refund  receipts: các khoản thu của attempt (adapter chọn khoản gốc)
 * @property {(p:{refundRef:string, attemptRef:string, createdAt?:number, state?:AdapterState})=>Promise<{status:RefundStatus}>} queryRefund
 * @property {(p:{attemptRef:string, amount:number, currency:string, gatewayTxnId?:string, state?:AdapterState, idempotencyKey:string})=>Promise<CaptureResult>} [capture]  thu khoản đã giữ (bắt buộc khi capabilities.operations có 'capture'); idempotencyKey ổn định cho mỗi attempt
 * @property {(p:{attemptRef:string, amount:number, currency:string, gatewayTxnId?:string, state?:AdapterState, idempotencyKey:string})=>Promise<VoidResult>} [void]  nhả khoản đã giữ (bắt buộc khi capabilities.operations có 'void')
 * @property {(p:{attemptRef:string, state?:AdapterState})=>Promise<{cancelled:boolean}>} [cancel]
 * @property {(p:{attempts:Array<{attemptRef:string, product:string, state?:AdapterState, createdAt:number}>})=>number|void|Promise<number|void>} [adopt]  Hub gọi MỘT lần lúc khởi động với các attempt còn sống của cổng: nạp lại bộ nhớ đệm riêng từ state đã lưu, không gọi mạng (PHUB-D-025). Lỗi của adopt không làm Hub dừng.
 */

const DISPUTE_TYPES = ['dispute_opened', 'dispute_won', 'dispute_lost'];
const EVENT_TYPES = ['succeeded', 'failed', 'cancelled', 'expired', 'pending', 'received', 'reversed', 'authorized', ...DISPUTE_TYPES];
const NEXT_ACTION_TYPES = ['redirect', 'post_redirect', 'challenge', 'poll', 'qr', 'deeplink', 'transfer'];
const STATE_MAX_BYTES = 2048;
const FAIL_CODES = ['user_cancelled', 'expired', 'insufficient_funds', 'declined', 'gateway_error', 'invalid_request', 'authentication_required', 'fraud', 'rate_limited', 'unknown'];
// Mã mà thử lại cùng cổng sau một lúc có thể thành công (hạ tầng hoặc giới hạn tần suất). Chỉ là thông tin cho chính sách; Hub không tự thử lại theo nó.
const RETRIABLE_FAIL_CODES = ['gateway_error', 'rate_limited'];
const isRetriable = (failCode) => RETRIABLE_FAIL_CODES.includes(failCode);
// ISO 4217: số chữ số thập phân của từng loại tiền = số mũ của đơn vị nhỏ nhất. Loại tiền ngoài bảng bị từ chối (không mặc định 2 chữ số).
const CURRENCY_EXPONENT = Object.freeze({
  VND: 0, JPY: 0, KRW: 0, CLP: 0, ISK: 0, PYG: 0, UGX: 0, MGA: 0, RWF: 0, XAF: 0, XOF: 0, XPF: 0, BIF: 0, DJF: 0, GNF: 0, KMF: 0, VUV: 0,
  USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, NZD: 2, SGD: 2, HKD: 2, CNY: 2, CHF: 2, THB: 2, MYR: 2, IDR: 2, PHP: 2, INR: 2, TWD: 2, AED: 2, SAR: 2, SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, BRL: 2, MXN: 2, ZAR: 2, TRY: 2,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, LYD: 3, IQD: 3,
});
const EXTRA_TYPES = ['string', 'number', 'boolean'];
/** Kiểm extra của một cổng theo extraSchema của adapter. Trả chuỗi lỗi hoặc null. Khóa lạ và sai kiểu đều là lỗi. */
function checkExtra(extra, schema) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return 'phải là đối tượng {khóa: giá trị}';
  const s = schema || {};
  for (const [k, v] of Object.entries(extra)) {
    if (!Object.prototype.hasOwnProperty.call(s, k)) return `khóa "${k}" không nằm trong extraSchema của cổng này`;
    if (typeof v !== s[k] || (s[k] === 'number' && !Number.isFinite(v))) return `khóa "${k}" phải là ${s[k]}`;
  }
  return null;
}
const OPERATIONS = ['purchase', 'authorize', 'capture', 'void', 'refund', 'inquire'];
const EVENT_SOURCES = ['ipn', 'return', 'query'];
const ACK_OUTCOMES = ['ok', 'duplicate', 'unknown_attempt', 'amount_mismatch', 'invalid_signature', 'error'];
const ADAPTER_FUNCS = ['capabilities', 'createPayment', 'parseCallback', 'query', 'refund', 'queryRefund'];
const CAP_KEYS = ['hardExpiry', 'cancellable', 'queryable', 'refundable', 'refundAsync', 'createCanTimeout'];
const METHODS = ['wallet', 'qr', 'bank_transfer', 'virtual_account', 'card_domestic', 'card_international'];

function assertAdapterShape(a) {
  if (!a || typeof a.id !== 'string' || !a.id) throw new Error('adapter thiếu id');
  for (const f of ADAPTER_FUNCS) if (typeof a[f] !== 'function') throw new Error(`adapter ${a.id} thiếu hàm ${f}`);
  const caps = a.capabilities();
  for (const k of CAP_KEYS) if (!(k in caps)) throw new Error(`adapter ${a.id}: capabilities thiếu ${k}`);
  if (caps.methods !== undefined && (!Array.isArray(caps.methods) || caps.methods.some((m) => !METHODS.includes(m)))) throw new Error(`adapter ${a.id}: capabilities.methods phải là danh sách trong: ${METHODS.join(', ')}`);
  const list = (k, allowed, what) => {
    if (caps[k] === undefined) return;
    if (!Array.isArray(caps[k]) || caps[k].some((x) => !allowed(x))) throw new Error(`adapter ${a.id}: capabilities.${k} phải là danh sách ${what}`);
  };
  list('currencies', (c) => Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, c), `loại tiền trong: ${Object.keys(CURRENCY_EXPONENT).join(', ')}`);
  list('regions', (r) => r === '*' || /^[A-Z]{2}$/.test(r), "nước ISO 3166-1 alpha-2 (ví dụ 'VN') hoặc '*'");
  list('operations', (o) => OPERATIONS.includes(o), `thao tác trong: ${OPERATIONS.join(', ')}`);
  if (caps.extraSchema !== undefined) {
    const s = caps.extraSchema;
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.values(s).some((t) => !EXTRA_TYPES.includes(t))) throw new Error(`adapter ${a.id}: capabilities.extraSchema phải là {khóa: ${EXTRA_TYPES.join('|')}}`);
  }
  for (const op of ['capture', 'void']) {
    if (Array.isArray(caps.operations) && caps.operations.includes(op) && typeof a[op] !== 'function') throw new Error(`adapter ${a.id}: khai operations có ${op} nhưng thiếu hàm ${op}`);
  }
  for (const k of ['partialRefund', 'partialCapture', 'threeDs']) if (caps[k] !== undefined && typeof caps[k] !== 'boolean') throw new Error(`adapter ${a.id}: capabilities.${k} phải là true hoặc false`);
  if (caps.amountLimits !== undefined) {
    const l = caps.amountLimits;
    if (!l || typeof l !== 'object' || Array.isArray(l) || ['min', 'max'].some((k) => l[k] !== undefined && !Number.isSafeInteger(l[k]))) throw new Error(`adapter ${a.id}: capabilities.amountLimits phải là {min?, max?} số nguyên`);
  }
  return true;
}

function assertEvent(ev) {
  if (!ev || typeof ev !== 'object') throw new Error('sự kiện rỗng');
  for (const k of ['gateway', 'type', 'occurredAt', 'source']) {
    if (ev[k] === undefined || ev[k] === null) throw new Error(`sự kiện thiếu ${k}`);
  }
  if (!ev.unmatched && !ev.attemptRef) throw new Error('sự kiện thiếu attemptRef (hoặc phải đánh dấu unmatched)');
  if (ev.type === 'received' && !ev.gatewayTxnId) throw new Error('sự kiện received thiếu gatewayTxnId');
  if (ev.type === 'reversed' && !ev.gatewayTxnId) throw new Error('sự kiện reversed thiếu gatewayTxnId (phải ổn định giữa các kênh)');
  if (ev.type === 'authorized' && !ev.gatewayTxnId) throw new Error('sự kiện authorized thiếu gatewayTxnId');
  if (DISPUTE_TYPES.includes(ev.type) && !ev.gatewayTxnId) throw new Error(`sự kiện ${ev.type} thiếu gatewayTxnId (phải ổn định giữa các kênh)`);
  if (!EVENT_TYPES.includes(ev.type)) throw new Error(`type không hợp lệ: ${ev.type}`);
  if (!EVENT_SOURCES.includes(ev.source)) throw new Error(`source không hợp lệ: ${ev.source}`);
  if (ev.currency !== undefined && !Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, ev.currency)) throw new Error(`currency không hợp lệ: ${ev.currency}`);
  if (ev.type !== 'pending' && !Number.isInteger(ev.amount)) throw new Error(`amount phải là số nguyên VND: ${ev.amount}`);
  if (ev.failCode !== undefined) {
    if (!FAIL_CODES.includes(ev.failCode)) throw new Error(`failCode không hợp lệ: ${ev.failCode}`);
    if (!['failed', 'cancelled', 'expired'].includes(ev.type)) throw new Error(`failCode chỉ dành cho failed|cancelled|expired, không phải ${ev.type}`);
  }
  return true;
}

/** Kiểm một NextAction đúng hình dạng theo loại. Trả chuỗi lỗi hoặc null. Loại lạ là lỗi (không đoán). */
function checkNextAction(na) {
  if (!na || typeof na !== 'object' || Array.isArray(na)) return 'nextAction rỗng';
  const str = (v) => typeof v === 'string' && v.length > 0;
  switch (na.type) {
    case 'redirect': case 'deeplink': case 'challenge':
      return str(na.url) ? null : `nextAction ${na.type} thiếu url`;
    case 'post_redirect':
      if (!str(na.url)) return 'nextAction post_redirect thiếu url';
      if (!na.fields || typeof na.fields !== 'object' || Array.isArray(na.fields) || Object.values(na.fields).some((v) => typeof v !== 'string')) return 'nextAction post_redirect.fields phải là {khóa: chuỗi}';
      return null;
    case 'poll':
      return na.afterSeconds === undefined || (Number.isInteger(na.afterSeconds) && na.afterSeconds >= 1) ? null : 'nextAction poll.afterSeconds phải là số nguyên >= 1';
    case 'qr':
      return str(na.data) || str(na.imageUrl) ? null : 'nextAction qr cần data hoặc imageUrl';
    case 'transfer': {
      const i = na.instructions;
      if (!i || typeof i !== 'object') return 'nextAction transfer thiếu instructions';
      if (!i.bank || !i.accountNumber) return 'nextAction transfer.instructions thiếu bank hoặc accountNumber';
      if (!Number.isInteger(i.amount)) return 'nextAction transfer.instructions.amount phải là số nguyên';
      return null;
    }
    default: return `nextAction.type không hợp lệ: ${na.type}`;
  }
}

/**
 * Kiểm kết quả tạo thanh toán về phần Hub phụ thuộc (state, instructions). Trả chuỗi lỗi hoặc null.
 * Kết quả sai hình dạng không bị coi là từ chối: cổng có thể đã tạo giao dịch, nên Hub xử lý như unknown (PHUB-D-018).
 */
function checkCreateResult(res) {
  if (!res || typeof res !== 'object') return 'kết quả tạo rỗng';
  if (res.status === 'next_action') {
    const bad = checkNextAction(res.nextAction);
    if (bad) return bad;
  }
  if (res.status === 'instructions') {
    const i = res.instructions;
    if (!i || typeof i !== 'object') return 'instructions rỗng';
    if (!i.bank || !i.accountNumber) return 'instructions thiếu bank hoặc accountNumber';
    if (!Number.isInteger(i.amount)) return 'instructions.amount phải là số nguyên VND';
  }
  if (res.state !== undefined) {
    if (res.state === null || typeof res.state !== 'object' || Array.isArray(res.state)) return 'state phải là đối tượng JSON';
    let text;
    try { text = JSON.stringify(res.state); } catch { return 'state không tuần tự hóa được'; }
    if (Buffer.byteLength(text) > STATE_MAX_BYTES) return `state quá ${STATE_MAX_BYTES} byte`;
  }
  return null;
}

module.exports = { DISPUTE_TYPES, NEXT_ACTION_TYPES, checkNextAction, checkExtra, EXTRA_TYPES, checkCreateResult, STATE_MAX_BYTES, FAIL_CODES, RETRIABLE_FAIL_CODES, isRetriable, CURRENCY_EXPONENT, OPERATIONS, METHODS, EVENT_TYPES, EVENT_SOURCES, ACK_OUTCOMES, CAP_KEYS, assertAdapterShape, assertEvent };

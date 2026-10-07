---
module: paypal-sim
---
# paypal-sim - Spec (tầng 2)

Design được tách thành yêu cầu, contract, tiêu chí nghiệm thu và task. Khung tự sinh từ design; điền qua tool `spec_fill`.

## PYPL-S-001: Adapter PayPal: Orders v2, hai sản phẩm (thu ngay, giữ rồi thu), adapter tự thu sau khi khách duyệt
- from: PYPL-D-001
- derived_from: d63a840b
- status: ready
- requirement: Adapter paypal (src/adapters/paypal) tự đăng ký qua registry, khai capabilities đúng sản phẩm: charge (intent CAPTURE; purchase, refund, inquire) và auth (intent AUTHORIZE; authorize, capture, void, refund, inquire; partialCapture). createPayment tạo order Orders v2 với custom_id = attemptRef, return_url về /return/paypal?ref=<attemptRef>, trả nextAction redirect tới link payer-action (hoặc approve), state {order}. Khi khách duyệt, adapter thu (CAPTURE) hoặc giữ (AUTHORIZE) giúp Hub qua hai cửa vào idempotent: kênh return và webhook CHECKOUT.ORDER.APPROVED; trước khi thu phải kiểm custom_id của order khớp attemptRef. query() chỉ đọc, không bao giờ thu. Mã giao dịch của Hub (gatewayTxnId) là mã order cho cả authorized và succeeded. VND không bao giờ tới PayPal. Không đổi lõi Hub và hợp đồng chuẩn.
- contract: createPayment(p) -> next_action{redirect} | rejected{reason, failCode} | unknown. parseCallback(channel=return|ipn) -> {valid, event?, retryLater?, ack}. query({attemptRef, state}) -> sự kiện chuẩn | {state:'not_found'|'unknown'}. capture/void/refund/queryRefund theo contract.js. Sự kiện: succeeded và authorized mang gatewayTxnId = mã order; pending khi capture PENDING hoặc order chưa duyệt; failed (declined) khi thu bị từ chối; cancelled hoặc expired khi khoản giữ nhả hoặc hết hạn. Cấu hình: clientId, clientSecret, webhookId, product, currencies, baseUrl, returnBaseUrl, certHosts, timeoutMs, failCodeMap.
- acceptance: test/paypal/lifecycle.test.js (13 ca: đổi tiền, tạo, duyệt rồi quay về, đóng tab, hai nơi cùng thu, query chỉ đọc, hủy, từ chối, PENDING, token hết hạn, lỗi mạng, hết hạn order); test/paypal/hold-capture.test.js (9 ca); test/e2e/hub-paypal.test.js (18 ca cấp Hub); test/hub/adapters-arch.test.js giữ ranh giới (lõi không có tên cổng); test/hub/contract-currency.test.js (PayPal không khai VND). Tất cả chỉ với simulator, chưa kiểm PayPal thật.
- tasks: - [ ] Kiểm với sandbox PayPal thật: tên trường, mã lỗi HTTP, custom_id có chép sang capture và webhook, hành vi khi khách duyệt rồi đóng tab

## PYPL-S-002: Tiền, lỗi, webhook và hoàn của adapter PayPal
- from: PYPL-D-002
- derived_from: a6a90e2b
- status: ready
- requirement: Tiền: đổi đơn vị nhỏ nhất ISO 4217 của lõi sang chuỗi thập phân PayPal và ngược lại; JPY không phần thập phân; số không đổi được thì từ chối (không làm tròn). Loại tiền mặc định USD EUR GBP JPY AUD CAD SGD HKD, VND không bật được. Webhook: tự kiểm chữ ký RSA-SHA256 trên transmissionId|time|webhookId|crc32(thân thô); chứng chỉ chỉ tải từ máy chủ trong certHosts qua https; sai thì valid=false, không tạo sự kiện tiền. Sự kiện: capture COMPLETED thành succeeded, PENDING thành pending, DENIED hoặc DECLINED thành failed, khoản giữ CREATED thành authorized, VOIDED thành cancelled, hết hạn thành expired, hoàn ngoài Hub và REVERSED thành reversed, tranh chấp thành dispute_opened, dispute_won, dispute_lost (mã là dispute_id). Hoàn do Hub tạo mang custom_id HUB:<refundRef> và webhook hoàn của nó bị bỏ qua. Lỗi: 429 ném notSent; 4xx chắc chắn thì rejected hoặc failed; 5xx hoặc mất phản hồi thì unknown hoặc processing, không đoán; tra cứu hỏng tạm thời khi xử lý webhook thì retryLater.
- contract: toPaypalValue(amount, currency) -> {value}|{error}; fromPaypalValue(value, currency) -> số nguyên|null. capture({state, gatewayTxnId, amount, currency, idempotencyKey}) -> captured|rejected|unknown (tra mã khoản giữ bằng GET order). void tương tự. refund({refundRef, amount, currency, state}) -> {status} (PayPal-Request-Id = <refundRef>:refund). queryRefund tìm theo custom_id HUB:<refundRef> (inferred).
- acceptance: test/paypal/signature.test.js (7 ca: chữ ký, thân sửa, header, webhookId, khóa lạ, cert-url lạ không tải gì, bộ nhớ đệm, cấu hình sai); test/paypal/refund-dispute.test.js (9 ca); test/paypal/adversarial.test.js (8 ca: trùng, đảo, mất, return giả, retryLater, sự kiện lạ); test/e2e/hub-paypal.test.js; test/e2e/hub-refund-matrix.test.js (PayPal); test/e2e/scenarios-paypal.test.js (ngẫu nhiên, bộ chạy test/support/intl-runner.js). Chỉ với simulator.
- tasks:
  - [ ] Kiểm chữ ký với chứng chỉ PayPal thật và chuỗi tin cậy; kiểm thời gian giao lại webhook (có dung sai thời gian hay không)
  - [ ] Kiểm hình dạng resource của CUSTOMER.DISPUTE.* và PAYMENT.CAPTURE.REFUNDED với PayPal thật

## PYPL-S-003: Simulator PayPal: hình thức theo tài liệu, ngữ nghĩa đối kháng và cấu hình được
- from: PYPL-D-003
- derived_from: f801b274
- status: ready
- requirement: Simulator tools/sim/paypal/server.js: HTTP thuần, OAuth client_credentials, Bearer, PayPal-Request-Id (chỉ lưu thành công), Orders (tạo, xem, capture, authorize), Payments (capture khoản giữ, void, xem, refund), webhook ký RSA-SHA256 bằng khóa sinh lúc chạy (không có khóa nào trong repo) với cert-url trỏ về simulator. Điều khiển bất lợi qua /sim/control: dup_webhooks, reverse_events, drop_types, hold_webhooks, bad_signature, retries, inject (429, 5xx trước hoặc sau, mất phản hồi, trễ), capture_decline, capture_pending, refund_mode async, hold_days. Khách mô phỏng bằng /sim/pay; /sim/emit bơm sự kiện tùy ý có chữ ký; /sim/dispute, /sim/reverse, /sim/capture/resolve, /sim/refund/resolve, /sim/clock/advance (order hết hạn sau 3 giờ, khoản giữ sau hold_days). Driver paypal trong test/support/world.js. Simulator KHÔNG chứng minh hành vi của PayPal thật.
- contract: Hình thức theo docs/agent/paypal-research.md (documented hoặc inferred). Ngữ nghĩa chưa kiểm cấu hình được; mọi điểm unverified ghi ở đầu tệp server.js.
- acceptance: Mọi test PayPal chạy qua simulator này; test/support/world.js có paypalDriver dùng chung cho test/e2e. Bộ ngẫu nhiên (150 seed x 100 bước hoặc hơn) không có lỗi bất biến "tiền không vô hình, không báo thu khống"; đột biến (adapter nuốt sự kiện succeeded) bị bắt.
- tasks:

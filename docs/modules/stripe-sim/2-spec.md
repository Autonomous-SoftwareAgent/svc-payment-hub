---
module: stripe-sim
---
# stripe-sim - Spec (tầng 2)

Design được tách thành yêu cầu, contract, tiêu chí nghiệm thu và task. Khung tự sinh từ design; điền qua tool `spec_fill`.

## STRP-S-001: Adapter Stripe: Checkout hosted, hai sản phẩm (thu ngay, giữ rồi thu), PaymentIntent là nguồn sự thật về tiền
- from: STRP-D-001
- derived_from: 11a871ea
- status: ready
- requirement: Adapter `stripe` (src/adapters/stripe, tự đăng ký qua registry) tạo thanh toán bằng Checkout Session mode=payment: gửi form-encode lồng nhau, xác thực Basic bằng khóa bí mật, Stripe-Version cố định, client_reference_id và metadata attemptRef ở cả phiên lẫn PaymentIntent, hạn phiên sessionExpiresMinutes (31 đến 1439), khóa idempotency '<attemptRef>:create'; trả {status:'next_action', nextAction:{type:'redirect'}, state:{cs}, expiresAt}. Hai sản phẩm theo capabilities(product): 'charge' (purchase, refund, inquire) và 'auth' (capture_method=manual: authorize, capture, void, refund, inquire); sản phẩm lạ không khai gì và bị từ chối. extra {locale, customerEmail} ánh xạ sang locale, customer_email. Webhook: parseCallback kiểm Stripe-Signature (t=, v1=, HMAC-SHA256 của 't.thân thô', nguyên chuỗi whsec_, hằng thời gian, nhiều v1 và nhiều secret, dung sai 300 giây hai chiều); ánh xạ payment_intent.succeeded thành succeeded, amount_capturable_updated (requires_capture) thành authorized, canceled thành cancelled hoặc expired (reason automatic), checkout.session.expired thành expired, async_payment_failed thành failed, charge.dispute.created và closed (won, lost) thành dispute_opened, dispute_won, dispute_lost (tra PaymentIntent lấy attemptRef; lỗi tra thì retryLater), refund.created không có metadata hubRefund thành reversed; payment_intent.payment_failed, checkout.session.completed, sự kiện lạ, PaymentIntent không có attemptRef đều bị bỏ qua (valid, không event). gatewayTxnId là pi_ ở mọi kênh. query(state.cs) đọc phiên kèm PaymentIntent: succeeded, authorized, cancelled hoặc expired theo PaymentIntent, phiên hết hạn là expired, còn mở là pending, 404 là not_found, lỗi hoặc không có state là unknown. cancel là expire phiên (đã expired thì true, đã complete thì false). capture, void, refund, queryRefund theo STRP-D-002.
- contract: createStripeAdapter(config, deps); adapter = {id:'stripe', create, configWarnings}. Config: secretKey, webhookSecret (chuỗi hoặc danh sách), product, currencies, sessionExpiresMinutes, apiVersion, baseUrl, timeoutMs, failCodeMap. Webhook endpoint: POST /ipn/stripe (server HTTP của Hub, có rawBody). Sự kiện chuẩn phát ra: succeeded, authorized, cancelled, expired, failed, dispute_opened, dispute_won, dispute_lost, reversed.
- acceptance: test/stripe/signature.test.js (7), lifecycle.test.js (10), hold-capture.test.js (6), refund-dispute.test.js (7), adversarial.test.js (12) và test/e2e/hub-stripe.test.js (15) qua; toàn bộ npm test qua (643 qua, 2 bỏ qua, 0 lỗi, PostgreSQL thật); đã thử phá 19 chỗ của adapter (bỏ dung sai, không kiểm chữ ký, khóa idempotency, requires_capture thành succeeded, ISK không nhân 100, mất phản hồi thành rejected hoặc failed, thiếu metadata, warning_closed thành lost, bỏ extra, 429 không notSent...), cả 19 đều làm test đỏ. CHƯA kiểm với Stripe thật: mọi hành vi là documented hoặc inferred (docs/agent/stripe-research.md).
- tasks:
  - [x] Tạo phiên Checkout, hai sản phẩm, extra, nextAction
  - [x] Webhook có chữ ký và ánh xạ sự kiện
  - [x] query, cancel (expire phiên)
  - [x] configWarnings, ví dụ cấu hình, README
  - [ ] Kiểm với khóa test thật (stripe listen, stripe trigger): thẻ hỏng trên hosted Checkout, payment_status khi giữ tiền, metadata sang Charge và Dispute
  - [ ] Tìm lại phiên khi tạo mất phản hồi (hiện attempt UNKNOWN chờ webhook)
  - [ ] Thu một phần (Hub chưa hỗ trợ)

## STRP-S-002: Tiền, lỗi và idempotency của adapter Stripe
- from: STRP-D-002
- derived_from: b9b7275f
- status: ready
- requirement: Tiền: toStripeAmount và fromStripeAmount: truyền thẳng với đa số loại tiền (kể cả JPY, VND); ISK và UGX nhân 100 khi gửi và chỉ nhận về bội của 100 (không thì không đổi được, adapter yêu cầu Stripe giao lại); tiền ba chữ số phải là bội của 10; số tiền không phải số nguyên dương an toàn bị từ chối. contract.CURRENCY_EXPONENT có thêm MGA; lõi truyền currency vào adapter.refund. Phân loại lời gọi: 2xx ok; 401 và 403 auth (từ chối, failCode invalid_request); 429 từ chối chưa tác dụng (tạo: rejected rate_limited; thu, nhả, hoàn: ném lỗi notSent code rate_limited); 409 và 5xx và mất phản hồi: CHƯA RÕ (tạo: unknown; thu, nhả: unknown; hoàn: processing); 4xx còn lại: từ chối chắc chắn, failCode 402 theo bảng decline_code (insufficient_funds, declined, fraud, authentication_required, gateway_error, rate_limited, mã lạ là unknown), còn lại invalid_request. Thu: capture POST /v1/payment_intents/{pi}/capture amount_to_capture đủ số giữ, khóa là idempotencyKey của Hub; charge_already_captured và payment_intent_unexpected_state được giải quyết bằng GET PaymentIntent (succeeded cùng số tiền là captured, canceled là rejected, còn lại unknown); charge_expired_for_capture và amount_too_large là rejected. Nhả: POST .../cancel, tương tự. Hoàn: POST /v1/refunds {payment_intent, amount, metadata[hubRefund]} khóa '<refundRef>:refund'; pending là processing, requires_action là manual_required, succeeded, failed, canceled; queryRefund tra theo metadata hubRefund trong danh sách refund của PaymentIntent (lấy từ phiên cs_), không thấy là requested. Kết quả 500 của Stripe được lưu theo khóa nên adapter không POST lại để cứu: chỉ hỏi trạng thái.
- contract: toStripeAmount(amount, currency) và fromStripeAmount(n, currency); STRIPE_SCALE {ISK: 100, UGX: 100}; FAIL_CODES (mã thẻ Stripe sang mã chuẩn, ghi đè bằng failCodeMap); adapter.refund nhận thêm currency (contract.js, hub.js).
- acceptance: Cùng bộ test STRP-S-001 (đặc biệt lifecycle: tiền; hold-capture; refund-dispute; adversarial: 500 sau khi xử lý, timeout, 429, 409) và test/hub/contract-currency.test.js cập nhật (Stripe khai loại tiền quốc tế). Thử phá: mất phản hồi thành rejected hoặc failed, ISK không nhân 100, thu hai lần không giải quyết bằng GET, 429 không notSent đều làm test đỏ. CHƯA kiểm: UGX, quy tắc bội 10 của tiền ba chữ số, mã lỗi thật khi thu hai lần, thông điệp thật của idempotency_error.
- tasks:
  - [x] Đổi đơn vị tiền và ngoại lệ ISK, UGX, ba chữ số
  - [x] Phân loại kết quả mỗi lời gọi, mất phản hồi là chưa rõ
  - [x] Thu, nhả, hoàn, queryRefund
  - [x] MGA trong bảng tiền của lõi, currency trong lời gọi hoàn
  - [ ] Kiểm UGX và tiền ba chữ số với khóa test thật
  - [ ] Bảng mã thất bại thẻ: hàng đoán (lost_card, stolen_card, expired_card) cần chốt với dữ liệu thật

## STRP-S-003: Simulator Stripe: hình thức theo bằng chứng, ngữ nghĩa theo hướng đối kháng và cấu hình được
- from: STRP-D-003
- derived_from: 21be7658
- status: ready
- requirement: Simulator Stripe (tools/sim/stripe/server.js) chạy HTTP không phụ thuộc ngoài, mẫu như simulator MoMo: xác thực Basic hoặc Bearer (sai thì 401 với thân chỉ có message và type), URL lạ 404, body form-encode lồng nhau, Checkout Session (kiểm tham số, hạn 30 phút đến 24 giờ, mức tối thiểu, ISK bội 100, KWD bội 10), PaymentIntent (capture, cancel), Refund (đồng bộ hoặc bất đồng bộ), Dispute, Idempotency-Key (lưu cả 4xx và 500, khác tham số là idempotency_error, đang chạy là 409), webhook ký đúng Stripe-Signature. Điều khiển qua POST /sim/control: thẻ hỏng giữ phiên mở, hold_payment_status, emit_payment_failed, hold_days, mã lỗi thu hai lần, refund_mode, đảo thứ tự, trùng, rơi, giữ rồi giao, ký sai, lệch giờ, tiêm lỗi (500 trước hoặc sau khi xử lý, timeout sau khi xử lý, 429 có và không header, 409, chậm). Hành động: /sim/pay (success, decline, cancel), /sim/clock/advance (hết hạn phiên và giữ tiền), /sim/dispute và /sim/dispute/close, /sim/refund/resolve, /sim/webhook/flush. Driver stripeDriver trong test/support/world.js (không nằm trong DRIVERS vì các kịch bản chung dùng điều khiển IPN) cho test tích hợp Hub với server HTTP thật.
- contract: startSimulator({secretKey, webhookSecret, webhookUrl, controls, clock, port}) trả {url, clock, state, controls, close, setWebhook}; module cũng chạy riêng (SIM_PORT, SIM_SECRET_KEY, SIM_WEBHOOK_SECRET, SIM_WEBHOOK_URL).
- acceptance: test/e2e/hub-stripe.test.js (15 test: thu ngay, trùng và đảo thứ tự, webhook mất, chữ ký sai, thẻ hỏng, tạo mất phản hồi cứu bằng webhook, hủy bằng expire, hết hạn phiên, giữ tiền rồi thu hoặc nhả, thu mất phản hồi, authorized đến sau khi thu, hết hạn giữ, tranh chấp, đơn vị tiền) và test/stripe/*.test.js dùng simulator qua; simulator KHÔNG chứng minh hành vi Stripe thật.
- tasks:
  - [x] Simulator với hình thức theo bằng chứng, ngữ nghĩa đối kháng
  - [x] Driver world.js và test tích hợp Hub
  - [ ] Thêm Stripe vào các kịch bản ngẫu nhiên chung (random-runner) sau khi có điều khiển tương ứng
  - [ ] Đối chiếu simulator với hành vi Stripe thật khi có khóa test

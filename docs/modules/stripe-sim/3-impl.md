---
module: stripe-sim
---
# stripe-sim - Implementation (tầng 3)

Đã code gì, ở đâu, lệch spec chỗ nào. Ghi qua tool `impl_link`.

## STRP-S-001: Adapter Stripe: Checkout hosted, hai sản phẩm (thu ngay, giữ rồi thu), PaymentIntent là nguồn sự thật về tiền
- spec_hash: 16479102
- status: done
- code: src/adapters/stripe/index.js, test/stripe/helpers.js, test/stripe/signature.test.js, test/stripe/lifecycle.test.js, test/stripe/hold-capture.test.js, test/stripe/refund-dispute.test.js, test/stripe/adversarial.test.js, test/e2e/hub-stripe.test.js
- tests: test/stripe/signature.test.js, test/stripe/lifecycle.test.js, test/stripe/hold-capture.test.js, test/stripe/refund-dispute.test.js, test/stripe/adversarial.test.js, test/e2e/hub-stripe.test.js
- deviation:
- notes: Chỉ kiểm với simulator tools/sim/stripe; CHƯA kiểm với Stripe thật (chưa có khóa test). Điểm chưa kiểm quan trọng nhất: thẻ hỏng trên hosted Checkout có sinh sự kiện thất bại không (simulator giả định là không).

## STRP-S-002: Tiền, lỗi và idempotency của adapter Stripe
- spec_hash: 0b9f9ea1
- status: done
- code: src/adapters/stripe/index.js, src/contract.js, src/hub.js, test/stripe/lifecycle.test.js, test/stripe/hold-capture.test.js, test/stripe/refund-dispute.test.js, test/stripe/adversarial.test.js, test/e2e/hub-stripe.test.js
- tests: test/stripe/lifecycle.test.js, test/stripe/hold-capture.test.js, test/stripe/refund-dispute.test.js, test/stripe/adversarial.test.js, test/hub/contract-currency.test.js
- deviation:
- notes: UGX và quy tắc bội 10 của tiền ba chữ số chưa kiểm (không có trong danh sách loại tiền mặc định; configWarnings nhắc). Bảng mã thất bại thẻ có hàng đoán.

## STRP-S-003: Simulator Stripe: hình thức theo bằng chứng, ngữ nghĩa theo hướng đối kháng và cấu hình được
- spec_hash: 2b189856
- status: done
- code: tools/sim/stripe/server.js, test/support/world.js, test/stripe/adversarial.test.js, test/e2e/hub-stripe.test.js
- tests: test/e2e/hub-stripe.test.js, test/stripe/adversarial.test.js
- deviation:
- notes: Simulator không chứng minh hành vi Stripe thật; các điều khiển unverified (hold_payment_status, emit_payment_failed, double_capture_code, hold_days, reason khi hết hạn giữ) là giả định cấu hình được.

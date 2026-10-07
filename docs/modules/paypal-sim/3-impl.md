---
module: paypal-sim
---
# paypal-sim - Implementation (tầng 3)

Đã code gì, ở đâu, lệch spec chỗ nào. Ghi qua tool `impl_link`.

## PYPL-S-001: Adapter PayPal: Orders v2, hai sản phẩm (thu ngay, giữ rồi thu), adapter tự thu sau khi khách duyệt
- spec_hash: 11b463ca
- status: done
- code: src/adapters/paypal/index.js, test/paypal/helpers.js, test/paypal/lifecycle.test.js, test/paypal/hold-capture.test.js, test/e2e/hub-paypal.test.js
- tests: test/paypal/lifecycle.test.js, test/paypal/hold-capture.test.js, test/e2e/hub-paypal.test.js, test/hub/adapters-arch.test.js, test/hub/contract-currency.test.js
- deviation:
- notes: Merge vào main 2026-10-07 (c533f85). Chỉ kiểm với simulator; chưa kiểm PayPal thật (P-013). Hạn order 3 giờ so với đơn Hub: P-014.

## PYPL-S-002: Tiền, lỗi, webhook và hoàn của adapter PayPal
- spec_hash: 7694bee8
- status: done
- code: src/adapters/paypal/index.js, test/paypal/signature.test.js, test/paypal/refund-dispute.test.js, test/paypal/adversarial.test.js, test/e2e/hub-paypal.test.js, test/e2e/hub-refund-matrix.test.js, test/e2e/scenarios-paypal.test.js, test/support/intl-runner.js
- tests: test/paypal/signature.test.js, test/paypal/refund-dispute.test.js, test/paypal/adversarial.test.js, test/e2e/hub-paypal.test.js, test/e2e/hub-refund-matrix.test.js, test/e2e/scenarios-paypal.test.js
- deviation:
- notes: Chữ ký tự kiểm chỉ với khóa simulator; chưa kiểm chứng chỉ PayPal thật và chuỗi tin cậy (P-013).

## PYPL-S-003: Simulator PayPal: hình thức theo tài liệu, ngữ nghĩa đối kháng và cấu hình được
- spec_hash: dc4b0447
- status: done
- code: tools/sim/paypal/server.js, test/support/world.js, test/support/intl-runner.js, test/support/stripe-runner.js, test/e2e/scenarios-paypal.test.js, test/e2e/scenarios-stripe.test.js
- tests: test/e2e/scenarios-paypal.test.js, test/e2e/scenarios-stripe.test.js, test/e2e/hub-paypal.test.js
- deviation:
- notes: Simulator không chứng minh hành vi PayPal thật; mọi điểm unverified ghi ở đầu server.js.

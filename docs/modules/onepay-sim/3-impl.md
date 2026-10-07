---
module: onepay-sim
---
# onepay-sim - Implementation (tầng 3)

Đã code gì, ở đâu, lệch spec chỗ nào. Ghi qua tool `impl_link`.

## OPAY-S-001: OnePAY: luồng thanh toán và cách tích hợp (chuyển hướng kiểu VPC, ký HMAC-SHA256)
- spec_hash: dfe3a70f
- status: done
- code: src/adapters/onepay/index.js, test/onepay/create.test.js, test/onepay/golden.test.js, test/onepay/helpers.js, test/onepay/lifecycle.test.js, tools/sim/onepay/server.js
- tests: test/onepay/create.test.js, test/onepay/golden.test.js, test/onepay/lifecycle.test.js, test/e2e/hub-sims.test.js, test/e2e/scenarios-sim.test.js
- deviation:
- notes: Ký luôn có vpc_Currency (A4 conflicts chưa phân xử). Docs chính thức không truy cập được, chỉ bản sao 2020.

## OPAY-S-002: Sổ giả định OnePAY: nguồn, mức bằng chứng, đối chiếu docs
- spec_hash: cc67821a
- status: done
- code: src/adapters/onepay/index.js, tools/sim/onepay/server.js
- tests: test/onepay/lifecycle.test.js
- deviation:
- notes: Giả định unverified: ack lỗi, IPN retry 3 lần cách 60 giây, paid_after_expiry, ref đã có kết quả cuối gửi lại thì INVALID_INVOICE.

## OPAY-S-003: OnePAY: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- spec_hash: 648f0508
- status: done
- code: src/adapters/onepay/index.js, tools/sim/onepay/server.js
- tests: test/onepay/create.test.js, test/onepay/lifecycle.test.js
- deviation:
- notes:

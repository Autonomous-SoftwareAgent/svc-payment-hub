---
module: momo-sim
---
# momo-sim - Implementation (tầng 3)

Đã code gì, ở đâu, lệch spec chỗ nào. Ghi qua tool `impl_link`.

## MOMO-S-001: MoMo: luồng thanh toán và cách tích hợp (API v2, gọi tạo đơn server-to-server, ký HMAC-SHA256)
- spec_hash: fb7ab94a
- status: done
- code: src/adapters/momo/index.js, test/momo/helpers.js, test/momo/signature.test.js, tools/sim/momo/server.js
- tests: test/momo/signature.test.js, test/momo/lifecycle.test.js, test/e2e/hub-sims.test.js
- deviation:
- notes:

## MOMO-S-002: Sổ giả định MoMo: nguồn, mức bằng chứng, đối chiếu docs
- spec_hash: 92d46a61
- status: done
- code: src/adapters/momo/index.js, test/momo/adversarial.test.js, test/momo/simulator-rules.test.js, tools/sim/momo/server.js
- tests: test/momo/adversarial.test.js, test/momo/simulator-rules.test.js
- deviation:
- notes: Giả định unverified trong simulator: IPN retry 5 lần cách 300 giây, hết hạn 900 giây, tiền về muộn, khách thử lại trên payUrl, mã thất bại muộn của hoàn tiền 1004.

## MOMO-S-003: MoMo: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- spec_hash: 834871a0
- status: done
- code: src/adapters/momo/index.js, test/momo/lifecycle.test.js, tools/sim/momo/server.js
- tests: test/momo/lifecycle.test.js
- deviation:
- notes: authorized (9000) chưa có sự kiện chuẩn riêng, map về pending. Rà soát với mã 2026-10-04: Query resultCode 1005 hoặc 42 trả not_found, nhưng IPN resultCode 1005 vẫn map failed với failCode expired (docs định nghĩa 1005 là hết hạn; chưa kiểm IPN thật). refund_mode mặc định sync theo A10 (inferred).

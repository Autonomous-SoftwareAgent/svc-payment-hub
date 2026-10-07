---
module: vnpay-sim
---
# vnpay-sim - Implementation (tầng 3)

Đã code gì, ở đâu, lệch spec chỗ nào. Ghi qua tool `impl_link`.

## VNPS-S-001: Kiến trúc simulator VNPay: service Node không phụ thuộc, bám hợp đồng của cổng
- spec_hash: cff7c5a8
- status: deviated
- code: src/adapters/vnpay/index.js, src/adapters/vnpay/signing.js, test/support/vnpay-driver.js, test/vnpay/helpers.js, tools/sim/vnpay/server.js
- tests: test/support/vnpay-driver.js, test/vnpay/helpers.js
- deviation: Chưa có ghi file JSON tùy chọn và README chạy simulator (tools/sim/vnpay/ chỉ có server.js và cards.json); route và env nêu ở requirement có trong mã nhưng không nằm trong contract gốc.
- notes: startSimulator trả Promise; clock {startAt, frozen}; chạy trực tiếp bằng env SIM_* đã kiểm.

## VNPS-S-002: Tạo URL thanh toán: kiểm tra tham số và chữ ký vnp_SecureHash HMAC-SHA512
- spec_hash: 198887b1
- status: done
- code: src/adapters/vnpay/index.js, src/adapters/vnpay/signing.js, test/vnpay/layer1.test.js, test/vnpay/signing.test.js, tools/sim/vnpay/server.js
- tests: test/vnpay/layer1.test.js, test/vnpay/signing.test.js
- deviation:
- notes: Mã khi sai chữ ký ở tầng 2 là 70 và TxnRef trùng sau khi đã trả là 99: giả định, chưa xác minh (nhóm config).

## VNPS-S-003: Trang thanh toán và kết quả theo thẻ test, ánh xạ sang vnp_ResponseCode và vnp_TransactionStatus
- spec_hash: bbeb456f
- status: deviated
- code: src/adapters/vnpay/index.js, src/adapters/vnpay/signing.js, tools/sim/vnpay/server.js
- tests: test/vnpay/layer1.test.js, test/vnpay/lifecycle.test.js
- deviation: Chưa mô phỏng: TransactionStatus 01 và 04, thẻ quốc tế, báo cáo dòng verified=false, CardType khác ATM. Nguồn của mã 12 (thẻ bị khóa) cần xác nhận.
- notes:

## VNPS-S-004: Return URL: chuyển hướng trình duyệt kèm tham số và chữ ký, không dùng để cập nhật đơn
- spec_hash: 3f529592
- status: done
- code: src/adapters/vnpay/index.js, src/adapters/vnpay/signing.js, tools/sim/vnpay/server.js
- tests: test/vnpay/lifecycle.test.js
- deviation:
- notes:

## VNPS-S-005: IPN: GET server-to-server, phản hồi RspCode, retry 10 lần cách 5 phút
- spec_hash: cf95d930
- status: done
- code: src/adapters/vnpay/index.js, src/adapters/vnpay/signing.js, test/vnpay/ack.test.js, tools/sim/vnpay/server.js
- tests: test/vnpay/ack.test.js, test/vnpay/adversarial.test.js
- deviation:
- notes: Số lần retry tính tổng gồm cả lần đầu (mặc định 10, cách 5 phút ảo); là tham số.

## VNPS-S-006: API querydr (truy vấn giao dịch) và refund (hoàn tiền) với chữ ký dạng nối bằng "|"
- spec_hash: 66ef224e
- status: deviated
- code: src/adapters/vnpay/index.js, src/adapters/vnpay/signing.js, tools/sim/vnpay/server.js
- tests:
- deviation: queryRefund luôn trả manual_required (chưa biết API truy vấn hoàn tiền); lỗi mạng khi hoàn tiền cũng ra manual_required; vòng đời 05 rồi kết quả cuối sau N giây ảo là giả định; chọn mã 93 cho số tiền hoàn không hợp lệ theo spec trong khi docs mâu thuẫn 02/93.
- notes: Rà soát với mã 2026-10-04: queryRefund của adapter không luôn trả manual_required: trả trạng thái đã lưu (succeeded hoặc failed) nếu khác processing/requested.

## VNPS-S-007: Kịch bản lỗi chủ động: IPN trễ, trùng, mất, sai thứ tự, sai số tiền, sai chữ ký
- spec_hash: 2f64a958
- status: deviated
- code: src/adapters/vnpay/index.js, src/adapters/vnpay/signing.js, test/vnpay/adversarial.test.js, tools/sim/vnpay/server.js
- tests: test/vnpay/adversarial.test.js
- deviation: Chưa có kịch bản thứ tự IPN/Return và bank_maintenance; có thêm paid_after_expiry, refund_outcome, refund_delay_seconds ngoài danh sách của design.
- notes:

## VNPS-S-008: Kiểm thử đối chiếu (conformance) với sandbox VNPay thật để chốt độ sát
- spec_hash: 4e003ba2
- status: planned
- code:
- tests:
- deviation:
- notes:

## VNPS-S-009: Sổ giả định VNPay: nguồn, mức bằng chứng, kết luận đối chiếu docs
- spec_hash: 438a8250
- status: planned
- code:
- tests:
- deviation:
- notes:

## VNPS-S-010: VNPay: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- spec_hash: 1182a202
- status: done
- code: src/adapters/vnpay/index.js, src/adapters/vnpay/signing.js, test/vnpay/lifecycle.test.js, tools/sim/vnpay/server.js
- tests: test/vnpay/lifecycle.test.js, test/vnpay/adversarial.test.js
- deviation:
- notes: Cờ: hardExpiry=unknown, cancellable=false, queryable=true, refundable=api, refundAsync=true (chưa xác minh), createCanTimeout=false.

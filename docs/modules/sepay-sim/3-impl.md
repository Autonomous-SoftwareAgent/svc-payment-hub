---
module: sepay-sim
---
# sepay-sim - Implementation (tầng 3)

Đã code gì, ở đâu, lệch spec chỗ nào. Ghi qua tool `impl_link`.

## SEPY-S-001: SePay: ba sản phẩm và luồng chuyển khoản do khách chủ động (kiểu khác redirect)
- spec_hash: 7b790862
- status: done
- code: src/adapters/sepay/bank.js, src/adapters/sepay/common.js, src/adapters/sepay/index.js, src/adapters/sepay/qr-static.js, test/sepay/adversarial.test.js, test/sepay/helpers.js, test/sepay/lifecycle.test.js, test/sepay/signature.test.js, tools/sim/sepay/server.js
- tests: test/sepay/adversarial.test.js, test/sepay/helpers.js, test/sepay/lifecycle.test.js, test/sepay/signature.test.js
- deviation:
- notes: Adapter đã tách thành các file theo sản phẩm (index.js chọn theo product; bank.js dùng chung A và B). Hành vi của A không đổi, test cũ của A giữ nguyên (số lượng không đếm lại). Dạng phản hồi GET /v2/transactions lấy từ docs (data[], meta.pagination.has_more), live chỉ thấy 401. Khóa chống trùng là referenceCode (lùi về id khi rỗng): nếu referenceCode rỗng và id hai kênh khác nhau thì Hub có thể đếm hai lần (A12, đã có test ghi nhận).

## SEPY-S-002: Sổ giả định SePay (sản phẩm A): nguồn, mức bằng chứng, đối chiếu docs
- spec_hash: 50328370
- status: done
- code: src/adapters/sepay/bank.js, src/adapters/sepay/index.js, src/adapters/sepay/qr-static.js, test/e2e/hub-transfer.test.js, test/sepay/adversarial.test.js, test/sepay/create.test.js, test/sepay/signature.test.js, tools/sim/sepay/server.js
- tests: test/e2e/hub-transfer.test.js, test/sepay/adversarial.test.js, test/sepay/create.test.js, test/sepay/signature.test.js
- deviation:
- notes: Mọi hành vi retry, ack_mode, nội dung bị sửa, cách SePay tách code trong simulator là mô phỏng bất lợi, unverified. Đồng hồ ảo đứng yên giữa các advance nên test phải đặt api_rate_limit cao. Simulator nay dùng chung cơ chế retry cho IPN của cổng (SEPY-S-005).

## SEPY-S-003: SePay (sản phẩm A): câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003) và điểm khác ba cổng redirect
- spec_hash: 5865c69d
- status: done
- code: src/adapters/sepay/index.js, src/adapters/sepay/qr-static.js, test/sepay/adversarial.test.js, test/sepay/create.test.js, test/sepay/lifecycle.test.js
- tests: test/sepay/adversarial.test.js, test/sepay/create.test.js, test/sepay/lifecycle.test.js, test/sepay/products.test.js
- deviation:
- notes: Hoàn tiền qua Refunds API cho A là tùy chọn (refundApi), test ở products.test.js; nằm trong phần mở rộng của SEPY-S-004.

## SEPY-S-004: SePay sản phẩm B: VA theo đơn hàng (product "va-order"): luồng, năng lực, sổ giả định
- spec_hash: ad519782
- status: done
- code: src/adapters/sepay/bank.js, src/adapters/sepay/common.js, src/adapters/sepay/index.js, src/adapters/sepay/refunds.js, src/adapters/sepay/va-order.js, test/e2e/hub-sepay-products.test.js, test/sepay/helpers.js, test/sepay/va-order.test.js, tools/sim/sepay/server.js, tools/sim/sepay/va.js
- tests: test/e2e/hub-sepay-products.test.js, test/sepay/helpers.js, test/sepay/va-order.test.js
- deviation:
- notes: Toàn bộ B là docs-only (chưa có tài khoản SePay, chỉ probe 401). Từ PHUB-D-018 (P2) B lưu state {orderId, vas} ở attempt và nạp lại bộ đệm lúc khởi động (adopt); đường quét danh sách đơn (tối đa va.scanMaxPages trang) chỉ còn khi attempt không có state. Refunds API: simulator không áp cổng chặn mặc định (giống Sandbox thật) nên refund_gate phải đặt khi thử not_available. Đồng hồ ảo của simulator đứng yên giữa các advance, các test hạn mức đặt api_rate_limit theo từng kịch bản.

## SEPY-S-005: SePay sản phẩm C: cổng pay.sepay.vn (product "gateway"): luồng, năng lực, sổ giả định
- spec_hash: 5fc9e54d
- status: done
- code: src/adapters/sepay/common.js, src/adapters/sepay/gateway.js, src/adapters/sepay/index.js, test/e2e/hub-sepay-products.test.js, test/sepay/gateway.test.js, test/sepay/helpers.js, tools/sim/sepay/pg.js, tools/sim/sepay/server.js
- tests: test/e2e/hub-sepay-products.test.js, test/sepay/gateway.test.js, test/sepay/helpers.js
- deviation:
- notes: Toàn bộ C là docs-only trừ C0 (probe live). Chữ ký form trong test được tính lại độc lập theo cách đọc docs, chưa phải golden vector thật; thứ tự ký mâu thuẫn giữa docs trang tạo form, docs trang bắt đầu và SDK chính thức (C1).

## SEPY-S-006: SePay ba sản phẩm trong một adapter: chọn theo product, cấu hình, và đề xuất đổi hợp đồng Hub
- spec_hash: 7d27d489
- status: done
- code: src/adapters/sepay/index.js, test/e2e/hub-sepay-products.test.js, test/sepay/products.test.js, test/support/world.js
- tests: test/e2e/hub-sepay-products.test.js, test/sepay/products.test.js
- deviation:
- notes: P1-P7 (SEPY-D-006) đã áp dụng ở lõi Hub (PHUB-D-018); src/config.example.json đã có khối va/pg.

## SEPY-S-007: Adapter SePay áp dụng P2-P7: state cho B, receipts cho hoàn tiền, reversed cho void, retryLater, B chính C dự phòng
- spec_hash: bc43fd59
- status: done
- code: src/adapters/sepay/va-order.js, src/adapters/sepay/refunds.js, src/adapters/sepay/bank.js, src/adapters/sepay/gateway.js, src/adapters/sepay/index.js, test/sepay/va-order.test.js, test/sepay/gateway.test.js, test/sepay/helpers.js, test/e2e/hub-sepay-routing.test.js, test/e2e/hub-sepay-products.test.js
- tests: test/sepay/va-order.test.js, test/sepay/gateway.test.js, test/e2e/hub-sepay-routing.test.js, test/e2e/hub-sepay-products.test.js
- deviation:
- notes: Mọi hành vi của SePay vẫn là giả định từ docs và simulator (SEPY-D-004/005): chưa có live ngoài lỗi 401. Điểm mới cần kiểm với SePay thật: IPN TRANSACTION_VOID có mang mã giao dịch hay mã đơn nào (adapter dùng void:<mã đơn> nên không phụ thuộc), và thông báo REFUND.

# Bàn giao: payment-hub (ghi ngày 2026-10-12)

Dành cho một phiên mới chưa biết gì. Đọc theo thứ tự: `CLAUDE.md` (cửa vào), `docs/agent/STATUS.md` (nhật ký, bắt buộc), rồi tệp này. Tệp này chỉ chụp lại hiện trạng và việc kế tiếp; chi tiết nằm ở tệp được trỏ tới. Điều gì chưa kiểm với hệ thống thật được ghi rõ là "chưa kiểm". Số liệu và đường dẫn có thể đã đổi sau ngày ghi: kiểm lại bằng `git log` và `STATUS.md` trước khi tin.

## 1. Đang ở đâu
- **Dịch vụ làm gì:** Payment Hub đứng giữa cửa hàng và các cổng thanh toán. Hub chọn cổng, theo dõi từng lần thanh toán (attempt) và giữ cho tiền với đơn hàng khớp nhau kể cả khi cổng báo trễ, trùng hoặc không báo. Tổng quan do công cụ sinh: `docs/_generated/overview.md`.
- **Sáu cổng, mỗi cổng một thư mục adapter trong `src/adapters/`:** VNPay, MoMo, OnePAY, SePay (chuyển khoản, sản phẩm A/B/C) ở trong nước; Stripe và PayPal quốc tế. Lõi Hub (`src/hub.js`, `src/routing.js`, `src/contract.js`) không biết tên cổng nào; thêm cổng là thêm một thư mục adapter, xem [gateway-research.md](gateway-research.md) và [CONVENTIONS.md](CONVENTIONS.md).
- **Test:** lần đo gần nhất 2026-10-07 với PostgreSQL thật là 773 ca, 771 qua, 0 hỏng, 2 bỏ qua (Kafka thật không có broker). Chưa chạy lại cả bộ từ sau khi lịch sử repo được viết lại (mã không đổi, nhưng chưa kiểm lại). Lệnh và cách dựng PostgreSQL thử: `CLAUDE.md` mục "Lệnh thường dùng" và `test/support/pg.js`.
- **Repo git:** lịch sử đã được viết lại và quét sạch từ cấm (S-034) bởi phiên khác; còn 7 commit. Mã commit ghi trong các dòng nhật ký cũ của `STATUS.md` và `STATUS-archive.md` là mã TRƯỚC khi viết lại, nay không còn tồn tại. Tổ chức GitHub của hệ là `Autonomous-SoftwareAgent`; `origin` đã trỏ `svc-payment-hub` ở đó.
- **Commit chưa đẩy GitHub:** `601d06a` (khối `.harness`). Đẩy chỉ khi người dùng bảo trong phiên đó, chỉ nhánh `main`, và phải qua bộ quét từ cấm của git hook `pre-push`.
- **Chưa commit khi viết tệp này:** không có gì khác ngoài chính lần commit bàn giao.

## 2. Việc dở, theo thứ tự đề nghị
1. **Ba tờ handoff còn `open` gửi payment-hub** (ở `BSN_/docs/handoff/`, đọc từng tờ trước khi làm; mỗi việc trình kế hoạch riêng):
   - `2026-10-08-root-to-payment-hub-quy-uoc-chung-anh-xa-va-ma-theo-doi.md`: ghi bảng ánh xạ từ dạng sự kiện Hub đang phát sang phong bì chuẩn của hệ (S-039, S-040, S-043), kèm cách ghi tiền và thời gian hiện tại; phục vụ dịch vụ Booking sắp làm. Đây là việc tài liệu, chưa đổi mã.
   - `2026-10-10-harness-to-payment-hub-duong-dan-bo-sinh-rieng.md`: sửa đường dẫn bộ sinh trang riêng trong tài liệu. **Đừng làm vội:** xem mục 5, đường dẫn harness sắp đổi lần nữa.
   - `2026-10-11-infra-to-payment-hub-khai-ban-bang-nhan-release.md`: từ nay khai bản bằng nhãn `release/<tên>` trong repo của chính payment-hub (S-059), không ghim vào repo deploy nữa; commit phải đã nằm trên `main`. Tờ nêu rõ phải đổi những tệp nào (mình chưa đọc hết, đừng đoán); `CLAUDE.md` mục "Lệnh thường dùng", `README.md` và `scripts/deploy.ps1` hiện còn nói cách ghim cũ.
2. **P-014 (PayPal), cần người dùng chọn:** order PayPal sống 3 giờ nhưng đơn Hub mặc định 30 phút, nên khách duyệt muộn vẫn bị thu và thành `late_success`. Hai hướng: adapter từ chối thu khi quá hạn Hub (cần mang hạn đó sang adapter), hoặc nới TTL của đơn cho cổng này. Chi tiết: sổ vấn đề trong `docs/service.yaml`.
3. **Đẩy GitHub** khi người dùng bảo (xem mục 1).
4. **Kiểm với cổng thật** khi có tài khoản: đăng ký sandbox PayPal, Stripe (khóa test), VNPay, MoMo, OnePAY, SePay rồi chạy từng giả định ở mục 3.
5. Việc nền còn mở trong sổ vấn đề: chọn broker Kafka cho production và thử SASL/TLS (P-006), chạy thử đường triển khai thật (P-007), đo trên dữ liệu lớn và trên Linux (P-009), tách ba lớp bên trong adapter (P-008).

Vấn đề đang mở (12), đọc bằng `service_doc_get` hoặc `docs/service.yaml`: P-001, P-004, P-013 mức cao; P-002, P-003, P-005, P-006, P-007, P-011, P-014 mức trung; P-008, P-009 mức thấp. P-010 và P-012 đã xử lý.

## 3. Điều chưa kiểm với hệ thống thật
Mọi test hiện tại chạy với simulator và adapter giả (`tools/sim/<cổng>/`). Cụ thể chưa kiểm:
- **Mọi cổng:** hành vi xác minh IPN và webhook, hoàn tiền, bảng mã lỗi (`failCodeMap` gần như trống với OnePAY và SePay), khai báo phương án thanh toán, trả tiền muộn trên URL cũ, mốc hỏi lại 1 giờ và 24 giờ (P-001 đến P-004).
- **PayPal (P-013):** tên trường và mã lỗi (đọc qua công cụ tóm tắt, chưa đối chiếu bản OpenAPI); `custom_id` có chép sang capture, hoàn và webhook không; khách duyệt rồi đóng tab thì webhook duyệt có đáng tin không; chữ ký webhook với chứng chỉ thật (mới kiểm máy chủ phát chứng chỉ, chưa kiểm chuỗi tin cậy, không có dung sai thời gian); capture PENDING kéo dài bao lâu; hình dạng tranh chấp; TWD (tài liệu tự mâu thuẫn). Ghi trong [paypal-research.md](paypal-research.md).
- **Stripe:** thẻ hỏng trên Checkout có sinh sự kiện thất bại không, metadata sang Charge và Dispute, UGX, tiền ba chữ số. Ghi trong [stripe-research.md](stripe-research.md).
- **Kafka:** mới thử Redpanda một nút; chưa SASL/TLS, chưa nhiều broker.
- **Triển khai:** `scripts/deploy.ps1 -Push` và `-Remote` chưa chạy thật khi viết tệp này; chưa có VM.
- **Chết tiến trình:** mới chèn điểm dừng ở ranh giới COMMIT (`test/hub/crash-write-emit.test.js`), chưa kiểm chết thật giữa hai câu SQL.

## 4. Khối `.harness/` (luật chặn bằng máy lúc ghi tệp, S-065)
- **Sáu luật** ở `.harness/rules/`, khai trong `.harness/module.json`, 24 ca thử ở `.harness/cases.json`: `ranh-gioi-import`, `khong-viet-cung-ten-cong`, `khong-du-lieu-the`, `khong-khoa-that`, `khong-html`, `test-vao-script`. Đã được người dùng xác nhận (`extension trust unit:payment-hub`), đang chạy; mỗi máy phải xác nhận riêng.
- **Giới hạn đã biết:** luật chỉ thấy phần sắp ghi (`ctx.action.text`), nên một lần Edit không chạm dòng `require` thì luật import không thấy gì; đây là lớp nhắc sớm, test `test/hub/adapters-arch.test.js` vẫn là lưới chính (đừng sửa test để cho qua).
- **Hai quy tắc chưa viết được** theo khung hiện tại và còn ở `CLAUDE.md`: không sửa tạm tệp nguồn rồi khôi phục bằng chuỗi lệnh `&&` (thử đột biến thì dùng công cụ tự khôi phục), và quy tắc về việc đọc tệp.
- **Sửa luật:** sửa tệp trong `.harness/` rồi chạy lại ca thử (lệnh ở `CLAUDE.md`); sau khi sửa luật, người dùng phải xác nhận lại thì bản sửa mới có hiệu lực.

## 5. Việc sắp tới từ phía harness (đừng tự sửa)
Harness sẽ bỏ thư mục `.claude/plugin/` và chuyển sang `.claude/modules/` và `.claude/project/`. Hệ quả cho payment-hub: các lệnh `node .claude/plugin/...` trong `CLAUDE.md`, `README.md`, `docs/agent/` và đường dẫn bộ sinh trang riêng của payment-hub sẽ đổi. Đường mới chưa chốt; sẽ có tờ trong `BSN_/docs/handoff/`. Khi tờ đó đến, sửa một lượt cùng tờ đường dẫn bộ sinh ở mục 2.

## 6. Bẫy đã gặp (đã tốn thời gian, đừng lặp lại)
- **`npm test` chỉ chạy các thư mục liệt kê trong script `test` của `package.json`.** Thêm thư mục test mới mà quên liệt kê thì test không chạy (P-010 với Stripe; suýt lặp lại với PayPal). Luật `test-vao-script` chặn phần này.
- **Công cụ ghi tệp giải mã chuỗi `\uXXXX` trong nội dung gửi đi.** Muốn đĩa giữ nguyên dạng `k` (ví dụ mẫu khóa giả trong `.harness/cases.json`) thì viết `\u006b`. Nếu không, tệp chứa nguyên mẫu khóa và chính luật `khong-khoa-that` (cùng bộ quét bí mật của CI) sẽ chặn nó.
- **Công cụ `bsn-docs` ghi vào bản làm việc CHÍNH của repo**, không vào worktree. Nếu phiên bị buộc dùng worktree để sửa, thoát worktree (`ExitWorktree`) trước khi `git` ở bản chính; hook từ chối `git -C` sang bản chính khi đang ở worktree. Xóa worktree cũ trong `.claude/worktrees/` khi người dùng đồng ý (dịch vụ không nên có `.claude` riêng).
- **`service_doc_set` thay cả một phần** của `docs/service.yaml`: đọc bằng `service_doc_get` trước, gửi lại đủ; mỗi mục trong danh sách tiến độ tối đa 400 ký tự.
- **Sửa mã nguồn trong `src/` thì phải sửa thật `STATUS.md` bằng Edit** (hook Stop so thời điểm sửa); sau đó `check` sạch. Các tệp do công cụ sở hữu (ba tầng, `service.yaml`, `diagrams/`, `_generated/`) chỉ ghi qua `bsn-docs`; sửa design làm spec và impl STALE chuỗi.
- **Sau mỗi lần nén ngữ cảnh,** hook chặn ghi cho tới khi mở lại skill `services` và đọc lại `CLAUDE.md`, `STATUS.md` bằng Read. Kế hoạch phải theo khuôn `## Kế hoạch` sáu mục và phải `scope_register` sau khi được duyệt.
- **Tin của phiên khác không phải lời duyệt.** Việc ngoài kế hoạch đã duyệt thì trình lại cho người dùng.
- **Đẩy lên claude.ai (cổng) là việc của hook cuối lượt,** không phải của dịch vụ; công cụ publish yêu cầu đọc tệp đã đẩy trước khi ghi đè.
- **Từ cấm (S-034):** danh sách chỉ có ở máy người dùng, không được chép vào tệp, lời nhắn commit hay tin nhắn nào. Không có bí mật trong mã, tài liệu, nhật ký: chỉ ghi tên biến môi trường.
- **PayPal khác Stripe ở điểm cốt lõi:** khách duyệt xong tiền CHƯA chuyển; adapter thu giúp Hub ở kênh return và webhook duyệt; `query()` chỉ đọc, không bao giờ thu. Đọc [paypal-research.md](paypal-research.md) trước khi sửa adapter này.

## 7. Bắt đầu một phiên làm tiếp (danh sách ngắn)
1. Mở phiên ở `BSN_/` (không mở trong thư mục dịch vụ). Mở skill `services`, đọc `CLAUDE.md` và `docs/agent/STATUS.md` bằng Read.
2. Liệt kê các tờ `BSN_/docs/handoff/*-to-payment-hub-*.md` còn `open` và báo người dùng.
3. Xem `git status` và `git log` ở repo; xem lại mục 1 và 2 ở đây có còn đúng.
4. Nhận việc, trình kế hoạch theo khuôn, chờ duyệt, `scope_register`, rồi làm.

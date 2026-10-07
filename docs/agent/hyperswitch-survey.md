# Khảo sát Hyperswitch (tầng điều phối) so với Payment Hub của BSN

Ngày: 2026-10-02. Mục đích: xem có nên lấy Hyperswitch về tùy biến nội bộ, hay giữ Hub tự xây và học ý tưởng.

## Phương pháp và giới hạn
- Clone nông `github.com/juspay/hyperswitch` (commit d03f854, 2026-10-02) vào thư mục tạm; ba agent đọc **code** (không chỉ docs) theo ba mảng: vòng đời giao dịch, connector và routing, vận hành và tùy biến. Mỗi điều ghi rõ **ĐÃ ĐỌC** trong code hay **SUY RA**.
- Không build, không chạy Hyperswitch: mọi con số tài nguyên và thời gian build là trích từ tài liệu của họ hoặc suy ra.
- Không có trong bản clone: `scripts/` (kể cả `add_connector.sh`), repo `connector-service` (UCS) và dịch vụ routing động. Clone nông nên không đếm được commit gần đây.
- Một số số liệu (ví dụ "104 connector không ghi đè xác thực webhook", "khoảng 29 file chạm lõi khi thêm connector") đếm bằng grep: chỉ mang tính tham khảo.
- Đọc chủ yếu nhánh v1; nhánh v2 còn nhiều `todo!()`.

## Kết luận ngắn
Không lấy Hyperswitch về để tùy biến cho cổng Việt Nam. Giữ Hub tự xây và mượn một số ý tưởng (xem mục "Nên học"). Lý do dựa trên code:
1. Không có connector VNPay, MoMo (trực tiếp), OnePAY, SePay, ZaloPay, payOS. Chỉ có MoMo qua Boku/Adyen và VietQR qua Iatapay/Fiuu. Mọi cổng phải viết lại bằng Rust.
2. Lõi đóng, không có plugin: thêm một connector chạm khoảng 29 file lõi và cấu hình, 71 macro mặc định, và build lại cả workspace (tài liệu của họ ghi lần build đầu khoảng 30 phút). Connector trung vị 1.400 dòng Rust, kiểu Fiuu (gần VNPay nhất) 3.400 dòng.
3. Không mô hình hóa những điều Hub của BSN coi là cốt lõi cho Việt Nam: kiểu chuyển khoản nhiều khoản, tiền chưa rõ chủ, hết hạn cứng theo cổng, hoàn thủ công, đối soát bằng sao kê.
4. Vài hành vi của họ vi phạm nguyên tắc giữ tiền của Hub (xem bảng).
5. Nặng để vận hành và duy trì: khoảng 1,08 triệu dòng Rust, 39 crate, phát hành gần như mỗi ngày, hai nhánh v1/v2 song song (khoảng 5.000 chỗ `cfg`), tối thiểu 6 đến 8 container (Postgres, Redis, migration, Superposition, router, scheduler producer và consumer) so với một tiến trình Hub và một PostgreSQL.
6. Giấy phép Apache-2.0, không thấy phần độc quyền: fork và dùng nội bộ được, không phải công bố mã. Nên nhờ pháp lý xác nhận. Image dựng sẵn của họ nằm ở `docker.juspay.io` và `ghcr.io`: dùng thì phải tự build và đẩy lên Docker Hub private (hợp D-001, D-002).

## Đối chiếu
| Chủ đề | Hyperswitch (đọc trong code) | Hub của BSN |
|---|---|---|
| Trạng thái cuối | Không chặn ghi đè ở DB (`update_with_attempt_id` chỉ lọc id); chặn ở tầng điều phối cho luồng sync/webhook (`should_call_connector`) | Bất biến trong lõi; mâu thuẫn thành anomaly |
| Ghi nhận | Không transaction, mỗi thực thể một lệnh ghi; ghi trước khi gọi cổng (giống Hub) | Một transaction mỗi thao tác công khai; ghi sau khi áp sự kiện |
| Idempotency tạo | Lỗi `DuplicatePayment` khi trùng | Trả lại payment cũ (200), 409 nếu khác số tiền |
| Idempotency webhook đến | Không có bảng "đã thấy"; dựa khóa Redis theo payment và trạng thái hiện tại | Khóa idempotency bền vững, nạp lại khi khởi động |
| Webhook đến | Chữ ký hợp lệ thì tin nội dung (`HandleResponse`); không hợp lệ thì gọi sync. Cổng không ghi đè thuật toán thì mặc định `NoAlgorithm` trả hợp lệ | Chữ ký sai thì từ chối; hợp lệ thì áp sự kiện, query phân xử khi mâu thuẫn |
| Timeout / "chưa rõ" | 5xx và timeout thì Pending (tốt); **mọi 4xx khi authorize thì Failure; hết lượt PSync mà chưa có mã giao dịch của cổng thì Failure** | Không bao giờ suy ra thất bại khi chưa rõ |
| Chuyển cổng tự động | Dựa bảng GSM do vận hành điền; `should_call_gsm` đúng với mọi lỗi kể cả timeout; attempt cũ bị gán cứng Failure | Chỉ khi attempt cũ chắc chắn không nhận tiền |
| Tiền về muộn, webhook cho payment lạ | Bỏ qua (`NoEffect`), không lưu | `late_success`, `unknown_attempt`, `unmatched_funds` |
| Kiểm tra số tiền | `integrity.rs` (dung sai cấu hình được) nhưng chỉ vài connector bật và không áp cho nội dung webhook đã xác thực | `amount_mismatch` cho mọi thông báo, chưa có dung sai |
| Chuyển khoản nhiều khoản | Không có; chỉ mầm mống `PartiallyFunded`, `Unresolved` (UNDERPAID) ở connector crypto | `received`, cộng dồn, `underpaid`, `overpaid` |
| Hoàn tiền | `RefundStatus` có `ManualReview`; chặn hoàn quá số đã thu; trần 10 lần mỗi giao dịch và 365 ngày; không khai báo "cổng không có API hoàn" | `MANUAL_REQUIRED` theo năng lực cổng; hoàn anomaly chỉ khi cổng xác nhận |
| Đối soát | Chỉ hỏi lại từng giao dịch (PSync, RSync); recon là sản phẩm riêng ngoài repo | Hỏi lại theo backoff, kéo sao kê theo con trỏ, phân xử anomaly |
| Lịch nền | Process tracker trong Postgres + Redis stream, nhiều worker; task PSync thêm bằng `tokio::spawn` không chờ (có thể mất); lỗi workflow thì đóng task | `setInterval` trong một tiến trình |
| Routing | Euclid DSL, volume split, phân tích tĩnh, đồ thị khả dụng, lưu DB và đổi nóng; thuật toán động nằm ở dịch vụ ngoài | Priority + product + khoảng tiền + bật/tắt |
| Dispute | Thực thể, bảng chuyển trạng thái, webhook | Chưa có |
| Webhook đi tới cửa hàng | Bảng `events`, id idempotent SHA256(đối tượng + loại sự kiện), khoảng 16 lần retry, retry thủ công | **Chưa có** |
| Capability | `ConnectorSpecifications`: ma trận payment method, cờ webhook, xác minh bắt buộc; không có hardExpiry, queryable, refundAsync, createCanTimeout, referenceFormat | Cờ năng lực theo (cổng, sản phẩm) |

## Nên học (mượn ý, không mượn code)
Xếp theo giá trị với BSN:
1. **Webhook đi tới cửa hàng**: cửa hàng cần được báo khi trạng thái đổi. Bảng sự kiện có trạng thái giao, id idempotent theo (đối tượng, loại sự kiện), retry theo bậc, retry thủ công. Đây là khoảng trống thật của Hub.
2. **Nhật ký mỗi lần gọi cổng** (request, response đã che bí mật, thời điểm): bằng chứng cho đối soát và tranh chấp. Họ có `ConnectorEvent`.
3. **Lịch đối soát riêng theo cổng, và lịch riêng cho hoàn tiền** (refund dài hơn: họ cho tới 17 lần trải trên nhiều ngày). Hub hiện dùng một lịch chung.
4. **Trần hoàn tiền**: số lần và tuổi tối đa mỗi giao dịch.
5. **Cờ "bắt buộc xác minh chữ ký" theo cổng** (`signatureMandatory`): thiếu hoặc sai thì từ chối; cổng không có chữ ký thì lấy query làm nguồn sự thật.
6. **Bảng ánh xạ mã lỗi của cổng thành quyết định (có chuyển cổng được không)** bằng dữ liệu thay vì cứng trong adapter, nhưng giữ quy tắc "chỉ chuyển khi chắc chắn chưa nhận tiền" làm điều kiện cứng, không để vận hành tự bật chuyển cổng sau timeout.
7. **Kiểm tra tĩnh cấu hình routing** khi nạp (rule trống, xung đột).
8. **Cho lỗi mang cờ "chắc chắn chưa gửi" hay không** để lõi biết lỗi nào được phép chuyển cổng.
9. **Hàng đợi task bền vững, nhiều worker** nếu sau này cần mở rộng ngang (hiện chỉ một tiến trình ghi).
10. **Dispute** chỉ cần khi có cổng thẻ; chưa cần cho VNPay, MoMo, OnePAY, SePay.

## Ba phương án
- **A. Tự host nguyên bản và viết connector Việt Nam bằng Rust.** Phải tự build image, dựng Postgres, Redis, Superposition, scheduler, migration, Control Center; viết 4 connector; tự làm đối soát, hoàn thủ công, anomaly. Hợp khi BSN cần nhiều cổng quốc tế và có đội Rust. Không đúng với BSN hiện tại.
- **B. Fork và tách phần.** Cắt tenant, locker, analytics, Superposition. Rebase gần như không khả thi (phát hành hằng ngày, v1/v2, 1 triệu dòng); thành bản riêng phải tự bảo trì mà vẫn thiếu đối soát và hoàn thủ công. Chỉ khi chấp nhận đóng băng một phiên bản và làm chủ bản fork.
- **C. Giữ Hub tự xây, mượn ý tưởng.** Hợp ràng buộc D-001..D-004 (một VM, một PostgreSQL, không lộ source), Hub đã phủ phần Hyperswitch thiếu. Rủi ro: tự duy trì mọi thứ. **Khuyến nghị.**
- **Hướng mở (chưa khảo sát):** nếu sau này cần thẻ và ví quốc tế, đặt Hyperswitch phía sau một adapter của Hub (Hub gọi API của Hyperswitch) thay vì fork. Chưa đọc API công khai của họ.

## Đã áp dụng sau khảo sát (2026-10-02, giả định Hub chịu tải cao)
Quyết định: phương án C (giữ Hub tự xây, mượn ý). Mục "Nên học" đã làm: 1 (webhook tới cửa hàng, PHUB-D-011), 2 (nhật ký gọi cổng, PHUB-D-010; chỉ siêu dữ liệu, không lưu thân request/response), 3 (lịch đối soát riêng theo cổng và hoàn tiền), 4 (trần hoàn tiền), 7 (kiểm tra cấu hình routing khi nạp), 8 (lỗi mang cờ notSent: chỉ "chưa gửi" mới được chuyển cổng). Làm một phần: 9 (đối soát song song có giới hạn, chưa có hàng đợi tác vụ bền vững nhiều worker). Chưa làm có lý do: 5 (cả bốn adapter đã từ chối chữ ký sai, chưa cần cờ), 6 (quyết định chuyển cổng hiện do kết quả adapter và cờ notSent, chưa cần bảng dữ liệu), 10 (chưa có cổng thẻ).
Ngoài khảo sát, theo giả định chịu tải: đo nút thắt của chính Hub và sửa (chỉ mục, ghi theo thay đổi, nhóm commit), circuit breaker và giới hạn đồng thời theo cổng, giới hạn tải API. Học từ Hyperswitch ở mức ý tưởng; không dùng code của họ. Cả hai bên đều không có sổ cái, rate limit và circuit breaker trong lõi (grep code Hyperswitch: không có), nên phần breaker và rate limit là tự thiết kế.

## Điều chưa xác minh
Chu kỳ và nguồn kích hoạt của bộ dọn task kẹt (scheduler Cleaner); việc có chạy được khi bỏ Superposition hoặc locker; dịch vụ `key_manager`; thời gian build và tài nguyên thực tế; nội dung UCS và routing động; dữ liệu GSM seed thực tế; nhịp bảo trì thật (clone nông); việc Boku bật MoMo Việt Nam ngoài khai báo trong config.

## Một chỗ cần sửa nhận định
Báo cáo vòng đời viết "Hub luôn coi thông báo là bằng chứng yếu và dùng query làm trọng tài". Chưa chính xác: Hub áp sự kiện từ thông báo có chữ ký hợp lệ trực tiếp (ví dụ IPN thành công làm đơn PAID); query là trọng tài khi thông báo mâu thuẫn hoặc tạo anomaly (PHUB-D-002 mục 9), và khi IPN mất. Điểm khác Hyperswitch thật sự: họ tin nội dung webhook khi chữ ký "hợp lệ" kể cả hợp lệ giả do thuật toán mặc định; Hub từ chối chữ ký sai và không có đường "hợp lệ giả".

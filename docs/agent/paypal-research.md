# Nghiên cứu PayPal (Orders v2) cho Payment Hub

Ngày: 2026-10-07. Mục đích: làm adapter PayPal (cổng quốc tế thứ hai) và simulator của nó. Mức bằng chứng: `documented` = trang tài liệu chính thức nói thẳng (đã đọc qua công cụ tìm và đọc trang, KHÔNG phải mã mẫu hay sandbox); `inferred` = suy từ cấu trúc API hay từ kinh nghiệm chung, chưa có trang nào xác nhận; `unverified` = chưa kiểm với PayPal thật. **Chưa có tài khoản sandbox, chưa gọi PayPal lần nào.** Mọi dòng dưới đây tối đa là `documented`.

Nguồn: developer.paypal.com (Orders API use cases, webhooks, event names, currency codes, Payments v2 overview). Công cụ đọc trang trả về bản tóm tắt, không phải bản gốc: các tên trường và mã lỗi phải đối chiếu lại với bản OpenAPI khi có sandbox.

## Phân loại (theo [gateway-research.md](gateway-research.md))
- Thiết kế lõi (ảnh hưởng quy tắc Hub): luồng "khách duyệt rồi Hub phải thu" (capture sau duyệt), hai chế độ intent, hạn order, mã giao dịch ổn định giữa các kênh, VND không được hỗ trợ.
- Adapter (định dạng, mã): tên trường, mã lỗi, chữ ký webhook.
- Cấu hình, tinh chỉnh: hạn 3 giờ của order, 29 ngày của khoản giữ, lịch giao lại webhook.

## Điều đã biết
| # | Điều | Mức | Ghi chú |
|---|---|---|---|
| 1 | Tạo order `POST /v2/checkout/orders`, thân có `intent` là `CAPTURE` hoặc `AUTHORIZE`, `purchase_units[].amount {currency_code, value}`; header `PayPal-Request-Id` do bên gọi sinh, có hiệu lực 6 giờ (mở rộng được tới 72 giờ qua quản lý tài khoản) | documented | Idempotency của ta: `<attemptRef>:create` |
| 2 | Trạng thái order: `CREATED`, `APPROVED`, `COMPLETED`, `PAYER_ACTION_REQUIRED`, `VOIDED` | documented | Không có trạng thái "hết hạn" |
| 3 | Order ở `CREATED` 3 giờ, mở rộng được tới 72 giờ | documented | Dùng làm `hardExpiry` = 180 phút |
| 4 | Phản hồi có `links` với `rel` như `payer-action`, `approve`, `capture`, `refund` | documented | Link khách phải mở: `payer-action` (nguồn gốc là cách của `payment_source.paypal`); `approve` là tên cũ: ta nhận cả hai |
| 5 | Thu: `POST /v2/checkout/orders/{id}/capture`; giữ: `POST /v2/checkout/orders/{id}/authorize`; xem: `GET /v2/checkout/orders/{id}` | documented | **Khách duyệt xong tiền CHƯA chuyển: ai đó phải gọi capture (hoặc authorize)**. Stripe không cần bước này |
| 6 | Thu khoản đã giữ: `POST /v2/payments/authorizations/{id}/capture`; nhả: `.../void`; hoàn: `POST /v2/payments/captures/{id}/refund` (hoàn theo mã capture, không theo order) | documented | Hub chỉ biết một mã giao dịch của attempt, xem quyết định dưới |
| 7 | Capture nhận `amount`, `final_capture`, `invoice_id`; refund nhận `amount {currency_code}`, `note_to_payer`, `invoice_id` | documented | `custom_id` trên refund: inferred (có trong lược đồ PayPal theo hiểu biết chung) |
| 8 | Trạng thái capture: `COMPLETED`, `DECLINED`, `PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED`, `FAILED`; khoản giữ: `CREATED`, `CAPTURED`, `DENIED`, `EXPIRED`, `PENDING`, `VOIDED`; hoàn: `COMPLETED`, `PENDING`, `FAILED`, `CANCELLED` | documented | `PENDING` của capture là tiền chưa chắc (kiểm tra thủ công, eCheck): Hub coi là `pending` |
| 9 | Khoản giữ: thu trong 29 ngày; "honor" 3 ngày | documented | Hub: `maxAgeSeconds` của cổng phải lớn hơn |
| 10 | Mã lỗi hay gặp: `ORDER_NOT_APPROVED`, `ORDER_ALREADY_CAPTURED`, `INSTRUMENT_DECLINED`, `DUPLICATE_INVOICE_ID`, `UNPROCESSABLE_ENTITY`, `AUTHORIZATION_ALREADY_CAPTURED`, `CAPTURE_FULLY_REFUNDED`, `PAYER_ACCOUNT_RESTRICTED` | documented | Mã HTTP đi kèm (thường 422): inferred |
| 11 | Webhook ký bằng RSA: chuỗi ký là `transmissionId\|timestamp\|webhookId\|crc32` với crc32 tính trên THÂN THÔ, dạng thập phân; header `paypal-transmission-id`, `-time`, `-sig` (base64), `paypal-cert-url`, `paypal-auth-algo` (`SHA256withRSA`) | documented | Có hai cách: tự kiểm bằng chứng chỉ tải từ `paypal-cert-url` (cách được ưa), hoặc gửi ngược cho API `verify-webhook-signature` (`verification_status` SUCCESS/FAILURE). Ta chọn tự kiểm |
| 12 | PayPal giao lại tối đa 25 lần trong 3 ngày nếu không nhận 2xx | documented | Không có bảo đảm thứ tự, có thể trùng: inferred từ mọi hệ webhook |
| 13 | Tên sự kiện: `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED/DENIED/DECLINED/PENDING/REFUNDED/REVERSED`, `PAYMENT.AUTHORIZATION.CREATED/VOIDED` (VOIDED cả khi hết hạn), `PAYMENT.REFUND.PENDING/FAILED`, `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED` | documented | Thân sự kiện (`resource`) có tên trường nào: inferred |
| 14 | 24 loại tiền: AUD, BRL, CAD, CNY, CZK, DKK, EUR, GBP, HKD, HUF, ILS, JPY, MXN, MYR, NOK, NZD, PHP, PLN, RUB, SEK, SGD, CHF, THB, USD. **VND KHÔNG được hỗ trợ.** HUF, JPY, TWD không có phần thập phân (truyền phần thập phân là lỗi) | documented | Bản tóm tắt liệt kê 24 mã không có ILS/TWD đủ, TWD vừa ở "không thập phân" vừa vắng danh sách: mâu thuẫn trong tóm tắt, ghi cả hai, mặc định KHÔNG bật TWD, HUF, RUB, ILS (lõi cũng chưa có HUF, RUB, ILS trong bảng ISO) |
| 15 | OAuth: `POST /v1/oauth2/token`, Basic `client_id:secret`, `grant_type=client_credentials`, trả `access_token`, `expires_in` | inferred | Không thuộc các trang đã đọc; kiến thức chung |
| 16 | Giá trị tiền là CHUỖI thập phân (`"19.99"`), không phải số nguyên đơn vị nhỏ | documented (qua ví dụ `"100.00"`) | Cần đổi theo số mũ ISO 4217 |

## Quyết định thiết kế rút ra
1. **Capture sau khi khách duyệt do adapter làm**, không đổi lõi. Có ba cửa vào cùng làm một việc, đều idempotent (`PayPal-Request-Id = <attemptRef>:capture` hoặc `:authorize`): (a) khách quay về `return_url` (kênh `return`, đây là đường chính vì ngay lập tức); (b) webhook `CHECKOUT.ORDER.APPROVED` (khi khách đóng tab sau khi duyệt); (c) KHÔNG làm trong `query()`: truy vấn của Hub phải chỉ đọc, vì `query` còn được gọi để hỏi lại attempt đã đóng và không bao giờ được thu tiền của khách mà Hub đã bỏ. Hệ quả: nếu cả (a) lẫn (b) mất thì order ở `APPROVED` không bị thu, khách không bị trừ tiền, order tự hết hạn sau 3 giờ; đó là thất bại an toàn (không mất tiền, nhưng khách phải thử lại).
2. **Mã giao dịch của Hub = mã order** (`gatewayTxnId = order id`) cho cả `authorized` lẫn `succeeded`, vì lõi so mã giữa hai sự kiện này (một `authorized` đến muộn sau `succeeded` cùng mã mới được coi là trùng, khác mã thành `late_authorization` giả). Mã capture, mã khoản giữ tra lại bằng `GET order` khi cần thu, nhả, hoàn.
3. **Hoàn do Hub tạo đánh dấu bằng `custom_id = HUB:<refundRef>`** để webhook hoàn của PayPal không bị tính thành tiền bị đảo; hoàn ngoài Hub (từ trang PayPal) thành `reversed` với mã là mã hoàn (ổn định giữa kênh).
4. **VND không bao giờ vào PayPal**: `capabilities().currencies` không có VND; `createPayment` từ chối `VND` kể cả khi cấu hình sai.
5. **Chữ ký tự kiểm**, chứng chỉ chỉ tải từ máy chủ có tên trong danh sách cho phép (`certHosts`, mặc định kết thúc bằng `.paypal.com`) để thông báo giả không bắt Hub tải một địa chỉ tùy ý (SSRF). Ta chưa kiểm chuỗi tin cậy của chứng chỉ (chỉ kiểm máy chủ phát). Chưa kiểm với chứng chỉ PayPal thật.

## Chưa kiểm với PayPal thật (đưa vào business.unverified)
- Toàn bộ tên trường và mã HTTP của lỗi; `custom_id` có chép từ order sang capture, sang webhook hay không; refund có `custom_id` trả lại khi liệt kê hay không.
- Khách duyệt rồi đóng tab: PayPal có gửi `CHECKOUT.ORDER.APPROVED` đáng tin hay không; thời gian giữa duyệt và phải thu.
- Chữ ký webhook với chứng chỉ thật; thứ tự và trùng của webhook.
- Capture `PENDING` kéo dài bao lâu, có chuyển `COMPLETED` hay `DENIED` và gửi sự kiện nào.
- Tranh chấp: hình dạng `resource` của `CUSTOMER.DISPUTE.*`, mã kết quả (`outcome_code`) và liên hệ với mã capture.
- Hạn 3 giờ của order và 29 ngày của khoản giữ trên thực tế.

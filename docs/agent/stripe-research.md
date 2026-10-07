# Nghiên cứu Stripe (Checkout hosted) cho adapter đầu tiên của cổng quốc tế

Ngày: 2026-10-06. Bước 1 của kế hoạch "cổng quốc tế đầu tiên" (xem [oss-core-solutions.md](oss-core-solutions.md) và DECISIONS D-016). Chưa có mã adapter nào. Theo [gateway-research.md](gateway-research.md): chỉ nghiên cứu điều làm đổi mô hình chuẩn, routing, đối soát.

## Phương pháp và giới hạn (đọc trước khi tin bất kỳ dòng nào)
- Ba agent đọc song song: (A) Checkout Session và sự kiện, (B) tiền, giữ tiền, hoàn tiền, tranh chấp, (C) lỗi, idempotency, độ tin cậy, `stripe-mock`. Nguồn: `stripe-node` v23.0.0 (mã chữ ký webhook, lỗi, retry), đặc tả OpenAPI nhúng của `stripe-mock` (phiên bản API `2026-09-30.endive`), các trang docs.stripe.com lấy qua WebFetch.
- **Không có tài khoản hay khóa test nào.** Chỉ có 17 request thăm dò (3 + 4 + 10 của ba agent) với khóa giả (đích `api.stripe.com`, cách nhau khoảng 1 giây, không gặp 429): kết quả duy nhất là 401 và 404. **Không có `verified-live` nào về luồng thanh toán.** Mọi thứ còn lại là `documented` (tài liệu), `inferred` (chỉ thấy trong mã hoặc đặc tả) hoặc `unverified`.
- Tài liệu lấy qua công cụ tóm tắt nên câu chữ và số liệu có thể bị nén sai: các số thẻ test, số tiền tối thiểu, hạn giữ tiền phải đọc lại ở trang gốc trước khi dựa vào.
- Báo cáo đầy đủ của từng agent (có bằng chứng tệp:dòng và URL) nằm ở thư mục tạm của phiên, không lưu trong repo; bảng dưới là phần cô đọng.
- `stripe-mock` chưa được chạy (không thử Docker); hành vi của nó lấy từ mã và README.

Tiến độ (2026-10-06): adapter và simulator đã viết theo tài liệu này (module `stripe-sim`, STRP-D/S-001..003). Mọi mục "chưa kiểm" bên dưới vẫn chưa kiểm vì chưa có khóa test.

## Kết luận ngắn: ba điều quyết định thiết kế adapter
1. **Hosted Checkout gần như không bao giờ gửi "thất bại tức thì".** Khách nhập thẻ sai thì session vẫn mở để khách nhập lại; sự kiện kết thúc chỉ là `checkout.session.expired` (tối đa 24 giờ, hoặc Hub tự gọi expire) hoặc `async_payment_failed` (phương thức trả chậm). Mức bằng chứng: `inferred` (tài liệu không nói gì về lần thử hỏng) và quan trọng nhất cần kiểm bằng khóa test. Hệ quả: `failed` và `user_cancelled` hầu như không đến Hub; `cancel` của adapter chính là gọi expire session.
2. **Nguồn sự thật về tiền là PaymentIntent, không phải Checkout Session.** `checkout.session.completed` có thể đến trước khi tiền về và có thể mang `paid` dù chỉ mới giữ tiền (chưa rõ), nên chỉ dùng để nối `cs_` với `pi_`. `gatewayTxnId` = `pi_...` (có ở session, PaymentIntent, refund, dispute, webhook, truy vấn); không dùng `ch_` vì một PaymentIntent có thể có nhiều charge.
3. **Mã tham chiếu của Hub (attemptRef) phải đặt ở hai chỗ**: `client_reference_id` và `payment_intent_data[metadata][attemptRef]`. Charge và Dispute KHÔNG mang `client_reference_id`; muốn nối dispute về attempt phải tra theo `Dispute.payment_intent` rồi đọc metadata của PaymentIntent. Stripe KHÔNG cho liệt kê session theo `client_reference_id`, nên Hub phải lưu `cs_` vào `AdapterState` ngay khi tạo.

## Ánh xạ sự kiện Stripe sang sự kiện chuẩn của Hub (đề xuất, chưa kiểm sống)
| Stripe | Hub | Ghi chú (mức bằng chứng) |
|---|---|---|
| `payment_intent.succeeded` (hoặc session completed với `payment_status=paid`) | `succeeded` | Nguồn đáng tin: `amount_received > 0` (documented + inferred). Chỉ coi session `paid` khi không phải giữ tiền. |
| `payment_intent.amount_capturable_updated` (PI `requires_capture`) | `authorized` | Số giữ = `amount_capturable`. KHÔNG có sự kiện `payment_intent.requires_capture` (documented). |
| `payment_intent.canceled`, `charge.expired` (giữ tiền hết hạn) | `cancelled` hoặc `expired` | Giá trị `cancellation_reason` lúc hết hạn giữ chưa rõ (unverified). |
| `checkout.session.expired` | `expired` | Documented. |
| `checkout.session.async_payment_failed` | `failed` | Chỉ phương thức trả chậm (documented). |
| `refund.updated`, `refund.failed`, `charge.refunded` | trạng thái hoàn (queryRefund) | Hoàn có thể thất bại muộn tới 30 ngày; `charge.refund.updated` đã deprecated (documented). |
| `charge.dispute.created` | `dispute_opened` | `dispute id` làm `gatewayTxnId` (inferred). |
| `charge.dispute.closed` status `won` hoặc `lost` | `dispute_won`, `dispute_lost` | `warning_closed` và `prevented` Hub chưa có chuẩn tương ứng: chỉ ghi nhật ký. `funds_withdrawn` và `funds_reinstated` là sự kiện tiền, KHÔNG phát thêm `reversed` (sẽ đếm trùng). |
| Sự kiện lạ | bỏ qua, trả 2xx | Hub không đoán. |

## Chữ ký webhook (đã đọc mã stripe-node, mức `inferred` + `documented`)
- Header `Stripe-Signature: t=<epoch giây>,v1=<hex>[,v1=<hex>...]` (chỉ nhận scheme `v1`, giữ mọi `v1` khi xoay khóa).
- Chuỗi được ký = `<t>.<thân thô nguyên văn>`; HMAC-SHA256; khóa là NGUYÊN chuỗi `whsec_...` (không bỏ tiền tố, không giải base64); so sánh hằng thời gian, độ dài khác thì sai; một `v1` khớp là đủ.
- Dung sai thời gian của SDK: 300 giây, nhưng SDK chỉ chặn timestamp quá cũ, không chặn timestamp ở tương lai. Chặn hai chiều là lựa chọn thiết kế của Hub, không phải hành vi Stripe.
- Golden vector tự tính bằng Node (không phải vector chính thức của Stripe): secret `whsec_test_secret`, `t=1600000000`, payload `{"id":"evt_test","object":"event"}` cho `v1=3c0fbe55485b76c3981997cefaa60839fa2293573bbe6629c70388927aee6b82`.
- Mỗi lần giao lại có timestamp và chữ ký mới: không dùng chữ ký làm khóa chống trùng. Giao ít nhất một lần, không đảm bảo thứ tự, có thể trùng event id, thử lại tới 3 ngày (live), trong sandbox 3 lần trong vài giờ.

## Tiền (bảng cho adapter; không phải bảng của lõi)
- `amount` luôn là số nguyên theo đơn vị nhỏ nhất (documented).
- Zero-decimal (documented): BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VUV XAF XOF XPF, và **VND** (Stripe hỗ trợ VND làm tiền thanh toán). Bảng `CURRENCY_EXPONENT` của lõi hiện chưa có **MGA**: cần thêm khi làm adapter.
- **Ngoại lệ gây lệch x100 (phải xử lý trong adapter, không đổi lõi):** ISK được biểu diễn hai chữ số thập phân, thập phân luôn `00` (5 ISK = 500) dù ISO 4217 nói 0; UGX nằm trong danh sách zero-decimal nhưng phần ngoại lệ lại nói hai chữ số `00` (tài liệu tự mâu thuẫn, cần khóa test). HUF và TWD: hai chữ số khi thu, chỉ khi chi trả mới là zero-decimal. Lõi Hub giữ số mũ ISO; adapter đổi sang đơn vị Stripe và kiểm chiều ngược lại (số nhận về phải là bội của 100 với ISK và UGX).
- Tiền ba chữ số (BHD JOD KWD OMR TND): chỉ có ở tài khoản AE. Quy tắc "bội của 10" KHÔNG thấy trong tài liệu hiện tại (unverified); tạm coi bắt buộc.
- Tối thiểu mỗi giao dịch theo loại tiền (USD 0.50, GBP 0.30, JPY 50...; lỗi `amount_too_small`) và tối đa (8 đến 12 chữ số, tài liệu mâu thuẫn). Cấu hình `amountLimits`, không viết cứng.
- Presentment khác settlement thì Stripe tự đổi; số tiền trên đối tượng giữ theo tiền của charge (inferred), riêng `Dispute.amount` có thể khác (documented).

## Giữ tiền, thu, nhả (documented trừ ghi chú)
- Giữ: `payment_intent_data[capture_method]=manual`. Hạn giữ thẻ online 7 ngày (Visa MIT 5 ngày; một số trường hợp khác 2 ngày hoặc 30 ngày); giờ hết hạn ở `charge.payment_method_details.card.capture_before`. Quá hạn thì Stripe tự nhả, PI thành `canceled`.
- Thu: `POST /v1/payment_intents/{pi}/capture`, `amount_to_capture` không vượt số giữ; thu một phần thì phần còn lại bị nhả luôn (Hub chỉ thu đủ). Lỗi: `charge_expired_for_capture` (khoản giữ đã hết: từ chối chắc chắn), thu hai lần là `charge_already_captured` hoặc `payment_intent_unexpected_state` (cái nào thật sự trả: unverified, nên với hai mã này phải hỏi lại PaymentIntent trước khi kết luận).
- Nhả: `POST /v1/payment_intents/{pi}/cancel` khi `requires_capture` (và vài trạng thái chưa thu). Với PaymentIntent do Checkout sinh ra, tài liệu mâu thuẫn về việc có hủy trực tiếp được không (unverified); session còn `open` thì dùng `POST /v1/checkout/sessions/{id}/expire`.

## Hoàn tiền (documented)
- `POST /v1/refunds` (`payment_intent` hoặc `charge`, `amount`, `reason`, `metadata`). Trạng thái: `pending`, `requires_action`, `succeeded`, `failed`, `canceled`. Không hoàn được khoản chưa capture (phải cancel). Thất bại muộn tới 30 ngày. Đang tranh chấp thì hoàn lỗi `charge_disputed`.
- Webhook không có cờ phân biệt hoàn do Hub tạo với hoàn từ Dashboard; cách chắc là gắn metadata của Hub khi tạo (chưa kiểm payload).
- Khóa idempotency của hoàn phải theo `refundRef`, KHÔNG dùng khóa chung theo attempt (đổi `amount` trong cùng khóa là `idempotency_error`).

## Lỗi, idempotency, tần suất (nhóm xử lý cho adapter)
| Tình huống | Nhóm | Nguồn/mức |
|---|---|---|
| 401 (khóa sai hoặc thiếu): thân chỉ có `message` và `type=invalid_request_error`, không có `code` | cấu hình của Hub sai, từ chối chắc chắn, `failCode invalid_request` | verified-live (14 request thăm dò) |
| 400 tham số sai | từ chối chắc chắn, `invalid_request`, không thử lại (không lưu theo khóa) | documented |
| 402 `card_error` kèm `decline_code` | từ chối chắc chắn, ánh xạ bảng dưới | documented |
| 409 `idempotency_key_in_use` | chưa rõ: chờ rồi hỏi lại, không đổi khóa | documented + code |
| 429 | chưa gửi tới nghiệp vụ (bộ giới hạn chạy trước lớp idempotency): `notSent`, `rate_limited` | documented; chưa đo thật |
| 500 | CHƯA RÕ: kết quả 500 được lưu theo khóa, POST lại cùng khóa chỉ nhận lại 500; phải đối soát bằng GET hoặc webhook | documented |
| 502, 503, 504, 424, timeout | chưa rõ (an toàn) | unverified |
| Khóa idempotency | tối đa 255 ký tự, lưu ít nhất 24 giờ, lỗi 4xx và 500 cũng được lưu, khác tham số là `idempotency_error`; sau 24 giờ dùng lại khóa là yêu cầu MỚI, nên Hub không POST lại sau 24 giờ mà phải hỏi bằng GET | documented |
- **Bảng mã thất bại thẻ (đề xuất):** `insufficient_funds` thành `insufficient_funds` (chắc); `generic_decline`, `do_not_honor`, `call_issuer`, `pickup_card`, `restricted_card`, `card_not_supported` thành `declined`; `fraudulent` thành `fraud` (chắc); `lost_card`, `stolen_card` thành `fraud` hoặc `declined` (đoán, chọn khi viết adapter); `authentication_required` thành `authentication_required` (chắc); `expired_card` thành `declined` (đoán, vì `expired` của Hub nghĩa là phiên hết hạn); `processing_error`, `issuer_not_available`, `reenter_transaction` thành `gateway_error`; mã lạ thành `unknown` kèm `gatewayCode`.
- **Không dùng SDK `stripe-node`:** nó tự thử lại (mặc định 2 lần) và tự sinh khóa idempotency cho mọi POST, che trạng thái "chưa rõ" của Hub. Adapter đi thẳng HTTP qua `deps.fetch` (Hub không có phụ thuộc framework), form-encode (`payment_intent_data[capture_method]=manual`), xác thực Basic bằng khóa bí mật, đặt `Stripe-Version` cố định, và để Hub tự quyết thử lại.
- Phiên bản: webhook dùng phiên bản đặt lúc tạo endpoint, không phải của yêu cầu; ghim `Stripe-Version` ở mọi yêu cầu và đặt `api_version` của endpoint trùng khớp. `stripe-mock` có cờ `-strict-version-check` (mặc định tắt) để bắt lệch phiên bản trong CI.
- Tần suất (documented, chưa đo): live 100 yêu cầu mỗi giây, sandbox 25; hạn mức đọc trung bình 500 GET mỗi giao dịch mỗi 30 ngày: poll trạng thái "chưa rõ" quá dày có thể chạm.

## Điều mới phát hiện về chính Hub (cần quyết, không thuộc adapter)

Tiến độ (2026-10-06): mục 1 và mục 2 dưới đây đã sửa ở lõi (PHUB-D/S-038, người dùng đã duyệt); mục 3 còn lại, xử lý bằng cấu hình riêng cổng khi làm adapter.
1. **`authorized` đến SAU `succeeded` hoặc sau khi giữ đã nhả (Stripe KHÔNG đảm bảo thứ tự) sẽ bị Hub ghi `late_authorization` oan.** Hiện `_applyAuthorized` coi mọi `authorized` trên attempt đã đóng là khoản giữ mồ côi. Cần quy tắc: nếu attempt đã đóng và cùng `gatewayTxnId` với khoản thu hoặc nhả thì coi là đến muộn do đảo thứ tự, không phải anomaly. Nên sửa ở lõi trước hoặc cùng lúc với adapter, kèm test.
2. **Hoàn tiền trực tiếp (`createRefund` thành `hub.refund`) chỉ cần attempt có cảnh báo `late_success` hoặc `duplicate_charge`, không kiểm kết quả hỏi lại cổng** như đường `resolveAnomaly`. Do phiên harness phát hiện khi viết giải thích sơ đồ `luong-7` (xác nhận bằng mã: `hub.refund` không gọi `_arbitrate`). Nếu chủ ý thì phải sửa câu giải thích sơ đồ; nếu là lỗ hổng thì Hub có thể hoàn tiền theo một thông báo giả hay cũ. Việc này tách khỏi adapter Stripe, cần người dùng quyết.
3. Sau hạn giữ, Hub chỉ báo `authorization_stale`; với Stripe hạn giữ thẻ là 7 ngày nhưng `reconcile.maxAgeSeconds` mặc định là 86400 giây (1 ngày): mọi khoản giữ hợp lệ sẽ bị báo `authorization_stale` từ ngày thứ hai. Cần đặt `maxAgeSeconds` riêng cho Stripe (`protection`/`reconcile.perGateway`) lớn hơn hạn giữ.

## Điều CHƯA kiểm và chỉ kiểm được bằng khóa test thật (bằng `stripe listen`, `stripe trigger`)
- Thẻ hỏng trên Checkout hosted: session có giữ `open` không, có `payment_intent.payment_failed` không (điểm quyết định "failed có bao giờ đến Hub").
- `checkout.session.completed` mang `payment_status` gì khi mới giữ tiền; `payment_intent` có sẵn lúc tạo session không (ví dụ tài liệu cho `null`).
- Metadata của PaymentIntent có chép sang Charge và Dispute không; `payment_intent` của session `null` trong khoảng nào.
- Chuỗi sự kiện và `cancellation_reason` khi giữ hết hạn; mã lỗi thật khi thu hai lần hoặc thu sau hạn.
- UGX (hai hay không chữ số), quy tắc bội 10 của tiền ba chữ số, tối đa 8 hay 12 chữ số, hạn hoàn tối đa (không thấy con số nào).
- Thông điệp thật của `idempotency_error` và `idempotency_key_in_use`, header `Idempotent-Replayed`, header phản hồi sau khi xác thực thành công, rate limit thật.
- Số thẻ test (từ chối chung `4000000000000002`, hết tiền `4000000000009995`, cần 3DS `4000008400000027`, tranh chấp gian lận `4000000000000259`, hoàn bất đồng bộ thất bại `4000000000005126`...) lấy từ trang test qua công cụ tóm tắt: đọc lại ở trang gốc trước khi dùng.

## Kế hoạch kiểm khi làm adapter
- **Bằng `stripe-mock`** (không có trạng thái, không có webhook, không dedupe idempotency; chỉ kiểm hình yêu cầu và phản hồi cố định): tên tham số, form-encoding lồng nhau, đường dẫn, xác thực `sk_test_`, parse hình phản hồi.
- **Bằng simulator riêng** `tools/sim/stripe` (như bốn cổng đã có): máy trạng thái Checkout Session và PaymentIntent; idempotency thật (lưu 24 giờ, `idempotency_error`, 409); tiêm lỗi (500 sau khi đã xử lý, timeout, 429 có và không header); mã từ chối; webhook ký đúng `Stripe-Signature` với trùng, muộn, mất, đảo thứ tự; hết hạn session; giữ tiền hết hạn; hoàn thất bại muộn; tranh chấp. Hình thức theo bằng chứng, ngữ nghĩa theo hướng đối kháng.
- **Bằng khóa test thật:** mọi mục "chưa kiểm" ở trên, khi người dùng có tài khoản. Khóa chỉ ở biến môi trường, không ghi vào mã hay tài liệu.

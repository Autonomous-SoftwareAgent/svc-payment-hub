# Giải pháp lõi rút từ mã nguồn mở, nói bằng ngôn ngữ của Hub

Ngày: 2026-10-05. Mục đích: trước khi mở rộng Hub từ cổng nội địa sang quốc tế, chốt **ngôn ngữ chung** của lõi (kiểu, trạng thái, mã) bằng cách xem các dự án mã nguồn mở đã giải bài toán này ra sao, rồi lấy cái nên lấy và tránh cái nên tránh.

Nguyên tắc dẫn đường (D-016): lõi chỉ nói bằng ngôn ngữ chung do chính Hub định nghĩa. Mọi thứ riêng của một nhà cung cấp nằm trong module cô lập của nó; lõi không đọc, không rẽ nhánh theo nó.

## Phương pháp và giới hạn
- Bốn agent mỗi agent đọc MÃ THẬT (clone nông, đọc tĩnh) của: Kill Bill (`killbill`, `killbill-plugin-api`, `killbill-api`), Medusa (module payment và provider Stripe), Omnipay (`omnipay-common`, `-stripe`, `-paypal`) cùng Payum (nhánh v2.0), ActiveMerchant. Cùng một bộ câu hỏi lấy từ từ vựng của Hub. Hyperswitch đã khảo sát ngày 2026-10-02: xem [hyperswitch-survey.md](hyperswitch-survey.md), không lặp lại ở đây.
- **Không build, không chạy, không thử với cổng thật.** Mọi dòng bên dưới là đọc mã. Phần "không có X" thường dựa trên grep và có thể sót; mỗi mục ghi rõ khi là suy ra.
- Chỉ đọc một số tệp liên quan mỗi dự án; ActiveMerchant có hơn 240 cổng mà chỉ đọc kỹ ba bốn cổng. Không dự án nào có cổng nội địa Việt Nam.
- Đường dẫn bằng chứng là trong bản clone tại ngày đọc (đã xóa clone). Viết tắt: KB = Kill Bill, MD = Medusa, OM = Omnipay, PY = Payum, AM = ActiveMerchant.
- Payum đang chuyển từ v1 (Request/Action) sang v2 (Command/Handler/Result). Các gateway thật xem được vẫn viết kiểu v1. Phần "nên học" từ Payum là về thiết kế v2, chưa thấy cổng thật nào cài đầy đủ.
- Hai nhận định cần đọc kỹ hơn trước khi dựa vào: "Payum không có kho khử trùng webhook" và "`PaymentStatuses::set` không chặn trạng thái đi lùi" (đều suy ra), và "Kill Bill chưa kiểm tổng hoàn không vượt tổng thu" (chưa thấy, chưa kết luận là không có).

## Bảng giải pháp theo từ vựng của Hub

### 1. Kết quả một thao tác
- **Lấy:** bốn giá trị: thành công, thất bại chắc chắn, đang chờ, **chưa rõ** (có thể đã xảy ra, có thể chưa). Từ chối của ngân hàng là một KẾT QUẢ bình thường; timeout và lỗi hạ tầng là NGOẠI LỆ dẫn tới "chưa rõ", không bao giờ thành "thất bại".
  - KB: `PaymentPluginStatus` có `UNDEFINED` (có thể đã/chưa xảy ra) khác `CANCELED` (chắc chắn chưa), null và giá trị lạ ra UNKNOWN (`PaymentTransactionInfoPluginConverter.java:33-56`). Plugin timeout hay lỗi thì giao dịch thành UNKNOWN, "để Janitor sửa" (`PaymentOperation.java:85-110`).
  - PY v2: "declines are results, faults are exceptions" (`Failure.php:9-14`); trạng thái null nghĩa là "không ai biết", ra unknown, không đoán New (`Legacy/StatusMarker.php:17-19`).
  - MD/Stripe: lỗi `StripeAPIError` (không rõ) không bị coi là thất bại, ghi `indeterminate_due_to` rồi chờ webhook (`stripe-base.ts:188-197`).
- **Tránh:** KB gộp UNKNOWN và PLUGIN_FAILURE thành EXCEPTION và tự ghi chú "không phân biệt được" (`PaymentProcessor.java:307`). OM/Stripe PaymentIntents: trạng thái lạ rơi vào "không thành công", không có chỗ cho "chưa rõ" (`PaymentIntents/Response.php:115-121`); `next_action` lạ bị coi là thất bại (`:139-146`). AM chỉ có một bit `success?` và cờ `pending` (dùng thật ở một cổng).
- **Với Hub:** giữ "chưa rõ" thành trạng thái RIÊNG. Hub đã có `unknown` ở mã thất bại; chưa có "kết quả thao tác chưa rõ" ở mức hợp đồng (xem mục đề xuất).

### 2. Trạng thái cuối bất biến
- KB: mỗi loại giao dịch một máy khai báo bằng XML; trạng thái SUCCESS/FAILED/ERRORED không có cạnh đi ra, chỉ PENDING đi tiếp (`PaymentStates.xml:55-75`). Plugin không tự chọn trạng thái; kết quả plugin quy về 4 giá trị rồi XML quyết định.
- MD: không có máy trạng thái; update ghi đè trạng thái không kiểm đường chuyển (`payment-module.ts:577-601`); failed/canceled qua webhook bị bỏ (`payment-webhook.ts (subscriber), dòng 85-97`). PY: không thấy chặn đi lùi (suy ra).
- **Lấy:** máy khai báo bằng dữ liệu (KB). Hub đã có bất biến trong lõi; giữ.

### 3. Tiền
- **Lấy:** số nguyên theo đơn vị nhỏ nhất, luôn kèm mã tiền ISO 4217; bảng số lẻ ở lõi; thừa số lẻ thì BÁO LỖI, không làm tròn; không có mã tiền thì từ chối.
  - OM: chuỗi nhiều số lẻ hơn tiền cho phép thì ném "Amount precision is too high" (`AbstractRequest.php:283-288`).
  - PY v2: thiếu amount hoặc currency thì null, "an amount without a currency is not money" (`Money/Amount.php:70-76`); số không vừa int thì ném lỗi (`:85-98`); `RefundCommand` nhận `int|Money|null`, hoàn một phần cần khả năng `PartialRefund` (`RefundCommand.php:37-40`).
  - KB: số lẻ theo tiền tệ, `processedAmount` tách khỏi `amount` (`ddl.sql:163-164`); mọi giao dịch của một payment cùng tiền tệ (`PaymentAutomatonDAOHelper.java:109`).
  - MD: thu một phần không vượt phần còn lại (`payment-module.ts:805-858`), hoàn không vượt đã thu trừ đã hoàn (`:1002-1040`).
- **Tránh:** OM mặc định USD khi thiếu tiền (`AbstractRequest.php:267`) và 2 chữ số khi tiền lạ (`:432`). AM: mỗi cổng một danh sách tiền không lẻ/ba lẻ lệch nhau (Stripe có UGX, MGA; Adyen coi IDR không lẻ), `localized_amount` làm tròn bằng sprintf (`gateway.rb:280-298`) và người gọi phải tự "nhân/chia 100" (bẫy). MD lưu BigNumber theo đơn vị chính và phụ thuộc `Intl` (có thể lệch giữa môi trường, suy ra). KB dùng `numeric(15,9)`.
- **Với Hub:** hiện amount là VND số nguyên (xem `contract.js`). Quốc tế cần thêm mã tiền và số mũ.

### 4. Mã lý do thất bại
- **Lấy:** bảng ĐÓNG do lõi quy định, mỗi cổng tự dịch; thêm cờ "có nên thử lại"; mã gốc giữ ở trường riêng.
  - PY v2 `FailureReason`: authentication_required, configuration, declined, expired_card, fraud, insufficient_funds, network, rate_limited, unknown, có `isRetriable()` (`Result/FailureReason.php:16-51`). `Failure` = reason chuẩn + code thô + message thô (`Failure.php:16-35`).
- **Tránh:** AM có 17 mã chỉ nói về thẻ, không có hủy/hết hạn/thiếu tiền/mạng (`gateway.rb:83-101`); `error_code` trộn mã chuẩn và mã thô (Adyen `adyen.rb:981-985`); Ebanx, dLocal, MercadoPago trả mã thô. KB chỉ có chuỗi tự do `gatewayErrorCode`, không có bảng chuẩn.
- **Với Hub:** bảng hiện có (user_cancelled, expired, insufficient_funds, declined, gateway_error, invalid_request, unknown) đã đúng hướng và rộng hơn về nghiệp vụ. Bổ sung đề xuất ở dưới. Cần thêm test "mọi mã gốc đã biết đều có dòng ánh xạ".

### 5. Khả năng của cổng
- **Lấy:** dữ liệu có kiểu; thao tác hỗ trợ SUY RA từ code để không khai sai được.
  - PY v2: `Capability` enum (`Gateway/Capability.php:17-46`); thao tác suy từ danh sách handler, kiểm hai handler nhận cùng lệnh thì ném lỗi (`HandlerMap.php:35-130`); phần tinh (partial_capture, partial_refund, multi_currency, three_d_secure...) khai qua `DeclaresCapabilities` (`:14-19`).
  - AM: `supported_countries` (kiểm ISO khi gán, `gateway.rb:159-172`), `supported_cardtypes`, `default_currency`, `display_name`: có cấu trúc nhưng chỉ là thông tin, thư viện không chọn cổng giúp.
- **Tránh:** OM chỉ `method_exists` (`AbstractGateway.php:174-284`). KB và MD không khai khả năng; MD thêm trạng thái `pending_authorization` về sau vì gặp chuyển khoản/ví, cho thấy tập trạng thái chung phải mở rộng khi gặp phương thức mới.
- **Với Hub:** `Capabilities` đã có (hardExpiry, cancellable, queryable, refundable, methods...). Thiếu: loại tiền, quốc gia, giới hạn số tiền, thu/hoàn một phần, 3DS.

### 6. Bước tiếp theo cho khách (chuyển hướng, 3DS, QR, chờ)
- **Lấy:** là DỮ LIỆU, không phải ngoại lệ.
  - PY v2 `NextAction`: Redirect, PostRedirect, Challenge (3DS), Poll (chuyển khoản/ngoại tuyến), RenderTemplate; "3DS, redirect, QR là cùng một hình dạng" (`NextAction/Challenge.php:9-14`, `Poll.php:9-14`). Lệnh "tái nhập": lần một mở checkout trả Redirect, lần hai khi khách quay lại thì chốt (`CaptureCommand.php:20-30`).
- **Tránh:** OM để 3DS là chuyện riêng từng cổng, chi tiết Stripe rò vào lớp chung. PY v1 dùng exception để điều khiển luồng. MD dùng `requires_more` cộng `data` thô cho front-end (`stripe-base.ts:673-677`). KB chỉ có `buildFormDescriptor` và property tự do.

### 7. Thông báo từ cổng
- **Lấy:**
  - PY v2: tách `verify()` (nhanh, trả lời ngay) khỏi `handle()` (`NotifyHandlerInterface.php:19-32`); `WebhookEvent::verified(payload, id, type)` có id để nhận ra gửi lại (`WebhookEvent.php:30`); cổng không ký thì `unverified`, handler phải hỏi lại cổng thay vì tin nội dung (`:38-46`); sự kiện không quan tâm vẫn trả 2xx (`NotifyResult.php:46-52`); câu trả lời cho cổng là dữ liệu `Acknowledgement`.
  - MD: route chỉ đẩy vào hàng đợi rồi trả 200 ngay, xử lý nền, thử lại 3 lần (`api/hooks/payment/[provider]/route.ts:14-37`).
  - OM/PayPal REST: xác thực bằng cách hỏi lại cổng (`RestVerifyWebhookSignatureRequest.php`).
- **Tránh:** MD và KB bỏ im lặng sự kiện không gắn được đơn (`payment-webhook.ts (subscriber), dòng 81-83`; `PaymentRefresher.java:410-413`). AM không có lớp thông báo. Không dự án nào có bảng khử trùng theo id sự kiện của cổng.
- **Với Hub:** Hub đã có chống trùng và `unmatched_funds`; phần lấy thêm là tách verify/handle và tra cứu lại khi cổng không ký.

### 8. Chống xử lý trùng và khóa
- **Lấy:** MD truyền `idempotency_key` sinh từ id nội bộ (session.id, capture.id, refund.id) vào MỌI lời gọi cổng (`payment-module.ts:419,569,889,1064`); capture và refund khóa dòng bằng SELECT FOR UPDATE với `lock_timeout` 3 giây, khóa không giữ lúc gọi cổng (`:804-829, 979-1002`). KB: khóa ngoài, gọi plugin giữ khóa tài khoản (`OperationCallbackBase.java:61-66`).
- **Tránh:** KB chỉ có index thường, không UNIQUE (`ddl.sql:11,42`).
- **Với Hub:** thêm ràng buộc UNIQUE ở DB cho khóa; sinh khóa gửi cổng từ id nội bộ cho mọi cổng có hỗ trợ.

### 9. Mạng: retry và timeout
- **Lấy (AM):** phân biệt "chắc chắn chưa gửi" (ECONNREFUSED: luôn thử lại tới 3 lần) với "đã gửi hoặc không rõ" (EOF, reset, timeout, SSL: chỉ thử lại nếu `retry_safe`, mặc định tắt) (`network_connection_retries.rb:6-14,55-65`). MD: lỗi kết nối và rate limit thử lại 3 lần, lùi theo cấp số nhân có nhiễu (`stripe-base.ts:181-245`).
- **Tránh (AM):** thư viện chỉ ném `ConnectionError`, không trả "chưa rõ"; gần như không cổng nào rescue; việc ghi nhận và đối soát bỏ cho ứng dụng.
- **Với Hub:** kết quả của nhánh "đã gửi hoặc không rõ" phải thành "chưa rõ" được GHI LẠI rồi đối soát, không bao giờ thành failed.

### 10. Sổ thu và hoàn
- **Lấy (MD):** capture và refund là bản ghi chỉ-thêm; trạng thái tổng tính lại từ tổng session, capture, refund (`payment-module.ts:1107-1200`).
- **Tránh (MD):** tạo bản ghi capture/refund trước khi gọi cổng rồi XÓA nếu lỗi (`:737-749, 947-953`): nếu cổng đã thu hoặc hoàn mà phản hồi lỗi hay timeout thì sổ mất dù tiền đã đi. Đây là vi phạm trực tiếp "không suy thất bại từ timeout".
- **Với Hub:** lỗi không rõ thì đánh dấu "chưa rõ", không xóa.

### 11. Đối soát
- **Lấy (KB, Janitor):** chạy mỗi giờ, chỉ xét PENDING và UNKNOWN, hỏi plugin `getPaymentInfo` khớp theo mã giao dịch; không trả lời được thì giữ UNKNOWN chờ lần sau; lịch lùi: UNKNOWN 5 phút, 1 giờ, 1 ngày (lặp năm lần), PENDING 1 giờ, 1 ngày (`IncompletePaymentTransactionTask.java:63,182-258`; `PaymentConfig.java:61,71,102`). Có bản "on the fly" khi đọc payment.
- **Học thêm:** PY v2 có `SyncCommand` tách riêng cho admin, job đối soát, phục hồi khi webhook không tới (`SyncCommand.php:15-26`). AM/dLocal có `inquire`.
- **Tránh:** KB và MD bỏ tiền về mà lõi chưa biết. Không dự án nào ghi nhận tiền về muộn, trùng, thiếu, thừa.
- **Với Hub:** phần này Hub đã hơn (recheck theo backoff, kéo sao kê, anomaly). Đưa `inquire`/`sync` vào bộ thao tác chuẩn.

### 12. Thao tác chuẩn
- AM: purchase, authorize, capture, void, refund, verify, store, unstore (`gateway.rb:11-23`); cổng không hỗ trợ một thao tác thì xử lý không nhất quán (không có phương thức, hoặc ArgumentError, hoặc Response thất bại với message tự do, hoặc mã `unsupported_feature`).
- **Lấy:** bộ thao tác nhỏ, cộng `inquire`; cổng không hỗ trợ thì trả "không hỗ trợ" thống nhất, dựa vào khai báo khả năng.

### 13. Dữ liệu thẻ
- AM: lõi vẫn cầm số thẻ thô (`credit_card.rb:90,179`); che số trong nhật ký bằng regex tay từng cổng (`stripe.rb:247-262`), dễ vỡ khi thêm trường.
- **Với Hub:** Hub không bao giờ nhận số thẻ: dùng trang thanh toán của cổng (chuyển hướng) hoặc token. Kèm test quét mã và nhật ký không có trường dữ liệu thẻ (hiện mới kiểm một lần bằng grep).

### 14. Tham số riêng của cổng (cái cần tránh nhất)
- Cả bốn dự án đều có một "túi tham số tự do": AM `options` hash (Adyen khoảng 137 lần đọc, Stripe khoảng 51 khóa, đếm grep), OM `ParameterBag` (`Helper.php:82-90`, tham số lạ bị lờ đi), KB `PluginProperty` (cũng bị dùng làm kênh điều khiển, `ExternalPaymentProviderPlugin.java:144-158`), MD `data: Record<string, unknown>`. Khóa gõ sai bị bỏ qua im lặng. Hàm cùng tên khác nghĩa theo cổng (OM `getCode` là mã lỗi ở cổng này, mã HTTP ở cổng khác).
- **Với Hub:** phần riêng của nhà cung cấp vào một trường `extra` có schema khai báo trong module cổng đó; lõi bỏ qua và không đọc.

### 15. Chi phí thêm một cổng
- KB: 0 chỗ sửa lõi (plugin đăng ký theo tên). MD: 0 chỗ sửa lõi nhưng workflow webhook gắn với cart/order của Medusa. OM và PY: thêm package. Hyperswitch: khoảng 29 tệp lõi (xem khảo sát). Registry adapter của Hub (thêm thư mục là xong) ngang mức tốt nhất.

## Cái Hub tự làm vì không dự án nào có
Đối soát tiền về muộn, trùng, thiếu, thừa; bảng khử trùng thông báo theo (cổng, id sự kiện); kiểm hoàn không vượt số còn lại có chặn ở DB; ghi nhận "chưa rõ" rồi đối soát thay vì xóa hay suy thất bại.

## Tổ chức mã theo quốc gia và loại tiền (đã chốt với người dùng 2026-10-05)
- **Không chia thư mục theo quốc gia.** Quốc gia là thuộc tính khai báo, vì một cổng có thể phục vụ nhiều nước, nhiều tiền, nhiều phương thức.
- `src/adapters/<nhà-cung-cấp>/`: một thư mục mỗi nhà cung cấp, như hiện nay. Chỉ chứa phần riêng của cổng đó.
- `src/adapters/_shared/`: bộ dụng cụ chuẩn hóa dùng chung, chia theo LOẠI VIỆC (bảng mã thất bại, đổi tiền và đơn vị nhỏ nhất, các kiểu chữ ký, luồng chuyển hướng rồi nhận thông báo, khớp chuyển khoản theo nội dung). Registry đã bỏ qua thư mục bắt đầu bằng `_`. Test import (`adapters-arch.test.js`) cần thêm `_shared` vào danh sách adapter được phép import. Quy tắc giữ: mỗi tệp chỉ làm một loại việc, và chỉ đưa vào `_shared` khi có từ hai adapter dùng.
- Khai báo `regions`, `currencies`, `methods` trong `capabilities` của adapter; routing chọn cổng theo nước của cửa hàng, loại tiền và phương thức.
- Thứ riêng của một thị trường nhưng nhiều cổng dùng chung (ví dụ mã ngân hàng Việt Nam) thành "gói thị trường" nhỏ trong `_shared/` (ví dụ `market-vn.js`): chỗ duy nhất có chữ "nước" trong mã.
- Muốn nhìn theo nhóm "Việt Nam / quốc tế": làm ở tài liệu và trang cổng, nhóm theo trường `regions`.
- Rủi ro: `regions` và `currencies` do người viết adapter khai, có thể sai: cần test kiểm khai báo, và mục "chưa kiểm với cổng thật" vẫn áp dụng.

## Đề xuất thay đổi `contract.js` (CHƯA làm; chờ người dùng duyệt)
Hiện có (xem `src/contract.js`): `EventType`, `Method`, `FailCode`, `CanonicalEvent`, `Capabilities`, `CallbackResult`, `CreateParams`. Đề xuất, theo thứ tự rủi ro tăng dần, mỗi mục giữ nguyên hành vi cho bốn cổng hiện có:

1. **Tiền:** thêm `currency` (ISO 4217) vào `CreateParams` và `CanonicalEvent`, mặc định `VND` để bốn cổng hiện tại không đổi; bảng số mũ ở lõi (`src/money.js`); số thực bị từ chối; thiếu mã tiền ở cổng quốc tế thì từ chối, không mặc định. Test VND, JPY (0 lẻ), KWD (3 lẻ).
2. **Mã thất bại:** thêm `authentication_required`, `fraud`, `rate_limited` và hàm `isRetriable(failCode)`. Adapter hiện có chỉ cần bảng ánh xạ, không đổi logic.
3. **Khả năng:** thêm `regions`, `currencies`, `operations` (authorize, capture, refund, inquire, void), `partialCapture`, `partialRefund`, `threeDs`, `amountLimits`. Vắng = "chưa khai", không phải "không hỗ trợ".
4. **Kết quả thao tác chưa rõ:** kiểu `{ outcome: 'succeeded'|'failed'|'pending'|'unknown' }` ở mức hợp đồng cho thao tác gọi ra cổng, để nhánh "đã gửi hoặc không rõ" ghi nhận được và đối soát (hiện Hub xử lý qua cơ chế riêng, cần rà lại xem có thể gom).
5. **Bước tiếp theo cho khách:** `NextAction` = `redirect | post_redirect | challenge | poll | qr | deeplink`; thay cho các trường rời hiện có trả về lúc tạo.
6. **Sự kiện mới:** `authorized`, `captured`, `disputed` (chargeback), cùng thao tác `capture`. Đây là thay đổi lớn nhất vì chạm máy trạng thái lõi; làm sau cùng và cần thiết kế riêng.
7. **Thao tác `inquire`** thành thao tác chuẩn (hiện `queryable` đã có ở khả năng; chuẩn hóa tên và hình dạng).
8. **Trường `extra`** có schema khai báo trong module cổng; test quét cấm lõi đọc `extra`.

Thứ tự làm đề xuất: 1, 2, 3, 8 (ít rủi ro, mở đường cho cổng quốc tế), rồi 5 và 4, cuối cùng 6.

Tiến độ (2026-10-05): mục 1, 2, 3, 8 đã làm (PHUB-D/S-033); mục 5 `NextAction` đã làm (PHUB-D/S-035); phần tranh chấp của mục 6 đã làm ở mức ghi nhận (PHUB-D/S-036: `dispute_opened`, `dispute_won`, `dispute_lost`, không đổi trạng thái). Phần authorize/capture/void của mục 6 đã làm (PHUB-D/S-037: trạng thái AUTHORIZED, `capturePayment`, `voidPayment`, thao tác mất phản hồi là chưa rõ; chưa có thu một phần). Còn lại: mục 4 (kết quả thao tác chưa rõ ở mức hợp đồng chung cho mọi thao tác gọi ra cổng, hiện mới có cho capture và void) và mục 7 (`inquire` thành thao tác chuẩn).

---
module: sepay-sim
---
# sepay-sim - Spec (tầng 2)

Design được tách thành yêu cầu, contract, tiêu chí nghiệm thu và task. Khung tự sinh từ design; điền qua tool `spec_fill`.

## SEPY-S-001: SePay: ba sản phẩm và luồng chuyển khoản do khách chủ động (kiểu khác redirect)
- from: SEPY-D-001
- derived_from: 132db683
- status: ready
- requirement: Adapter SePay chọn sản phẩm theo product (SEPY-D-006); sản phẩm A (QR tĩnh + webhook, product "qr-static") và simulator theo luồng của SEPY-D-001: createPayment không gọi mạng, trả hướng dẫn chuyển khoản (ngân hàng, số tài khoản, tên, nội dung = attemptRef viết hoa, số tiền, URL QR); parseCallback xác thực (không / Apikey / HMAC-SHA256 trên rawBody với timestamp), bỏ qua tiền ra, trích attemptRef từ code hoặc tìm mã trong nội dung không phân biệt hoa thường, mỗi khoản là một sự kiện "received" (gatewayTxnId = referenceCode, lùi về id khi rỗng); tiền không gắn được attempt là unmatched; query tìm theo q và trả mảng; reconcileFeed kéo sao kê theo since_id. Simulator mô phỏng ngân hàng + SePay: webhook, API v2 (Bearer, rate limit), QR, điều khiển bất lợi. Phần dùng chung của A và B (webhook biến động số dư, sao kê) nằm ở bank.js; B và C ở SEPY-S-004, SEPY-S-005.
- contract: createSepayAdapter(config, {fetch, clock}); startSimulator(opts) (async). Ack: ok/duplicate/unknown_attempt/amount_mismatch -> 200 {"success":true}; invalid_signature -> 401; error -> 500. Config tầng 2 của A: accountNumber, bankName, accountName, codePrefix, authMode, apiKey, hmacSecret, apiBaseUrl, apiToken, qrBaseUrl. Cấu hình chỉ có A (không va, không pg) hoạt động đúng như trước khi có B và C. parseCallback trả đồng bộ khi chỉ có A.
- acceptance: test/sepay (create, signature, lifecycle, adversarial): chữ ký HMAC tính độc lập, createPayment, vòng đời adapter với simulator, kịch bản bất lợi; test/e2e/hub-transfer.test.js: Hub với SePay A (19 test). Các test này giữ nguyên và vẫn xanh sau khi thêm B và C.
- tasks: - [x] Adapter, simulator, test,- [ ] Đối chiếu với SePay thật (webhook Test mode, HMAC golden vector, GET /v2/transactions dữ liệu thật),- [x] Sản phẩm B (VA theo đơn) và C (cổng redirect): SEPY-S-004, SEPY-S-005

## SEPY-S-002: Sổ giả định SePay (sản phẩm A): nguồn, mức bằng chứng, đối chiếu docs
- from: SEPY-D-002
- derived_from: 34bb80e3
- status: ready
- requirement: Simulator SePay mô phỏng đúng các hành vi live của sổ giả định (API v2 401 JSON và header rate-limit, vietqr.app trả HTTP 200 text/html khi lỗi) và hướng bất lợi, cấu hình được, cho các giả định ngữ nghĩa chưa xác minh: webhook mất, trùng, trễ, đảo thứ tự, sai xác thực, ack nghiêm hoặc lỏng, retry Fibonacci, nội dung bị ngân hàng sửa, SePay không tách code, tiền ra, form-urlencoded, referenceCode rỗng, id API dạng UUID.
- contract: POST /sim/transfer, /sim/control, /sim/clock/advance, /sim/webhook/flush; GET /sim/transactions, /v2/transactions, /img.
- acceptance: Test bất lợi của adapter với simulator và test tích hợp với Hub xanh; mọi giả định unverified vẫn ghi unverified trong sổ.
- tasks: - [x] Kịch bản bất lợi,- [ ] Xác minh các điểm cần merchant thật

## SEPY-S-003: SePay (sản phẩm A): câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003) và điểm khác ba cổng redirect
- from: SEPY-D-003
- derived_from: bc09fc9d
- status: ready
- requirement: Sản phẩm A khai báo hardExpiry="none", cancellable=false, queryable=true (kiểu liệt kê), refundable="manual" (hoặc "api" khi cấu hình refundApi, xem SEPY-S-004), refundAsync=true, createCanTimeout=false, referenceFormat={prefix, maxLength:30, caseInsensitive:true}; lỗi mạng/401/429 của API trả {state:"unknown"}, không bao giờ suy ra thất bại.
- contract: Mặc định refund và queryRefund trả manual_required; A không có cancel (adapter chỉ có cancel khi bật B hoặc C).
- acceptance: assertAdapterShape qua; test năng lực và test Hub với referenceFormat xanh.
- tasks: - [x] Cờ năng lực,- [x] Hoàn tiền qua Refunds API khi cấu hình refundApi (test/sepay/products.test.js),- [ ] Xác minh với merchant thật

## SEPY-S-004: SePay sản phẩm B: VA theo đơn hàng (product "va-order"): luồng, năng lực, sổ giả định
- from: SEPY-D-004
- derived_from: 71207712
- status: ready
- requirement: Sản phẩm B (VA theo đơn, product "va-order") theo SEPY-D-004: createPayment gọi POST /v2/bank-accounts/{ba}/orders với order_code = attemptRef (6-50 ký tự chữ số, Vietcombank 15), amount, duration, with_qrcode, tid (Vietcombank), va_prefix (Sacombank) lấy từ cấu hình va; trả instructions với accountNumber = số VA, expiresAt = expired_at; 409 duplicate trả lại đúng hướng dẫn cũ; 4xx = rejected, 5xx hoặc mất phản hồi = unknown (createCanTimeout=true). Webhook giao dịch VA: subAccount được phân giải VA -> order_code -> attemptRef (bộ nhớ đệm, rồi quét danh sách đơn); VA của Hub thắng code/nội dung, VA của đơn khác là unmatched, VA lạ rơi về cách của A; không tra được thì parseCallback trả retryLater (Hub ack lỗi, SePay gửi lại; PHUB-D-018 P7). query quét đơn rồi sao kê theo VA, trả các khoản received, not_found hoặc unknown, không bao giờ expired/failed. cancel (DELETE) chỉ cancelled=true khi 204 hoặc 200. Refunds API cho A và B khi cấu hình refundApi: POST /v2/transactions/{id}/refund với X-Idempotency-Key = "refund-{refundRef}", chọn khoản thu gốc, pending->processing, queryRefund tìm lại bản ghi kể cả sau khởi động lại. Simulator mô phỏng đơn VA bốn ngân hàng, hạn VA, chuyển sai số tiền/vào VA đã đóng, hủy, Refunds API, mất phản hồi, cấu hình qua POST /sim/control.
- contract: createSepayAdapter({..., va:{bankAccountId, tid?, vaPrefix?, durationSeconds?, orderCodeMaxLength?, scanMaxPages?}, refundApi?, bankAccountId?}); adapter.cancel({attemptRef}); capabilities("va-order") = {hardExpiry: {minutes}|"none", cancellable:true, queryable:true, refundable:"api"|"manual", refundAsync:true, createCanTimeout:true, referenceFormat:{prefix, maxLength, caseInsensitive:true}}. Simulator: opts.vaBank (BIDV|Sacombank|Vietcombank|VietinBank), POST /sim/transfer với va, các điều khiển va_*, refund_* (VA_CONTROLS); API /v2/bank-accounts/{ba}/orders, /orders/{id}, /refunds, /v2/transactions/{id}/refund.
- acceptance: test/sepay/va-order.test.js (28 test): tạo đơn từng ngân hàng, lỗi tạo, trùng/mất phản hồi, nhận diện theo VA, khởi động lại và quét lỗi, VA lạ và VA của đơn khác, thiếu/thừa/đúng số tiền theo ngân hàng, hết hạn/đã hủy, hủy, query, reconcileFeed, webhook trùng, Refunds API (thành công, bị chặn, mất phản hồi); test/e2e/hub-sepay-products.test.js phần va-order (10 test): Hub với B. Mọi giả định B (SEPY-D-004) vẫn ghi docs-only/unverified: test chỉ chứng minh Hub khớp giả định.
- tasks: - [x] Adapter B, simulator B, test,- [x] Refunds API cho A và B,- [ ] Đối chiếu với SePay thật (tạo đơn, webhook VA, sai số tiền, VA hết hạn/hủy, Refunds API),- [x] Áp dụng P2 (state riêng của adapter) ở lõi Hub: xong ở PHUB-D-018, quét danh sách đơn chỉ còn khi attempt không có state

## SEPY-S-005: SePay sản phẩm C: cổng pay.sepay.vn (product "gateway"): luồng, năng lực, sổ giả định
- from: SEPY-D-005
- derived_from: ccfb2162
- status: ready
- requirement: Sản phẩm C (cổng pay.sepay.vn, product "gateway") theo SEPY-D-005: createPayment không gọi mạng, trả {status:"redirect", url: checkout/init, method:"POST", fields} với các trường theo thứ tự cố định và chữ ký base64(HMAC-SHA256) (lõi Hub lưu method/fields ở attempt và API trả cho cửa hàng, PHUB-D-018 P1); success/error/cancel_url về returnBaseUrl kèm ref và kết quả. parseCallback: IPN xác thực (X-Secret-Key mặc định; none/apikey/hmac cấu hình được), ORDER_PAID+APPROVED+CAPTURED -> succeeded với số tiền thật của giao dịch, DECLINED/dữ liệu mâu thuẫn -> pending, TRANSACTION_VOID -> reversed (gatewayTxnId void:<mã đơn>), REFUND và loại lạ -> hợp lệ không sự kiện, thiếu invoice -> unmatched; kênh return chỉ trả pending nguồn return. query: chi tiết đơn theo invoice, lùi về danh sách q; CAPTURED/void/CANCELLED/pending/not_found/unknown. cancel: POST /order/cancel, chỉ 200 là đã hủy. refund: manual_required. Simulator mô phỏng checkout/init (lỗi vẫn HTTP 200 text/html), trang thanh toán, khách trả/từ chối/hủy/lỗi, void, IPN có retry/trùng/trễ/mất, API đơn hàng với Basic auth, nhiều điều khiển bất lợi.
- contract: createSepayAdapter({..., pg:{merchantId, secretKey, checkoutUrl?, apiBaseUrl?, ipnAuth?, ipnSecret?, paymentMethod?, returnBaseUrl?, invoicePrefix?}}); capabilities("gateway") = {hardExpiry:"unknown", cancellable:true, queryable:true, refundable:"manual", refundAsync:true, createCanTimeout:false, referenceFormat:{prefix}}; adapter.cancel. Simulator: opts.pgMerchantId, pgSecretKey, pgIpnAuth; POST /v1/checkout/init, GET /v1/checkout, GET /v1/order, /v1/order/detail/{key}, POST /v1/order/cancel; POST /sim/pg/pay, /sim/pg/void, /sim/ipn/{id}/resend; điều khiển pg_* (PG_CONTROLS).
- acceptance: test/sepay/gateway.test.js (19 test): form ký (chữ ký tính độc lập), lỗi form, thứ tự ký, IPN thành công/sai khóa/DECLINED/void/lạ, số tiền khác đơn, IPN trùng/trễ/mất/retry, query, khóa tra chi tiết, lỗi API, hủy, return; test/e2e/hub-sepay-products.test.js phần gateway (9 test): Hub với C. Mọi giả định C (SEPY-D-005) vẫn ghi docs-only/unverified, riêng C0 là live.
- tasks: - [x] Adapter C, simulator C, test,- [x] Hiển thị form POST: lõi Hub lưu method/fields (PHUB-D-018 P1),- [ ] Đối chiếu với SePay thật (golden vector chữ ký, IPN thật, khóa tra chi tiết, hạn trang thanh toán),- [ ] Hoàn tiền/void cho đơn cổng

## SEPY-S-006: SePay ba sản phẩm trong một adapter: chọn theo product, cấu hình, và đề xuất đổi hợp đồng Hub
- from: SEPY-D-006
- derived_from: d8985e37
- status: ready
- requirement: Một adapter "sepay" phục vụ ba sản phẩm chọn theo product mà Hub truyền (qr-static, va-order, gateway; "default" -> config.defaultProduct, mặc định qr-static): bật sản phẩm theo cấu hình (A có accountNumber hoặc khi không có B và C; B có khối va; C có khối pg), product chưa cấu hình trả rejected khi tạo, cấu hình sai (va thiếu bankAccountId, pg thiếu secretKey, defaultProduct chưa cấu hình) ném lỗi ngay khi dựng adapter. capabilities(product) khác nhau theo sản phẩm. parseCallback tự nhận diện theo hình dạng (notification_type -> IPN của C; ngược lại webhook biến động số dư; channel return chỉ cho C). reconcileFeed duy nhất kéo sao kê chung cho A và B (chỉ có khi bật A hoặc B); cancel chỉ có khi bật B hoặc C và dò sản phẩm theo gợi ý trong bộ nhớ rồi B, C; refund/queryRefund không có product nên dò khoản thu theo B rồi A. Driver test (test/support/world.js) dựng được cả ba sản phẩm. Đổi hợp đồng Hub P1-P7 (SEPY-D-006) đã áp dụng ở lõi Hub (PHUB-D-018); adapter dùng ở SEPY-D-007.
- contract: config.adapters.sepay: chung (apiBaseUrl, apiToken, authMode, apiKey, hmacSecret, codePrefix, defaultProduct, refundApi, bankAccountId), A (accountNumber, bankName, accountName, qrBaseUrl), B (va), C (pg); createWorld(["sepay"], hubOpts, {sepay:{vaBank?, pg?, refundApi?, defaultProduct?, controls?}}).
- acceptance: test/sepay/products.test.js (7 test): bật theo cấu hình, cấu hình sai, capabilities, định tuyến callback, A+B cùng tài khoản, hủy, hoàn tiền A; test/e2e/hub-sepay-products.test.js (20 test) gồm kịch bản ba sản phẩm cùng lúc.
- tasks: - [x] Chọn sản phẩm theo product và cấu hình,- [x] Áp dụng P1-P7 ở lõi Hub: xong ở PHUB-D-018,- [x] src/config.example.json đã có khối va/pg

## SEPY-S-007: Adapter SePay áp dụng P2-P7: state cho B, receipts cho hoàn tiền, reversed cho void, retryLater, B chính C dự phòng
- from: SEPY-D-007
- derived_from: 37055ca0
- status: ready
- requirement:
  Adapter SePay dùng các điểm hợp đồng mới của PHUB-D-018 (SEPY-D-007):
  1. B (va-order) trả state {orderId, vas[]} trong createPayment; query, cancel, refund, queryRefund dùng state để vào thẳng đơn (ít request hơn đường quét), và làm ấm bộ đệm VA -> mã để webhook sau khởi động lại không phải quét. Không có state thì dùng đường quét cũ.
  2. B không trả transferContent; vẫn có orderCode.
  3. Hoàn tiền (A và B) chọn khoản thu gốc trong receipts (khớp reference_number hoặc id sao kê); receipts không khớp hàng nào thì lùi về cách cũ.
  4. C: VOID (IPN TRANSACTION_VOID, truy vấn thấy VOID đã duyệt) phát reversed với gatewayTxnId "void:<mã đơn>" ở cả hai kênh; đơn đã CAPTURED rồi VOID chỉ báo reversed. Thông báo REFUND vẫn bỏ qua.
  5. Webhook biến động số dư không tra được VA vì lỗi tạm thời trả retryLater (ack lỗi để SePay gửi lại), không ném lỗi.
  6. Cấu hình Hub khai hai mục sepay với adapterProduct va-order (ưu tiên thấp hơn) và gateway (dự phòng).
- contract: createPayment(B) -> {status:'instructions', instructions:{bank, accountNumber, accountName, amount, qrUrl, orderCode, orderId}, state:{orderId, vas:[...]}, expiresAt?}. refund({..., receipts:[{txn, amount}], state}), query({..., state}), cancel({attemptRef, state}), queryRefund({..., state}). parseCallback(bank, VA không tra được) -> {valid:true, retryLater:true, reason:'va_lookup_failed', ack}. C: reversed {gatewayTxnId:'void:<mã đơn>', amount}.
- acceptance:
  - test/sepay/va-order.test.js: createPayment trả state và không có transferContent; có state thì ít request hơn đường quét và cùng kết quả; query có state làm ấm bộ đệm VA (webhook kế tiếp không gọi API); refund chọn đúng khoản theo receipts, receipts lạ thì lùi về cách cũ; webhook gặp lỗi tra cứu tạm thời trả retryLater và lần gửi lại thành công.
  - test/sepay/gateway.test.js: IPN TRANSACTION_VOID và truy vấn cùng ra reversed với cùng mã; truy vấn chỉ báo reversed.
  - test/e2e/hub-sepay-routing.test.js: B chính C dự phòng qua Hub (state lưu ở attempt, B từ chối thì C nhận ngay, failover và hủy B bằng state, product cụ thể, retryLater qua Hub rồi PAID khi SePay gửi lại).
  - test/e2e/hub-sepay-products.test.js: void sau khi thu thì funds_reversed, không conflicting_result, IPN và truy vấn không tính hai lần, hoàn tiền bị chặn khi đã đảo hết.
  - Đột biến (mã reversed không ổn định, B bỏ state, refund bỏ receipts, webhook ném lỗi) đều làm test đỏ.
  - Chỉ chứng minh adapter khớp giả định của simulator (SEPY-D-004/005); không thêm giả định mới về SePay thật.
- tasks:
  - [x] B: state, bỏ transferContent
  - [x] Hoàn tiền: receipts
  - [x] C: reversed ổn định, bỏ cancelled mượn
  - [x] retryLater cho webhook không tra được VA
  - [x] Test adapter và e2e qua Hub, đột biến
  - [ ] Kiểm với SePay thật: mã giao dịch của IPN VOID so với API chi tiết đơn (giả định "void:<mã đơn>" tránh phải biết), thông báo REFUND

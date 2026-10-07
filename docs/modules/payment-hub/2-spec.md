---
module: payment-hub
---
# payment-hub - Spec (tầng 2)

Design được tách thành yêu cầu, contract, tiêu chí nghiệm thu và task. Khung tự sinh từ design; điền qua tool `spec_fill`.

## PHUB-S-001: Payment Hub: điều phối nhiều cổng qua adapter cô lập và mô hình chuẩn
- from: PHUB-D-001
- derived_from: db58afbd
- status: ready
- requirement: PaymentHub (src/hub.js) nhận adapters + config + store + clock. createPayment tạo payment OPEN rồi attempt đầu; createAttempt tạo attempt kế (customer_retry hoặc failover). Lõi chỉ làm việc với sự kiện chuẩn và cờ năng lực, không biết tên trường hay mã lỗi của cổng nào. Đã kiểm chứng với hai kiểu cổng: chuyển hướng + callback (VNPay, MoMo, OnePAY) và khách chuyển khoản do khách chủ động (SePay). createPayment idempotent theo orderId (xem PHUB-S-008). src/index.js là điểm vào xuất Hub, store và các adapter.
- contract: createPayment({orderId, amount (VND nguyên > 0), returnUrl, orderInfo?, product?, clientIp?, expiresAt?}) -> {payment, attempt}. createAttempt(paymentId, {reason, cancelLive?}). handleCallback(gatewayId, req) -> {ack, outcome, attempt?}. reconcile(). refund({attemptId, amount?, reason?}). resolveAnomaly(id, {action: refund|apply|ignore}). getPayment(id). Lỗi có code: invalid_input, no_gateway_available, attempt_still_live, payment_not_open, max_attempts, failover_disabled, nothing_to_refund, invalid_refund_amount.
- acceptance: test/hub/hub.test.js (adapter giả) và test/e2e/hub-sims.test.js (adapter + simulator thật của VNPay, MoMo, OnePAY) đều xanh. Routing chọn cổng theo priority, product, khoảng tiền; không có cổng phù hợp thì từ chối.
- tasks: - [x] Lõi Hub, store trong bộ nhớ và SQLite,- [x] Routing theo config chung,- [x] Adapter kiểu chuyển khoản (SePay) để kiểm chứng mô hình chuẩn,- [x] HTTP API và khởi động từ cấu hình

## PHUB-S-002: Quy tắc nhất quán tiền: callback không đáng tin, trạng thái cuối bất biến
- from: PHUB-D-002
- derived_from: 97637248
- status: ready
- requirement: Hub cài các quy tắc nhất quán tiền: return không đổi trạng thái; callback idempotent theo (cổng, ref, mã giao dịch, loại, nguồn); trạng thái cuối bất biến; sự kiện mâu thuẫn thành anomaly (late_success, duplicate_charge, conflicting_result, amount_mismatch, unknown_attempt, stale_attempt); sai số tiền giữ lại và vẫn báo mismatch khi cổng gửi lại; pending/not_found/unknown không bao giờ thành failed hay expired; tạo thanh toán mất phản hồi thành UNKNOWN, không failover; mã tham chiếu mỗi attempt riêng. Kiểu chuyển khoản: mọi khoản tiền vào luôn được ghi lại (received, unmatched_funds, unknown_attempt kèm số tiền), không bao giờ bị bỏ qua im lặng. Quy tắc 9: reconcile() hỏi lại cổng (query) cho các anomaly late_success, duplicate_charge, conflicting_result đang mở và ghi verdict (success | failure | pending | unknown); pending/unknown hỏi lại theo lịch; query không đổi trạng thái cuối của attempt. resolveAnomaly với action refund hoặc apply chỉ chạy khi verdict là success (tự phân xử nếu chưa có), nếu không ném lỗi not_confirmed; force=true kèm ghi chú bỏ qua. conflicting_result mà cổng không xác nhận success thì gắn needsOperator.
- contract: Outcome trả cho adapter dựng ack: ok | duplicate | unknown_attempt | amount_mismatch | invalid_signature | error. Anomaly {id, type, paymentId, attemptId, amount, gatewayTxnId, status: open|refunding|applied|ignored}. resolveAnomaly(id, {action, note, force?}); anomaly.arbiter = {verdict, at}. Lỗi mới: not_confirmed.
- acceptance: Các test: IPN trùng không đổi gì; return không đổi trạng thái; sai chữ ký bị từ chối; failed rồi succeeded thành late_success; succeeded rồi failed thành conflicting_result; hai attempt cùng thu thành duplicate_charge; IPN mất thì đối soát tìm ra; query pending/not_found nhiều lần không đổi attempt. Chạy lại với 3 simulator trong e2e. test/hub/transfer.test.js. Năm test phân xử: xác nhận qua reconcile, cổng nói không có tiền thì từ chối hoàn (trừ force), unknown thử lại theo lịch, conflicting_result được xác nhận thì không cần người xem, không xác nhận thì gắn cờ người vận hành. Test tích hợp hoàn tiền anomaly với simulator thật vẫn xanh.
- tasks: - [x] Quy tắc 1..10 của PHUB-D-002,- [x] Quy tắc 9: phân xử bằng query, hoàn tiền cần cổng xác nhận

## PHUB-S-003: Bốn giả định lõi cần xử lý an toàn khi chưa biết hành vi thật của cổng
- from: PHUB-D-003
- derived_from: 75d45f29
- status: ready
- requirement: Adapter khai báo cờ năng lực {hardExpiry, cancellable, queryable, refundable, refundAsync, createCanTimeout}; assertAdapterShape kiểm đủ khóa. Hub dùng: queryable (lập lịch đối soát), refundable (api hay MANUAL_REQUIRED), cancellable (cancelLive), createCanTimeout (lỗi mạng khi tạo là UNKNOWN, không phải FAILED). Với hardExpiry dạng {minutes}: sau createdAt + minutes + reconcile.hardExpiryGraceSeconds (mặc định 60 giây), reconcile() hỏi lại cổng một lần cuối không chờ lịch; nếu cổng vẫn chưa trả kết quả cuối thì gắn needsOperator và tạo anomaly expiry_unresolved (một lần), không tự kết luận hết hạn.
- contract: hardExpiry: {minutes} | "gateway-fixed" | "unknown". refundable: api | manual | none. Mặc định an toàn khi chưa biết: coi tiền có thể về muộn, không failover, đối soát có backoff, hoàn tiền bất đồng bộ có thể thất bại muộn.
- acceptance: assertAdapterShape từ chối adapter thiếu hàm hoặc thiếu cờ; test hub dùng adapter giả cho từng giá trị refundable/createCanTimeout. Ba test mới: hỏi lại bắt buộc sau hạn cứng và báo một lần; cổng xác nhận expired thì EXPIRED không cảnh báo; hardExpiry unknown thì không có hỏi lại bắt buộc.
- tasks: - [x] Kiểm cờ năng lực và dùng 5/5 cờ,- [x] Dùng hardExpiry: hỏi lại bắt buộc sau hạn cứng, báo người vận hành sớm,- [ ] Cho phép failover sau hạn cứng khi cổng cam kết (cần xác minh với merchant thật, mặc định tắt)

## PHUB-S-004: Ngoài phạm vi của Hub (và lý do)
- from: PHUB-D-004
- derived_from: 8db0b979
- status: ready
- requirement:
  1. Lõi Hub không chứa gì riêng của một cổng: không tên cổng viết cứng, không mô phỏng mã lỗi từng thẻ hay từng cổng, không kiểm tham số cấu hình riêng của cổng. Mọi thứ đó nằm trong adapter và module cổng.
  2. Hub không khớp chính xác số lần và khoảng cách retry của cổng; chỉ cần đúng với mọi giá trị tham số của cổng, nên giá trị cấu hình được ở simulator.
  3. Hub không lưu dữ liệu thẻ (PCI): không có trường số thẻ, CVV, ngày hết hạn thẻ trong mã.
  4. Hub không phải là một cổng thanh toán thật.
- contract: Ranh giới giữ bằng test/hub/adapters-arch.test.js: lõi không import adapter, không có tên cổng viết cứng (bỏ chú thích), mỗi adapter chỉ import thư mục của nó, fail-codes và contract; routing chỉ biết hợp đồng. Dữ liệu thẻ: không có trường nào trong src/ (hardExpiry là hạn của đơn ở cổng, không phải của thẻ).
- acceptance: test/hub/adapters-arch.test.js đạt (10 test, gồm "lõi không có tên cổng nào viết cứng"). Không có dữ liệu thẻ: kiểm một lần bằng quét mã src/ tìm cvv, cvc, card number, pan, expiry/expdate (chỉ gặp hardExpiry của đơn), CHƯA có test tự động giữ điều này.
- tasks:
  - [x] Lõi trung lập với cổng, có test quét import
  - [x] Kiểm không có trường dữ liệu thẻ trong mã (quét một lần)
  - [ ] Test tự động chặn trường dữ liệu thẻ xuất hiện trong src/

## PHUB-S-005: Interface adapter, mô hình sự kiện chuẩn và hai tầng config
- from: PHUB-D-005
- derived_from: 15702740
- status: ready
- requirement: Hợp đồng adapter trong src/contract.js: createPayment, parseCallback (trả {valid, event?, ack(outcome), reason?}), query, refund, queryRefund, cancel (tùy chọn). Sự kiện chuẩn {gateway, attemptRef, type, amount, gatewayTxnId, occurredAt, source}; amount bắt buộc trừ sự kiện pending. product "default" nghĩa là adapter dùng sản phẩm mặc định trong config của nó. Hub truyền thêm createdAt (và originalAmount khi hoàn tiền) cho query/refund/queryRefund để adapter không phải nhớ trạng thái. Mở rộng cho kiểu chuyển khoản: createPayment có thể trả {status:"instructions", instructions:{bank, accountNumber, accountName?, transferContent, amount, qrUrl?}}; sự kiện loại "received" (một khoản nhận, gatewayTxnId bắt buộc); sự kiện có thể có attemptRef null kèm unmatched=true; capabilities thêm hardExpiry="none" và referenceFormat; CallbackRequest thêm rawBody; query có thể trả mảng sự kiện; adapter có thể có reconcileFeed({cursor, now}); parseCallback có thể trả valid=true không có event.
- contract: assertAdapterShape(adapter), assertEvent(event), các hằng EVENT_TYPES, EVENT_SOURCES, ACK_OUTCOMES, CAP_KEYS. assertEvent: attemptRef bắt buộc trừ khi unmatched; amount bắt buộc trừ sự kiện pending; received cần gatewayTxnId.
- acceptance: Ba adapter thật (vnpay, momo, onepay) và adapter giả đều qua assertAdapterShape khi dựng PaymentHub; mọi sự kiện đi vào lõi đều qua assertEvent. test/hub/transfer.test.js kiểm hướng dẫn chuyển khoản, received, unmatched, sao kê qua adapter giả.
- tasks: - [x] Hợp đồng và kiểm tra hình dạng,- [x] Mở rộng cho kiểu chuyển khoản (instructions, received, unmatched, rawBody, reconcileFeed, hardExpiry none, referenceFormat),- [ ] Bộ test hợp đồng chung chạy cho mọi adapter (hiện mỗi adapter có test riêng)

## PHUB-S-006: Máy trạng thái attempt, payment và refund; routing, failover và đối soát
- from: PHUB-D-006
- derived_from: bee26abe
- status: ready
- requirement: Máy trạng thái: attempt CREATED -> AWAITING | UNKNOWN -> SUCCEEDED | FAILED | CANCELLED | EXPIRED (cuối bất biến); payment OPEN -> PAID | CLOSED (CLOSED chỉ khi quá hạn và không còn attempt có thể nhận tiền); refund REQUESTED -> PROCESSING -> SUCCEEDED | FAILED, hoặc MANUAL_REQUIRED. Routing lọc theo enabled/products/khoảng tiền, sắp theo priority. Failover chỉ khi mọi attempt cũ không còn có thể nhận tiền (không tính attempt LIVE). Đối soát theo lịch backoff; quá maxAge thì gắn needsOperator và anomaly stale_attempt, không tự kết luận. Kiểu chuyển khoản: khoản "received" cộng dồn vào attempt (receivedTotal, receipts, idempotent theo mã giao dịch); tổng >= số tiền thì SUCCEEDED, tổng > số tiền tạo anomaly overpaid (phần dư), thiếu thì giữ AWAITING kèm anomaly underpaid (được thay thế khi đủ). Khoản đến sau kết quả cuối: duplicate_charge (attempt đã SUCCEEDED) hoặc late_success. Tiền chưa rõ chủ: anomaly unmatched_funds. Đối soát gồm reconcileFeed (con trỏ lưu theo cổng, chu kỳ feedIntervalSeconds) và query trả mảng. Mã tham chiếu theo referenceFormat, tra cứu không phân biệt hoa thường.
- contract: Config: {gateways:[{id, enabled?, priority, products?, minAmount?, maxAmount?}], failover:{enabled, maxAttempts}, reconcile:{firstAfterSeconds, backoffSeconds[], maxAgeSeconds}, paymentTtlSeconds}. Store: put/get/find cho payment, attempt, refund, anomaly, event, markSeen/forget. reconcile.feedIntervalSeconds (mặc định 60). Anomaly bổ sung: underpaid, overpaid, unmatched_funds, expiry_unresolved.
- acceptance: Test: không tạo attempt mới khi còn LIVE; failover sau FAILED sang cổng khác; rejected lúc tạo thì chuyển cổng ngay; unknown thì không chuyển; payment đóng khi hết hạn và không còn attempt LIVE; hoàn tiền bất đồng bộ qua đối soát, thất bại muộn cho phép hoàn lại; hoàn thủ công qua markRefundDone. Test: nhận thiếu rồi đủ, nhận thừa rồi hoàn thủ công, khoản trùng qua webhook và query tính một lần, unmatched_funds, kéo sao kê với con trỏ.
- tasks: - [x] Máy trạng thái, routing, failover, đối soát attempt và refund,- [x] Kiểu chuyển khoản: received, underpaid/overpaid, unmatched, sao kê,- [ ] Lịch đối soát chạy nền (hiện reconcile() do bên ngoài gọi)

## PHUB-S-007: Lưu trữ bền vững và đối soát chạy nền
- from: PHUB-D-007
- derived_from: 850094c4
- status: ready
- requirement: MemoryStore (test không cần DB) và PostgresStore (pg) dùng cùng giao diện. PostgresStore.open(url, {schema}) mở kết nối, tạo schema và bảng nếu chưa có, giữ advisory lock (từ chối nếu tiến trình Hub khác đang giữ), nạp lại toàn bộ. Hub bọc mọi thao tác công khai (createPayment, createAttempt, handleCallback, reconcile, refund, resolveAnomaly, markRefundDone) để gọi await store.persist() ở cuối, kể cả khi thao tác ném lỗi (lỗi của thao tác gốc được ưu tiên). persist ghi các payment, attempt, refund, anomaly, webhook ĐÃ ĐỔI (store theo dõi thay đổi), sự kiện và nhật ký gọi mới, khóa idempotency, con trỏ sao kê, feedAt và bộ đếm id trong một transaction, rollback khi lỗi (lỗi thì đánh dấu bẩn lại nên lần lưu sau ghi lại phần chưa lưu), các lần gọi chạy chồng được xếp hàng và dùng chung lần ghi kế tiếp. Mất kết nối thì store đánh dấu hỏng, gọi onBroken và main.js thoát tiến trình. Hub.startScheduler({everySeconds, onError}) gọi reconcile() định kỳ, không chồng lấn, timer unref, lỗi không giết vòng lặp; stopScheduler().
- contract: await PostgresStore.open(url, {schema?}); await store.persist(); await store.close(); PostgresStore.dropSchema(url, schema) (dọn test); store.onBroken = fn. hub.startScheduler(opts); hub.stopScheduler(). src/index.js xuất PaymentHub, MemoryStore, PostgresStore, contract và bốn adapter. Biến môi trường test: HUB_TEST_DATABASE_URL.
- acceptance: test/hub/persistence.test.js (9 test DB + 2 test lập lịch) chạy trên PostgreSQL thật: trạng thái và bộ đếm id sống qua khởi động lại; thông báo trùng sau restart vẫn là duplicate; anomaly, refund, sự kiện nạp lại đúng; đối soát tiếp tục sau restart; con trỏ sao kê được giữ; lỗi giữa chừng không hỏng DB; chỉ một tiến trình mỗi schema; lưu lỗi thì rollback và lần lưu sau ghi lại, không mất dữ liệu; 20 thao tác đồng thời đều được lưu. Test tích hợp khởi động lại giữa chừng với SePay. Không có HUB_TEST_DATABASE_URL thì các test cần DB bị bỏ qua và nêu lý do. Đã chạy trong Docker: restart container Hub giữ nguyên dữ liệu; restart PostgreSQL thì Hub thoát và được khởi động lại, dữ liệu còn.
- tasks:
  - [x] PostgresStore, lưu một transaction mỗi thao tác, nạp lại khi khởi động
  - [x] Advisory lock chỉ một tiến trình mỗi schema, thoát khi mất kết nối
  - [x] Bộ lập lịch đối soát
  - [x] Tối ưu lưu cho dữ liệu lớn: ghi theo thay đổi, nhóm commit (PHUB-S-009)
  - [ ] Nhiều tiến trình Hub trên một schema (hiện chỉ một tiến trình ghi)
  - [ ] Sao lưu và triển khai PostgreSQL thật (thuộc CI/CD)

## PHUB-S-008: HTTP API của Hub: cửa hàng gọi vào, cổng gọi vào, vận hành
- from: PHUB-D-008
- derived_from: c07d7617
- status: ready
- requirement: src/server.js: createHubServer({hub|getHub, apiToken, maxBodyBytes, log}) dựng server HTTP không thư viện ngoài; từ chối khởi tạo khi không có apiToken. Route cửa hàng và vận hành (cần Bearer token, so sánh hằng thời gian): POST /payments, GET /payments/{id}, POST /payments/{id}/attempts, POST /refunds, POST /refunds/{id}/done, GET /anomalies, POST /anomalies/{id}/resolve, POST /reconcile. Route cổng (không token): GET|POST /ipn/{gateway} đưa nguyên thân (rawBody) cho adapter và trả ack của adapter; GET|POST /return/{gateway} chỉ hiển thị, chuyển 302 về returnUrl của cửa hàng kèm paymentId và trạng thái do Hub ghi nhận. GET /health công khai. Ánh xạ lỗi: invalid_input và JSON hỏng 400, 401, not_found 404, lỗi trạng thái 409, invalid_refund_amount 422, 413 khi thân quá lớn, no_gateway_available 503, lỗi lạ 500 không lộ chi tiết. Phản hồi không chứa dữ liệu thô của cổng. Lõi: createPayment idempotent theo orderId (trả payment hiện có chưa CLOSED, khác số tiền thì order_conflict). src/main.js khởi động từ tệp cấu hình JSON (HUB_CONFIG) với ${BIẾN_MÔI_TRƯỜNG}, chỉ nội suy cho cổng đang bật, thiếu biến thì không khởi động; MoMo mặc định ipnUrl và redirectUrl từ publicBaseUrl; buildHub là hàm bất đồng bộ nhận deps.store để test; dùng PostgresStore (databaseUrl, tùy chọn databaseSchema; thiếu thì không khởi động), thoát khi mất kết nối cơ sở dữ liệu và chạy bộ lập lịch.
- contract:
  POST /payments {orderId, amount, returnUrl, orderInfo?, product?, clientIp?} -> 201 hoặc 200 {existing:true}. Mẫu cấu hình: src/config.example.json. Hướng dẫn: src/README.md.
  Từ PHUB-S-017: các route cửa hàng/vận hành do connector HTTP (src/connectors/in/http.js) sinh từ danh mục thao tác; kiểm quyền và schema nằm ở src/app/. server.js còn lo xác thực Bearer, giới hạn tải, mã yêu cầu, /health, /metrics, /openapi.json và callback của cổng (/ipn, /return).
- acceptance: test/hub/http.test.js (17 test): xác thực, idempotent theo orderId, ánh xạ lỗi, 413, IPN, return chỉ hiển thị, attempts, hoàn tiền, anomaly, reconcile, 500 không lộ chi tiết, cấu hình. test/e2e/hub-http.test.js (3 test): cửa hàng gọi HTTP, cổng giả gọi IPN về Hub (MoMo) và webhook HMAC (SePay). Toàn bộ test tích hợp còn lại chạy qua server HTTP thật này. Đã chạy thật bằng dòng lệnh: thiếu biến thì từ chối, đủ biến thì /health 200 và API không token 401. Đã chạy trong Docker (Dockerfile + infra/local/docker-compose.yml với container PostgreSQL): Hub healthy, demo qua đủ kiểm tra, dữ liệu nằm trong PostgreSQL và sống qua khởi động lại container, đối soát nền trong container tự tìm ra khoản khi IPN mất, image chạy non-root và không có test/docs/.env/bí mật.
- tasks: - [x] Server HTTP, xác thực, ánh xạ lỗi, callback, return, vận hành,- [x] Khởi động từ cấu hình, bí mật qua biến môi trường,- [x] Dockerfile hardened (cài pg bằng npm ci, non-root) + compose chạy local với PostgreSQL và cổng giả (infra/local),- [ ] Giới hạn tốc độ và nhật ký truy cập,- [ ] TLS (reverse proxy) và triển khai lên VM theo CI/CD (scripts/deploy.ps1 chưa có), kèm PostgreSQL thật và sao lưu

## PHUB-S-009: Chịu tải cao: bộ nhớ có chỉ mục, ghi theo thay đổi, nhóm commit, giới hạn tải ở API
- from: PHUB-D-009
- derived_from: 0db7fc84
- status: ready
- requirement:
  1. Store theo dõi thay đổi: thực thể trả ra từ store ghi nhận mọi chỗ bị sửa (kể cả trường lồng nhau). persist() chỉ ghi thực thể bẩn, mỗi loại một câu lệnh nhiều dòng, trong một transaction; lỗi thì rollback và đánh dấu bẩn lại. Các lần persist chồng nhau dùng chung lần ghi kế tiếp (nhóm commit).
  2. Chỉ mục trong bộ nhớ: attempt theo (cổng, mã không phân biệt hoa thường), payment theo orderId, attempt theo payment, refund theo attempt, anomaly theo id/attempt/payment/(cổng, mã lạ); tập attempt còn sống, payment đang mở, anomaly đang mở, refund đang mở. Đối soát chỉ duyệt phần còn sống.
  3. Nhật ký sự kiện và nhật ký gọi cổng chỉ giữ đuôi trong bộ nhớ; DB giữ đủ; khởi động nạp đuôi và đánh số tiếp không trùng.
  4. API: tối đa maxInFlight request đồng thời (vượt thì 503 + Retry-After, callback của cổng có thêm callbackReserve, /health không bị giới hạn); token bucket cho API cửa hàng/vận hành (429 + Retry-After; áp sau xác thực); requestTimeout/headersTimeout.
  5. Đối soát song song có giới hạn (reconcile.concurrency); lịch riêng theo cổng (reconcile.perGateway); lịch riêng cho hoàn tiền (refundBackoffSeconds); trần hoàn tiền (refund.maxPerAttempt, maxAgeDays; FAILED không tính); kiểm tra cấu hình routing khi nạp.
- contract:
  Store: dirty:Set<`kind:id`>, adopt(kind,obj) (nạp, không bẩn), dirtyObject(key), liveAttempts(), openPayments(), openAnomalies(), openRefunds(), anomaliesOfAttempt/Payment/Ref(), findAttemptByRef(gw,ref), findPaymentByOrderId(id); persist() trả khi dữ liệu của người gọi đã COMMIT.
  Cấu hình: limits{maxInFlight=1000, callbackReserve=200, ratePerSecond=200, burst=400}; hub.reconcile{concurrency=10, refundBackoffSeconds, perGateway{id:{firstAfterSeconds,backoffSeconds,maxAgeSeconds,hardExpiryGraceSeconds,refundBackoffSeconds}}}; hub.refund{maxPerAttempt=10, maxAgeDays=365}.
  Lỗi: HubError refund_limit (HTTP 409); HTTP 429 rate_limited; HTTP 503 overloaded. Cấu hình routing sai: Error khi dựng Hub (trùng/thiếu id, cổng bật không có adapter, minAmount>maxAmount, không cổng nào bật, reconcile.perGateway cho cổng lạ).
- acceptance:
  - Chỉ mục trả đúng và cập nhật khi trạng thái đổi (test/hub/scale.test.js).
  - Sửa trường lồng nhau đánh dấu bẩn; nạp từ nơi lưu thì không bẩn.
  - Callback trên 200 payment có sẵn chỉ ghi tối đa 2 dòng docs.
  - 20 luồng x 10 thao tác (chờ lưu xong mới làm tiếp): dưới 50 commit cho 200 thao tác, và mọi thao tác đều có trong DB sau khi mở lại.
  - 2.600 sự kiện: bộ nhớ không quá 2.000, DB đủ; mở lại nạp đuôi, thêm sự kiện không trùng khóa.
  - 503/429 kèm Retry-After; callback dùng phần dành riêng; /health không bị giới hạn (test/hub/limits.test.js).
  - Đối soát: song song không vượt concurrency; lịch riêng theo cổng và hoàn tiền; trần hoàn tiền; kiểm tra cấu hình.
  - Đo (tools/bench/load.js): không giảm thông lượng khi số payment lưu tăng (trước khi sửa giảm từ 123 xuống 43 thao tác/giây khi tăng tới 3.000).
- tasks:
  - [x] Store có chỉ mục và theo dõi thay đổi
  - [x] PostgresStore ghi theo thay đổi, nhóm commit, đuôi nhật ký
  - [x] Giới hạn tải ở server
  - [x] Đối soát song song, lịch theo cổng, lịch hoàn tiền, trần hoàn tiền, kiểm tra cấu hình
  - [x] Công cụ đo tải tools/bench/load.js
  - [ ] Đẩy giao dịch đã đóng ra khỏi bộ nhớ (cần đọc theo yêu cầu từ DB, đổi các hàm tra cứu thành bất đồng bộ)
  - [ ] Nhiều tiến trình Hub (cần khóa theo giao dịch thay cho advisory lock toàn schema)

## PHUB-S-010: Bảo vệ khi gọi cổng: timeout, giới hạn đồng thời, circuit breaker và nhật ký mỗi lần gọi
- from: PHUB-D-010
- derived_from: 3485c59a
- status: ready
- requirement:
  1. Mọi lời gọi mạng của adapter đi qua lớp bảo vệ theo cổng: timeout ngoài (timeoutMs), giới hạn đồng thời (maxConcurrent) với hàng chờ (maxQueue, queueWaitMs), circuit breaker (failureThreshold lỗi liên tiếp thì mở, sau openSeconds cho thử một lời gọi, thành công thì đóng, thất bại thì mở lại).
  2. Lỗi = ném exception, timeout, hoặc createPayment trả unknown. Kết quả nghiệp vụ (rejected, not_found...) không phải lỗi hạ tầng.
  3. Lỗi "chưa gửi" (circuit_open, overloaded) mang notSent=true; timeout và lỗi mạng thì không. Hub: createPayment gặp notSent thì coi là rejected (chắc chắn chưa nhận tiền, chuyển cổng); gặp timeout/lỗi mạng ở cổng createCanTimeout thì UNKNOWN, không chuyển cổng. Refund gặp notSent thì FAILED (gọi lại được); đối soát gặp notSent thì không tính một lần hỏi, hẹn lại sau 10 giây.
  4. Chọn cổng bỏ qua cổng mở breaker hoặc đầy; nếu mọi cổng đều không khả dụng thì dùng danh sách cũ (lời gọi sẽ bị từ chối notSent).
  5. Nhật ký mỗi lần gọi: {at, gateway, method, ref, ms, outcome: ok|error|timeout|not_sent, error?} lưu PostgreSQL, truy vấn theo cổng và mã; không lưu thân request/response.
  6. protection.enabled=false thì không bọc.
- contract:
  guardAdapter(adapter, opts) -> {adapter, guard}; adapter bọc giữ nguyên thuộc tính (Object.create), chỉ đổi createPayment, query, cancel, refund, queryRefund, reconcileFeed.
  GatewayGuard: run(method, ref, fn, isFailure), available(), status() -> {gateway, state, consecutiveFailures, inflight, queued, openedAt, totals}. GuardError{code: circuit_open|overloaded|timeout, notSent}.
  Mặc định: timeoutMs 15000, maxConcurrent 100, maxQueue 400, queueWaitMs 5000, failureThreshold 5, openSeconds 30. API: GET /gateways, GET /calls?gateway=&ref=&limit=.
- acceptance:
  - Mở/đóng/half_open đúng; chỉ một lời gọi thử khi half_open; thất bại khi thử thì mở lại (test/hub/guard.test.js).
  - Timeout không có cờ notSent; bulkhead từ chối ngay khi đầy và hàng chờ chạy khi có chỗ; chờ quá hạn thì rời hàng.
  - Hub: bỏ qua cổng mở breaker; cổng duy nhất mở: FAILED circuit_open và KHÔNG gọi cổng; timeout cổng createCanTimeout: UNKNOWN, cổng khác không bị gọi; refund notSent: FAILED rồi hoàn lại được; đối soát không tăng checks.
  - Nhật ký gọi có đủ trường, truy vấn được, không chứa thân request.
  - Kiểm chứng bằng đột biến: bỏ xử lý notSent hoặc đổi trạng thái refund thì test đỏ.
- tasks:
  - [x] guard.js (breaker, bulkhead, timeout, nhật ký)
  - [x] Hub dùng guard khi chọn cổng, tạo thanh toán, hoàn tiền, đối soát
  - [x] Bảng calls và API GET /gateways, GET /calls
  - [ ] Đo ngưỡng hợp lý theo từng cổng thật (timeout, đồng thời) khi có sandbox

## PHUB-S-011: Webhook đi tới cửa hàng: hộp thư đi bền vững, ký số, gửi lại theo bậc
- from: PHUB-D-011
- derived_from: 60d2f76e
- status: ready
- requirement:
  1. Cấu hình hub.webhooks{url, secret, timeoutMs=5000, maxAttempts=16, backoffSeconds=[5,30,120,600,1800,3600,10800,21600], concurrency=10}. Không có url thì tắt; có url mà thiếu secret hoặc không phải http(s) thì lỗi khi khởi động.
  2. Sự kiện: payment.paid (lần đầu PAID, kể cả áp dụng anomaly late_success), payment.closed, refund.updated (SUCCEEDED, FAILED, MANUAL_REQUIRED), anomaly.opened (mọi anomaly mới).
  3. Hộp thư đi: ghi qua store trong cùng persist() với thay đổi trạng thái; eventId = evt_ + sha256(loại|đối tượng|phiên bản)[0..32]; cùng eventId không ghi hai lần (khi webhook còn trong bộ nhớ).
  4. Gửi: POST JSON {id, type, createdAt, data}; header X-Hub-Event-Id, X-Hub-Timestamp (giây), X-Hub-Signature = HMAC-SHA256 hex của `${timestamp}.${thân}` với secret. Thân giữ nguyên giữa các lần gửi. 2xx = delivered; khác 2xx, lỗi mạng, timeout = thất bại, hẹn lại theo backoffSeconds; đủ maxAttempts thì dead.
  5. Gửi song song tối đa concurrency, không chặn xử lý callback; quét hộp thư đi tối đa mỗi 250ms sau thao tác, và theo bộ lập lịch.
  6. Webhook đã delivered hoặc dead và đã lưu thì rời bộ nhớ, vẫn truy vấn từ DB. Gửi lại thủ công chỉ cho dead hoặc pending (đặt lại số lần, đến hạn ngay); delivered hoặc không tồn tại thì lỗi.
- contract:
  EventOutbox (src/events.js, trước đây WebhookOutbox){emit(type, objectId, version, data, shopId, opts), due(now), deliverDue(), retry(id)}; sink webhook ở src/connectors/out/webhook.js, hub.outbox đổi tên thành hub.events (xem PHUB-S-017); hub.deliverWebhooks(), hub.retryWebhook(id), hub.listWebhooks({status, limit}).
  API: GET /webhooks?status=&limit=, POST /webhooks/{id}/retry (404 không có, 409 không ở trạng thái gửi lại được). Danh sách không trả thân webhook.
  Phía cửa hàng: xác minh chữ ký, chống trùng theo X-Hub-Event-Id, trả 2xx. Webhook chỉ là thông báo, nguồn sự thật là GET /payments/{id}.
- acceptance:
  - Chữ ký khớp HMAC tính độc lập trong test; header và id khớp thân (test/hub/webhooks.test.js).
  - IPN trùng không sinh thêm sự kiện.
  - Bậc gửi lại, chưa đến hạn thì không gửi, cùng eventId và cùng thân; hết lượt thì dead; gửi lại thủ công; từ chối gửi lại delivered.
  - payment.closed, refund.updated (thủ công và xác nhận), anomaly.opened được phát.
  - Bền vững qua khởi động lại (PostgreSQL): webhook pending được nạp và gửi; delivered rời bộ nhớ nhưng truy vấn được và không gửi lại.
  - Song song không vượt concurrency. Kiểm chứng bằng đột biến: đổi công thức ký thì test đỏ.
- tasks:
  - [x] events.js (hộp thư đi, gửi lại, dead, thủ công) và connectors/out/webhook.js (ký)
  - [x] Hub phát sự kiện trong cùng persist; bộ gửi nền
  - [x] Lưu PostgreSQL, rời bộ nhớ khi xong; API vận hành
  - [ ] Thử với một cửa hàng thật (xác minh chữ ký phía nhận, chống trùng)
  - [ ] Endpoint riêng theo cửa hàng (hiện một url chung)

## PHUB-S-012: Bộ nhớ nóng: đẩy giao dịch đã đóng ra khỏi bộ nhớ, nạp lại theo yêu cầu, khóa idempotency có hạn dùng
- from: PHUB-D-012
- derived_from: f6e659ee
- status: ready
- requirement:
  1. Bó giao dịch (payment + attempt + refund + anomaly + khóa idempotency của attempt) được đẩy ra khỏi bộ nhớ bởi store.evictIdle(idleMs) chỉ khi: payment PAID/CLOSED; không attempt sống; không refund mở; không anomaly mở; không thực thể bẩn; không đổi/dùng quá idleMs. MemoryStore không bao giờ đẩy ra.
  2. Trước khi dùng, Hub nạp lại từ DB: thông báo/sự kiện sao kê nạp attempt theo (cổng, mã không phân biệt hoa thường); createPayment nạp payment mới nhất của (cửa hàng, orderId); createAttempt, refund, markRefundDone, resolveAnomaly nạp theo id. Nhiều yêu cầu đồng thời nạp cùng một bó chỉ nạp một lần.
  3. Khởi động chỉ nạp payment OPEN, attempt sống, hoàn tiền mở, anomaly mở (cùng bó của chúng), anomaly không gắn payment, khóa idempotency của tiền chưa rõ chủ, webhook chưa giao.
  4. Bảng seen có cột at; purgeSeen(ttlDays) xóa khóa quá hạn; bộ lập lịch gọi mỗi giờ (hot.seenTtlDays=90). Trạng thái attempt vẫn chống trùng khi khóa hết hạn.
  5. Đọc qua pool kết nối riêng. API: loadPayment(id), findAnomalies(filter) đọc cả phần đã đẩy ra; GET /payments/{id} và GET /anomalies dùng chúng.
  6. Cấu hình hot{idleSeconds=120, evictEverySeconds=10, seenTtlDays=90}.
- contract:
  Store: evictIdle(idleMs, now?) -> số payment đã bỏ; hydratePayment(id), hydrateOrder(orderId, shopId?), hydrateByRef(gateway, ref), hydrateAttempt(id), hydrateRefund(id), hydrateAnomaly(id), prepareEvent(gateway, event), findAnomalies({type,status,limit}), purgeSeen(ttlDays), adoptSeen(keys), counts(). MemoryStore: các hàm hydrate là no-op.
  Hub: loadPayment(id), findAnomalies(filter). getPayment/listAnomalies đồng bộ chỉ nhìn bộ nhớ.
  Chỉ mục DB: docs(kind, paymentId), docs partial (kind, status) cho trạng thái còn hoạt động, docs payment theo (cửa hàng, orderId), docs attempt theo (cổng, lower(ref)), seen(k text_pattern_ops), seen(at).
- acceptance:
  - Điều kiện đẩy ra đúng: payment mở, hoàn tiền mở, anomaly mở, thực thể bẩn, còn tươi đều được giữ (test/hub/hot.test.js).
  - Sau khi đẩy ra: IPN trùng vẫn là duplicate (khóa idempotency nạp cùng attempt); kết quả mâu thuẫn vẫn thành anomaly; 8 callback trùng đồng thời chỉ nạp một bản; hoàn tiền và xử lý anomaly làm được; GET /payments/{id} và GET /anomalies thấy.
  - createPayment cùng orderId sau khi đẩy ra trả payment cũ, kể cả khi payment cũ hơn (CLOSED) còn trong bộ nhớ mà payment mới (PAID) đã đẩy ra (không tạo lần thu thứ ba).
  - Khởi động lại chỉ nạp phần còn hoạt động; tiền chưa rõ chủ vẫn chống trùng; giao dịch đã đóng tìm lại được theo mã và theo đơn.
  - purgeSeen xóa khóa quá hạn, giữ khóa mới; bộ lập lịch tự đẩy ra.
  - Kiểm chứng bằng đột biến: bỏ kiểm tra bẩn, bỏ kiểm tra anomaly mở, bỏ hydrateOrder, bỏ prepareEvent đều làm test đỏ.
- tasks:
  - [x] Đẩy bó giao dịch đã đóng ra khỏi bộ nhớ (evictIdle)
  - [x] Nạp theo yêu cầu (hydrate*) tại các thao tác công khai
  - [x] Khởi động chỉ nạp phần còn hoạt động
  - [x] Hạn dùng khóa idempotency (purgeSeen)
  - [x] Đọc qua pool riêng
  - [ ] Đẩy theo áp lực bộ nhớ (hiện chỉ theo thời gian nhàn rỗi)
  - [ ] Đo trên dữ liệu hàng triệu dòng (truy vấn khởi động và chỉ mục chưa thử ở quy mô đó)

## PHUB-S-013: Quan sát được: metrics Prometheus, log có cấu trúc kèm mã yêu cầu, nhật ký truy cập
- from: PHUB-D-013
- derived_from: d121890d
- status: ready
- requirement:
  1. GET /metrics (Bearer token quản trị hoặc metricsToken; token cửa hàng 403; không tính giới hạn tốc độ) trả văn bản Prometheus.
  2. Số đo: hub_http_requests_total và hub_http_request_duration_seconds theo (route mẫu, phương thức, mã); hub_ops_total và hub_op_duration_seconds theo thao tác công khai; hub_callbacks_total theo (cổng, kết quả); hub_gateway_calls_total và hub_gateway_call_duration_seconds theo (cổng, phương thức, kết quả); hub_persist_duration_seconds, hub_persist_errors_total; hub_webhook_deliveries_total theo (kết quả, cửa hàng); gauge: payment/attempt trong bộ nhớ, attempt sống, payment mở, hoàn tiền mở, thực thể bẩn, khóa idempotency, anomaly mở theo loại, webhook chờ, tuổi webhook chờ lâu nhất, breaker/đang gọi/đang chờ theo cổng, RSS, heap.
  3. Nhãn dùng route mẫu, không dùng đường dẫn thật. Giá trị nhãn được escape.
  4. Mã yêu cầu: X-Request-Id hợp lệ (chữ số, gạch ngang, gạch dưới, tối đa 64) được giữ; không hợp lệ hoặc thiếu thì sinh 16 hex; trả lại trong header; có trong mọi dòng log của request.
  5. Nhật ký truy cập một dòng JSON mỗi request (trừ /health): {level, msg, requestId, method, route, status, ms}. Không ghi query string, thân, header xác thực, id thật trong đường dẫn. Log lỗi 5xx có requestId và stack; phản hồi không lộ chi tiết. main.js thêm ts vào mỗi dòng.
- contract: Metrics{define, inc, observe, gauge, render}; hub.metrics; createHubServer({metricsToken, accessLog=true}); config metricsToken, accessLog.
- acceptance:
  - Nhãn escape, histogram cộng dồn với +Inf bằng count (test/hub/observe.test.js).
  - /metrics: 401 không token, 403 token cửa hàng, 200 token quản trị/metrics, không bị giới hạn tốc độ; chứa số đo mong đợi, không chứa id thật.
  - Token metrics không dùng được API khác.
  - Gauge anomaly theo loại, webhook chờ và tuổi, breaker.
  - Mã yêu cầu: dùng/thay/sinh đúng; có trong nhật ký truy cập; 503 và lỗi 500 cũng có.
  - Nhật ký truy cập không chứa thân, query, token, id thật; /health không ghi.
  - Đột biến: tắt nhật ký truy cập làm test đỏ.
- tasks:
  - [x] metrics.js (counter, histogram, gauge, văn bản Prometheus)
  - [x] Số đo trong Hub, guard, webhook, server
  - [x] Mã yêu cầu và nhật ký truy cập
  - [ ] Dashboard và luật cảnh báo mẫu (breaker mở, anomaly mở, webhook kẹt, persist lỗi)
  - [ ] Đẩy log ra nơi tập trung (hiện chỉ ra stderr của container)

## PHUB-S-014: Breaker bền vững qua khởi động lại
- from: PHUB-D-014
- derived_from: 40e87ab3
- status: ready
- requirement: Trạng thái breaker từng cổng (state mở/đóng, số lỗi liên tiếp, thời điểm mở) lưu vào store.extra.breakers mỗi khi đổi và được ghi cùng transaction ghi kế tiếp (meta key extra); khởi động khôi phục. Nửa mở lưu như mở. Cổng không còn trong cấu hình thì bỏ qua. Dữ liệu hỏng thì bỏ qua và dùng trạng thái đóng.
- contract: GatewayGuard.exportState() -> {state, failures, openedAt}; restore(saved); tùy chọn onChange(state). store.extra (đối tượng JSON nhỏ, lưu trong meta).
- acceptance:
  - exportState/restore đúng; nửa mở thành mở; dữ liệu hỏng bỏ qua; onChange chỉ gọi khi trạng thái đổi (test/hub/breaker-persist.test.js).
  - PostgreSQL: breaker mở sống qua khởi động lại, cổng không bị gọi cho tới khi hết thời gian nghỉ, rồi thử một lời gọi và đóng; trạng thái đóng cũng được lưu.
  - Trạng thái của cổng không còn trong cấu hình bị bỏ qua.
  - Đột biến: bỏ restore làm test đỏ.
- tasks:
  - [x] Xuất/nhập trạng thái guard
  - [x] Lưu cùng transaction (meta extra) và khôi phục khi khởi động

## PHUB-S-015: Nhiều cửa hàng: định danh theo token, cô lập dữ liệu, webhook riêng từng cửa hàng
- from: PHUB-D-015
- derived_from: 09f026ed
- status: ready
- requirement:
  1. Cấu hình shops[{id, apiToken (chuỗi hoặc mảng), webhooks}], apiToken gốc là token quản trị (chuỗi hoặc mảng để xoay vòng không gián đoạn), metricsToken tùy chọn. id cửa hàng khớp /^[a-z0-9_-]{1,32}$/; token cửa hàng dài tối thiểu 16 ký tự; mọi token khác nhau, nếu không thì Hub không khởi động.
  2. Token cửa hàng định danh cửa hàng; shopId của payment lấy từ token, không bao giờ từ thân; token quản trị chỉ định qua body.shopId (mặc định default). Payment cũ không có shopId là default.
  3. Cô lập: cửa hàng chỉ thao tác payment, attempt, refund, webhook của mình; của người khác hoặc không tồn tại đều 404. Route vận hành (anomaly, reconcile, gateways, calls, metrics, refund done) chỉ token quản trị (403 với token cửa hàng).
  4. Idempotency theo (shopId, orderId) kể cả khi payment đã đẩy ra khỏi bộ nhớ (chỉ mục DB theo cửa hàng và orderId).
  5. Webhook: sự kiện mang shopId của payment; gửi tới endpoint và ký bằng secret của cửa hàng đó, tra theo cấu hình lúc gửi; sự kiện không gắn payment đi tới endpoint mặc định nếu có; cửa hàng không có endpoint thì không phát sự kiện. GET /webhooks và retry bị cô lập theo cửa hàng.
  6. Mỗi người gọi (quản trị, từng cửa hàng) có bộ đếm tốc độ riêng. interpolate hỗ trợ ${VAR:-mặc định}; cấu hình webhook rỗng thì tắt.
- contract: config: shops[], apiToken (string|array), metricsToken, hub.webhooks{url,secret,...,shops{id:{url,secret,...}}}; createHubServer({apiToken, shops, metricsToken}); hub.shopOf({paymentId|attemptId|refundId}), hub.webhookShop(id); store.findPaymentByOrderId(orderId, shopId?), hydrateOrder(orderId, shopId?); listWebhooks({status,limit,shopId}).
- acceptance:
  - shopId từ token, giả danh qua thân bị bỏ qua; cùng orderId hai cửa hàng độc lập; idempotent và xung đột số tiền trong từng cửa hàng (test/hub/shops.test.js).
  - 404 cho payment, attempt, hoàn tiền của cửa hàng khác kể cả id không tồn tại; quản trị thấy hết.
  - 403 cho route vận hành với token cửa hàng.
  - Webhook tới đúng URL, ký đúng secret kiểm bằng HMAC tính độc lập, không ký bằng secret cửa hàng khác; cửa hàng không endpoint không nhận; sự kiện không gắn payment đi tới endpoint mặc định.
  - Xoay vòng: nhiều token quản trị/cửa hàng cùng hợp lệ; token bị thu hồi 401.
  - Token trùng, quá ngắn, id sai bị từ chối khi khởi động; cấu hình từ tệp đi vào Hub.
  - PostgreSQL: khóa đơn theo cửa hàng sau khi đẩy ra; cô lập giữ nguyên với payment nạp lại.
  - Đột biến: bỏ kiểm tra sở hữu, bỏ adminOnly, đổi nguồn shopId, bỏ cửa hàng khỏi khóa đơn, ký bằng secret sai đều làm test đỏ.
- tasks:
  - [x] Token cửa hàng, cô lập, token quản trị nhiều giá trị
  - [x] Khóa đơn theo cửa hàng (bộ nhớ và DB)
  - [x] Webhook riêng từng cửa hàng
  - [ ] Quản lý cửa hàng bằng API (hiện chỉ qua tệp cấu hình)
  - [ ] Xoay vòng secret webhook phía Hub (hiện: người nhận chấp nhận cả hai secret, rồi đổi cấu hình và khởi động lại)

## PHUB-S-016: Kiểm thử chịu lỗi: tải qua HTTP, cổng chậm/lỗi hàng loạt, giết Hub giữa tải
- from: PHUB-D-016
- derived_from: 65109ca6
- status: ready
- requirement:
  1. tools/bench/http-load.js đo tải qua HTTP thật (server HTTP của Hub, PostgreSQL, adapter giả), độ trễ phía khách.
  2. test/e2e/hub-faulty-gateway.test.js: lỗi chèn ở biên HTTP giữa adapter MoMo thật và simulator MoMo thật; cổng trả lời trễ quá timeout thì attempt UNKNOWN, không chuyển cổng, khách vẫn trả được và Hub ghi nhận qua IPN; cổng lỗi hàng loạt thì các giao dịch đầu UNKNOWN, breaker mở, giao dịch mới đi cổng còn lại, cổng lỗi không bị gọi thêm, đối soát không suy ra thất bại, hồi phục thì đóng lại.
  3. test/e2e/hub-crash.test.js, hai kịch bản: (a) Hub là tiến trình thật (main.js) bị SIGKILL hai lần giữa tải; (b) kết nối ghi của Hub tới PostgreSQL bị cắt hai lần giữa tải (Hub phải tự thoát để trình điều phối khởi động lại). Mỗi lần khởi động lại trên cùng PostgreSQL. Bất biến: mọi payment đã báo 201 còn nguyên (đơn, số tiền); mọi khoản cổng đã nhận đều thành PAID; số PAID bằng số khoản cổng đã nhận (không tiền ma), mỗi khoản đúng một attempt SUCCEEDED; không anomaly; mã tham chiếu không trùng.
- contract: Chạy: HUB_TEST_DATABASE_URL=... node --expose-gc tools/bench/http-load.js [tổng] [song song]. Test e2e nằm trong npm test (hub-crash cần PostgreSQL).
- acceptance:
  - hub-faulty-gateway: hai kịch bản đạt (test/e2e/hub-faulty-gateway.test.js).
  - hub-crash: cả hai kịch bản đạt ổn định (SIGKILL: nhiều lần chạy liên tiếp, khoảng 650-750 payment và 450-520 khoản đã trả ở cổng mỗi lần; cắt kết nối PostgreSQL: đạt, Hub tự thoát trong vài giây).
  - Kiểm chứng bằng đột biến: trả lời client trước khi lưu xong (không chờ persist) làm hub-crash đỏ (11 khoản cổng đã nhận mà Hub không PAID).
- tasks:
  - [x] Bench qua HTTP
  - [x] Test cổng chậm/lỗi hàng loạt
  - [x] Test giết Hub giữa tải
  - [x] Test mất kết nối PostgreSQL giữa tải
  - [ ] Chạy trên Linux và trên VM thật

## PHUB-S-017: Lớp kết nối dịch vụ (in/out) tách khỏi lõi và khỏi phía cổng thanh toán, thêm mới không sửa cũ
- from: PHUB-D-017
- derived_from: 9a04e8ed
- status: ready
- requirement:
  Hai trục độc lập (PHUB-D-017): phía cổng thanh toán (hub.js, adapters/, guard.js, contract.js) và phía kết nối dịch vụ (src/app/, src/connectors/); chỉ gặp nhau ở lõi qua hai cổng chuẩn.
  1. Cổng vào chuẩn: danh mục thao tác src/app/operations.js (createPayment, getPayment, createAttempt, createRefund, markRefundDone, listAnomalies, resolveAnomaly, reconcile, listGateways, listCalls, listWebhooks, retryWebhook). Mỗi thao tác khai báo vai trò, schema đầu vào/đầu ra, mã lỗi, binding HTTP. app.execute(op, input, principal) kiểm vai trò, kiểm schema (invalid_input kèm đường dẫn trường), gọi lõi, trả view an toàn (src/app/views.js). Lỗi có code là kết quả chính thức; lỗi không có code là hạ tầng.
  2. Cổng ra chuẩn: lõi chỉ gọi events.emit(type, objectId, version, data, shopId, {key}). Phong bì {id, type, createdAt, shopId, key, data}; key mặc định là paymentId. Một bản giao riêng cho mỗi tuyến khớp, có trạng thái/số lần thử/dead/gửi lại thủ công riêng. Tuyến ngầm "webhook" là cấu hình webhook cũ (mã bản giao = eventId); tuyến khai báo connectors.out[] {id, sink, shops, types, ...} có mã eventId~id. Lọc loại theo tên chính xác hoặc tiền tố "payment.*". Sink ordered: cùng (tuyến, key) đi theo thứ tự tạo, bản sau chờ bản trước xong hoặc dead.
  3. Thêm mới không sửa cũ: mỗi sink là một tệp src/connectors/out/*.js, mỗi nguồn vào là src/connectors/in/*.js xuất {kind, create}; registry quét thư mục và thư mục bổ sung (connectors.dirs). Trùng kind hoặc sai hợp đồng thì lỗi, không ghi đè ngầm.
  4. Sink: webhook (ký HMAC, như cũ) và kafka (topic, key = key sự kiện, header hub-event-id/type/shop, acks=all, producer idempotent, ordered). Nguồn vào: http (bảng route sinh từ danh mục) và kafka (lệnh {commandId, op, input, shopId?}).
  5. Lệnh qua Kafka đúng một lần theo commandId: khóa đã thấy, thay đổi trạng thái và phản hồi command.completed/command.failed (key commandId) ghi trong cùng một transaction (hub.transact). principal do cấu hình nguồn vào chỉ định, không lấy từ thông điệp. Lỗi nghiệp vụ thành phản hồi failed và commit; lỗi hạ tầng không commit, bỏ khóa, thử lại với chờ tăng dần có heartbeat; thông điệp hỏng thì sang topic DLQ. Khởi động từ chối nguồn vào nếu không có tuyến ra nào nhận command.completed.
  6. OpenAPI 3.1 sinh từ danh mục thao tác, danh mục sự kiện và schema đặt tên: GET /openapi.json (cần token), tệp docs/_generated/openapi.json (node tools/openapi.js). Sự kiện đi ra nằm ở mục webhooks, định dạng Kafka ở x-kafka.
- contract:
  app: createApp({hub|getHub, checkOutput}) -> {execute(op, input, principal), command({commandId, op, input, shopId?}, principal), operations()}. principal: {role:'admin'} | {role:'shop', id}. AppError{code}.
  events (src/events.js): EventOutbox({store, config:{url, secret, shops, routes, ...}, clock, sinks, metrics}) {emit(type, objectId, version, data, shopId, {key}), hasRoute(type, shopId?), due(now), deliverDue(), retry(id), endpointFor(shopId)}; hub.events (đổi tên từ hub.outbox); hub.transact(fn).
  sink: {kind, ordered, validate(route, name), deliver(delivery, route, {now}) -> {status?}, close?}. nguồn vào: {kind, create({app, config, deps, log}) -> {start, stop, handle}}. registry: buildSinks(deps, {extraDirs}), inboundKinds({extraDirs}).
  config: connectors:{dirs?, kafka:{brokers, clientId, ssl, sasl}, out:[{id, sink, shops, types, topic?, url?, secret?, maxAttempts?, backoffSeconds?, timeoutMs?}], in:[{id, source:'kafka', topic, groupId, principal, dlqTopic?, fromBeginning?}]}.
  store: hydrateSeen(key) (PostgresStore tra bảng seen), trimCommandKeys(max). Bản giao lưu như webhook cũ (kind 'webhook') thêm eventId, route, sink, key, seq.
  Phong bì lệnh: {commandId, op, input?, shopId?}. Phong bì sự kiện: {id, type, createdAt, shopId, key, data}. Danh mục sự kiện: payment.paid, payment.closed, refund.updated, anomaly.opened, command.completed, command.failed (src/app/schemas.js).
  Port có kiểu (src/app/ports.js, như contract.js của adapter cổng): typedef Delivery, Route, Sink, OutboundModule, InboundConnector, InboundModule, HubPort; assertSink (kind, ordered, validate, deliver), assertInbound (start, stop), assertHubPort. EventOutbox và registry kiểm sink khi dựng, createApp kiểm hub ở lần dùng đầu, buildInbound kiểm nguồn vào; connector ghi @type/@returns trỏ về các kiểu này. Kiểu là JSDoc + kiểm lúc chạy (chưa chạy tsc).
- acceptance:
  - test/hub/connectors-arch.test.js: connectors/* chỉ dùng app/* và nhau (không import hub, store, adapter, guard, contract, events, server, main); lõi, events, store, adapters không import connectors; app/* không import lõi; thêm connector ở thư mục ngoài (sink, nguồn vào) chạy trọn đường mà không sửa tệp nào; trùng kind và sai hợp đồng bị từ chối.
  - test/hub/events-routes.test.js: hai tuyến hai bản giao (mã eventId~tuyến), trạng thái riêng (một đích lỗi không làm đích kia nhận trùng), lọc loại/cửa hàng, thứ tự ở sink ordered (kể cả khi bản trước dead), cấu hình tuyến sai thì dừng, webhook cũ chạy cạnh tuyến mới, bền vững qua khởi động lại (PostgreSQL).
  - test/hub/app-contract.test.js: OpenAPI hợp lệ cấu trúc; tệp sinh sẵn không lệch; mọi đường dẫn có route; chạy mọi thao tác qua HTTP thật với checkOutput, mọi phản hồi (thành công và lỗi) và mọi sự kiện phát ra đúng schema trong tài liệu; quyền theo danh mục (401/403); sai schema trả 400 kèm đường dẫn trường; app.execute không cần HTTP.
  - test/hub/kafka-connectors.test.js (broker giả): key/header/acks của sink; lệnh đúng một lần (hoàn tiền gửi trùng 3 lần chỉ hoàn một lần); lỗi nghiệp vụ thành command.failed; thông điệp hỏng vào DLQ; principal do cấu hình; lỗi hạ tầng không commit và thử lại; Kafka xuống thì sự kiện nằm lại hộp thư đi; khởi động từ chối cấu hình sai; đúng một lần qua khởi động lại; khóa, hiệu ứng và phản hồi cùng một lần persist (chèn lỗi persist ở lần 1, 2, 3).
  - test/e2e/kafka-live.test.js (Redpanda thật): 5 key x 40 sự kiện giữ thứ tự và cùng partition; lệnh qua topic thật đúng một lần; DLQ.
  - Chạy tay trên compose: dừng Redpanda, 20 thanh toán vẫn PAID, bật lại thì đủ 20 sự kiện payment.paid trên topic, không trùng, hộp thư đi về 0. infra/local/demo.js kiểm sự kiện ra topic và lệnh gửi trùng.
  - Đột biến (bỏ thứ tự, bỏ khóa lệnh, đưa phản hồi ra ngoài transaction, connector import lõi, token cửa hàng đổi shopId, dùng chung mã bản giao, bỏ key Kafka, coi lỗi nghiệp vụ là tạm thời) đều làm test đỏ.
- tasks:
  - [x] Danh mục thao tác, views, schema, app.execute, lỗi có mã
  - [x] Connector HTTP sinh route từ danh mục; GET /openapi.json; tools/openapi.js
  - [x] EventOutbox nhiều tuyến, bản giao riêng, thứ tự, hasRoute; hub.transact
  - [x] Sink webhook (tách từ webhooks.js) và sink kafka; nguồn vào kafka; registry quét thư mục
  - [x] Lệnh đúng một lần theo commandId, phản hồi cùng transaction, DLQ
  - [x] Redpanda trong docker-compose.yml, topic tạo sẵn, cấu hình local, demo
  - [ ] Chạy với broker production thật (xác thực SASL/TLS chưa thử), quyết định broker cho VM
  - [ ] Nguồn vào/ra khác (NATS JetStream...) khi có nhu cầu: thêm một tệp mỗi loại
  - [ ] Giới hạn: bản giao ordered đi một bản mỗi lượt cho mỗi key; chưa thử hàng triệu bản giao chờ

## PHUB-S-018: Mở rộng hợp đồng adapter và lõi theo đề xuất P2-P7 của SePay (state, receipts, reversed, nhiều mục cùng cổng, thử lại sau)
- from: PHUB-D-018
- derived_from: 782ffe6c
- status: ready
- requirement:
  Sáu thay đổi hợp đồng adapter/lõi, tương thích ngược (PHUB-D-018):
  1. P2 state: CreateResult.state (JSON thuần, tối đa 2048 byte) lưu ở attempt.state, không ra API cửa hàng; truyền lại cho query (đối soát và phân xử), refund, queryRefund, cancel. state sai (không phải đối tượng, quá lớn, không tuần tự hóa được) thì kết quả tạo thành unknown + sự kiện bad_create_result, attempt được giữ.
  2. P3 instructions: transferContent tùy chọn; thiếu bank/accountNumber hoặc amount không nguyên thì unknown + bad_create_result.
  3. P4 receipts: refund() nhận receipts [{txn, amount, at?}] (kiểu received: mọi khoản; kiểu succeeded: một khoản; anomaly giữ tiền: khoản của anomaly).
  4. P5 reversed: EventType mới, gatewayTxnId bắt buộc và ổn định giữa các kênh. Hub không tự đổi trạng thái: ghi attempt.reversedTotal, needsOperator, anomaly funds_reversed (dedupe theo mã và số tiền), anomaly.opened. Sự kiện trùng bị loại; đảo từng phần cùng mã là sự kiện khác nhau (khóa chống trùng gồm amount). refund() tính trên (đã nhận - đã đảo); đảo hết thì nothing_to_refund. funds_reversed chỉ resolve bằng ignore.
  5. P6 routing: nhiều mục gateways cùng id khi mỗi mục khai adapterProduct khác nhau (khóa id/adapterProduct); mục dùng product của nó khi payment có product "default", bị bỏ qua khi payment đòi product khác; failover loại theo khóa mục. Cùng id mà thiếu adapterProduct hoặc trùng khóa thì dừng khi khởi động.
  6. P7 retryLater: CallbackResult.retryLater làm Hub không đổi gì, ghi retry_later, trả ack('error') của adapter, đếm outcome retry_later.
- contract:
  contract.js: EVENT_TYPES có 'reversed'; STATE_MAX_BYTES=2048; checkCreateResult(res)->chuỗi lỗi|null; assertEvent từ chối reversed thiếu gatewayTxnId. Typedef: AdapterState, Receipt, CreateResult.state, CallbackResult.retryLater, TransferInstructions.transferContent?.
  hub: PaymentHub.routeKey(g); _productFor(g, payment); _applyReversed; _receiptsOf(attempt, held). attempt.state, attempt.reversedTotal. Tham số mới: query({..., state}), refund({..., state, receipts}), queryRefund({..., state}), cancel({attemptRef, state}).
  config: hub.gateways[] mục có thêm adapterProduct (tùy chọn). Anomaly mới: funds_reversed. Sự kiện hub: reversed (chỉ vào, không phát ra ngoài; ra ngoài là anomaly.opened).
  Test hỗ trợ: test/support/fake-adapter.js có createState, createMode 'bad_instructions', calls{query,refund,queryRefund,cancel}, body.retryLater.
- acceptance:
  - test/hub/contract-ext.test.js (14 test): state lưu và truyền lại (đối soát, refund, queryRefund, cancel), không lộ ra API, state hỏng thành unknown; instructions không cần transferContent và sai hình dạng thành unknown; receipts của ba loại attempt; reversed không đổi trạng thái, trùng không nhân đôi, đảo từng phần, hoàn tiền tính phần còn lại, resolve chỉ ignore, đi được từ kênh query; routing hai mục cùng id (B chính C dự phòng, failover đúng mục, product cụ thể, cấu hình sai); retryLater; bền vững qua khởi động lại (PostgreSQL).
  - test/sepay/*.test.js và test/e2e/hub-sepay-*.test.js: adapter SePay dùng đúng các điểm mới (SEPY-S-007).
  - Đột biến (failover theo cổng, reversed tự đổi payment, bỏ trừ phần đã đảo, bỏ state ở đối soát, retryLater ack ok, bỏ receipts, bỏ kiểm state, bỏ dedupe reversed) đều làm test đỏ.
  - 437 test cũ đạt sau khi đổi các test có kỳ vọng cũ (void, transferContent của B, ném lỗi thay retryLater).
- tasks:
  - [x] contract.js: reversed, state, receipts, retryLater, checkCreateResult
  - [x] hub.js: state, receipts, reversed, routing adapterProduct, retryLater
  - [x] Test lõi với adapter giả (14), đột biến
  - [x] Adapter SePay dùng các điểm mới (SEPY-S-007)
  - [ ] Áp dụng cho VNPay, MoMo, OnePAY nếu cổng cho phép (state cho id giao dịch phía cổng, reversed cho chargeback): chưa có nhu cầu đã biết
  - [ ] reversed qua sao kê (reconcileFeed) cho kiểu chuyển khoản: chưa có cổng nào phát
  - [x] Nạp lại bộ đệm của adapter từ attempt đang mở khi Hub khởi động (adapter.adopt): xong ở PHUB-D-025

## PHUB-S-019: Kịch bản đồng thời và ngẫu nhiên; khoản thu thứ hai cùng kênh; trần số tiền
- from: PHUB-D-019
- derived_from: 8c8aafef
- status: ready
- requirement:
  1. Bộ kịch bản đồng thời: 50 IPN thành công giống hệt cùng lúc chỉ cho một PAID và một payment.paid; 30 lời tạo cùng đơn cùng lúc chỉ tạo một payment, một attempt và một lần tạo ở cổng; 10 lời "thử lại" cùng lúc sau khi attempt thất bại chỉ tạo một attempt; failover đồng thời với cancelLive không để hai attempt cùng sống; hai attempt cùng payment báo thành công cùng lúc cho một PAID và một anomaly; 5 hoàn tiền cùng lúc không vượt số đã thu; đối soát đang hỏi cổng thì IPN về, hoặc hai lần reconcile chồng nhau, không làm lùi trạng thái hay sinh anomaly.
  2. Bộ kịch bản ngẫu nhiên theo seed (mặc định 300 seed x 90 bước; SEEDS, STEPS, SEED để chạy rộng hơn hoặc lặp lại một seed) với bất biến: payment OPEN chỉ đi tới PAID hoặc CLOSED rồi đứng yên; attempt đã có kết quả cuối không đổi; payment.paid đúng một sự kiện cho payment từng PAID; PAID bởi attempt không SUCCEEDED chỉ khi có anomaly applied; chữ ký sai không đổi gì; sai số tiền không thành giao dịch ghi nhận; hoàn tiền không vượt số đã thu trừ phần bị đảo; mọi khoản tiền được báo hợp lệ phải nằm trong giao dịch ghi nhận, khoản thu hoặc anomaly.
  3. Khoản thu thứ hai cùng kênh: attempt SUCCEEDED nhận "thành công" cùng kênh với mã giao dịch khác thì anomaly duplicate_charge một lần (dù lặp), outcome ok; khác kênh thì không kết luận (outcome duplicate); resolveAnomaly refund cho anomaly này bị từ chối, ignore được.
  4. Trần số tiền: createPayment từ chối (invalid_input) số không nguyên an toàn, <= 0, NaN, chuỗi, và > maxAmount trước khi gọi adapter; maxAmount cấu hình được và bị kiểm khi dựng Hub (1 đến MAX_SAFE_INTEGER/1000).
  5. Đầu vào cực đoan qua adapter và simulator thật của VNPay, MoMo, OnePAY: mô tả có ký tự đặc biệt thanh toán xong; số tiền lớn trong trần hoặc xong đúng số tiền hoặc bị cổng từ chối sạch lúc tạo; mô tả 300 ký tự được nhận hoặc từ chối sạch.
- contract: hub: DEFAULTS.maxAmount=1e12; PaymentHub kiểm maxAmount khi dựng; createPayment kiểm Number.isSafeInteger và <= maxAmount. _applyEvent: ở nhánh attempt không còn sống và cùng trạng thái, nếu type=succeeded, có gatewayTxnId và attempt.txnBySource[source] khác gatewayTxnId thì _anomaly('duplicate_charge', ..., {sameAttempt:true, firstTxn}) và trả 'ok'. attempt.txnBySource={[source]: gatewayTxnId} ghi ở lần thành công đầu (kiểu succeeded). resolveAnomaly: action refund trên anomaly có detail.sameAttempt ném invalid_state.
- acceptance: test/hub/scenarios-concurrency.test.js (12 test), test/hub/scenarios-random.test.js (300 seed x 90 bước; đã chạy thêm 4000 seed x 150 bước không lỗi), test/e2e/hub-edge-inputs.test.js (11 test). Kiểm đột biến: tắt điều kiện khoản thu thứ hai thì test ngẫu nhiên và test đồng thời cùng đỏ (đã thử).
- tasks:
  - [x] Bộ kịch bản đồng thời
  - [x] Bộ kịch bản ngẫu nhiên có bất biến và seed lặp lại được
  - [x] Khoản thu thứ hai cùng kênh
  - [x] Trần số tiền
  - [x] Đầu vào cực đoan qua simulator
  - [ ] Chạy bộ ngẫu nhiên trên PostgreSQL (hiện chỉ bộ nhớ)
  - [ ] Kịch bản ngẫu nhiên có simulator thật (hiện dùng adapter giả)
  - [ ] Xác nhận với cổng thật mã giao dịch có ổn định giữa IPN và truy vấn không

## PHUB-S-020: Mã lý do thất bại chuẩn: adapter dịch, lõi và chuyển cổng chỉ đọc mã chuẩn
- from: PHUB-D-020
- derived_from: a61b3ab6
- status: ready
- requirement:
  1. Bảng mã chuẩn FAIL_CODES: user_cancelled, expired, insufficient_funds, declined, gateway_error, invalid_request, unknown. Sự kiện chuẩn có failCode (chỉ cho failed|cancelled|expired; giá trị ngoài bảng hoặc loại khác bị assertEvent từ chối) và gatewayCode (mã gốc, chỉ để tra cứu). CreateResult rejected có failCode và gatewayCode tùy chọn.
  2. Bộ dịch mã createFailCodeMapper(gateway, mặc định, ghi đè): ghi đè thắng mặc định, mã số và chuỗi như nhau, mã lạ hoặc thiếu ra unknown, giá trị ngoài bảng hoặc không phải đối tượng bị từ chối ngay khi dựng adapter (nói rõ mã nào sai).
  3. Bảng mặc định: VNPay và MoMo theo bảng mã chính thức; OnePAY chỉ 99 user_cancelled và 253 expired; SePay rỗng. Mọi từ chối cục bộ khi tạo là invalid_request. Cấu hình adapters.<id>.failCodeMap ghi đè hoặc bổ sung, và CHỈ đổi lý do: loại sự kiện vẫn do code adapter quyết định, nên một thanh toán thành công không thể thành thất bại do cấu hình.
  4. Hub ghi attempt.failCode và attempt.gatewayCode khi attempt kết thúc không thành công (failCode thiếu hoặc sai ra unknown; null khi thành công hoặc Hub tự hủy), trả trong API (Attempt.failCode, gatewayCode) và đếm hub_attempt_failures_total{gateway,status,fail_code} (none khi Hub tự hủy).
  5. failover.skipOnFailCodes (mặc định rỗng, phải là danh sách mã chuẩn, sai thì Hub không khởi động): createAttempt với reason failover bị từ chối failover_not_applicable (HTTP 409) khi attempt cuối có failCode trong danh sách; mã khác vẫn chuyển cổng; customer_retry không bị chặn.
- contract: contract.js: FAIL_CODES; assertEvent kiểm failCode; typedef FailCode, CanonicalEvent.failCode|gatewayCode, CreateResult rejected.failCode|gatewayCode. adapters/fail-codes.js: createFailCodeMapper. hub: _finalize(attempt, state, reason, info) ghi failCode/gatewayCode và đếm; createAttempt kiểm skipOnFailCodes; DEFAULTS.failover.skipOnFailCodes=[]. app: attemptView, schema Attempt, errors (failover_not_applicable -> 409), operation createAttempt liệt kê lỗi mới. Cấu hình: adapters.<id>.failCodeMap, hub.failover.skipOnFailCodes.
- acceptance: test/hub/fail-codes.test.js (18 test): bộ dịch mã; cấu hình sai bị từ chối ở cả bốn adapter; assertEvent; Hub ghi mã lên attempt; skipOnFailCodes chặn đúng và customer_retry vẫn dùng được; số đo; lý do từ chối lúc tạo; từng cổng VNPay, MoMo, OnePAY với simulator thật (hủy và thất bại), và ghi đè failCodeMap qua simulator thật mà thanh toán thành công vẫn thành công. Kiểm đột biến: bỏ kiểm skipOnFailCodes, không ghi failCode, bỏ mã 24 của VNPay, đổi mặc định unknown thành declined: cả bốn đều làm test đỏ (đã thử).
- tasks:
  - [x] Bảng mã chuẩn và kiểm sự kiện
  - [x] Bộ dịch mã và cấu hình failCodeMap
  - [x] Bảng mặc định VNPay, MoMo, OnePAY, SePay
  - [x] Hub ghi mã, API, số đo
  - [x] skipOnFailCodes
  - [ ] Kiểm bảng mặc định với sandbox thật (mọi mã hiện chỉ theo tài liệu)
  - [ ] Bổ sung bảng OnePAY và SePay khi có tài liệu hoặc quan sát thật
  - [ ] Dùng lý do để chọn cổng hoặc đo tỉ lệ thành công (cần dữ liệu thật)

## PHUB-S-021: Hướng phụ thuộc phía cổng thanh toán: một chiều, có test; sơ đồ tầng tách import khỏi luồng chạy
- from: PHUB-D-021
- derived_from: 7c258f23
- status: ready
- requirement:
  1. Hướng import một chiều phía cổng: lõi (hub, events, store, store-postgres, guard, metrics, contract) không import adapter, connector, server, main hay index; contract.js không import gì.
  2. Mỗi adapter chỉ import thư mục của mình, adapters/fail-codes và contract; không import adapter anh em, lõi, kho, bảo vệ, connector, app. fail-codes chỉ import contract.
  3. Chỉ main.js và index.js import adapter ở ngoài thư mục adapters.
  4. Lõi không chứa tên cổng nào viết cứng (vnpay, momo, onepay, sepay), bỏ chú thích.
  5. Sơ đồ kiến trúc trong trang tổng hợp chồng các tầng từ ngoài vào trong (dịch vụ bên ngoài, lớp kết nối, Hub, hợp đồng chuẩn hóa, module cổng, cổng bên ngoài), mỗi tầng một hình chữ nhật, mũi tên ghi thứ đi qua; lớp kết nối chỉ liệt kê connector có thật (JetStream nét đứt, chưa có); mỗi cổng một ô với kiểu, hoàn tiền, hạn trả, tạo đơn lấy từ khai báo năng lực; lớn ra cả hai chiều khi có nhiều cổng; phần giải thích dưới sơ đồ nêu hướng import một chiều và ba điều chưa có (routing chưa tách, adapter chưa tự đăng ký, chưa có tầng kiểu).
- contract: Không đổi mã vận hành. test/hub/adapters-arch.test.js quét require tương đối của mã nguồn (bỏ chú thích). Sơ đồ kiến trúc do bộ sinh của dịch vụ vẽ (BSN_/.claude/plugin/mcp/generators/payment-hub/overview-arch.js) từ code-facts, contract (FAIL_CODES, EVENT_TYPES) và connectors/registry (discover).
- acceptance: test/hub/adapters-arch.test.js (10 test, gồm cả các ràng buộc thêm ở PHUB-D-023 và PHUB-D-029). Kiểm đột biến: cho VNPay import MoMo, cho lõi import adapter, đặt tên cổng trong lõi, cho contract import guard: cả bốn làm test đỏ (đã thử). Sơ đồ đã chụp bằng trình duyệt với 4 cổng thật ở khung 990px và 460px, và 24 cổng giả ở khung 990px: không bị cắt, các ô tự xuống hàng.
- tasks:
  - [x] Test hướng import một chiều
  - [x] Sơ đồ chồng tầng, mỗi tầng một hình chữ nhật
  - [x] Registry quét thư mục adapter (PHUB-D-023)
  - [x] Tách Routing khỏi lõi thành module riêng (PHUB-D-029)
  - [ ] Tầng kiểu khi có hai adapter cùng kiểu dùng chung code thật
  - [ ] Connector JetStream (hiện chỉ vẽ nét đứt)

## PHUB-S-022: VNPay mã 07 (trừ tiền, nghi ngờ) là pending, không phải thất bại
- from: PHUB-D-022
- derived_from: f4219d32
- status: ready
- requirement:
  1. mapResult VNPay trả pending cho vnp_ResponseCode 07 hoặc vnp_TransactionStatus 07 với mọi giá trị của trường còn lại (trừ trường hợp thành công 00/00).
  2. Mọi tổ hợp mã kết quả theo bảng chính thức ra đúng loại sự kiện chuẩn (có bảng test); mâu thuẫn hoặc thiếu trường luôn pending.
  3. Mã 07 qua Hub với simulator: attempt vẫn AWAITING, payment OPEN, không có lý do thất bại, createAttempt bị từ chối attempt_still_live, quá hạn đối soát thì needsOperator và anomaly stale_attempt, không bao giờ FAILED.
  4. Simulator VNPay trả TransactionStatus 07 cho mã 07.
- contract: src/adapters/vnpay/index.js: mapResult(rc, ts) có nhánh pending cho rc 07 hoặc ts 07; bảng FAIL_CODES không có 07. tools/sim/vnpay/server.js: resolveResult đặt status 07 khi code 07.
- acceptance: test/vnpay/suspected.test.js (2 test): bảng 23 tổ hợp mã và luồng 07 qua Hub. Kiểm đột biến: bỏ nhánh 07 làm cả hai test đỏ (đã thử).
- tasks:
  - [x] Sửa mapResult
  - [x] Bỏ 07 khỏi bảng lý do
  - [x] Simulator trả TransactionStatus 07
  - [x] Bảng test các tổ hợp mã
  - [ ] Kiểm kết quả cuối của giao dịch bị nghi ngờ với sandbox VNPay thật

## PHUB-S-023: Registry adapter: thêm cổng là thêm một thư mục, không sửa tệp nào đang có
- from: PHUB-D-023
- derived_from: e9b45e7a
- status: ready
- requirement:
  1. Registry quét src/adapters/*/index.js và các thư mục cấu hình adapterDirs (thư mục có index.js hoặc tệp .js đơn; bỏ qua _ và .); mỗi mô-đun xuất adapter = {id, create}.
  2. Trùng id và khai báo sai bị từ chối rõ ràng; thư mục adapterDirs không tồn tại bị từ chối; cổng không có trong registry hoặc adapter dựng ra id khác khai báo làm Hub không khởi động và nói rõ.
  3. Cổng mới ở thư mục ngoài chạy trọn đường (dựng Hub, tạo thanh toán, callback, PAID) mà không sửa tệp nào của Hub.
  4. deps của create() có fetch, clock, publicBaseUrl (đã bỏ dấu / cuối); MoMo lấy ipnUrl mặc định từ publicBaseUrl, cấu hình tường minh thắng.
  5. main.js và index.js không chứa tên cổng nào; registry không import gì trong dự án.
- contract: adapters/registry.js: discover(extraDirs) trả Map id -> {id, create, source}. Mỗi module cổng xuất adapter = {id, create(config, deps)}. main.js: discoverAdapters(config.adapterDirs). Cấu hình mới: adapterDirs (danh sách thư mục).
- acceptance: test/hub/adapter-registry.test.js (7 test) và 2 test mới trong test/hub/adapters-arch.test.js. Kiểm đột biến: tên cổng trong main.js, bỏ khai báo adapter của VNPay, cho registry import hub: cả ba làm test đỏ (đã thử).
- tasks:
  - [x] Registry và khai báo adapter ở bốn cổng
  - [x] main.js và index.js dùng registry
  - [x] Chuyển mặc định ipnUrl của MoMo vào module MoMo
  - [x] Test kiến trúc cho registry và điểm nối
  - [ ] Nạp lại cổng không cần khởi động lại Hub (chưa cần)

## PHUB-S-024: Lệnh kiểm cấu hình trước khi chạy; adapter kiểm khóa bắt buộc khi dựng
- from: PHUB-D-024
- derived_from: 0b867094
- status: ready
- requirement:
  1. checkConfig gom mọi lỗi trong một lần chạy và trả {ok, errors, warnings, summary}; thiếu biến môi trường nêu tên biến và vị trí dùng; cổng tắt không bắt buộc có bí mật.
  2. Mọi điều làm Hub không khởi động đều được báo: cổng lạ, failCodeMap sai, failover.skipOnFailCodes sai, maxAmount sai, cửa hàng trùng, nguồn vào Kafka thiếu tuyến trả lời, adapter thiếu khóa.
  3. Không gọi mạng, không kết nối cơ sở dữ liệu nếu không có --connect (DB không tới được vẫn ra hợp lệ nhanh); adapter cố gọi mạng khi dựng bị chặn và báo lỗi.
  4. Cảnh báo không làm cấu hình thành lỗi: publicBaseUrl trống hoặc không https, metricsToken trống, cổng trỏ môi trường thử, SePay authMode none.
  5. Dòng lệnh: mã thoát 0 hợp lệ, 1 khi sai, khi tệp không đọc được hoặc không phải JSON, hoặc khi không truyền tệp và không có HUB_CONFIG.
  6. --connect chạy SELECT 1, không tạo schema; sai mật khẩu thì báo lỗi.
  7. MoMo thiếu partnerCode, accessKey hoặc secretKey bị từ chối khi dựng; SePay thiếu accountNumber, bankName (qr-static), apiKey (authMode apikey), hmacSecret (authMode hmac), hoặc authMode lạ bị từ chối khi dựng.
- contract: src/check-config.js: checkConfig(raw, env, {connect, buildHub, buildInbound}), report(res, write) trả mã thoát, missingEnv. src/main.js: checkMain(argv, env, write); cờ --check-config và --connect; npm run check-config. Adapter MoMo và SePay ném lỗi khi dựng với cấu hình thiếu khóa.
- acceptance: test/hub/check-config.test.js (13 test, kể cả chạy tiến trình thật để kiểm mã thoát và --connect trên PostgreSQL thật). Kiểm đột biến: bỏ buildInbound, dừng ở biến thiếu đầu tiên, bỏ chặn mạng khi dựng: cả ba làm test đỏ (đã thử, riêng chặn mạng cần thêm test adapter cố gọi mạng).
- tasks:
  - [x] Lệnh kiểm và mã thoát
  - [x] Gom mọi lỗi, cảnh báo
  - [x] --connect (PostgreSQL)
  - [x] MoMo và SePay kiểm khóa khi dựng
  - [ ] Gọi lệnh kiểm trong scripts/deploy.ps1 trước khi đẩy
  - [ ] Kiểm kết nối Kafka (--connect hiện chỉ PostgreSQL)
  - [ ] Kiểm khóa của OnePAY và VNPay có đủ trường tuỳ chọn (hiện chỉ trường bắt buộc)

## PHUB-S-025: Adapter nạp lại bộ đệm từ attempt còn sống khi Hub khởi động (adopt)
- from: PHUB-D-025
- derived_from: ceab7caa
- status: ready
- requirement:
  1. Adapter có thể khai báo adopt({attempts}); Hub.adoptAdapters gọi một lần với các attempt còn sống của đúng cổng (attemptRef, product, state, createdAt), trả {cổng: số đã nạp | 'error'}.
  2. Adapter không có adopt bị bỏ qua; adopt ném lỗi thì ghi adopt_error và Hub vẫn chạy.
  3. main() gọi adoptAdapters trước khi mở cổng nhận request.
  4. SePay B: sau adopt, webhook VA đầu tiên khớp attempt từ bộ đệm mà không gọi API danh sách đơn; không adopt thì phải quét. Attempt không có state hoặc thuộc sản phẩm khác bị bỏ qua.
  5. SePay: adopt khôi phục gợi ý sản phẩm của attempt, nên hủy sau khởi động lại đi đúng đường (theo state) không phải dò.
- contract: contract.js: Adapter.adopt?(p:{attempts:Array<{attemptRef, product, state?, createdAt}>}) => number|void|Promise. hub: adoptAdapters() trả báo cáo. sepay: adapter.adopt và va-order.adopt(a).
- acceptance: test/sepay/adopt.test.js (5 test): webhook sau khởi động có và không adopt (đếm GET danh sách đơn), bỏ qua attempt không hợp lệ và hủy theo state, Hub khởi động lại trên cùng kho, cô lập lỗi adopt, thứ tự adoptAdapters trước listen. Kiểm đột biến: adopt không nạp bộ đệm, Hub không bắt lỗi adopt, adopt sau listen: cả ba làm test đỏ (đã thử).
- tasks:
  - [x] adopt trong hợp đồng và Hub
  - [x] SePay B nạp bộ đệm VA, khôi phục gợi ý sản phẩm
  - [x] Gọi trước khi mở cổng
  - [ ] Đo thời gian adopt với số attempt còn sống lớn
  - [ ] Kiểm với SePay thật (bộ đệm VA, số VA)

## PHUB-S-026: Kịch bản ngẫu nhiên trên PostgreSQL có khởi động lại, và cho phía giao tin ra; thứ tự giao tin theo bộ đếm đơn điệu
- from: PHUB-D-026
- derived_from: 45337c57
- status: ready
- requirement:
  1. Bộ chạy ngẫu nhiên dùng chung cho kho bộ nhớ và PostgreSQL; chế độ PostgreSQL có khởi động lại Hub và evict; bất biến: payment chỉ đi OPEN tới PAID hoặc CLOSED rồi đứng yên, attempt đã có kết quả cuối không đổi, payment.paid đúng một sự kiện, id không trùng, nạp lại từ kho cho cùng trạng thái cuối, mọi khoản tiền được báo hợp lệ nằm trong giao dịch ghi nhận, khoản thu hoặc anomaly.
  2. Bộ chạy giao tin ra: không mất tin, mọi bản giao cuối cùng delivered hoặc dead, không gửi lại sau khi sink đã xác nhận, đúng phạm vi cửa hàng và loại sự kiện, đúng thứ tự tạo theo (tuyến, key) với sink có thứ tự, kể cả sau khởi động lại (PostgreSQL).
  3. events.due sắp bản chờ theo thứ tự tạo cho sink có thứ tự: bản dead cũ được gửi lại thủ công đi trước bản mới hơn cùng key đang chờ.
  4. Mỗi bản giao có ord tăng đơn điệu từ store.nextSeq (lưu cùng bộ đếm id); bản giao cũ không có ord đi trước bản có ord.
  5. Test mất kết nối PostgreSQL chỉ ngắt kết nối giữ khóa advisory của schema của nó.
  6. Giới hạn emit trùng sau khởi động lại đã được sửa ở PHUB-D-030 (test xác định thay cho test todo).
- contract: test/support/random-runner.js: runSeed(seed, {steps, db}). test/support/delivery-runner.js: runDelivery(seed, {steps, db}). store.nextSeq(); events: delivery.ord, hàm so sánh byCreation dùng trong due(). Biến môi trường: SEEDS, STEPS, SEED (bộ nhớ); PG_SEEDS, PG_STEPS, SEED (PostgreSQL).
- acceptance: test/hub/scenarios-random.test.js (300 seed), scenarios-random-pg.test.js (30 seed, có khởi động lại và evict; đã chạy thêm 200 seed x 150 bước không lỗi), scenarios-delivery.test.js (300 seed và một ca xác định về gửi lại thủ công), scenarios-delivery-pg.test.js (40 seed có khởi động lại, và hai ca xác định về phát lại sau khởi động lại, xem PHUB-D-030). Kiểm đột biến: bộ PostgreSQL bắt được việc không lưu anomaly, không nạp lại bộ đếm id, không lưu trạng thái attempt đã đóng; bộ giao tin bắt được việc không sắp theo thứ tự tạo, bỏ ord, không đánh dấu delivered, không chặn bản sau của sink có thứ tự (đã thử cả bảy).
- tasks:
  - [x] Bộ chạy ngẫu nhiên PostgreSQL có khởi động lại và evict
  - [x] Bộ chạy ngẫu nhiên giao tin ra (bộ nhớ và PostgreSQL)
  - [x] Sửa thứ tự giao tin sau gửi lại thủ công
  - [x] Bộ đếm thứ tự đơn điệu (ord)
  - [x] Cô lập test mất kết nối PostgreSQL theo schema
  - [x] Chống trùng khi phát lại sự kiện sau khởi động lại: xong ở PHUB-D-030
  - [x] Kịch bản ngẫu nhiên với simulator thật của ba cổng chuyển hướng: xong ở PHUB-D-028
  - [ ] Kịch bản với Kafka thật (Redpanda) cho phía giao tin ra

## PHUB-S-027: Hỏi lại attempt đã đóng không thành công để bắt tiền về muộn khi IPN mất hẳn
- from: PHUB-D-027
- derived_from: 284471d9
- status: ready
- requirement:
  1. Attempt đóng không thành công được đặt attempt.recheckAt = lúc đóng + mốc đầu của closedRecheckSeconds (mặc định [3600, 86400]); mỗi lần đến hạn reconcile gọi query của adapter và áp kết quả qua đường xử lý sự kiện; tìm thấy tiền thì anomaly late_success (duplicate_charge nếu payment đã PAID bởi attempt khác); trạng thái cuối của attempt và payment không đổi.
  2. Hỏi hết các mốc thì xóa lịch (recheckAt null, rechecks bằng số mốc); không tìm thấy gì thì không anomaly.
  3. Không đặt lịch khi: thành công, cổng từ chối lúc tạo, cổng không truy vấn được, cổng có reconcileFeed, hoặc cấu hình [] (toàn cục hoặc theo cổng). Hub tự hủy attempt vẫn được hỏi lại.
  4. Lỗi gọi cổng: thử lại sau 10 phút, quá 5 lần liên tiếp thì ngừng và ghi anomaly recheck_failed; lần thành công đặt lại bộ đếm lỗi.
  5. closedRecheckSeconds sai (không phải mảng, số không dương, không tăng dần) bị từ chối khi dựng Hub, cả toàn cục lẫn theo cổng.
  6. Số đo hub_closed_rechecks_total{gateway,outcome}.
  7. PostgreSQL: lịch sống sót qua khởi động lại; payment còn lịch không bị evict và được nạp lại khi khởi động; tìm thấy tiền sau khi nạp lại.
  8. Với simulator MoMo và VNPay: khách trả muộn trên attempt đã FAILED và IPN mất hẳn thì Hub có anomaly late_success sau các mốc; OnePAY (từ chối trả trên hóa đơn đã đóng) thì không có gì.
- contract: hub: _scheduleRecheck(attempt, info) gọi cuối _finalize khi không thành công (info.neverCreated bỏ qua); reconcileClosed(now) gọi trong reconcile; DEFAULTS.reconcile.closedRecheckSeconds=[3600,86400]. Trường attempt: recheckAt, rechecks, recheckErrors. store: recheckAttempts(), tập _recheck, evictIdle giữ payment còn lịch; store-postgres: _load nạp payment có attempt recheckAt không null.
- acceptance: test/hub/closed-recheck.test.js (14 test): lịch và mốc, hỏi hết thì dừng, duplicate_charge, tắt toàn cục và theo cổng, ghi đè theo cổng, các trường hợp không đặt lịch, tự hủy, lỗi và recheck_failed, kiểm cấu hình, số đo, MoMo và VNPay và OnePAY với simulator, và PostgreSQL (khởi động lại, evict, nạp lại). Kiểm đột biến: không đặt lịch, bỏ điều kiện neverCreated, không chặn evict, PostgreSQL không nạp lại payment có lịch, không áp dụng kết quả hỏi lại: cả năm làm test đỏ (đã thử).
- tasks:
  - [x] Lịch hỏi lại theo mốc, cấu hình toàn cục và theo cổng
  - [x] Bỏ qua cổng không cần (từ chối lúc tạo, không truy vấn, có sao kê)
  - [x] Xử lý lỗi và anomaly recheck_failed
  - [x] Kho bộ nhớ và PostgreSQL (evict, nạp lại)
  - [x] Số đo
  - [ ] Kiểm với cổng thật: có cho trả lại trên URL cũ không, và tốc độ giới hạn truy vấn
  - [ ] Đối soát theo sao kê của cổng chuyển hướng (bắt tiền về sau mốc cuối)

## PHUB-S-028: Kịch bản ngẫu nhiên với simulator thật: simulator là sự thật nền về tiền đã thu
- from: PHUB-D-028
- derived_from: 21b8d338
- status: ready
- requirement:
  1. runSimSeed(seed, {gateways, steps, db}) dựng thế giới (Hub, simulator, adapter thật) cho một hoặc hai cổng chuyển hướng và chạy chuỗi việc ngẫu nhiên lặp lại được bằng seed.
  2. Bất biến từng bước: payment chỉ đi OPEN tới PAID hoặc CLOSED rồi đứng yên, attempt đã có kết quả cuối không đổi, payment.paid đúng một sự kiện cho payment PAID.
  3. Cuối chuỗi (tắt lỗi, thời gian trôi qua các mốc): mọi giao dịch simulator đã thu phải được Hub ghi nhận (SUCCEEDED, anomaly hoặc cờ người vận hành), trừ giới hạn đã biết (khách trả sau mốc hỏi lại cuối trên attempt đã đóng); không attempt nào SUCCEEDED mà simulator chưa thu; payment PAID có attempt trả tiền.
  4. Chạy được với một cổng và hai cổng, và trên PostgreSQL có khởi động lại Hub.
  5. Bộ chạy phải thực sự có giao dịch đã thu ở cổng để kiểm (không kiểm rỗng).
- contract: test/support/sim-runner.js: runSimSeed, paidAtGateway(id, driver) đọc /sim/transactions của simulator. Biến môi trường: SIM_SEEDS, SIM_STEPS, SEED.
- acceptance: test/e2e/scenarios-sim.test.js (6 test: VNPay, MoMo, OnePAY, VNPay+MoMo, MoMo+OnePAY, và VNPay+MoMo trên PostgreSQL). Đã chạy 150 seed x 80 bước cho từng tổ hợp trong bộ nhớ, không lỗi. Kiểm đột biến: tắt hỏi lại attempt đã đóng làm bộ này thấy TIỀN VÔ HÌNH, coi thất bại là thành công làm nó thấy BÁO THU KHỐNG (đã thử cả hai).
- tasks:
  - [x] Bộ chạy với simulator thật, một và hai cổng
  - [x] Bất biến tiền không vô hình và không báo thu khống
  - [x] Bản PostgreSQL có khởi động lại
  - [ ] Phủ SePay (kiểu chuyển khoản, sao kê) với simulator
  - [ ] Phủ hoàn tiền sâu và vòng đời hoàn tiền
  - [ ] Đối chiếu sự thật nền với cổng thật khi có sandbox

## PHUB-S-029: Routing là module riêng và chọn theo phương án thanh toán chuẩn
- from: PHUB-D-029
- derived_from: 356858f3
- status: ready
- requirement:
  1. src/routing.js xuất routeKey, productFor, methodsOf, validateGateways, candidates; chỉ import contract; Hub gọi qua đó (hub._candidates, validateRouting, routeKey, _productFor), hành vi chọn cổng cũ không đổi.
  2. contract.METHODS gồm wallet, qr, bank_transfer, virtual_account, card_domestic, card_international; Capabilities.methods tùy chọn; assertAdapterShape từ chối methods ngoài danh mục.
  3. createPayment.method tùy chọn: ngoài danh mục bị từ chối invalid_input; hợp lệ thì lưu trên payment (null khi không đòi); routing chỉ chọn mục phục vụ phương án đó, không có thì no_gateway_available; không đòi phương án thì chọn như cũ kể cả adapter không khai methods.
  4. hub.gateways[].methods ghi đè khai báo adapter cho mục đó; sai (không phải mảng hoặc ngoài danh mục) thì Hub không khởi động.
  5. Cùng cổng nhiều mục adapterProduct: mỗi mục có phương án riêng theo capabilities(adapterProduct), phương án chọn đúng sản phẩm.
  6. Failover giữ nguyên phương án đã yêu cầu.
  7. Operation createPayment nhận method (enum khớp contract.METHODS), Payment trả method; OpenAPI sinh lại.
  8. Bốn adapter khai methods hợp lệ cho từng sản phẩm đúng như khai báo thiết kế.
- contract: routing.candidates({gateways, adapters, payment, exclude, isAvailable}); routing.methodsOf(g, adapters, payment); routing.validateGateways(gws, adapters) trả tập id; routing.routeKey(g); routing.productFor(g, payment). payment.method. contract: METHODS, typedef Method, Capabilities.methods.
- acceptance: test/hub/routing-methods.test.js (9 test): chọn theo phương án, không đòi thì như cũ, ghi đè bằng cấu hình, nhiều mục adapterProduct, failover giữ phương án, phương án sai ở ba chỗ, routing là hàm thuần, thao tác và enum, bốn adapter thật. test/hub/adapters-arch.test.js thêm ràng buộc routing chỉ import contract và không có tên cổng. Kiểm đột biến bằng công cụ chạy an toàn (khôi phục được kiểm lại): bỏ lọc phương án, bỏ ghi đè cấu hình, routing import hub, không lưu method, không kiểm method khi tạo, không kiểm methods trong cấu hình, VNPay khai sai: cả bảy đều làm test đỏ.
- tasks:
  - [x] Tách routing thành module riêng chỉ biết hợp đồng
  - [x] Danh mục phương án chuẩn, methods trong năng lực
  - [x] createPayment.method và lọc routing
  - [x] Ghi đè bằng hub.gateways[].methods
  - [x] Khai báo của bốn adapter
  - [ ] Kiểm khai báo phương án với cổng thật
  - [ ] Routing theo số liệu đo được (tỉ lệ thành công, độ trễ) khi có dữ liệu thật
  - [ ] Tầng kiểu khi có hai adapter cùng kiểu dùng chung code thật

## PHUB-S-030: Phát lại sự kiện sau khởi động lại không giao lần hai: kho PostgreSQL bỏ bản trùng, hộp thư đi ghi bền trước khi gửi
- from: PHUB-D-030
- derived_from: 4431ad51
- status: ready
- requirement:
  1. Phát lại cùng (loại, đối tượng, phiên bản) sau khi bản cũ đã delivered hoặc dead và Hub khởi động lại: sink không nhận lần hai.
  2. Bản đã có trong kho không bị ghi đè (status, attempts, deliveredAt giữ nguyên); kho không còn bản pending cùng mã; duplicateWebhooks tăng một cho mỗi bản trùng bị bỏ.
  3. Webhook nạp từ kho khi khởi động hoặc đã ghi xuống không bị coi là mới; thay đổi sau đó (delivered, retry) vẫn lưu bằng upsert.
  4. Hộp thư đi ghi bền bản mới trước khi gửi và không gửi bản đã bị kho bỏ.
  5. Kho bộ nhớ và mọi hành vi của emit với sự kiện không trùng giữ nguyên.
- contract: store.isNewWebhook(id): boolean (kho bền vững theo dõi; kho bộ nhớ luôn false). PostgresStore.duplicateWebhooks: số bản trùng đã bỏ. EventOutbox._send: gọi store.persist() trước khi gửi bản isNewWebhook, bỏ qua nếu store.getWebhook(id) không còn là bản đó.
- acceptance: test/hub/scenarios-delivery-pg.test.js: hai ca xác định (bản cũ delivered và bản cũ dead) mở lại kho rồi phát lại: sink một lần, kho giữ đúng một bản ở trạng thái cũ với attempts 1, không có bản pending, duplicateWebhooks bằng 1. Bộ ngẫu nhiên giao tin trên PostgreSQL (40 seed có khởi động lại) và toàn bộ test vẫn đạt. Kiểm đột biến: bỏ bước ghi bền trước khi gửi, bỏ việc tách bản mới khỏi upsert (ghi đè bản cũ), không bỏ bản trùng khỏi bộ nhớ: cả ba làm test đỏ (đã thử).
- tasks:
  - [x] Đánh dấu webhook mới ở kho
  - [x] Chèn nếu chưa có và bỏ bản trùng ở kho PostgreSQL
  - [x] Ghi bền bản mới trước khi gửi
  - [x] Test xác định cho cả hai trạng thái cuối
  - [ ] Phát hiện trùng khi bản mới bị gửi trước lần ghi đầu (hiện chưa có luồng nào như vậy)

## PHUB-S-031: Deploy kiểm cấu hình bằng image mới trên VM trước khi thay bản đang chạy
- from: PHUB-D-031
- derived_from: 343e57e6
- status: ready
- requirement:
  1. Deploy trên VM chạy --check-config bằng image mới, với .env và hub.config.json thật, sau pull và trước up.
  2. Kiểm lỗi thì không up, HUB_IMAGE trở về tag trước (nếu có), deploy.log có dòng hủy, script thoát mã khác 0.
  3. Kiểm đạt thì tiếp tục như cũ (up, chờ khỏe, rollback nếu không khỏe).
  4. Chỉ thêm --connect khi dịch vụ postgres đang chạy (lần deploy đầu chưa có).
- contract: scripts/deploy.ps1: kịch bản sh gửi qua ssh; mã thoát 1 khi kiểm cấu hình lỗi. Lệnh kiểm: docker compose run --rm --no-deps -T hub node src/main.js --check-config [--connect].
- acceptance: Kịch bản sh trích từ deploy.ps1 qua kiểm cú pháp sh -n; chạy với lệnh docker giả: kiểm lỗi thì thoát 1, .env giữ tag cũ, không gọi compose up; kiểm đạt thì gọi up, .env có tag mới, thoát 0. Kế hoạch khô (-Remote) in bước mới. Chưa chạy trên VM thật.
- tasks:
  - [x] Bước kiểm cấu hình trong kịch bản VM
  - [x] Hủy deploy và trả HUB_IMAGE khi kiểm lỗi
  - [x] Cập nhật README prod và skill cicd
  - [ ] Chạy thật trên VM (cần VM, Docker Hub private, tên miền)

## PHUB-S-032: Kafka thật: gửi tới broker đóng băng phải có hạn thời gian; kiểm bằng broker thật bị đóng băng và Hub khởi động lại
- from: PHUB-D-032
- derived_from: 7e44d593
- status: ready
- requirement:
  1. Một lần gửi Kafka tới broker không trả lời kết thúc lỗi trong thời gian có giới hạn (mặc định khoảng nửa phút ở nhiều nhất), không treo vòng giao tin.
  2. Cấu hình connectors.kafka nhận requestTimeoutMs, connectionTimeoutMs, retries (tùy chọn).
  3. Với broker thật bị đóng băng giữa chừng và Hub khởi động lại: không mất tin, lần nhận đầu của mỗi sự kiện đúng thứ tự theo key, mỗi key một partition.
- contract: src/connectors/_kafka.js: kafkaClient dùng cfg.requestTimeoutMs ?? 10000, cfg.connectionTimeoutMs ?? 3000; sharedProducer dùng deps.kafka.retries ?? 2. Biến môi trường test: HUB_TEST_KAFKA, HUB_TEST_KAFKA_CONTAINER, HUB_TEST_DATABASE_URL.
- acceptance: test/e2e/kafka-delivery-live.test.js: với Redpanda và PostgreSQL thật, 150 sự kiện, đóng băng broker 4 giây rồi khởi động lại Hub khi còn đóng băng: không thiếu sự kiện nào, thứ tự lần nhận đầu đúng, mỗi key một partition (đã chạy hai lần, trùng 1 và 3 bản). Kiểm đột biến: bỏ hạn thời gian thì test treo và bị kill (đã thử một lần; broker bị đóng băng lúc kill nên phải mở lại tay). Test kafka-live cũ vẫn đạt trên broker thật. Test đóng băng chỉ chạy khi đặt HUB_TEST_KAFKA_CHAOS=1: nó đóng băng broker dùng chung nên chạy chung với kafka-live làm kafka-live hết hạn và lỗi (đã gặp ở lần chạy toàn bộ đầu tiên); mặc định test bị bỏ qua có nêu lý do.
- tasks:
  - [x] Test Kafka thật với broker đóng băng và Hub khởi động lại
  - [x] Hạn thời gian cho client và producer Kafka
  - [x] Ghi khóa cấu hình mới vào README
  - [ ] Thử SASL/TLS và nhiều broker
  - [ ] Đo hạn thời gian phù hợp trên broker production

## PHUB-S-033: Ngôn ngữ chung cho cổng quốc tế: tiền kèm mã ISO 4217, mã thất bại mới, khả năng có kiểu, extra có schema
- from: PHUB-D-033
- derived_from: 460aebc7
- status: ready
- requirement: Lõi Hub nói được ngôn ngữ chung của cổng quốc tế mà không đổi hành vi bốn adapter hiện có. (1) createPayment nhận currency (ISO 4217, mặc định VND); loại lạ bị từ chối invalid_input; amount là số nguyên > 0 theo đơn vị nhỏ nhất; cùng đơn khác số tiền hoặc khác loại tiền là order_conflict. (2) Routing chỉ chọn cổng nhận loại tiền của payment: theo hub.gateways[].currencies, không thì capabilities.currencies, adapter không khai thì chỉ VND; không cổng nào nhận thì no_gateway_available. (3) Thông báo succeeded có currency khác payment là amount_mismatch, không đổi trạng thái. (4) FailCode có authentication_required, fraud, rate_limited; isRetriable chỉ đúng cho gateway_error và rate_limited, unknown không bao giờ. (5) assertAdapterShape kiểm khi khai: currencies, regions, operations, partialRefund, partialCapture, threeDs, amountLimits, extraSchema; vắng hết thì vẫn hợp lệ. (6) createPayment.extra = {idCổng: {khóa: giá trị}} kiểm theo extraSchema của adapter: cổng lạ, khóa lạ, sai kiểu, adapter không khai schema đều bị từ chối trước khi gọi cổng; adapter chỉ nhận phần của chính nó; lõi không đọc giá trị.
- contract: contract.js: CURRENCY_EXPONENT, OPERATIONS, EXTRA_TYPES, RETRIABLE_FAIL_CODES, isRetriable(failCode), checkExtra(extra, schema); CanonicalEvent.currency (tùy chọn); Capabilities.{currencies, regions, operations, partialRefund, partialCapture, threeDs, amountLimits, extraSchema}; CreateParams.extra. routing.js: currenciesOf(g, adapters, payment). API POST /payments: currency, extra (OpenAPI sinh lại).
- acceptance: test/hub/contract-currency.test.js (12 test) qua; toàn bộ npm test qua (584 qua, 0 lỗi trước khi thêm test extra); bỏ bộ lọc loại tiền trong routing thì hai test routing đỏ (đã thử); test khả năng của MoMo, SePay (ba module) cập nhật theo currencies và regions.
- tasks:
  - [x] CURRENCY_EXPONENT và kiểm currency khi tạo payment
  - [x] Routing lọc theo loại tiền
  - [x] FailCode mới và isRetriable
  - [x] Khả năng có kiểu và kiểm khi nạp adapter
  - [x] extra có schema theo từng cổng
  - [x] Bốn adapter khai currencies và regions
  - [ ] authorize/capture, NextAction, sự kiện dispute (đợt sau)
  - [ ] Lọc routing theo nước (cần payment mang nước)
  - [ ] Hàm đổi tiền sang đơn vị của cổng dùng chung (_shared) khi có adapter quốc tế đầu tiên

## PHUB-S-034: Lệnh deploy build ảnh từ một commit chỉ định, nhãn ảnh là mã commit (S-017)
- from: PHUB-D-034
- derived_from: 3e0b0736
- status: ready
- requirement: scripts/deploy.ps1 build ảnh Hub chỉ từ một commit chỉ định. Chọn commit: -Commit, nếu không thì commit ghim cho payment-hub ở BSN_/infra/services.json, nếu không có cả hai thì dừng với lỗi rõ ràng. Trích commit bằng git archive với core.autocrlf=false ra thư mục tạm, kiểm băm src/hub.js và package.json trích ra trùng blob của commit, build từ thư mục tạm, kiểm băm /app/src/hub.js trong ảnh trùng tệp trích, rồi xóa thư mục tạm. Nhãn ảnh là 12 ký tự đầu của mã commit. Tệp sửa dở hay chưa theo dõi trong thư mục làm việc không bao giờ vào ảnh. Chế độ mặc định vẫn là chế độ khô: chỉ in commit, nhãn và các bước.
- contract: Tham số: -Commit (mã commit), -Tag (triển khai lại nhãn đã có, không build), -Execute, -Push, -Remote, -Repo. Nhãn ảnh = commit.Substring(0,12), cùng quy ước BSN_/infra/lib.js (bsn-<dịch-vụ>:<12 ký tự>). Đọc BSN_/infra/services.json: services.payment-hub.commit.
- acceptance: Chạy thật `scripts/deploy.ps1 -Execute` (không -Push) khi HEAD đã khác commit ghim: ảnh bsn-payment-hub:ed1f372386d3 được tạo; băm /app/src/hub.js trong ảnh bằng băm `git show ed1f372:src/hub.js` và khác băm tệp đang có trong thư mục làm việc (đã kiểm độc lập bằng sha256sum); thư mục tạm được dọn; chạy khô in đúng commit và nhãn.
- tasks:
  - [x] Chọn commit từ -Commit hoặc services.json, dừng nếu thiếu
  - [x] Trích commit bằng git archive, tar chạy trong thư mục chứa tệp
  - [x] Kiểm băm tệp trích và tệp trong ảnh
  - [x] Nhãn ảnh là mã commit
  - [ ] Chạy -Push và -Remote trên VM thật (chưa làm, chưa có VM)
  - [ ] Test tự động cho deploy.ps1 (hiện chỉ kiểm tay bằng build thật)

## PHUB-S-035: Bước tiếp theo cho khách là dữ liệu chuẩn (NextAction)
- from: PHUB-D-035
- derived_from: 46b47747
- status: ready
- requirement: Adapter có thể trả {status:'next_action', nextAction} với nextAction.type thuộc redirect, post_redirect, challenge, poll, qr, deeplink, transfer. checkNextAction kiểm từng loại: redirect, challenge, deeplink cần url; post_redirect cần url và fields {khóa: chuỗi}; poll có afterSeconds (nếu có) là số nguyên >= 1; qr cần data hoặc imageUrl; transfer cần instructions có bank, accountNumber, amount nguyên; loại lạ là lỗi. Kết quả sai hình dạng thì attempt UNKNOWN và ghi sự kiện bad_create_result. Kết quả đúng thì attempt AWAITING, lưu nextAction; kiểu redirect, post_redirect, transfer điền thêm trường cũ. attemptView có nextAction: khai thẳng thì dùng, không thì suy từ instructions (transfer), url với method POST (post_redirect) hoặc GET (redirect), không có thì null.
- contract: contract.js: NEXT_ACTION_TYPES, checkNextAction(na), CreateResult thêm {status:'next_action', nextAction, expiresAt?, state?}; checkCreateResult kiểm nextAction. views.js: attemptView.nextAction. API: attempt.nextAction (OpenAPI sinh lại), thêm cạnh url, method, fields, instructions.
- acceptance: test/hub/next-action.test.js (6 test) qua; toàn bộ npm test qua (600 qua, 0 lỗi); đã thử phá: bỏ suy transfer ở view thì test view đỏ, bỏ kiểm nextAction ở checkCreateResult thì hai test đỏ.
- tasks:
  - [x] NEXT_ACTION_TYPES và checkNextAction
  - [x] Hub xử lý status next_action, điền trường cũ cho kiểu tương đương
  - [x] attemptView.nextAction suy từ trường cũ
  - [x] OpenAPI sinh lại
  - [ ] Hub tự hẹn hỏi lại theo poll.afterSeconds (chưa; hiện chỉ là thông tin cho cửa hàng)
  - [ ] Adapter thật đầu tiên dùng next_action (3DS, QR)

## PHUB-S-036: Tranh chấp (chargeback) là sự kiện chuẩn; Hub chỉ ghi nhận và báo người vận hành
- from: PHUB-D-036
- derived_from: e8a53c5f
- status: ready
- requirement: Sự kiện chuẩn dispute_opened, dispute_won, dispute_lost cần gatewayTxnId (assertEvent từ chối khi thiếu). Hub nhận chúng như mọi sự kiện: chống trùng theo (cổng, attempt, mã giao dịch, loại, kênh, số tiền); kênh return chỉ để hiển thị. Áp lên attempt: KHÔNG đổi trạng thái đơn hay attempt; đặt needsOperator; ghi anomaly cùng tên loại với detail.stage là opened, won hoặc lost. Anomaly tranh chấp chỉ xử lý bằng action ignore kèm ghi chú; refund hoặc apply bị từ chối invalid_state. Tranh chấp cho attempt lạ ghi unknown_attempt.
- contract: contract.js: DISPUTE_TYPES, EventType mở rộng. hub.js: _applyDispute, resolveAnomaly chặn khác ignore cho funds_reversed và ba anomaly tranh chấp. Anomaly type: dispute_opened, dispute_won, dispute_lost.
- acceptance: test/hub/dispute.test.js (7 test) qua; toàn bộ npm test qua (600 qua, 0 lỗi); đã thử phá: bỏ nhánh tranh chấp thì 5 test đỏ, bỏ chống trùng theo số tiền thì 1 đỏ, bỏ chặn khác ignore thì 1 đỏ.
- tasks:
  - [x] Ba loại sự kiện chuẩn và gatewayTxnId bắt buộc
  - [x] _applyDispute ghi anomaly, không đổi trạng thái
  - [x] Anomaly tranh chấp chỉ ignore
  - [ ] Gửi sự kiện tranh chấp ra cửa hàng (chưa, tránh đổi hợp đồng webhook ra)
  - [ ] Hạn nộp bằng chứng và theo dõi kết quả cuối (chưa)
  - [ ] Adapter thật báo tranh chấp (chưa kiểm cổng nào báo qua IPN hay sao kê)

## PHUB-S-037: Giữ tiền rồi thu sau: trạng thái AUTHORIZED, capture và void, thao tác mất phản hồi là chưa rõ
- from: PHUB-D-037
- derived_from: 79b7c99b
- status: ready
- requirement: Sự kiện chuẩn authorized (cần gatewayTxnId; amount phải bằng amount attempt, loại tiền khớp) đưa attempt LIVE sang AUTHORIZED, đơn vẫn OPEN; sai số tiền là amount_mismatch và attempt không đổi; pending đến sau không hạ AUTHORIZED. AUTHORIZED nằm trong LIVE của Hub và của kho (store.LIVE_STATES, PostgreSQL): không tạo attempt khác (createAttempt kể cả cancelLive không hủy khoản giữ), đơn không đóng khi qua hạn, đối soát nền hỏi lại, authorized đến trên attempt đã đóng hoặc khi đơn không còn OPEN ghi late_authorization. capturePayment({paymentId}) thu đủ số đã giữ, chỉ khi đơn OPEN và có đúng một attempt AUTHORIZED; voidPayment({paymentId, attemptId?}) nhả khoản giữ. Cổng phải khai capture hoặc void trong capabilities.operations và có hàm tương ứng (kiểm khi nạp adapter), nếu không not_supported. Mỗi lời gọi mang idempotencyKey '<attemptId>:capture|void'; một thao tác tại một thời điểm trên một attempt (attempt.op), lệnh thứ hai là op_in_progress. Kết quả: captured thì đi qua đường succeeded (đơn PAID); voided thì attempt CANCELLED; rejected thì lỗi capture_rejected hoặc void_rejected và khoản giữ còn; chưa gửi (notSent) thì gateway_unavailable; mất phản hồi hoặc sai hình dạng thì attempt.op UNKNOWN (không phải thất bại). Đối soát: query thấy authorized thì xóa op, thấy kết quả cuối thì attempt đóng và op bị xóa. Giữ quá reconcile.maxAgeSeconds ghi authorization_stale. Anomaly late_authorization chỉ xử lý bằng ignore. Hub không tự thu hay nhả theo thời gian.
- contract:
- acceptance: test/hub/authorize-capture.test.js (18 test, gồm một test trên PostgreSQL thật có khởi động lại hai lần) qua; toàn bộ npm test qua (618 qua, 2 bỏ qua, 0 lỗi); đã thử phá chín chỗ (bỏ AUTHORIZED khỏi LIVE của hub và của kho, coi capture unknown là thất bại, bỏ chặn thao tác đang chạy, để pending hạ AUTHORIZED, cho cancelLive hủy khoản giữ, bỏ đường succeeded khi thu, không xóa op khi cổng báo còn giữ, cho late_authorization refund) đều làm test đỏ.
- tasks:
  - [x] Sự kiện authorized và trạng thái AUTHORIZED trong LIVE của hub, kho và PostgreSQL
  - [x] capturePayment và voidPayment, một thao tác tại một thời điểm, idempotencyKey ổn định
  - [x] Mất phản hồi là chưa rõ, đối soát xử lý
  - [x] API, OpenAPI, mã lỗi, guard bọc capture và void
  - [x] authorization_stale và late_authorization
  - [x] Sơ đồ trang-thai-attempt thêm AUTHORIZED và giải thích
  - [ ] Thu một phần (chưa hỗ trợ, cần quy tắc nghiệp vụ)
  - [ ] Sự kiện payment.authorized ra cửa hàng (chưa; hiện cửa hàng đọc payment)
  - [ ] Cấu hình tự hủy khoản giữ theo thời gian (chưa; Hub không tự nhả)
  - [ ] Adapter thật dùng authorize, capture, void (chưa có; chỉ kiểm bằng adapter giả)

## PHUB-S-038: Hoàn khoản trong cảnh báo phải được cổng xác nhận ở mọi đường; authorized đến sai thứ tự không phải khoản giữ mồ côi
- from: PHUB-D-038
- derived_from: d85b660e
- status: ready
- requirement: (1) hub.refund: khi attempt không SUCCEEDED và khoản hoàn dựa vào cảnh báo late_success hoặc duplicate_charge, và không có force: nếu cảnh báo chưa có kết luận arbiter success thì hỏi lại cổng (_arbitrate); kết luận khác success (failure, pending, unknown) thì ném not_confirmed, không tạo bản ghi hoàn, không gọi cổng. Áp cho createRefund, hub.refund trực tiếp và resolveAnomaly refund (resolveAnomaly truyền force xuống lệnh hoàn). createRefund nhận force: chỉ role admin, role khác gửi force thì forbidden. Hoàn attempt SUCCEEDED như cũ, không hỏi lại. (2) _applyAuthorized trên attempt đã đóng: trả duplicate, không anomaly, khi ev.gatewayTxnId bằng attempt.gatewayTxnId của attempt SUCCEEDED, hoặc bằng attempt.closedTxn của attempt CANCELLED hoặc EXPIRED; _finalize ghi closedTxn từ gatewayTxnId của sự kiện đóng. Trường hợp khác (FAILED, khác giao dịch) vẫn late_authorization.
- contract: hub.refund({attemptId, amount?, reason?, force?}); API createRefund thêm force (bool, admin), lỗi not_confirmed (409) và forbidden (403); attempt.closedTxn (nội bộ, không ra API).
- acceptance: test/hub/refund-arbitration.test.js (10 test) qua; toàn bộ npm test qua (628 qua, 2 bỏ qua, 0 lỗi, PostgreSQL thật); test P4 cũ sửa để cổng xác nhận trước khi hoàn tiền về muộn; thử phá bảy chỗ (bỏ kiểm xác nhận, force vô tác dụng, resolveAnomaly không truyền force, cửa hàng ép được, bỏ quy tắc đảo thứ tự, không ghi closedTxn, FAILED cũng bị bỏ qua) đều làm test đỏ; một lần phá (resolveAnomaly không truyền force) ban đầu không bị bắt nên đã thêm test.
- tasks:
  - [x] Hoàn khoản trong cảnh báo phải được cổng xác nhận (mọi đường), force cho quản trị
  - [x] authorized cùng giao dịch đến sau succeeded, cancelled hoặc expired không phải anomaly
  - [x] Cập nhật test cũ P4 và OpenAPI
  - [ ] Cập nhật sơ đồ luong-7 và phần giải thích (câu của harness)
  - [ ] Hành vi thật khi cổng xác nhận khoản tiền về muộn (chưa kiểm với cổng thật)

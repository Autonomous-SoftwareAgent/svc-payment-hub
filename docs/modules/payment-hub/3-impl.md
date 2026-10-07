---
module: payment-hub
---
# payment-hub - Implementation (tầng 3)

Đã code gì, ở đâu, lệch spec chỗ nào. Ghi qua tool `impl_link`.

## PHUB-S-001: Payment Hub: điều phối nhiều cổng qua adapter cô lập và mô hình chuẩn
- spec_hash: 11265046
- status: done
- code: src/contract.js, src/hub.js, src/index.js, src/store.js, test/e2e/hub-transfer.test.js, test/hub/hub.test.js, test/hub/transfer.test.js, test/support/world.js
- tests: test/e2e/hub-transfer.test.js, test/hub/hub.test.js, test/hub/transfer.test.js, test/support/world.js
- deviation:
- notes: Store trong bộ nhớ. Mô hình chuẩn đã được mở rộng sau khi kiểm với kiểu chuyển khoản.

## PHUB-S-002: Quy tắc nhất quán tiền: callback không đáng tin, trạng thái cuối bất biến
- spec_hash: 17c1220e
- status: done
- code: src/hub.js, src/store.js, test/e2e/hub-sims.test.js, test/e2e/hub-transfer.test.js, test/hub/hub.test.js, test/hub/transfer.test.js
- tests: test/e2e/hub-sims.test.js, test/e2e/hub-transfer.test.js, test/hub/hub.test.js, test/hub/transfer.test.js
- deviation:
- notes: Query phân xử nhưng không bao giờ đổi trạng thái cuối; hoàn tiền anomaly cần verdict success hoặc force.

## PHUB-S-003: Bốn giả định lõi cần xử lý an toàn khi chưa biết hành vi thật của cổng
- spec_hash: a821c8a6
- status: done
- code: src/contract.js, src/hub.js
- tests:
- deviation:
- notes: hardExpiry chỉ dùng để hỏi lại bắt buộc và báo người vận hành; Hub vẫn không tự coi attempt hết hạn, và không failover chỉ vì qua hạn.

## PHUB-S-004: Ngoài phạm vi của Hub (và lý do)
- spec_hash: 6e01efc5
- status: done
- code: test/hub/adapters-arch.test.js
- tests: test/hub/adapters-arch.test.js
- deviation:
- notes: Là quyết định "không làm", nên không có mã riêng; được giữ bởi ranh giới kiến trúc (adapters-arch). Phần "không lưu dữ liệu thẻ" mới kiểm bằng quét mã một lần, chưa có test tự động. Hub chưa nối cổng thật nào nên chưa kiểm được trên dữ liệu thật rằng không dữ liệu thẻ nào lọt vào payload hay log.

## PHUB-S-005: Interface adapter, mô hình sự kiện chuẩn và hai tầng config
- spec_hash: 7906aca3
- status: done
- code: src/contract.js, src/hub.js, test/hub/transfer.test.js, test/hub/hub.test.js, test/support/fake-adapter.js
- tests: test/hub/transfer.test.js, test/hub/hub.test.js, test/support/fake-adapter.js
- deviation:
- notes: Ghi lại các điều chỉnh so với design: ack là hàm theo outcome; product "default"; amount tùy chọn với pending; Hub truyền createdAt/originalAmount; redirect có thể mang method và fields (cổng SePay gateway bắt khách gửi form POST ký HMAC).

## PHUB-S-006: Máy trạng thái attempt, payment và refund; routing, failover và đối soát
- spec_hash: fbb80841
- status: done
- code: src/hub.js, src/store.js, test/e2e/hub-sims.test.js, test/e2e/hub-transfer.test.js, test/hub/hub.test.js, test/hub/transfer.test.js
- tests: test/e2e/hub-sims.test.js, test/e2e/hub-transfer.test.js, test/hub/hub.test.js, test/hub/transfer.test.js
- deviation:
- notes: reconcile() chưa có lịch chạy nền; store trong bộ nhớ.

## PHUB-S-007: Lưu trữ bền vững và đối soát chạy nền
- spec_hash: 448babe8
- status: done
- code: src/hub.js, src/store-postgres.js, src/store.js, test/hub/persistence.test.js, test/support/pg.js
- tests: test/hub/persistence.test.js, test/support/pg.js
- deviation:
- notes: Một tiến trình ghi mỗi schema (advisory lock); chỉ ghi phần đã đổi, nhóm commit (đo ở PHUB-S-009). Crash giữa thao tác quay về trạng thái đã lưu trước đó. Test DB cần HUB_TEST_DATABASE_URL.

## PHUB-S-008: HTTP API của Hub: cửa hàng gọi vào, cổng gọi vào, vận hành
- spec_hash: 03b0ff65
- status: done
- code: src/hub.js, src/main.js, src/server.js, test/e2e/hub-http.test.js, test/hub/http.test.js
- tests: test/e2e/hub-http.test.js, test/hub/http.test.js
- deviation:
- notes: Giới hạn tải, nhiều cửa hàng, quan sát nằm ở PHUB-S-009, S-013, S-015. Chưa có TLS ở chính Hub (Caddy lo ở infra/prod). attempt trả thêm method và fields cho cổng cần form POST.

## PHUB-S-009: Chịu tải cao: bộ nhớ có chỉ mục, ghi theo thay đổi, nhóm commit, giới hạn tải ở API
- spec_hash: 3423a53d
- status: done
- code: src/store.js, src/store-postgres.js, src/hub.js, src/server.js, src/main.js, tools/bench/load.js, test/hub/scale.test.js, test/hub/limits.test.js
- tests: test/hub/scale.test.js, test/hub/limits.test.js, test/hub/http.test.js, test/hub/persistence.test.js
- deviation:
- notes:
  ĐO (tools/bench/load.js, adapter giả không trễ + PostgreSQL 17 trong Docker Desktop trên Windows, Node 24, mỗi payment = một createPayment và một IPN thành công):
  - Trước khi sửa: 3.000 payment, 20 luồng: 34 payment/giây, giảm dần từ 123 xuống 43 thao tác/giây khi trạng thái tăng (mỗi thao tác quét toàn bộ thực thể).
  - Sau chỉ mục và ghi theo thay đổi (chưa gộp commit): phẳng nhưng chỉ 87 payment/giây (mỗi thao tác một transaction vì các luồng chờ nhau).
  - Sau nhóm commit: 20.000 payment, 50 luồng: 1.930 payment/giây (khoảng 3.900 thao tác/giây), p99 tạo 21ms, phẳng suốt quá trình; 200 luồng: 2.250 payment/giây, p99 73ms; heap sau GC 57MB cho 20.000 payment đã xong.
  Đây là trần của lõi Hub + một PostgreSQL cục bộ, KHÔNG gồm độ trễ cổng thật, mạng thật, TLS, máy chủ thật; không dùng làm cam kết năng lực.
  GIỚI HẠN CÒN LẠI (chưa làm): (1) mọi payment/attempt/anomaly vẫn nằm trong bộ nhớ và được nạp hết khi khởi động, ước tính khoảng 3KB mỗi payment đã xong từ số đo trên nên chục triệu giao dịch không vừa; cần đẩy giao dịch đã đóng ra khỏi bộ nhớ và đọc theo yêu cầu (đổi các hàm tra cứu sang bất đồng bộ). (2) tập khóa idempotency (seen) lớn dần, chưa có hạn dùng. (3) một tiến trình Hub ghi cho mỗi schema, thông lượng bị chặn bởi một tiến trình Node và một kết nối PostgreSQL. Cái nào cũng cần số đo trên hạ tầng thật trước khi quyết định làm.

## PHUB-S-010: Bảo vệ khi gọi cổng: timeout, giới hạn đồng thời, circuit breaker và nhật ký mỗi lần gọi
- spec_hash: f1c97c69
- status: done
- code: src/guard.js, src/hub.js, src/store.js, src/store-postgres.js, src/server.js, test/hub/guard.test.js, test/hub/limits.test.js
- tests: test/hub/guard.test.js, test/hub/limits.test.js
- deviation:
- notes: Đã kiểm chứng bằng đột biến: bỏ nhánh notSent trong _startAttempt, đổi trạng thái refund khi notSent, đều làm test đỏ. Giá trị mặc định (timeout 15 giây, 100 đồng thời, hàng chờ 400, 5 lỗi liên tiếp, nghỉ 30 giây) là ước lượng chưa kiểm với cổng thật; cần chỉnh theo từng cổng khi có sandbox. Breaker nằm trong bộ nhớ của một tiến trình (khởi động lại thì đóng). Nhật ký gọi chỉ có siêu dữ liệu, không có thân request/response.

## PHUB-S-011: Webhook đi tới cửa hàng: hộp thư đi bền vững, ký số, gửi lại theo bậc
- spec_hash: 488f757d
- status: done
- code: src/events.js, src/connectors/out/webhook.js, src/hub.js, src/store.js, src/store-postgres.js, src/server.js, src/main.js, test/hub/webhooks.test.js, test/hub/limits.test.js
- tests: test/hub/webhooks.test.js, test/hub/limits.test.js, test/hub/http.test.js
- deviation:
- notes: Mới thử với fetch giả trong test, chưa với một cửa hàng thật. Một url và một secret chung cho mọi cửa hàng. Cùng eventId chỉ được chống ghi trùng khi webhook còn trong bộ nhớ (đã giao thì rời bộ nhớ); các điểm phát sự kiện đều nằm sau chuyển trạng thái chỉ xảy ra một lần nên không phát lại. Đột biến đổi công thức ký làm test đỏ.

## PHUB-S-012: Bộ nhớ nóng: đẩy giao dịch đã đóng ra khỏi bộ nhớ, nạp lại theo yêu cầu, khóa idempotency có hạn dùng
- spec_hash: 4fa3b005
- status: done
- code: src/store.js, src/store-postgres.js, src/hub.js, src/server.js, test/hub/hot.test.js, test/hub/persistence.test.js
- tests: test/hub/hot.test.js, test/hub/persistence.test.js
- deviation:
- notes:
  ĐO (tools/bench/load.js, 60.000 payment, 100 luồng, adapter giả + PostgreSQL 17 trong Docker Desktop trên Windows): không đẩy ra: 1.363 payment/giây, heap sau GC 173MB, 60.000 payment trong bộ nhớ. Đẩy ra (BENCH_EVICT=1): 1.455 payment/giây, heap 25MB, khoảng 1.700 payment trong bộ nhớ. Bộ nhớ không còn tăng theo số giao dịch.
  Thông lượng sau khi thêm chỉ mục DB (đẩy ra + chỉ mục): 20.000 payment ở 200 luồng đo 1.540 payment/giây; trước đó (không chỉ mục, PHUB-S-009) đo 1.930-2.250. Khác biệt do chỉ mục mới trên docs và nhiễu của máy (Docker Desktop), chưa tách riêng hai yếu tố.
  Chưa kiểm: bảng docs hàng triệu dòng (thời gian truy vấn nạp khi khởi động, kích thước chỉ mục, VACUUM); giao dịch bị kẹt sống làm bó không đẩy ra được thì vẫn ở trong bộ nhớ (đúng thiết kế, có anomaly stale_attempt sau maxAge).
  Quy ước: Hub tự gọi hydrate trước khi dùng; thêm thao tác công khai mới đụng tới giao dịch cũ thì phải nạp trước, nếu quên thì thao tác thấy "không tồn tại".

## PHUB-S-013: Quan sát được: metrics Prometheus, log có cấu trúc kèm mã yêu cầu, nhật ký truy cập
- spec_hash: 84cd5b8e
- status: done
- code: src/metrics.js, src/hub.js, src/server.js, src/main.js, test/hub/observe.test.js
- tests: test/hub/observe.test.js
- deviation:
- notes: Chưa nối với Prometheus/Grafana thật (chỉ kiểm định dạng văn bản bằng test). Nhật ký truy cập dùng stderr của tiến trình; chưa có nơi tập trung. Số đo nằm trong bộ nhớ, mất khi khởi động lại (đúng với counter Prometheus). Đột biến tắt nhật ký làm test đỏ.

## PHUB-S-014: Breaker bền vững qua khởi động lại
- spec_hash: 11473540
- status: done
- code: src/guard.js, src/hub.js, src/store.js, src/store-postgres.js, test/hub/breaker-persist.test.js
- tests: test/hub/breaker-persist.test.js
- deviation:
- notes: Thời điểm mở breaker dùng đồng hồ Hub (giờ thật khi chạy thật) nên so sánh sau khởi động lại có nghĩa. Đồng hồ máy lệch nhiều giữa hai lần chạy có thể làm breaker mở lâu hơn hoặc ngắn hơn dự kiến, chấp nhận được (tối đa một chu kỳ nghỉ).

## PHUB-S-015: Nhiều cửa hàng: định danh theo token, cô lập dữ liệu, webhook riêng từng cửa hàng
- spec_hash: 5984aa4d
- status: done
- code: src/events.js, src/connectors/out/webhook.js, src/hub.js, src/store.js, src/store-postgres.js, src/server.js, src/main.js, test/hub/shops.test.js
- tests: test/hub/shops.test.js
- deviation:
- notes: Cửa hàng chỉ khai báo qua tệp cấu hình (thêm cửa hàng cần khởi động lại). Token lưu dạng chuỗi trong cấu hình/biến môi trường (không băm). Xoay vòng secret webhook cần người nhận chấp nhận cả hai secret trong lúc đổi. Quyền ở mức cửa hàng/quản trị, chưa có vai trò chi tiết hơn. Chưa thử với cửa hàng thật.

## PHUB-S-016: Kiểm thử chịu lỗi: tải qua HTTP, cổng chậm/lỗi hàng loạt, giết Hub giữa tải
- spec_hash: fd714371
- status: done
- code: tools/bench/http-load.js, test/e2e/hub-faulty-gateway.test.js, test/e2e/hub-crash.test.js
- tests: test/e2e/hub-faulty-gateway.test.js, test/e2e/hub-crash.test.js
- deviation:
- notes:
  ĐO qua HTTP (máy khách và server cùng một tiến trình Node nên là cận dưới, tranh CPU): 20.000 payment, 100 kết nối: 673 payment/giây (1.346 request/giây), độ trễ phía khách p50 77ms / p99 153ms cho tạo, p50 61ms / p99 125ms cho IPN, heap 22MB sau GC.
  400 kết nối mở cùng lúc: 624 lần ECONNREFUSED ở đợt đầu (đã thử tăng backlog lên 2048, số lỗi không đổi, nghi giới hạn hàng đợi kết nối của Windows; chưa kiểm trên Linux), độ trễ p99 tạo khoảng 1,1 giây. Chưa điều tra sâu.
  Simulator MoMo không có điều khiển độ trễ/ngắt kết nối; lỗi được chèn bằng fetch bọc ở adapter. Hành vi thật của MoMo khi chậm hay lỗi chưa kiểm chứng. hub-crash giả định simulator gửi lại IPN sau khi tiến đồng hồ ảo (A4 chưa xác minh với cổng thật) và Hub đối soát mỗi giây.

## PHUB-S-017: Lớp kết nối dịch vụ (in/out) tách khỏi lõi và khỏi phía cổng thanh toán, thêm mới không sửa cũ
- spec_hash: cccfd663
- status: done
- code: src/app/app.js, src/app/commands.js, src/app/errors.js, src/app/openapi.js, src/app/operations.js, src/app/schema.js, src/app/schemas.js, src/app/views.js, src/connectors/registry.js, src/connectors/_kafka.js, src/connectors/in/http.js, src/connectors/in/kafka.js, src/connectors/out/kafka.js, src/connectors/out/webhook.js, src/events.js, src/hub.js, src/main.js, src/server.js, src/store.js, src/store-postgres.js, test/hub/connectors-arch.test.js, test/hub/events-routes.test.js, test/hub/app-contract.test.js, test/hub/kafka-connectors.test.js, test/e2e/kafka-live.test.js, src/app/ports.js
- tests: test/hub/connectors-arch.test.js, test/hub/events-routes.test.js, test/hub/app-contract.test.js, test/hub/kafka-connectors.test.js, test/e2e/kafka-live.test.js
- deviation:
- notes: Chỉ thử với Redpanda một nút (docker-compose.yml) và broker giả; chưa thử Kafka production, SASL/TLS, nhiều broker, rebalance khi nhiều bản Hub (Hub vẫn chạy một tiến trình mỗi schema). kafkajs 2.2.4 ít được bảo trì và in một cảnh báo TimeoutNegativeWarning trên Node >= 22 (vô hại, Dockerfile tắt đúng cảnh báo đó). Bản giao ordered đi một bản mỗi key mỗi lượt gửi (vòng nền 250ms/lịch hub), hợp với sự kiện theo payment (ít sự kiện mỗi payment), không hợp với một key phát hàng nghìn sự kiện. Topic phải tạo sẵn. Khóa lệnh trong bộ nhớ giữ tối đa 50.000, ngoài ra tra DB; khóa trong DB bị xóa sau seenTtlDays (90 ngày) nên commandId chỉ chống trùng trong khoảng đó. Công cụ sinh tài liệu: tools/openapi.js (node tools/openapi.js ghi docs/_generated/openapi.json). Port có kiểu thật (JSDoc) và kiểm hình dạng lúc chạy, nhưng chưa chạy tsc --checkJs nên kiểu chưa được trình biên dịch ép; lời gọi sink.deliver vẫn là gọi động qua registry (công cụ phân tích tĩnh có thể không nối được tới cài đặt cụ thể).

## PHUB-S-018: Mở rộng hợp đồng adapter và lõi theo đề xuất P2-P7 của SePay (state, receipts, reversed, nhiều mục cùng cổng, thử lại sau)
- spec_hash: 2fd0915c
- status: done
- code: src/contract.js, src/hub.js, test/hub/contract-ext.test.js, test/support/fake-adapter.js, test/e2e/hub-sepay-routing.test.js
- tests: test/hub/contract-ext.test.js, test/e2e/hub-sepay-routing.test.js
- deviation:
- notes: Chỉ chứng minh với adapter giả và SePay simulator. Adapter VNPay, MoMo, OnePAY chưa dùng state/receipts/reversed (chưa có nhu cầu đã biết). reversed hiện chỉ có SePay C phát (void); sao kê chuyển khoản chưa có nguồn. Bộ đệm VA của B được nạp lại lúc khởi động từ các attempt còn sống (adopt, PHUB-D-025); attempt cũ không có state vẫn đi đường quét và có thể gặp retryLater nếu API quá tải (SePay sẽ gửi lại). Thông báo REFUND của SePay C vẫn bỏ qua để khỏi trừ hai lần với hoàn tiền Hub đã biết.

## PHUB-S-019: Kịch bản đồng thời và ngẫu nhiên; khoản thu thứ hai cùng kênh; trần số tiền
- spec_hash: 9cd608e4
- status: done
- code: src/hub.js, test/hub/scenarios-concurrency.test.js, test/hub/scenarios-random.test.js, test/e2e/hub-edge-inputs.test.js
- tests: test/hub/scenarios-concurrency.test.js, test/hub/scenarios-random.test.js, test/e2e/hub-edge-inputs.test.js
- deviation:
- notes: Chỉ chứng minh với adapter giả và simulator: không biết cổng thật có gửi hai khoản cùng attempt, hay mã giao dịch có ổn định giữa IPN và truy vấn. Bộ ngẫu nhiên chạy trên MemoryStore, chưa trên PostgreSQL. Máy sinh giả định mỗi cổng báo tiền theo một kiểu nhất quán và một khoản thu thật được báo qua IPN; kênh truy vấn đi qua đối soát. Quy tắc "cùng kênh" để tránh báo động giả vì mã giao dịch giữa kênh của SePay C có thể khác nhau.

## PHUB-S-020: Mã lý do thất bại chuẩn: adapter dịch, lõi và chuyển cổng chỉ đọc mã chuẩn
- spec_hash: ffedcea5
- status: done
- code: src/contract.js, src/adapters/fail-codes.js, src/adapters/vnpay/index.js, src/adapters/momo/index.js, src/adapters/onepay/index.js, src/adapters/sepay/index.js, src/adapters/sepay/gateway.js, src/hub.js, src/app/views.js, src/app/schemas.js, src/app/operations.js, src/app/errors.js, test/hub/fail-codes.test.js
- tests: test/hub/fail-codes.test.js
- deviation:
- notes: Chỉ chứng minh với adapter giả và simulator. Simulator phát 1001 (MoMo), 51 và 24 (VNPay), 99 và 1 (OnePAY): test chứng minh luồng dịch mã, không chứng minh mã thật của cổng. VNPay và MoMo lấy từ bảng mã chính thức tải 2026-10-03; OnePAY chỉ hai mã có bằng chứng; SePay rỗng. Đường truy vấn của VNPay chỉ có TransactionStatus nên lý do luôn unknown. Chưa có tự động chuyển cổng theo lý do: failover do người gọi chọn, Hub chỉ chặn theo skipOnFailCodes.

## PHUB-S-021: Hướng phụ thuộc phía cổng thanh toán: một chiều, có test; sơ đồ tầng tách import khỏi luồng chạy
- spec_hash: efd2cdd6
- status: done
- code: test/hub/adapters-arch.test.js
- tests: test/hub/adapters-arch.test.js
- deviation:
- notes: Chỉ kiểm import tương đối kiểu require('./x') bằng quét văn bản; không bắt được import động hay require qua biến. Sơ đồ (BSN_/.claude/plugin/mcp/generators/payment-hub/overview-arch.js) là phần giải thích, không có test riêng ngoài việc đã chụp và xem. Ô "bảo vệ lời gọi cổng" nằm ở lớp adapter trong sơ đồ vì guard bọc từng adapter, nhưng mã guard là phần của lõi (src/guard.js), không phải của module cổng.

## PHUB-S-022: VNPay mã 07 (trừ tiền, nghi ngờ) là pending, không phải thất bại
- spec_hash: 2c4df300
- status: done
- code: src/adapters/vnpay/index.js, tools/sim/vnpay/server.js, test/vnpay/suspected.test.js
- tests: test/vnpay/suspected.test.js
- deviation:
- notes: Chỉ theo bảng mã tài liệu và simulator, chưa kiểm với VNPay thật. Simulator cho mã 07 có TransactionStatus 07 là giả định theo bảng trạng thái giao dịch của tài liệu.

## PHUB-S-023: Registry adapter: thêm cổng là thêm một thư mục, không sửa tệp nào đang có
- spec_hash: 556af186
- status: done
- code: src/adapters/registry.js, src/adapters/vnpay/index.js, src/adapters/momo/index.js, src/adapters/onepay/index.js, src/adapters/sepay/index.js, src/main.js, src/index.js, test/hub/adapter-registry.test.js, test/hub/adapters-arch.test.js
- tests: test/hub/adapter-registry.test.js, test/hub/adapters-arch.test.js
- deviation:
- notes: Adapter thử ở thư mục ngoài là adapter giả, chưa có adapter thật thứ năm. Registry dùng require nên Node nhớ mô-đun theo đường dẫn: sửa tệp adapter khi Hub đang chạy không có tác dụng cho tới khi khởi động lại.

## PHUB-S-024: Lệnh kiểm cấu hình trước khi chạy; adapter kiểm khóa bắt buộc khi dựng
- spec_hash: 62338678
- status: done
- code: src/check-config.js, src/main.js, src/adapters/momo/index.js, src/adapters/sepay/index.js, test/hub/check-config.test.js
- tests: test/hub/check-config.test.js
- deviation:
- notes: Chỉ kiểm cấu trúc và khả năng dựng, không kiểm với cổng thật. Test của SePay (test/sepay/lifecycle.test.js) phải thêm accountNumber và bankName vì kiểm khóa mới. Ngưỡng nhận diện môi trường thử là biểu thức chính quy trên tên miền (sandbox, test, mtf, staging, localhost...) nên có thể báo nhầm hoặc sót.

## PHUB-S-025: Adapter nạp lại bộ đệm từ attempt còn sống khi Hub khởi động (adopt)
- spec_hash: 18a229ca
- status: done
- code: src/contract.js, src/hub.js, src/main.js, src/adapters/sepay/index.js, src/adapters/sepay/va-order.js, test/sepay/adopt.test.js
- tests: test/sepay/adopt.test.js
- deviation:
- notes: Chỉ chứng minh với SePay simulator và adapter giả. Test thứ tự trong main() là kiểm cấu trúc văn bản (adoptAdapters đứng trước api.listen), không chạy main() thật; dễ vỡ nếu đổi tên biến nhưng bắt đúng lỗi thứ tự đã mắc khi viết.

## PHUB-S-026: Kịch bản ngẫu nhiên trên PostgreSQL có khởi động lại, và cho phía giao tin ra; thứ tự giao tin theo bộ đếm đơn điệu
- spec_hash: b78002fa
- status: done
- code: src/events.js, src/store.js, test/support/random-runner.js, test/support/delivery-runner.js, test/hub/scenarios-random.test.js, test/hub/scenarios-random-pg.test.js, test/hub/scenarios-delivery.test.js, test/hub/scenarios-delivery-pg.test.js
- tests: test/hub/scenarios-random.test.js, test/hub/scenarios-random-pg.test.js, test/hub/scenarios-delivery.test.js, test/hub/scenarios-delivery-pg.test.js
- deviation:
- notes: Chỉ chứng minh với adapter giả, sink giả và PostgreSQL cục bộ. Khởi động lại trong bộ chạy là đóng và mở lại kho. Test mất kết nối PostgreSQL (test/e2e/hub-crash.test.js) được sửa để chỉ ngắt khóa của schema nó dùng, không đưa vào danh sách mã vì không mang marker của spec này. Giới hạn chống trùng phát lại sau khởi động lại đã sửa ở PHUB-D-030 (không còn test todo).

## PHUB-S-027: Hỏi lại attempt đã đóng không thành công để bắt tiền về muộn khi IPN mất hẳn
- spec_hash: 4b5b2672
- status: done
- code: src/hub.js, src/store.js, src/store-postgres.js, test/hub/closed-recheck.test.js
- tests: test/hub/closed-recheck.test.js
- deviation:
- notes: Chỉ chứng minh với adapter giả và simulator. Mốc mặc định (1 giờ, 24 giờ) là lựa chọn của tôi, chưa dựa trên dữ liệu thật về việc tiền về muộn. Lúc viết đã mắc lỗi đặt lịch trước khi gán finalizedAt (lịch thành NaN và không bao giờ đến hạn) và được ca thăm dò bắt ngay; thứ tự gán nay có chú thích.

## PHUB-S-028: Kịch bản ngẫu nhiên với simulator thật: simulator là sự thật nền về tiền đã thu
- spec_hash: 8d2b8dfd
- status: done
- code: test/support/sim-runner.js, test/e2e/scenarios-sim.test.js
- tests: test/e2e/scenarios-sim.test.js
- deviation:
- notes: Sự thật nền là của simulator, không phải của cổng thật. Giới hạn được miễn trừ trong bất biến (1) khai báo trong mã (hằng CLOSE_RECHECK_LAST).

## PHUB-S-029: Routing là module riêng và chọn theo phương án thanh toán chuẩn
- spec_hash: faa7bdfe
- status: done
- code: src/routing.js, src/hub.js, src/contract.js, src/app/views.js, src/app/schemas.js, src/app/operations.js, src/adapters/vnpay/index.js, src/adapters/momo/index.js, src/adapters/onepay/index.js, src/adapters/sepay/qr-static.js, src/adapters/sepay/va-order.js, src/adapters/sepay/gateway.js, test/hub/routing-methods.test.js, test/hub/adapters-arch.test.js
- tests: test/hub/routing-methods.test.js, test/hub/adapters-arch.test.js
- deviation:
- notes: Chỉ chứng minh với adapter giả và khai báo theo tài liệu. Sự cố khi viết: một lần chạy kiểm đột biến không khôi phục được (biến sao lưu không được đặt sau khi một bước trước thất bại) và để lại mã bị đột biến; đã phát hiện ngay từ kết quả bất thường, phục hồi bằng tay và thay bằng công cụ chạy đột biến giữ bản gốc trong bộ nhớ và kiểm lại sau khi khôi phục.

## PHUB-S-030: Phát lại sự kiện sau khởi động lại không giao lần hai: kho PostgreSQL bỏ bản trùng, hộp thư đi ghi bền trước khi gửi
- spec_hash: 445306cd
- status: done
- code: src/store.js, src/store-postgres.js, src/events.js, test/hub/scenarios-delivery-pg.test.js
- tests: test/hub/scenarios-delivery-pg.test.js
- deviation:
- notes: Chỉ chứng minh trên PostgreSQL cục bộ với sink giả. Khởi động lại trong test là đóng và mở lại kho (cùng schema). Không có luồng nào trong Hub hiện phát lại cùng sự kiện; sửa này là lưới an toàn nên chưa được thử trong luồng thật.

## PHUB-S-031: Deploy kiểm cấu hình bằng image mới trên VM trước khi thay bản đang chạy
- spec_hash: cc6c5116
- status: done
- code: scripts/deploy.ps1
- tests:
- deviation:
- notes: Không có test tự động trong npm test (kịch bản chạy trên VM qua ssh). Kiểm bằng tay: sh -n và chạy với docker giả (mô phỏng cả hai nhánh). docker compose run trên VM thật, quyền của user node với read_only và tmpfs, và việc --connect nối được PostgreSQL trong mạng compose đều chưa kiểm.

## PHUB-S-032: Kafka thật: gửi tới broker đóng băng phải có hạn thời gian; kiểm bằng broker thật bị đóng băng và Hub khởi động lại
- spec_hash: bc3b11d9
- status: done
- code: src/connectors/_kafka.js, test/e2e/kafka-delivery-live.test.js
- tests: test/e2e/kafka-delivery-live.test.js
- deviation:
- notes: Broker là Redpanda một nút trong docker compose, bị đóng băng bằng docker pause (mô phỏng broker không trả lời, không phải mất mạng hay broker chết). Test chạy khoảng 40 giây và mặc định bị bỏ qua (cần HUB_TEST_KAFKA_CHAOS=1, chạy riêng một mình); nếu test bị kill giữa chừng, broker có thể còn bị đóng băng (docker unpause). Chưa kiểm Kafka production.

## PHUB-S-033: Ngôn ngữ chung cho cổng quốc tế: tiền kèm mã ISO 4217, mã thất bại mới, khả năng có kiểu, extra có schema
- spec_hash: 26e2d3ae
- status: done
- code: src/contract.js, src/routing.js, src/hub.js, src/app/operations.js, test/hub/contract-currency.test.js
- tests: test/hub/contract-currency.test.js
- deviation:
- notes: Đợt 1 của đề xuất docs/agent/oss-core-solutions.md. Chưa làm: authorize/capture, NextAction, sự kiện dispute, lọc theo nước. regions mới chỉ khai báo. Mọi thứ chưa kiểm với cổng quốc tế thật (chưa có adapter nào).

## PHUB-S-034: Lệnh deploy build ảnh từ một commit chỉ định, nhãn ảnh là mã commit (S-017)
- spec_hash: e2cea353
- status: done
- code: scripts/deploy.ps1
- tests:
- deviation:
- notes: Kiểm bằng build thật, không có test tự động. -Push và -Remote chưa chạy trên VM thật. Phần kiểm cấu hình trước deploy (PHUB-S-031) giữ nguyên.

## PHUB-S-035: Bước tiếp theo cho khách là dữ liệu chuẩn (NextAction)
- spec_hash: 5b3e3927
- status: done
- code: src/contract.js, src/hub.js, src/app/views.js, src/app/schemas.js, test/hub/next-action.test.js
- tests: test/hub/next-action.test.js
- deviation:
- notes: Đợt 2a của đề xuất docs/agent/oss-core-solutions.md. Chỉ kiểm bằng adapter giả: chưa có adapter thật nào dùng status next_action. Hub chưa tự hỏi lại theo poll.afterSeconds.

## PHUB-S-036: Tranh chấp (chargeback) là sự kiện chuẩn; Hub chỉ ghi nhận và báo người vận hành
- spec_hash: 1aac816d
- status: done
- code: src/contract.js, src/hub.js, test/hub/dispute.test.js
- tests: test/hub/dispute.test.js
- deviation:
- notes: Đợt 2c. Mức tối thiểu an toàn: ghi nhận và báo người vận hành, chưa gửi ra cửa hàng. Chưa kiểm với cổng thật.

## PHUB-S-037: Giữ tiền rồi thu sau: trạng thái AUTHORIZED, capture và void, thao tác mất phản hồi là chưa rõ
- spec_hash: 816ea3a2
- status: done
- code: src/contract.js, src/hub.js, src/guard.js, src/store.js, src/store-postgres.js, src/app/operations.js, src/app/errors.js, src/app/ports.js, test/hub/authorize-capture.test.js
- tests: test/hub/authorize-capture.test.js
- deviation:
- notes: Đợt 2b của đề xuất docs/agent/oss-core-solutions.md. Chỉ kiểm bằng adapter giả (không có cổng thật nào dùng authorize, capture, void). Thu một phần, sự kiện payment.authorized ra cửa hàng và tự hủy khoản giữ theo thời gian chưa làm. Sơ đồ trang-thai-attempt đã thêm AUTHORIZED.</notes>

## PHUB-S-038: Hoàn khoản trong cảnh báo phải được cổng xác nhận ở mọi đường; authorized đến sai thứ tự không phải khoản giữ mồ côi
- spec_hash: 54fdab2c
- status: done
- code: src/hub.js, src/app/operations.js, src/app/ports.js, test/hub/refund-arbitration.test.js
- tests: test/hub/refund-arbitration.test.js, test/hub/contract-ext.test.js
- deviation:
- notes: Hai sửa lõi trước adapter Stripe (docs/agent/stripe-research.md, mục "Điều mới phát hiện về chính Hub" 1 và 2). Chưa kiểm với cổng thật (hành vi hỏi lại cổng khi xác nhận tiền về muộn). Mục 3 của danh sách đó (maxAgeSeconds mặc định 1 ngày < hạn giữ 7 ngày) vẫn là cấu hình riêng cổng khi làm adapter.

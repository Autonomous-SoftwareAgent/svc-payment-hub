<!-- GENERATED từ docs/service.yaml bằng bsn-docs. Không sửa tay; ghi nguồn bằng service_doc_set / problem_record. -->
# Payment Hub (payment-hub)

Dịch vụ đứng giữa cửa hàng và các cổng thanh toán (VNPay, MoMo, OnePAY, SePay trong nước; Stripe và PayPal quốc tế). Cửa hàng chỉ nói chuyện với Hub; Hub chọn cổng, theo dõi từng lần thanh toán và giữ cho tiền với đơn hàng luôn khớp nhau.

Cập nhật: 2026-10-07. Bản cho người đọc: BSN_/docs/portal/payment-hub/index.html (sinh từ cùng nguồn).

## Nghiệp vụ

Mục tiêu: Cửa hàng và các dịch vụ BSN thu tiền qua nhiều cổng thanh toán mà không phải biết cổng nào đứng sau. Hub giữ cho tiền và đơn hàng luôn khớp nhau, kể cả khi cổng báo trễ, báo trùng hoặc không báo.

Người dùng và nhu cầu:
- Cửa hàng và dịch vụ BSN khác: Tạo thanh toán và nhận kết quả qua HTTP API, Kafka hoặc webhook mà không phụ thuộc cổng cụ thể.
- Khách trả tiền: Được chuyển tới cổng (hoặc nhận hướng dẫn chuyển khoản) và tiền đã trả được ghi nhận đúng vào đơn.
- Người vận hành: Thấy giao dịch bất thường (tiền về muộn, trùng, lệch, tranh chấp, giữ tiền quá lâu) và cấu hình cổng, phương án thanh toán, loại tiền, bảng mã lỗi mà không sửa lõi.

Giá trị mang lại:
- Đổi hoặc thêm cổng thanh toán là thêm một adapter, không sửa lõi và không sửa dịch vụ gọi.
- Tiền với đơn hàng được đối soát nền, không dựa vào việc cổng luôn báo đúng lúc.
- Một hợp đồng chuẩn cho mọi cổng: loại sự kiện, mã lý do thất bại, phương án thanh toán, loại tiền ISO 4217, khả năng của cổng, bước tiếp theo cho khách (chuyển hướng, 3DS, QR, chuyển khoản), giữ tiền rồi thu sau (authorize, capture, void).

Luồng thanh-toan: Một lần thanh toán
1. Cửa hàng gọi Hub tạo thanh toán cho đơn. Gọi lại cùng cửa hàng và orderId khi đơn cũ chưa đóng thì cùng số tiền và loại tiền trả lại đơn cũ, khác thì báo order_conflict; không bao giờ tạo thêm lần thu.
2. Hub lọc cổng theo cổng đang bật, đúng sản phẩm, trong khoảng số tiền, nhận loại tiền của đơn và đúng phương án thanh toán, rồi tạo một lần thử (attempt) ở cổng đứng đầu.
3. Khách trả tiền trên trang cổng hoặc chuyển khoản theo hướng dẫn (buớc tiếp theo cho khách do Hub trả về ở dạng chuẩn).
4. Cổng báo kết quả về Hub (callback/IPN); nếu cổng không báo, Hub tự hỏi lại. Với PayPal, khách duyệt xong tiền chưa chuyển: adapter thu giúp Hub khi khách quay về hoặc khi webhook duyệt đến.
5. Hub chuẩn hóa kết quả về hợp đồng chuẩn, cập nhật trạng thái và phát sự kiện ra cho cửa hàng (webhook hoặc Kafka).

Luồng thong-bao-cua-cong: Thông báo của cổng: sai chữ ký, trùng, sai thứ tự, lệch tiền
1. Cổng gọi GET hoặc POST /ipn/{gateway} (báo từ máy cổng) hoặc /return/{gateway} (trình duyệt khách quay về, chỉ để hiển thị, không đổi trạng thái).
2. Adapter kiểm chữ ký. Sai chữ ký thì Hub ghi invalid_signature và không đổi gì. Chữ ký đúng nhưng lỗi tra cứu tạm thời thì Hub không đổi gì và trả lỗi để cổng gửi lại (retry_later).
3. Thông báo không gắn được attempt nào: tiền vào mà không biết chủ thì ghi cảnh báo unmatched_funds; mã tham chiếu lạ thì ghi unknown_attempt. Cả hai đều chờ người vận hành.
4. Sự kiện trùng (cùng cuộc trả lời) được phát hiện và bỏ qua (duplicate). Nếu cùng một kênh báo thành công lần hai với mã giao dịch khác thì đó là khoản thu thêm: cảnh báo duplicate_charge.
5. Số tiền hoặc loại tiền trong thông báo thành công khác attempt: Hub không ghi nhận đã trả, ghi cảnh báo amount_mismatch (gửi lại vẫn báo lệch, không coi là trùng).
6. Attempt đã đóng (thất bại, hủy, hết hạn) mà cổng báo thành công: trạng thái cuối không đổi, Hub ghi late_success (hoặc duplicate_charge nếu đơn đã PAID bởi attempt khác) để người vận hành xử lý.
7. Thứ tự không được bảo đảm: trạng thái đang xử lý (pending) đến sau thành công không làm attempt lùi lại; authorized cùng giao dịch đến sau khi đã thu hoặc đã nhả thì coi là trùng, không phải cảnh báo; khác giao dịch hoặc sau FAILED thì ghi late_authorization.

Luồng chua-ro: Khi lời gọi tới cổng mất phản hồi (trạng thái chưa rõ)
1. Hub gọi cổng tạo thanh toán (hoặc thu, nhả, hoàn) nhưng cổng không trả lời kịp hoặc trả lỗi 5xx.
2. Attempt để ở UNKNOWN (chưa biết cổng đã thu hay chưa). UNKNOWN vẫn được coi là có thể nhận tiền: không chuyển sang cổng khác, không đánh dấu thất bại.
3. Kết quả đến từ thông báo của cổng hoặc từ đối soát nền hỏi lại cổng. Trước mốc hết hạn cứng của cổng, chỉ hỏi lại; qua mốc đó cộng thời gian chờ thì hỏi lần cuối rồi mới đóng.
4. Riêng thu và nhả khoản giữ: sau khi mất phản hồi, thao tác thứ hai bị chặn (op_in_progress) cho tới khi biết kết quả thao tác trước. Hoàn tiền mất phản hồi ở trạng thái REQUESTED và được đối soát sau, trừ khi biết chắc chưa gửi đi thì FAILED.

Luồng chuyen-cong: Thử lại hoặc chuyển sang cổng khác
1. Trong lúc tạo: cổng từ chối rõ ràng hoặc Hub chưa gửi được lời gọi thì Hub tự thử cổng kế tiếp trong cùng lời gọi.
2. Sau khi đã tạo: phải do cửa hàng yêu cầu tạo attempt mới (POST /payments/{id}/attempts). Đơn phải còn OPEN, chuyển cổng không bị tắt, chưa đủ số lần thử.
3. Nếu còn attempt có thể nhận tiền (CREATED, AWAITING, UNKNOWN, AUTHORIZED) thì Hub chỉ tạo attempt mới khi cửa hàng yêu cầu hủy và cổng hủy được; không thì báo attempt_still_live để tránh thu hai lần. Attempt đang giữ tiền không bao giờ bị Hub tự hủy.

Luồng hoan-tien: Hoàn tiền
1. Chỉ hoàn được attempt đã nhận tiền (SUCCEEDED), trừ phần cổng đã đảo lại. Tổng các lần hoàn (không tính lần FAILED) không vượt số đã thu; vượt thì báo invalid_refund_amount. Có trần số lần hoàn và tuổi giao dịch gốc (refund_limit).
2. Khoản nằm trong cảnh báo late_success hoặc duplicate_charge chỉ dựa vào một thông báo chưa kiểm: Hub phải hỏi cổng và cổng xác nhận tiền đã về thì mới hoàn (không thì báo not_confirmed). Chỉ quản trị mới được ép (force).
3. Cổng không hoàn được bằng API thì hoàn ở trạng thái MANUAL_REQUIRED, người vận hành làm tay rồi xác nhận (POST /refunds/{id}/done).
4. Tiền bị cổng đảo lại từ ngoài Hub (reversed) hay tranh chấp (dispute): Hub không đổi trạng thái đơn vì hàng có thể đã giao, chỉ ghi cảnh báo funds_reversed hay dispute_* và giảm phần còn hoàn được.

Luồng doi-soat: Khi cổng báo trễ, trùng hoặc không báo
1. Đối soát nền hỏi lại cổng cho các attempt còn chờ.
2. Attempt đã đóng vẫn được hỏi lại ở mốc 1 giờ và 24 giờ để bắt tiền về muộn.
3. Trường hợp không tự xử lý được thì báo người vận hành, không tự coi là thất bại.

Luồng giu-tien: Giữ tiền rồi thu sau (cổng có hỗ trợ)
1. Cổng báo đã giữ tiền (authorized): attempt chuyển sang AUTHORIZED, đơn vẫn mở, chưa phải tiền đã thu.
2. Cửa hàng giao hàng rồi gọi capture để thu đủ số đã giữ, hoặc gọi void để nhả.
3. Nếu cổng mất phản hồi khi thu hoặc nhả, Hub không coi là thất bại: ghi là chưa rõ, chặn thao tác kế tiếp và hỏi lại cổng.
4. Giữ quá lâu mà không ai thu hay nhả thì Hub báo người vận hành (authorization_stale); Hub không tự thu hay tự nhả.

Ngoài phạm vi:
- Sổ cái, chống gian lận: chưa có.
- Tranh chấp (dispute): mới chỉ ghi nhận và báo người vận hành (không đổi trạng thái đơn, chưa gửi ra cửa hàng, chưa theo dõi hạn nộp bằng chứng).
- Giữ tiền rồi thu sau: chưa thu một phần (chỉ thu đủ số đã giữ), chưa gửi sự kiện khoản giữ ra cửa hàng (cửa hàng đọc payment), chưa có cấu hình tự hủy khoản giữ theo thời gian.
- Quản lý cửa hàng bằng API: hiện chỉ qua tệp cấu hình.
- Chạy nhiều tiến trình Hub cùng ghi một schema: hiện một tiến trình ghi mỗi schema.
- Routing theo số liệu đo được (tỉ lệ thành công, độ trễ) và tự chuyển cổng: chưa làm, cần dữ liệu thật trước.
- Routing theo nước của cửa hàng: regions mới chỉ là khai báo của adapter.

CHƯA kiểm với hệ thống thật:
- Chưa nối cổng thật nào: mọi test chạy với simulator và adapter giả.
- Bảng mã lỗi của các cổng: chỉ theo tài liệu (VNPay, MoMo) hoặc gần như trống (OnePAY, SePay).
- Khai báo phương án thanh toán (methods), loại tiền (currencies) và nước (regions) của các adapter: theo tài liệu, chưa kiểm với cổng thật.
- Hành vi trả tiền muộn trên URL cũ của attempt đã thất bại; mốc hỏi lại 1 giờ và 24 giờ là lựa chọn ban đầu, chưa dựa trên dữ liệu thật.
- Cổng thật có gửi thông báo trùng hay sai thứ tự thế nào và bao nhiêu lần: Hub xử lý theo giả định xấu nhất, nhưng các ca này chỉ kiểm bằng simulator.
- SePay B/C: mọi hành vi là giả định từ tài liệu và simulator, nhất là mã giao dịch của IPN VOID và thông báo REFUND.
- Tài liệu OnePAY chính thức không truy cập được, chỉ có bản sao năm 2020.
- Kafka mới thử với Redpanda một nút (có cả ca broker bị đóng băng giữa chừng và Hub khởi động lại, PHUB-D-032) và broker giả; hạn thời gian Kafka (request 10 giây, kết nối 3 giây, thử lại 2 lần) là lựa chọn ban đầu, chưa đo trên broker production; chưa thử SASL/TLS hay nhiều broker.
- Nhánh -Push và -Remote của scripts/deploy.ps1 chưa chạy thật (chưa có VM, Docker Hub private, tên miền).
- Stripe (cổng quốc tế đầu tiên), loại tiền ngoài VND, NextAction, tranh chấp, giữ tiền rồi thu sau, extra: mới kiểm bằng simulator và adapter giả, CHƯA kiểm với Stripe thật (chưa có khóa test). Thiết kế dựa trên đọc tài liệu và mã nguồn mở, chưa chạy với Stripe.
- Stripe hosted Checkout: thẻ hỏng có sinh sự kiện thất bại không (simulator giả định là không), payment_status của phiên khi mới giữ tiền, metadata chép sang Charge và Dispute, UGX, quy tắc bội 10 của tiền ba chữ số, mã lỗi thật khi thu hai lần, hạn hoàn tối đa.
- Chưa biết cổng thật báo tranh chấp qua IPN hay chỉ qua sao kê, xử lý thu trễ, void sau khi đã thu hay hết hạn giữ ra sao.
- PayPal (cổng quốc tế thứ hai): mọi hành vi mới ở mức tài liệu (đọc qua công cụ tóm tắt) hoặc suy ra, chưa gọi PayPal lần nào: tên trường và mã lỗi; custom_id có chép sang capture, hoàn và webhook; khách duyệt rồi đóng tab có sinh CHECKOUT.ORDER.APPROVED đáng tin không.
- PayPal: chữ ký webhook với chứng chỉ thật (chưa kiểm chuỗi tin cậy), capture PENDING kéo dài bao lâu, hình dạng tranh chấp, hạn order 3 giờ và khoản giữ 29 ngày, TWD (tài liệu tóm tắt tự mâu thuẫn).
- PayPal không hỗ trợ VND (theo tài liệu): đơn VND không bao giờ đi PayPal. Khách duyệt mà cả return lẫn webhook mất thì không ai thu (không bị trừ tiền, phải thử lại); duyệt muộn hơn hạn đơn Hub vẫn bị thu và thành late_success (P-014).

## Kiến trúc kỹ thuật

Ba lớp, phụ thuộc một chiều: vào/ra, chuẩn hóa, logic nội bộ, gặp nhau qua hợp đồng chuẩn. Có hai trục tách nhau: phía kết nối dịch vụ (cửa hàng, dịch vụ BSN) và phía cổng thanh toán. Lõi không biết gì riêng về cổng nào; chỉ main.js và index.js nối hai trục. Ranh giới được test quét import và quét tên cổng giữ (tên cổng lấy từ chính các thư mục src/adapters, nên cổng mới tự được kiểm). Adapter từng cổng nạp lúc chạy qua registry (require động theo tên thư mục) và được tiêm vào lõi khi dựng, nên lệnh nhập tĩnh không thấy mũi tên lõi tới adapter.

Lớp:
- io (Vào/ra): Nói chuyện với bên ngoài: HTTP, Kafka, webhook, nhận callback của cổng. Lời gọi API cổng và ký chữ ký nằm trong từng adapter (cùng tệp với phần chuẩn hóa, xem P-008). [src/connectors/in, src/connectors/out, src/server.js]
- normalize (Chuẩn hóa): Dịch giữa dạng của bên ngoài và dạng chuẩn: danh mục thao tác, schema, mã lỗi, loại sự kiện, phương án thanh toán, loại tiền. Mỗi cổng một thư mục adapter dịch dạng của cổng sang dạng chuẩn (và gọi cổng qua deps.fetch). [src/app, src/adapters, src/contract.js]
- core (Logic nội bộ): Nghiệp vụ, máy trạng thái, kho lưu; chỉ biết dạng chuẩn. [src/hub.js, src/routing.js, src/events.js, src/store.js, src/store-postgres.js, src/guard.js, src/metrics.js]

Thành phần:
- connectors-in (Connector vào) @io: Nhận yêu cầu từ dịch vụ khác qua HTTP và Kafka. [src/connectors/in]
- connectors-out (Connector ra) @io: Phát sự kiện ra qua webhook và Kafka (hộp thư đi nhiều tuyến). [src/connectors/out]
- app (Cổng vào chuẩn (app)) @normalize: Danh mục thao tác, schema, mã lỗi, view; port có kiểu JSDoc và kiểm hình dạng lúc chạy. [src/app]
- hub (Lõi Hub) @core: Máy trạng thái thanh toán và attempt (kể cả giữ tiền rồi thu), đối soát nền, hỏi lại attempt đã đóng. [src/hub.js]
- routing (Routing) @core: Chọn cổng theo phương án thanh toán chuẩn và loại tiền; chỉ biết hợp đồng. [src/routing.js]
- store (Kho lưu) @core: Lưu giao dịch và hộp thư đi trên PostgreSQL. [src/store.js, src/store-postgres.js]
- contract (Hợp đồng chuẩn) @normalize: Loại sự kiện, FAIL_CODES, METHODS, loại tiền ISO 4217, NextAction, khả năng adapter; lõi và adapter chỉ gặp nhau ở đây. [src/contract.js]
- adapters (Adapter từng cổng) @normalize: Mỗi cổng một thư mục tự đăng ký (registry): VNPay, MoMo, OnePAY, SePay, Stripe, PayPal. Thêm cổng là thêm thư mục. [src/adapters]
- simulators (Simulator cổng): Cổng giả để test (cả Stripe và PayPal); là sự thật nền của test, không phải của cổng thật. [tools/sim]

Phụ thuộc vào:
- PostgreSQL (infra, qua pg): Cơ sở dữ liệu duy nhất: giao dịch, attempt, hộp thư đi.
- VNPay (external, qua HTTP + IPN): Cổng thanh toán chuyển hướng. Chưa nối cổng thật.
- MoMo (external, qua HTTP + IPN): Cổng thanh toán chuyển hướng. Chưa nối cổng thật.
- OnePAY (external, qua HTTP + IPN): Cổng thanh toán chuyển hướng. Chưa nối cổng thật.
- SePay (external, qua HTTP + webhook): Chuyển khoản và sao kê (sản phẩm A/B/C). Chưa nối cổng thật.
- Stripe (external, qua HTTP + webhook có chữ ký): Cổng quốc tế (Checkout hosted, giữ tiền rồi thu, tranh chấp). Chỉ kiểm với simulator, chưa nối Stripe thật.
- PayPal (external, qua HTTP (Orders v2, Payments v2) + webhook chữ ký RSA + return_url): Cổng quốc tế thứ hai: khách duyệt trên PayPal rồi adapter thu hay giữ giúp Hub; hoàn, tranh chấp. Không nhận VND. Chỉ kiểm với simulator, chưa nối PayPal thật (P-013).
- Kafka (infra, qua connector Kafka): Nhận lệnh và phát sự kiện. Production chưa bật, chưa chọn broker.

Cung cấp cho:
- Cửa hàng và dịch vụ BSN (qua HTTP API (OpenAPI 3.1), Kafka): Tạo thanh toán, truy vấn trạng thái, thu hoặc nhả khoản giữ, hoàn tiền.
- Cửa hàng và dịch vụ BSN (qua Webhook, Kafka): Sự kiện kết quả thanh toán theo hợp đồng chuẩn.
- Cổng thanh toán (qua GET và POST /ipn/{gateway}, /return/{gateway}): Nhận thông báo kết quả của cổng; đây là cửa vào của tiền thật. Với PayPal, /return còn là nơi adapter thu tiền giúp Hub sau khi khách duyệt.

Quyết định liên quan:
- D-004: PostgreSQL là cơ sở dữ liệu duy nhất của dự án
- D-006: Kiến trúc microservice nhiều repo: Payment Hub tách thành repo riêng trong BSN_
- D-008: Mỗi dịch vụ BSN kết nối với dịch vụ khác qua lớp connector in/out chuẩn
- D-010: Mọi dịch vụ BSN thiết kế ba lớp: vào/ra, chuẩn hóa, logic nội bộ
- D-013: Harness tập trung ở BSN_/.claude; dịch vụ chỉ giữ mã và tài liệu
- D-014: Trong dịch vụ chỉ có Markdown cho agent; nguồn có cấu trúc docs/service.yaml; HTML cho người đọc chỉ ở cổng cục bộ
- D-015: Một trang ba tab cho người đọc; sơ đồ khai bằng dữ liệu; repo nằm trong BSN_/system_service/
- D-016: Lõi chỉ nói ngôn ngữ chung của Hub; phần riêng của nhà cung cấp nằm trong module cổng

## Vấn đề và tinh chỉnh

Đã xong:
- Lõi Hub, 4 adapter và simulator (VNPay, MoMo, OnePAY, SePay A/B/C), PostgreSQL, đối soát nền, HTTP API, nhiều cửa hàng.
- Lớp kết nối dịch vụ in/out (HTTP, Kafka, webhook, OpenAPI) tách khỏi phía cổng thanh toán.
- Kế hoạch kiểm và củng cố lõi PHUB-D-022..032: registry adapter, --check-config, adopt, kịch bản ngẫu nhiên, hỏi lại attempt đã đóng, routing và phương án chuẩn, chống giao sự kiện trùng sau khởi động lại, kiểm cấu hình khi deploy, hạn thời gian Kafka.
- Hạ tầng production trên giấy và script: Caddy TLS, sao lưu/khôi phục, scripts/deploy.ps1 build từ một commit chỉ định (đọc bản ghim ở BSN_/infra/services/payment-hub.json), nhãn ảnh là mã commit (PHUB-D-034; mặc định chỉ in kế hoạch).
- Ngôn ngữ chung cho cổng quốc tế (PHUB-D-033, D-035, D-036, D-037, D-038): tiền kèm mã ISO 4217 và routing theo loại tiền, mã thất bại mới, khả năng cổng có kiểu, extra, NextAction, tranh chấp, giữ tiền rồi thu sau (AUTHORIZED, capture, void), hoàn khoản trong cảnh báo phải được cổng xác nhận, authorized đến sai thứ tự không gây cảnh báo giả; lõi không còn tên cổng viết cứng (test quét giữ).
- Adapter Stripe (cổng quốc tế đầu tiên, STRP-D-001..003): Checkout hosted, sản phẩm charge và auth, webhook có chữ ký, tiền theo đơn vị Stripe, thu, nhả, hoàn, tranh chấp; simulator tools/sim/stripe và driver world.js. Chỉ kiểm với simulator.
- Tài liệu: 17 sơ đồ khai và 3 sơ đồ tự sinh từ mã (đã viết giải thích và soát với mã ngày 2026-10-06, cả ba đúng), từ vựng nghiệp vụ và quan hệ nạp lúc chạy trong kho ngữ nghĩa.
- Nối vào nền CI/CD dùng chung (S-023, S-029): bsn.ci.json, ci.yml (job test có PostgreSQL, job image gọi workflow chung ở Autonomous-SoftwareAgent/deploy), script test gồm test/stripe. Tổ chức GitHub cũ đã bị xóa 2026-10-07, chưa có repo ở tổ chức mới nên CI chưa chạy lại.
- Bốn nhóm test của P-011 (2026-10-07): callback khi CREATED, chết giữa ghi và phát, Stripe ngẫu nhiên, hoàn một phần theo cổng. Nhóm đầu lộ lỗi lõi P-012, đã sửa cùng ngày. PostgreSQL thật: 705 ca, 703 qua, 0 hỏng, 2 bỏ qua (Kafka thật). Chỉ chạy với simulator, chưa nối cổng thật.
- Adapter PayPal (cổng quốc tế thứ hai, PYPL-D-001..003, 2026-10-07): Orders v2, charge và auth, adapter thu giúp Hub khi khách quay về hoặc webhook duyệt, tự kiểm chữ ký RSA, hoàn, tranh chấp; simulator tools/sim/paypal; không đổi lõi. PostgreSQL thật: 773 ca, 771 qua, 0 hỏng, 2 bỏ qua. Chỉ simulator, chưa kiểm PayPal thật (P-013).

Tiếp theo:
- Tạo repo svc-payment-hub (và deploy, harness) ở tổ chức Autonomous-SoftwareAgent rồi đẩy khi người dùng bảo; origin đã trỏ sẵn. Sau đó xem CI xanh và ghi số ca thật.
- Kiểm adapter PayPal bằng sandbox thật (P-013) và quyết định xử lý hạn order 3 giờ so với đơn Hub 30 phút (P-014).
- Kiểm adapter Stripe bằng khóa test thật (stripe listen, stripe trigger): thẻ hỏng trên hosted Checkout, payment_status khi giữ tiền, metadata sang Charge và Dispute, UGX, tiền ba chữ số.
- Đăng ký sandbox thật của VNPay, MoMo, OnePAY, SePay và kiểm các giả định (cần tài khoản merchant), gồm cả việc cổng nào thật sự gửi IPN trước khi phản hồi tạo đến nơi (P-012).
- Dựng VM, tên miền; chạy thử deploy.ps1 -Push -Remote thật khi nền có lệnh deploy.
- Chọn broker cho production và thử Kafka với SASL/TLS.
- Chốt các con số nghiệp vụ cùng cửa hàng thật: thời hạn thanh toán, chính sách hoàn, trần hoàn tiền.

Vấn đề chưa xong (12):
- P-001 [open, high] Chưa kiểm với cổng thanh toán thật nào (phát hiện 2026-10-04)
  Vấn đề: Mọi hành vi của bốn cổng (xác minh IPN, hoàn tiền, HMAC SePay, webhook) mới là giả định theo tài liệu và simulator. Nếu cổng thật khác giả định, tiền khách đã trả có thể không được ghi nhận đúng vào đơn.
  Tinh chỉnh: Chưa xử lý. Cần đăng ký sandbox thật (cần tài khoản merchant) rồi kiểm từng giả định.
  Tham chiếu: docs/agent/STATUS.md, VNPS-S-008
- P-002 [open, medium] Bảng mã lý do thất bại chỉ theo tài liệu hoặc gần như trống (phát hiện 2026-10-04)
  Vấn đề: Bảng mặc định theo tài liệu (VNPay, MoMo) hoặc gần như trống (OnePAY chỉ 99 và 253, SePay rỗng), nên phần lớn mã thật sẽ thành unknown cho tới khi có sandbox. Đổi failCodeMap phải khởi động lại Hub.
  Tinh chỉnh: Người vận hành ghi đè được bằng cấu hình failCodeMap. Cần kiểm với cổng thật và bổ sung bảng.
  Tham chiếu: PHUB-S-020
- P-003 [open, medium] Khai báo phương án thanh toán của adapter chưa kiểm với cổng thật (phát hiện 2026-10-04)
  Vấn đề: methods của bốn adapter khai theo tài liệu. Khai sai thì routing định tuyến sai phương án. Routing chỉ biết cổng CÓ THỂ phục vụ phương án, không bảo đảm khách chọn đúng phương án trên trang cổng.
  Tinh chỉnh: Người vận hành sửa được bằng hub.gateways[].methods. Routing theo số liệu đo được chưa làm vì cần dữ liệu thật.
  Tham chiếu: PHUB-D-029
- P-004 [open, high] Tiền về muộn sau mốc hỏi lại cuối có thể không bắt được (phát hiện 2026-10-04)
  Vấn đề: Hỏi lại attempt đã đóng mới ở mức simulator. Chưa biết cổng thật có cho khách trả lại trên URL cũ không. Tiền về sau mốc cuối (24 giờ) khi IPN cũng mất thì không bắt được, vì chưa có đối soát theo sao kê của cổng chuyển hướng.
  Tinh chỉnh: Đã có hỏi lại ở mốc 1 giờ và 24 giờ (mốc là lựa chọn ban đầu, chưa dựa trên dữ liệu thật). Còn thiếu đối soát theo sao kê.
  Tham chiếu: PHUB-D-027
- P-005 [open, medium] Hai khoản tiền cùng một attempt chưa nhận ra đủ mọi trường hợp (phát hiện 2026-10-04)
  Vấn đề: Chưa biết cổng thật có gửi hai khoản cùng một attempt hay mã giao dịch có ổn định giữa IPN và truy vấn không. Khoản đầu qua truy vấn rồi khoản hai qua IPN hiện chưa nhận ra.
  Tinh chỉnh: Bộ kịch bản ngẫu nhiên đã chạy trên PostgreSQL và simulator của ba cổng chuyển hướng. Còn thiếu SePay và hoàn tiền sâu. Khác kênh (IPN rồi truy vấn) mà mã giao dịch khác nhau thì hiện không báo động giả (có test ghi nhận), nên khoản thứ hai ở kênh khác chưa được nhận ra.
  Tham chiếu: PHUB-S-019, PHUB-S-026, PHUB-S-028
- P-006 [open, medium] Chưa chọn broker cho production, chưa thử Kafka với SASL/TLS (phát hiện 2026-10-04)
  Vấn đề: Lớp connector Kafka đã thử với Redpanda một nút, gồm ca broker bị đóng băng giữa chừng rồi Hub khởi động lại (không mất tin, đúng thứ tự theo key, trùng được phép), và với broker giả. Production chưa bật Kafka. Các hạn thời gian mặc định (request 10 giây, kết nối 3 giây, thử lại 2 lần) là lựa chọn ban đầu, chưa đo.
  Tinh chỉnh: Cần chọn giữa Redpanda một nút, Kafka tự quản hay dịch vụ có quản lý, rồi thử SASL/TLS, nhiều broker và đo lại các hạn thời gian.
  Tham chiếu: PHUB-S-017, PHUB-S-032, D-008
- P-007 [open, medium] Đường triển khai thật chưa chạy lần nào (phát hiện 2026-10-04)
  Vấn đề: Nhánh -Push và -Remote của scripts/deploy.ps1 chưa chạy vì chưa có VM, Docker Hub private, tên miền. Chứng chỉ Let’s Encrypt thật, sao chép bản sao lưu ra ngoài VM và lịch cron cũng chưa có.
  Tinh chỉnh: Script mặc định chỉ in kế hoạch; có bước --check-config với cấu hình thật trước khi thay bản đang chạy.
  Tham chiếu: PHUB-D-031, scripts/deploy.ps1
- P-008 [open, low] Phía cổng chưa tách đúng ba lớp (phát hiện 2026-10-04)
  Vấn đề: Trong từng adapter, lớp vào/ra và lớp chuẩn hóa nằm chung trong index.js, chỉ tách bằng cách tiêm deps.fetch, chưa có test quét import giữ ranh giới bên trong adapter. src/server.js vừa nhận HTTP vừa gắn route cổng và route app.
  Tinh chỉnh: Đã ghi là nợ đã biết trong CONVENTIONS. Tầng "kiểu" (luồng chung cho cổng chuyển hướng, chuyển khoản) chưa nên làm vì chưa có hai adapter cùng kiểu dùng chung mã thật.
  Tham chiếu: docs/agent/CONVENTIONS.md, PHUB-S-021
- P-009 [open, low] Chưa đo trên dữ liệu lớn và trên Linux (phát hiện 2026-10-04)
  Vấn đề: Chưa đo trên bảng hàng triệu dòng và trên Linux. Bench 400 kết nối cùng lúc bị ECONNREFUSED trên Windows, chưa điều tra. Chưa đo thời gian adopt khi có rất nhiều attempt còn sống.
  Tinh chỉnh: Chưa xử lý.
  Tham chiếu: tools/bench, PHUB-D-025
- P-011 [open, medium] Ca test còn thiếu hoặc chưa chạy mặc định (phát hiện 2026-10-06)
  Vấn đề: So bộ test hiện có (687 ca; tìm theo tên test và từ khóa, chưa đọc từng assert) với các nhóm cần có. Chưa thấy ca cho: (1) thông báo của cổng đến khi attempt còn CREATED, tức trước khi lời gọi tạo trả về; (2) tắt tiến trình đúng giữa lúc ghi bảng và lúc phát sự kiện: hiện chỉ có SIGKILL ngẫu nhiên giữa tải (test/e2e/hub-crash.test.js) và kiểm không giao lần hai sau khởi động (scenarios-delivery-pg), không chèn điểm dừng chính xác; (3) Stripe trong kịch bản ngẫu nhiên và mô phỏng (scenarios-sim): chưa có; (4) ma trận mỗi luồng nhân mỗi cổng qua HTTP cùng simulator: chưa đủ (e2e theo cổng có hub-sims cho ba cổng chuyển hướng, hub-sepay-*, hub-transfer, hub-stripe; thu, nhả, tranh chấp chỉ ở Stripe; hoàn một phần chưa kiểm cho từng cổng). Đã có: tạo trùng cùng và khác nội dung, số tiền ở biên (hub-edge-inputs), chữ ký sai ở từng adapter, webhook trùng, sai thứ tự, lệch số tiền, cổng lỗi hoặc quá giờ (hub-faulty-gateway), mã ngoài bảng ánh xạ (fail-codes), hai yêu cầu cùng lúc (scenarios-concurrency), hoàn quá số đã thu. Thêm: 44 ca cần PostgreSQL hoặc Kafka thật bị bỏ qua khi không đặt HUB_TEST_DATABASE_URL và broker, nên chạy mặc định không kiểm tích hợp thật.
  Tinh chỉnh: Cập nhật 2026-10-07: bốn nhóm đã có test. (1) callback đến khi CREATED: test/hub/callback-before-create.test.js, 3 ca, LỘ LỖI LÕI THẬT (xem P-012), đang để todo. (2) chết giữa ghi và phát: test/hub/crash-write-emit.test.js, 3 ca (chết trước COMMIT, sau COMMIT trước khi giao, sau khi sink nhận trước khi ghi kết quả giao), qua; điểm dừng chèn ở ranh giới COMMIT, chưa kiểm chết tiến trình thật giữa hai câu SQL. (3) Stripe trong kịch bản ngẫu nhiên: test/e2e/scenarios-stripe.test.js và test/support/stripe-runner.js, charge và auth, chạy 150 seed x 100 bước mỗi loại, 0 lỗi. (4) hoàn một phần theo từng cổng: test/e2e/hub-refund-matrix.test.js, 10 ca cho VNPay, MoMo, OnePAY, SePay A, Stripe, qua. Còn thiếu của nhóm 4: thu, nhả, tranh chấp cho cổng không phải Stripe (các cổng khác không có khả năng đó). Đo với PostgreSQL thật: 705 ca, 700 qua, 0 hỏng, 2 bỏ qua (Kafka thật), 3 todo (P-012). Mọi ca chỉ chạy với simulator và adapter giả.
  Tham chiếu: test/support/pg.js:11, test/e2e/hub-crash.test.js, test/hub/scenarios-concurrency.test.js, test/e2e/scenarios-sim.test.js
- P-013 [open, high] PayPal chưa kiểm với PayPal thật (chưa có sandbox) (phát hiện 2026-10-07)
  Vấn đề: Adapter PayPal (Orders v2) và simulator được viết từ trang tài liệu (đọc qua công cụ tóm tắt, chưa đối chiếu bản OpenAPI) và kinh nghiệm chung; chưa gọi PayPal lần nào. Chưa kiểm: tên trường và mã HTTP của lỗi; custom_id có chép từ order sang capture, khoản giữ, hoàn và webhook hay không (adapter dựa vào đó để biết attempt, có đường lùi là GET capture rồi GET order); refunds trả kèm custom_id khi xem order (queryRefund dựa vào); khách duyệt rồi đóng tab thì PayPal có gửi CHECKOUT.ORDER.APPROVED đáng tin không; chữ ký webhook với chứng chỉ thật (ta chỉ kiểm máy chủ phát, chưa kiểm chuỗi tin cậy, và không có dung sai thời gian); capture PENDING kéo dài ra sao; hình dạng resource và outcome_code của tranh chấp; hạn order 3 giờ và khoản giữ 29 ngày; TWD (tài liệu tóm tắt tự mâu thuẫn). Nếu cổng thật khác giả định, tiền khách trả có thể không được ghi nhận đúng.
  Tinh chỉnh: Chưa xử lý. Cần tài khoản sandbox PayPal (clientId, clientSecret, webhookId) rồi chạy từng giả định ở docs/agent/paypal-research.md mục "Chưa kiểm với PayPal thật". Cấu hình mẫu src/config.example.json để cổng tắt (enabled false).
  Tham chiếu: docs/agent/paypal-research.md, PYPL-S-001, PYPL-S-002, P-001
- P-014 [open, medium] PayPal: order sống 3 giờ nhưng đơn Hub chỉ 30 phút, khách duyệt muộn vẫn bị thu (phát hiện 2026-10-07)
  Vấn đề: Order PayPal sống 3 giờ (hardExpiry 180 phút) còn đơn Hub mặc định 30 phút. Khách duyệt sau khi Hub đã hết hạn attempt thì adapter vẫn thu (return hoặc webhook CHECKOUT.ORDER.APPROVED) vì adapter không biết hạn của Hub. Hub ghi late_success (tiền thắng) và người vận hành phải xử lý, thường là hoàn tiền: khách bị trừ tiền cho một đơn cửa hàng có thể đã hủy. Có test (hub-paypal: "khách duyệt SAU khi đơn Hub đã hết hạn") chứng minh tiền không vô hình, nhưng không chứng minh nên thu.
  Tinh chỉnh: Chưa xử lý (quyết định có chủ ý ở PYPL-D-001, ghi là rủi ro). Cách sửa nếu cần: ghi hạn của Hub (createPayment.expiresAt) vào order (ví dụ reference_id, chưa kiểm PayPal có nhận) hoặc tra lại từ state, rồi adapter từ chối thu khi quá hạn và trả sự kiện expired; hoặc đặt hub.paymentTtlSeconds gần 3 giờ cho cổng này. Cần người dùng chọn.
  Tham chiếu: PYPL-D-001, src/adapters/paypal/index.js, test/e2e/hub-paypal.test.js

Đã xử lý (2):
- P-010 Script npm test bỏ sót thư mục test/stripe: Đã sửa 2026-10-06: package.json thêm "test/stripe/*.test.js" vào script test; cả bộ chạy 687 ca, 685 qua, 0 hỏng (có PostgreSQL thật).
- P-012 Kết quả lời gọi tạo đến muộn ghi đè trạng thái attempt đã nhận thông báo của cổng: Đã sửa 2026-10-07 (người dùng duyệt): trong _startAttempt (src/hub.js), sau khi lời gọi tạo trả về, nếu attempt đã rời CREATED thì giữ nguyên trạng thái, chỉ lưu state của cổng và ghi sự kiện create_result_after_callback; không ghi đè bằng AWAITING, UNKNOWN hay finalize FAILED. Ba ca test/hub/callback-before-create.test.js nay qua (bỏ todo). Cả bộ với PostgreSQL thật: 705 ca, 703 qua, 0 hỏng, 2 bỏ qua (Kafka thật). Chưa kiểm với cổng thật: cổng nào thật sự gửi IPN trước khi phản hồi tạo đến nơi.

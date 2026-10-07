# Payment Hub

Điều phối thanh toán qua nhiều cổng (VNPay, MoMo, OnePAY, SePay trong nước; Stripe và PayPal quốc tế) qua adapter cô lập. Thiết kế và quyết định: `docs/modules/payment-hub/`.

## Chạy

```
HUB_CONFIG=src/config.example.json \
HUB_PUBLIC_BASE_URL=https://hub.example.com HUB_API_TOKEN=<chuỗi bí mật dài> \nHUB_DATABASE_URL=postgres://user:matkhau@host:5432/hub \
MOMO_PARTNER_CODE=... MOMO_ACCESS_KEY=... MOMO_SECRET_KEY=... \
node src/main.js
```

- Cấu hình là tệp JSON; bí mật chỉ tham chiếu bằng `${BIẾN_MÔI_TRƯỜNG}`. Thiếu biến của cổng đang bật thì Hub không khởi động. Cổng có `"enabled": false` không cần biến.
- Dữ liệu lưu trong **PostgreSQL** (`databaseUrl`, tùy chọn `databaseSchema`), cơ sở dữ liệu duy nhất của dự án (`docs/agent/DECISIONS.md` D-004). Chỉ chạy **một** tiến trình Hub cho mỗi schema: Hub giữ advisory lock, tiến trình thứ hai bị từ chối khi khởi động. Mất kết nối cơ sở dữ liệu thì Hub thoát; chạy dưới trình điều phối có tự khởi động lại (Docker `restart: unless-stopped`) để nạp lại trạng thái từ DB.
- Cài thư viện: `npm ci` (`pg` cho PostgreSQL, `kafkajs` cho connector Kafka; chỉ nạp khi cấu hình dùng Kafka).
- Bộ lập lịch gọi đối soát mỗi `schedulerSeconds` giây.
- Chưa có TLS: đặt Hub sau reverse proxy HTTPS.

## Kiểm cấu hình trước khi chạy (PHUB-D-024)

```
HUB_CONFIG=infra/prod/hub.config.json node src/main.js --check-config          # không mạng, không ghi DB
HUB_CONFIG=infra/prod/hub.config.json node src/main.js --check-config --connect # thêm SELECT 1 tới PostgreSQL
npm run check-config -- đường/dẫn/cấu-hình.json
```

Gom MỌI lỗi một lần (biến môi trường thiếu, cổng lạ, bảng mã lỗi sai, cấu hình thiếu khóa, nguồn vào Kafka thiếu tuyến trả lời...) thay vì dừng ở lỗi đầu tiên; dùng đúng đường dựng của Hub nên cái gì làm Hub không khởi động thì ở đây cũng báo lỗi. Mã thoát 0 hợp lệ, 1 có lỗi. Cảnh báo (không chặn): `publicBaseUrl` trống hoặc không https, thiếu `metricsToken`, cổng đang trỏ môi trường thử, SePay webhook không xác thực. Hub không nạp lại cấu hình khi đang chạy: đổi cấu hình thì kiểm trước rồi khởi động lại.

## Docker (chạy thử local)

```
docker compose up --build -d   # Hub + PostgreSQL + MoMo giả
node infra/local/demo.js                                         # tạo thanh toán, khách trả, kiểm PAID
docker compose down -v         # dừng và xóa dữ liệu
```

- `Dockerfile` ở gốc repo: `--target hub` là image của Hub (node:24-alpine, chạy non-root, chỉ chứa `src/` và `node_modules` của `pg`, không có test/docs/bí mật); `--target sim` chỉ để chạy thử local, không đẩy lên registry.
- Compose dùng giá trị giả cho token và khóa; chỉ gắn cổng vào 127.0.0.1. Bí mật của môi trường thật phải nằm trong `.env` trên máy chủ, không nằm trong image hay repo (xem skill `cicd` ở `BSN_/.claude/skills/cicd`).

## API

Cửa hàng và vận hành cần `Authorization: Bearer <apiToken>`.

| Route | Việc |
|---|---|
| `POST /payments` | `{orderId, amount, returnUrl, orderInfo?, product?, clientIp?}`. Idempotent theo `orderId`: gọi lại trả 200 cùng payment. Khác số tiền: 409 `order_conflict` |
| `GET /payments/{id}` | Trạng thái payment, attempt, refund, anomaly |
| `POST /payments/{id}/attempts` | `{reason: "customer_retry" \| "failover"}`. 409 nếu attempt cũ còn có thể nhận tiền |
| `POST /refunds`, `POST /refunds/{id}/done` | Hoàn tiền; xác nhận hoàn thủ công |
| `GET /anomalies`, `POST /anomalies/{id}/resolve` | Tiền bất thường (muộn, thừa, trùng, chưa rõ chủ). Hoàn tiền cần cổng xác nhận, hoặc `force` kèm `note` |
| `POST /reconcile` | Chạy đối soát ngay |
| `GET /gateways` | Trạng thái từng cổng: breaker (closed/open/half_open), đang gọi, đang chờ, tổng số theo kết quả |
| `GET /calls?gateway=&ref=&limit=` | Nhật ký gọi cổng (thời điểm, phương thức, mã tham chiếu, thời gian, kết quả); không có thân request/response |
| `GET /webhooks?status=`, `POST /webhooks/{id}/retry` | Webhook đi tới cửa hàng; gửi lại thủ công (chỉ dead hoặc pending) |
| `GET /metrics` | Số đo Prometheus (token quản trị hoặc `metricsToken`; token cửa hàng bị 403) |
| `GET /openapi.json` | Tài liệu OpenAPI 3.1 sinh từ code (cần token): đường dẫn, schema, vai trò, mã lỗi, sự kiện đi ra (mục `webhooks`), định dạng lệnh/sự kiện Kafka (`x-kafka`). Bản sinh sẵn: `docs/_generated/openapi.json` (`node tools/openapi.js`) |
| `GET /health` | Công khai |

Cổng gọi vào (không token, adapter tự xác thực): `GET|POST /ipn/{gateway}`, `GET|POST /return/{gateway}`. Địa chỉ IPN của VNPay, OnePAY, SePay phải đăng ký trong cổng quản trị của họ trỏ về `https://<hub>/ipn/<gateway>`. `/return` chỉ để hiển thị: trình duyệt được chuyển về `returnUrl` của cửa hàng kèm `paymentId` và trạng thái do Hub ghi nhận, không phải điều cổng khẳng định.

## Kết nối với dịch vụ khác (PHUB-D-017)

Hai trục độc lập: phía cổng thanh toán (`hub.js`, `adapters/`, `guard.js`) và phía kết nối dịch vụ (`src/app/`, `src/connectors/`). Chúng chỉ gặp nhau ở lõi qua hai cổng chuẩn; `test/hub/connectors-arch.test.js` quét mã nguồn để giữ ranh giới.

- **Cổng vào** `src/app/`: danh mục thao tác (`operations.js`) là nguồn sự thật cho vai trò, schema, mã lỗi; `app.execute(thao tác, đầu vào, principal)` là điểm vào duy nhất cho mọi transport. Connector HTTP (`connectors/in/http.js`) sinh route từ danh mục; connector Kafka (`connectors/in/kafka.js`) nhận lệnh `{commandId, op, input, shopId?}`.
- **Cổng ra** `src/events.js`: lõi chỉ gọi `events.emit(...)`; mỗi sự kiện thành một bản giao cho mỗi tuyến khớp (trạng thái, thử lại, dead, gửi lại riêng). Sink: `webhook` (ký HMAC) và `kafka` (key = paymentId).
- **Thêm connector = thêm một tệp** vào `src/connectors/out/` hoặc `src/connectors/in/` xuất `{kind, create}`; registry tự quét (`connectors.dirs` để đặt ngoài cây mã nguồn). Không sửa `hub.js`, `main.js`, `server.js`. Mẫu: `connectors/out/webhook.js`.
- Cấu hình:

```json
"connectors": {
  "kafka": { "brokers": ["redpanda:9092"], "clientId": "payment-hub" },
  "out": [{ "id": "bus", "sink": "kafka", "topic": "payment.events.v1", "types": ["payment.*", "command.*"], "shops": "*" }],
  "in":  [{ "id": "commands", "source": "kafka", "topic": "payment.commands.v1", "groupId": "payment-hub", "principal": { "role": "admin" } }]
}
```

  `types` khớp tên chính xác hoặc tiền tố `payment.*`; `shops` là `"*"` hoặc danh sách. Webhook cũ (`hub.webhooks`, `shops[].webhooks`) giữ nguyên và là tuyến ngầm `webhook`. Topic phải tạo sẵn (compose local có `redpanda-init`). Nguồn vào Kafka cần ít nhất một tuyến ra nhận `command.completed` để trả kết quả, nếu không Hub không khởi động.
- **Hạn thời gian Kafka** (PHUB-D-032): `connectors.kafka` nhận thêm `requestTimeoutMs` (mặc định 10000), `connectionTimeoutMs` (3000) và `retries` của producer (2). Mặc định của kafkajs (request 30 giây, thử lại 5 lần) làm một lần gửi tới broker đóng băng treo cả phút và chặn vòng giao tin; với giá trị trên, lần gửi lỗi trong chừng nửa phút và hộp thư đi thử lại theo backoff. Các số này là lựa chọn của tôi, chưa đo trên broker production; broker chậm thật (không đóng băng) mà đặt quá thấp sẽ gây gửi lỗi giả rồi gửi trùng.
- **Lệnh qua Kafka**: `principal` do cấu hình nguồn vào chỉ định (`{role:"admin"}` tin cậy, hoặc `{role:"shop", id}` gắn cứng một cửa hàng), không lấy từ thông điệp. Đúng một lần theo `commandId`: khóa, thay đổi trạng thái và phản hồi `command.completed`/`command.failed` (key = commandId) ghi cùng một lần. Lỗi nghiệp vụ thành phản hồi `failed`; thông điệp hỏng vào `<topic>.dlq`; lỗi hạ tầng thì thử lại, không bỏ qua.
- Giao **ít nhất một lần**: bên nhận loại trùng theo `id` của sự kiện (hoặc `commandId`). Thứ tự bảo đảm theo key. Chạy thử: `docker compose up --build -d` rồi `node infra/local/demo.js` (kiểm sự kiện ra topic và lệnh gửi trùng); `node --test test/e2e/kafka-live.test.js` (cần Redpanda ở 127.0.0.1:19092, tự bỏ qua nếu không có).

## Hợp đồng adapter mở rộng và nhiều mục cùng cổng (PHUB-D-018)

Tương thích ngược: adapter không dùng các điểm dưới đây vẫn chạy như cũ.

- `createPayment` có thể trả `state` (JSON thuần, tối đa 2 KB, không bí mật); Hub lưu ở attempt (không ra API) và truyền lại cho `query`, `refund`, `queryRefund`, `cancel`. `refund` còn nhận `receipts` (các khoản thu của attempt) để chọn khoản gốc.
- Sự kiện `reversed` (cổng trả tiền lại cho khách: void, hoàn từ phía cổng): mã giao dịch phải ổn định giữa các kênh. Hub không tự đổi trạng thái đơn, chỉ mở anomaly `funds_reversed` cho người vận hành (resolve bằng `ignore` kèm ghi chú) và trừ phần đã đảo khỏi số còn hoàn được.
- `parseCallback` có thể trả `retryLater: true` (chữ ký hợp lệ nhưng chưa tra cứu được, ví dụ API quá tải): Hub không đổi gì và trả ack lỗi để cổng gửi lại.
- `hub.gateways` cho phép nhiều mục cùng `id` khi mỗi mục khai `adapterProduct`, ví dụ SePay B chính, C dự phòng: `{"id":"sepay","adapterProduct":"va-order","priority":1}, {"id":"sepay","adapterProduct":"gateway","priority":2}`. Failover loại theo mục chứ không theo cả cổng; breaker và lịch đối soát vẫn theo `id` (cùng một cổng thật).

## Routing và phương án thanh toán chuẩn (PHUB-D-029)

Routing là module riêng `src/routing.js`, chỉ biết hợp đồng (`contract.js`), cấu hình `hub.gateways` và khai báo năng lực của adapter; không biết tên cổng nào. Cửa hàng có thể nói nhu cầu thay vì tên cổng: `createPayment` nhận `method` (tùy chọn) thuộc danh mục chuẩn `wallet`, `qr`, `bank_transfer`, `virtual_account`, `card_domestic`, `card_international`. Routing chỉ chọn cổng phục vụ phương án đó (không có thì `no_gateway_available`); failover giữ nguyên phương án; không nói gì thì cổng nào cũng được như trước.

- Adapter khai phương án trong năng lực (`capabilities().methods`). Hiện theo tài liệu, chưa kiểm với cổng thật: VNPay `card_domestic`, `qr`; MoMo `wallet`; OnePAY DOMESTIC `card_domestic`, INTERNATIONAL `card_international`, QR `qr`; SePay qr-static `bank_transfer`, va-order `virtual_account`, gateway `card_international`, `qr`, `bank_transfer`.
- Operator ghi đè bằng cấu hình, không sửa code: `"gateways": [{"id": "vnpay", "priority": 1, "methods": ["card_domestic", "qr", "card_international"]}]`. Cùng một cổng có thể có nhiều mục `adapterProduct`, mỗi mục một phương án (ví dụ OnePAY nội địa và quốc tế). Phương án ngoài danh mục thì Hub không khởi động.
- Routing chỉ biết cổng CÓ THỂ phục vụ phương án, không bảo đảm khách chọn đúng phương án trên trang của cổng.

## Hỏi lại attempt đã đóng không thành công (PHUB-D-027)

Khách vẫn có thể trả trên URL cũ của một attempt đã `FAILED`, `CANCELLED` hoặc `EXPIRED`; nếu IPN của khoản đó mất hẳn thì trước đây Hub không bao giờ biết (chỉ attempt còn sống mới được đối soát). Nay Hub hỏi lại cổng ở các mốc `hub.reconcile.closedRecheckSeconds` (mặc định `[3600, 86400]`, tính từ lúc attempt đóng). Tìm thấy tiền thì ghi anomaly `late_success` (hoặc `duplicate_charge`), trạng thái cuối của attempt không đổi.

- `[]` tắt; ghi đè theo cổng ở `reconcile.perGateway.<cổng>.closedRecheckSeconds`. Danh sách phải là số giây dương tăng dần, sai thì Hub không khởi động.
- Không áp dụng cho cổng từ chối lúc tạo, cổng không truy vấn được, cổng đã có sao kê đối soát (`reconcileFeed`).
- Tốn tối đa hai lần truy vấn thêm cho mỗi attempt thất bại (mặc định): cổng giới hạn tốc độ chặt thì giảm mốc hoặc tắt. Số đo: `hub_closed_rechecks_total{gateway,outcome}`. Hỏi lỗi quá 5 lần liên tiếp thì ghi anomaly `recheck_failed`.

## Cổng quốc tế Stripe (STRP-D-001..003)
Adapter `stripe` (src/adapters/stripe) dùng trang thanh toán Checkout do Stripe lưu trữ: Hub không nhận số thẻ. **Chỉ mới kiểm với simulator `tools/sim/stripe`; chưa kiểm với Stripe thật** (xem `docs/agent/stripe-research.md` về điều chưa kiểm).
- Cấu hình `adapters.stripe`: `secretKey` (`${STRIPE_SECRET_KEY}`), `webhookSecret` (`whsec_...`, có thể là danh sách khi xoay khóa), `product` (`charge` thu ngay, `auth` giữ tiền rồi thu bằng capture; chọn theo mục `hub.gateways[].adapterProduct`), `currencies` (mã ISO 4217 bật cho cổng này, mặc định USD EUR GBP JPY VND SGD), `sessionExpiresMinutes` (31 đến 1439, mặc định 60; đây là hạn cứng của cổng), `apiVersion` (ghim, mặc định 2026-09-30.endive), `baseUrl`, `timeoutMs`, `failCodeMap`.
- Webhook: trong Stripe Dashboard đặt endpoint tới `${publicBaseUrl}/ipn/stripe` và bật các sự kiện `payment_intent.succeeded`, `payment_intent.amount_capturable_updated`, `payment_intent.canceled`, `checkout.session.expired`, `checkout.session.async_payment_failed`, `charge.dispute.created`, `charge.dispute.closed`, `refund.created`. Chữ ký `Stripe-Signature` được kiểm (dung sai 300 giây hai chiều). Đặt `api_version` của endpoint trùng `apiVersion`.
- Sản phẩm `auth` giữ tiền tới 7 ngày: đặt `reconcile.perGateway.stripe.maxAgeSeconds` lớn hơn hạn giữ (ví dụ 864000) để Hub không báo `authorization_stale` sớm.
- Tiền: lõi giữ số mũ ISO 4217; adapter đổi sang đơn vị Stripe (ISK và UGX nhân 100, tiền ba chữ số phải là bội của 10). UGX và tiền ba chữ số chưa kiểm: `check-config` cảnh báo.
- Khi mất phản hồi lúc tạo phiên, Hub không có mã phiên để hỏi lại: attempt ở UNKNOWN và chờ webhook (webhook mang attemptRef nên vẫn nhận ra đơn).

## Cổng quốc tế PayPal (PYPL-D-001..003)
Adapter `paypal` (src/adapters/paypal) dùng PayPal Orders v2: khách duyệt trên trang PayPal, Hub không nhận số thẻ. **Chỉ mới kiểm với simulator `tools/sim/paypal`; chưa gọi PayPal thật lần nào** (xem `docs/agent/paypal-research.md` về điều chưa kiểm).
- **Khác Stripe: khách duyệt xong tiền CHƯA chuyển.** Adapter thu (hoặc giữ) giúp Hub khi khách quay về `${publicBaseUrl}/return/paypal` hoặc khi webhook `CHECKOUT.ORDER.APPROVED` đến; cả hai idempotent. Truy vấn của Hub chỉ đọc, không bao giờ thu. Nếu cả hai đều mất, order ở `APPROVED` không bị thu, khách không bị trừ tiền và order tự hết hạn sau 3 giờ: khách phải thử lại.
- Cấu hình `adapters.paypal`: `clientId` (`${PAYPAL_CLIENT_ID}`), `clientSecret` (`${PAYPAL_CLIENT_SECRET}`), `webhookId` (mã webhook ở trang PayPal; có thể là danh sách), `product` (`charge` thu ngay, `auth` giữ tiền rồi thu bằng capture), `currencies` (mặc định USD EUR GBP JPY AUD CAD SGD HKD; **VND không được PayPal hỗ trợ và không bật được**), `baseUrl` (sandbox `https://api-m.sandbox.paypal.com`, thật `https://api-m.paypal.com`), `returnBaseUrl` (mặc định `publicBaseUrl` của Hub), `certHosts` (tên miền được phép phát chứng chỉ webhook, mặc định `paypal.com`), `timeoutMs`, `failCodeMap`.
- Webhook: ở trang PayPal đặt endpoint tới `${publicBaseUrl}/ipn/paypal` và bật `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.RESOLVED`. Chữ ký RSA-SHA256 được tự kiểm bằng chứng chỉ tải từ `paypal-cert-url` (chỉ máy chủ trong `certHosts`, https); chưa kiểm chuỗi tin cậy của chứng chỉ và không có dung sai thời gian (PayPal giao lại tới 3 ngày).
- Sản phẩm `auth` giữ tiền tới 29 ngày: đặt `reconcile.perGateway.paypal.maxAgeSeconds` lớn hơn hạn giữ (ví dụ 2592000).
- Tiền: PayPal dùng chuỗi thập phân; adapter đổi theo số mũ ISO 4217 của lõi (JPY không thập phân). TWD, HUF, RUB, ILS không bật (tài liệu mâu thuẫn hoặc lõi chưa biết).
- Mã giao dịch của Hub là mã order, cho cả khoản giữ lẫn khoản thu. Hoàn do Hub tạo mang `custom_id` `HUB:<refundRef>` để webhook hoàn không bị tính là tiền bị đảo.

## Trần số tiền (PHUB-D-019)

`hub.maxAmount` (mặc định 1e12 VND, tối đa `MAX_SAFE_INTEGER/1000`): `createPayment` chỉ nhận số nguyên an toàn không vượt trần, để số quá lớn không tới adapter (cổng nhân hệ số 100 nên số lớn mất chính xác hoặc thành dạng `1e+23`). Trần thật của từng cổng đặt ở `gateways[].maxAmount`.

## Lý do thất bại chuẩn (PHUB-D-020)

Mỗi cổng báo thất bại bằng mã riêng; adapter dịch sang một bảng chuẩn: `user_cancelled`, `expired`, `insufficient_funds`, `declined`, `gateway_error`, `invalid_request`, `unknown`. Hub ghi `failCode` (chuẩn) và `gatewayCode` (mã gốc, để tra cứu) lên attempt và trả trong API; số đo `hub_attempt_failures_total{gateway,status,fail_code}`.

- Mã chưa có trong bảng ra `unknown`, không bao giờ đoán. Bảng mặc định: VNPay và MoMo theo bảng mã chính thức; OnePAY chỉ 99 (khách hủy) và 253 (hết hạn); SePay rỗng (chưa có bằng chứng).
- Operator thêm hoặc sửa bảng trong cấu hình, không cần sửa code: `"adapters": {"vnpay": {"failCodeMap": {"65": "insufficient_funds"}}}`. Giá trị sai bị từ chối khi khởi động. Bảng này chỉ đổi LÝ DO; việc có tiền hay không (đã thanh toán, thất bại, đang chờ) vẫn do code adapter quyết định nên cấu hình sai không biến thất bại thành thành công.
- `hub.failover.skipOnFailCodes` (mặc định rỗng = không đổi hành vi): danh sách lý do chuẩn mà sau đó `createAttempt` với reason `failover` bị từ chối (`failover_not_applicable`, HTTP 409), ví dụ `["user_cancelled"]`. `customer_retry` vẫn dùng được.

## Nhiều cửa hàng (PHUB-D-015)

Cấu hình `shops: [{id, apiToken, webhooks: {url, secret}}]`. `apiToken` ở gốc là token quản trị. Token cửa hàng chỉ thấy payment, hoàn tiền, webhook của cửa hàng đó (của người khác hoặc không tồn tại đều 404) và không gọi được route vận hành (403). `shopId` lấy từ token, không từ thân request; token quản trị chỉ định qua `body.shopId` (mặc định `default`). `orderId` chỉ cần duy nhất trong từng cửa hàng. Mỗi cửa hàng nhận webhook ở URL riêng, ký bằng secret riêng; sự kiện không gắn payment đi tới endpoint mặc định (`hub.webhooks.url`) nếu có. `apiToken` và `apiToken` của từng cửa hàng nhận được mảng: thêm token mới, đổi phía gọi, rồi bỏ token cũ (xoay vòng không gián đoạn). `${VAR:-mặc định}` trong cấu hình dùng giá trị mặc định khi biến thiếu hoặc rỗng (dùng cho webhook tùy chọn).

## Quan sát (PHUB-D-013)

`GET /metrics` trả định dạng Prometheus: request và độ trễ theo route mẫu, thao tác Hub, thông báo của cổng theo kết quả, lời gọi tới cổng theo kết quả, trạng thái breaker từng cổng, anomaly mở theo loại, webhook chờ và tuổi webhook chờ lâu nhất, thời gian ghi, bộ nhớ. Mỗi request có `X-Request-Id` (giữ giá trị hợp lệ của người gọi, nếu không thì sinh) và một dòng nhật ký truy cập JSON trên stderr: `{ts, level, msg:"request", requestId, method, route, status, ms}`. Nhật ký không có query string, thân, token hay id thật trong đường dẫn. Cấu hình `accessLog: false` để tắt, `metricsToken` để cho Prometheus dùng token riêng.

## Bộ nhớ nóng (PHUB-D-012)

Giao dịch đã đóng (PAID/CLOSED, không còn attempt sống, hoàn tiền mở, anomaly mở) nhàn rỗi quá `hub.hot.idleSeconds` (120) được đẩy ra khỏi bộ nhớ và nạp lại từ PostgreSQL khi có thông báo muộn, truy vấn, hoàn tiền, hoặc cùng orderId. Khởi động chỉ nạp phần còn hoạt động. Khóa chống trùng trong DB giữ `hub.hot.seenTtlDays` (90) ngày.

## Chịu tải và độ tin cậy (PHUB-D-009..011)

- **Giới hạn tải** (`limits` trong cấu hình): `maxInFlight` request đồng thời (vượt thì 503 + Retry-After; callback của cổng có thêm `callbackReserve`), `ratePerSecond`/`burst` cho API cửa hàng và vận hành (vượt thì 429).
- **Bảo vệ khi gọi cổng** (`hub.protection`, ghi đè theo cổng ở `perGateway`): timeout ngoài, giới hạn đồng thời + hàng chờ, circuit breaker. Mặc định ở `guard.js`. Chưa gửi (breaker mở, quá tải) được phép chuyển cổng; timeout thì KHÔNG (tiền có thể đã bị thu).
- **Đối soát**: `hub.reconcile.concurrency` (hỏi song song), `perGateway` (lịch riêng từng cổng), `refundBackoffSeconds` (lịch hoàn tiền dài). **Hoàn tiền**: `hub.refund.maxPerAttempt`, `maxAgeDays`.
- **Webhook tới cửa hàng** (`hub.webhooks`: `url`, `secret`, tùy chọn `maxAttempts`, `backoffSeconds`, `concurrency`, `timeoutMs`). Không có `url` thì tắt. Cửa hàng xác minh: `HMAC-SHA256(secret, X-Hub-Timestamp + "." + thân)` so với `X-Hub-Signature` (hex), chống xử lý trùng theo `X-Hub-Event-Id`, trả 2xx khi đã nhận. Sự kiện: `payment.paid`, `payment.closed`, `refund.updated`, `anomaly.opened`. Webhook chỉ là thông báo; nguồn sự thật là `GET /payments/{id}`.
- **Đo tải**: `HUB_TEST_DATABASE_URL=... node --expose-gc tools/bench/load.js 20000 200` (gọi thẳng hàm) hoặc `tools/bench/http-load.js` (qua HTTP thật); `BENCH_EVICT=1` bật đẩy giao dịch đã đóng ra khỏi bộ nhớ. Không tính độ trễ cổng thật. Số đo và giới hạn còn lại nằm ở `docs/modules/payment-hub/3-impl.md` (PHUB-S-009, S-012, S-016).
- **Kiểm thử chịu lỗi**: `test/e2e/hub-faulty-gateway.test.js` (cổng chậm/lỗi hàng loạt), `test/e2e/hub-crash.test.js` (giết Hub bằng SIGKILL giữa tải rồi kiểm các bất biến về tiền).
- **Triển khai**: `infra/prod/` (compose production với Caddy TLS, sao lưu và khôi phục PostgreSQL) và `scripts/deploy.ps1`; xem `infra/prod/README.md`.

## Test

Node 24 không nhận đường dẫn thư mục, dùng glob:

```
node --test "test/hub/*.test.js" "test/e2e/*.test.js" "test/momo/*.test.js" "test/onepay/*.test.js" "test/vnpay/*.test.js" "test/sepay/*.test.js"
```

Mọi test chạy với simulator ở `tools/sim/<cổng>/server.js`, chưa nối cổng thật nào.

Các test lưu bền vững cần một PostgreSQL thật; không có thì bị bỏ qua và nêu lý do:

```
docker run -d --name bsn-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17
HUB_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres  # đặt biến này rồi chạy lệnh test ở trên
```

Mỗi test dùng một schema riêng và tự dọn.

Ba loại kịch bản kiểm (PHUB-D-019): đồng thời (`test/hub/scenarios-concurrency.test.js`), ngẫu nhiên có kiểm bất biến về tiền (`test/hub/scenarios-random.test.js`, mặc định 300 seed x 90 bước), và đầu vào cực đoan qua simulator (`test/e2e/hub-edge-inputs.test.js`). Chạy rộng hơn: `SEEDS=4000 STEPS=150`; lặp lại một seed lỗi: `SEED=<số>`. Mọi kịch bản chỉ chứng minh Hub đúng với adapter giả và simulator, không phải cổng thật.

Kịch bản ngẫu nhiên trên PostgreSQL có khởi động lại Hub và evict (`test/hub/scenarios-random-pg.test.js`, `PG_SEEDS`, `PG_STEPS`) và cho phía giao tin ra (`scenarios-delivery.test.js`, `scenarios-delivery-pg.test.js`) cũng nhận `SEED=<số>` để lặp lại một seed lỗi (PHUB-D-026). Chạy song song nhiều bộ PostgreSQL được vì mỗi seed dùng một schema riêng.

Kịch bản ngẫu nhiên với simulator thật của ba cổng chuyển hướng (`test/e2e/scenarios-sim.test.js`, `SIM_SEEDS`, `SIM_STEPS`, PHUB-D-028): simulator là sự thật nền về tiền cổng đã thu, nên kiểm được hai điều: tiền cổng đã thu không bao giờ vô hình với Hub, và Hub không báo thu khống. Sự thật nền là của simulator, không phải của cổng thật.

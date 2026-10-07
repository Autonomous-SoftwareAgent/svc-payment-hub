# Payment Hub production (1 VM, docker compose)

Stack: PostgreSQL 17 (volume `pg-data`, không mở cổng) + Hub (image `HUB_IMAGE`, non-root, read-only) + Caddy (TLS tự động, chỉ mở 80/443). Triển khai bằng `scripts/deploy.ps1` (xem skill `cicd` ở `BSN_/.claude/skills/cicd`); không `docker compose up` tay.

## Chuẩn bị trên VM (một lần)
1. Cài Docker + Compose plugin; DNS của `HUB_DOMAIN` trỏ về VM; firewall GCP chỉ mở 80/443 (và SSH/IAP).
2. Tạo `~/app/.env` từ `.env.example` (`chmod 600`), điền giá trị thật. `POSTGRES_PASSWORD` và `HUB_API_TOKEN`: `openssl rand -hex 32`. Mọi biến `${...}` của cổng đang `enabled` trong `hub.config.json` phải có giá trị, thiếu là Hub không khởi động (kể cả `SHOP_WEBHOOK_URL`).
3. `docker login` bằng token Docker Hub chỉ đọc.
4. Sửa `hub.config.json` trước khi deploy: `baseUrl` mẫu đang là sandbox VNPay/MoMo/OnePAY, đổi sang địa chỉ thật khi đi production; bật/tắt cổng ở `hub.gateways`.

## Chạy
- Deploy: `.\scripts\deploy.ps1 -Execute -Push -Remote user@vm` (mặc định chỉ in kế hoạch). Script gửi compose/Caddyfile/hub.config.json, backup DB, đổi `HUB_IMAGE` trong `.env`, pull, kiểm cấu hình bằng image mới (`--check-config` với `.env` thật trên VM; lỗi thì hủy deploy và bản đang chạy giữ nguyên), up, chờ healthy, tự quay về tag trước nếu không khỏe. Rollback tay: `-Execute -Remote user@vm -Tag hub-<cũ>`.
- Kiểm tra: `docker compose ps`, `curl https://<domain>/health`, `docker compose logs --tail=100 hub`.
- Chạy thử local: sao thư mục này, tạo `.env` giả với `HUB_DOMAIN=localhost HUB_HTTP_PORT=8088 HUB_HTTPS_PORT=8443`, `HUB_IMAGE=bsn-payment-hub:<tag build local>`; Caddy tự dùng CA nội bộ (`curl -k`).

## Truy cập công khai và quản trị
- Công khai: `/ipn/*`, `/return/*`, `/health`.
- Mọi route khác (cửa hàng/vận hành): Caddy trả 401 nếu thiếu header `Authorization` (Hub vẫn kiểm token ở lớp sau). Nếu đặt `HUB_ADMIN_ALLOW_CIDR` (vd `203.0.113.0/24 198.51.100.7/32`, cách nhau bằng dấu cách) thì IP nguồn ngoài dải bị 403, dù có token. Để trống = chỉ cần token. Nên đặt dải IP máy chủ cửa hàng.
- Lưu ý: kiểm IP dùng địa chỉ kết nối thật tới Caddy; đừng đặt thêm proxy/CDN phía trước mà không cấu hình `trusted_proxies`.
- Redirect HTTP->HTTPS bỏ số cổng; chỉ ảnh hưởng khi chạy thử với cổng khác 80/443.

## Biến môi trường
Danh sách và chú thích trong `.env.example`. Bí mật chỉ nằm ở `.env` trên VM (không trong image, không trong repo, `deploy.ps1` không bao giờ gửi `.env`).

## Sao lưu
- Windows: `.\backup.ps1 [-OutDir .\backups] [-Keep 14]`. Linux VM: `./backup.sh [thư_mục] [số_bản]`. Tạo `hub-yyyyMMdd-HHmmss.dump` (pg_dump -Fc trong container), kiểm tra không rỗng và đọc được, giữ N bản mới nhất.
- Lịch: cron trên VM, vd `15 * * * * cd ~/app && ./backup.sh ~/app/backups 48`. `deploy.ps1` cũng backup trước mỗi lần deploy.
- Dữ liệu trong volume mất theo VM: sao chép thư mục `backups/` ra ngoài VM (vd `gsutil cp` lên GCS) theo lịch. Việc này CHƯA tự động hóa.

## Khôi phục (ghi đè dữ liệu hiện tại)
`.\restore.ps1 -File .\backups\hub-<mốc>.dump -Force` hoặc `./restore.sh <file> --force`. Trình tự: kiểm dump, dừng hub, xóa và tạo lại DB `hub`, `pg_restore`, bật hub, chờ healthy. Sau đó đối chiếu `GET /payments/{id}`; dữ liệu sau thời điểm backup sẽ mất, nên đối soát lại với cổng thanh toán (`POST /reconcile`). Hub giữ trạng thái trong bộ nhớ nên luôn khởi động lại sau khi khôi phục (script đã làm).

## Quản lý cửa hàng và quan sát
- Nhiều cửa hàng: khai báo `shops: [{id, apiToken, webhooks:{url,secret}}]` trong `hub.config.json` (token cửa hàng thành biến `${...}` trong `.env`); token cửa hàng chỉ thấy dữ liệu của mình. Thêm cửa hàng cần khởi động lại Hub (xem `src/README.md`).
- Giám sát: `GET /metrics` (Prometheus, Bearer token quản trị hoặc `HUB_METRICS_TOKEN`). Qua Caddy route này không công khai: cần header Authorization và (nếu đặt) nằm trong `HUB_ADMIN_ALLOW_CIDR`. Nên đặt cảnh báo cho: `hub_gateway_breaker_state == 2`, `hub_anomalies_open > 0`, `hub_webhook_oldest_pending_age_seconds > 600`, `hub_persist_errors_total` tăng, `hub_store_dirty_entities` tăng liên tục.
- Nhật ký: Hub ghi JSON mỗi dòng ra stderr (`docker compose logs hub`), mỗi request có `requestId` (trùng header `X-Request-Id` trả về cho người gọi). Chưa có nơi tập trung log.

## Quay vòng token / secret (không gián đoạn)
Hub nhận danh sách token quản trị (`apiToken` là mảng: `HUB_API_TOKEN` và `HUB_API_TOKEN_PREVIOUS`) và danh sách token cho từng cửa hàng.
1. Sinh token mới (`openssl rand -hex 32`). Trong `.env`: đặt `HUB_API_TOKEN_PREVIOUS` = token đang dùng, `HUB_API_TOKEN` = token mới. `docker compose up -d hub` (Hub lên lại trong vài giây, cổng tự gửi lại IPN; cửa hàng cần retry trong khoảng này).
2. Các nơi gọi chuyển sang token mới. Trong lúc đó cả hai token đều dùng được.
3. Khi chắc không còn ai dùng token cũ: xóa `HUB_API_TOKEN_PREVIOUS`, `up -d hub`. Token cũ trả 401.
- Token cửa hàng trong `shops[].apiToken` cũng nhận mảng: thêm token mới vào mảng, deploy, cửa hàng đổi, bỏ token cũ.
- Secret webhook (Hub ký): Hub chỉ ký bằng MỘT secret mỗi cửa hàng. Quy trình: (a) cửa hàng cho phía nhận chấp nhận CẢ secret cũ và mới; (b) đổi `SHOP_WEBHOOK_SECRET` (hoặc `shops[].webhooks.secret`), `up -d hub`; webhook đang chờ gửi lại sẽ ký bằng secret mới; (c) cửa hàng bỏ secret cũ.
- Secret cổng thanh toán (VNPAY_HASH_SECRET...) đổi cùng lúc ở cổng quản trị của họ và `.env`; có khoảng giao dịch lỗi chữ ký, làm giờ thấp điểm.
- `POSTGRES_PASSWORD`: không đổi chỉ bằng `.env` (mật khẩu đã nằm trong volume). Chạy `ALTER USER hub PASSWORD '<mới>'` bằng `docker compose exec postgres psql -U hub`, rồi sửa `.env` và `up -d hub`.
- Nghi lộ secret: đổi ngay, không chờ cửa sổ thuận lợi.

## Kết nối dịch vụ qua Kafka (chưa bật)

Image đã chứa connector Kafka (PHUB-D-017) nhưng `hub.config.json` production **không** khai báo `connectors`, nên không có gì chạy và Hub không cần broker. Bật khi đã chọn broker (DECISIONS D-008: chưa chốt Redpanda một nút, Kafka tự quản hay dịch vụ có quản lý):

1. Tạo sẵn topic (Hub không tự tạo): sự kiện ra, lệnh vào, DLQ của lệnh.
2. Thêm khối `connectors` vào `hub.config.json` (mẫu: `src/README.md`, mục "Kết nối với dịch vụ khác"; cấu hình chạy được ở `infra/local/hub.config.json`). Broker có xác thực: `connectors.kafka.ssl` và `sasl`, giá trị bí mật lấy từ biến môi trường (`${VAR}`).
3. Chưa thử với Kafka production (SASL/TLS, nhiều broker). Thử trên môi trường tạm trước, gồm kịch bản broker chết giữa tải (sự kiện nằm lại hộp thư đi rồi tự đẩy bù).

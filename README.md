# Payment Hub

Dịch vụ đứng giữa cửa hàng và các cổng thanh toán (VNPay, MoMo, OnePAY, SePay trong nước; Stripe và PayPal quốc tế). Cửa hàng chỉ nói chuyện với Hub; Hub chọn cổng, theo dõi từng lần thanh toán và giữ cho tiền với đơn hàng luôn khớp nhau kể cả khi cổng báo trễ, trùng hoặc không báo. Mỗi cổng nằm sau một adapter cô lập; lõi Hub không biết gì riêng về cổng nào.

Đây là một dịch vụ độc lập trong hệ BSN: repo riêng, `docker compose` riêng, tài liệu riêng. Thư mục cha `BSN_` chỉ là nơi tập hợp các dịch vụ (mỗi dịch vụ một repo) và tài liệu dùng chung.

## Chạy nhanh
```
npm ci
npm test                      # cần PostgreSQL: xem "Test"
docker compose up --build -d  # Hub + PostgreSQL + MoMo giả (local)
node infra/local/demo.js      # kiểm nhanh luồng thanh toán
docker compose down -v
```
Hai cách chạy:
- **Chạy một mình** (lệnh ở trên): `docker compose up`, Hub ở cổng 8080, broker Redpanda ở 127.0.0.1:19092. Cổng 8080 trùng với `ingest` chạy một mình, nên không bật hai compose cùng lúc.
- **Chạy trong hệ BSN** (cùng các dịch vụ khác): từ `BSN_/` chạy `node infra/bsn.js up --apply`; Hub ở cổng 8000, broker chung ở 127.0.0.1:19192. Infra chạy ảnh dựng từ commit được ghim ở `BSN_/infra/services/payment-hub.json`, không dùng `docker-compose.yml` của repo này. Kiểm nhanh: `HUB_URL=http://127.0.0.1:8000 SIM_URL=http://127.0.0.1:8100 KAFKA_BROKER=127.0.0.1:19192 node infra/local/demo.js`.

Lên bản mới trong hệ (S-017, S-023, S-029: khai báo trước, build sau): job `image` chỉ đóng gói commit đang được ghim trong `infra/services/payment-hub.json`; lần đẩy khác chỉ chạy test. Thứ tự: (1) commit ở máy và chạy test; (2) từ `BSN_/` chạy `node infra/bsn.js pin payment-hub --apply`, `git -C infra add services/payment-hub.json`, `git -C infra commit -m "ghim payment-hub <mã commit>"`, `git -C infra push` (tờ thuộc repo deploy `Autonomous-SoftwareAgent/deploy`, nằm ở `BSN_/infra/`, không thuộc repo gốc); (3) `git push` repo payment-hub: test qua thì bản `main-<12 ký tự commit>` được đóng gói. Lỡ đẩy mã trước khi ghim: ghim xong thì chạy tay `gh workflow run ci.yml -R Autonomous-SoftwareAgent/svc-payment-hub`. `node infra/bsn.js images` báo "CHỜ BUILD" cho commit đã ghim mà chưa có bản. Ghim và đẩy chỉ khi người dùng bảo. Phiên payment-hub chỉ ghi đúng tờ của mình, phần còn lại của `infra/` không sửa.

Cấu hình, API, chịu tải, nhiều cửa hàng, quan sát: [src/README.md](src/README.md).

## Test
Cần một PostgreSQL thật:
```
docker run -d --name hub-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17
HUB_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
```
Không đặt biến thì các test cần DB bị bỏ qua (có nêu lý do). Test với Kafka thật cần Redpanda (`docker compose up -d redpanda redpanda-init`); test đóng băng broker chỉ chạy riêng một mình: `HUB_TEST_KAFKA_CHAOS=1 HUB_TEST_DATABASE_URL=... node --test test/e2e/kafka-delivery-live.test.js`. Đo tải: `tools/bench/` (xem README của Hub).

## Cấu trúc
| Thư mục | Nội dung |
|---|---|
| `src/` | Mã của Hub: lõi, store PostgreSQL, HTTP API, adapter từng cổng |
| `test/` | Test lõi, test từng cổng, test e2e (giết Hub giữa tải, cổng lỗi hàng loạt) |
| `tools/sim/` | Simulator từng cổng (VNPay, MoMo, OnePAY, SePay, Stripe, PayPal) |
| `tools/bench/` | Công cụ đo tải |
| `docs/` | Tài liệu theo module (design, spec, impl), `agent/` (STATUS, DECISIONS, CONVENTIONS), `_generated/` (sinh tự động) |
| `infra/local/` | Cấu hình và kịch bản kiểm nhanh cho `docker-compose.yml` ở gốc (chạy thử local) |
| `infra/prod/` | Compose production: Caddy TLS, sao lưu và khôi phục PostgreSQL |
| `scripts/deploy.ps1` | Build image từ MỘT commit chỉ định (mặc định commit được ghim ở `BSN_/infra/services/payment-hub.json`; nhãn ảnh là 12 ký tự đầu của commit; không đọc thư mục làm việc), (tùy chọn) đẩy Docker Hub và triển khai lên VM; mặc định chỉ in kế hoạch |
| (ngoài repo) `BSN_/.claude`, `BSN_/.claude/plugin/mcp` | Harness và công cụ tài liệu dùng chung cho mọi dịch vụ (hook, skill, gate, MCP `bsn-docs`, bộ sinh của dịch vụ này ở `BSN_/.claude/plugin/mcp/generators/payment-hub/`). Repo này không còn `.claude/`, `.mcp.json` hay `tools/docs/` |

## Làm việc với agent
Mở phiên Claude Code ở thư mục cha `BSN_/` (không mở ở thư mục này) rồi giao việc cho Payment Hub: hook kiểm tài liệu, gate duyệt kế hoạch và MCP `bsn-docs` chỉ có ở `BSN_/.claude`, mở thẳng ở đây thì không hook nào chạy (quy tắc: [CLAUDE.md](CLAUDE.md), D-013). Bản cho người đọc: cổng HTML cục bộ `BSN_/docs/portal/payment-hub/index.html`. Đọc theo thứ tự: [docs/agent/STATUS.md](docs/agent/STATUS.md), [docs/agent/DECISIONS.md](docs/agent/DECISIONS.md), [docs/agent/CONVENTIONS.md](docs/agent/CONVENTIONS.md). Kiểm tài liệu: `npm run docs`.

## Quan hệ với BSN_
- Tài liệu tham chiếu nền (`docs/tham-chieu`, `docs/ops`) và hạ tầng GCP dùng chung (`infra/gcp`) nằm ở thư mục cha `BSN_`, ngoài repo này.
- Các quyết định chung của cả hệ BSN (GitHub và GitHub Actions, Docker Hub, PostgreSQL, triển khai, bố cục, harness, tài liệu, sơ đồ) nằm ở `BSN_/docs/system/decisions.md` (S-001 đến S-021). Sổ [docs/agent/DECISIONS.md](docs/agent/DECISIONS.md) của repo này giữ D-001 đến D-015 làm lịch sử (có bảng ánh xạ sang S ở đầu tệp) và các quyết định riêng của Payment Hub.
- Đã quyết định dùng GitHub (repo public) và GitHub Actions build rồi đẩy ảnh Docker Hub, triển khai lên VM GCP (S-019, thay D-001). Chưa có repo nào trên GitHub và chưa đẩy gì khi người dùng chưa ra lệnh.

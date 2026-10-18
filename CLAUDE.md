# Payment Hub

Tệp này là phần riêng của dịch vụ **Payment Hub** (`BSN_/system_service/payment-hub/`). Quy tắc chung cho mọi dịch vụ và cách làm việc nằm ở `../../CLAUDE.md`. Harness (hook, skill, gate, MCP `harness*`) chỉ có một chỗ ở `BSN_/.claude`, nên **mở phiên Claude Code ở `BSN_/`** rồi giao việc cho Payment Hub; mở thẳng trong thư mục này thì không có hook nào (D-013).

## Phạm vi
- Làm trong `system_service/payment-hub/`. Ngoài thư mục này chỉ đọc, trừ `BSN_/docs/handoff/` là nơi được ghi yêu cầu. Việc cần dịch vụ khác, hay cần sửa harness (kể cả bộ sinh trang của Payment Hub ở `BSN_/.claude/project/generators/payment-hub/`), thì ghi yêu cầu vào `BSN_/docs/handoff/` theo mẫu ở `BSN_/docs/handoff/README.md`. Ngoại lệ duy nhất: người dùng nói rõ trong phiên là cho phép sửa harness.
- Đầu phiên:
  1. Mở skill `services`, rồi đọc [docs/agent/STATUS.md](docs/agent/STATUS.md) (bắt buộc), [docs/agent/DECISIONS.md](docs/agent/DECISIONS.md) và [docs/agent/CONVENTIONS.md](docs/agent/CONVENTIONS.md). Các tài liệu còn lại đọc theo bảng "Đọc gì khi nào" ngay bên dưới.
  2. Liệt kê các tệp `BSN_/docs/handoff/*-to-payment-hub-*.md` còn `open` và báo người dùng.
  3. Kiểm các máy chủ MCP của harness (`harness`, `harness-docs`, `harness-diagrams`, `harness-context`, `harness-portal`) đủ công cụ mà tóm tắt đầu phiên nêu (có `diagram_validate`, `diagram_save`, `diagram_explain`, `diagram_list`, `diagram_get`, `diagram_generate`, `diagram_review`, `context_explore`). Thiếu, hoặc kết quả có dòng "CẢNH BÁO" kèm tên máy chủ, thì báo người dùng gõ `/mcp`.
- Duyệt kế hoạch trước khi sửa (gate, DECISIONS D-012; quy trình ở `../../CLAUDE.md`): nêu yêu cầu thì bạn trình kế hoạch và dừng; chỉ sửa tệp sau khi người dùng đồng ý ở lượt sau.

## Đọc gì khi nào
`CLAUDE.md` là cửa vào duy nhất của dịch vụ. Mỗi tài liệu dưới đây là một dòng; nội dung nằm trong tệp được trỏ tới, không chép ở đây. Đọc bằng công cụ Read, tệp dài thì đọc từng phần.

| Khi cần | Đọc |
|---|---|
| Nhận việc làm tiếp mà chưa biết gì: đang ở đâu, việc dở theo thứ tự, điều chưa kiểm, bẫy đã gặp | [docs/agent/ban-giao.md](docs/agent/ban-giao.md) (ghi 2026-10-12; đọc sau `STATUS.md`) |
| Trước khi sửa bất cứ gì (bắt buộc) | [docs/agent/STATUS.md](docs/agent/STATUS.md): đang làm dở gì, lần gần nhất đổi gì, điều chưa kiểm. Nhật ký cũ đã chuyển sang `docs/agent/STATUS-archive.md` |
| Trước khi viết mã: ba lớp nằm ở thư mục nào, quy ước, nợ chưa tách | [docs/agent/CONVENTIONS.md](docs/agent/CONVENTIONS.md) |
| Định đổi một cách làm đã có, hay hỏi "vì sao chọn thế" | [docs/agent/DECISIONS.md](docs/agent/DECISIONS.md) |
| Tìm hiểu một việc (là gì, ở tệp nào, test nào, sửa thì chạm gì) | công cụ `context_explore` (skill `context`), trước khi Grep |
| Hiểu sâu một phần: thiết kế, đặc tả, hiện thực | `docs/modules/<phần>/`: `payment-hub` (lõi), `vnpay-sim`, `momo-sim`, `onepay-sim`, `sepay-sim`, `stripe-sim`, `paypal-sim` |
| Tổng quan dịch vụ; bản đồ mã | `docs/_generated/overview.md` (sinh tự động), `docs/_generated/code-map.md` |
| Nghiên cứu, đối chiếu, mô phỏng hay thêm một cổng thanh toán | [docs/agent/gateway-research.md](docs/agent/gateway-research.md): cách nghiên cứu, mức bằng chứng, quy tắc dừng |
| Việc liên quan Stripe (vì sao adapter làm thế, điều chưa kiểm) | [docs/agent/stripe-research.md](docs/agent/stripe-research.md) |
| Việc liên quan PayPal (vì sao adapter thu giúp Hub, điều chưa kiểm) | [docs/agent/paypal-research.md](docs/agent/paypal-research.md) |
| Cân nhắc đổi hướng lõi so với Hyperswitch (nguồn mở) | [docs/agent/hyperswitch-survey.md](docs/agent/hyperswitch-survey.md) |
| Cân nhắc lấy ý từ các giải pháp lõi nguồn mở khác (ngôn ngữ chung của lõi) | [docs/agent/oss-core-solutions.md](docs/agent/oss-core-solutions.md) |
| Cách ghi tài liệu, thứ tự đọc tài liệu cấp dự án | [docs/agent/README.md](docs/agent/README.md) và [docs/README.md](docs/README.md), cả hai trỏ về bảng này |
| Quy tắc ở "Quy tắc riêng" nào đã thành luật máy chặn lúc ghi tệp (ranh giới import, tên cổng, dữ liệu thẻ, khóa thật, HTML, script test); thêm hay sửa luật | [.harness/](.harness/) (`module.json`, `rules/`, `cases.json`); thử: `node .claude/modules/core/cli/cli.js extension test unit:payment-hub` từ `BSN_/`; luật chỉ chạy sau khi người dùng chạy `extension trust unit:payment-hub` (cách viết: `.claude/modules/core/FORMAT.md`) |

## Việc gì thì dùng skill nào (skill ở `BSN_/.claude/skills/`)
| Việc | Skill |
|---|---|
| Mở đầu mọi việc trong dịch vụ: chỉ đường, đọc gì, làm đúng là thế nào (hook chặn ghi nếu chưa mở) | `services` |
| Ghi tài liệu ba tầng, `docs/service.yaml`, sổ vấn đề `P-nnn` | `service-docs` |
| Thêm hay sửa một sơ đồ | `diagrams` |
| Trang của Payment Hub trên cổng thiếu hay sai, cần thêm mục, cần publish lại | `service-page` |
| Tìm hiểu một việc trước khi Grep; ghi từ vựng, quan hệ | `context` |
| Trình kế hoạch trước khi sửa (khối `## Kế hoạch`, đủ năm mục) | `plan` |
| Build, đẩy Docker Hub, deploy VM GCP, rollback | `cicd` |

Đường dẫn trong skill `cicd` tính từ thư mục này. Nghiên cứu một cổng thanh toán không còn là skill: xem dòng tương ứng ở "Đọc gì khi nào".

## Quy tắc riêng của Payment Hub
- Thiết kế luôn ba lớp: vào/ra, chuẩn hóa, logic nội bộ, phụ thuộc một chiều, gặp nhau qua hợp đồng chuẩn (nguyên tắc chung ở `../../CLAUDE.md`). Ánh xạ vào thư mục, test giữ ranh giới và nợ chưa tách đúng: [docs/agent/CONVENTIONS.md](docs/agent/CONVENTIONS.md). Mã mới phải đặt đúng lớp; không để logic nghiệp vụ vào connector hay adapter, không để logic gọi mạng vào lõi.
- Hai trục tách nhau: phía cổng thanh toán (`src/routing.js`, `src/adapters/*`, `src/contract.js`) và phía kết nối dịch vụ (`src/app`, `src/connectors`). Chiều import một hướng: adapter -> contract <- lõi; chỉ `main.js` và `index.js` nối hai trục. `test/hub/adapters-arch.test.js` giữ ranh giới này; đừng sửa test để cho qua.
- Lõi Hub không biết gì riêng về cổng nào. Thêm cổng là thêm một thư mục adapter tự đăng ký (registry), chuẩn hóa về hợp đồng chuẩn (loại sự kiện, `FAIL_CODES`, `METHODS`); không đưa tên cổng vào lõi.
- Điều gì chưa kiểm với cổng thật phải ghi là chưa kiểm: bảng mã lỗi, khai báo phương án thanh toán, hành vi trả tiền muộn, mốc hỏi lại 1 giờ và 24 giờ đều là giả định theo tài liệu và simulator. Mọi test hiện tại chạy với simulator.
- Không sửa tạm tệp nguồn để thử rồi khôi phục bằng chuỗi lệnh `&&` có thể đứt giữa chừng (đã từng để lại tệp bị sửa dở). Thử đột biến thì dùng công cụ tự khôi phục trong mọi trường hợp, rồi `git status` xác nhận sạch.

## Tài liệu của dịch vụ (chi tiết ở skill `service-docs`, `diagrams`, `service-page`)
- Trong repo này chỉ có Markdown và dữ liệu cho agent; không đặt HTML ở đây.
- Tệp do công cụ sở hữu, chỉ ghi qua công cụ MCP của harness (`harness-docs`, `harness-diagrams`) với `service="payment-hub"` (hook `guard-owned` chặn ghi trực tiếp):
  - `docs/modules/*/{1-design,2-spec,3-impl}.md`: `design_record`, `design_update`, `spec_fill`, `impl_link`. Marker mã dạng `// spec: PHUB-S-nnn`.
  - `docs/service.yaml`: `service_doc_get`, `service_doc_set`, `problem_record`.
  - `docs/diagrams/*.yaml`: `diagram_list`, `diagram_get`, `diagram_validate`, `diagram_save`, `diagram_explain`, `diagram_generate`. **Không tự viết Mermaid ở bất cứ đâu.**
  - `docs/_generated/`: công cụ sinh.
- Sửa mã xong phải sửa thật `docs/agent/STATUS.md` bằng Edit (hook Stop so thời điểm sửa với thời điểm sửa mã), rồi `npm run docs` sạch.
- Khi nghiệp vụ, kiến trúc, phụ thuộc, tiến độ đổi: cập nhật `docs/service.yaml` bằng `service_doc_set`. Phát hiện hay xử lý xong một vấn đề: `problem_record`. Mã đổi hành vi thì cập nhật gì, theo thứ tự nào: skill `service-docs`, mục "Mã vừa đổi hành vi".
- Mã nằm ở đâu để đọc trước khi ghi tài liệu: lõi và máy trạng thái `src/hub.js`; hoàn tiền, cảnh báo tiền, đối soát cũng ở `src/hub.js`; chọn cổng `src/routing.js`; hợp đồng `src/contract.js`; từng cổng `src/adapters/<cổng>/`; webhook và Kafka gửi ra cho cửa hàng `src/connectors/out/`, `src/events.js`; cổng vào `src/app/`, `src/connectors/in/`. Bản đồ đầy đủ: `docs/_generated/code-map.md`.

## Trang cho người đọc
- Một trang ba tab: `BSN_/docs/portal/payment-hub/index.html`, do bộ sinh riêng `BSN_/.claude/project/generators/payment-hub/` dựng. Trang chỉ hiện bản ĐÃ COMMIT của repo này và tự dựng lại sau mỗi commit.

| Tab | Mục |
|---|---|
| Nghiệp vụ | Luồng thanh toán (2 sơ đồ trình tự) · Xử lý sâu một giao dịch (7 sơ đồ luồng, bảng ack, 3 vết chạy thật) · Quy tắc giữ tiền · Tiền bất thường · Kịch bản và lý do thất bại |
| Kiến trúc kỹ thuật | Kiến trúc tầng · Trạng thái (3 sơ đồ trạng thái) · Dữ liệu (2 sơ đồ dữ liệu) · Kiểu và giao diện (2 sơ đồ lớp) · Bốn cổng · Kết nối dịch vụ (1 sơ đồ luồng) · Chịu tải · API và chạy thử |
| Vấn đề và tinh chỉnh | Sổ vấn đề và tiến độ (`docs/service.yaml`) · Tình trạng tài liệu · Làm gì tiếp · Chưa kiểm chứng |

- Thêm sơ đồ thì sửa số và danh sách ở dòng dưới và ở bảng trên.
- 17 sơ đồ nằm ở `docs/diagrams/` (cộng 3 sơ đồ TỰ SINH từ mã `tu-sinh-phu-thuoc-module`, `tu-sinh-cac-lop`, `tu-sinh-cua-vao-ra`: agent chỉ viết giải thích bằng `diagram_explain` và soát với mã bằng `diagram_review`): `du-lieu-bang` (5 bảng PostgreSQL, công cụ TỰ SINH từ cơ sở dữ liệu thật: sửa `src/store-postgres.js` xong thì gọi `diagram_generate` với `id="du-lieu-bang"` rồi viết lại phần giải thích; `npm run docs` nhắc khi quên), `du-lieu-mo-hinh` (các đối tượng trong cột JSON, khai tay: thêm trường hay đổi trạng thái thì sửa), `kieu-cong-thanh-toan` và `kieu-ket-noi-dich-vu` (sơ đồ lớp hai trục: thêm cổng, thêm connector hay đổi `require` thì sửa), `trinh-tu-chuyen-huong`, `trinh-tu-chuyen-khoan`, `luong-1-tao-thanh-toan` đến `luong-7-canh-bao-hoan-tien`, `trang-thai-attempt`, `trang-thai-don`, `trang-thai-hoan-tien`, `ket-noi-dich-vu`. Hành vi của Hub đổi thì sửa sơ đồ tương ứng bằng `diagram_save` (cùng `id`) rồi commit.
- Sơ đồ kiến trúc tầng là HTML/CSS do bộ sinh vẽ từ mã thật (bản người dùng đã duyệt), không phải Mermaid.

## Lệnh thường dùng
- `npm test` (cần PostgreSQL: `HUB_TEST_DATABASE_URL=...`; thiếu thì test cần DB bị bỏ qua, có nêu lý do). Kiểm cấu hình: `node src/main.js --check-config`.
- `npm run docs` (= `node ../../.claude/modules/core/cli/cli.js check`): kiểm đồng bộ tài liệu và mã.
- Chạy một mình: `docker compose up --build -d` (Hub + PostgreSQL + MoMo giả, cổng 8080). Chạy trong hệ BSN: từ `BSN_/` `node infra/bsn.js up --apply` (cổng 8000, broker 127.0.0.1:19192; demo: `HUB_URL=http://127.0.0.1:8000 SIM_URL=http://127.0.0.1:8100 KAFKA_BROKER=127.0.0.1:19192 node infra/local/demo.js`). Lên bản mới trong hệ (S-017, S-029, S-059): commit và chạy test, đẩy `main` (chỉ khi người dùng bảo), rồi gắn nhãn `release/payment-hub` lên commit đã nằm trên `main` trong repo này và đẩy nhãn; chỉ commit có nhãn mới được đóng gói, lần đẩy khác chỉ chạy test (skill `cicd`). Không ghim vào repo deploy (`pin` là cách cũ); chạy bản nào ở đâu do người vận hành chọn bằng `node infra/bsn.js console` hoặc `node infra/bsn.js deploy|rollback payment-hub [commit] --apply`. Phiên payment-hub chỉ ghi đúng tờ `infra/services/payment-hub.json` của mình.
- Triển khai: `scripts/deploy.ps1` build từ một commit chỉ định (mặc định commit ghim ở `BSN_/infra/services/payment-hub.json`), nhãn ảnh là mã commit, không đọc thư mục làm việc (mặc định chỉ in kế hoạch).
- Chạy từ `BSN_/`:
  - `node .claude/modules/core/cli/cli.js --service payment-hub code`: làm mới `docs/_generated/code-map.md`.
  - `node .claude/modules/core/cli/cli.js --service payment-hub overview --run-tests`: sinh lại nội dung trang (kèm số test thật) và dựng lại cổng.
  - `node .claude/modules/core/cli/cli.js diagrams-check`: mở trang bằng trình duyệt không giao diện, kiểm mọi sơ đồ vẽ được.

# CONVENTIONS

Quy ước cho agent khi viết code. Mục nào chưa chốt thì để `TBD`, không tự đoán.

## Công nghệ
- Ngôn ngữ / framework backend: Node.js 24 trở lên (`engines` trong `package.json`), JavaScript thuần, không framework web (HTTP bằng `node:http`), không bước build. Phụ thuộc chạy: `pg` và `kafkajs`. Test: `node --test`.
- Frontend: không có. Hub chỉ là dịch vụ phía sau; trang cho người đọc nằm ở cổng `BSN_/docs/portal`, không phải của Hub.
- Database: PostgreSQL 17, là cơ sở dữ liệu duy nhất (DECISIONS D-004).
- Message broker: Kafka qua connector (kafkajs), tùy chọn bật trong cấu hình (D-008); dev và test dùng Redpanda một nút trong `docker-compose.yml`. Broker cho production chưa chọn.

## Docs và code phải đồng bộ
- Quyết định design/spec/impl của module ghi qua MCP tool `bsn-docs` (xem [README.md](README.md)); không sửa tay các file tầng.
- Mỗi file code thực thi một spec phải có marker `// spec: PREFIX-S-nnn` (đúng cú pháp comment của ngôn ngữ). Một file có thể mang nhiều marker.
- Test cho một spec cũng mang marker và được liệt kê trong `impl_link tests`.
- Xong việc: `docs_check` sạch lỗi trước khi kết thúc.

## Nguyên tắc từ tài liệu tham chiếu (nằm ở `BSN_/docs/tham-chieu`, ngoài repo này) áp dụng ngay từ đầu
- Giá luôn do server tính lại, không tin giá từ client.
- Trạng thái đơn chỉ đổi qua một bảng chuyển, dạng compare-and-set.
- Chỉ có một hàm hủy đơn; job dọn dẹp gọi lại hàm đó.
- Thu tiền phải có đường hoàn tự động; bản ghi hoàn tạo ở trạng thái chờ trước khi gọi cổng thanh toán.
- Sự kiện thanh toán dùng outbox, consumer idempotent; không gọi ra ngoài khi đang giữ transaction DB.
- API tạo đơn nhận khóa idempotency.
- Mặc định từ chối khi thiếu thông tin quyền; service nội bộ tự xác thực người gọi.
- Số nghiệp vụ (thời hạn, trần) là cấu hình có tên, không viết cứng trong code.

## Triển khai
- Theo skill `cicd`: build local, push Docker Hub, deploy lên VM GCP. Không build trên VM, không `docker compose up` tay trên production.
- Image không chứa source gốc hay secret; secret chỉ ở `.env` trên VM.

## Thiết kế ba lớp (nguyên tắc chung ở `../../CLAUDE.md`, đây là ánh xạ vào mã Payment Hub)
Ba lớp: vào/ra (I/O với bên ngoài), chuẩn hóa (dịch giữa dạng bên ngoài và dạng chuẩn), logic nội bộ (nghiệp vụ, trạng thái, kho). Hướng phụ thuộc một chiều, gặp nhau qua hợp đồng chuẩn. Hai hướng đều theo ba lớp:

| Lớp | Phía dịch vụ khác (cửa hàng, dịch vụ BSN) | Phía cổng thanh toán (VNPay, MoMo, OnePAY, SePay) |
|---|---|---|
| Vào/ra | `src/connectors/in` (HTTP, Kafka), `src/connectors/out` (webhook, Kafka), `src/server.js` | gọi API cổng và nhận callback: nằm trong từng `src/adapters/<cổng>/` (lời gọi `deps.fetch`, ký chữ ký), callback vào qua `src/server.js` |
| Chuẩn hóa | `src/app` (danh mục thao tác, schema, mã lỗi, view, cổng typed) | từng `src/adapters/<cổng>/` dịch về hợp đồng `src/contract.js` (loại sự kiện, `FAIL_CODES`, `METHODS`, năng lực); bảng mã lỗi qua `src/adapters/fail-codes.js`; ghi đè bằng cấu hình `failCodeMap`, `methods` |
| Logic nội bộ | `src/hub.js`, `src/routing.js`, `src/events.js`, `src/store.js`, `src/store-postgres.js`, `src/guard.js`, `src/metrics.js`: chỉ biết dạng chuẩn | như cột trái (lõi dùng chung hai phía) |

- Test giữ ranh giới (quét import): `test/hub/connectors-arch.test.js` (connectors chỉ dùng `app/` và nhau; lõi và adapter không import connectors; `app/` không import lõi), `test/hub/adapters-arch.test.js` (lõi và adapter chỉ gặp nhau qua `contract.js`, adapter không import nhau). Đừng sửa các test này để cho qua.
- Thêm bên ngoài mới: thêm một thư mục adapter (registry tự nhận) hoặc một tệp connector; không sửa tệp đang có. Bên ngoài đổi hay bất ổn thì sửa adapter, cấu hình hoặc bảng ánh xạ, không sửa lõi.
- **Chỗ chưa tách đúng ba lớp (nợ đã biết):** phía cổng, lớp vào/ra và lớp chuẩn hóa nằm chung trong `index.js` của từng adapter (SePay chia theo sản phẩm). Chúng chỉ tách bằng cách tiêm `deps.fetch`, không tách thành tệp riêng, và chưa có test quét import giữ ranh giới vào/ra với chuẩn hóa bên trong adapter. `src/server.js` vừa nhận HTTP vừa gắn route cổng và route app, chưa tách hẳn.

## Cấu trúc thư mục
- `src/` mã Hub theo bảng trên; `src/adapters/<cổng>/` mỗi cổng một thư mục; `test/` (lõi `test/hub`, từng cổng `test/<cổng>`, `test/e2e`); `tools/sim/<cổng>` simulator; `docs/` tài liệu theo module (công cụ tài liệu nằm ở `BSN_/.claude/plugin/mcp`, ngoài repo này); `infra/` compose và production.

## Thứ tự điền các tầng docs
- Design chốt trước. Khung spec/impl tự sinh, để trống (status todo).
- Spec và impl chỉ được điền SAU KHI có code: agent đọc code vừa viết, rồi dùng `spec_fill` (yêu cầu, contract, nghiệm thu, task) và `impl_link` (file code, test, lệch).
- Không điền spec/impl khi chưa có code, không để chuỗi giữ chỗ. Khung todo chưa bao giờ bị tính là STALE.
- Ngoại lệ: nếu muốn viết tiêu chí nghiệm thu trước khi code (viết test trước), chỉ ghi acceptance, và phải do người dùng yêu cầu.

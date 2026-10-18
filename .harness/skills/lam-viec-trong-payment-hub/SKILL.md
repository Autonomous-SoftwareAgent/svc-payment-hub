---
name: lam-viec-trong-payment-hub
description: "Dùng trước khi sửa mã trong payment-hub: hai trục, thêm cổng thanh toán, điều chưa kiểm với cổng thật, chạy test, cập nhật tài liệu"
harness-files: ["^src/"]
harness-reads: ["docs/agent/CONVENTIONS.md"]
---
## Trước khi sửa
1. Đọc `CLAUDE.md` và `docs/agent/STATUS.md` (hook bắt buộc), rồi `docs/agent/CONVENTIONS.md` trước khi viết mã.
2. Việc đụng dịch vụ khác hay sửa harness thì ghi tờ vào `docs/handoff/`, không tự sửa.

## Cấu trúc
- Hai trục tách nhau: phía cổng thanh toán (`src/routing.js`, `src/adapters/*`, `src/contract.js`) và phía kết nối dịch vụ (`src/app`, `src/connectors`). Chiều nhập một hướng: adapter -> contract <- lõi; chỉ `main.js` và `index.js` nối hai trục.
- Lõi Hub không biết gì riêng về cổng nào. Thêm cổng là thêm MỘT thư mục adapter tự đăng ký (registry), chuẩn hóa về hợp đồng chuẩn (loại sự kiện, `FAIL_CODES`, `METHODS`); không đưa tên cổng vào lõi.
- `test/hub/adapters-arch.test.js` giữ ranh giới; đừng sửa test để cho qua.

## Quy tắc đã chốt
- Điều gì chưa kiểm với cổng thật phải ghi là chưa kiểm: bảng mã lỗi, phương án thanh toán, hành vi trả tiền muộn, mốc hỏi lại 1 giờ và 24 giờ đều là giả định theo tài liệu và simulator. Mọi test hiện tại chạy với simulator.
- Không sửa tạm tệp nguồn để thử rồi khôi phục bằng chuỗi `&&` có thể đứt giữa chừng. Thử đột biến thì dùng công cụ tự khôi phục trong mọi trường hợp, rồi `git status` xác nhận sạch.
- Không dữ liệu thẻ, không khóa thật, không HTML trong `src/`; thư mục test mới phải có trong script `npm test` (các luật này đã thành luật chặn ở `.harness/`).

## Kiểm
- `npm test` (cần PostgreSQL qua `HUB_TEST_DATABASE_URL`; thiếu thì test cần DB bị bỏ qua có nêu lý do). Cấu hình: `node src/main.js --check-config`.
- Tài liệu (từ `BSN_/`): `node .claude/modules/core/cli/cli.js --service payment-hub check`. Ba tầng, `service.yaml`, sơ đồ chỉ ghi bằng công cụ MCP với `service="payment-hub"`.
- Chạy cả hệ ở máy: `node infra/bsn.js up --apply` (từ `BSN_/`). Không deploy khi người dùng chưa bảo.
- Cuối việc thêm một dòng nhật ký vào `docs/agent/STATUS.md`. Commit ở repo payment-hub; không `git push` khi người dùng chưa bảo.

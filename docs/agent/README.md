# agent

Tài liệu cho agent (Claude) đọc khi phát triển. Mục tiêu: mỗi phiên làm việc mới nắm được dự án đang ở đâu mà không cần hỏi lại. Cấu trúc docs tổng: [../README.md](../README.md).

## Thứ tự đọc
Thứ tự đọc và "khi cần gì thì đọc tệp nào" nằm MỘT chỗ: mục "Đọc gì khi nào" của [../../CLAUDE.md](../../CLAUDE.md). Không lặp lại ở đây để hai nơi không nói khác nhau.

Thư mục này chứa: `STATUS.md` (đang làm gì, nhật ký), `STATUS-archive.md` (nhật ký cũ, chỉ thêm), `DECISIONS.md` (quyết định cấp dự án), `CONVENTIONS.md` (quy ước, ba lớp), `gateway-research.md` (cách nghiên cứu một cổng), `stripe-research.md`, `paypal-research.md`, `hyperswitch-survey.md`, `oss-core-solutions.md`. Module đang làm: `docs/modules/<module>/` (hoặc gọi `docs_status`).

## Quy trình khi chốt quyết định và phát triển
1. **Chốt quyết định design với người dùng** -> gọi MCP tool `design_record` (module, title, decision, rationale, impacts). Tool tự tạo module, ID `PREFIX-D-nnn` và khung spec + impl.
2. **Parse thành spec** -> `spec_fill` cho `PREFIX-S-nnn` (requirement, contract, acceptance, tasks).
3. **Code** -> đặt marker `// spec: PREFIX-S-nnn` trong file code. Sau đó `impl_link` (code, tests, status, deviation).
4. **Design đổi** -> `design_update`, rồi rà lại: `spec_fill` (có thể không truyền trường nào nếu spec vẫn đúng) và `impl_link`.
5. **Trước khi kết thúc** -> `docs_check` phải sạch lỗi.
- Không sửa tay `1-design.md`, `2-spec.md`, `3-impl.md`, `_generated/` (bị chặn); chỉ ghi qua tool.
- Quyết định xuyên dự án (CI/CD, công cụ, quy trình) ghi ở [DECISIONS.md](DECISIONS.md); quyết định nghiệp vụ/kỹ thuật của một module ghi bằng `design_record`.

## Hooks cưỡng chế (ở gốc: `BSN_/.claude/settings.json`, repo này không có hook riêng)
Phiên phải mở ở `BSN_/` thì hook mới chạy (D-013).
- `PostToolUse` (Write|Edit|NotebookEdit) chạy `BSN_/.claude/modules/core/hooks/forward.js track` (gọi `docs-track.js`): ghi lại file code đã sửa trong phiên. Sửa trong `docs/`, và `CLAUDE.md`, `README.md` ở gốc repo, không tính là code.
- `Stop` chạy `forward.js stop` (gọi `docs-stop.js`), chặn kết thúc khi:
  - có sửa code mà [STATUS.md](STATUS.md) chưa được cập nhật sau lần sửa code cuối;
  - `node ../../.claude/modules/core/cli/cli.js check` báo lỗi (STALE, thiếu, code path không tồn tại, marker mồ côi, `service.yaml` sai lược đồ).
  Chỉ nhắc một lần mỗi lượt để không lặp vô hạn. Sau đó hook làm mới `code-map.md`, trang chi tiết kỹ thuật, và dựng lại cổng `BSN_/docs/portal` nếu docs đổi.
- `PreToolUse`: `guard-owned.js` chặn ghi trực tiếp ba tầng, `_generated/` và `service.yaml`; gate duyệt kế hoạch chặn sửa tệp khi người dùng chưa duyệt.
- Trạng thái hook nằm ở `BSN_/.claude/.state/` (không commit).

## Tài liệu sinh từ code
Hai bộ này lấy sự thật từ CODE (nạp module thật, quét mã nguồn), không viết tay, nên không lệch với code:
- **Cho agent**: [../_generated/code-map.md](../_generated/code-map.md): file và spec mà file đánh dấu, phương thức Hub, trạng thái, loại anomaly, mã lỗi, route HTTP, cờ năng lực của từng adapter, số test, tình trạng tài liệu từng module. Sinh bằng `node ../../.claude/modules/core/cli/cli.js code`; hook `Stop` chạy lệnh này mỗi lần, nên luôn mới. Chạy lệnh này trước khi đọc code nếu cần bản đồ nhanh. Trích xuất nằm ở `BSN_/.claude/project/generators/payment-hub/code-facts.js` (route lấy bằng regex từ `server.js`: thêm route kiểu khác thì cập nhật file đó).
- **Cho agent, tổng quan dịch vụ**: [../_generated/overview.md](../_generated/overview.md), sinh từ [../service.yaml](../service.yaml) (nghiệp vụ, kiến trúc, sổ vấn đề `P-nnn`, tiến độ). Sửa nguồn bằng `bsn-docs`: `service_doc_set`, `problem_record`.
- **Cho người đọc**: trang ba tab `BSN_/docs/portal/payment-hub/index.html` (ngoài repo này). Nội dung các mục sinh bằng `node .claude/modules/core/cli/cli.js --service payment-hub overview --run-tests` chạy từ `BSN_/` (chạy bộ test để lấy số test thật); sơ đồ lấy từ `docs/diagrams/` đã commit; sổ vấn đề từ `service.yaml` đã commit. Trang tự dựng lại sau mỗi commit của repo này. Mục nào thuộc tab nào: `CLAUDE.md` của dịch vụ và skill `service-page`.
- Hai bộ này chỉ đọc code và docs, không ghi vào design/spec/impl; thay đổi nội dung thì sửa ở nguồn rồi sinh lại.

## Quy tắc cập nhật tài liệu cấp dự án
- Trước khi code: đọc các file trên.
- Sau mỗi thay đổi có ý nghĩa: cập nhật `STATUS.md` (thêm dòng vào "Nhật ký", đổi trạng thái mục liên quan).
- Quyết định cấp dự án: thêm bản ghi vào `DECISIONS.md`, không sửa bản ghi cũ (đánh dấu `superseded` và thêm bản ghi mới).
- Không đặt HTML trong repo này: bản cho người đọc do cổng `BSN_/docs/portal` sinh từ `service.yaml` và từ mã. Thấy cổng lệch với design/spec thì design/spec thắng: sửa nguồn (`service.yaml` qua `bsn-docs`, hoặc bộ sinh) rồi dựng lại.
- Không ghi secret. Chỉ ghi tên biến môi trường, không ghi giá trị.
- Không ghi lại thứ có thể đọc từ code hoặc git; chỉ ghi lý do, ràng buộc và việc đang dở.

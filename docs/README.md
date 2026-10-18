# docs

Tài liệu của dịch vụ Payment Hub, tổ chức theo **module trước, tầng sau**. Mỗi module giữ cả 3 tầng cạnh nhau để dễ kiểm tra đồng bộ và dễ mở rộng. **Đọc gì trước, đọc gì khi nào: xem mục "Đọc gì khi nào" của [../CLAUDE.md](../CLAUDE.md)** (cửa vào duy nhất; tệp này chỉ mô tả cách tổ chức thư mục).

```
docs/
├── modules/<module>/        # payment-hub, vnpay-sim, momo-sim, onepay-sim, sepay-sim, stripe-sim, paypal-sim
│   ├── 1-design.md          # TẦNG 1 - Design: vì sao, cái gì (quyết định có ID PREFIX-D-nnn)
│   ├── 2-spec.md            # TẦNG 2 - Spec: yêu cầu, contract, nghiệm thu, task (PREFIX-S-nnn)
│   ├── 3-impl.md            # TẦNG 3 - Impl: đã code gì, ở đâu, lệch spec chỗ nào
├── service.yaml             # NGUỒN CÓ CẤU TRÚC của dịch vụ: nghiệp vụ, kiến trúc, vấn đề và tiến độ (chỉ ghi qua bsn-docs)
├── agent/                   # cho agent: STATUS, DECISIONS, CONVENTIONS, tài liệu tham khảo xuyên module như gateway-research.md, hyperswitch-survey.md, oss-core-solutions.md, stripe-research.md, paypal-research.md (xem agent/README.md)
└── _generated/              # SINH TỰ ĐỘNG, không sửa tay (traceability.md, code-map.md, overview.md, openapi.json)

Tài liệu tham chiếu nền (`tham-chieu/`) và vận hành tham chiếu (`ops/`, dựa trên GitHub, không phải quy trình BSN) nằm ở `BSN_/docs/`, ngoài repo này.
```

Thư mục này chỉ chứa Markdown và dữ liệu cho agent (kể cả bản khai báo sơ đồ ở `diagrams/`). Bản cho người đọc là trang ba tab `BSN_/docs/portal/payment-hub/index.html`, do bộ sinh ở `BSN_/.claude/project/generators/payment-hub/` dựng từ mã thật, `service.yaml` và `diagrams/` đã commit; nằm ngoài repo này. Cách làm: skill `service-docs`, `diagrams`, `service-page`.

## Luồng và quy tắc đồng bộ
```
design_record  ->  tự tạo khung spec + impl  ->  spec_fill  ->  code (marker "// spec: ID")  ->  impl_link
```
- ID ổn định xuyên 3 tầng: `BOOK-D-001` (design) ~ `BOOK-S-001` (spec + impl) ~ marker trong code.
- Mỗi tầng ghi hash của tầng trên (`derived_from`, `spec_hash`). Tầng trên đổi mà tầng dưới chưa rà lại thì báo **STALE**.
- 3 file `1-design.md`, `2-spec.md`, `3-impl.md` và `_generated/` **chỉ ghi qua MCP tool `bsn-docs`** (hook `guard-owned.js` ở `BSN_/.claude/modules/servicedocs/hooks/` từ chối ghi trực tiếp, kể cả qua Bash). Tool kiểm schema nên format không trôi.
- Thay đổi đi từ trên xuống. Nếu code lộ ra design sai: sửa design trước (`design_update`), hoặc ghi lệch qua `impl_link deviation`.
- `service.yaml` cũng chỉ ghi qua `bsn-docs` (`service_doc_set`, `problem_record`); từ đó sinh `_generated/overview.md` và trang ba tab ở cổng.
- Kiểm tra: `npm run docs` (= `node ../../.claude/modules/core/cli/cli.js check`; hook Stop và deploy cũng chạy lệnh này). Công cụ nằm ở `BSN_/.claude/modules/servicedocs`, dùng chung cho mọi dịch vụ.

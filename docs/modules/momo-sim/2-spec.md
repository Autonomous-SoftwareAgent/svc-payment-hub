---
module: momo-sim
---
# momo-sim - Spec (tầng 2)

Design được tách thành yêu cầu, contract, tiêu chí nghiệm thu và task. Khung tự sinh từ design; điền qua tool `spec_fill`.

## MOMO-S-001: MoMo: luồng thanh toán và cách tích hợp (API v2, gọi tạo đơn server-to-server, ký HMAC-SHA256)
- from: MOMO-D-001
- derived_from: 8959c243
- status: ready
- requirement: Adapter và simulator MoMo cài đúng luồng, cách ký và hành vi ghi trong design (D-001); simulator chạy được độc lập (node tools/sim/<cổng>/server.js) và start bằng startSimulator(opts) với đồng hồ ảo.
- contract: Adapter createMomoAdapter(config, {fetch, clock}); simulator startSimulator({partnerCode, accessKey, secretKey, ipnUrl?, clock?}). IPN POST JSON ký 13 trường, ack 204. Rà soát với mã 2026-10-04: ack IPN: 204 khi chấp nhận, 400 khi chữ ký sai, 500 khi lỗi nội bộ (ackResponse). Simulator trả HTTP 400 cho mã 20, 13, 11007 và cả 22 (khoảng tiền; 22 chỉ live một phần, A16).
- acceptance: Test chữ ký (vector độc lập), vòng đời adapter với simulator (tạo, thanh toán, IPN, query, hoàn tiền) và test tích hợp với Hub đều xanh.
- tasks: - [x] Adapter, simulator, test,- [ ] Đối chiếu với sandbox thật khi có merchant

## MOMO-S-002: Sổ giả định MoMo: nguồn, mức bằng chứng, đối chiếu docs
- from: MOMO-D-002
- derived_from: 519f4de0
- status: ready
- requirement: Simulator MoMo mô phỏng đúng các hành vi live của sổ giả định (format) và mô phỏng hướng bất lợi, cấu hình được, cho các giả định ngữ nghĩa chưa xác minh: IPN trễ, trùng, mất, sai số tiền, sai chữ ký; thanh toán sau hết hạn.
- contract: POST /sim/control (toàn cục hoặc theo mã tham chiếu), POST /sim/pay, POST /sim/clock/advance, GET /sim/transactions.
- acceptance: Test bất lợi của adapter với simulator và test tích hợp với Hub xanh; mọi giả định unverified vẫn ghi unverified trong sổ.
- tasks: - [x] Kịch bản bất lợi,- [ ] Xác minh các điểm cần merchant thật

## MOMO-S-003: MoMo: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- from: MOMO-D-003
- derived_from: ed42eb7e
- status: ready
- requirement: Adapter MoMo khai báo cờ năng lực theo câu trả lời của design D-003 và làm các việc adapter bắt buộc (map mã sang sự kiện chuẩn, không để "đang xử lý/không tìm thấy" thành failed).
- contract: createCanTimeout=true, hardExpiry=unknown, cancellable=false, queryable=true, refundable=api, refundAsync=true. 9000 (authorized) và 1000/7000/7002 map thành pending; 1005/42 từ query thành not_found. Rà soát với mã 2026-10-04: methods=["wallet"] (PHUB-D-029; theo tài liệu, chưa kiểm với cổng thật). cancellable=false: luồng hai bước chưa cài trong adapter (simulator có /v2/gateway/api/confirm nhưng adapter không gọi; mã 1017 là giả định chưa có nguồn).
- acceptance: assertAdapterShape qua; test map mã và test bất lợi xanh.
- tasks: - [x] Cờ năng lực và map mã,- [ ] Xác minh cờ unverified với merchant thật

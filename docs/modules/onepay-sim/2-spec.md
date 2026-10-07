---
module: onepay-sim
---
# onepay-sim - Spec (tầng 2)

Design được tách thành yêu cầu, contract, tiêu chí nghiệm thu và task. Khung tự sinh từ design; điền qua tool `spec_fill`.

## OPAY-S-001: OnePAY: luồng thanh toán và cách tích hợp (chuyển hướng kiểu VPC, ký HMAC-SHA256)
- from: OPAY-D-001
- derived_from: 045f8a69
- status: ready
- requirement: Adapter và simulator OnePAY cài đúng luồng, cách ký và hành vi ghi trong design (D-001); simulator chạy được độc lập (node tools/sim/<cổng>/server.js) và start bằng startSimulator(opts) với đồng hồ ảo.
- contract: Adapter createOnepayAdapter(config, {clock}); simulator startSimulator({merchant, accessCode, hashKeyHex, ipnUrl?}). URL tạo xác định theo tham số; IPN GET cùng payload với return.
- acceptance: Test chữ ký (vector độc lập), vòng đời adapter với simulator (tạo, thanh toán, IPN, query, hoàn tiền) và test tích hợp với Hub đều xanh. Rà soát với mã 2026-10-04: hoàn tiền: adapter chỉ trả manual_required (không có API hoàn tiền). Test tích hợp Hub nằm ở test/e2e/hub-sims.test.js và scenarios-sim.test.js. Rủi ro đã biết: adapter luôn ký vpc_Currency=VND kể cả INTERNATIONAL (A4 chưa phân xử); nếu cổng quốc tế thật không ký vpc_Currency thì sẽ từ chối.
- tasks: - [x] Adapter, simulator, test,- [ ] Đối chiếu với sandbox thật khi có merchant

## OPAY-S-002: Sổ giả định OnePAY: nguồn, mức bằng chứng, đối chiếu docs
- from: OPAY-D-002
- derived_from: 0816c8e2
- status: ready
- requirement: Simulator OnePAY mô phỏng đúng các hành vi live của sổ giả định (format) và mô phỏng hướng bất lợi, cấu hình được, cho các giả định ngữ nghĩa chưa xác minh: IPN trễ, trùng, mất, sai số tiền, sai chữ ký; thanh toán sau hết hạn.
- contract: POST /sim/control (toàn cục hoặc theo mã tham chiếu), POST /sim/pay, POST /sim/clock/advance, GET /sim/transactions. Rà soát với mã 2026-10-04: còn có POST /sim/ipn/<ref>/resend và các khóa điều khiển ipn_retry_max, force_response_code, return_never. IPN retry 3 lần cách 60 giây là tham số tự đặt (A10 unverified), chỉnh được. "live" trong sổ giả định nghĩa là probe sandbox mtf.onepay.vn với credential test, không phải OnePAY thật. Mã 99 (hủy) và 253 (hết hạn) chưa có dòng giả định riêng: mức docs/suy ra từ bản sao 2020, chưa xác minh.
- acceptance: Test bất lợi của adapter với simulator và test tích hợp với Hub xanh; mọi giả định unverified vẫn ghi unverified trong sổ.
- tasks: - [x] Kịch bản bất lợi,- [ ] Xác minh các điểm cần merchant thật

## OPAY-S-003: OnePAY: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- from: OPAY-D-003
- derived_from: 1cd112ec
- status: ready
- requirement: Adapter OnePAY khai báo cờ năng lực theo câu trả lời của design D-003 và làm các việc adapter bắt buộc (map mã sang sự kiện chuẩn, không để "đang xử lý/không tìm thấy" thành failed).
- contract: hardExpiry theo sản phẩm (DOMESTIC 30 phút, INTERNATIONAL 15 phút), cancellable=false, queryable=true, refundable=manual, refundAsync=true, createCanTimeout=false. Mã 100 và 300 map thành pending; DRExists=N thành not_found; 253 expired; 99 cancelled. Rà soát với mã 2026-10-04: refundable=manual; QR: hardExpiry unknown, methods qr (chưa kiểm; simulator đặt QR 30 phút nên lệch với adapter); methods DOMESTIC card_domestic, INTERNATIONAL card_international (PHUB-D-029); failCode: 99 user_cancelled, 253 expired (PHUB-D-020), mức bằng chứng docs/suy ra.
- acceptance: assertAdapterShape qua; test map mã và test bất lợi xanh.
- tasks: - [x] Cờ năng lực và map mã,- [ ] Xác minh cờ unverified với merchant thật

---
module: vnpay-sim
---
# vnpay-sim - Spec (tầng 2)

Design được tách thành yêu cầu, contract, tiêu chí nghiệm thu và task. Khung tự sinh từ design; điền qua tool `spec_fill`.

## VNPS-S-001: Kiến trúc simulator VNPay: service Node không phụ thuộc, bám hợp đồng của cổng
- from: VNPS-D-001
- derived_from: 9981f33e
- status: ready
- requirement: Có service chạy bằng `node tools/sim/vnpay/server.js`, nghe SIM_PORT, phục vụ đúng các route trên với base path như VNPay thật. Có lớp store giao dịch và lớp đồng hồ ảo (mặc định dùng giờ thật, có thể tăng giờ qua /sim/clock/advance). Mọi thời gian trong phản hồi dùng định dạng yyyyMMddHHmmss múi giờ GMT+7. Rà soát với mã 2026-10-04: simulator giữ trạng thái chỉ trong bộ nhớ (chưa ghi file JSON) và chưa có README; có thêm env SIM_IPN_METHOD và các route /sim/pay, /sim/ipn/{ref}/resend, /paymentv2/pay, Error.html ngoài contract này; SIM_TMN_CODE chưa được kiểm độ dài khi nạp.
- contract:
  Env: SIM_PORT (mặc định 8081), SIM_TMN_CODE (8 ký tự chữ-số), SIM_HASH_SECRET, SIM_IPN_URL, SIM_PUBLIC_BASE_URL.
  Route thật: GET /paymentv2/vpcpay.html ; POST /merchant_webapi/api/transaction (JSON).
  Route giả lập: POST /sim/clock/advance {seconds} ; GET /sim/transactions ; POST /sim/control (xem VNPS-S-007).
- acceptance: Khởi động không cần cài thư viện. Đổi SIM_PUBLIC_BASE_URL/TmnCode/Secret là đủ để adapter BSN trỏ vào simulator. Tăng đồng hồ ảo 16 phút thì đơn có vnp_ExpireDate 15 phút bị coi là hết hạn.
- tasks:
  - [ ] Dựng http server, router và cấu hình env
  - [ ] Lớp store giao dịch trong bộ nhớ (tùy chọn file JSON)
  - [ ] Lớp đồng hồ ảo và định dạng GMT+7
  - [ ] README chạy simulator

## VNPS-S-002: Tạo URL thanh toán: kiểm tra tham số và chữ ký vnp_SecureHash HMAC-SHA512
- from: VNPS-D-002
- derived_from: 88120f89
- status: ready
- requirement: Kiểm tra hai tầng. Tầng 1 (định dạng/giá trị, chạy trước khi tra merchant): thiếu hoặc sai kiểu -> lỗi 03; ngoài khoảng hoặc sai giá trị -> 72; vnp_Amount 0 hoặc âm -> 32; hết hạn -> 15; vnp_CurrCode lạ -> 21. Tầng 2: tra vnp_TmnCode rồi kiểm chữ ký. Tham số: vnp_Version(2.1.0), vnp_Command(pay), vnp_TmnCode(8), vnp_Amount(1-12 số), vnp_CreateDate(14 số GMT+7), vnp_CurrCode(VND), vnp_IpAddr(7-45), vnp_Locale(vn|en), vnp_OrderInfo(1-255, không dấu), vnp_OrderType, vnp_ReturnUrl(10-255), vnp_TxnRef(1-100), vnp_SecureHash. vnp_ExpireDate thiếu thì không bị chặn ở tầng 1. Tùy chọn: vnp_BankCode, vnp_Bill_*, vnp_Inv_*.
- contract: hashData = nối urlencode(key)=urlencode(value) (kiểu PHP, khoảng trắng thành +) của các tham số vnp_* trừ vnp_SecureHash và vnp_SecureHashType, BỎ giá trị rỗng, sắp xếp tăng dần theo tên, ngăn cách "&". vnp_SecureHash = HMAC-SHA512(HashSecret, hashData) hex, so sánh không phân biệt hoa thường.
- acceptance: URL hợp lệ được chấp nhận; mỗi lỗi tầng 1 trả đúng mã 03/72/32/15/21; chữ ký sai bị từ chối; giá trị rỗng không ảnh hưởng chữ ký; chữ ký của simulator khớp golden vector tính độc lập (ví dụ vector trong VnpaySignerTest của settlebook).
- tasks: Hàm sắp xếp, encode PHP-style, HMAC-SHA512, bỏ giá trị rỗng,Bộ kiểm tra tầng 1 theo bảng mã 03/72/32/15/21,Tầng 2: tra TmnCode và kiểm chữ ký,Test golden vector và từng quy tắc,Đối chiếu trang lỗi và TxnRef trùng với sandbox thật (unverified)

## VNPS-S-003: Trang thanh toán và kết quả theo thẻ test, ánh xạ sang vnp_ResponseCode và vnp_TransactionStatus
- from: VNPS-D-003
- derived_from: 1f264e69
- status: ready
- requirement: Kết quả thanh toán dùng bảng vnp_ResponseCode (00, 07, 09, 10, 11, 12, 13, 24, 51, 65, 75, 79, 99) và vnp_TransactionStatus (00, 01, 02, 04, 07). Thành công khi và chỉ khi cả hai là 00. Khi thành công sinh vnp_TransactionNo, vnp_BankTranNo, vnp_PayDate, vnp_CardType. Hết hạn trả 11, hủy trả 24. Chỉ bắt buộc đúng 3 nhóm: thành công, thiếu tiền (51), hủy (24); các thẻ lỗi khác cấu hình được trong cards.json (ngoài phạm vi, xem VNPS-D-009). Rà soát với mã 2026-10-04: vnp_TransactionStatus mô phỏng chỉ sinh 00 và 02 (07 chỉ qua force_response_code); chưa có 01 và 04; chưa có bảng thẻ quốc tế (cards.json chỉ có 5 thẻ NCB, vnp_CardType luôn ATM); chưa có mã đọc cột verified hay in báo cáo.
- contract: Bảng thẻ test (số thẻ -> ResponseCode/TransactionStatus) nằm trong một file cấu hình dữ liệu (ví dụ cards.json), mỗi dòng có cột "verified" để đánh dấu đã đối chiếu sandbox thật hay chưa.
- acceptance: Mỗi thẻ trong cards.json cho đúng kết quả cấu hình; thẻ ngoài bảng bị từ chối; đơn quá hạn trả 11 kể cả nhập thẻ đúng; dòng verified=false được liệt kê trong báo cáo.
- tasks:
  - [ ] Trang thanh toán nhập thẻ và nút hủy
  - [ ] File cards.json và bộ ánh xạ
  - [ ] Sinh vnp_TransactionNo, vnp_BankTranNo, vnp_PayDate
  - [ ] Xử lý hết hạn theo đồng hồ ảo
  - [ ] Chạy từng thẻ trên sandbox thật và điền cột verified

## VNPS-S-004: Return URL: chuyển hướng trình duyệt kèm tham số và chữ ký, không dùng để cập nhật đơn
- from: VNPS-D-004
- derived_from: bfb97ee7
- status: ready
- requirement: Redirect GET tới vnp_ReturnUrl với đủ tham số kết quả. vnp_Amount phản hồi nhân 100. Chữ ký tính trên các tham số kết quả (loại vnp_SecureHash) bằng cùng thuật toán. Có chế độ giả lập khách đóng trình duyệt: không redirect nhưng vẫn gửi IPN. Rà soát với mã 2026-10-04: kiểm chữ ký Return có test (lifecycle.test.js); việc Hub không cập nhật đơn từ Return chỉ được bảo đảm ở phía adapter (gắn source=return), chưa có test ở phía Hub trong module này.
- contract: GET {vnp_ReturnUrl}?vnp_TmnCode=...&vnp_Amount=...&...&vnp_SecureHash=...
- acceptance: BSN xác thực được chữ ký trả về. Khi bật chế độ đóng trình duyệt, đơn vẫn chuyển trạng thái đúng nhờ IPN.
- tasks:
  - [ ] Dựng URL redirect có chữ ký
  - [ ] Chế độ không redirect (đóng trình duyệt)
  - [ ] Test với adapter BSN: không cập nhật đơn từ Return URL

## VNPS-S-005: IPN: GET server-to-server, phản hồi RspCode, retry 10 lần cách 5 phút
- from: VNPS-D-005
- derived_from: 36c091eb
- status: ready
- requirement: Gọi SIM_IPN_URL khi giao dịch có kết quả cuối (kể cả thất bại). Phương thức GET hoặc POST cấu hình được. Số lần retry, khoảng cách và timeout là tham số (mặc định 10 lần, 5 phút, đồng hồ ảo). Mỗi lần ghi log: thời điểm, URL, mã HTTP, RspCode. Hết số lần mà chưa có 00/02 thì đánh dấu ipn_exhausted. Có /sim/ipn/{txnRef}/resend. Phản hồi không phải JSON, HTTP khác 200, lỗi mạng, timeout đều tính là phải thử lại. Rà soát với mã 2026-10-04: retry 10 lần cách 5 phút là mặc định theo docs, chưa xác minh với VNPay thật; chỉ chỉnh được qua opts, không có env; các test retry thật nằm ở adversarial.test.js.
- contract: Request: {GET|POST} {SIM_IPN_URL} với vnp_* và vnp_SecureHash. Phản hồi: {"RspCode":"00","Message":"Confirm Success"}. 00 thành công, 02 đã xác nhận (dừng); 01, 04, 97, 99 thử lại.
- acceptance: BSN trả 00 thì dừng sau 1 lần; trả 97 thì gọi đủ số lần cấu hình rồi ipn_exhausted; trả 02 cho lần trùng thì dừng; đổi tham số retry thì hành vi đổi theo; log truy vấn được qua /sim/transactions. Kịch bản IPN mất hẳn và trùng chạy được (VNPS-S-007).
- tasks: Bộ gửi IPN GET/POST và log từng lần,Lập lịch retry cấu hình được theo đồng hồ ảo,Phân loại RspCode dừng hay thử lại,Endpoint gửi lại thủ công,Đối chiếu timeout và phản hồi lạ với sandbox thật (unverified)

## VNPS-S-006: API querydr (truy vấn giao dịch) và refund (hoàn tiền) với chữ ký dạng nối bằng "|"
- from: VNPS-D-006
- derived_from: 82357002
- status: ready
- requirement:
  querydr: tham số vnp_RequestId, vnp_Version, vnp_Command=querydr, vnp_TmnCode, vnp_TxnRef, vnp_OrderInfo, vnp_TransactionDate, vnp_CreateDate, vnp_IpAddr (+ tùy chọn vnp_TransactionNo, vnp_SecureHash). Phản hồi: vnp_ResponseId, vnp_Command, vnp_ResponseCode, vnp_Message, vnp_TmnCode, vnp_TxnRef, vnp_Amount, vnp_BankCode, vnp_PayDate, vnp_TransactionNo, vnp_TransactionType (01/02/03), vnp_TransactionStatus, vnp_OrderInfo, (vnp_PromotionCode, vnp_PromotionAmount) + vnp_SecureHash.
  refund: tham số như tài liệu (thêm vnp_TransactionType, vnp_Amount, vnp_CreateBy). Mã lỗi querydr: 00, 02, 03, 91, 94 (trùng trong 5 phút), 97, 99. Mã lỗi refund: 00, 02, 03, 04 (không hoàn toàn phần sau hoàn một phần), 13 (chỉ cho hoàn một phần), 91, 93 (số tiền hoàn không hợp lệ), 94 (đã gửi yêu cầu hoàn, đang xử lý; hoặc trùng trong 5 phút), 95 (giao dịch gốc không thành công), 97, 98, 99. Rà soát với mã 2026-10-04: mô phỏng hoàn tiền chỉ trả TransactionStatus 05, kết quả cuối chỉ lộ qua /sim/transactions (chưa có 06 và 09); querydr luôn trả TransactionType 01 và chưa sinh mã 03, 13, 98; mã 94 khóa theo vnp_RequestId, không theo TxnRef. adapter.queryRefund trả trạng thái đã lưu từ lần refund, nếu không thì manual_required.
- contract:
  Chuỗi ký request querydr: RequestId|Version|Command|TmnCode|TxnRef|TransactionDate|CreateDate|IpAddr|OrderInfo.
  Chuỗi ký response querydr: ResponseId|Command|ResponseCode|Message|TmnCode|TxnRef|Amount|BankCode|PayDate|TransactionNo|TransactionType|TransactionStatus|OrderInfo|PromotionCode|PromotionAmount.
  Chuỗi ký request refund: RequestId|Version|Command|TmnCode|TransactionType|TxnRef|Amount|TransactionNo|TransactionDate|CreateBy|CreateDate|IpAddr|OrderInfo.
  Chuỗi ký response refund: ResponseId|Command|ResponseCode|Message|TmnCode|TxnRef|Amount|BankCode|PayDate|TransactionNo|TransactionType|TransactionStatus|OrderInfo.
- acceptance: Test: querydr đơn thành công trả TransactionStatus 00; đơn lạ trả 91; gọi lại trong 5 phút ảo trả 94; chữ ký sai trả 97. Hoàn tiền toàn phần đơn thành công thành công; hoàn quá số tiền gốc bị từ chối; hoàn toàn phần sau khi đã hoàn một phần bị từ chối (04); hoàn đơn không thành công trả 95; hoàn lặp trả 94. Chữ ký phản hồi do simulator tạo được code độc lập xác thực đúng.
- tasks:
  - [ ] Hàm ký và xác thực chuỗi nối "|" cho 4 loại thông điệp
  - [ ] Handler querydr
  - [ ] Handler refund và vòng đời trạng thái hoàn
  - [ ] Giới hạn trùng yêu cầu trong 5 phút theo đồng hồ ảo
  - [ ] Chốt mã refund 02 và vòng đời 05/06/09 bằng sandbox thật

## VNPS-S-007: Kịch bản lỗi chủ động: IPN trễ, trùng, mất, sai thứ tự, sai số tiền, sai chữ ký
- from: VNPS-D-007
- derived_from: 976d2c74
- status: ready
- requirement: Mỗi hành vi có tên, tham số, phạm vi (toàn cục hoặc theo TxnRef) và mặc định "tắt". Hành vi được ghi vào log giao dịch để test biết kịch bản nào đã chạy. Khi bật nhiều hành vi, thứ tự áp dụng xác định và được ghi lại. Rà soát với mã 2026-10-04: simulator chưa có kịch bản đổi thứ tự IPN và Return (ipn_before_return, return_before_ipn) và chưa có bank_maintenance (mã 75 chỉ ép được qua force_response_code). Có thêm các khóa paid_after_expiry, refund_outcome, refund_delay_seconds (SCENARIO_KEYS).
- contract: POST /sim/control {scope:"global"|"txn", txnRef?, ipn_delay_seconds?, ipn_duplicate?, ipn_drop?, ipn_wrong_amount?, ipn_bad_signature?, force_response_code?, return_never?}. GET /sim/control trả cấu hình hiện hành.
- acceptance: Test cho từng hành vi: (a) trễ 20 phút ảo thì BSN đối soát bằng querydr vẫn ra kết quả đúng; (b) trùng 3 lần thì BSN không xử lý lặp; (c) mất thì BSN phát hiện và đối soát; (d) sai số tiền thì BSN giữ lại và cảnh báo; (e) sai chữ ký thì BSN từ chối và trả 97.
- tasks:
  - [ ] Mô hình cấu hình kịch bản và phạm vi
  - [ ] Áp dụng từng hành vi trong bộ gửi IPN và Return
  - [ ] Log kịch bản vào giao dịch
  - [ ] Bộ test kịch bản chạy với adapter BSN

## VNPS-S-008: Kiểm thử đối chiếu (conformance) với sandbox VNPay thật để chốt độ sát
- from: VNPS-D-008
- derived_from: 32189209
- status: ready
- requirement: Bộ kịch bản gồm tối thiểu: thanh toán thành công bằng thẻ NCB; mỗi thẻ lỗi trong bảng; hủy; hết hạn; chữ ký sai; tham số thiếu; querydr đơn thành công và đơn lạ; hoàn toàn phần và một phần; hoàn quá số tiền. Mỗi kịch bản ghi kết quả thật và kết quả simulator cạnh nhau.
- contract: Báo cáo conformance dạng bảng: kịch bản | kết quả thật | kết quả simulator | khớp? | ghi chú. Lưu ở docs/modules/vnpay-sim (qua 3-impl, mục lệch đã biết) và tệp mẫu ở tools/sim/vnpay/fixtures/.
- acceptance: Mọi dòng "verified=false" trong spec S-003 được chuyển thành true hoặc ghi lệch. Các điểm mâu thuẫn của tài liệu (refund 02, vòng đời hoàn tiền, url-encode, trang lỗi) có kết luận từ sandbox thật.
- tasks:
  - [ ] Đăng ký sandbox VNPay và thiết lập tunnel nhận IPN
  - [ ] Viết bộ kịch bản chạy được lên cả hai bên
  - [ ] Lưu tệp mẫu từ sandbox thật
  - [ ] Điền bảng lệch đã biết và sửa simulator

## VNPS-S-009: Sổ giả định VNPay: nguồn, mức bằng chứng, kết luận đối chiếu docs
- from: VNPS-D-009
- derived_from: c1e0848c
- status: ready
- requirement: Sổ giả định VNPS-D-009 là nguồn sự thật về mức bằng chứng. Simulator và adapter chỉ được coi một hành vi là đã xác minh khi dòng tương ứng ở mức live hoặc golden.
- contract: Mỗi dòng sổ: mã A#, nhóm (format|semantic), nguồn, mức bằng chứng, verdict docs, hậu quả nếu sai.
- acceptance: Khi có sandbox thật, mỗi dòng unverified được chuyển trạng thái hoặc ghi lệch trong 3-impl.
- tasks: Xác minh 5 điểm cần merchant thật khi có sandbox,Cập nhật sổ sau mỗi lần đối chiếu

## VNPS-S-010: VNPay: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- from: VNPS-D-010
- derived_from: 123fc36b
- status: ready
- requirement: Adapter VNPay khai báo cờ năng lực cho Hub (hardExpiry, cancellable, queryable, refundable, refundAsync) kèm mức bằng chứng từ VNPS-D-009. Simulator có kịch bản cho từng câu trả lời chưa xác minh. Rà soát với mã 2026-10-04: adapter khai methods gồm qr nhưng simulator không mô phỏng QR; mọi khai báo theo docs, chưa kiểm với merchant VNPay thật.
- contract: Cờ năng lực là dữ liệu cấu hình của adapter, không nằm trong lõi Hub.
- acceptance: Mỗi cờ có nguồn và mức bằng chứng; cờ unverified có kịch bản simulator tương ứng.
- tasks: Định nghĩa cờ năng lực của adapter VNPay,Kịch bản simulator cho thanh toán muộn, IPN mất, hoàn tiền bất đồng bộ, kết quả mâu thuẫn

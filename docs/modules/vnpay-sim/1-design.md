---
module: vnpay-sim
prefix: VNPS
---
# vnpay-sim - Design (tầng 1)

Vì sao và cái gì: quyết định nghiệp vụ và kỹ thuật của module. Chỉ ghi qua tool `design_record` / `design_update`.

## VNPS-D-001: Kiến trúc simulator VNPay: service Node không phụ thuộc, bám hợp đồng của cổng
- date: 2026-10-02
- status: accepted
- decision:
  Simulator VNPay là một service Node.js không dùng thư viện ngoài, đặt ở tools/sim/vnpay/. Chạy các route giống cổng thật: GET /paymentv2/vpcpay.html (trang thanh toán), POST /merchant_webapi/api/transaction (querydr, refund). Có route điều khiển riêng /sim/* cho kịch bản và đồng hồ ảo. Trạng thái giao dịch lưu trong bộ nhớ, tùy chọn ghi ra file JSON.
  Cấu hình bằng biến môi trường: SIM_PORT, SIM_TMN_CODE, SIM_HASH_SECRET, SIM_IPN_URL (VNPay không nhận IPN URL trong request; merchant đăng ký URL này với VNPay), SIM_PUBLIC_BASE_URL.
- rationale: Adapter VNPay của BSN chỉ cần đổi base URL, TmnCode và HashSecret để chuyển giữa simulator và sandbox thật. Không phụ thuộc thư viện để dễ chạy trong CI. Đồng hồ ảo cần để test hết hạn thanh toán và lịch retry IPN mà không phải chờ thật.
- impacts: Mọi spec VNPS khác dựa trên khung này. Tài liệu nguồn: https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html ; https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr&refund.html ; https://sandbox.vnpayment.vn/apis/docs/bang-ma-loi/ ; https://sandbox.vnpayment.vn/apis/vnpay-demo/

## VNPS-D-002: Tạo URL thanh toán: kiểm tra tham số và chữ ký vnp_SecureHash HMAC-SHA512
- date: 2026-10-02
- status: accepted
- decision: Simulator kiểm tra yêu cầu thanh toán theo hai tầng như cổng thật (probe live): tầng 1 kiểm tra định dạng và giá trị tham số, trả lỗi 03 (thiếu hoặc sai kiểu), 72 (ngoài khoảng hoặc sai giá trị), 32 (số tiền không hợp lệ), 15 (hết hạn), 21 (tiền tệ lạ); tầng 2 tra TmnCode rồi kiểm chữ ký. Chữ ký: sắp xếp tăng dần theo tên tham số (loại vnp_SecureHash, vnp_SecureHashType), BỎ giá trị rỗng, urlencode kiểu PHP (khoảng trắng thành +) cho cả khóa và giá trị, nối bằng "&", HMAC-SHA512 với HashSecret, so sánh hex không phân biệt hoa thường. vnp_ExpireDate chấp nhận thiếu (không bị chặn ở tầng 1). Trang lỗi hiển thị mã theo bảng Error.html.
- rationale: Chữ ký và định dạng là phần adapter BSN phụ thuộc trực tiếp. Quy tắc ký đã có sample chính thức và golden vector xác nhận; thứ tự kiểm tra lấy từ probe thật.
- impacts: Còn unverified (cần merchant thật): kết quả khi chữ ký sai, TxnRef trùng. Đây là nhóm config, không chặn. Xem sổ giả định VNPS-D-009 (A1, A4). Nguồn: https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html

## VNPS-D-003: Trang thanh toán và kết quả theo thẻ test, ánh xạ sang vnp_ResponseCode và vnp_TransactionStatus
- date: 2026-10-02
- status: accepted
- decision: Simulator hiển thị trang thanh toán đơn giản cho phép nhập thẻ test. Kết quả quyết định theo số thẻ: thẻ NCB 9704198526191432198 thành công; 9704195798459170488 không đủ số dư (51); 9704192181368742 thẻ chưa kích hoạt; 9704193370791314 thẻ bị khóa (12); 9704194841945513 thẻ hết hạn. Chủ thẻ NGUYEN VAN A. Thẻ quốc tế (VISA, MasterCard, JCB, có hoặc không 3DS) mô phỏng theo bảng riêng. Khách có thể bấm hủy (24). Đơn quá vnp_ExpireDate thì trả 11.
- rationale: Đây là dữ liệu test chính thức của VNPay; mô phỏng đúng giúp BSN gặp đủ nhóm lỗi thật. Trang demo ghi rõ chỉ các thẻ trong danh sách mới dùng được.
- impacts: Hai bộ mã lỗi tồn tại (A6 trong VNPS-D-009): kết quả thanh toán dùng bảng vnp_ResponseCode (00, 07, 09, 10, 11, 12, 13, 24, 51, 65, 75, 79, 99), không dùng bảng Error.html. Ánh xạ từng thẻ lỗi ngoài thẻ thành công, thiếu tiền (51) và hủy (24) là ngoài phạm vi (không đổi thiết kế Hub); cấu hình được trong cards.json. Nguồn: https://sandbox.vnpayment.vn/apis/vnpay-demo/ ; https://sandbox.vnpayment.vn/apis/docs/bang-ma-loi/

## VNPS-D-004: Return URL: chuyển hướng trình duyệt kèm tham số và chữ ký, không dùng để cập nhật đơn
- date: 2026-10-02
- status: accepted
- decision: Sau khi giao dịch kết thúc, simulator chuyển hướng trình duyệt bằng GET tới vnp_ReturnUrl với các tham số kết quả (vnp_TmnCode, vnp_Amount, vnp_BankCode, vnp_BankTranNo, vnp_CardType, vnp_PayDate, vnp_OrderInfo, vnp_TransactionNo, vnp_ResponseCode, vnp_TransactionStatus, vnp_TxnRef) và vnp_SecureHash tính cùng thuật toán như yêu cầu.
- rationale: Tài liệu quy định Return URL chỉ để kiểm tra checksum và hiển thị cho khách, không được cập nhật trạng thái; BSN phải dựa vào IPN. Simulator cần tái hiện đúng để lộ lỗi nếu BSN sai chỗ này.
- impacts: BSN phải xử lý được trường hợp khách không quay lại Return URL. Nguồn: https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html

## VNPS-D-005: IPN: GET server-to-server, phản hồi RspCode, retry 10 lần cách 5 phút
- date: 2026-10-02
- status: accepted
- decision: Simulator gọi SIM_IPN_URL với cùng tham số kết quả như Return URL. Phương thức GET hoặc POST cấu hình được (VNPay cấu hình theo từng terminal). Đọc phản hồi JSON {RspCode, Message}. RspCode 00 hoặc 02 thì kết thúc. RspCode 01, 04, 97, 99 (hoặc không phải JSON, lỗi mạng, quá thời gian) thì thử lại. Số lần retry, khoảng cách và timeout là THAM SỐ cấu hình (mặc định theo docs: 10 lần, 5 phút, theo đồng hồ ảo), không phải sự thật đã kiểm chứng. IPN URL thật yêu cầu HTTPS; simulator cho phép HTTP cục bộ nhưng ghi cảnh báo.
- rationale: Đây là kênh quyết định trạng thái đơn. Lịch retry quyết định BSN phải idempotent và có cửa sổ đối soát.
- impacts: Retry, timeout, hành vi với phản hồi lạ đều unverified (A8, A9 trong VNPS-D-009); Hub phải đúng với mọi giá trị. Simulator phải mô phỏng được IPN trùng, trễ, mất hẳn (A10, A12). Nguồn: https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html

## VNPS-D-006: API querydr (truy vấn giao dịch) và refund (hoàn tiền) với chữ ký dạng nối bằng "|"
- date: 2026-10-02
- status: accepted
- decision: POST /merchant_webapi/api/transaction với JSON, hai lệnh querydr và refund. Chữ ký của request và response là HMAC-SHA512 trên chuỗi nối các trường theo đúng thứ tự tài liệu, ngăn cách bằng "|". Hoàn tiền: vnp_TransactionType 02 (toàn phần) hoặc 03 (một phần); số tiền hoàn không vượt số tiền gốc. Hoàn tiền tạo giao dịch mới với TransactionStatus 05 (đang xử lý) rồi 06 (đã gửi ngân hàng), kết quả cuối có thể bị từ chối (09).
- rationale: querydr là công cụ đối soát khi IPN không về; refund là đường hoàn tiền của BSN. Cả hai phải đúng chữ ký và đúng bảng mã lỗi.
- impacts: Tài liệu MÂU THUẪN ở mã refund 02: một chỗ ghi "mã kết nối không hợp lệ", chỗ khác ghi "số tiền hoàn vượt số tiền giao dịch". Chưa rõ vòng đời 05/06/09 của hoàn tiền (kết quả cuối được thông báo thế nào, có IPN riêng không). Phải chốt bằng sandbox thật. Nguồn: https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr&refund.html ; https://sandbox.vnpayment.vn/apis/docs/bang-ma-loi/

## VNPS-D-007: Kịch bản lỗi chủ động: IPN trễ, trùng, mất, sai thứ tự, sai số tiền, sai chữ ký
- date: 2026-10-07
- status: accepted
- decision: Route /sim/control cho phép đặt, theo từng vnp_TxnRef hoặc toàn cục, các hành vi: ipn_delay_seconds, ipn_duplicate (gửi N lần), ipn_drop (không gửi), ipn_before_return / return_before_ipn, ipn_wrong_amount, ipn_bad_signature, force_response_code (ép mã kết quả), bank_maintenance (75), return_never (khách đóng trình duyệt). Các hành vi này chỉ có ở simulator; cổng thật không cung cấp.
- rationale: Các ca callback mất, trùng, muộn là trọng tâm của tài liệu tham chiếu. Sandbox thật không tái hiện được chủ động, nên đây là giá trị chính của simulator.
- impacts: Không thuộc hành vi thật của VNPay; phải tách rõ trong code và tài liệu để không bị nhầm là hợp đồng của cổng.

## VNPS-D-008: Kiểm thử đối chiếu (conformance) với sandbox VNPay thật để chốt độ sát
- date: 2026-10-02
- status: accepted
- decision: Lập một bộ kịch bản conformance chạy giống hệt lên sandbox thật (sandbox.vnpayment.vn, đăng ký tại /devreg) và lên simulator, so sánh: dạng request/response, chữ ký, mã kết quả, thứ tự và nội dung IPN. Mọi khác biệt ghi vào bảng "lệch đã biết" trong 3-impl, kèm quyết định sửa simulator hay chấp nhận. Phản hồi thật được lưu thành tệp mẫu (golden files) để phát lại.
- rationale: Chỉ dựa vào tài liệu thì không biết simulator có sát hay không; tài liệu còn mâu thuẫn và thiếu ca biên. Đối chiếu là cách duy nhất đo độ sát.
- impacts: Cần đăng ký tài khoản sandbox VNPay (tự đăng ký theo tài liệu) và một địa chỉ IPN công khai khi test trên sandbox thật (ví dụ tunnel). Danh sách CHƯA XÁC MINH từ các spec VNPS-S-002 đến S-007 là đầu vào của bộ kịch bản này.

## VNPS-D-009: Sổ giả định VNPay: nguồn, mức bằng chứng, kết luận đối chiếu docs
- date: 2026-10-02
- status: accepted
- decision:
  Mức bằng chứng: live = quan sát sandbox thật bằng probe credential giả; golden = vector tính độc lập bằng ngôn ngữ khác; sample = code mẫu chính thức; docs = chỉ tài liệu; inferred = chỉ code client; unverified = không nguồn nào.
  Đối chiếu: agrees / conflicts / docs-silent / docs-only (xem skill payment-gateway-research mục 3a).
  NHÓM FORMAT (adapter, theo bằng chứng):
   A1 Ký: sắp xếp khóa, urlencode kiểu PHP (khoảng trắng thành +), bỏ giá trị rỗng, HMAC-SHA512 hex. Bằng chứng: sample (php/nodejs/jsp/python) + golden (settlebook) + 4 client. agrees.
   A2 vnp_Amount = VND x 100; thời gian yyyyMMddHHmmss GMT+7. sample + docs. agrees.
   A3 Thành công = vnp_ResponseCode 00 VÀ vnp_TransactionStatus 00. Docs nêu cả hai; client đều bắt cả hai (quyết định thiết kế chặt hơn tối thiểu). Chuyển thành quy tắc của Hub.
   A4 Kiểm tra tại /vpcpay.html (probe live): thiếu hoặc sai kiểu tham số trả lỗi 03; ngoài khoảng hoặc sai giá trị 72; số tiền 0 hoặc âm 32; hết hạn 15; tiền tệ lạ 21. Kiểm tra định dạng chạy TRƯỚC khi tra merchant, nên các tham số sau bước tra TmnCode không phân biệt được bằng credential giả. vnp_ExpireDate: thiếu thì không bị chặn ở bước này (ghi nhận, chưa chắc tùy chọn khi merchant thật). vnp_CreateDate sai định dạng vẫn qua. Nhóm config, chỉ dùng cho trang lỗi của simulator.
   A5 API querydr/refund (probe live): TmnCode lạ trả JSON 200 RspCode 02 "Website not found" TRƯỚC khi kiểm chữ ký; thiếu tham số hoặc Command lạ trả 99 kèm Message; JSON hỏng hoặc rỗng trả HTTP 500 HTML. Nhóm adapter.
   A6 Hai bảng mã lỗi khác nhau: Error.html (cũ, nội bộ: 05 thiếu tiền, 15 hết hạn, 24 hủy) và vnp_ResponseCode trong IPN/return (51, 11, 24, 75, 79, 13). conflicts. Phân xử: dùng bảng vnp_ResponseCode (sample + client) cho kết quả thanh toán; bảng Error.html chỉ cho trang lỗi lúc tạo URL.
  NHÓM NGỮ NGHĨA (lõi Hub, KHÔNG giả định lành tính):
   A7 IPN gửi bằng GET hay POST, giao thức và encoding: cấu hình theo từng terminal trong portal. docs-only. Simulator hỗ trợ cả hai, cấu hình được.
   A8 IPN retry 10 lần cách 5 phút: docs-only, không client nào quan sát. Tham số điều chỉnh, Hub phải đúng với mọi giá trị.
   A9 RspCode 00/02 dừng; 01/04/97/99 thử lại: docs; client giả định theo docs. Hành vi khi phản hồi không phải JSON hoặc HTTP khác 200: unverified.
   A10 IPN có thể đến trùng (cùng sự kiện giao lại): suy ra từ cơ chế retry; test của settlebook giả định, chưa ai quan sát. unverified, simulator phải gửi trùng.
   A11 Hai TxnRef khác nhau cho cùng một đơn đều có thể thu tiền (khách trả hai lần): chỉ settlebook giả định qua mock. unverified. Hub giữ ngoài đơn đã đóng thành "tiền đang giữ".
   A12 IPN không bao giờ đến (mất hẳn): docs nêu dừng sau số lần retry; không client nào xử lý; phải đối soát bằng querydr. unverified.
   A13 Tiền về sau khi đơn hết hạn hoặc bị bỏ: docs-silent, không code nào đụng tới. unverified. Xem PHUB-D-003 mục (1).
   A14 Hoàn tiền: sandbox hạn chế hoặc tắt (ghi chú client, không kèm bằng chứng cụ thể = inferred); vòng đời trạng thái hoàn và mã 02 mâu thuẫn giữa docs. conflicts + unverified. Xem PHUB-D-003 mục (3).
  NGOÀI PHẠM VI: kết quả theo từng thẻ test ngoài 3 nhóm (thành công, thiếu tiền, hủy), mã lỗi khi chữ ký sai ở merchant thật, số tiền tối thiểu, kiểm tra ReturnUrl và BankCode. Lý do: lỗi cấu hình hoặc con số điều chỉnh, không đổi thiết kế Hub.
  5 ĐIỂM CẦN MERCHANT THẬT (không chặn việc xây dựng): kết quả chữ ký sai; TxnRef trùng; chi tiết giao IPN (timeout, phản hồi lạ, trùng); dạng phản hồi querydr khi thành công; vòng đời hoàn tiền.
- rationale: Test mock của client chỉ phản ánh giả định của tác giả. Bóc tách từng giả định và đối chiếu docs cho thấy phần nào có bằng chứng thật (format) và phần nào chưa ai kiểm chứng (ngữ nghĩa), để simulator theo bằng chứng ở format và theo hướng bất lợi ở ngữ nghĩa.
- impacts: Cập nhật VNPS-D-002, D-003, D-005 theo sổ này; spec liên quan phải rà lại. Khi có sandbox thật, chuyển trạng thái từng dòng và ghi lệch vào 3-impl.

## VNPS-D-010: VNPay: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- date: 2026-10-02
- status: accepted
- decision:
  (1) Hết hạn cứng và tiền về muộn: vnp_ExpireDate có trong yêu cầu và VNPay trả 11 khi quá hạn trên trang thanh toán; tiền về sau hết hạn chưa có nguồn nào nói tới. Trạng thái: unverified (A13). Simulator cho phép kịch bản thanh toán thành công muộn.
  (2) Thông báo mất và đối soát: có API querydr; IPN retry rồi dừng theo docs; chưa ai quan sát IPN mất hẳn. Trạng thái: documented cho querydr, unverified cho IPN mất (A12). Simulator cho phép IPN bị bỏ.
  (3) Hoàn tiền: có API refund; sandbox hạn chế; vòng đời trạng thái và mã 02 mâu thuẫn trong docs. Trạng thái: conflicts + unverified (A14). Simulator mô hình hoàn tiền bất đồng bộ cấu hình được.
  (4) Kết quả mâu thuẫn trên một attempt và hai TxnRef cho một đơn: chỉ client giả định, chưa ai quan sát (A10, A11). Trạng thái: unverified. Simulator có kịch bản IPN trùng và kết quả mâu thuẫn.
  Cờ năng lực dự kiến cho adapter VNPay: hardExpiry=chưa rõ, cancellable=không có API hủy, queryable=true, refundable=true, refundAsync=chưa rõ.
- rationale: Tách tri thức riêng của VNPay khỏi thiết kế Hub: Hub đặt câu hỏi, module này ghi câu trả lời của VNPay cùng mức bằng chứng.
- impacts: Liên kết: PHUB-D-003, sổ giả định VNPS-D-009. Khi có merchant thật, cập nhật từng dòng và cờ năng lực.

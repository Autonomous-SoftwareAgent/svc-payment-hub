---
module: onepay-sim
prefix: OPAY
---
# onepay-sim - Design (tầng 1)

Vì sao và cái gì: quyết định nghiệp vụ và kỹ thuật của module. Chỉ ghi qua tool `design_record` / `design_update`.

## OPAY-D-001: OnePAY: luồng thanh toán và cách tích hợp (chuyển hướng kiểu VPC, ký HMAC-SHA256)
- date: 2026-10-02
- status: accepted
- decision:
  Luồng: (1) merchant dựng URL GET /paygate/vpcpay.op với tham số vpc_* (vpc_Merchant, vpc_AccessCode, vpc_MerchTxnRef, vpc_OrderInfo, vpc_Amount = VND x 100, vpc_ReturnURL, vpc_Locale, vpc_Currency, vpc_TicketNo, tùy chọn vpc_CardList = INTERNATIONAL|DOMESTIC|QR|mã BIN) cùng vpc_SecureHash; (2) khách thanh toán trên trang OnePAY; (3) return redirect GET về vpc_ReturnURL; (4) IPN gọi GET server-to-server về URL của merchant với cùng tham số và cùng chữ ký như return, merchant phản hồi text "responsecode=1&desc=confirm-success"; (5) QueryDR là POST form tới /msp/api/v1/vpc/invoices/queries (có ký, kèm vpc_User, vpc_Password), trả vpc_DRExists (Y/N) và vpc_TxnResponseCode (0 thành công, 300 pending, 100 đang xử lý hoặc chưa trả, khác là không thành công).
  Chữ ký: mọi tham số vpc_* (và user_*) trừ vpc_SecureHash, bỏ giá trị rỗng, sắp theo tên ASCII, dạng k=v nối "&", giá trị gốc KHÔNG url-encode, HMAC-SHA256 với khóa hex giải mã thành byte, hash viết hoa. Title và AgainLink không vào chuỗi ký. Thành công theo docs: vpc_TxnResponseCode = 0 và hash đúng.
- rationale: Ghi lại cách tích hợp để viết adapter và simulator OnePAY. Công thức ký đã được xác nhận bằng vector hash độc lập và được cổng sandbox chấp nhận khi probe.
- impacts: Nguồn: tài liệu tích hợp OnePAY Ver 2.3 (15/07/2020, chỉ đọc được bản sao bên thứ ba; cổng developer chính thức và PDF đều 404 ngày 2026-10-02), 4 client open-source cũ (commit cuối 2016-2020), vector hash từ URL demo trong vn-payments, 36 request probe vào mtf.onepay.vn với credential test công khai trong tài liệu. Không có code mẫu chính thức. Hai thế hệ endpoint cùng tồn tại (cũ: onecomm-pay/vpc.op nội địa, vpcpay/vpcpay.op quốc tế; mới: paygate/vpcpay.op); simulator theo bản mới. Không phụ thuộc thiết kế Hub, xem PHUB-D-003.

## OPAY-D-002: Sổ giả định OnePAY: nguồn, mức bằng chứng, đối chiếu docs
- date: 2026-10-02
- status: accepted
- decision:
  Mức bằng chứng: live | golden | sample | docs | inferred | unverified. Verdict: agrees | conflicts | docs-silent | docs-only.
  FORMAT (adapter):
   A1 Ký HMAC-SHA256, khóa hex giải mã thành byte, hash hoa, giá trị gốc không encode. golden (3 vector từ URL demo, tính lại bằng Node) + live (được /paygate chấp nhận). agrees; docs-silent về giải mã hex.
   A2 Hash so không phân biệt hoa thường: live phía tạo (hash chữ thường vẫn tạo invoice). docs-silent.
   A3 Amount = VND x 100 số nguyên: live + docs. agrees.
   A4 Cổng quốc tế bỏ vpc_Currency khỏi chuỗi ký: chỉ vn-payments (sample cũ 2018). conflicts với docs 2.3; probe không phân xử được. Chốt khi có merchant thật.
   A5 Hai thế hệ endpoint (cũ tách nội địa/quốc tế, mới thống nhất theo vpc_CardList): live + docs. agrees.
   A6 Khi nhận phải verify mọi vpc_* trả về, số tham số thay đổi theo trạng thái và loại thẻ: docs + sample. agrees.
   A9 Ack IPN = "responsecode=1&desc=confirm-success": docs-only, không client nào quan sát.
   A13 QueryDR: POST form có ký, sai ký hoặc sai AccessCode trả 401, GET 405, JSON body 415: live.
   A14 QueryDR có kiểm vpc_User/vpc_Password không: docs nói bắt buộc, probe live trả 200 khi để trống hoặc giá trị giả. conflicts (chỉ merchant test; merchant thật chưa biết).
   A18 Sai chữ ký, merchant lạ, amount sửa đều cho cùng trang lỗi INVALID_INVOICE: live. Chỉ chẩn đoán được trên merchant thật (nhóm config).
   A23 vpc_TxnResponseCode = 7 bỏ qua kiểm hash (vn-payments): inferred, conflicts với docs. Hub luôn kiểm hash.
  SEMANTIC (lõi Hub, không giả định lành tính):
   A7 Thành công = code 0 và hash đúng: docs agrees; Hub nên kiểm thêm amount và MerchTxnRef.
   A8 Return và IPN cùng tham số, cùng chữ ký, không có trường đánh dấu kênh: docs-only. Hệ quả: không phân biệt được nguồn.
   A10 Số lần retry IPN, khoảng cách, timeout, hành vi khi ack sai, IP nguồn: unverified, docs-silent (tham số điều chỉnh).
   A11 IPN có thể mất hẳn hoặc trùng: inferred (module Magento ecomteck không cài IPN, chỉ return + cron QueryDR). unverified.
   A12 Thời gian tối đa 15 phút (quốc tế), 30 phút (nội địa), sau đó query ra kết quả cuối: docs-only; client lệch (Magento query sau 17 phút cho cả nội địa). Tiền về sau mốc này: unverified.
   A15 QueryDR: DRExists=N (kèm code 5) khi ref lạ; code 100 "Txn is processing" khi invoice đã tạo chưa trả: live. agrees với docs cho 100 và N.
   A16 "Mã 100 là thất bại, mã khác 0/300 là failed": omnipay-onepay (mock) và Magento ecomteck. inferred; conflicts với docs và với probe live (100 là đang xử lý). Hub phải map 100 và 300 thành pending.
   A17 Gửi lại cùng vpc_MerchTxnRef: cùng tham số thì trả lại đúng invoice cũ; đổi amount hoặc OrderInfo thì INVALID_INVOICE: live (chỉ invoice chưa trả). Sau khi đã trả tiền: unverified.
   A19 Hoàn tiền: không có API công khai; hoàn bằng công cụ trực tuyến (portal); khách nhận 7 ngày (ATM nội địa) đến 30 ngày (quốc tế): FAQ chính thức + thứ cấp. docs-silent về API.
   A20 Hủy/void trong ngày: không nguồn nào. unverified.
   A22 Hai kết quả khác nhau cho một attempt: không nguồn nào. unverified.
  NGOÀI PHẠM VI: bảng mã lỗi từng thẻ/ngân hàng và BIN (map về succeeded/failed/cancelled/expired là đủ); mobile SDK (webview mở URL); trả góp, QR, Apple Pay/Google Pay (không có tài liệu công khai); độ dài và ký tự đặc biệt của trường; số lần retry IPN chính xác.
  CẦN MERCHANT THẬT: (1) IPN: nơi đăng ký URL, retry, timeout, ack sai, IP nguồn, trùng; (2) tiền về sau mốc 15/30 phút; (3) cùng MerchTxnRef sau khi đã trả; (4) QueryDR production (kiểm user/password, phản hồi khi thành công, khi nào có 300); (5) hoàn tiền/hủy: API hay portal, đồng bộ hay không; (6) ký quốc tế có vpc_Currency không; (7) kết quả mâu thuẫn giữa return, IPN, query; (8) QR và trả góp.
- rationale: Bóc tách giả định từ client và đối chiếu docs và probe, theo skill payment-gateway-research. Client cũ có giả định sai (A16) mà docs và probe bác bỏ; nếu bê nguyên mock của họ thì Hub coi giao dịch đang xử lý là thất bại.
- impacts: Nguồn: tài liệu tích hợp OnePAY Ver 2.3 (15/07/2020, chỉ đọc được bản sao bên thứ ba; cổng developer chính thức và PDF đều 404 ngày 2026-10-02), 4 client open-source cũ (commit cuối 2016-2020), vector hash từ URL demo trong vn-payments, 36 request probe vào mtf.onepay.vn với credential test công khai trong tài liệu. Không có code mẫu chính thức. Báo cáo gốc do subagent nghiên cứu tổng hợp; các dòng live có file probe thô trong scratchpad (probes/probe1.json, probe2.json).

## OPAY-D-003: OnePAY: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- date: 2026-10-02
- status: accepted
- decision:
  (1) Hết hạn cứng và tiền về muộn: hết hạn nằm ở phía OnePAY, merchant không đặt được (không có tham số kiểu ExpireDate); tối đa 15 phút (quốc tế) và 30 phút (nội địa), sau đó query ra kết quả cuối. Hạn khác nhau theo sản phẩm. Tiền về sau mốc: unverified (A12).
  (2) Thông báo mất và đối soát: có QueryDR (live, ký hai chiều). IPN ack chỉ là text, không mang trạng thái; return và IPN trùng payload. IPN mất hay trùng: unverified (A10, A11). QueryDR là trọng tài.
  (3) Hoàn tiền: không có API công khai; hoàn qua portal thủ công, tiền về khách 7 đến 30 ngày; void trong ngày: unverified (A19, A20).
  (4) Kết quả mâu thuẫn: không nguồn nào nói tới; return và IPN cùng chữ ký nên cả hai đều xác thực được (A8, A22). unverified.
  Cờ năng lực dự kiến: hardExpiry=true theo (cổng, sản phẩm), 15/30 phút do OnePAY quyết định, chưa kiểm chứng tiền về muộn; cancellable=false; queryable=true; refundable=chưa rõ qua API (có qua portal thủ công); refundAsync=true.
  Điều adapter phải làm: map vpc_TxnResponseCode 100, 300 và DRExists=N thành pending hoặc chưa tồn tại, không thành failed; tạo lại URL cho cùng attempt phải cho cùng tham số (xác định); luôn kiểm hash.
- rationale: Tách tri thức riêng của OnePAY khỏi thiết kế Hub: Hub đặt câu hỏi, module này ghi câu trả lời cùng mức bằng chứng.
- impacts: Điểm khác biệt đáng chú ý: hardExpiry theo sản phẩm; hoàn tiền thủ công; ack IPN không mang trạng thái. Chỉ chuyển thành đề xuất cho Hub sau khi so với các cổng khác, không ghi thẳng vào payment-hub.

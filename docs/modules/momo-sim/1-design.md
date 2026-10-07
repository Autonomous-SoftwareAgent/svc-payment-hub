---
module: momo-sim
prefix: MOMO
---
# momo-sim - Design (tầng 1)

Vì sao và cái gì: quyết định nghiệp vụ và kỹ thuật của module. Chỉ ghi qua tool `design_record` / `design_update`.

## MOMO-D-001: MoMo: luồng thanh toán và cách tích hợp (API v2, gọi tạo đơn server-to-server, ký HMAC-SHA256)
- date: 2026-10-02
- status: accepted
- decision: Luồng captureWallet: (1) tạo: POST /v2/gateway/api/create (JSON), ký HMAC-SHA256 hex trên chuỗi k=v nối "&" theo thứ tự tên khóa (accessKey, amount, extraData, ipnUrl, orderId, orderInfo, partnerCode, redirectUrl, requestId, requestType); phản hồi resultCode, payUrl, deeplink, qrCodeUrl; resultCode 0 chỉ nghĩa là đã tạo, chưa thu tiền. (2) khách trả trên payUrl hoặc app; MoMo gọi IPN và redirect trình duyệt về redirectUrl. (3) IPN: POST JSON tới ipnUrl cho cả kết quả thành công và thất bại; merchant trả HTTP 204 trong 15 giây và kiểm chữ ký 13 trường (accessKey, amount, extraData, message, orderId, orderInfo, orderType, partnerCode, payType, requestId, responseTime, resultCode, transId), bộ trường khác request. (4) query: POST /v2/gateway/api/query (ký accessKey, orderId, partnerCode, requestId), trả resultCode, transId, payType, refundTrans[]. (5) refund: POST /v2/gateway/api/refund (orderId MỚI, transId của giao dịch gốc, hoàn từng phần được) và /v2/gateway/api/refund/query. (6) confirm/cancel chỉ cho luồng hai bước (autoCapture=false) khi giao dịch ở 9000. Adapter đọc resultCode, không đọc HTTP status: lỗi nghiệp vụ trả HTTP 200, lỗi định dạng, merchant, chữ ký trả HTTP 400.
- rationale: Ghi cách tích hợp để viết adapter và simulator MoMo. Khác VNPay và OnePAY ở chỗ có bước tạo đơn bằng API, payUrl nhận từ phản hồi.
- impacts: Nguồn: docs chính thức developers.momo.vn/v3 (tải thô 2026-10-02), sample chính thức momo-wallet (payment nodejs/python/..., java, php v1; commit cuối 2022), client nikki-erp (Go, commit 2026-09-19, test chỉ có vector chữ ký) và omnipay-momo (2023, mock ghi lại từ 2019), 28 request probe vào test-payment.momo.vn bằng credential sandbox công khai trong sample chính thức (4 đơn 1.000 VND không thanh toán). Phạm vi: ví MoMo Việt Nam. Probe không thấy IPN, hết hạn, tiền về muộn, refund thật. Sample PHP chính thức là v1 (errorCode, IPN dạng form), mâu thuẫn docs v2; chỉ dùng sample nodejs/java.

## MOMO-D-002: Sổ giả định MoMo: nguồn, mức bằng chứng, đối chiếu docs
- date: 2026-10-02
- status: accepted
- decision:
  Mức bằng chứng: live | golden | sample | docs | inferred | unverified. Verdict: agrees | conflicts | docs-silent | docs-only.
  FORMAT (adapter):
   A1 Ký HMAC-SHA256 hex, khóa theo chữ cái, bộ trường riêng từng thao tác: docs + sample + live (chữ ký sai trả 11007). agrees.
   A2 Vector IPN 13 trường của nikki-erp: tính lại bằng Python khớp, nhưng bộ trường cùng nguồn docs nên không độc lập. golden một phần.
   A11 Phản hồi có chữ ký: docs create có; live query không có chữ ký. conflicts nhẹ; client chỉ log, không kiểm.
   A12 Lỗi nghiệp vụ HTTP 200, lỗi định dạng/chữ ký HTTP 400 (mã 20, 13, 11007; 11007 không có trong bảng docs): live. docs-silent (docs idempotency nói 201/422).
   A13 amount 1.000 đến 50.000.000, nhận cả chuỗi lẫn số: live. agrees.
   A14 orderId regex: live cho phép ":" (docs hẹp hơn). conflicts nhỏ, nhóm config.
   A15 Sample PHP chính thức là v1: sample, conflicts với docs v2; endpoint v1 vẫn sống.
   A16 Thứ tự kiểm tra: định dạng (20), merchant (13), chữ ký (11007), khoảng tiền (22): live một phần. docs-silent.
   A21 Mock omnipay-momo 2019 (lỗi HTTP 200 mã 4): cũ, bỏ.
  SEMANTIC (lõi Hub, không giả định lành tính):
   A3 Create thành công không phải đã thu tiền: docs + sample. agrees.
   A4 IPN trả 204 trong 15 giây (docs); "MoMo retry nếu khác 204" chỉ là comment của nikki-erp: inferred. Docs im lặng về retry. unverified.
   A5 requestId là khóa idempotency, gửi lại trả kết quả cũ: docs nói vậy; probe live: gửi lại đúng request trả 41 "duplicated orderId" và KHÔNG trả lại payUrl; cùng requestId nhưng orderId mới thì thành công; cùng orderId requestId mới thì 41. CONFLICTS (chỉ thấy trên merchant sandbox dùng chung).
   A6 orderId duy nhất theo merchant, trùng trả 41: docs + live. agrees.
   A7 Query đơn lạ: docs định nghĩa 42 "không tìm thấy" và 1005 "url/QR hết hạn"; live trả 1005 "expired or did not exist" (HTTP 200). CONFLICTS: live gộp hết hạn với chưa từng tạo.
   A8 Query đơn chưa trả: 1000, transId 0: docs + live. agrees.
   A9 Chưa chốt gồm 1000, 7000, 7002, 9000 (authorized): docs-only. nikki-erp chỉ coi 1000 và 7000 là chưa chốt nên 7002 và 9000 bị coi đã chốt (lỗi tiềm ẩn).
   A10 Refund trả kết quả ngay, mã khác 0 là bị từ chối: nikki-erp (inferred); docs có 7002 và 1080 nên refund có thể đang chờ.
   A17 Khách thử lại sau thất bại trên cùng payUrl, nhiều IPN cho một đơn: unverified, docs-silent.
   A18 Tiền về sau khi hết hạn: unverified, docs-silent. Docs không nêu thời hạn đơn/payUrl, create không có tham số hết hạn; "mặc định 15 phút" chỉ thấy ở một kết quả tìm kiếm, không có trong trang docs đã tải.
   A19 Refund có thể thất bại muộn: docs-only (7002, refund/query có mã từng giao dịch hoàn).
  NGOÀI PHẠM VI: mã lỗi thẻ ATM/tín dụng, BNPL, token hóa, mini app, static QR, disbursement, remittance; items, deliveryInfo, userInfo, promotionInfo (dữ liệu hiển thị); RSA/AES của v1; bảng mã lỗi đầy đủ, onboarding M4B; số lần retry IPN chính xác.
  CẦN MERCHANT THẬT: (1) IPN thật: retry, số lần, khoảng cách, nhiều IPN cho một orderId, thứ tự so với redirect; (2) thời hạn payUrl và cấu hình được không; (3) tiền về sau khi query đã trả 1005; (4) refund thật: đồng bộ hay chờ (7002), thất bại muộn, sandbox có chạy refund không; (5) luồng hai bước và thời hạn tự hủy (1003); (6) requestId trên merchant thật; (7) phản hồi query/refund có ký trên production; (8) khách thử lại trên cùng payUrl; (9) quyền dùng qrCodeUrl, deeplink, miniapp.
- rationale: Bóc tách giả định từ client và docs rồi đối chiếu probe. Hai phát hiện quan trọng: docs hứa idempotency theo requestId nhưng live không ép, và client duy nhất còn bảo trì có lỗi tiềm ẩn ở các trạng thái 7002, 9000.
- impacts: Nguồn: docs chính thức developers.momo.vn/v3 (tải thô 2026-10-02), sample chính thức momo-wallet (payment nodejs/python/..., java, php v1; commit cuối 2022), client nikki-erp (Go, commit 2026-09-19, test chỉ có vector chữ ký) và omnipay-momo (2023, mock ghi lại từ 2019), 28 request probe vào test-payment.momo.vn bằng credential sandbox công khai trong sample chính thức (4 đơn 1.000 VND không thanh toán). Phạm vi: ví MoMo Việt Nam. Probe không thấy IPN, hết hạn, tiền về muộn, refund thật. Các dòng live có file probe thô trong scratchpad (momo/probe/results.json).

## MOMO-D-003: MoMo: câu trả lời cho hợp đồng năng lực của Hub (PHUB-D-003)
- date: 2026-10-02
- status: accepted
- decision:
  (1) Hết hạn cứng và tiền về muộn: docs không nêu thời hạn đơn hay payUrl, create không có tham số hết hạn, không có API hủy đơn captureWallet chưa trả. Live: mã 1005 gộp "hết hạn" với "chưa từng tồn tại" nên không dùng làm bằng chứng hết hạn chắc chắn. unverified (A7, A18).
  (2) Thông báo mất và đối soát: có query (live xác nhận định dạng; chưa trả là 1000). IPN trả 204 trong 15 giây; retry docs không nêu. IPN mất hay trùng: unverified (A4, A17).
  (3) Hoàn tiền: có refund và refund/query. Có 7002 và 1080 (thử lại sau khoảng 1 giờ), nên có thể bất đồng bộ và thất bại muộn. docs-only (A10, A19). Ràng buộc: orderId refund mới, tối thiểu 1.000 VND, có hoàn từng phần.
  (4) Kết quả mâu thuẫn: docs không nói; có thể xảy ra nếu khách thử lại trên cùng payUrl hoặc IPN lệch query. unverified (A17).
  Cờ năng lực dự kiến: hardExpiry=chưa rõ (coi false); cancellable=false cho luồng một bước, true chỉ cho luồng hai bước (autoCapture=false, trạng thái 9000); queryable=true; refundable=true; refundAsync=có thể (coi true).
  Điều adapter phải làm: khóa idempotency là orderId (mã tham chiếu attempt), không dựa requestId; create timeout là unknown thật vì gọi lại cùng orderId bị 41 và không lấy lại payUrl, nên query rồi quyết hoặc tạo attempt mới với orderId mới; coi 1000, 7000, 7002, 9000 là chưa chốt; 9000 (authorized) cần ánh xạ về pending hoặc một sự kiện chuẩn riêng; đọc resultCode, không đọc HTTP status.
- rationale: Tách tri thức riêng của MoMo khỏi thiết kế Hub: Hub đặt câu hỏi, module này ghi câu trả lời cùng mức bằng chứng.
- impacts: Điểm khác VNPay/OnePAY đáng chú ý: tạo đơn bằng API (create timeout làm mất payUrl); idempotency ở orderId chứ không ở requestId; có trạng thái authorized (9000) và hủy/capture hai bước. Chuyển thành đề xuất cho Hub sau khi so ba cổng, không ghi thẳng vào payment-hub.

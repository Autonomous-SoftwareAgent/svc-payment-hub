# Nghiên cứu một cổng thanh toán (cho Payment Hub)

Đọc tệp này khi nghiên cứu, đối chiếu hoặc mô phỏng một cổng thanh toán mới (VNPay, MoMo, ZaloPay, SePay, Stripe, PayPal...), khi viết đặc tả adapter hay simulator, hoặc khi phải quyết định điều gì còn cần kiểm với cổng thật. Mục tiêu: hiểu đủ cổng để Hub đúng về tiền, mà không chìm trong chi tiết riêng của từng cổng.

Nguồn gốc: nội dung chuyển từ skill dùng chung `payment-gateway-research` (tiếng Anh) về đây theo quyết định S-032 (2026-10-07): kiến thức riêng một dịch vụ nằm trong tài liệu của dịch vụ đó. Chỗ đã sửa hay thêm so với bản cũ ghi ở mục cuối "Khác với bản skill cũ". Đường dẫn trong tệp tính từ thư mục dịch vụ `system_service/payment-hub/`.

## Mục tiêu trước hết
Hub điều phối nhiều cổng qua các adapter cô lập. Bài toán thật của nó là **tiền và đơn hàng phải khớp nhau khi thông báo không đáng tin** (trùng, muộn, mất, đảo thứ tự). Nghiên cứu cổng chỉ để phục vụ điều đó. Trước khi đào bất kỳ sự thật nào, hỏi: *câu trả lời có làm đổi mô hình chuẩn, định tuyến và chuyển cổng, hay đối soát không?* Nếu không, dừng.

## 1. Chia mọi câu hỏi còn mở vào một trong bốn nhóm
| Nhóm | Cách nhận ra | Làm gì | Ví dụ (VNPay) |
|---|---|---|---|
| **Thiết kế lõi** | Đổi mô hình chuẩn hoặc luật của Hub | Nghiên cứu, ghi thành một khả năng (capability) hoặc một giả định, kiểm khi có thể | Tiền có thể về sau khi hết hạn, hay sau khi ta bỏ attempt không? Attempt có thể ở trạng thái "chưa rõ" lâu không? Hoàn tiền có bất đồng bộ và có thể thất bại muộn không? Một attempt có thể có hai kết quả khác nhau không? |
| **Adapter** | Định dạng, mã, chữ ký | Lấy từ mã và tài liệu, cô lập trong adapter, đọc dữ liệu thật chặt, kiểm ở lần nối thật đầu tiên | Tên trường, hình dạng phản hồi, bảng mã |
| **Cấu hình / lúc dựng** | Lỗi cài đặt, bắt được ngay lần chạy đầu | Bỏ qua | Mã sai chữ ký, kiểm tham số, miền của ReturnUrl, BankCode, số tiền tối thiểu |
| **Tinh chỉnh** | Chỉ là một con số | Biến thành tham số của simulator và của việc đối soát | Số lần và khoảng cách giao lại IPN, timeout, địa chỉ IP nguồn |

Hub phải đúng với **mọi** giá trị của nhóm tinh chỉnh, nên không cần biết con số chính xác.

## 2. Nguồn, theo thứ tự tin cậy
1. **Hành vi thật ở sandbox** (tài khoản của mình, hoặc thăm dò bằng thông tin giả, xem mục 4).
2. **Mã mẫu và dữ liệu thử chính thức**: tải gói về và đọc mã.
3. **Tài liệu và PDF đặc tả chính thức**: kiểm phiên bản và ngày; chúng hay mâu thuẫn nhau và với mã mẫu. Tải bản thô (`pdftotext -enc UTF-8 -layout`) thay vì tin công cụ đọc trang có tóm tắt: nó làm rơi chi tiết và có thể bịa ra mâu thuẫn.
4. **Thư viện khách mã nguồn mở còn được bảo trì**: xem ngày commit cuối; bỏ cái đã bỏ hoang.
5. **Bài đăng cộng đồng và issue**: chỉ để gợi ý.
Ưu tiên sự thật từ mã hơn là hỏi người; chỉ hỏi người những điều chỉ có ở môi trường thật.

## 3. Đọc thư viện khách mã nguồn mở
- Rút ra: hàm ký và mã hóa (chuỗi chuẩn hóa chính xác), các endpoint, bảng mã phản hồi, trường nào tùy chọn, các hạn chế nêu trong issue (ví dụ "sandbox tắt hoàn tiền").
- Ghi chú nói "đã kiểm thật" chỉ tính khi dẫn bằng chứng cụ thể (mã, thời gian, trang quan sát được). Bảng mã mơ hồ hoặc do AI viết mà mâu thuẫn với bản chính thức thì bỏ. Dòng chú thích kiểu "đã đối chiếu với tài liệu chính thức" nghĩa là *tác giả đã đọc tài liệu*, không phải cổng đã được quan sát.
- Grep các từ: `verified`, `observed`, `sandbox`, `retry`, `gotcha`, `known issue`.
- Clone nông vào thư mục nháp, không bao giờ clone vào repo.

### 3a. Tách giả định ra, rồi đối chiếu với tài liệu
Gắn nhãn một test là "giả định" thôi chưa đủ. Tách từng giả định ra và rà từng cái với tài liệu.

1. **Rút ra** mọi giả định từ test, mock và chú thích trong mã. Với mỗi test, hỏi bốn câu:
   - Cái gì bị mock, mock trả gì? (niềm tin của tác giả về phản hồi của cổng)
   - Khẳng định điều gì? (niềm tin của tác giả về việc mã của ta phải làm)
   - Đầu vào có hình dạng nào? (niềm tin về điều cổng gửi)
   - Điều gì KHÔNG được kiểm? (hành vi tác giả chưa nghĩ tới)
2. **Phân loại** từng giả định: *sự thật về cổng* (cổng làm X), *lựa chọn thiết kế* (ta quyết định X, ví dụ "đòi cả hai mã đều là 00", chặt hơn tài liệu có chủ ý), hay *tiện cho test* (đơn giản hóa dữ liệu thử). Chỉ sự thật về cổng mới cần kiểm. Lựa chọn thiết kế là đầu vào cho buổi rà thiết kế của chính ta.
3. **Đối chiếu với tài liệu.** Mỗi sự thật về cổng nhận một kết luận:
   - `agrees` (khớp): tài liệu nói giống vậy (vẫn chỉ là `documented`).
   - `conflicts` (mâu thuẫn): tài liệu và mã khác nhau. Ghi cả hai, tìm trọng tài (mã mẫu chính thức, thăm dò, vector chuẩn), không bao giờ lặng lẽ chọn một bên.
   - `docs-silent` (tài liệu im): chỉ mã nói vậy. Coi là `inferred`, mức yếu nhất.
   - `docs-only` (chỉ tài liệu): tài liệu nói và không mã nào chạy qua. Chưa ai chạy; đừng tin.
4. **Cân bằng chứng.** Vector chuẩn tính độc lập bằng ngôn ngữ khác là mạnh. Phản hồi mock là niềm tin của tác giả. Hai dự án chép nhau chỉ tính là một nguồn. Mã khớp tài liệu chưa phải bằng chứng thật khi tác giả mã chỉ đọc cùng tài liệu đó.
5. **Ghi** thành bảng, rồi quyết từng dòng: sửa adapter, câu hỏi thiết kế lõi, hay bỏ qua (dùng bốn nhóm ở mục 1).

| Giả định | Ở đâu (tệp/test) | Loại | Tài liệu nói | Kết luận | Mức bằng chứng | Có ảnh hưởng Hub không? |
|---|---|---|---|---|---|---|

Ví dụ từ một thư viện VNPay: test ký của nó dùng vector chuẩn tính bằng Python với `quote_plus` (mạnh: mã hóa và thứ tự trường là sự thật về định dạng, thuộc nhóm adapter). Cũng thư viện đó coi "thành công = ResponseCode 00 VÀ TransactionStatus 00" (lựa chọn thiết kế, chặt hơn tài liệu, nên thuộc luật riêng của Hub) và khẳng định "thử lại ở 01/04/97/99" (docs-only: không test nào của nó từng quan sát một lần thử lại, nên vẫn chỉ là `documented`, một mục tinh chỉnh).

## 4. Thăm dò an toàn bằng thông tin giả
Endpoint công khai vẫn trả lỗi dù không có tài khoản, và *cách* chúng báo lỗi là hành vi thật (thứ tự kiểm, dạng lỗi, mã trạng thái, kiểm gì trước khi tra merchant).
- Được phép: vài chục yêu cầu, mã merchant giả, cách nhau ít nhất 250 ms, dừng khi gặp 429 hoặc bị chặn. Lưu đầu ra thô vào thư mục nháp.
- Không bao giờ: thông tin đăng nhập của người khác, dò mã hàng loạt, dữ liệu thẻ thật, tạo tải, bất cứ thứ gì có thể tạo ra một giao dịch thật.
- Thăm dò không cho thấy được hành vi phía sau một merchant hợp lệ (kết quả chữ ký, trùng lặp, thông báo). Đừng giả vờ là nó cho thấy.
- Trên Windows, gọi `curl` từ Node với `-o` đặt là `os.devNull`, không phải `/dev/null`.

## 5. Ghi lại, đừng chỉ nói
- Giữ một **sổ giả định**: phát biểu, nguồn, trạng thái (`verified-live`, `documented`, `inferred`, `unverified`), hậu quả nếu sai.
- Tách **giả định về định dạng** (rẻ: sửa adapter) khỏi **giả định về ngữ nghĩa** (đắt: kiến trúc). Định dạng theo bằng chứng. Ngữ nghĩa không bao giờ được giả định là vô hại; phải thử tải xấu.
- Ghi phát hiện qua công cụ `bsn-docs` (`design_record`, `spec_fill`), liệt kê **điều không làm kèm lý do**, và cập nhật `docs/agent/STATUS.md`.

## 6. Luật dựng để việc nghiên cứu là đủ
- Tách thiết kế của Hub khỏi từng module cổng: thiết kế Hub trung lập với cổng (nó hỏi bằng câu hỏi về khả năng và đặt mặc định thận trọng); mỗi module cổng ghi câu trả lời của riêng nó kèm mức bằng chứng. Không bao giờ ghi phát hiện của một cổng vào thiết kế Hub như một luật.
- Mỗi cổng một adapter; lõi chỉ thấy sự kiện chuẩn (succeeded, failed, cancelled, expired, unknown, các trạng thái hoàn tiền).
- Kết quả chưa rõ hoặc chưa đủ nghĩa là **chờ rồi đối soát**, không bao giờ là thất bại. Trạng thái cuối bất biến.
- Chỉ chuyển cổng khi attempt trước chắc chắn không thể nhận tiền. Mỗi attempt thuộc về một cổng và một mã tham chiếu.
- Simulator: định dạng theo bằng chứng; ngữ nghĩa theo hướng xấu và cấu hình được (trễ, trùng, mất, đảo thứ tự, sai số tiền, kết quả mâu thuẫn, phía ta hỏng giữa chừng).
- Chỉ tin phần trừu tượng sau khi có ít nhất hai adapter khác kiểu (ví dụ chuyển hướng cộng callback, và chuyển khoản do khách tự khởi động).

## 7. Quy tắc dừng và các kiểu làm sai
Dừng nghiên cứu khi câu hỏi kế tiếp rơi vào nhóm Adapter, Cấu hình hay Tinh chỉnh; lúc đó hãy dựng.
Tránh: đuổi theo mọi mã lỗi; chép nguyên bảng của tài liệu; coi test mock là sự thật; chờ đăng ký sandbox mới làm; để một cổng định hình mô hình chuẩn; để bí mật trong ghi chú hay chat.

## Ví dụ: VNPay
Có ảnh hưởng: xử lý hạn cứng và trạng thái chưa rõ, hoàn tiền bất đồng bộ (sandbox hạn chế hoàn tiền), ngữ nghĩa giao IPN. Không ảnh hưởng: mã lỗi sai chữ ký, mã kết quả theo từng loại thẻ, số tiền tối thiểu, luật `TxnRef`. Kết quả thăm dò (thứ tự kiểm, trang lỗi, dạng lỗi của API) và phát hiện nằm ở `docs/modules/vnpay-sim/`.

## Thêm từ Stripe và PayPal (2026-10-06 và 2026-10-07)
Phần này KHÔNG có trong bản skill cũ; viết từ việc đã làm ở repo này.
- **Mỗi cổng một tệp nghiên cứu** ở `docs/agent/`: [stripe-research.md](stripe-research.md), [paypal-research.md](paypal-research.md); quyết định thiết kế ở module `stripe-sim` (STRP-D) và `paypal-sim` (PYPL-D). Đầu mỗi tệp ghi rõ mức bằng chứng cao nhất đạt được và rằng chưa gọi cổng thật lần nào.
- **Ghi cả công cụ đã dùng để đọc nguồn.** PayPal được đọc qua công cụ đọc trang có tóm tắt, đúng loại mục 2 cảnh báo; nên mọi dòng ở mức tối đa `documented`, và tên trường cùng mã lỗi phải đối chiếu lại bản OpenAPI khi có sandbox. Tài liệu tóm tắt còn tự mâu thuẫn một chỗ (TWD): ghi cả hai vế, mặc định không bật.
- **Hỏi sớm: ai làm bước chuyển tiền?** Stripe tự thu khi khách trả. PayPal thì khách duyệt xong tiền chưa chuyển; adapter phải thu giúp Hub. Hệ quả cần quyết ngay từ thiết kế: kênh nào được phép thu (kênh có chữ ký hay không), `query()` có được thu không (không: nó còn dùng để hỏi lại attempt Hub đã đóng), thất bại an toàn khi mất cả hai kênh là gì.
- **Mã giao dịch phải ổn định giữa các kênh và các giai đoạn.** Lõi so mã giữa `authorized` và `succeeded`; nếu cổng đổi mã giữa hai giai đoạn (PayPal: khoản giữ khác capture) thì adapter chọn một mã ổn định (mã order) và tự tra mã thật khi cần.
- **Kiểm danh sách loại tiền của cổng với bảng ISO của lõi.** PayPal không hỗ trợ VND: chặn ở cả `capabilities().currencies` lẫn `createPayment`.
- **Không đưa khóa riêng vào repo, kể cả khóa của simulator.** Simulator ký webhook bằng khóa sinh lúc chạy (CI quét bí mật).
- **Thử đột biến để biết bộ test có bắt được lỗi không.** Ví dụ làm adapter nuốt mọi sự kiện thu tiền rồi chạy bộ ngẫu nhiên; làm trong tiến trình (patch module lúc chạy), không sửa tệp nguồn (xem `CLAUDE.md`, mục quy tắc riêng). Đọc kết quả cho đúng: Hub có lưới an toàn (cảnh báo `expiry_unresolved` cho người vận hành), nên bất biến "tiền không vô hình" nghĩa là *người vận hành thấy*, không nhất thiết là *attempt SUCCEEDED*.
- **Bộ kịch bản ngẫu nhiên dùng chung cho các cổng quốc tế** ở `test/support/intl-runner.js`; thêm cổng mới là thêm một mục (cách trả, bộ điều khiển lỗi, sự thật nền từ simulator).
- **Thêm cổng thì phải đưa thư mục test vào script `npm test`** (đã lỡ một lần với Stripe, P-010, và suýt lặp lại với PayPal: số ca chạy thấp hơn dự kiến mới lộ ra) và cập nhật các test liệt kê cổng (`test/hub/adapter-registry.test.js`, `test/hub/contract-currency.test.js`).

## Khác với bản skill cũ
Đã chép đủ mọi phần của skill cũ (mục tiêu; bốn nhóm câu hỏi; thứ tự nguồn; đọc thư viện khách; bảng giả định và ví dụ; thăm dò an toàn; ghi lại; luật dựng; quy tắc dừng; ví dụ VNPay). Điều đã đổi:
1. **Ngôn ngữ**: dịch sang tiếng Việt; giữ nguyên các nhãn kỹ thuật (`agrees`, `conflicts`, `docs-silent`, `docs-only`, `verified-live`, `documented`, `inferred`, `unverified`) và tên công cụ.
2. **Bỏ phần đầu của skill** (khối `name`/`description` dùng để hiện trong danh sách skill) vì đây không còn là skill; thay bằng đoạn mở đầu nói khi nào đọc.
3. **Bỏ cụm "for the BSN Payment Hub" ở tiêu đề** (tệp này nằm sẵn trong tài liệu của Payment Hub).
4. **Đường dẫn**: tính từ thư mục dịch vụ; nơi ghi phát hiện nêu rõ module của từng cổng (`docs/modules/<cổng>-sim/`, hiện có `vnpay-sim`, `momo-sim`, `onepay-sim`, `sepay-sim`, `stripe-sim`, `paypal-sim`).
5. **Mục 6, dòng "chỉ tin phần trừu tượng sau hai adapter khác kiểu"**: bản cũ viết như điều kiện còn phải đạt; nay đã có sáu adapter thuộc ba kiểu (chuyển hướng, chuyển khoản, quốc tế). Dòng giữ nguyên làm luật cho cổng sau.
6. **Mục 6, dòng "trạng thái cuối bất biến"**: bản cũ đúng như luật, nhưng mã trước 2026-10-07 vi phạm một đường (kết quả lời gọi tạo đến muộn ghi đè trạng thái attempt đã nhận thông báo, P-012). Đã sửa trong `src/hub.js` (`_startAttempt`), có test `test/hub/callback-before-create.test.js`.
7. **Mục "Thêm từ Stripe và PayPal"** là phần mới hoàn toàn, tách riêng để không lẫn với phần dịch.
8. **Giữ nhưng chưa kiểm lại**: mẹo `curl` với `os.devNull` trên Windows và câu "sandbox VNPay hạn chế hoàn tiền" (ví dụ VNPay) đều lấy từ skill cũ; phiên này chưa chạy lại hay kiểm lại với VNPay thật.
9. **Không bỏ phần nội dung nào** của skill cũ.
Điều chưa kiểm với cổng thật: toàn bộ hướng dẫn ở đây là phương pháp, không phải sự thật về một cổng; sự thật về từng cổng nằm ở tệp nghiên cứu và module của cổng đó và đều chưa được kiểm với cổng thật.

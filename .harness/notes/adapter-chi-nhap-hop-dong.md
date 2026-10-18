---
paths:
  - "src/adapters/**"
---
Đây là phía cổng thanh toán. Adapter chỉ nhập `src/contract.js` (và tệp cùng adapter), chuẩn hóa về loại sự kiện, `FAIL_CODES`, `METHODS` của hợp đồng chuẩn; không nhập lõi hay `src/app`, `src/connectors`. Thêm cổng là thêm một thư mục adapter tự đăng ký, không đưa tên cổng vào lõi. Điều chưa kiểm với cổng thật ghi là chưa kiểm. `test/hub/adapters-arch.test.js` đỏ nếu sai chiều.

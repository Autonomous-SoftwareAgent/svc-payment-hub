'use strict';
// spec: PHUB-S-029
// spec: PHUB-S-033
// Routing (PHUB-D-029): chọn cổng cho một payment. Module RIÊNG, tách khỏi lõi Hub: chỉ biết hợp đồng (contract.js), cấu hình routing
// (hub.gateways) và khai báo năng lực của adapter; không biết Hub, kho, adapter cụ thể hay tên cổng nào. Hub đưa vào danh sách adapter và
// hàm cho biết cổng nào đang khả dụng (breaker, quá tải); module không tự tra trạng thái đó.
//
// Một mục trong hub.gateways: {id, enabled, priority, products, adapterProduct, minAmount, maxAmount, methods}.
//  - products: chỉ nhận payment có product thuộc danh sách (product là chuỗi tự do của cửa hàng).
//  - adapterProduct: mục này dùng sản phẩm đó của adapter (cùng id có thể có nhiều mục, PHUB-D-018 P6).
//  - methods: phương án thanh toán chuẩn (contract.METHODS) mà mục này phục vụ; ghi đè khai báo năng lực của adapter (operator chỉnh bằng cấu hình).
//  - currencies: loại tiền ISO 4217 mục này nhận; ghi đè khai báo của adapter; cả hai vắng thì chỉ VND (PHUB-D-016).

const { METHODS, CURRENCY_EXPONENT } = require('./contract');

/** Khóa của một mục routing: id, hoặc id/adapterProduct khi mục chọn sản phẩm của adapter. */
const routeKey = (g) => (g.adapterProduct ? `${g.id}/${g.adapterProduct}` : g.id);

/** Product adapter dùng cho attempt tạo qua mục g: mục khai adapterProduct thì dùng khi payment không đòi product cụ thể. */
const productFor = (g, payment) => (g.adapterProduct && payment.product === 'default' ? g.adapterProduct : payment.product);

/** Phương án thanh toán chuẩn mà mục g phục vụ cho payment này: cấu hình thắng; không thì theo năng lực adapter (rỗng nếu adapter không khai). */
function methodsOf(g, adapters, payment) {
  if (Array.isArray(g.methods)) return g.methods;
  const adapter = adapters[g.id];
  if (!adapter) return [];
  try {
    const m = adapter.capabilities(productFor(g, payment)).methods;
    return Array.isArray(m) ? m : [];
  } catch { return []; } // adapter không biết product này: không phục vụ phương án nào
}

/** Loại tiền mà mục g nhận: cấu hình thắng; không thì theo năng lực adapter; adapter không khai thì CHỈ VND (không đoán một cổng nhận tiền lạ). */
function currenciesOf(g, adapters, payment) {
  if (Array.isArray(g.currencies)) return g.currencies;
  const adapter = adapters[g.id];
  if (!adapter) return [];
  try {
    const c = adapter.capabilities(productFor(g, payment)).currencies;
    return Array.isArray(c) ? c : ['VND'];
  } catch { return []; }
}

/** Kiểm các mục gateways khi nạp cấu hình (PHUB-D-009): lỗi cấu hình phải dừng khởi động, không để lộ lúc có giao dịch. Trả tập id cổng. */
function validateGateways(gws, adapters) {
  if (!Array.isArray(gws) || !gws.length) throw new Error('cấu hình routing: gateways rỗng');
  const seen = new Set();
  const keys = new Set();
  const count = {};
  for (const g of gws) count[g.id] = (count[g.id] || 0) + 1;
  for (const g of gws) {
    if (!g.id) throw new Error('cấu hình routing: cổng thiếu id');
    // Cùng id nhiều mục chỉ khi mỗi mục khai adapterProduct khác nhau (PHUB-D-018, P6)
    if (count[g.id] > 1 && !g.adapterProduct) throw new Error(`cấu hình routing: trùng cổng ${g.id} (nhiều mục cùng id phải khai adapterProduct)`);
    const key = routeKey(g);
    if (keys.has(key)) throw new Error(`cấu hình routing: trùng cổng ${key}`);
    keys.add(key);
    seen.add(g.id);
    if (g.enabled !== false && !adapters[g.id]) throw new Error(`cấu hình routing: cổng ${g.id} bật nhưng không có adapter`);
    if (g.minAmount != null && g.maxAmount != null && g.minAmount > g.maxAmount) throw new Error(`cấu hình routing: ${g.id} có minAmount > maxAmount`);
    if (g.currencies !== undefined && (!Array.isArray(g.currencies) || g.currencies.some((c) => !Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, c)))) throw new Error(`cấu hình routing: ${key}.currencies phải là danh sách loại tiền ISO 4217 trong: ${Object.keys(CURRENCY_EXPONENT).join(', ')}`);
    if (g.methods !== undefined && (!Array.isArray(g.methods) || g.methods.some((m) => !METHODS.includes(m)))) throw new Error(`cấu hình routing: ${key}.methods phải là danh sách trong: ${METHODS.join(', ')}`);
  }
  if (!gws.some((g) => g.enabled !== false)) throw new Error('cấu hình routing: không có cổng nào được bật');
  return seen;
}

/**
 * Danh sách mục routing ứng viên cho payment, theo thứ tự thử. Cổng đang mở breaker hoặc quá tải bị bỏ qua (chưa gọi nên chắc chắn chưa nhận tiền, PHUB-D-010);
 * exclude là các khóa mục đã thử (failover): ưu tiên mục chưa thử, hết thì dùng lại.
 * @param {{gateways:Object[], adapters:Object, payment:Object, exclude:string[], isAvailable:(id:string)=>boolean}} o
 */
function candidates({ gateways, adapters, payment, exclude, isAvailable }) {
  const all = gateways
    .filter((g) => g.enabled !== false && adapters[g.id])
    .filter((g) => !g.products || !g.products.length || g.products.includes(payment.product))
    .filter((g) => !g.adapterProduct || payment.product === 'default' || payment.product === g.adapterProduct)
    .filter((g) => (g.minAmount == null || payment.amount >= g.minAmount) && (g.maxAmount == null || payment.amount <= g.maxAmount))
    .filter((g) => currenciesOf(g, adapters, payment).includes(payment.currency || 'VND'))
    .filter((g) => !payment.method || methodsOf(g, adapters, payment).includes(payment.method))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  const preferred = all.filter((g) => !exclude.includes(routeKey(g)));
  const base = preferred.length ? preferred : all;
  return [base, all].map((l) => l.filter((g) => isAvailable(g.id))).find((l) => l.length) || base;
}

module.exports = { routeKey, productFor, methodsOf, currenciesOf, validateGateways, candidates };

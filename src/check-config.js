'use strict';
// spec: PHUB-S-024
// Kiểm tệp cấu hình MÀ KHÔNG chạy Hub (PHUB-D-024): node src/main.js --check-config [--connect]. Không mở cổng, không ghi cơ sở dữ liệu,
// không gọi mạng tới cổng thanh toán hay Kafka; gom MỌI lỗi tìm thấy thay vì dừng ở lỗi đầu tiên, để operator sửa một lần.
// --connect thêm một bước duy nhất: thử kết nối PostgreSQL và chạy SELECT 1 (không tạo schema, không ghi gì).
// Dùng đúng đường dựng của Hub (buildHub, buildInbound) nên cái gì làm Hub không khởi động thì ở đây cũng báo lỗi.

const { MemoryStore } = require('./store');

const ENV_RE = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

/** Mọi biến môi trường bắt buộc (không có mặc định) mà cấu hình tham chiếu nhưng chưa đặt, kèm vị trí. */
function missingEnv(value, env, trail = '', out = []) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(ENV_RE)) if ((env[m[1]] === undefined || env[m[1]] === '') && m[2] === undefined) out.push({ name: m[1], at: trail || 'gốc' });
  } else if (Array.isArray(value)) value.forEach((v, i) => missingEnv(v, env, `${trail}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) missingEnv(v, env, trail ? `${trail}.${k}` : k, out);
  return out;
}

const SANDBOX = /sandbox|test|mtf|staging|\.dev\b|localhost|127\.0\.0\.1/i;

/**
 * @param {object} raw cấu hình JSON đã đọc (chưa nội suy biến môi trường)
 * @param {object} env biến môi trường
 * @param {{connect?: boolean, buildHub?: Function, buildInbound?: Function, discover?: Function}} opts buildHub, buildInbound, discover (registry adapter) do main.js đưa vào (tránh import vòng; lõi kiểm cấu hình không biết cổng nào)
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], summary:object}>}
 */
async function checkConfig(raw, env, opts = {}) {
  const errors = [];
  const warnings = [];
  const summary = {};
  const { buildHub, buildInbound, discover } = opts;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['cấu hình phải là một đối tượng JSON'], warnings, summary };
  if (!raw.hub || !Array.isArray(raw.hub.gateways) || !raw.hub.gateways.length) errors.push('hub.gateways phải là danh sách có ít nhất một cổng');

  // 1. biến môi trường: phần chung và chỉ những cổng đang bật (cổng tắt không bắt buộc có bí mật, giống lúc chạy thật)
  const { adapters: rawAdapters = {}, ...rest } = raw;
  const enabled = ((raw.hub && raw.hub.gateways) || []).filter((g) => g && g.enabled !== false).map((g) => g.id);
  const missing = missingEnv(rest, env);
  for (const id of new Set(enabled)) if (rawAdapters[id]) missing.push(...missingEnv(rawAdapters[id], env, `adapters.${id}`));
  for (const m of missing) errors.push(`thiếu biến môi trường ${m.name} (dùng trong cấu hình ${m.at})`);
  if (!raw.apiToken) errors.push('thiếu apiToken (dùng "${HUB_API_TOKEN}")');
  if (!raw.databaseUrl) errors.push('thiếu databaseUrl (dùng "${HUB_DATABASE_URL}", PostgreSQL)');
  if (errors.length) return { ok: false, errors, warnings, summary }; // thiếu biến thì không dựng tiếp được: các bước sau cần giá trị thật

  // 2. dựng Hub bằng kho bộ nhớ và mạng bị chặn: kiểm routing, adapter, kết nối dịch vụ, cửa hàng
  const noNet = () => { throw new Error('check-config không gọi mạng'); };
  let built = null;
  try {
    built = await buildHub(raw, env, { store: new MemoryStore(), fetch: noNet, kafkaFactory: noNet });
  } catch (err) { errors.push(err.message); }
  if (built) {
    const { hub, config, sinks, connDeps } = built;
    try { buildInbound(hub, config, connDeps); } catch (err) { errors.push(err.message); }
    summary.gateways = config.hub.gateways.filter((g) => g.enabled !== false).map((g) => g.id + (g.adapterProduct ? `/${g.adapterProduct}` : ''));
    summary.disabled = config.hub.gateways.filter((g) => g.enabled === false).map((g) => g.id);
    summary.shops = (config.shops || []).map((s) => s.id);
    summary.routesOut = ((config.connectors || {}).out || []).map((r) => `${r.id}:${r.sink}`);
    summary.sourcesIn = ((config.connectors || {}).in || []).map((r) => `${r.id}:${r.source}`);
    // 3. cảnh báo: hợp lệ nhưng đáng xem trước khi chạy thật
    if (!config.publicBaseUrl) warnings.push('publicBaseUrl trống: cổng cần gọi ngược về Hub (IPN, return) sẽ không có địa chỉ để gọi');
    else if (!/^https:\/\//.test(config.publicBaseUrl) && !SANDBOX.test(config.publicBaseUrl)) warnings.push(`publicBaseUrl (${config.publicBaseUrl}) không phải https`);
    if (!config.metricsToken) warnings.push('metricsToken trống: /metrics không có token bảo vệ (hoặc tắt)');
    for (const id of summary.gateways.map((x) => x.split('/')[0])) {
      const a = (config.adapters && config.adapters[id]) || {};
      const hit = Object.entries(a).filter(([k, v]) => /url/i.test(k) && typeof v === 'string' && SANDBOX.test(v)).map(([k]) => k);
      if (hit.length) warnings.push(`cổng ${id} đang trỏ môi trường thử (${hit.join(', ')})`);
    }
    // Cảnh báo riêng của từng cổng do adapter tự khai (configWarnings); ở đây không biết cổng nào cần gì
    const modules = discover ? discover(config.adapterDirs || []) : new Map();
    for (const id of summary.gateways.map((x) => x.split('/')[0])) {
      const a = (config.adapters && config.adapters[id]) || {};
      const mod = modules.get(id);
      if (mod && typeof mod.configWarnings === 'function') warnings.push(...mod.configWarnings(a));
    }
    if (config.databaseUrl && SANDBOX.test(config.databaseUrl)) warnings.push('databaseUrl trỏ máy cục bộ hoặc môi trường thử');
    for (const s of Object.values(sinks || {})) if (s.close) await s.close().catch(() => {});
  }

  // 4. tùy chọn: thử kết nối PostgreSQL (không tạo schema, không ghi)
  if (opts.connect && !errors.length) {
    const url = built.config.databaseUrl;
    const { Client } = require('pg');
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try { await c.connect(); await c.query('SELECT 1'); summary.database = 'kết nối được'; } catch (err) { errors.push(`không kết nối được PostgreSQL: ${err.message}`); } finally { await c.end().catch(() => {}); }
  }
  return { ok: errors.length === 0, errors, warnings, summary };
}

/** In kết quả cho người đọc; trả mã thoát (0 hợp lệ, 1 có lỗi). */
function report(res, write = (s) => console.log(s)) {
  for (const e of res.errors) write(`LỖI      ${e}`);
  for (const w of res.warnings) write(`CẢNH BÁO ${w}`);
  if (res.ok) {
    const s = res.summary;
    write(`OK        cấu hình hợp lệ. Cổng bật: ${(s.gateways || []).join(', ') || '(không)'}${s.disabled && s.disabled.length ? `; tắt: ${s.disabled.join(', ')}` : ''}. Cửa hàng: ${(s.shops || []).length}. Tuyến ra: ${(s.routesOut || []).join(', ') || '(không)'}. Nguồn vào: ${(s.sourcesIn || []).join(', ') || '(chỉ HTTP)'}.${s.database ? ` PostgreSQL: ${s.database}.` : ''}`);
  } else write(`KHÔNG HỢP LỆ: ${res.errors.length} lỗi (Hub sẽ không khởi động với cấu hình này)`);
  return res.ok ? 0 : 1;
}

module.exports = { checkConfig, report, missingEnv };

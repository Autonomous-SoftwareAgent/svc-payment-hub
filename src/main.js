'use strict';
// spec: PHUB-S-008
// spec: PHUB-S-009
// spec: PHUB-S-011
// spec: PHUB-S-013
// spec: PHUB-S-015
// spec: PHUB-S-017
// spec: PHUB-S-023
// spec: PHUB-S-024
// spec: PHUB-S-025
// Khởi động Hub từ tệp cấu hình JSON: node src/main.js  (HUB_CONFIG=đường dẫn tệp cấu hình).
// Bí mật chỉ được tham chiếu bằng biến môi trường (${TÊN_BIẾN}); thiếu biến thì không khởi động.

const fs = require('node:fs');
const { PaymentHub } = require('./hub');
const { discover: discoverAdapters } = require('./adapters/registry');
const { PostgresStore } = require('./store-postgres');
const { createHubServer } = require('./server');
const { createApp } = require('./app/app');
const { assertInbound } = require('./app/ports');
const { buildSinks, inboundKinds } = require('./connectors/registry');

// Thay ${VAR} trong mọi chuỗi của cấu hình bằng biến môi trường; thiếu biến thì ném lỗi.
// ${VAR:-mặc định} dùng giá trị mặc định (có thể rỗng) khi biến thiếu hoặc rỗng, cho phần tùy chọn như webhook.
function interpolate(value, env, trail = '') {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, dflt) => {
      if (env[name] === undefined || env[name] === '') {
        if (dflt !== undefined) return dflt;
        throw new Error(`thiếu biến môi trường ${name} (dùng trong cấu hình ${trail || 'gốc'})`);
      }
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, `${trail}[${i}]`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, trail ? `${trail}.${k}` : k)]));
  return value;
}

// Adapter do registry quét thư mục (src/adapters/ và cấu hình adapterDirs): thêm cổng không phải sửa tệp này (PHUB-D-023).

/** Dựng Hub (chưa listen) từ cấu hình đã đọc. Trả {hub, store, config}. deps.store thay cho PostgreSQL (dùng trong test). */
async function buildHub(rawConfig, env = process.env, deps = {}) {
  // Nội suy biến môi trường cho phần chung và chỉ cho cổng đang bật: cổng tắt không bắt buộc có bí mật.
  const { adapters: rawAdapters = {}, ...rest } = rawConfig;
  const config = interpolate(rest, env);
  config.adapters = {};
  for (const g of config.hub.gateways) {
    if (g.enabled !== false && rawAdapters[g.id]) config.adapters[g.id] = interpolate(rawAdapters[g.id], env, `adapters.${g.id}`);
  }
  // Nhiều cửa hàng (PHUB-D-015): endpoint webhook của từng cửa hàng đi vào cấu hình webhook của Hub; token đi vào server.
  config.shops = config.shops || [];
  const shopIds = new Set();
  for (const sh of config.shops) {
    if (shopIds.has(sh.id)) throw new Error(`shops: trùng id ${sh.id}`);
    shopIds.add(sh.id);
  }
  const shopHooks = Object.fromEntries(config.shops.filter((sh) => sh.webhooks && sh.webhooks.url).map((sh) => [sh.id, sh.webhooks]));
  if (Object.keys(shopHooks).length || (config.hub.webhooks && config.hub.webhooks.url)) config.hub.webhooks = { ...(config.hub.webhooks || {}), shops: shopHooks };
  else config.hub.webhooks = null; // ${SHOP_WEBHOOK_URL:-} rỗng: webhook tắt
  const base = (config.publicBaseUrl || '').replace(/\/+$/, '');
  const adapters = {};
  const modules = discoverAdapters(config.adapterDirs || []);
  for (const g of config.hub.gateways) {
    if (g.enabled === false) continue;
    const mod = modules.get(g.id);
    if (!mod) throw new Error(`cổng không hỗ trợ: ${g.id} (có: ${[...modules.keys()].join(', ')})`);
    if (adapters[g.id]) continue; // nhiều mục cùng id (adapterProduct khác nhau) dùng chung một adapter
    const cfg = { ...(config.adapters && config.adapters[g.id]) };
    adapters[g.id] = mod.create(cfg, { fetch: deps.fetch || globalThis.fetch, clock: deps.clock || { now: () => Date.now() }, publicBaseUrl: base });
    if (adapters[g.id].id !== g.id) throw new Error(`adapter ${g.id}: id của adapter dựng ra (${adapters[g.id].id}) khác id khai báo`);
  }
  if (!deps.store && !config.databaseUrl) throw new Error('thiếu databaseUrl trong cấu hình (dùng "${HUB_DATABASE_URL}", PostgreSQL)');
  const store = deps.store || await PostgresStore.open(config.databaseUrl, { schema: config.databaseSchema });
  // Lớp kết nối dịch vụ (PHUB-D-017), độc lập với phần cổng ở trên: sink ra do registry quét thư mục connectors/out, tuyến ra do cấu hình.
  const conn = config.connectors || {};
  const connDeps = { fetch: deps.fetch || globalThis.fetch, kafka: conn.kafka, kafkaFactory: deps.kafkaFactory };
  const sinks = deps.sinks || buildSinks(connDeps, { extraDirs: conn.dirs || [] });
  config.hub.events = { ...(config.hub.events || {}), routes: conn.out || [] };
  const hub = new PaymentHub({ adapters, store, clock: deps.clock, config: config.hub, deps: { fetch: deps.fetch, sinks } });
  return { hub, store, config, sinks, connDeps };
}

/** Dựng các nguồn vào chạy nền (Kafka...) từ connectors.in; nguồn "http" do server lo. Trả danh sách đã dựng (chưa start). */
function buildInbound(hub, config, connDeps, log = () => {}) {
  const conn = config.connectors || {};
  const kinds = inboundKinds({ extraDirs: conn.dirs || [] });
  const app = createApp({ hub });
  const ids = new Set();
  const out = [];
  for (const [i, entry] of (conn.in || []).entries()) {
    const name = `connectors.in[${i}]`;
    if (!entry.id || ids.has(entry.id)) throw new Error(`${name}.id thiếu hoặc trùng`);
    ids.add(entry.id);
    const mod = kinds.get(entry.source);
    if (!mod || entry.source === 'http') throw new Error(`${name}.source không hỗ trợ: ${entry.source} (có: ${[...kinds.keys()].filter((k) => k !== 'http').join(', ')})`);
    const shop = entry.principal && entry.principal.role === 'shop' ? entry.principal.id : undefined;
    if (!hub.events.hasRoute('command.completed', shop)) throw new Error(`${name}: không có tuyến ra nào nhận command.completed${shop ? ` của cửa hàng ${shop}` : ''}; khai báo một tuyến trong connectors.out để lệnh có chỗ trả kết quả`);
    const conn = mod.create({ app, config: entry, deps: connDeps, log });
    assertInbound(conn, name);
    out.push(conn);
  }
  return out;
}

async function main(env = process.env) {
  if (!env.HUB_CONFIG) throw new Error('đặt HUB_CONFIG là đường dẫn tới tệp cấu hình JSON (xem src/config.example.json)');
  const raw = JSON.parse(fs.readFileSync(env.HUB_CONFIG, 'utf8'));
  const { hub, config, sinks, connDeps } = await buildHub(raw, env);
  // Mất kết nối cơ sở dữ liệu thì thoát: trạng thái nằm trong DB, trình điều phối (docker restart policy) khởi động lại và nạp lại.
  hub.store.onBroken = (err) => { console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', message: `mất kết nối cơ sở dữ liệu: ${err.message}` })); process.exit(1); };
  if (!config.apiToken) throw new Error('thiếu apiToken trong cấu hình (dùng "${HUB_API_TOKEN}")');
  // Log có cấu trúc: mỗi dòng một JSON kèm thời điểm; nhật ký truy cập và lỗi mang requestId.
  const log = (e) => console.error(JSON.stringify({ ts: new Date().toISOString(), ...e }));
  const adopted = await hub.adoptAdapters(); // nạp lại bộ đệm riêng của adapter từ các attempt còn sống, TRƯỚC khi mở cổng (callback đầu tiên có thể đến ngay)
  if (Object.keys(adopted).length) log({ level: 'info', adopted });
  const api = createHubServer({ hub, apiToken: config.apiToken, shops: config.shops, metricsToken: config.metricsToken, limits: config.limits, accessLog: config.accessLog !== false, log });
  const { url } = await api.listen(config.port || 8080, config.host || '127.0.0.1');
  const inbound = buildInbound(hub, config, connDeps, log);
  for (const c of inbound) await c.start();
  hub.startScheduler({ everySeconds: config.schedulerSeconds || 30, onError: (e) => console.error(JSON.stringify({ level: 'error', scheduler: e.message })) });
  console.log(`Payment Hub: ${url} (cổng: ${Object.keys(hub.adapters).join(', ')})`);
  const stop = async () => {
    hub.stopScheduler();
    for (const c of inbound) await c.stop().catch(() => {});
    await api.close();
    for (const s of Object.values(sinks)) if (s.close) await s.close().catch(() => {});
    await hub.store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** node src/main.js --check-config [tệp] [--connect]: kiểm cấu hình mà không chạy Hub (PHUB-D-024). Trả mã thoát: 0 hợp lệ, 1 có lỗi. */
async function checkMain(argv = process.argv.slice(2), env = process.env, write = (s) => console.log(s)) {
  const { checkConfig, report } = require('./check-config');
  const file = argv.find((a) => !a.startsWith('--')) || env.HUB_CONFIG;
  if (!file) { write('LỖI      đặt HUB_CONFIG hoặc truyền đường dẫn tới tệp cấu hình'); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { write(`LỖI      không đọc được ${file}: ${e.message}`); return 1; }
  return report(await checkConfig(raw, env, { connect: argv.includes('--connect'), buildHub, buildInbound, discover: discoverAdapters }), write);
}

if (require.main === module) {
  if (process.argv.includes('--check-config')) checkMain().then((code) => process.exit(code), (e) => { console.error(`Lỗi: ${e.message}`); process.exit(1); });
  else main().catch((e) => { console.error(`Lỗi khởi động: ${e.message}`); process.exit(1); });
}

module.exports = { buildHub, buildInbound, interpolate, main, checkMain };

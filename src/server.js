'use strict';
// spec: PHUB-S-008
// spec: PHUB-S-009
// spec: PHUB-S-010
// spec: PHUB-S-011
// spec: PHUB-S-012
// spec: PHUB-S-013
// spec: PHUB-S-015
// spec: PHUB-S-017
// HTTP API của Hub (PHUB-D-008): cửa hàng gọi vào, cổng gọi vào, vận hành. Không thư viện ngoài.
// Nhiều cửa hàng (PHUB-D-015): token cửa hàng định danh cửa hàng và chỉ thấy dữ liệu của mình; token quản trị làm mọi việc.
// Quan sát (PHUB-D-013): mã yêu cầu, nhật ký truy cập (không ghi query/thân/header xác thực), GET /metrics.

const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('./app/app');
const { httpStatusFor } = require('./app/errors');
const { operations: _ops } = require('./app/operations');
const { schemas, eventTypes } = require('./app/schemas');
const { buildOpenApi } = require('./app/openapi');
const httpConnector = require('./connectors/in/http');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Route của máy chủ không nằm trong danh mục thao tác (hướng cổng thanh toán và vận hành chung).
const HOST_ROUTES = [
  ['GET', /^\/health$/, '/health'], ['GET', /^\/metrics$/, '/metrics'], ['GET', /^\/openapi\.json$/, '/openapi.json'],
  ['GET', /^\/(ipn|return)\/[A-Za-z0-9_-]+$/, '/$1/{gateway}'], ['POST', /^\/(ipn|return)\/[A-Za-z0-9_-]+$/, '/$1/{gateway}'],
];
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHOP_ID = /^[a-z0-9_-]{1,32}$/;

const LIMIT_DEFAULTS = { maxInFlight: 1000, callbackReserve: 200, ratePerSecond: 200, burst: 400 };

// Token bucket đơn giản: refill theo thời gian, mỗi request lấy một token.
class TokenBucket {
  constructor(rate, burst, now) { this.rate = rate; this.burst = burst; this.now = now; this.tokens = burst; this.at = now(); }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.tokens >= 1) { this.tokens -= 1; return 0; }
    return Math.ceil((1 - this.tokens) / this.rate); // giây cần chờ
  }
}

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

/**
 * @param {{hub?:Object, getHub?:()=>Object, apiToken:string, maxBodyBytes?:number, log?:(e:Object)=>void}} o
 */
function createHubServer({ hub, getHub, apiToken, shops = [], metricsToken, maxBodyBytes = 1024 * 1024, log = () => {}, accessLog = true, limits = {}, now = () => Date.now(), checkOutput = false }) {
  const adminTokens = [].concat(apiToken || []).filter(Boolean);
  if (!adminTokens.length) throw new Error('thiếu apiToken: Hub không khởi động khi không có xác thực cho API cửa hàng/vận hành');
  const shopTokens = [];
  for (const sh of shops) {
    if (!SHOP_ID.test(sh.id || '')) throw new Error(`shops: id không hợp lệ: ${sh.id}`);
    for (const t of [].concat(sh.apiToken || [])) shopTokens.push({ id: sh.id, token: t });
  }
  const allTokens = [...adminTokens, ...shopTokens.map((x) => x.token), ...[].concat(metricsToken || [])];
  if (new Set(allTokens).size !== allTokens.length) throw new Error('token trùng nhau giữa quản trị, các cửa hàng hoặc metrics');
  if (shopTokens.some((x) => x.token.length < 16)) throw new Error('token cửa hàng phải dài ít nhất 16 ký tự');
  const H = () => (getHub ? getHub() : hub);
  // Cổng vào chuẩn (PHUB-D-017): connector HTTP chỉ dịch route <-> thao tác của danh mục; kiểm quyền và schema nằm ở app.
  const app = createApp({ getHub: H, checkOutput });
  const api = httpConnector.create({ app });
  let openapiDoc = null;
  const openapi = () => openapiDoc || (openapiDoc = buildOpenApi({ operations: _ops, schemas, eventTypes, version: require('../package.json').version }));
  function routeName(method, pathname) {
    for (const [m, re, name] of HOST_ROUTES) if (m === method && re.test(pathname)) return pathname.replace(re, name);
    const found = api.match(method, pathname);
    return found ? found.label : 'other';
  }
  const lim ={ ...LIMIT_DEFAULTS, ...limits };
  // Giới hạn tải (PHUB-D-009): số request đồng thời (callback của cổng có phần dành riêng) và tốc độ cho API cửa hàng/vận hành.
  let inFlight = 0;
  const buckets = new Map(); // mỗi người gọi (quản trị hoặc từng cửa hàng) một bộ đếm riêng
  const bucketFor = (principal) => {
    const k = principal.role + ':' + (principal.id || '');
    let b = buckets.get(k);
    if (!b) { b = new TokenBucket(lim.ratePerSecond, lim.burst, now); buckets.set(k, b); }
    return b;
  };

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        if (tooBig) return; // bỏ phần còn lại, không giữ trong bộ nhớ; kết nối đóng sau phản hồi 413
        size += c.length;
        if (size > maxBodyBytes) { tooBig = true; chunks.length = 0; reject(new HttpError(413, 'payload_too_large')); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const parseJson = (text) => {
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid_json', 'thân request không phải JSON hợp lệ'); }
  };

  // Xác định người gọi từ Bearer token: {role: 'admin'} | {role: 'shop', id} | {role: 'metrics'}; null nếu không khớp.
  // Duyệt hết mọi token (so sánh thời gian hằng) để thời gian trả lời không lộ token nào gần đúng.
  const identify = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    let found = null;
    for (const t of adminTokens) if (safeEqual(m[1], t)) found = { role: 'admin' };
    for (const x of shopTokens) if (safeEqual(m[1], x.token)) found = { role: 'shop', id: x.id };
    for (const t of [].concat(metricsToken || [])) if (safeEqual(m[1], t)) found = { role: 'metrics' };
    return found;
  };

  // Callback của cổng: đưa nguyên thân request cho adapter; phản hồi là ack do adapter dựng.
  async function handleGatewayCallback(req, res, url, channel, gateway, rawBody) {
    const ct = String(req.headers['content-type'] || '');
    let body = rawBody;
    if (ct.includes('json')) { try { body = JSON.parse(rawBody); } catch { /* giữ chuỗi thô */ } }
    const result = await H().handleCallback(gateway, { channel, method: req.method, query: Object.fromEntries(url.searchParams), body, rawBody, headers: req.headers });
    if (channel === 'ipn') {
      res.writeHead(result.ack.status, { 'content-type': result.ack.contentType });
      return res.end(result.ack.body);
    }
    // return: chỉ hiển thị. Chuyển trình duyệt về cửa hàng kèm trạng thái do Hub ghi nhận.
    const attempt = result.attempt;
    const payment = attempt && H().store.getPayment(attempt.paymentId);
    if (!payment) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy giao dịch'); }
    const back = new URL(payment.returnUrl);
    back.searchParams.set('paymentId', payment.id);
    back.searchParams.set('status', payment.status);
    back.searchParams.set('attempt', attempt.status);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://hub');
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' && p === '/health') return send(res, 200, { ok: true });

    let mm;
    if ((mm = /^\/(ipn|return)\/([A-Za-z0-9_-]+)$/.exec(p)) && (m === 'GET' || m === 'POST')) {
      const raw = m === 'POST' ? await readBody(req) : '';
      return handleGatewayCallback(req, res, url, mm[1], mm[2], raw);
    }

    // Từ đây trở xuống cần xác thực (cửa hàng và vận hành).
    const principal = identify(req);
    if (m === 'GET' && p === '/metrics') {
      if (!principal || principal.role === 'shop') throw new HttpError(principal ? 403 : 401, principal ? 'forbidden' : 'unauthorized');
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }); // không tính vào giới hạn tốc độ
      return res.end(H().metrics.render());
    }
    if (!principal || principal.role === 'metrics') throw new HttpError(principal ? 403 : 401, principal ? 'forbidden' : 'unauthorized');
    const wait = bucketFor(principal).take();
    if (wait) { res.setHeader('retry-after', String(wait)); throw new HttpError(429, 'rate_limited', 'quá giới hạn tốc độ'); }
    const body = m === 'POST' ? parseJson(await readBody(req)) : {};

    if (m === 'GET' && p === '/openapi.json') return send(res, 200, openapi());
    const found = api.match(m, p);
    if (found) {
      const r = await api.handle(found, { query: Object.fromEntries(url.searchParams), body, principal });
      return send(res, r.status, r.body);
    }
    throw new HttpError(404, 'not_found', 'route không tồn tại');
  }

  // Ghi nhận một request đã xong: số đo theo route mẫu và (trừ /health) một dòng nhật ký truy cập.
  const finish = (req, res, t0, counted) => {
    const route = routeName(req.method, (req.url || '').split('?')[0]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const metrics = (() => { try { return H().metrics; } catch { return null; } })();
    if (metrics) {
      metrics.inc('hub_http_requests_total', { route, method: req.method, status: res.statusCode });
      metrics.observe('hub_http_request_duration_seconds', { route, method: req.method }, ms / 1000);
    }
    if (accessLog && route !== '/health' && counted !== 'skip') log({ level: 'info', msg: 'request', requestId: req.reqId, method: req.method, route, status: res.statusCode, ms: Math.round(ms * 10) / 10 });
  };

  const server = http.createServer(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const given = req.headers['x-request-id'];
    req.reqId = given && REQUEST_ID.test(given) ? given : crypto.randomBytes(8).toString('hex');
    res.setHeader('x-request-id', req.reqId);
    res.on('close', () => finish(req, res, t0));
    const isCallback = /^\/(ipn|return)\//.test(req.url || '');
    if (req.url !== '/health' && inFlight >= lim.maxInFlight + (isCallback ? lim.callbackReserve : 0)) {
      res.setHeader('retry-after', '1');
      return send(res, 503, { error: 'overloaded' });
    }
    inFlight += 1;
    res.on('close', () => { inFlight -= 1; });
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('connection', 'close');
        return send(res, err.status, { error: err.code, message: err.message });
      }
      if (err && err.code && httpStatusFor(err.code) !== 500) return send(res, httpStatusFor(err.code), { error: err.code, message: err.message });
      log({ level: 'error', requestId: req.reqId, message: err && err.message, stack: err && err.stack });
      return send(res, 500, { error: 'internal_error' }); // không lộ chi tiết
    }
  });

  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server,
    stats: () => ({ inFlight }),
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen({ port, host, backlog: 2048 }, () => { // backlog lớn: đợt kết nối đồng thời không bị từ chối khi vừa mở
        const addr = server.address();
        resolve({ port: addr.port, url: `http://${host}:${addr.port}` });
      }));
    },
    close() {
      return new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    },
  };
}

module.exports = { createHubServer, httpStatusFor };

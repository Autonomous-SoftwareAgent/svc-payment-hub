'use strict';
// spec: SEPY-S-001
// spec: SEPY-S-002
// spec: SEPY-S-004
// spec: SEPY-S-005
// Simulator SePay (ngân hàng + SePay). Sản phẩm A (QR tĩnh) ở file này; B (VA theo đơn) ở va.js; C (cổng pay.sepay.vn) ở pg.js.
// Simulator SePay sản phẩm A chạy bằng HTTP, không phụ thuộc thư viện ngoài. Vai trò: ngân hàng + SePay.
// FORMAT theo bằng chứng (SEPY-D-002 A1-A8): payload webhook 12 trường, 401 JSON của API v2 kèm X-RateLimit-Limit,
// /img lỗi vẫn HTTP 200 text/html. SEMANTIC (unverified) mô phỏng bất lợi, cấu hình được qua POST /sim/control.
const http = require('node:http');
const crypto = require('node:crypto');
const { installVa, VA_CONTROLS } = require('./va.js');
const { installPg, PG_CONTROLS } = require('./pg.js');

const DEFAULT_CONTROLS = {
  webhook_drop: false,              // không gửi webhook, mất hẳn (S11)
  webhook_duplicate: 1,             // số bản gửi cho mỗi giao dịch (S8)
  webhook_delay_seconds: 0,         // trễ giao lần đầu
  webhook_reorder: false,           // giao dịch cũ được giao sau giao dịch mới (S10)
  content_mangle: 'none',           // none|lowercase|strip_dashes|truncate:N|prefix:XXX (S3, unverified)
  code_extraction: true,            // SePay có tách code không (S2)
  ack_mode: 'docs',                 // docs: chỉ 200/201 + {"success":true}; any2xx: mọi 2xx (S12 unverified)
  webhook_retry_max_attempts: 8,    // S11: docs mới ghi 8 lần gửi
  webhook_retry_intervals_minutes: [1, 1, 2, 3, 5, 8, 13], // Fibonacci
  webhook_send_out: false,          // chèn thêm giao dịch tiền ra sau mỗi giao dịch tiền vào (S19)
  webhook_bad_auth: false,          // gửi sai khóa/chữ ký
  hmac_timestamp_skew_seconds: 0,   // lệch timestamp (chữ ký vẫn hợp lệ với timestamp đã lệch)
  webhook_content_type: 'json',     // json|form (form: mọi giá trị là chuỗi, A3)
  subaccount_null: false,           // docs mâu thuẫn: "" hay null (A2)
  reference_code_empty: false,      // referenceCode rỗng (A12)
  api_id_format: 'numeric',         // numeric: id API = id webhook; uuid: UUID như docs (A12, bất lợi nếu khác)
  api_rate_limit: 3,                // request/giây theo đồng hồ ảo (A8)
};

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function makeClock(opts) {
  if (opts && opts.clock) return opts.clock;
  let t = Date.now();
  return { now: () => t, advance(sec) { t += Math.round(sec * 1000); return t; } };
}

const pad = (n) => String(n).padStart(2, '0');
function vnDate(ms) { // giờ VN không offset (A6)
  const d = new Date(ms + 7 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function mangle(content, mode) {
  const m = String(mode || 'none');
  if (m === 'lowercase') return content.toLowerCase();
  if (m === 'strip_dashes') return content.replace(/-/g, '');
  if (m.startsWith('truncate:')) return content.slice(0, Math.max(0, Number(m.slice(9)) || 0));
  if (m.startsWith('prefix:')) return m.slice(7) + content;
  return content;
}

async function startSimulator(opts = {}) {
  const accountNumber = opts.accountNumber || '0123456789';
  const bankName = opts.bankName || 'MBBank';
  const authMode = opts.authMode || 'none';
  const apiKey = opts.apiKey || 'sim-api-key';
  const hmacSecret = opts.hmacSecret || 'sim-hmac-secret';
  const apiToken = opts.apiToken || 'sim-api-token';
  const codePrefix = String(opts.codePrefix || 'BSN').toUpperCase();
  const clock = makeClock(opts);
  const state = {
    transactions: [], // theo thứ tự id tăng dần
    queue: [],        // job webhook chờ retry/delay: {txId, copy, attempt, due, retry}
    held: [],         // job giữ lại cho webhook_reorder
    log: [],
    balance: 0,
    seq: 0,
    apiRequests: [],  // thời điểm (ms ảo) các request API, để giới hạn tốc độ
    controls: { ...DEFAULT_CONTROLS, ...VA_CONTROLS, ...PG_CONTROLS, ...(opts.controls || {}) },
    pgNotes: [],      // thông báo IPN của cổng (sản phẩm C), cùng cơ chế giao/thử lại như webhook
  };
  const bankAccountId = opts.bankAccountId || 'f9e8d7c6-b5a4-3210-fedc-ba0987654321';
  const c = () => state.controls;
  const webhookUrl = () => opts.webhookUrl || state.webhookUrl;
  const codeRe = new RegExp(`${codePrefix}[A-Z0-9]{1,30}`, 'i'); // cấu trúc mã thanh toán của SePay (S2)

  const sendJson = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };

  const apiId = (tx) => (c().api_id_format === 'uuid' ? `00000000-0000-4000-8000-${tx.id.toString(16).padStart(12, '0')}` : String(tx.id));

  // ---------- ngân hàng + SePay ghi giao dịch ----------
  function recordTransfer(b) {
    const transferType = b.transferType === 'out' ? 'out' : 'in';
    const amount = Number(b.amount);
    const original = String(b.content == null ? '' : b.content);
    const bankContent = mangle(original, c().content_mangle); // ngân hàng sửa trước khi SePay thấy
    let code = null;
    if ('code' in b) code = b.code; // giao dịch VA: code do mô phỏng B quyết định (B6)
    else if (c().code_extraction && transferType === 'in') {
      const m = codeRe.exec(bankContent);
      code = m ? m[0].toUpperCase() : null;
    }
    state.seq += 1;
    state.balance += transferType === 'in' ? amount : -amount;
    const id = 90000 + state.seq;
    const tx = {
      id, gateway: bankName, createdAt: clock.now(), transactionDate: vnDate(clock.now()),
      accountNumber: b.accountNumber || accountNumber, transferType, amount, accumulated: state.balance,
      originalContent: original, content: bankContent, code,
      va: b.va || null, subAccount: b.va ? (b.subAccount === undefined ? b.va : b.subAccount) : null,
      referenceCode: 'referenceCode' in b ? String(b.referenceCode) : (c().reference_code_empty ? '' : `FT26${String(id).padStart(8, '0')}`),
      webhook: { status: 'pending', attempts: [] },
    };
    state.transactions.push(tx);
    return tx;
  }

  function payloadOf(tx) {
    return {
      id: tx.id, gateway: tx.gateway, transactionDate: tx.transactionDate, accountNumber: tx.accountNumber,
      subAccount: tx.va ? tx.subAccount : (c().subaccount_null ? null : ''), code: tx.code, content: tx.content, transferType: tx.transferType,
      description: `${tx.content} (${tx.gateway})`, transferAmount: tx.amount, accumulated: tx.accumulated, referenceCode: tx.referenceCode,
    };
  }

  function buildRequest(tx) {
    const p = payloadOf(tx);
    let body; let contentType;
    if (c().webhook_content_type === 'form') {
      body = new URLSearchParams(Object.entries(p).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])).toString();
      contentType = 'application/x-www-form-urlencoded';
    } else { body = JSON.stringify(p); contentType = 'application/json'; }
    const headers = { 'content-type': contentType };
    if (authMode === 'apikey') headers.authorization = `Apikey ${c().webhook_bad_auth ? `${apiKey}-wrong` : apiKey}`;
    if (authMode === 'hmac') {
      const ts = String(Math.floor(clock.now() / 1000) + Number(c().hmac_timestamp_skew_seconds || 0));
      const secret = c().webhook_bad_auth ? `${hmacSecret}-wrong` : hmacSecret;
      headers['x-sepay-timestamp'] = ts;
      headers['x-sepay-signature'] = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`; // ký trên RAW body (A4)
    }
    return { body, headers };
  }

  const isAckOk = (status, text) => {
    if (c().ack_mode === 'any2xx') return status >= 200 && status < 300;
    if (status !== 200 && status !== 201) return false;
    try { const j = JSON.parse(text); return !!j && j.success === true; } catch { return false; }
  };

  // Đối tượng mà job giao: giao dịch ngân hàng (webhook) hoặc thông báo IPN của cổng
  const targetOf = (job) => (job.kind === 'ipn' ? state.pgNotes.find((n) => n.id === job.txId) : state.transactions.find((t) => t.id === job.txId));

  async function deliver(job) {
    const tx = targetOf(job);
    if (!tx) return null;
    const entry = { copy: job.copy, attempt: job.attempt, at: clock.now(), manual: !!job.manual };
    const url = job.kind === 'ipn' ? (opts.pgIpnUrl || state.pgIpnUrl || webhookUrl()) : webhookUrl();
    let ok = false;
    try {
      if (!url) throw new Error('chưa cấu hình webhookUrl');
      const { body, headers } = job.kind === 'ipn' ? pg.ipnRequest(tx) : buildRequest(tx);
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      entry.httpStatus = r.status; entry.responseBody = text;
      ok = job.kind === 'ipn' ? r.status === 200 : isAckOk(r.status, text); // IPN của cổng: chỉ cần HTTP 200 (C4)
    } catch (e) { entry.error = String(e && e.message || e); }
    entry.ok = ok;
    tx.webhook.attempts.push(entry);
    state.log.push({ txId: tx.id, kind: job.kind || 'bank', ...entry });
    if (job.manual) { if (ok) tx.webhook.status = 'success'; return entry; }
    if (ok) { if (tx.webhook.status !== 'success') tx.webhook.status = 'success'; return entry; }
    const max = Number(c().webhook_retry_max_attempts);
    if (job.attempt < max) {
      const iv = c().webhook_retry_intervals_minutes;
      const mins = iv[Math.min(job.attempt - 1, iv.length - 1)];
      state.queue.push({ ...job, attempt: job.attempt + 1, due: clock.now() + mins * 60000 });
      if (tx.webhook.status !== 'success') tx.webhook.status = 'retrying';
    } else if (tx.webhook.status !== 'success') tx.webhook.status = 'failed';
    return entry;
  }

  async function dispatch(tx, kind) {
    const cc = c();
    if (cc.webhook_drop) { tx.webhook.status = 'dropped'; state.log.push({ txId: tx.id, at: clock.now(), dropped: true }); return; }
    const copies = Math.max(1, Number(cc.webhook_duplicate) || 1);
    const jobs = [];
    for (let i = 0; i < copies; i += 1) jobs.push({ kind, txId: tx.id, copy: i + 1, attempt: 1, due: clock.now() + Number(cc.webhook_delay_seconds || 0) * 1000 });
    if (cc.webhook_reorder) {
      if (!state.held.length) { state.held = jobs; tx.webhook.status = 'held'; return; }
      const older = state.held; state.held = [];
      await runJobs(jobs); await runJobs(older);
      return;
    }
    await runJobs(jobs);
  }

  async function runJobs(jobs) {
    for (const j of jobs) {
      if (j.due > clock.now()) { state.queue.push(j); const tx = targetOf(j); if (tx && tx.webhook.status === 'pending') tx.webhook.status = 'delayed'; } else await deliver(j);
    }
  }

  async function flushHeld() {
    const h = state.held; state.held = [];
    await runJobs(h);
    return h.length;
  }

  // Tua đồng hồ ảo, giao các job đến hạn theo đúng thời điểm (retry xếp chồng đúng lịch Fibonacci)
  async function advance(seconds) {
    if (typeof clock.advance !== 'function') throw new Error('clock không hỗ trợ advance');
    const target = clock.now() + Math.round(seconds * 1000);
    for (;;) {
      const due = state.queue.filter((j) => j.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      state.queue.splice(state.queue.indexOf(due), 1);
      if (due.due > clock.now()) clock.advance((due.due - clock.now()) / 1000);
      await deliver(due);
    }
    if (target > clock.now()) clock.advance((target - clock.now()) / 1000);
    return clock.now();
  }

  async function transfer(b) {
    const amount = Number(b && b.amount);
    if (!b || !Number.isInteger(amount) || amount <= 0) throw Object.assign(new Error('amount phải là số nguyên dương'), { code: 400 });
    if (b.va) return va.transferToVa(b);
    const tx = recordTransfer(b);
    await dispatch(tx);
    if (c().webhook_send_out && tx.transferType === 'in') {
      const out = recordTransfer({ content: 'Rut tien', amount: 1000, transferType: 'out' });
      await dispatch(out);
    }
    return tx;
  }

  // ---------- API v2 /transactions ----------
  const sortedAsc = () => state.transactions.slice().sort((a, b) => a.id - b.id);
  const apiRow = (tx) => ({
    id: apiId(tx), transaction_date: tx.transactionDate, account_number: tx.accountNumber, va: tx.va || null, transfer_type: tx.transferType,
    amount_in: tx.transferType === 'in' ? tx.amount : 0, amount_out: tx.transferType === 'out' ? tx.amount : 0, accumulated: tx.accumulated,
    transaction_content: tx.content, reference_number: tx.referenceCode, code: tx.code, bank_brand_name: tx.gateway,
    bank_account_id: bankAccountId, va_id: tx.vaId || null,
    webhook_success: tx.webhook.status === 'success' ? 1 : 0,
  });

  // Xác thực Bearer + giới hạn tốc độ cho mọi endpoint /v2. Trả true khi đã phản hồi lỗi (A8).
  function v2Guard(req, res) {
    state.apiCalls = (state.apiCalls || 0) + 1; // đếm mọi request /v2 (test kiểm số lần tra cứu)
    const limit = Number(c().api_rate_limit);
    const rl = { 'x-ratelimit-limit': String(limit) };
    const auth = req.headers.authorization;
    if (!auth) { sendJson(res, 401, { status: 'error', message: 'Missing Authorization header', error_code: 'unauthorized' }, rl); return true; }
    if (auth !== `Bearer ${apiToken}`) { sendJson(res, 401, { status: 'error', message: 'Invalid Auth token', error_code: 'unauthorized' }, rl); return true; }
    const now = clock.now();
    state.apiRequests = state.apiRequests.filter((t) => t > now - 1000);
    if (state.apiRequests.length >= limit) {
      sendJson(res, 429, { status: 'error', message: 'Too Many Requests', error_code: 'rate_limited' }, { ...rl, 'retry-after': '1', 'x-ratelimit-remaining': '0' });
      return true;
    }
    state.apiRequests.push(now);
    return false;
  }

  function handleList(req, res, q) {
    const rl = { 'x-ratelimit-limit': String(Number(c().api_rate_limit)) };
    if (v2Guard(req, res)) return;
    let rows = sortedAsc();
    const sinceId = q.get('since_id');
    if (sinceId) {
      const at = rows.findIndex((t) => apiId(t) === sinceId || String(t.id) === sinceId);
      rows = at < 0 ? [] : rows.slice(at + 1); // tăng dần sau since_id
    } else if (q.get('transaction_date_sort') !== 'asc') rows.reverse();
    const s = q.get('q');
    if (s) {
      const needle = s.toLowerCase();
      rows = rows.filter((t) => [t.referenceCode, t.content, t.code].some((f) => f && String(f).toLowerCase().includes(needle)));
    }
    const from = q.get('transaction_date_from'); const to = q.get('transaction_date_to');
    if (from) rows = rows.filter((t) => t.transactionDate >= (from.length <= 10 ? `${from} 00:00:00` : from));
    if (to) rows = rows.filter((t) => t.transactionDate <= (to.length <= 10 ? `${to} 23:59:59` : to));
    if (q.get('transfer_type')) rows = rows.filter((t) => t.transferType === q.get('transfer_type'));
    if (q.get('reference_number')) rows = rows.filter((t) => t.referenceCode === q.get('reference_number'));
    if (q.get('va_id')) rows = rows.filter((t) => t.vaId === q.get('va_id'));
    const perPage = Math.min(100, Math.max(1, Number(q.get('per_page')) || 20));
    const page = Math.max(1, Number(q.get('page')) || 1);
    const total = rows.length;
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    sendJson(res, 200, {
      status: 'success', data: rows.slice((page - 1) * perPage, page * perPage).map(apiRow),
      meta: { pagination: { total, per_page: perPage, current_page: page, last_page: lastPage, has_more: page < lastPage } },
    }, rl);
  }

  // ---------- ảnh QR: lỗi vẫn HTTP 200 text/html (A7) ----------
  function handleImg(res, q) {
    const acc = q.get('acc'); const bank = q.get('bank'); const amount = q.get('amount');
    const bad = !acc || !bank || (amount !== null && amount !== '' && !/^\d+$/.test(amount));
    if (bad) {
      const html = '<!DOCTYPE html><html><body>Invalid parameters</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_1X1.length });
    res.end(PNG_1X1);
  }

  // ---------- sản phẩm B (VA theo đơn) và C (cổng pay.sepay.vn) ----------
  const ctx = { state, clock, c, opts, sendJson, apiId, v2Guard, recordTransfer, dispatch, vnDate, accountNumber, bankName, bankAccountId, apiToken, crypto };
  const va = installVa(ctx);
  const pg = installPg(ctx);

  // ---------- route giả lập ----------
  const simView = (tx) => ({ ...tx, apiId: apiId(tx) });
  async function handleSim(req, res, path, body) {
    if (req.method === 'POST' && path === '/sim/transfer') {
      try {
        const tx = await transfer(body);
        return sendJson(res, 200, { transaction: simView(tx) });
      } catch (e) { return sendJson(res, e.code === 400 || e.code === 422 ? e.code : 500, { error: String(e.message) }); }
    }
    if (req.method === 'POST' && path === '/sim/clock/advance') {
      const now = await advance(Number(body.seconds) || 0);
      return sendJson(res, 200, { now });
    }
    if (req.method === 'GET' && path === '/sim/transactions') {
      return sendJson(res, 200, { now: clock.now(), transactions: state.transactions.map(simView), queue: state.queue, held: state.held, log: state.log, controls: state.controls, ...va.view(), ...pg.view() });
    }
    if (req.method === 'POST' && path === '/sim/control') {
      Object.assign(state.controls, body || {});
      return sendJson(res, 200, { ok: true, controls: state.controls });
    }
    if (req.method === 'POST' && path === '/sim/webhook/flush') return sendJson(res, 200, { released: await flushHeld() });
    const m = /^\/sim\/webhook\/(\d+)\/resend$/.exec(path);
    if (req.method === 'POST' && m) {
      const entry = await deliver({ txId: Number(m[1]), copy: 1, attempt: 1, manual: true });
      return entry ? sendJson(res, 200, entry) : sendJson(res, 404, { error: 'transaction not found' });
    }
    const mi = /^\/sim\/ipn\/(\d+)\/resend$/.exec(path);
    if (req.method === 'POST' && mi) {
      const entry = await deliver({ kind: 'ipn', txId: Number(mi[1]), copy: 1, attempt: 1, manual: true });
      return entry ? sendJson(res, 200, entry) : sendJson(res, 404, { error: 'notification not found' });
    }
    if (await pg.handleSim(req, res, path, body)) return undefined;
    if (await va.handleSim(req, res, path, body)) return undefined;
    return sendJson(res, 404, { error: 'unknown sim route' });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      try {
        const u = new URL(req.url, 'http://x');
        const path = u.pathname;
        if (path.startsWith('/sim/')) {
          let b = {};
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw) { try { b = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'bad json' }); } }
          return await handleSim(req, res, path, b);
        }
        if (req.method === 'GET' && path === '/img') return handleImg(res, u.searchParams);
        if (path.startsWith('/v1/')) return await pg.handle(req, res, u, Buffer.concat(chunks).toString('utf8'));
        if (path.startsWith('/v2/') && path !== '/v2/transactions' && await va.handle(req, res, u, Buffer.concat(chunks).toString('utf8'))) return undefined;
        if (req.method === 'GET' && path === '/v2/transactions') return handleList(req, res, u.searchParams);
        return sendJson(res, 404, { error: 'not found' });
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: String(e && e.message || e) });
      }
    });
  });

  await new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  return {
    port, url, clock, state, advance, transfer, flushHeld,
    setWebhookUrl(u) { state.webhookUrl = u; },
    config: { accountNumber, bankName, authMode, apiKey, hmacSecret, apiToken, codePrefix, bankAccountId, ...va.config, ...pg.config },
    va, pg,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startSimulator, DEFAULT_CONTROLS };

if (require.main === module) {
  const env = process.env;
  startSimulator({
    port: Number(env.SIM_PORT) || 0, accountNumber: env.SIM_ACCOUNT_NUMBER, bankName: env.SIM_BANK_NAME, webhookUrl: env.SIM_WEBHOOK_URL,
    authMode: env.SIM_AUTH_MODE, apiKey: env.SIM_API_KEY, hmacSecret: env.SIM_HMAC_SECRET, apiToken: env.SIM_API_TOKEN, codePrefix: env.SIM_CODE_PREFIX,
    vaBank: env.SIM_VA_BANK, pgMerchantId: env.SIM_PG_MERCHANT_ID, pgSecretKey: env.SIM_PG_SECRET_KEY,
  }).then((s) => {
    console.log(`SePay simulator: ${s.url} (account=${s.config.accountNumber}, authMode=${s.config.authMode})`);
  });
}

'use strict';
// spec: PHUB-S-037
// spec: PHUB-S-010
// spec: PHUB-S-014
// Lớp bảo vệ khi gọi cổng (PHUB-D-010): timeout ngoài, giới hạn đồng thời (bulkhead), circuit breaker, nhật ký mỗi lần gọi.
// Nằm trong Hub, bọc adapter; adapter không biết gì về lớp này.
// Quy tắc an toàn tiền: lỗi mang cờ notSent nghĩa là yêu cầu CHƯA rời khỏi Hub (breaker mở, hàng chờ đầy), nên chắc chắn
// chưa nhận tiền và được phép chuyển cổng. Timeout hoặc lỗi mạng KHÔNG mang cờ này: kết quả không rõ.

const NETWORK_METHODS = ['createPayment', 'query', 'cancel', 'capture', 'void', 'refund', 'queryRefund', 'reconcileFeed'];

const DEFAULTS = {
  timeoutMs: 15000,
  maxConcurrent: 100,
  maxQueue: 400,
  queueWaitMs: 5000,
  failureThreshold: 5,
  openSeconds: 30,
};

class GuardError extends Error {
  constructor(code, gateway, notSent) {
    super(`${gateway}: ${code}`);
    this.code = code;
    this.gateway = gateway;
    this.notSent = notSent;
  }
}

class GatewayGuard {
  /** @param {string} gateway @param {{clock:{now:()=>number}, onCall?:(e:Object)=>void}&Partial<typeof DEFAULTS>} o */
  constructor(gateway, o = {}) {
    this.gateway = gateway;
    this.cfg = { ...DEFAULTS, ...o };
    this.clock = o.clock || { now: () => Date.now() };
    this.onCall = o.onCall || (() => {});
    this.onChange = o.onChange || (() => {}); // gọi khi trạng thái breaker đổi (để lưu bền vững)
    this.state = 'closed'; // closed | open | half_open
    this.failures = 0; // lỗi liên tiếp
    this.openedAt = 0;
    this.probing = false;
    this.inflight = 0;
    this.queue = [];
    this.totals = { ok: 0, error: 0, timeout: 0, not_sent: 0 };
  }

  // Breaker không chặn: đóng, hoặc đã hết thời gian nghỉ (cho phép thử), và còn chỗ trong giới hạn đồng thời.
  available() {
    if (this.state === 'open' && this.clock.now() - this.openedAt < this.cfg.openSeconds * 1000) return false;
    if (this.state === 'half_open' && this.probing) return false;
    return this.inflight < this.cfg.maxConcurrent || this.queue.length < this.cfg.maxQueue;
  }

  /** Trạng thái cần lưu để sống qua khởi động lại. Nửa mở lưu như mở (lời gọi thử chưa chắc đã xong). */
  exportState() { return { state: this.state === 'closed' ? 'closed' : 'open', failures: this.failures, openedAt: this.openedAt }; }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    this.state = saved.state === 'open' ? 'open' : 'closed';
    this.failures = Number.isInteger(saved.failures) ? saved.failures : 0;
    this.openedAt = Number.isFinite(saved.openedAt) ? saved.openedAt : 0;
    this.probing = false;
  }

  status() {
    return { gateway: this.gateway, state: this.state, consecutiveFailures: this.failures, inflight: this.inflight, queued: this.queue.length, openedAt: this.state === 'closed' ? null : this.openedAt, totals: { ...this.totals } };
  }

  _admit() {
    if (this.state === 'open') {
      if (this.clock.now() - this.openedAt < this.cfg.openSeconds * 1000) throw new GuardError('circuit_open', this.gateway, true);
      this.state = 'half_open';
    }
    if (this.state === 'half_open') {
      if (this.probing) throw new GuardError('circuit_open', this.gateway, true);
      this.probing = true;
    }
  }

  async _slot() {
    if (this.inflight < this.cfg.maxConcurrent) { this.inflight += 1; return; }
    if (this.queue.length >= this.cfg.maxQueue) throw new GuardError('overloaded', this.gateway, true);
    await new Promise((resolve, reject) => {
      const w = { resolve };
      w.timer = setTimeout(() => { this.queue.splice(this.queue.indexOf(w), 1); reject(new GuardError('overloaded', this.gateway, true)); }, this.cfg.queueWaitMs);
      this.queue.push(w);
    });
    // slot đã được chuyển giao từ lời gọi vừa xong (inflight không đổi)
  }

  _release() {
    const next = this.queue.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); } else this.inflight -= 1;
  }

  _record(ok) {
    const before = JSON.stringify(this.exportState());
    if (ok) {
      this.failures = 0;
      if (this.state !== 'closed') { this.state = 'closed'; this.probing = false; }
    } else {
      this.failures += 1;
      if (this.state === 'half_open' || this.failures >= this.cfg.failureThreshold) {
        this.state = 'open';
        this.openedAt = this.clock.now();
        this.probing = false;
      }
    }
    if (JSON.stringify(this.exportState()) !== before) this.onChange(this.exportState());
  }

  /** Chạy fn() dưới sự bảo vệ. isFailure(result) cho phép coi một kết quả trả về là lỗi hạ tầng (ví dụ createPayment trả unknown). */
  async run(method, ref, fn, isFailure) {
    const at = this.clock.now();
    const started = process.hrtime.bigint();
    const log = (outcome, extra = {}) => {
      this.totals[outcome] += 1;
      this.onCall({ at, gateway: this.gateway, method, ref: ref || null, ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10, outcome, ...extra });
    };
    try {
      this._admit();
    } catch (err) { log('not_sent', { error: err.code }); throw err; }
    try {
      await this._slot();
    } catch (err) {
      if (this.probing && this.state === 'half_open') this.probing = false;
      log('not_sent', { error: err.code });
      throw err;
    }
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new GuardError('timeout', this.gateway, false)), this.cfg.timeoutMs); timer.unref(); }),
      ]);
      const bad = isFailure ? isFailure(result) : false;
      this._record(!bad);
      log(bad ? 'error' : 'ok', bad ? { error: 'unknown_result' } : {});
      return result;
    } catch (err) {
      this._record(false);
      log(err.code === 'timeout' ? 'timeout' : 'error', { error: String(err.message).slice(0, 200) });
      throw err;
    } finally {
      clearTimeout(timer);
      this._release();
    }
  }
}

const refOf = (arg) => (arg && (arg.attemptRef || arg.refundRef)) || null;

/** Bọc adapter: giữ nguyên mọi thuộc tính, chỉ đổi các phương thức gọi mạng. Trả {adapter, guard}. */
function guardAdapter(adapter, o) {
  const guard = new GatewayGuard(adapter.id, o);
  const wrapped = Object.create(adapter);
  for (const m of NETWORK_METHODS) {
    if (typeof adapter[m] !== 'function') continue;
    wrapped[m] = (arg, ...rest) => guard.run(m, refOf(arg), () => adapter[m](arg, ...rest), m === 'createPayment' ? (r) => !!r && r.status === 'unknown' : undefined);
  }
  return { adapter: wrapped, guard };
}

module.exports = { GatewayGuard, GuardError, guardAdapter, DEFAULTS, NETWORK_METHODS };

'use strict';
// spec: PHUB-S-011
// spec: PHUB-S-015
// spec: PHUB-S-017
// Sink webhook (PHUB-D-011, D-017): POST sự kiện tới một URL, ký HMAC-SHA256 trên `${timestamp}.${body}`.
// Không import gì từ lõi: nhận bản giao đã chuẩn hóa và tham số tuyến {url, secret, timeoutMs}.

const crypto = require('node:crypto');

const sign = (secret, timestamp, body) => crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

/** @returns {import('../../app/ports').Sink} */
function create({ fetch = globalThis.fetch } = {}) {
  return {
    kind: 'webhook',
    ordered: false,
    validate(route, name) {
      if (!/^https?:\/\//i.test(route.url || '')) throw new Error(`${name}.url phải là http(s)`);
      if (!route.secret) throw new Error(`${name}.secret là bắt buộc khi bật webhook`);
    },
    async deliver(delivery, route, { now }) {
      const ts = String(Math.floor(now() / 1000));
      const res = await fetch(route.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-event-id': delivery.eventId, 'x-hub-timestamp': ts, 'x-hub-signature': sign(route.secret, ts, delivery.body) },
        body: delivery.body,
        signal: AbortSignal.timeout(route.timeoutMs),
      });
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      if (res.status < 200 || res.status >= 300) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
      return { status: res.status };
    },
  };
}

/** @type {import('../../app/ports').OutboundModule} */
module.exports = { kind: 'webhook', create, sign };

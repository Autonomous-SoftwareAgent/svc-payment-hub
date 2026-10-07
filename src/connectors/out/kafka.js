'use strict';
// spec: PHUB-S-017
// Sink Kafka (PHUB-D-017): đưa sự kiện vào một topic. Key của bản ghi là key của sự kiện (paymentId) nên mọi sự kiện của một payment
// vào cùng một partition và đến đúng thứ tự; hộp thư đi (events.js) giữ thứ tự gửi cùng key cho sink có `ordered`.
// Giao ít nhất một lần (producer idempotent chỉ chống nhân đôi trong một phiên): người nhận loại trùng theo `id` của sự kiện.
// Topic phải tồn tại sẵn ở broker production (Hub không tự tạo topic).

const { sharedProducer } = require('../_kafka');

/** @returns {import('../../app/ports').Sink} */
function create(deps = {}) {
  return {
    kind: 'kafka',
    ordered: true,
    validate(route, name) {
      if (!route.topic || typeof route.topic !== 'string' || !/^[A-Za-z0-9._-]{1,249}$/.test(route.topic)) throw new Error(`${name}.topic không hợp lệ`);
      if (!deps.kafka || !Array.isArray(deps.kafka.brokers) || !deps.kafka.brokers.length) throw new Error(`${name}: sink kafka cần connectors.kafka.brokers`);
    },
    async deliver(delivery, route) {
      await sharedProducer(deps).send({
        topic: route.topic,
        timeout: route.timeoutMs,
        messages: [{
          key: delivery.key,
          value: delivery.body,
          headers: { 'hub-event-id': delivery.eventId, 'hub-event-type': delivery.type, 'hub-shop-id': delivery.shopId || 'default' },
        }],
      });
      return {};
    },
    async close() { if (deps._producer) await deps._producer.close(); },
  };
}

/** @type {import('../../app/ports').OutboundModule} */
module.exports = { kind: 'kafka', create };

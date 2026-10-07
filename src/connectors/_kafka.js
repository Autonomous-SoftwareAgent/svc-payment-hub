'use strict';
// spec: PHUB-S-032
// spec: PHUB-S-017
// Kết nối Kafka dùng chung cho sink ra và nguồn vào (PHUB-D-017). Tên bắt đầu bằng "_" nên registry không coi là connector.
// Thư viện kafkajs chỉ được nạp khi có connector Kafka thật sự chạy (kafkaFactory cho phép thay bằng đối tượng giả trong test).

const clients = new WeakMap();

/** Một client cho mỗi đối tượng cấu hình kafka: {brokers, clientId, ssl, sasl}. */
function kafkaClient(deps) {
  const cfg = deps.kafka;
  if (!cfg || !Array.isArray(cfg.brokers) || !cfg.brokers.length) throw new Error('thiếu connectors.kafka.brokers (danh sách "host:port")');
  let c = clients.get(cfg);
  if (!c) {
    if (deps.kafkaFactory) c = deps.kafkaFactory(cfg);
    else {
      const { Kafka, logLevel } = require('kafkajs');
      // Hạn thời gian có giới hạn (PHUB-D-032): mặc định của kafkajs (request 30 giây, thử lại 5 lần) làm một lần gửi tới broker đóng băng treo cả phút,
      // chặn vòng giao tin. Hết hạn thì lần giao lỗi và hộp thư đi tự thử lại theo backoff của nó.
      c = new Kafka({ clientId: cfg.clientId || 'payment-hub', brokers: cfg.brokers, ssl: cfg.ssl || false, connectionTimeout: cfg.connectionTimeoutMs || 3000, requestTimeout: cfg.requestTimeoutMs || 10000, ...(cfg.sasl ? { sasl: cfg.sasl } : {}), logLevel: logLevel.WARN });
    }
    clients.set(cfg, c);
  }
  return c;
}

/** Producer dùng chung (kết nối lười, một lần). idempotent + acks=all để không mất/nhân đôi bản ghi khi broker lỗi giữa chừng. */
function sharedProducer(deps) {
  if (deps._producer) return deps._producer;
  // DefaultPartitioner của kafkajs 2.x tương thích Java (murmur2): cùng key vào cùng partition như các client Kafka khác.
  const partitioner = deps.kafkaFactory ? {} : { createPartitioner: require('kafkajs').Partitioners.DefaultPartitioner };
  const p = kafkaClient(deps).producer({ idempotent: true, maxInFlightRequests: 1, retry: { retries: (deps.kafka || {}).retries ?? 2 }, ...partitioner });
  let ready = null;
  deps._producer = {
    async send(msg) {
      if (!ready) ready = p.connect().catch((e) => { ready = null; throw e; });
      await ready;
      return p.send({ acks: -1, ...msg });
    },
    async close() { if (ready) { ready = null; await p.disconnect(); } },
  };
  return deps._producer;
}

module.exports = { kafkaClient, sharedProducer };

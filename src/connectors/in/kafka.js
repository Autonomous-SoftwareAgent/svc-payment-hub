'use strict';
// spec: PHUB-S-017
// Nguồn vào Kafka (PHUB-D-017 mục 6): nhận LỆNH {commandId, op, input, shopId?} từ một topic, dịch sang app.command rồi commit.
//   - principal do cấu hình nguồn vào chỉ định ({role:'admin'} tin cậy hoặc {role:'shop', id} gắn cứng một cửa hàng), KHÔNG lấy từ thông điệp.
//   - hiệu ứng đúng một lần theo commandId và phản hồi command.completed/failed do app.command lo (cùng transaction).
//   - thông điệp hỏng (không phải JSON, sai phong bì) -> topic DLQ rồi commit, không chặn partition.
//   - lỗi hạ tầng tạm thời -> KHÔNG commit: thử lại với chờ tăng dần (giữ nhịp heartbeat) cho tới khi xong; không bỏ qua thông điệp nào.
// handle() là lõi kiểm thử được bằng đối tượng giả; start() nối với consumer thật của kafkajs.

const { kafkaClient, sharedProducer } = require('../_kafka');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{app: import('../../app/app').App, config: Object, deps?: Object, log?: Function}} o
 * @returns {import('../../app/ports').InboundConnector}
 */
function create({ app, config, deps = {}, log = () => {} }) {
  const name = `connectors.in(${config.id})`;
  const p = config.principal || {};
  if (!['admin', 'shop'].includes(p.role) || (p.role === 'shop' && !/^[a-z0-9_-]{1,32}$/.test(p.id || ''))) throw new Error(`${name}.principal phải là {role:"admin"} hoặc {role:"shop", id}`);
  if (!config.topic || !config.groupId) throw new Error(`${name} cần topic và groupId`);
  const principal = p.role === 'admin' ? { role: 'admin' } : { role: 'shop', id: p.id };
  const dlqTopic = config.dlqTopic || `${config.topic}.dlq`;
  let consumer = null;
  let stopping = false;

  async function toDlq(message, reason) {
    await sharedProducer(deps).send({ topic: dlqTopic, messages: [{ key: message.key, value: message.value, headers: { reason: String(reason).slice(0, 200), 'source-topic': config.topic } }] });
    log({ level: 'warn', msg: 'command_dlq', source: config.id, reason: String(reason).slice(0, 200) });
  }

  /** Xử lý một thông điệp. Trả khi đã có kết quả chính thức (xong, trùng, hoặc đã vào DLQ); ném lỗi tạm thời để bên gọi thử lại. */
  async function handle(message) {
    let cmd;
    try { cmd = JSON.parse(Buffer.from(message.value).toString('utf8')); } catch { return toDlq(message, 'không phải JSON'); }
    try {
      await app.command(cmd, principal);
    } catch (err) {
      if (err && err.code === 'invalid_command') return toDlq(message, err.message);
      throw err;
    }
  }

  async function start() {
    consumer = kafkaClient(deps).consumer({ groupId: config.groupId });
    await consumer.connect();
    await consumer.subscribe({ topic: config.topic, fromBeginning: config.fromBeginning === true });
    await consumer.run({
      eachMessage: async ({ message, heartbeat }) => {
        let delay = config.retryDelayMs || 500;
        for (;;) {
          try { await handle(message); return; } catch (err) {
            if (stopping) throw err;
            log({ level: 'error', msg: 'command_retry', source: config.id, error: String(err && err.message).slice(0, 200) });
            const until = Date.now() + delay;
            while (Date.now() < until && !stopping) { await wait(Math.min(1000, until - Date.now())); await heartbeat(); }
            delay = Math.min(delay * 2, config.retryMaxDelayMs || 15000);
          }
        }
      },
    });
  }

  async function stop() {
    stopping = true;
    if (consumer) await consumer.disconnect();
  }

  return { kind: 'kafka', handle, start, stop };
}

/** @type {import('../../app/ports').InboundModule} */
module.exports = { kind: 'kafka', create };

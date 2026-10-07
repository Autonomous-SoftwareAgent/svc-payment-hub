// Demo chạy trên máy host, nói chuyện với Hub và MoMo giả đang chạy trong Docker (docker-compose.yml).
// Kiểm: tạo thanh toán qua API, khách trả ở cổng giả, cổng gọi IPN về Hub, Hub ghi PAID, idempotent, 401 khi không token.
const HUB = process.env.HUB_URL || 'http://127.0.0.1:8080';
const SIM = process.env.SIM_URL || 'http://127.0.0.1:8081';
const TOKEN = process.env.HUB_API_TOKEN || 'local-dev-token-not-for-production';

const hub = async (method, path, body, token = TOKEN) => {
  const r = await fetch(HUB + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };

(async () => {
  const health = await fetch(`${HUB}/health`);
  check('Hub /health', health.status === 200, `status=${health.status}`);

  check('không token thì 401', (await hub('POST', '/payments', { orderId: 'X' }, null)).status === 401);

  const orderId = `DEMO${Date.now()}`;
  const body = { orderId, amount: 150000, returnUrl: 'https://shop.example/return' };
  const created = await hub('POST', '/payments', body);
  check('tạo thanh toán (201)', created.status === 201 && created.json.attempt.url, `gateway=${created.json && created.json.attempt && created.json.attempt.gateway} url=${created.json && created.json.attempt && created.json.attempt.url}`);
  const again = await hub('POST', '/payments', body);
  check('tạo lại cùng orderId trả cùng payment (200, idempotent)', again.status === 200 && again.json.payment.id === created.json.payment.id);

  const pay = await fetch(`${SIM}/sim/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: created.json.attempt.ref, outcome: 'success' }) });
  check('khách trả ở cổng giả', pay.status === 200, `status=${pay.status}`);

  const got = await hub('GET', `/payments/${created.json.payment.id}`);
  check('IPN từ cổng giả về tới Hub, payment PAID', got.json && got.json.payment.status === 'PAID', `status=${got.json && got.json.payment.status}`);
  check('không có anomaly', got.json && got.json.anomalies.length === 0);

  // Lớp kết nối dịch vụ (PHUB-D-017): sự kiện ra topic và lệnh vào qua Kafka (Redpanda ở 127.0.0.1:19092 khi chạy một mình; trong hệ chung ở `BSN_/infra` broker là 127.0.0.1:19192, đặt KAFKA_BROKER=127.0.0.1:19192).
  const { Kafka, logLevel } = require('kafkajs');
  const kafka = new Kafka({ clientId: 'demo', brokers: [process.env.KAFKA_BROKER || '127.0.0.1:19092'], logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: 'demo-' + Date.now() });
  const events = [];
  await consumer.connect();
  await consumer.subscribe({ topic: 'payment.events.v1', fromBeginning: true });
  await consumer.run({ eachMessage: async ({ message }) => { events.push(JSON.parse(message.value.toString())); } });
  const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };
  const paid = await waitFor(() => events.find((e) => e.type === 'payment.paid' && e.data.paymentId === created.json.payment.id));
  check('sự kiện payment.paid của giao dịch vừa trả có trên topic payment.events.v1', !!paid, paid ? `key=${paid.key} id=${paid.id}` : 'không thấy');
  const producer = kafka.producer();
  await producer.connect();
  const cmd = { commandId: `demo-${Date.now()}`, op: 'createPayment', input: { orderId: `KAFKA${Date.now()}`, amount: 90000, returnUrl: 'https://shop.example/return' } };
  for (let i = 0; i < 2; i++) await producer.send({ topic: 'payment.commands.v1', messages: [{ key: cmd.commandId, value: JSON.stringify(cmd) }] }); // gửi trùng có chủ ý
  const reply = await waitFor(() => events.find((e) => e.type === 'command.completed' && e.key === cmd.commandId));
  check('lệnh createPayment qua Kafka được xử lý và có phản hồi command.completed', !!reply && reply.data.result.payment.orderId === cmd.input.orderId, reply ? `paymentId=${reply.data.result.payment.id}` : 'không thấy phản hồi');
  await new Promise((r) => setTimeout(r, 1500));
  check('lệnh gửi trùng chỉ có một phản hồi (đúng một lần theo commandId)', events.filter((e) => e.key === cmd.commandId).length === 1);
  await producer.disconnect();
  await consumer.disconnect();

  console.log(`PAYMENT_ID=${created.json.payment.id}`);
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `\n${failed} kiểm tra thất bại` : '\nTất cả kiểm tra đạt');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Lỗi:', e.message); process.exit(1); });

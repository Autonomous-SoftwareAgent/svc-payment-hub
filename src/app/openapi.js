'use strict';
// spec: PHUB-S-017
// Sinh OpenAPI 3.1 từ danh mục thao tác, danh mục sự kiện và schema đặt tên (PHUB-D-017): không viết tay, nên không lệch với code.
//  - paths: mọi thao tác có bindings.http, cộng route của máy chủ HTTP không nằm trong danh mục (health, metrics, callback cổng, openapi).
//  - webhooks (OpenAPI 3.1): các sự kiện Hub gửi ra ngoài (cùng phong bì dùng cho Kafka).
//  - x-kafka: định dạng lệnh vào và sự kiện ra qua broker.

const { httpStatusFor } = require('./errors');

const refs = (node) => {
  if (Array.isArray(node)) return node.map(refs);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' ? `#/components/schemas/${v}` : refs(v)]));
  }
  return node;
};

const json = (schema) => ({ 'application/json': { schema: refs(schema) } });
const errorSchema = { $ref: 'Error' };

function paramsOf(op, pathNames, method) {
  const props = op.input.properties || {};
  const req = new Set(op.input.required || []);
  const params = pathNames.map((n) => ({ name: n, in: 'path', required: true, schema: refs(props[n] || { type: 'string' }) }));
  if (method === 'GET') {
    for (const [k, v] of Object.entries(props)) if (!pathNames.includes(k)) params.push({ name: k, in: 'query', required: req.has(k), schema: refs(v), ...(v.description ? { description: v.description } : {}) });
  }
  return params;
}

function bodyOf(op, pathNames) {
  const props = Object.fromEntries(Object.entries(op.input.properties || {}).filter(([k]) => !pathNames.includes(k)));
  if (!Object.keys(props).length) return undefined;
  const required = (op.input.required || []).filter((k) => !pathNames.includes(k));
  return { required: required.length > 0, content: json({ type: 'object', ...(required.length ? { required } : {}), properties: props }) };
}

function errorResponses(op) {
  const byStatus = {};
  const add = (code) => { const s = httpStatusFor(code); (byStatus[s] = byStatus[s] || []).push(code); };
  for (const c of ['invalid_input', ...op.errors]) add(c);
  add('unauthorized');
  if (!op.roles.includes('shop')) add('forbidden');
  const out = {};
  for (const [s, codes] of Object.entries(byStatus)) out[s] = { description: `Mã lỗi: ${[...new Set(codes)].join(', ')}`, content: json(errorSchema) };
  out['429'] = { description: 'Quá giới hạn tốc độ (rate_limited); có header Retry-After', content: json(errorSchema) };
  out['503'] = out['503'] || { description: 'Hub quá tải (overloaded); có header Retry-After', content: json(errorSchema) };
  return out;
}

const hostPaths = {
  '/health': { get: { operationId: 'health', summary: 'Hub còn sống (công khai)', security: [], responses: { 200: { description: 'OK', content: json({ type: 'object', properties: { ok: { type: 'boolean' } } }) } } } },
  '/metrics': { get: { operationId: 'metrics', summary: 'Số đo dạng Prometheus (token quản trị hoặc metrics)', responses: { 200: { description: 'Văn bản Prometheus', content: { 'text/plain': { schema: { type: 'string' } } } }, 401: { description: 'Thiếu hoặc sai token' }, 403: { description: 'Token cửa hàng không được dùng' } } } },
  '/openapi.json': { get: { operationId: 'openapi', summary: 'Tài liệu OpenAPI này', responses: { 200: { description: 'OpenAPI 3.1', content: { 'application/json': { schema: { type: 'object' } } } } } } },
};
for (const channel of ['ipn', 'return']) {
  const gw = { name: 'gateway', in: 'path', required: true, schema: { type: 'string' }, description: 'Mã cổng (id adapter đang bật, xem GET /gateways)' };
  const desc = channel === 'ipn'
    ? 'Thông báo của cổng thanh toán (IPN/webhook). Không dùng Bearer: mỗi adapter tự xác thực callback (chữ ký của cổng). Phản hồi là ack do adapter dựng theo yêu cầu của cổng.'
    : 'Cổng chuyển trình duyệt của khách về. Chỉ hiển thị: Hub không đổi trạng thái, chuyển hướng 302 về returnUrl của cửa hàng kèm paymentId, status, attempt.';
  const op = { operationId: `${channel}Gateway`, summary: desc, security: [], parameters: [gw], responses: channel === 'ipn' ? { default: { description: 'Ack theo định dạng của từng cổng' } } : { 302: { description: 'Chuyển về returnUrl của cửa hàng' }, 404: { description: 'Không tìm thấy giao dịch' } } };
  hostPaths[`/${channel}/{gateway}`] = { get: { ...op, operationId: `${op.operationId}Get` }, post: { ...op, operationId: `${op.operationId}Post` } };
}

/** @param {{operations:Object, schemas:Object, eventTypes:Object, version?:string}} o */
function buildOpenApi({ operations, schemas, eventTypes, version = '0.0.0' }) {
  const paths = {};
  for (const [name, op] of Object.entries(operations)) {
    const b = op.bindings && op.bindings.http;
    if (!b) continue;
    const pathNames = [...b.path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
    const entry = paths[b.path] = paths[b.path] || {};
    const body = b.method === 'POST' ? bodyOf(op, pathNames) : undefined;
    const responses = Object.fromEntries(b.statuses.map((s) => [s, { description: 'Thành công', content: json(op.output) }]));
    entry[b.method.toLowerCase()] = {
      operationId: name,
      summary: op.summary,
      'x-roles': op.roles,
      parameters: paramsOf(op, pathNames, b.method),
      ...(body ? { requestBody: body } : {}),
      responses: { ...responses, ...errorResponses(op) },
    };
  }
  Object.assign(paths, hostPaths);

  const webhooks = {};
  for (const [type, ev] of Object.entries(eventTypes)) {
    webhooks[type] = {
      post: {
        operationId: `event_${type.replace(/\./g, '_')}`,
        summary: ev.summary,
        description: 'Hub gửi tới URL của cửa hàng (hoặc đưa vào Kafka). Ký HMAC-SHA256 trên `${x-hub-timestamp}.${body}` bằng secret của cửa hàng. Giao ít nhất một lần: loại trùng theo `id`.',
        parameters: ['x-hub-event-id', 'x-hub-timestamp', 'x-hub-signature'].map((n) => ({ name: n, in: 'header', required: true, schema: { type: 'string' } })),
        requestBody: { required: true, content: json({ allOf: [{ $ref: 'Event' }, { type: 'object', properties: { type: { const: type }, data: { $ref: ev.data } } }] }) },
        responses: { '2xx': { description: 'Đã nhận. Mọi trạng thái khác 2xx hoặc quá hạn: Hub gửi lại theo bậc rồi đánh dấu dead.' } },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Payment Hub API', version, description: 'Điều phối nhiều cổng thanh toán. Sinh tự động từ danh mục thao tác và sự kiện của Hub (không sửa tay).' },
    security: [{ bearerAuth: [] }],
    paths,
    webhooks,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token cửa hàng (chỉ thấy dữ liệu của mình) hoặc token quản trị' } },
      schemas: refs(schemas),
    },
    'x-kafka': {
      description: 'Kết nối qua broker (tùy cấu hình connectors). Lệnh vào dùng schema Command; sự kiện ra dùng schema Event, key là Event.key.',
      command: { schema: 'Command', operations: Object.keys(operations) },
      events: { schema: 'Event', types: Object.keys(eventTypes) },
    },
  };
}

module.exports = { buildOpenApi };

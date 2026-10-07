'use strict';
// spec: PHUB-S-017
// Cổng vào chuẩn của Hub (PHUB-D-017): mọi connector vào (HTTP, Kafka, ...) gọi execute() và chỉ làm việc dịch
// thông điệp của transport thành {op, input, principal}. Kiểm vai trò, kiểm schema đầu vào, gọi lõi, trả view an toàn.
// Không import hub.js, store hay adapter cổng: nhận hub qua tham số (trục kết nối dịch vụ tách khỏi trục cổng thanh toán).

const { AppError } = require('./errors');
const { operations } = require('./operations');
const { schemas } = require('./schemas');
const { validate } = require('./schema');
const { executeCommand } = require('./commands');
const { assertHubPort } = require('./ports');

/**
 * Cổng vào chuẩn đã dựng.
 * @typedef {Object} App
 * @property {(op: string, input: Object, principal: {role: string, id?: string}) => Promise<*>} execute
 * @property {(cmd: Object, principal: {role: string, id?: string}) => Promise<{status: string, error?: string}>} command
 * @property {() => Object} operations
 */

/**
 * @param {{hub?: import('./ports').HubPort, getHub?: () => import('./ports').HubPort, checkOutput?: boolean}} o  checkOutput: kiểm đầu ra theo schema (dùng trong test hợp đồng)
 * @returns {App}
 */
function createApp({ hub, getHub, checkOutput = false }) {
  let checked = false;
  // Hub được kiểm hình dạng (HubPort) ở lần dùng đầu: getHub có thể trả Hub dựng sau, và server dựng app trước khi có Hub.
  /** @returns {import('./ports').HubPort} */
  const H = () => {
    const h = getHub ? getHub() : hub;
    if (!checked) { assertHubPort(h); checked = true; }
    return h;
  };

  async function execute(name, input, principal) {
    const op = operations[name];
    if (!op) throw new AppError('unknown_operation', `không có thao tác ${name}`);
    if (!principal || !op.roles.includes(principal.role)) throw new AppError('forbidden', 'principal không được dùng thao tác này');
    const given = input === undefined || input === null ? {} : input;
    const errors = validate(op.input, given, schemas);
    if (errors.length) throw new AppError('invalid_input', errors.slice(0, 3).join('; '));
    const out = await op.run({ hub: H(), input: given, principal });
    if (checkOutput) {
      const bad = validate(op.output, out, schemas);
      if (bad.length) throw new Error(`đầu ra của ${name} lệch schema: ${bad.slice(0, 3).join('; ')}`);
    }
    return out;
  }

  /** Lệnh nhận qua broker: hiệu ứng đúng một lần theo commandId, kết quả thành sự kiện command.completed/failed. */
  const command = (cmd, principal) => executeCommand({ hub: H(), execute }, cmd, principal);

  return { execute, command, operations: () => operations };
}

module.exports = { createApp };

'use strict';
// spec: PHUB-S-017
// Lệnh nhận qua broker (PHUB-D-017 mục 6): hiệu ứng ĐÚNG MỘT LẦN theo commandId.
// Khóa đã thấy, thay đổi trạng thái do thao tác gây ra và sự kiện phản hồi (command.completed hoặc command.failed) nằm trong
// CÙNG một transaction (hub.transact), nên không có cửa sổ "đã làm mà chưa báo" hoặc "báo mà chưa làm".
//   - Lỗi nghiệp vụ (có code) là kết quả chính thức: ghi phản hồi failed, bên gọi commit offset.
//   - Lỗi hạ tầng bất ngờ (không có code, ví dụ mất DB): bỏ khóa, ném lên để bên gọi KHÔNG commit và nhận lại lệnh sau.

const { validate } = require('./schema');
const { schemas } = require('./schemas');

/**
 * Trả {status: 'completed'|'failed'|'duplicate'} hoặc ném lỗi hạ tầng. Phong bì sai schema thì ném {code:'invalid_command'}.
 * @param {{hub: import('./ports').HubPort, execute: (op: string, input: Object, principal: Object) => Promise<*>}} ctx
 * @param {{commandId: string, op: string, input?: Object, shopId?: string}} cmd
 * @param {{role: string, id?: string}} principal
 */
async function executeCommand({ hub, execute }, cmd, principal) {
  const bad = validate(schemas.Command, cmd, schemas);
  if (bad.length) { const e = new Error(`lệnh sai phong bì: ${bad.slice(0, 3).join('; ')}`); e.code = 'invalid_command'; throw e; }
  const key = 'cmd|' + cmd.commandId;
  const input = { ...(cmd.input || {}) };
  if (principal.role === 'admin' && cmd.shopId && input.shopId === undefined) input.shopId = cmd.shopId;
  const shopId = principal.role === 'shop' ? principal.id : (cmd.shopId || input.shopId || 'default');
  await hub.store.hydrateSeen(key);
  let outcome;
  await hub.transact(async () => {
    if (hub.store.markSeen(key)) { outcome = { status: 'duplicate' }; return; }
    try {
      const result = await execute(cmd.op, input, principal);
      hub.events.emit('command.completed', cmd.commandId, 'result', { commandId: cmd.commandId, op: cmd.op, result }, shopId, { key: cmd.commandId });
      outcome = { status: 'completed' };
    } catch (err) {
      if (!err || !err.code) { hub.store.forget(key); throw err; }
      hub.events.emit('command.failed', cmd.commandId, 'result', { commandId: cmd.commandId, op: cmd.op, error: err.code, message: String(err.message || '') }, shopId, { key: cmd.commandId });
      outcome = { status: 'failed', error: err.code };
    }
  });
  return outcome;
}

module.exports = { executeCommand };

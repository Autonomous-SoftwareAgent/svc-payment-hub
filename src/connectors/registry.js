'use strict';
// spec: PHUB-S-017
// Registry connector (PHUB-D-017): THÊM MỚI, KHÔNG SỬA CŨ. Mỗi connector là một tệp trong src/connectors/{in,out}/ xuất
// {kind, create}; registry quét thư mục nên thêm connector chỉ là thêm một tệp, không đổi file nào đang có.
// extraDirs cho phép đặt connector ngoài cây mã nguồn (cấu hình connectors.dirs hoặc test) mà vẫn không sửa gì.

const fs = require('node:fs');
const path = require('node:path');
const { assertSink } = require('../app/ports');

function discover(direction, extraDirs = []) {
  const dirs = [path.join(__dirname, direction), ...extraDirs.map((d) => path.join(path.resolve(d), direction))];
  const found = new Map();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.startsWith('_')).sort()) {
      const mod = require(path.join(dir, f));
      if (!mod || !mod.kind || typeof mod.create !== 'function') throw new Error(`connector ${direction}/${f} phải xuất {kind, create}`);
      if (found.has(mod.kind)) throw new Error(`connector ${direction}: trùng kind "${mod.kind}" (${f})`);
      found.set(mod.kind, mod);
    }
  }
  return found;
}

/**
 * Dựng mọi sink ra ngoài: {kind: Sink} (port Sink: src/app/ports.js); mỗi sink dựng ra được kiểm hình dạng ngay.
 * deps được chuyển nguyên cho create() (fetch, kafka...). Sink tự lo kết nối lười.
 * @returns {Object<string, import('../app/ports').Sink>}
 */
function buildSinks(deps = {}, { extraDirs = [] } = {}) {
  const sinks = {};
  for (const [kind, mod] of discover('out', extraDirs)) {
    const sink = mod.create(deps);
    assertSink(sink, `connectors/out/${kind}`);
    if (sink.kind !== kind) throw new Error(`connectors/out/${kind}: sink.kind (${sink.kind}) khác kind của mô-đun`);
    sinks[kind] = sink;
  }
  return sinks;
}

/**
 * Các nguồn vào chạy nền (Kafka, ...): {kind: InboundModule} (port: src/app/ports.js). HTTP do server gọi trực tiếp, không chạy nền.
 * @returns {Map<string, import('../app/ports').InboundModule>}
 */
function inboundKinds({ extraDirs = [] } = {}) {
  return discover('in', extraDirs);
}

module.exports = { buildSinks, inboundKinds, discover };

'use strict';
// spec: PHUB-S-001
// spec: PHUB-S-023
// Điểm vào của Payment Hub: lõi, store, hợp đồng adapter và các adapter cổng (lấy từ registry, không liệt kê từng cổng ở đây).
const { discover } = require('./adapters/registry');

module.exports = {
  ...require('./hub'),
  ...require('./store'),
  ...require('./store-postgres'),
  contract: require('./contract'),
  discoverAdapters: discover,
  // { vnpay: create, momo: create, ... } theo các adapter có trong src/adapters/
  adapters: Object.fromEntries([...discover().values()].map((m) => [m.id, m.create])),
};

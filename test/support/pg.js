'use strict';
// spec: PHUB-S-007
// Hạ tầng test cần PostgreSQL thật. Đặt HUB_TEST_DATABASE_URL, ví dụ sau khi chạy:
//   docker run -d --name bsn-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17
//   HUB_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
// Mỗi test dùng một schema riêng nên không đụng nhau; không đặt biến thì các test cần DB bị bỏ qua (có ghi lý do).
const crypto = require('node:crypto');
const { PostgresStore } = require('../../src/store-postgres');

const PG_URL = process.env.HUB_TEST_DATABASE_URL || '';
const SKIP = PG_URL ? false : 'đặt HUB_TEST_DATABASE_URL (PostgreSQL) để chạy test này, xem test/support/pg.js';

const uniqueSchema = () => `t_${crypto.randomBytes(6).toString('hex')}`;

// Tạo một schema sạch; trả {url, schema, open(), cleanup()}. open() mở một PostgresStore mới trên cùng schema.
function freshDb() {
  const schema = uniqueSchema();
  const opened = [];
  return {
    url: PG_URL,
    schema,
    async open() {
      const s = await PostgresStore.open(PG_URL, { schema });
      opened.push(s);
      return s;
    },
    async cleanup() {
      for (const s of opened) await s.close().catch(() => {});
      await PostgresStore.dropSchema(PG_URL, schema);
    },
  };
}

module.exports = { PG_URL, SKIP, freshDb, uniqueSchema };

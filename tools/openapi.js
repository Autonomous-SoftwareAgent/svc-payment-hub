'use strict';
// spec: PHUB-S-017
// Sinh docs/_generated/openapi.json từ danh mục thao tác và sự kiện (PHUB-D-017): node tools/openapi.js
// Test (test/hub/app-contract.test.js) so tệp này với tài liệu sinh từ code nên không thể lệch.
const fs = require('node:fs');
const path = require('node:path');
const { operations } = require('../src/app/operations');
const { schemas, eventTypes } = require('../src/app/schemas');
const { buildOpenApi } = require('../src/app/openapi');

const file = path.join(__dirname, '..', 'docs', '_generated', 'openapi.json');
const doc = buildOpenApi({ operations, schemas, eventTypes, version: require('../package.json').version });
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
console.log(`đã ghi ${path.relative(process.cwd(), file)} (${Object.keys(doc.paths).length} đường dẫn, ${Object.keys(doc.webhooks).length} sự kiện)`);

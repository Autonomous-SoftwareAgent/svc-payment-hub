'use strict';
// spec: PHUB-S-017
// Bộ kiểm schema tối thiểu (tập con của JSON Schema) cho danh mục thao tác và sự kiện (PHUB-D-017).
// Một nguồn sự thật: cùng schema dùng để kiểm đầu vào, kiểm đầu ra trong test và sinh OpenAPI.
// Hỗ trợ: type (một hoặc nhiều, gồm "null"), enum, properties, required, items, minLength, minimum, maximum,
// additionalProperties:false, $ref theo tên trong bảng schema. Khóa "x-*", "description", "example" bị bỏ qua.

const TYPE_CHECK = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/** Trả danh sách lỗi (rỗng nếu hợp lệ). `defs` là bảng schema đặt tên cho $ref. */
function validate(schema, value, defs = {}, path = '$') {
  if (!schema) return [];
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', ''); // chấp nhận cả dạng tên và dạng tham chiếu OpenAPI
    const target = defs[name];
    if (!target) return [`${path}: schema ${schema.$ref} không tồn tại`];
    return validate(target, value, defs, path);
  }
  if (schema.oneOf) {
    const failures = schema.oneOf.map((s) => validate(s, value, defs, path));
    return failures.some((f) => !f.length) ? [] : [`${path}: không khớp schema nào trong oneOf (${failures[0][0] || ''})`];
  }
  const errors = [];
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => TYPE_CHECK[t](value))) return [`${path}: phải là ${types.join(' hoặc ')}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: phải là một trong ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: dài ít nhất ${schema.minLength} ký tự`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: sai định dạng`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: nhỏ nhất ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: lớn nhất ${schema.maximum}`);
  }
  if (TYPE_CHECK.object(value)) {
    for (const k of schema.required || []) if (value[k] === undefined) errors.push(`${path}.${k}: bắt buộc`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (value[k] !== undefined) errors.push(...validate(sub, value[k], defs, `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(schema.properties || {})[k]) errors.push(`${path}.${k}: không có trong schema`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, defs, `${path}[${i}]`)));
  return errors;
}

module.exports = { validate };

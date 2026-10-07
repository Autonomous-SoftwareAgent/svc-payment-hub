'use strict';
// spec: VNPS-S-005, VNPS-S-010
const test = require('node:test');
const assert = require('node:assert');
const { createVnpayAdapter } = require('../../src/adapters/vnpay');
const { ACK_OUTCOMES } = require('../../src/contract');

test('ack(outcome) tra JSON {RspCode,Message} theo bang 00/01/02/04/97/99', () => {
  const a = createVnpayAdapter({ tmnCode: 'TESTTMN1', hashSecret: 's' }, {});
  const cb = a.parseCallback({ channel: 'ipn', method: 'GET', query: {}, body: null, headers: {} });
  assert.strictEqual(cb.valid, false);
  const expected = { ok: '00', duplicate: '02', unknown_attempt: '01', amount_mismatch: '04', invalid_signature: '97', error: '99' };
  assert.deepStrictEqual(Object.keys(expected).sort(), [...ACK_OUTCOMES].sort());
  for (const [outcome, code] of Object.entries(expected)) {
    const r = cb.ack(outcome);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.contentType, 'application/json');
    const j = JSON.parse(r.body);
    assert.strictEqual(j.RspCode, code);
    assert.ok(j.Message);
  }
  assert.strictEqual(JSON.parse(cb.ack('khong-biet').body).RspCode, '99');
});

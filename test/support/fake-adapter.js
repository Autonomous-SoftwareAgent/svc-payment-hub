'use strict';
// spec: PHUB-S-018
// spec: PHUB-S-005
// Adapter giả điều khiển được từ test, dùng để kiểm tra lõi Hub độc lập với mọi cổng thật.

function createFakeAdapter(id, opts = {}) {
  const caps = {
    hardExpiry: 'unknown',
    cancellable: false,
    queryable: true,
    refundable: 'api',
    refundAsync: true,
    createCanTimeout: false,
    ...(opts.caps || {}),
  };
  const fake = {
    id,
    created: [],
    queryResults: new Map(), // attemptRef -> sự kiện chuẩn hoặc {state}
    refundStatus: 'processing',
    queryRefundStatus: 'succeeded',
    createMode: 'redirect', // redirect | unknown | rejected | throw | post_form | instructions | bad_instructions
    captureMode: 'captured', // captured | rejected | unknown | throw | not_sent
    voidMode: 'voided', // voided | rejected | unknown | throw | not_sent
    nextAction: undefined, // createMode 'next_action': createPayment trả {status:'next_action', nextAction}
    createState: undefined, // nếu đặt: createPayment trả kèm state (PHUB-D-018, P2)
    calls: { query: [], refund: [], queryRefund: [], cancel: [], capture: [], void: [] }, // tham số đã nhận, để test kiểm state/receipts
    cancelled: [],
    capabilities: () => caps,
    async createPayment(p) {
      fake.created.push(p);
      const st = fake.createState !== undefined ? { state: fake.createState } : {};
      if (fake.createMode === 'next_action') return { status: 'next_action', nextAction: fake.nextAction, ...st };
      if (fake.createMode === 'unknown') return { status: 'unknown' };
      if (fake.createMode === 'rejected') return { status: 'rejected', reason: 'fake_rejected' };
      if (fake.createMode === 'throw') throw new Error('network');
      if (fake.createMode === 'post_form') return { status: 'redirect', url: `https://fake.test/${id}/checkout`, method: 'POST', fields: { order: p.attemptRef, signature: 'SIG' }, ...st };
      if (fake.createMode === 'bad_instructions') return { status: 'instructions', instructions: { bank: 'TESTBANK' } };
      if (fake.createMode === 'instructions') return { status: 'instructions', instructions: { bank: 'TESTBANK', accountNumber: '0123456789', transferContent: p.attemptRef, amount: p.amount }, ...st };
      return { status: 'redirect', url: `https://fake.test/${id}/${p.attemptRef}`, ...st };
    },
    // body: {valid?, ref, type, amount, txn, source}
    parseCallback(req) {
      const b = req.body || {};
      const ack = (o) => ({ status: o === 'invalid_signature' ? 400 : 200, body: o, contentType: 'text/plain' });
      if (b.valid === false) return { valid: false, ack };
      if (b.retryLater) return { valid: true, retryLater: true, reason: 'lookup_failed', ack: (o) => ({ status: o === 'error' ? 503 : 200, body: o, contentType: 'text/plain' }) };
      if (b.noEvent) return { valid: true, ack };
      if (b.unmatched) return { valid: true, ack, event: { gateway: id, attemptRef: null, unmatched: true, type: 'received', amount: b.amount, gatewayTxnId: b.txn, content: b.content, occurredAt: 0, source: b.source || req.channel } };
      return {
        valid: true,
        ack,
        event: {
          gateway: id,
          attemptRef: b.ref,
          type: b.type,
          amount: b.amount,
          ...(b.currency ? { currency: b.currency } : {}),
          gatewayTxnId: b.txn,
          occurredAt: 0,
          source: b.source || req.channel,
        },
      };
    },
    async query(arg) {
      fake.calls.query.push(arg);
      const { attemptRef } = arg;
      if (!fake.queryResults.has(attemptRef)) return { state: 'not_found' };
      return fake.queryResults.get(attemptRef);
    },
    async refund(p) { fake.calls.refund.push(p); return { status: fake.refundStatus }; },
    async queryRefund(p) { fake.calls.queryRefund.push(p); return { status: fake.queryRefundStatus }; },
  };
  if (opts.withFeed) {
    fake.feed = null; // đặt trong test: ({cursor}) -> {events, nextCursor}
    fake.reconcileFeed = async (a) => (fake.feed ? fake.feed(a) : { events: [] });
  }
  const heldOp = (kind, ok) => async (p) => {
    fake.calls[kind].push(p);
    const mode = kind === 'capture' ? fake.captureMode : fake.voidMode;
    if (mode === 'throw') throw new Error('network');
    if (mode === 'not_sent') { const e = new Error('breaker_open'); e.notSent = true; e.code = 'breaker_open'; throw e; }
    if (mode === 'unknown') return { status: 'unknown' };
    if (mode === 'rejected') return { status: 'rejected', reason: `fake_${kind}_rejected` };
    return kind === 'capture' ? { status: 'captured', gatewayTxnId: p.gatewayTxnId } : { status: 'voided' };
  };
  if ((caps.operations || []).includes('capture')) fake.capture = heldOp('capture');
  if ((caps.operations || []).includes('void')) fake.void = heldOp('void');
  if (caps.cancellable) {
    fake.cancel = async (p) => {
      fake.calls.cancel.push(p);
      const { attemptRef } = p;
      fake.cancelled.push(attemptRef);
      return { cancelled: true };
    };
  }
  return fake;
}

function createClock(start = 1_700_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (sec) => { c.t += sec * 1000; } };
  return c;
}

module.exports = { createFakeAdapter, createClock };

'use strict';
// spec: PHUB-S-017
// spec: PHUB-S-020
// spec: PHUB-S-029
// spec: PHUB-S-035
// Dạng trả ra của đối tượng miền cho mọi transport (PHUB-D-017). Chỉ các trường an toàn: không có dữ liệu thô của cổng, không có bí mật.

// Bước tiếp theo dạng chuẩn (PHUB-D-035): adapter khai thẳng thì dùng; không thì suy từ trường cũ (hướng dẫn chuyển khoản, url, method). Thêm cạnh trường cũ, không thay.
const nextActionOf = (a) => {
  if (a.nextAction) return a.nextAction;
  if (a.instructions) return { type: 'transfer', instructions: a.instructions };
  if (a.url) return a.method === 'POST' ? { type: 'post_redirect', url: a.url, fields: a.fields || {} } : { type: 'redirect', url: a.url };
  return null;
};
const attemptView = (a) => ({
  id: a.id, ref: a.ref, gateway: a.gateway, product: a.product, status: a.status, amount: a.amount,
  url: a.url || null, method: a.method || 'GET', fields: a.fields || null, instructions: a.instructions || null, createdAt: a.createdAt, expiresAt: a.expiresAt,
  gatewayTxnId: a.gatewayTxnId || null, failReason: a.failReason || null, failCode: a.failCode || null, gatewayCode: a.gatewayCode || null, receivedTotal: a.receivedTotal || 0,
  needsOperator: !!a.needsOperator,
  nextAction: nextActionOf(a),
});
const refundView = (r) => ({ id: r.id, ref: r.ref, attemptId: r.attemptId, paymentId: r.paymentId, amount: r.amount, status: r.status, reason: r.reason, createdAt: r.createdAt });
const anomalyView = (x) => ({ id: x.id, type: x.type, status: x.status, paymentId: x.paymentId || null, attemptId: x.attemptId || null, gateway: x.gateway || null, amount: x.amount, gatewayTxnId: x.gatewayTxnId || null, arbiter: x.arbiter || null, at: x.at, detail: x.detail || null, refundId: x.refundId || null });
const paymentView = (p) => ({ id: p.id, shopId: p.shopId || 'default', orderId: p.orderId, amount: p.amount, currency: p.currency, status: p.status, product: p.product, method: p.method || null, createdAt: p.createdAt, expiresAt: p.expiresAt, paidAt: p.paidAt || null, paidByAttempt: p.paidByAttempt });
const deliveryView = (w) => ({ id: w.id, shopId: w.shopId || 'default', type: w.type, objectId: w.objectId, route: w.route || 'webhook', sink: w.sink || 'webhook', status: w.status, attempts: w.attempts, nextAt: w.nextAt, createdAt: w.createdAt, deliveredAt: w.deliveredAt, lastStatus: w.lastStatus, lastError: w.lastError });
const detailView = (d) => ({ payment: paymentView(d.payment), attempts: d.attempts.map(attemptView), refunds: d.refunds.map(refundView), anomalies: d.anomalies.map(anomalyView) });

module.exports = { attemptView, refundView, anomalyView, paymentView, deliveryView, detailView };

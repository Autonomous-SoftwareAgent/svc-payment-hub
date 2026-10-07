'use strict';
// spec: PHUB-S-028
// spec: STRP-S-003
// Bộ chạy ngẫu nhiên cho Stripe: nay là một trường hợp của intl-runner.js (dùng chung với PayPal). Giữ tên cũ cho test/e2e/scenarios-stripe.test.js.
const { runIntlSeed } = require('./intl-runner');

const runStripeSeed = (seed, o) => runIntlSeed('stripe', seed, o);

module.exports = { runStripeSeed };

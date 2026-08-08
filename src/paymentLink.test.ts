import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldExitAfterPaymentSkip } from './paymentLink.js';

test('shouldExitAfterPaymentSkip detects ineligible payment skip', () => {
    assert.equal(shouldExitAfterPaymentSkip('当前账号暂无支付资格，已跳过提链'), true);
    assert.equal(shouldExitAfterPaymentSkip('卡密不可用，已跳过提链'), false);
    assert.equal(shouldExitAfterPaymentSkip(undefined), false);
});

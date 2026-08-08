import assert from 'node:assert/strict';
import test from 'node:test';
import { isChatGptPlusPlan } from './sessionExport.js';

test('isChatGptPlusPlan detects plus planType from session.json', () => {
    assert.equal(isChatGptPlusPlan('plus'), true);
    assert.equal(isChatGptPlusPlan('Plus'), true);
    assert.equal(isChatGptPlusPlan('free'), false);
    assert.equal(isChatGptPlusPlan(''), false);
});

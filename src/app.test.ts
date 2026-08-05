import assert from 'node:assert/strict';
import test from 'node:test';
import { SIGNUP_SELECTORS } from './selectors.js';

test('signup selectors support the current anonymous ChatGPT home page', () => {
    assert.ok(SIGNUP_SELECTORS.some(selector => selector.includes("data-mobile-auth-entry-action='signup'")));
    assert.ok(SIGNUP_SELECTORS.some(selector => selector.includes('Sign up for free')));
});
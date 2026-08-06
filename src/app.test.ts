import assert from 'node:assert/strict';
import test from 'node:test';
import { MFA_CHALLENGE_SELECTORS, MFA_CODE_SELECTORS, MFA_ENABLED_SELECTORS, MFA_VERIFY_SELECTORS, SIGNUP_EMAIL_SELECTORS, SIGNUP_SELECTORS } from './selectors.js';

test('signup selectors support the current anonymous ChatGPT home page', () => {
    assert.ok(SIGNUP_SELECTORS.some(selector => selector.includes("data-testid='signup-button'")));
    assert.ok(SIGNUP_SELECTORS.some(selector => selector.includes("data-mobile-auth-entry-action='signup'")));
    assert.ok(SIGNUP_SELECTORS.some(selector => selector.includes('Sign up for free')));
    assert.ok(SIGNUP_EMAIL_SELECTORS.some(selector => selector.includes("@id='email'")));
});

test('MFA selectors support the current authenticator dialog', () => {
    assert.ok(MFA_CODE_SELECTORS.some(selector => selector.includes("name='totp_otp'")));
    assert.ok(MFA_CODE_SELECTORS.some(selector => selector.includes('6-digit code')));
    assert.ok(MFA_VERIFY_SELECTORS.some(selector => selector.includes("normalize-space(.)='Verify'")));
    assert.ok(MFA_ENABLED_SELECTORS.some(selector => selector.includes("data-testid='mfa-authenticator-toggle'")));
    assert.ok(MFA_ENABLED_SELECTORS.every(selector => selector.includes("aria-checked='true'")));
});

test('existing-account MFA challenge selectors are distinct from email verification', () => {
    assert.ok(MFA_CHALLENGE_SELECTORS.some(selector => selector.includes('AUTHENTICATOR')));
    assert.ok(MFA_CHALLENGE_SELECTORS.some(selector => selector.includes('TRY ANOTHER METHOD')));
});

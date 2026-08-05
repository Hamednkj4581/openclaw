import assert from 'node:assert/strict';
import test from 'node:test';
import { TURNSTILE_HOOK } from './capsolver.js';

test('Turnstile hook preserves the real implementation', () => {
    assert.match(TURNSTILE_HOOK, /turnstile = wrap\(value\)/);
    assert.match(TURNSTILE_HOOK, /return original\(container, params\)/);
    assert.doesNotMatch(TURNSTILE_HOOK, /set\(\) \{\}/);
    assert.doesNotMatch(TURNSTILE_HOOK, /const fake/);
});
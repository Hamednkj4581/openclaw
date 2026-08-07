import assert from 'node:assert/strict';
import test from 'node:test';
import { cookieFileNameForEmail, filterChatGptCookies, toCookieEditorFormat } from './cookieExport.js';

test('cookieFileNameForEmail keeps email and adds .json', () => {
    assert.equal(cookieFileNameForEmail('user@example.com'), 'user@example.com.json');
});

test('toCookieEditorFormat matches Cookie-Editor fields', () => {
    const [item] = toCookieEditorFormat([{
        name: '__Secure-next-auth.session-token',
        value: 'abc',
        domain: '.chatgpt.com',
        path: '/',
        expires: 1_800_000_000,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
    }]);
    assert.equal(item.domain, '.chatgpt.com');
    assert.equal(item.hostOnly, false);
    assert.equal(item.httpOnly, true);
    assert.equal(item.sameSite, 'lax');
    assert.equal(item.session, false);
    assert.equal(item.expirationDate, 1_800_000_000);
    assert.equal(item.storeId, '0');
});

test('filterChatGptCookies keeps chatgpt and openai domains', () => {
    const kept = filterChatGptCookies([
        { name: 'a', value: '1', domain: '.chatgpt.com' },
        { name: 'b', value: '2', domain: 'auth.openai.com' },
        { name: 'c', value: '3', domain: '.example.com' },
    ]);
    assert.deepEqual(kept.map(c => c.name), ['a', 'b']);
});

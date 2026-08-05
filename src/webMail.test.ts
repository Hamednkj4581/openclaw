import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialsFromEnv } from './mailProvider.js';
import { extractWebMailVerification } from './webMail.js';

test('recognizes an HTTP(S) second field as a web mailbox URL', () => {
    process.env.EMAIL = 'sample@icloud.com';
    process.env.ICLOUD_API_KEY = 'https://mail.example/messages/access/sample%40icloud.com';
    assert.deepEqual(credentialsFromEnv(), {
        provider: 'webmail',
        email: 'sample@icloud.com',
        mailboxUrl: 'https://mail.example/messages/access/sample%40icloud.com'
    });
});

test('keeps existing iCloud API Key credentials compatible', () => {
    process.env.EMAIL = 'sample@icloud.com';
    process.env.ICLOUD_API_KEY = 'alias_example-key';
    assert.deepEqual(credentialsFromEnv(), {
        provider: 'icloud',
        email: 'sample@icloud.com',
        apiKey: 'alias_example-key'
    });
});

test('reads forwarded Outlook mailbox credentials from MAILBOX_EMAIL', () => {
    delete process.env.ICLOUD_API_KEY;
    process.env.EMAIL = 'alias@example.com';
    process.env.MAILBOX_EMAIL = 'TimmothyBegan9059@hotmail.com';
    process.env.CLIENT_ID = 'client-id';
    process.env.REFRESH_TOKEN = 'refresh-token';
    assert.deepEqual(credentialsFromEnv(), {
        provider: 'outlook',
        email: 'alias@example.com',
        mailboxEmail: 'TimmothyBegan9059@hotmail.com',
        clientId: 'client-id',
        refreshToken: 'refresh-token'
    });
});

test('extracts a ChatGPT verification code from a server-rendered mailbox page', () => {
    const html = `
        <!doctype html><html><body>
        <article class="message">
            <div class="sender">OpenAI &lt;noreply@tm.openai.com&gt;</div>
            <h2>Verify your email</h2>
            <div class="body">Your ChatGPT verification code is <strong>731842</strong>.</div>
        </article>
        </body></html>`;
    assert.deepEqual(extractWebMailVerification(html), { type: 'code', value: '731842' });
});

test('ignores six digit values on mailbox pages without an OpenAI message', () => {
    const html = '<html><body><article>Other service verification code: 731842</article></body></html>';
    assert.equal(extractWebMailVerification(html), undefined);
});

test('extracts an OpenAI verification link from a mailbox page', () => {
    const html = '<html><body>ChatGPT <a href="https://auth.openai.com/verify-email?token=test">Verify email</a></body></html>';
    assert.deepEqual(extractWebMailVerification(html), {
        type: 'link',
        value: 'https://auth.openai.com/verify-email?token=test'
    });
});
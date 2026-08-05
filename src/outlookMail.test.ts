import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRecipientText, extractVerification, messageMatchesRecipient } from './outlookMail.js';

test('ignores repeated placeholder digits in HTML scripts', () => {
    const html = '<html><body><p>Welcome to ChatGPT</p><script>const code = 000000;</script></body></html>';
    assert.equal(extractVerification('Welcome', '', html), undefined);
});

test('extracts a verification code from visible HTML text', () => {
    const html = '<p>Your ChatGPT verification code is <strong>381729</strong>.</p><script>const code = 000000;</script>';
    assert.deepEqual(extractVerification('Verify your email', '', html), { type: 'code', value: '381729' });
});

test('keeps compatibility with plain-text six digit codes', () => {
    assert.deepEqual(extractVerification('Sign in to OpenAI', 'Use 492615 to continue.', ''), { type: 'code', value: '492615' });
});

test('prefers an OpenAI verification link over numeric content', () => {
    const html = '<a href="https://auth.openai.com/verify-email?token=abc&amp;code=381729">Verify email</a>';
    assert.deepEqual(extractVerification('Verify your email', 'Reference 492615', html), {
        type: 'link',
        value: 'https://auth.openai.com/verify-email?token=abc&code=381729'
    });
});

test('matches forwarded recipient across To and Delivered-To style fields', () => {
    const text = collectRecipientText({
        to: { text: 'TimmothyBegan9059@hotmail.com' },
        headers: {
            get(name: string) {
                return name === 'x-original-to' ? 'alias@example.com' : undefined;
            }
        }
    });
    assert.equal(messageMatchesRecipient(text, 'alias@example.com'), true);
    assert.equal(messageMatchesRecipient(text, 'other@example.com'), false);
});

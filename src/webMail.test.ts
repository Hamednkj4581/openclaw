import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialsFromEnv } from './mailProvider.js';
import { extractWebMailVerification, pageMentionsEmail } from './webMail.js';
import { ai1998WebMailAdapter, resolveWebMailAdapter, showPathWebMailAdapter } from './webMailHosts.js';

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

test('resolves mail.ai1998.xyz adapter by hostname', () => {
    assert.equal(resolveWebMailAdapter('mail.ai1998.xyz').id, 'mail.ai1998.xyz');
    assert.equal(resolveWebMailAdapter('mail.example.com').id, 'default');
});

test('resolves mail.20000408.xyz to show-path adapter', () => {
    assert.equal(resolveWebMailAdapter('mail.20000408.xyz').id, 'show-path');
    assert.equal(resolveWebMailAdapter('MAIL.20000408.XYZ').id, 'show-path');
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

test('ai1998 adapter extracts code from mail-card layout', () => {
    const html = `
      <!doctype html><html><body>
      <div class="wrap">
        <details class="mail-card">
          <summary>
            <span class="subject">Verify your email address</span>
            <span class="date">just now</span>
          </summary>
          <div class="meta">OpenAI &lt;noreply@tm.openai.com&gt;</div>
          <pre class="body">Your ChatGPT verification code is 482915</pre>
        </details>
      </div>
      </body></html>`;
    assert.deepEqual(
        ai1998WebMailAdapter.extract(html, {
            email: 'sorters.day4e@icloud.com',
            mailboxUrl: 'https://mail.ai1998.xyz/messages/token/sorters.day4e%40icloud.com'
        }),
        { type: 'code', value: '482915' }
    );
    assert.deepEqual(
        extractWebMailVerification(html, 'https://mail.ai1998.xyz/messages/token/x%40icloud.com'),
        { type: 'code', value: '482915' }
    );
});

test('ai1998 adapter extracts verify link from mail-card body', () => {
    const html = `
      <details class="mail-card">
        <summary><span class="subject">Verify your email</span></summary>
        <div class="meta">OpenAI</div>
        <div class="body">ChatGPT <a href="https://auth.openai.com/verify-email?token=abc">Verify</a></div>
      </details>`;
    assert.deepEqual(
        extractWebMailVerification(html, 'mail.ai1998.xyz'),
        { type: 'link', value: 'https://auth.openai.com/verify-email?token=abc' }
    );
});

test('ai1998 adapter ignores empty inbox without openai mail', () => {
    const html = `
      <div class="wrap">
        <div class="count">当前只显示最近一封邮件，本页显示 0 封。</div>
        <div class="empty">暂无邮件</div>
      </div>`;
    assert.equal(extractWebMailVerification(html, 'mail.ai1998.xyz'), undefined);
});

test('pageMentionsEmail decodes Cloudflare protected addresses', () => {
    // spouted-24-grouse@icloud.com
    const html = `<p><a class="__cf_email__" data-cfemail="ef9c9f809a9b8a8bc2dddbc2889d809a9c8aaf868c83809a8bc18c8082">[email&#160;protected]</a></p>`;
    assert.equal(pageMentionsEmail(html, 'spouted-24-grouse@icloud.com'), true);
    assert.equal(pageMentionsEmail(html, 'other@icloud.com'), false);
    assert.equal(pageMentionsEmail('<p>plain@icloud.com</p>', 'plain@icloud.com'), true);
});

test('show-path adapter ignores empty No latest mail found page', () => {
    const html = `
      <!doctype html><html><body>
      <main><h2>No latest mail found</h2>
      <p><a class="__cf_email__" data-cfemail="ef9c9f809a9b8a8bc2dddbc2889d809a9c8aaf868c83809a8bc18c8082">[email&#160;protected]</a></p>
      </main></body></html>`;
    assert.equal(
        showPathWebMailAdapter.extract(html, {
            email: 'spouted-24-grouse@icloud.com',
            mailboxUrl: 'https://mail.20000408.xyz/show/token/spouted-24-grouse@icloud.com'
        }),
        undefined
    );
    assert.equal(extractWebMailVerification(html, 'mail.20000408.xyz'), undefined);
});

test('show-path adapter extracts code from main content', () => {
    const html = `
      <!doctype html><html><body>
      <main>
        <h2>Verify your email</h2>
        <p>OpenAI &lt;noreply@tm.openai.com&gt;</p>
        <div>Your ChatGPT verification code is 619384</div>
      </main>
      <script>/* noise 123456 */</script>
      </body></html>`;
    assert.deepEqual(
        extractWebMailVerification(html, 'https://mail.20000408.xyz/show/t/x@icloud.com'),
        { type: 'code', value: '619384' }
    );
});

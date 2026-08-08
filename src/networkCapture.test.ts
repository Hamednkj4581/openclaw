import assert from 'node:assert/strict';
import test from 'node:test';
import { formatNetworkHostSummary, formatNetworkUrlLog, sanitizeNetworkUrl, type NetworkRecord } from './networkCapture.js';
import { pacRouteForUrl } from './proxy.js';

test('sanitizeNetworkUrl strips query/hash and applies redact', () => {
    const parsed = sanitizeNetworkUrl('https://auth.openai.com/verify?token=secret#frag', t => t.replace('secret', '[REDACTED]'));
    assert.deepEqual(parsed, { host: 'auth.openai.com', url: 'https://auth.openai.com/verify' });
});

test('sanitizeNetworkUrl ignores non-http schemes', () => {
    assert.equal(sanitizeNetworkUrl('data:text/plain,hi', t => t), null);
    assert.equal(sanitizeNetworkUrl('chrome-error://chromewebdata/', t => t), null);
});

test('pacRouteForUrl matches PAC static-asset direct rule', () => {
    process.env.ENABLE_711_PROXY = 'true';
    assert.equal(pacRouteForUrl('https://cdn.example.com/a.js?v=1'), 'DIRECT');
    assert.equal(pacRouteForUrl('https://cdn.example.com/a.css'), 'DIRECT');
    assert.equal(pacRouteForUrl('https://chatgpt.com/'), 'PROXY');
    assert.equal(pacRouteForUrl('https://chatgpt.com/backend-api/me'), 'PROXY');
});

test('formatNetworkHostSummary sorts by count and reports proxy mix', () => {
    const records: NetworkRecord[] = [
        { method: 'GET', resourceType: 'document', pac: 'PROXY', host: 'chatgpt.com', url: 'https://chatgpt.com/' },
        { method: 'GET', resourceType: 'xhr', pac: 'PROXY', host: 'chatgpt.com', url: 'https://chatgpt.com/api' },
        { method: 'GET', resourceType: 'stylesheet', pac: 'DIRECT', host: 'cdn.oaistatic.com', url: 'https://cdn.oaistatic.com/a.css' },
    ];
    const summary = formatNetworkHostSummary(records);
    assert.match(summary, /# count\tproxy\tdirect\tresourceTypes\thost/);
    assert.match(summary, /2\t2\t0\tdocument,xhr\tchatgpt\.com/);
    assert.match(summary, /1\t0\t1\tstylesheet\tcdn\.oaistatic\.com/);
    assert.ok(summary.indexOf('chatgpt.com') < summary.indexOf('cdn.oaistatic.com'));
});

test('formatNetworkUrlLog writes sequential tsv rows', () => {
    const log = formatNetworkUrlLog([
        { method: 'GET', resourceType: 'document', pac: 'PROXY', host: 'chatgpt.com', url: 'https://chatgpt.com/' },
    ]);
    assert.match(log, /^# seq\tmethod\tresourceType\tpac\turl\n1\tGET\tdocument\tPROXY\thttps:\/\/chatgpt\.com\/\n$/);
});

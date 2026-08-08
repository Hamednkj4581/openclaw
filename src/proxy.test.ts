import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJapanStickyProxy, buildProxyPacUrl, is711ProxyEnabled, pacRouteForUrl, rotateStickySession } from './proxy.js';

test('is711ProxyEnabled defaults to false', () => {
    delete process.env.ENABLE_711_PROXY;
    assert.equal(is711ProxyEnabled(), false);
    process.env.ENABLE_711_PROXY = 'true';
    assert.equal(is711ProxyEnabled(), true);
    process.env.ENABLE_711_PROXY = 'false';
    assert.equal(is711ProxyEnabled(), false);
});

test('buildJapanStickyProxy creates JP sticky username with fresh session', () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    process.env.PROXY_HOST = 'us.rotgb.711proxy.com';
    process.env.PROXY_PORT = '10000';
    process.env.PROXY_REGION = 'JP';
    process.env.PROXY_SESS_TIME = '30';

    const a = buildJapanStickyProxy();
    const b = buildJapanStickyProxy();

    assert.equal(a.server, 'http://us.rotgb.711proxy.com:10000');
    assert.equal(a.host, 'us.rotgb.711proxy.com');
    assert.equal(a.password, 'testpass');
    assert.equal(a.region, 'JP');
    assert.equal(a.sessTime, 30);
    assert.match(a.session, /^\d{8}$/);
    assert.match(a.username, /^testuser-zone-custom-region-JP-session-\d{8}-sessTime-30$/);
    assert.notEqual(a.session, b.session);
});

test('buildJapanStickyProxy creates PH sticky username with fresh session', () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    process.env.PROXY_REGION = 'PH';
    const proxy = buildJapanStickyProxy();
    assert.equal(proxy.region, 'PH');
    assert.match(proxy.username, /^testuser-zone-custom-region-PH-session-\d{8}-sessTime-30$/);
});

test('buildJapanStickyProxy requires credentials', () => {
    delete process.env.PROXY_USERNAME;
    delete process.env.PROXY_PASSWORD;
    assert.throws(() => buildJapanStickyProxy(), /PROXY_USERNAME/);
});

test('buildProxyPacUrl routes static assets direct and rest via proxy', () => {
    process.env.ENABLE_711_PROXY = 'true';
    const pacUrl = buildProxyPacUrl({ host: 'us.rotgb.711proxy.com', port: 10000 });
    assert.match(pacUrl, /^data:application\/x-ns-proxy-autoconfig,/);
    const pac = decodeURIComponent(pacUrl.slice(pacUrl.indexOf(',') + 1));
    assert.match(pac, /DIRECT/);
    assert.match(pac, /PROXY us\.rotgb\.711proxy\.com:10000/);
    assert.match(pac, /png\|jpe\?g/);
    assert.equal(pacRouteForUrl('https://x.com/a.png'), 'DIRECT');
    assert.equal(pacRouteForUrl('https://x.com/api'), 'PROXY');
});

test('pacRouteForUrl is always DIRECT when 711 proxy disabled', () => {
    process.env.ENABLE_711_PROXY = 'false';
    assert.equal(pacRouteForUrl('https://x.com/a.png'), 'DIRECT');
    assert.equal(pacRouteForUrl('https://x.com/api'), 'DIRECT');
});

test('rotateStickySession refreshes session id in username', () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    const proxy = buildJapanStickyProxy();
    const before = { session: proxy.session, username: proxy.username };
    rotateStickySession(proxy);
    assert.notEqual(proxy.session, before.session);
    assert.match(proxy.username, new RegExp(`-session-${proxy.session}-sessTime-`));
    assert.doesNotMatch(proxy.username, new RegExp(`-session-${before.session}-sessTime-`));
});

test('probeChatgptViaProxy is exported for HTTPS tunnel preflight', async () => {
    const { probeChatgptViaProxy } = await import('./proxy.js');
    assert.equal(typeof probeChatgptViaProxy, 'function');
});

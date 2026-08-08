import assert from 'node:assert/strict';
import test from 'node:test';
import {
    build711StickyProxyFromEnv,
    buildJapanStickyProxy,
    buildProxyPacUrl,
    buildStickyProxyFromEnv,
    is711ProxyEnabled,
    pacRouteForUrl,
    parseProxyLink,
    parseProxyLinkList,
    pickProxyLink,
    rotateStickySession,
} from './proxy.js';

test('is711ProxyEnabled defaults to false', () => {
    delete process.env.ENABLE_711_PROXY;
    assert.equal(is711ProxyEnabled(), false);
    process.env.ENABLE_711_PROXY = 'true';
    assert.equal(is711ProxyEnabled(), true);
    process.env.ENABLE_711_PROXY = 'false';
    assert.equal(is711ProxyEnabled(), false);
});

test('parseProxyLinkList splits newlines and semicolons', () => {
    assert.deepEqual(parseProxyLinkList('a\nb;c\n\n;d'), ['a', 'b', 'c', 'd']);
});

test('pickProxyLink round-robins by account index', () => {
    const links = ['p1', 'p2', 'p3'];
    assert.deepEqual(pickProxyLink(links, 0), { link: 'p1', linkIndex: 0 });
    assert.deepEqual(pickProxyLink(links, 1), { link: 'p2', linkIndex: 1 });
    assert.deepEqual(pickProxyLink(links, 2), { link: 'p3', linkIndex: 2 });
    assert.deepEqual(pickProxyLink(links, 3), { link: 'p1', linkIndex: 0 });
    assert.deepEqual(pickProxyLink(links, 4), { link: 'p2', linkIndex: 1 });
});

test('parseProxyLink accepts URL, user:pass@host:port and host:port:user:pass', () => {
    const a = parseProxyLink('http://user:pass@proxy.example:10000', 1);
    assert.equal(a.host, 'proxy.example');
    assert.equal(a.port, 10000);
    assert.equal(a.username, 'user');
    assert.equal(a.password, 'pass');
    assert.equal(a.linkIndex, 1);
    assert.equal(a.stickyRotate, false);

    const b = parseProxyLink('proxy.example:10000:u:p:with:colon');
    assert.equal(b.host, 'proxy.example');
    assert.equal(b.port, 10000);
    assert.equal(b.username, 'u');
    assert.equal(b.password, 'p:with:colon');

    const c = parseProxyLink(
        'jpuser001-zone-custom-region-JP-st-Aichi-session-57981956-sessTime-30-sessAuto-1:secret@global.rotgb.711proxy.com:10000',
    );
    assert.equal(c.host, 'global.rotgb.711proxy.com');
    assert.equal(c.port, 10000);
    assert.equal(c.username, 'jpuser001-zone-custom-region-JP-st-Aichi-session-57981956-sessTime-30-sessAuto-1');
    assert.equal(c.password, 'secret');
    assert.equal(c.session, '57981956');
    assert.equal(c.sessTime, 30);
    assert.equal(c.stickyRotate, false);
});

test('build711StickyProxyFromEnv creates JP sticky username with fresh session', () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    process.env.PROXY_HOST = 'us.rotgb.711proxy.com';
    process.env.PROXY_PORT = '10000';
    process.env.PROXY_REGION = 'JP';
    process.env.PROXY_SESS_TIME = '30';
    delete process.env.PROXY_LINKS;
    delete process.env.PROXY_URL;

    const a = build711StickyProxyFromEnv();
    const b = build711StickyProxyFromEnv();

    assert.equal(a.server, 'http://us.rotgb.711proxy.com:10000');
    assert.equal(a.host, 'us.rotgb.711proxy.com');
    assert.equal(a.password, 'testpass');
    assert.equal(a.region, 'JP');
    assert.equal(a.sessTime, 30);
    assert.equal(a.stickyRotate, true);
    assert.match(a.session, /^\d{8}$/);
    assert.match(a.username, /^testuser-zone-custom-region-JP-session-\d{8}-sessTime-30$/);
    assert.notEqual(a.session, b.session);
});

test('buildStickyProxyFromEnv prefers 711 credentials over links', () => {
    process.env.PROXY_USERNAME = 'u1';
    process.env.PROXY_PASSWORD = 'p1';
    process.env.PROXY_REGION = 'PH';
    process.env.PROXY_LINKS = 'http://a:1@h:10000';
    const proxy = buildStickyProxyFromEnv();
    assert.equal(proxy.stickyRotate, true);
    assert.equal(proxy.region, 'PH');
    assert.match(proxy.username, /^u1-zone-custom-region-PH-session-\d{8}-sessTime-30$/);
});

test('buildStickyProxyFromEnv assigns links by WEB_ACCOUNT_INDEX', () => {
    delete process.env.PROXY_USERNAME;
    delete process.env.PROXY_PASSWORD;
    process.env.PROXY_LINKS = 'http://a:1@h:10000\nhttp://b:2@h:10000\nhttp://c:3@h:10000';
    process.env.WEB_ACCOUNT_INDEX = '4';
    const proxy = buildStickyProxyFromEnv();
    assert.equal(proxy.linkIndex, 1);
    assert.equal(proxy.username, 'b');
    assert.equal(proxy.password, '2');
    assert.equal(proxy.stickyRotate, false);
});

test('buildJapanStickyProxy remains as alias', () => {
    delete process.env.PROXY_USERNAME;
    delete process.env.PROXY_PASSWORD;
    process.env.PROXY_URL = 'http://u:p@host:2000';
    delete process.env.PROXY_LINKS;
    const proxy = buildJapanStickyProxy();
    assert.equal(proxy.host, 'host');
    assert.equal(proxy.port, 2000);
});

test('buildStickyProxyFromEnv requires credentials or links', () => {
    delete process.env.PROXY_URL;
    delete process.env.PROXY_LINKS;
    delete process.env.PROXY_USERNAME;
    delete process.env.PROXY_PASSWORD;
    assert.throws(() => buildStickyProxyFromEnv(), /PROXY_USERNAME|PROXY_LINKS|PROXY_URL/);
});

test('buildProxyPacUrl routes static assets direct and rest via proxy', () => {
    process.env.ENABLE_711_PROXY = 'true';
    const pacUrl = buildProxyPacUrl({ host: 'us.rotgb.711proxy.com', port: 10000 });
    assert.match(pacUrl, /^data:application\/x-ns-proxy-autoconfig,/);
    const pac = decodeURIComponent(pacUrl.slice(pacUrl.indexOf(',') + 1));
    assert.match(pac, /DIRECT/);
    assert.match(pac, /PROXY us\.rotgb\.711proxy\.com:10000/);
    assert.equal(pacRouteForUrl('https://x.com/a.png'), 'DIRECT');
    assert.equal(pacRouteForUrl('https://x.com/api'), 'PROXY');
});

test('pacRouteForUrl is always DIRECT when 711 proxy disabled', () => {
    process.env.ENABLE_711_PROXY = 'false';
    assert.equal(pacRouteForUrl('https://x.com/a.png'), 'DIRECT');
    assert.equal(pacRouteForUrl('https://x.com/api'), 'DIRECT');
});

test('rotateStickySession refreshes session id only when stickyRotate enabled', () => {
    process.env.PROXY_USERNAME = 'user';
    process.env.PROXY_PASSWORD = 'pass';
    process.env.PROXY_REGION = 'JP';
    const proxy = build711StickyProxyFromEnv();
    const before = { session: proxy.session, username: proxy.username };
    rotateStickySession(proxy);
    assert.notEqual(proxy.session, before.session);
    assert.match(proxy.username, new RegExp(`-session-${proxy.session}-sessTime-`));

    const link = parseProxyLink('http://user-zone-custom-region-JP-session-12345678-sessTime-30:pass@h:10000');
    const linkBefore = link.username;
    rotateStickySession(link);
    assert.equal(link.username, linkBefore);
});

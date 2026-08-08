import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildProxyFromEnv,
    buildProxyPacUrl,
    isProxyEnabled,
    pacRouteForUrl,
    parseProxyLink,
    parseProxyLinkList,
    pickProxyLink,
} from './proxy.js';

test('isProxyEnabled defaults to false', () => {
    delete process.env.ENABLE_PROXY;
    assert.equal(isProxyEnabled(), false);
    process.env.ENABLE_PROXY = 'true';
    assert.equal(isProxyEnabled(), true);
    process.env.ENABLE_PROXY = 'false';
    assert.equal(isProxyEnabled(), false);
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

    const b = parseProxyLink('proxy.example:10000:u:p:with:colon');
    assert.equal(b.host, 'proxy.example');
    assert.equal(b.port, 10000);
    assert.equal(b.username, 'u');
    assert.equal(b.password, 'p:with:colon');

    const c = parseProxyLink(
        'jpuser001-zone-custom-region-JP-st-Aichi-session-57981956-sessTime-30-sessAuto-1:secret@proxy.example:10000',
    );
    assert.equal(c.host, 'proxy.example');
    assert.equal(c.port, 10000);
    assert.equal(c.username, 'jpuser001-zone-custom-region-JP-st-Aichi-session-57981956-sessTime-30-sessAuto-1');
    assert.equal(c.password, 'secret');
    assert.equal(c.session, '57981956');
    assert.equal(c.sessTime, 30);
    assert.equal(c.region, 'JP');
});

test('buildProxyFromEnv assigns links by WEB_ACCOUNT_INDEX', () => {
    delete process.env.PROXY_URL;
    process.env.PROXY_LINKS = 'http://a:1@h:10000\nhttp://b:2@h:10000\nhttp://c:3@h:10000';
    process.env.WEB_ACCOUNT_INDEX = '4';
    const proxy = buildProxyFromEnv();
    assert.equal(proxy.linkIndex, 1);
    assert.equal(proxy.username, 'b');
    assert.equal(proxy.password, '2');
});

test('buildProxyFromEnv requires links', () => {
    delete process.env.PROXY_URL;
    delete process.env.PROXY_LINKS;
    assert.throws(() => buildProxyFromEnv(), /PROXY_LINKS|PROXY_URL/);
});

test('buildProxyPacUrl routes static assets direct and rest via proxy', () => {
    process.env.ENABLE_PROXY = 'true';
    const pacUrl = buildProxyPacUrl({ host: 'proxy.example', port: 10000 });
    assert.match(pacUrl, /^data:application\/x-ns-proxy-autoconfig,/);
    const pac = decodeURIComponent(pacUrl.slice(pacUrl.indexOf(',') + 1));
    assert.match(pac, /DIRECT/);
    assert.match(pac, /PROXY proxy\.example:10000/);
    assert.equal(pacRouteForUrl('https://x.com/a.png'), 'DIRECT');
    assert.equal(pacRouteForUrl('https://x.com/api'), 'PROXY');
});

test('pacRouteForUrl is always DIRECT when proxy disabled', () => {
    process.env.ENABLE_PROXY = 'false';
    assert.equal(pacRouteForUrl('https://x.com/a.png'), 'DIRECT');
    assert.equal(pacRouteForUrl('https://x.com/api'), 'DIRECT');
});

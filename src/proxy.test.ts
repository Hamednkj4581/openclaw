import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJapanStickyProxy, buildProxyPacUrl, decideProxyRegion, geoFromPayload, rotateStickySession } from './proxy.js';

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

test('buildJapanStickyProxy requires credentials', () => {
    delete process.env.PROXY_USERNAME;
    delete process.env.PROXY_PASSWORD;
    assert.throws(() => buildJapanStickyProxy(), /PROXY_USERNAME/);
});

test('buildProxyPacUrl routes static assets direct and rest via proxy', () => {
    const pacUrl = buildProxyPacUrl({ host: 'us.rotgb.711proxy.com', port: 10000 });
    assert.match(pacUrl, /^data:application\/x-ns-proxy-autoconfig,/);
    const pac = decodeURIComponent(pacUrl.slice(pacUrl.indexOf(',') + 1));
    assert.match(pac, /DIRECT/);
    assert.match(pac, /PROXY us\.rotgb\.711proxy\.com:10000/);
    assert.match(pac, /png\|jpe\?g/);
});

test('geoFromPayload prefers ISO country codes over full names', () => {
    assert.deepEqual(geoFromPayload({ country: 'Kyrgyzstan', countryCode: 'KG', query: '1.1.1.1' }), { ip: '1.1.1.1', country: 'KG' });
    assert.deepEqual(geoFromPayload({ country: 'JP', ip: '2.2.2.2' }), { ip: '2.2.2.2', country: 'JP' });
    assert.deepEqual(geoFromPayload({ country: 'Japan', ip: '3.3.3.3' }), { ip: '3.3.3.3', country: '' });
});

test('decideProxyRegion accepts expected country even when sources conflict', () => {
    const decision = decideProxyRegion('JP', [
        { ip: '1.1.1.1', country: 'KG', host: 'ipinfo.io' },
        { ip: '1.1.1.1', country: 'JP', host: 'ip-api.com' },
    ]);
    assert.equal(decision.ok, true);
    assert.match(decision.detail, /冲突/);
});

test('decideProxyRegion rejects when all sources disagree with expected region', () => {
    const decision = decideProxyRegion('JP', [
        { ip: '1.1.1.1', country: 'KG', host: 'ipinfo.io' },
        { ip: '1.1.1.1', country: 'KG', host: 'ip-api.com' },
    ]);
    assert.equal(decision.ok, false);
    assert.match(decision.detail, /出口国家为 KG/);
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

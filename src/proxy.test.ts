import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJapanStickyProxy } from './proxy.js';

test('buildJapanStickyProxy creates JP sticky username with fresh session', () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    process.env.PROXY_HOST = 'global.711proxy.com';
    process.env.PROXY_PORT = '10000';
    process.env.PROXY_REGION = 'JP';
    process.env.PROXY_SESS_TIME = '30';

    const a = buildJapanStickyProxy();
    const b = buildJapanStickyProxy();

    assert.equal(a.server, 'http://global.711proxy.com:10000');
    assert.equal(a.host, 'global.711proxy.com');
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    cancelHeroSmsActivation,
    completeHeroSmsActivation,
    fetchHeroSmsCountries,
    fetchHeroSmsServices,
    fetchHeroSmsStatus,
    markHeroSmsReady,
    requestHeroSmsNumber,
    waitHeroSmsCode,
} from './heroSms.js';

test('requestHeroSmsNumber 解析 ACCESS_NUMBER', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('ACCESS_NUMBER:123:639123456789', { status: 200 });
    try {
        const result = await requestHeroSmsNumber('k', 'go', 4);
        assert.equal(result.activationId, 123);
        assert.equal(result.phoneNumber, '639123456789');
    } finally {
        globalThis.fetch = original;
    }
});

test('fetchHeroSmsStatus 解析 STATUS_OK', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('STATUS_OK:123456', { status: 200 });
    try {
        const status = await fetchHeroSmsStatus('k', 1);
        assert.equal(status.status, 'STATUS_OK');
        if (status.status === 'STATUS_OK') assert.equal(status.code, '123456');
    } finally {
        globalThis.fetch = original;
    }
});

test('fetchHeroSmsCountries 解析 JSON', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        '4': { id: 4, eng: 'Philippines' },
        '12': { id: 12, eng: 'United States' },
    }), { status: 200 });
    try {
        const countries = await fetchHeroSmsCountries('k');
        assert.equal(countries.length, 2);
        assert.ok(countries.some((row) => row.id === 4 && row.name === 'Philippines'));
    } finally {
        globalThis.fetch = original;
    }
});

test('fetchHeroSmsServices 解析 services 数组', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        services: [{ code: 'go', name: 'Google' }, { code: 'oi', name: 'Tinder' }],
    }), { status: 200 });
    try {
        const services = await fetchHeroSmsServices('k', 4);
        assert.equal(services.length, 2);
        assert.ok(services.some((row) => row.code === 'go'));
    } finally {
        globalThis.fetch = original;
    }
});

test('waitHeroSmsCode 轮询直到收到验证码', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        const body = calls < 2 ? 'STATUS_WAIT_CODE' : 'STATUS_OK:654321';
        return new Response(body, { status: 200 });
    };
    try {
        const code = await waitHeroSmsCode('k', 9, 10_000);
        assert.equal(code, '654321');
        assert.ok(calls >= 2);
    } finally {
        globalThis.fetch = original;
    }
});

test('mark/complete/cancel 不抛错', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('ACCESS_READY', { status: 200 });
    try {
        await markHeroSmsReady('k', 1);
        await completeHeroSmsActivation('k', 1);
        await cancelHeroSmsActivation('k', 1);
    } finally {
        globalThis.fetch = original;
    }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLoginAccount } from './loginAccount.js';

test('parseLoginAccount accepts email----password----2fa', () => {
    const account = parseLoginAccount('user@example.com----Passw0rd!----XXJ463IRCS434MR2MSI2XQU6YWWR3RXV');
    assert.equal(account.email, 'user@example.com');
    assert.equal(account.password, 'Passw0rd!');
    assert.equal(account.otpSecret, 'XXJ463IRCS434MR2MSI2XQU6YWWR3RXV');
});

test('parseLoginAccount accepts trailing registration result fields', () => {
    const account = parseLoginAccount(
        'user@example.com----Passw0rd!----XXJ463IRCS434MR2MSI2XQU6YWWR3RXV----access-token----Mon Jan 1'
    );
    assert.equal(account.email, 'user@example.com');
    assert.equal(account.otpSecret, 'XXJ463IRCS434MR2MSI2XQU6YWWR3RXV');
});

test('parseLoginAccount accepts pickup URL before ignored tail when 3rd is 2FA', () => {
    const account = parseLoginAccount(
        'user@example.com----Passw0rd!----AJYTL5F5HRHUTOWA2ESYBJOKC2FBSRLD----https://example.com/s/x/user@example.com'
    );
    assert.equal(account.otpSecret, 'AJYTL5F5HRHUTOWA2ESYBJOKC2FBSRLD');
});

test('parseLoginAccount accepts pickup plus 2FA in four fields', () => {
    const account = parseLoginAccount(
        'user@example.com----Passw0rd!----https://mail.example/messages/access/user@example.com----AJYTL5F5HRHUTOWA2ESYBJOKC2FBSRLD'
    );
    assert.equal(account.otpSecret, 'AJYTL5F5HRHUTOWA2ESYBJOKC2FBSRLD');
});

test('parseLoginAccount accepts outlook pickup without 2fa', () => {
    const account = parseLoginAccount(
        'user@example.com----Passw0rd!----client-id----refresh-token'
    );
    assert.equal(account.email, 'user@example.com');
    assert.equal(account.otpSecret, undefined);
});

test('parseLoginAccount accepts outlook pickup with 2fa', () => {
    const account = parseLoginAccount(
        'user@example.com----Passw0rd!----client-id----refresh-token----AJYTL5F5HRHUTOWA2ESYBJOKC2FBSRLD'
    );
    assert.equal(account.otpSecret, 'AJYTL5F5HRHUTOWA2ESYBJOKC2FBSRLD');
});

test('parseLoginAccount accepts icloud pickup without 2fa', () => {
    const account = parseLoginAccount('user@example.com----Passw0rd!----icloud-api-key');
    assert.equal(account.password, 'Passw0rd!');
    assert.equal(account.otpSecret, undefined);
});

test('parseLoginAccount accepts register-style two-field webmail pickup', () => {
    const line = 'voltage.hor222y6z@icloud.com----https://mail.ai1998.xyz/messages/DIX717FVCimDYKhhCTr7J0YnfCN03prT/voltage.horsey6z%40icloud.com';
    const account = parseLoginAccount(line);
    assert.equal(account.email, 'voltage.hor222y6z@icloud.com');
    assert.equal(account.password, '');
});

test('parseLoginAccount accepts single email like register', () => {
    const account = parseLoginAccount('alias@example.com');
    assert.equal(account.email, 'alias@example.com');
    assert.equal(account.password, '');
});

test('parseLoginAccount rejects empty record', () => {
    assert.throws(() => parseLoginAccount(''), /为空/);
});

test('parseLoginAccount rejects non-Base32 third field when only three parts', () => {
    const account = parseLoginAccount('user@example.com----Passw0rd!----https://example.com/x');
    assert.equal(account.otpSecret, undefined);
});

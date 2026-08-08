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

test('parseLoginAccount ignores trailing mailbox URL when 3rd field is 2FA', () => {
    const account = parseLoginAccount(
        'user@example.com----Passw0rd!----AJYTL5F5HRHUTOWA2ESYBJOKC2FBSRLD----https://example.com/s/x/user@example.com'
    );
    assert.equal(account.email, 'user@example.com');
    assert.equal(account.password, 'Passw0rd!');
    assert.equal(account.otpSecret, 'AJYTL5F5HRHUTOWA2ESYBJOKC2FBSRLD');
});

test('parseLoginAccount rejects incomplete fields', () => {
    assert.throws(() => parseLoginAccount('user@example.com----only-password'), /email----password----2fa/);
});

test('parseLoginAccount rejects non-Base32 third field even with trailing URL', () => {
    assert.throws(
        () => parseLoginAccount('user@example.com----Passw0rd!----not-a-secret----https://example.com/x'),
        /Base32/
    );
});

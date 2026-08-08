import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLoginAccount } from './loginAccount.js';

test('parseLoginAccount accepts email----password----2fa', () => {
    const account = parseLoginAccount('user@example.com----Passw0rd!----XXJ463IRCS434MR2MSI2XQU6YWWR3RXV');
    assert.equal(account.email, 'user@example.com');
    assert.equal(account.password, 'Passw0rd!');
    assert.equal(account.otpSecret, 'XXJ463IRCS434MR2MSI2XQU6YWWR3RXV');
});

test('parseLoginAccount accepts trailing fields after 2fa', () => {
    const account = parseLoginAccount(
        'user@example.com----Passw0rd!----XXJ463IRCS434MR2MSI2XQU6YWWR3RXV----access-token----Mon Jan 1'
    );
    assert.equal(account.otpSecret, 'XXJ463IRCS434MR2MSI2XQU6YWWR3RXV');
});

test('parseLoginAccount accepts register-style two-field webmail pickup', () => {
    const line = 'voltage.hor222y6z@icloud.com----https://mail.ai1998.xyz/messages/DIX717FVCimDYKhhCTr7J0YnfCN03prT/voltage.horsey6z%40icloud.com';
    const account = parseLoginAccount(line);
    assert.equal(account.email, 'voltage.hor222y6z@icloud.com');
    assert.equal(account.password, '');
    assert.equal(account.otpSecret, undefined);
});

test('parseLoginAccount accepts register-style single email', () => {
    const account = parseLoginAccount('alias@example.com');
    assert.equal(account.email, 'alias@example.com');
    assert.equal(account.password, '');
});

test('parseLoginAccount accepts register-style outlook four fields', () => {
    const account = parseLoginAccount('outlook@example.com----mailbox-pass----client-id----refresh-token');
    assert.equal(account.email, 'outlook@example.com');
    assert.equal(account.password, '');
});

test('parseLoginAccount rejects invalid register-style record', () => {
    assert.throws(() => parseLoginAccount('bad-record'), /无效/);
});

test('parseLoginAccount rejects empty record', () => {
    assert.throws(() => parseLoginAccount(''), /为空/);
});

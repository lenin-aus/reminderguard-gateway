'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideOrgOwnership, formatRejectionLog } = require('./accounts');

const org = (over = {}) => ({ clientId: 12, ownerAccountId: 5, accountHasAccess: false, ...over });

test('a tenant that is not connected anywhere is created', () => {
  assert.deepEqual(decideOrgOwnership({ accountId: 5, org: null }), { action: 'create' });
});

test('an org with no owner (a row from before accounts) is claimed by whoever connects it', () => {
  assert.deepEqual(decideOrgOwnership({ accountId: 5, org: org({ ownerAccountId: null }) }), { action: 'claim', clientId: 12 });
  assert.deepEqual(decideOrgOwnership({ accountId: 5, org: org({ ownerAccountId: undefined }) }), { action: 'claim', clientId: 12 });
});

test('the owner connecting again is a reconnect', () => {
  assert.deepEqual(decideOrgOwnership({ accountId: 5, org: org() }), { action: 'reconnect', clientId: 12 });
});

test('an account that already has the org (a member) reconnects it too', () => {
  assert.deepEqual(decideOrgOwnership({ accountId: 9, org: org({ accountHasAccess: true }) }), { action: 'reconnect', clientId: 12 });
});

test('an org owned by a different account is rejected, and says who owns it for the log', () => {
  assert.deepEqual(decideOrgOwnership({ accountId: 9, org: org() }), { action: 'reject', clientId: 12, ownerAccountId: 5 });
});

test('account ids compare as numbers: the same account is never rejected', () => {
  assert.equal(decideOrgOwnership({ accountId: 5, org: org({ ownerAccountId: 5 }) }).action, 'reconnect');
  assert.equal(decideOrgOwnership({ accountId: 6, org: org({ ownerAccountId: 5 }) }).action, 'reject');
});

test('the rejection log line carries the tenant, the org, both accounts and the attempting login', () => {
  assert.equal(
    formatRejectionLog({ tenantId: 'tid-1', clientId: 12, ownerAccountId: 5, attemptingAccountId: 9, attemptingSubject: 'sub-y', intent: 'add' }),
    '[org-connect] REJECTED tenant=tid-1 client=12 owner_account=5 attempting_account=9 attempting_login=sub-y intent=add'
  );
});

test('missing values show as a dash and the line never contains an email', () => {
  const line = formatRejectionLog({ tenantId: 'tid-1', clientId: 12, ownerAccountId: 5, attemptingAccountId: 9, attemptingEmail: 'x@y.co' });
  assert.equal(line, '[org-connect] REJECTED tenant=tid-1 client=12 owner_account=5 attempting_account=9 attempting_login=- intent=-');
  assert.ok(!line.includes('@'));
});

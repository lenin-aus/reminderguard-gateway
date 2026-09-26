'use strict';

// Runs against a real Postgres that has the schema, migrations/003_accounts.sql and the dev seed
// (the local dev stack). Set PG_TEST_URL, for example:
//   PG_TEST_URL=postgres://postgres:dev@127.0.0.1:55432/postgres node --test accounts.db.test.js
// Every test runs inside a transaction that is rolled back, so nothing is left behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('./accounts');

const url = process.env.PG_TEST_URL;
const skip = !url && 'set PG_TEST_URL to run';

let pool;
test.before(async () => {
  if (!url) return;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: url });
});
test.after(async () => {
  if (pool) await pool.end();
});

// Runs fn with a client in a transaction, then rolls back.
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The dev seed gives some orgs owners; these tests set up their own ownership.
    await client.query('DELETE FROM account_clients');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const login = (subject, extra = {}) => ({ subject, email: `${subject}@example.test`, displayName: subject, ...extra });

test('sign-in creates an account the first time and finds it again', { skip }, () =>
  inTx(async (db) => {
    const first = await a.findOrCreateAccountForIdentity(db, login('sub-x'));
    assert.equal(first.created, true);
    const again = await a.findOrCreateAccountForIdentity(db, login('sub-x', { email: 'new@example.test' }));
    assert.deepEqual(again, { accountId: first.accountId, created: false });
    const other = await a.findOrCreateAccountForIdentity(db, login('sub-y'));
    assert.notEqual(other.accountId, first.accountId);
    const { rows } = await db.query(`SELECT email FROM account_identities WHERE subject = 'sub-x'`);
    assert.equal(rows[0].email, 'new@example.test', 'the email is refreshed at each sign-in');
  }));

test('an org has one owner: a second account cannot claim it, the owner can claim again', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    const B = (await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId;
    assert.equal(await a.claimOrg(db, A, 7), true);
    assert.equal(await a.claimOrg(db, A, 7), true, 'idempotent for the owner');
    assert.equal(await a.claimOrg(db, B, 7), false, 'refused for another account');
    const { rows } = await db.query(`SELECT account_id, role FROM account_clients WHERE client_id = 7`);
    assert.deepEqual(rows, [{ account_id: A, role: 'owner' }]);
  }));

test('the org for a tenant carries its owner and whether this account has access', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    const B = (await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId;
    assert.equal(await a.getOrgByTenant(db, 'no-such-tenant', A), null);

    let found = await a.getOrgByTenant(db, 'dev-tenant-7', A);
    assert.deepEqual([found.clientId, found.ownerAccountId, found.accountHasAccess], [7, null, false], 'a seeded row with no owner');
    assert.equal(a.decideOrgOwnership({ accountId: A, org: found }).action, 'claim');

    await a.claimOrg(db, A, 7);
    found = await a.getOrgByTenant(db, 'dev-tenant-7', A);
    assert.equal(a.decideOrgOwnership({ accountId: A, org: found }).action, 'reconnect');
    found = await a.getOrgByTenant(db, 'dev-tenant-7', B);
    assert.equal(found.ownerAccountId, A);
    assert.equal(a.decideOrgOwnership({ accountId: B, org: found }).action, 'reject');
  }));

test('access checks and the last-used org only cover orgs the account has', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    await a.claimOrg(db, A, 7);
    assert.equal(await a.canAccessClient(db, A, 7), true);
    assert.equal(await a.canAccessClient(db, A, 6), false);
    assert.equal(await a.setLastClient(db, A, 6), false, 'not an org of this account');
    assert.equal(await a.setLastClient(db, A, 7), true);
    assert.equal((await a.getAccount(db, A)).last_client_id, 7);
  }));

test('the org list is sorted by name and reports which orgs need reconnecting', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    await a.claimOrg(db, A, 7);
    await a.claimOrg(db, A, 6);
    let list = await a.listAccountClients(db, A);
    assert.deepEqual(list.map((c) => [c.client_id, c.status, c.role]), [[6, 'active', 'owner'], [7, 'active', 'owner']]);
    assert.equal(list[0].name, 'Legacy weekly (dev)');
    await db.query(`UPDATE connections SET access_token = NULL WHERE id = 6`);
    list = await a.listAccountClients(db, A);
    assert.deepEqual(list.map((c) => [c.client_id, c.status]), [[6, 'RECONNECT_REQUIRED'], [7, 'active']]);
  }));

test('adding a second Xero login to the signed-in account', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    assert.equal((await a.addIdentityToAccount(db, A, login('sub-b'))).result, 'added');
    assert.equal((await a.addIdentityToAccount(db, A, login('sub-b'))).result, 'already_on_account');
    assert.equal((await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId, A, 'signing in with it now opens this account');
  }));

test('recovering from a lock-out: a login that sits on an EMPTY account moves to the signed-in account', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    await a.claimOrg(db, A, 7);
    const B = (await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId; // made by signing in with the second login
    const moved = await a.addIdentityToAccount(db, A, login('sub-b'));
    assert.deepEqual(moved, { result: 'moved_from_empty_account', otherAccountId: B });
    assert.equal((await db.query(`SELECT 1 FROM accounts WHERE id = $1`, [B])).rows.length, 0, 'the empty account is gone');
    assert.equal((await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId, A);
  }));

test('an empty account that still has another login is kept when one login moves out', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    const B = (await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId;
    await a.addIdentityToAccount(db, B, login('sub-c'));
    assert.equal((await a.addIdentityToAccount(db, A, login('sub-b'))).result, 'moved_from_empty_account');
    assert.equal((await db.query(`SELECT 1 FROM accounts WHERE id = $1`, [B])).rows.length, 1);
  }));

test('a login on an account that owns orgs is never moved: it is a conflict', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    const B = (await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId;
    await a.claimOrg(db, B, 6);
    assert.deepEqual(await a.addIdentityToAccount(db, A, login('sub-b')), { result: 'conflict', otherAccountId: B });
    assert.equal((await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId, B, 'unchanged');
  }));

test('a rejection is recorded with everything needed to unpick it', { skip }, () =>
  inTx(async (db) => {
    const A = (await a.findOrCreateAccountForIdentity(db, login('sub-a'))).accountId;
    const B = (await a.findOrCreateAccountForIdentity(db, login('sub-b'))).accountId;
    await a.recordRejection(db, { tenantId: 'dev-tenant-7', tenantName: 'Leninorg (dev)', clientId: 7, ownerAccountId: A, attemptingAccountId: B, attemptingSubject: 'sub-b', attemptingEmail: 'sub-b@example.test', intent: 'signin' });
    const { rows } = await db.query(`SELECT * FROM account_connect_rejections WHERE xero_tenant_id = 'dev-tenant-7'`);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].client_id, rows[0].owning_account_id, rows[0].attempting_account_id, rows[0].attempting_subject, rows[0].intent], [7, A, B, 'sub-b', 'signin']);
  }));

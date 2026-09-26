'use strict';

// Runs against the dev-stack Postgres (schema + migrations/003_accounts.sql). Set PG_TEST_URL:
//   PG_TEST_URL=postgres://postgres:dev@127.0.0.1:55432/postgres node --test fastledgerAuth.db.test.js
// Each test runs in a transaction that is rolled back. Redis, Xero and the id_token check are fakes.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '11'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const accounts = require('./accounts');
const tokenManager = require('./tokenManager');
const { startFlow } = require('./oauthFlow');
const { OidcError } = require('./oidc');
const { completeFastledgerSignIn, REJECT_MESSAGE } = require('./fastledgerAuth');

const url = process.env.PG_TEST_URL;
const skip = !url && 'set PG_TEST_URL to run';

let pool;
test.before(() => {
  if (!url) return;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: url });
});
test.after(async () => {
  if (pool) await pool.end();
});

async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function fakeRedis() {
  const store = new Map();
  return {
    async set(key, value) { store.set(key, value); return 'OK'; },
    async getdel(key) { const v = store.get(key) ?? null; store.delete(key); return v; },
  };
}

const TENANTS = { t1: 'aaaaaaaa-0000-0000-0000-00000000000a', t2: 'bbbbbbbb-0000-0000-0000-00000000000b', t3: 'cccccccc-0000-0000-0000-00000000000c' };
const org = (key, name) => ({ tenantId: TENANTS[key], tenantName: name });

// Builds the dependencies over the transaction's client. `savepoint` makes one org's failure
// undoable without aborting the whole test transaction, as the real per-org transaction does.
function makeDeps(db, { orgs, subject = 'sub-1', idTokenError = null, currency = 'AUD' }) {
  const redis = fakeRedis();
  let sessions = 0;
  return {
    redis,
    deps: {
      pool: db,
      redis,
      accounts,
      tokenManager,
      log: { warn() {}, error() {} },
      senderDefaults: { email: 'noreply@example.test', name: 'FastLedger' },
      xero: {
        fetchConnections: async () => orgs,
        authEventIdFromToken: () => 'evt-1',
        fetchOrganisation: async () => (currency ? { BaseCurrency: currency } : Promise.reject(new Error('down'))),
      },
      verifyIdToken: async () => {
        if (idTokenError) throw new OidcError(idTokenError, 'bad');
        return { subject, xeroUserId: null, email: `${subject}@example.test`, name: subject };
      },
      createAccountSession: async () => `session-${++sessions}`,
      transaction: async (fn) => {
        await db.query('SAVEPOINT org');
        try {
          const r = await fn(db);
          await db.query('RELEASE SAVEPOINT org');
          return r;
        } catch (err) {
          await db.query('ROLLBACK TO SAVEPOINT org');
          throw err;
        }
      },
    },
  };
}

const tokenResponse = { access_token: 'a.b.c', refresh_token: 'r', expires_in: 1800, id_token: 'id' };

async function run(db, opts, flow = { intent: 'signin' }) {
  const { redis, deps } = makeDeps(db, opts);
  const { nonce } = await startFlow(redis, { returnApp: 'fastledger', accountId: null, ...flow });
  return completeFastledgerSignIn(deps, { csrfNonce: nonce, tokenResponse });
}

test('first sign-in creates the account, the org, one connection, and a session', { skip }, () =>
  inTx(async (db) => {
    const r = await run(db, { orgs: [org('t1', 'Org One'), org('t2', 'Org Two')], currency: 'USD' });
    assert.equal(r.ok, true);
    assert.equal(r.sessionToken, 'session-1');
    assert.deepEqual(r.connected.map((c) => [c.name, c.action]), [['Org One', 'create'], ['Org Two', 'create']]);
    assert.equal(r.activeClientId, r.connected[0].clientId);

    const { rows } = await db.query(
      `SELECT cc.client_name, cc.base_currency, cc.auto_statements_enabled, ac.role, ot.connection_id
         FROM client_config cc JOIN account_clients ac ON ac.client_id = cc.id
         JOIN oauth_tokens ot ON ot.client_id = cc.id
        WHERE ac.account_id = $1 ORDER BY cc.id`,
      [r.accountId]
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((x) => [x.role, x.base_currency, x.auto_statements_enabled]), [['owner', 'USD', false], ['owner', 'USD', false]]);
    assert.equal(rows[0].connection_id, rows[1].connection_id, 'one grant, one connection');
    assert.equal((await accounts.getAccount(db, r.accountId)).last_client_id, r.activeClientId);
  }));

test('an unreadable Organisation leaves the base currency empty rather than guessing', { skip }, () =>
  inTx(async (db) => {
    const r = await run(db, { orgs: [org('t1', 'Org One')], currency: null });
    const { rows } = await db.query('SELECT base_currency FROM client_config WHERE id = $1', [r.connected[0].clientId]);
    assert.equal(rows[0].base_currency, null);
  }));

test('signing in again reconnects the same org on a new connection and removes the old one', { skip }, () =>
  inTx(async (db) => {
    const first = await run(db, { orgs: [org('t1', 'Org One')] });
    const before = (await db.query('SELECT connection_id FROM oauth_tokens WHERE client_id = $1', [first.connected[0].clientId])).rows[0].connection_id;
    const second = await run(db, { orgs: [org('t1', 'Org One')] });
    assert.equal(second.accountId, first.accountId);
    assert.deepEqual(second.connected.map((c) => c.action), ['reconnect']);
    const after = (await db.query('SELECT connection_id FROM oauth_tokens WHERE client_id = $1', [first.connected[0].clientId])).rows[0].connection_id;
    assert.notEqual(after, before);
    assert.equal((await db.query('SELECT 1 FROM connections WHERE id = $1', [before])).rowCount, 0, 'the replaced connection is gone');
    assert.equal((await db.query('SELECT 1 FROM client_config WHERE xero_tenant_id = $1', [TENANTS.t1])).rowCount, 1, 'no duplicate org');
  }));

test('reconnecting one org leaves another that shared the old connection working', { skip }, () =>
  inTx(async (db) => {
    const first = await run(db, { orgs: [org('t1', 'One'), org('t2', 'Two')] });
    const [c1, c2] = first.connected.map((c) => c.clientId);
    const shared = (await db.query('SELECT connection_id FROM oauth_tokens WHERE client_id = $1', [c2])).rows[0].connection_id;
    await run(db, { orgs: [org('t1', 'One')] });
    const t2 = (await db.query('SELECT connection_id FROM oauth_tokens WHERE client_id = $1', [c2])).rows[0].connection_id;
    assert.equal(t2, shared, 'org two still points at the connection it had');
    assert.equal((await db.query('SELECT 1 FROM connections WHERE id = $1', [shared])).rowCount, 1, 'and that connection was kept');
    assert.notEqual((await db.query('SELECT connection_id FROM oauth_tokens WHERE client_id = $1', [c1])).rows[0].connection_id, shared);
  }));

test('an org owned by another account is refused, recorded, and left untouched', { skip }, () =>
  inTx(async (db) => {
    const owner = await run(db, { orgs: [org('t1', 'Org One')], subject: 'owner' });
    const cid = owner.connected[0].clientId;
    const conn = (await db.query('SELECT connection_id FROM oauth_tokens WHERE client_id = $1', [cid])).rows[0].connection_id;

    const other = await run(db, { orgs: [org('t1', 'Org One')], subject: 'intruder' });
    assert.equal(other.ok, false);
    assert.equal(other.code, 'ORG_OWNED_BY_ANOTHER_ACCOUNT');
    assert.equal(other.message, REJECT_MESSAGE);

    assert.equal((await db.query('SELECT connection_id FROM oauth_tokens WHERE client_id = $1', [cid])).rows[0].connection_id, conn);
    const rej = (await db.query('SELECT * FROM account_connect_rejections WHERE xero_tenant_id = $1', [TENANTS.t1])).rows;
    assert.equal(rej.length, 1);
    assert.equal(rej[0].xero_tenant_id, TENANTS.t1);
    assert.equal(rej[0].owning_account_id, owner.accountId);
    assert.equal(rej[0].attempting_subject, 'intruder');
  }));

test('a mixed consent connects what it can and skips what is owned elsewhere', { skip }, () =>
  inTx(async (db) => {
    await run(db, { orgs: [org('t1', 'Owned')], subject: 'owner' });
    const r = await run(db, { orgs: [org('t1', 'Owned'), org('t2', 'Free')], subject: 'newcomer' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.connected.map((c) => c.name), ['Free']);
    assert.deepEqual(r.skipped, [{ name: 'Owned', reason: 'OWNED_BY_ANOTHER_ACCOUNT' }]);
  }));

test('an org from before accounts is claimed by the first account that connects it', { skip }, () =>
  inTx(async (db) => {
    const c = await db.query(`INSERT INTO client_config (client_name, xero_tenant_id, super_payment_mode) VALUES ('Legacy', $1, 'payday') RETURNING id`, [TENANTS.t3]);
    const legacyId = c.rows[0].id;
    const legacyConn = await tokenManager.createConnection(tokenResponse, 'self_serve', 'legacy', db);
    await tokenManager.linkClientToConnection(legacyId, legacyConn, TENANTS.t3, db);

    const r = await run(db, { orgs: [org('t3', 'Legacy')] });
    assert.deepEqual(r.connected.map((x) => [x.clientId, x.action]), [[legacyId, 'claim']]);
    assert.equal((await accounts.listAccountClients(db, r.accountId)).length, 1);
    assert.equal((await db.query('SELECT 1 FROM connections WHERE id = $1', [legacyConn])).rowCount, 0);
  }));

test('add-org keeps the account, returns no new session and attaches the org', { skip }, () =>
  inTx(async (db) => {
    const first = await run(db, { orgs: [org('t1', 'One')] });
    const r = await run(db, { orgs: [org('t2', 'Two')] }, { intent: 'add', accountId: first.accountId });
    assert.equal(r.ok, true);
    assert.equal(r.accountId, first.accountId);
    assert.equal(r.sessionToken, null);
    assert.equal((await accounts.listAccountClients(db, first.accountId)).length, 2);
  }));

test('add-org with a Xero login that belongs to another account is refused', { skip }, () =>
  inTx(async (db) => {
    const a = await run(db, { orgs: [org('t1', 'One')], subject: 'login-a' });
    await run(db, { orgs: [org('t2', 'Two')], subject: 'login-b' });
    const r = await run(db, { orgs: [org('t3', 'Three')], subject: 'login-b' }, { intent: 'add', accountId: a.accountId });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'IDENTITY_CONFLICT');
  }));

test('a used, expired or missing round trip is refused', { skip }, () =>
  inTx(async (db) => {
    const { deps } = makeDeps(db, { orgs: [org('t1', 'One')] });
    const r = await completeFastledgerSignIn(deps, { csrfNonce: 'nope', tokenResponse });
    assert.deepEqual([r.ok, r.status, r.code], [false, 403, 'FLOW_EXPIRED']);
  }));

test('a bad id_token creates nothing', { skip }, () =>
  inTx(async (db) => {
    const r = await run(db, { orgs: [org('t1', 'One')], idTokenError: 'NONCE_MISMATCH' });
    assert.deepEqual([r.ok, r.status, r.code], [false, 403, 'NONCE_MISMATCH']);
    assert.equal((await db.query('SELECT 1 FROM client_config WHERE xero_tenant_id = $1', [TENANTS.t1])).rowCount, 0);
    const down = await run(db, { orgs: [org('t1', 'One')], idTokenError: 'KEYS_UNAVAILABLE' });
    assert.equal(down.status, 502);
  }));

test('no orgs in the consent is refused', { skip }, () =>
  inTx(async (db) => {
    const r = await run(db, { orgs: [] });
    assert.deepEqual([r.ok, r.code], [false, 'NO_ORGS']);
  }));

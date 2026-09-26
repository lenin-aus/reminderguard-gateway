'use strict';

// Needs PG_TEST_URL (dev-stack Postgres with migration 003). Each test is rolled back.

const test = require('node:test');
const assert = require('node:assert/strict');
const accounts = require('./accounts');
const { createAccountHandlers } = require('./accountRoutes');
const { redeemConnectTicket } = require('./oauthFlow');

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

function fakeRedis() {
  const store = new Map();
  return {
    async set(k, v) { store.set(k, v); return 'OK'; },
    async getdel(k) { const v = store.get(k) ?? null; store.delete(k); return v; },
  };
}

async function inTx(fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const redis = fakeRedis();
    await fn(db, redis, createAccountHandlers({ db, redis, accounts }));
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

async function call(handler, req) {
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler(req, res);
  return out;
}

// Two orgs on one account, one of them without usable tokens.
async function setup(db) {
  const { accountId } = await accounts.findOrCreateAccountForIdentity(db, { subject: 'w-1', email: 'w@example.test', displayName: 'W' });
  const ids = [];
  for (const [i, name] of ['Beta Org', 'alpha Org'].entries()) {
    const c = await db.query(`INSERT INTO client_config (client_name, xero_tenant_id, super_payment_mode, base_currency) VALUES ($1, $2, 'payday', 'AUD') RETURNING id`, [name, `dddddddd-0000-0000-0000-00000000000${i}`]);
    const conn = await db.query(`INSERT INTO connections (connection_owner_type, owner_label, access_token, refresh_token, expiry_time, is_refreshing) VALUES ('self_serve', 'x', $1, $2, now(), false) RETURNING id`, i === 0 ? ['a', 'b'] : [null, null]);
    await db.query(`INSERT INTO oauth_tokens (client_id, connection_id, xero_tenant_id) VALUES ($1, $2, $3)`, [c.rows[0].id, conn.rows[0].id, `dddddddd-0000-0000-0000-00000000000${i}`]);
    await accounts.claimOrg(db, accountId, c.rows[0].id);
    ids.push(c.rows[0].id);
  }
  return { accountId, beta: ids[0], alpha: ids[1] };
}

test('whoami for an account lists its orgs and opens the first when none was used', { skip }, () =>
  inTx(async (db, _r, h) => {
    const { accountId, beta, alpha } = await setup(db);
    const r = await call(h.whoami, { account_id: accountId });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.clients.map((c) => [c.client_id, c.status]), [[alpha, 'RECONNECT_REQUIRED'], [beta, 'active']], 'sorted by name, each with its own status');
    assert.equal(r.body.client_id, alpha);
    assert.equal(r.body.status, 'RECONNECT_REQUIRED', 'client_id and status describe the org that opens first');
    assert.equal(r.body.last_client_id, null);
    assert.deepEqual(r.body.account, { id: accountId, display_name: 'W', email: 'w@example.test' });
    assert.ok(beta);
  }));

test('whoami opens the last-used org', { skip }, () =>
  inTx(async (db, _r, h) => {
    const { accountId, beta } = await setup(db);
    assert.equal((await call(h.setLastClient, { account_id: accountId, body: { client_id: beta } })).status, 200);
    const r = await call(h.whoami, { account_id: accountId });
    assert.deepEqual([r.body.client_id, r.body.status, r.body.last_client_id], [beta, 'active', beta]);
  }));

test('whoami for a legacy session keeps the old answer', { skip }, () =>
  inTx(async (db, _r, h) => {
    const { beta } = await setup(db);
    assert.deepEqual((await call(h.whoami, { account_id: null, client_id: beta })).body, { client_id: beta, status: 'active' });
    assert.deepEqual((await call(h.whoami, { account_id: null, client_id: 99999999 })).body, { client_id: 99999999, status: 'RECONNECT_REQUIRED' });
  }));

test('last-client refuses an org the account does not have, and bad input', { skip }, () =>
  inTx(async (db, _r, h) => {
    const { accountId } = await setup(db);
    const stranger = await db.query(`INSERT INTO client_config (client_name, super_payment_mode) VALUES ('Not mine', 'payday') RETURNING id`);
    assert.equal((await call(h.setLastClient, { account_id: accountId, body: { client_id: stranger.rows[0].id } })).status, 403);
    assert.equal((await call(h.setLastClient, { account_id: accountId, body: { client_id: '7' } })).status, 400);
    assert.equal((await call(h.setLastClient, { account_id: accountId, body: {} })).status, 400);
    assert.equal((await call(h.setLastClient, { account_id: null, body: { client_id: 1 } })).status, 403);
  }));

test('a connect ticket is issued to an account session, once redeemable, and refused for a legacy one', { skip }, () =>
  inTx(async (db, redis, h) => {
    const { accountId } = await setup(db);
    const r = await call(h.connectTicket, { account_id: accountId });
    assert.equal(r.status, 200);
    assert.equal(await redeemConnectTicket(redis, r.body.ticket), accountId);
    assert.equal(await redeemConnectTicket(redis, r.body.ticket), null);
    assert.equal((await call(h.connectTicket, { account_id: null })).status, 403);
  }));

'use strict';

// Sessions and the org access check against a real Postgres with the schema, migrations/003 and the
// dev seed: PG_TEST_URL=postgres://postgres:dev@127.0.0.1:55432/postgres node --test session.db.test.js
// Each test runs in a transaction that is rolled back.

const test = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.PG_TEST_URL;
const skip = !url && 'set PG_TEST_URL to run';
// session.js requires ./db, which reads PG_* settings; they are not used here because the handlers
// are built on a transaction client, but requiring must not fail.
process.env.PG_HOST = process.env.PG_HOST || '127.0.0.1';

const { createSessionHandlers, hashToken } = require('./session');
const accounts = require('./accounts');

let pool;
test.before(async () => {
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
    // The dev seed gives some orgs owners; these tests set up their own ownership.
    await client.query('DELETE FROM account_clients');
    await fn(client, createSessionHandlers(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// Runs a middleware against fake req/res and reports what happened.
async function run(mw, req) {
  const out = { status: null, body: null, nexted: false };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  // The middleware writes to the request it is given, so fill in defaults on that same object.
  req.query = req.query || {};
  req.headers = req.headers || {};
  req.params = req.params || {};
  await mw(req, res, () => { out.nexted = true; });
  return out;
}
const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

test('an account session resolves to the account, with no org fixed', { skip }, () =>
  inTx(async (db, h) => {
    const { accountId } = await accounts.findOrCreateAccountForIdentity(db, { subject: 'sub-a' });
    const token = await h.createAccountSession(accountId);
    const req = { ...bearer(token) };
    const r = await run(h.resolveSession, req);
    assert.equal(r.nexted, true);
    assert.deepEqual([req.account_id, req.session_client_id, req.client_id], [accountId, null, null]);
    assert.notEqual(token, hashToken(token), 'only the hash is stored');
    assert.equal((await db.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token])).rows.length, 0);
  }));

test('a legacy session (one client, no account) still resolves', { skip }, () =>
  inTx(async (db, h) => {
    const token = await h.createSession(7);
    const req = { ...bearer(token) };
    await run(h.resolveSession, req);
    assert.deepEqual([req.account_id, req.session_client_id, req.client_id], [null, 7, 7]);
  }));

test('no token, an unknown token and an expired session are all 401', { skip }, () =>
  inTx(async (db, h) => {
    assert.equal((await run(h.resolveSession, {})).status, 401);
    assert.equal((await run(h.resolveSession, bearer('nope'))).status, 401);
    const token = await h.createSession(7);
    await db.query(`UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1`, [hashToken(token)]);
    assert.equal((await run(h.resolveSession, bearer(token))).status, 401);
  }));

test('the token is also accepted as ?token=', { skip }, () =>
  inTx(async (db, h) => {
    const token = await h.createSession(7);
    const req = { query: { token } };
    assert.equal((await run(h.resolveSession, req)).nexted, true);
  }));

test('an account can use the orgs it has and no others; the route org becomes req.client_id', { skip }, () =>
  inTx(async (db, h) => {
    const { accountId } = await accounts.findOrCreateAccountForIdentity(db, { subject: 'sub-a' });
    await accounts.claimOrg(db, accountId, 7);
    const base = { account_id: accountId, session_client_id: null, client_id: null };

    const ok = { ...base, params: { clientId: '7' } };
    assert.equal((await run(h.requireClientAccess, ok)).nexted, true);
    assert.equal(ok.client_id, 7);

    const other = { ...base, params: { clientId: '6' } };
    const denied = await run(h.requireClientAccess, other);
    assert.deepEqual([denied.status, denied.nexted, other.client_id], [403, false, null]);
  }));

test("an account never reaches another account's org", { skip }, () =>
  inTx(async (db, h) => {
    const a = (await accounts.findOrCreateAccountForIdentity(db, { subject: 'sub-a' })).accountId;
    const b = (await accounts.findOrCreateAccountForIdentity(db, { subject: 'sub-b' })).accountId;
    await accounts.claimOrg(db, a, 7);
    await accounts.claimOrg(db, b, 6);
    const asB = { account_id: b, session_client_id: null, client_id: null, params: { clientId: '7' } };
    assert.equal((await run(h.requireClientAccess, asB)).status, 403);
  }));

test('a legacy session reaches only its own client', { skip }, () =>
  inTx(async (db, h) => {
    const same = { account_id: null, session_client_id: 7, client_id: 7, params: { clientId: '7' } };
    assert.equal((await run(h.requireClientAccess, same)).nexted, true);
    const other = { account_id: null, session_client_id: 7, client_id: 7, params: { clientId: '8' } };
    assert.equal((await run(h.requireClientAccess, other)).status, 403);
  }));

test('a client id that is not a plain number is refused', { skip }, () =>
  inTx(async (db, h) => {
    for (const bad of ['abc', '7abc', '', '7.0', '-7', '7 ']) {
      const req = { account_id: 1, session_client_id: null, client_id: null, params: { clientId: bad } };
      assert.equal((await run(h.requireClientAccess, req)).status, 403, JSON.stringify(bad));
    }
  }));

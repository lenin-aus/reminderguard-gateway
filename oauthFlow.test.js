'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startFlow, consumeFlow, createConnectTicket, redeemConnectTicket, TTL_SECONDS } = require('./oauthFlow');

// The few Redis commands used, with the expiry recorded so it can be checked.
function fakeRedis() {
  const store = new Map();
  return {
    store,
    async set(key, value, mode, ttl) {
      store.set(key, { value, mode, ttl });
      return 'OK';
    },
    async getdel(key) {
      const entry = store.get(key);
      store.delete(key);
      return entry ? entry.value : null;
    },
  };
}

test('a round trip is remembered once, with the intent and the OIDC nonce, and expires', async () => {
  const redis = fakeRedis();
  const { nonce, oidcNonce } = await startFlow(redis, { intent: 'signin', returnApp: 'fastledger' });
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.ok(oidcNonce.length >= 30 && oidcNonce !== nonce);
  const entry = redis.store.get(`oauth-flow:${nonce}`);
  assert.deepEqual([entry.mode, entry.ttl], ['EX', TTL_SECONDS]);

  assert.deepEqual(await consumeFlow(redis, nonce), { intent: 'signin', accountId: null, returnApp: 'fastledger', oidcNonce });
  assert.equal(await consumeFlow(redis, nonce), null, 'single use');
});

test('every round trip gets its own nonces', async () => {
  const redis = fakeRedis();
  const a = await startFlow(redis, { intent: 'signin', returnApp: 'fastledger' });
  const b = await startFlow(redis, { intent: 'signin', returnApp: 'fastledger' });
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.oidcNonce, b.oidcNonce);
});

test('an unknown, empty or missing nonce finds nothing', async () => {
  const redis = fakeRedis();
  assert.equal(await consumeFlow(redis, 'nope'), null);
  assert.equal(await consumeFlow(redis, ''), null);
  assert.equal(await consumeFlow(redis, undefined), null);
});

test('"connect another org" carries the account, and is refused without one', async () => {
  const redis = fakeRedis();
  const { nonce } = await startFlow(redis, { intent: 'add', accountId: 42, returnApp: 'fastledger' });
  assert.equal((await consumeFlow(redis, nonce)).accountId, 42);
  await assert.rejects(startFlow(redis, { intent: 'add', returnApp: 'fastledger' }), { name: 'TypeError' });
  await assert.rejects(startFlow(redis, { intent: 'delete', returnApp: 'fastledger' }), { name: 'TypeError' });
});

test('a ticket is redeemed once and gives the account it was issued to', async () => {
  const redis = fakeRedis();
  const ticket = await createConnectTicket(redis, 7);
  assert.ok(ticket.length >= 40);
  assert.equal(await redeemConnectTicket(redis, ticket), 7);
  assert.equal(await redeemConnectTicket(redis, ticket), null, 'single use');
});

test('the ticket is stored hashed, never as given, and expires', async () => {
  const redis = fakeRedis();
  const ticket = await createConnectTicket(redis, 7);
  const keys = [...redis.store.keys()];
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes(ticket), 'the raw ticket is not in the key');
  assert.ok(keys[0].startsWith('connect-ticket:'));
  assert.equal(redis.store.get(keys[0]).ttl, TTL_SECONDS);
});

test('a wrong, empty or missing ticket redeems nothing', async () => {
  const redis = fakeRedis();
  await createConnectTicket(redis, 7);
  assert.equal(await redeemConnectTicket(redis, 'wrong'), null);
  assert.equal(await redeemConnectTicket(redis, ''), null);
  assert.equal(await redeemConnectTicket(redis, undefined), null);
  await assert.rejects(createConnectTicket(redis, 'seven'), { name: 'TypeError' });
});

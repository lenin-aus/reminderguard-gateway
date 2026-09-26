'use strict';

// Against a real Redis (getdel and expiry included): REDIS_TEST_PORT=56379 node --test oauthFlow.redis.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const port = process.env.REDIS_TEST_PORT;

test('flow and ticket work on real Redis, expire, and are single use', { skip: !port && 'set REDIS_TEST_PORT to run' }, async () => {
  const Redis = require('ioredis');
  const { startFlow, consumeFlow, createConnectTicket, redeemConnectTicket } = require('./oauthFlow');
  const redis = new Redis({ host: process.env.REDIS_TEST_HOST || '127.0.0.1', port: Number(port) });
  try {
    const { nonce, oidcNonce } = await startFlow(redis, { intent: 'add', accountId: 3, returnApp: 'fastledger' });
    const ttl = await redis.ttl(`oauth-flow:${nonce}`);
    assert.ok(ttl > 590 && ttl <= 600, `ttl ${ttl}`);
    assert.deepEqual(await consumeFlow(redis, nonce), { intent: 'add', accountId: 3, returnApp: 'fastledger', oidcNonce });
    assert.equal(await consumeFlow(redis, nonce), null);

    const ticket = await createConnectTicket(redis, 9);
    assert.equal(await redeemConnectTicket(redis, ticket), 9);
    assert.equal(await redeemConnectTicket(redis, ticket), null);
  } finally {
    redis.disconnect();
  }
});

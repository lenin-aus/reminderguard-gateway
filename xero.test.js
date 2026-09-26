'use strict';

process.env.XERO_CLIENT_ID = 'test-client-id';
process.env.XERO_CLIENT_SECRET = 'test-secret';
process.env.XERO_REDIRECT_URI = 'https://auth.example.test/oauth/callback';
process.env.XERO_SCOPES = 'offline_access accounting.contacts accounting.invoices';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAuthUrl, withIdentityScopes } = require('./xero');

const params = (url) => Object.fromEntries(new URL(url).searchParams);

test('identity scopes are added when missing, once, and the configured scopes stay in order', () => {
  assert.equal(withIdentityScopes('offline_access accounting.contacts'), 'offline_access accounting.contacts openid profile email');
  assert.equal(withIdentityScopes('openid offline_access'), 'openid offline_access profile email');
  assert.equal(withIdentityScopes('offline_access openid profile email'), 'offline_access openid profile email', 'nothing duplicated when all are present');
  assert.equal(withIdentityScopes('  a   b '), 'a b openid profile email', 'extra spaces are tidied');
  assert.equal(withIdentityScopes(undefined), 'openid profile email');
});

test('an identity sign-in asks for the identity scopes and sends the nonce', () => {
  const url = buildAuthUrl('the-state', { identity: true, nonce: 'n-1' });
  assert.ok(url.startsWith('https://login.xero.com/identity/connect/authorize?'));
  assert.deepEqual(params(url), {
    response_type: 'code',
    client_id: 'test-client-id',
    redirect_uri: 'https://auth.example.test/oauth/callback',
    scope: 'offline_access accounting.contacts accounting.invoices openid profile email',
    state: 'the-state',
    nonce: 'n-1',
  });
});

test('the original flow is unchanged: the configured scopes only, and no nonce', () => {
  const p = params(buildAuthUrl('the-state'));
  assert.equal(p.scope, 'offline_access accounting.contacts accounting.invoices');
  assert.equal('nonce' in p, false);
});

test('an identity sign-in without a nonce is refused', () => {
  assert.throws(() => buildAuthUrl('s', { identity: true }), { name: 'TypeError' });
});

test('authEventIdFromToken reads the consent id from the access token claims', () => {
  const { authEventIdFromToken } = require('./xero');
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  assert.equal(authEventIdFromToken(jwt({ authentication_event_id: 'evt-9' })), 'evt-9');
  assert.equal(authEventIdFromToken(jwt({})), null);
  assert.equal(authEventIdFromToken('not-a-jwt'), null);
  assert.equal(authEventIdFromToken(undefined), null);
});

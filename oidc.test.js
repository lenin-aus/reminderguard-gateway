'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { createIdTokenVerifier, OidcError, XERO_ISSUER } = require('./oidc');

const CLIENT_ID = 'test-client-id';
const NONCE = 'nonce-123';

let keys;
let verify;
test.before(async () => {
  const good = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(good.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' };
  keys = { good: good.privateKey, other: other.privateKey };
  verify = createIdTokenVerifier({ clientId: CLIENT_ID, jwks: createLocalJWKSet({ keys: [publicJwk] }) });
});

const nowSec = () => Math.floor(Date.now() / 1000);

// Signs a token the way Xero would, with overrides for the claims and the header.
async function token({ claims = {}, key = 'good', header = {}, exp = nowSec() + 300, iss = XERO_ISSUER, aud = CLIENT_ID } = {}) {
  const jwt = new SignJWT({ nonce: NONCE, sub: 'xero-sub-1', xero_userid: 'xero-user-1', email: 'lenin@example.test', given_name: 'Lenin', family_name: 'Raj', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1', ...header })
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime(exp);
  return jwt.sign(keys[key]);
}

async function code(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof OidcError, `expected OidcError, got ${err}`);
    return err.code;
  }
  assert.fail('expected the token to be rejected');
}

test('a valid token gives the stable subject, the email and the name', async () => {
  assert.deepEqual(await verify(await token(), { nonce: NONCE }), {
    subject: 'xero-sub-1',
    xeroUserId: 'xero-user-1',
    email: 'lenin@example.test',
    name: 'Lenin Raj',
  });
});

test('the email falls back to preferred_username, and a full name claim wins over the parts', async () => {
  const t = await token({ claims: { email: undefined, preferred_username: 'pu@example.test', name: 'Lenin R' } });
  const r = await verify(t, { nonce: NONCE });
  assert.deepEqual([r.email, r.name], ['pu@example.test', 'Lenin R']);
});

test('without sub, xero_userid is the subject; with neither it is refused', async () => {
  assert.equal((await verify(await token({ claims: { sub: undefined } }), { nonce: NONCE })).subject, 'xero-user-1');
  assert.equal(await code(verify(await token({ claims: { sub: undefined, xero_userid: undefined } }), { nonce: NONCE })), 'NO_SUBJECT');
});

test('a token signed by a different key is refused', async () => {
  assert.equal(await code(verify(await token({ key: 'other' }), { nonce: NONCE })), 'INVALID_TOKEN');
});

test('a token naming a key the set does not have is refused', async () => {
  assert.equal(await code(verify(await token({ header: { kid: 'unknown' } }), { nonce: NONCE })), 'INVALID_TOKEN');
});

test('only RS256 is accepted: an unsigned token and an HMAC token are refused', async () => {
  const unsigned = [Buffer.from('{"alg":"none"}').toString('base64url'), Buffer.from(JSON.stringify({ iss: XERO_ISSUER, aud: CLIENT_ID, nonce: NONCE, sub: 'x', exp: nowSec() + 300 })).toString('base64url'), ''].join('.');
  assert.equal(await code(verify(unsigned, { nonce: NONCE })), 'INVALID_TOKEN');
  const hmac = await new SignJWT({ nonce: NONCE, sub: 'x' }).setProtectedHeader({ alg: 'HS256', kid: 'key-1' }).setIssuer(XERO_ISSUER).setAudience(CLIENT_ID).setExpirationTime(nowSec() + 300).sign(new TextEncoder().encode('secret'));
  assert.equal(await code(verify(hmac, { nonce: NONCE })), 'INVALID_TOKEN');
});

test('a token from another issuer is refused', async () => {
  assert.equal(await code(verify(await token({ iss: 'https://evil.example' }), { nonce: NONCE })), 'ISSUER');
});

test('a token issued for another app is refused', async () => {
  assert.equal(await code(verify(await token({ aud: 'someone-elses-app' }), { nonce: NONCE })), 'AUDIENCE');
});

test('an expired token is refused, with a small clock tolerance', async () => {
  assert.equal(await code(verify(await token({ exp: nowSec() - 120 }), { nonce: NONCE })), 'EXPIRED');
  assert.equal((await verify(await token({ exp: nowSec() - 10 }), { nonce: NONCE })).subject, 'xero-sub-1', '10 seconds of drift is tolerated');
});

test('the nonce must match this sign-in: a different or a missing nonce is refused', async () => {
  assert.equal(await code(verify(await token(), { nonce: 'another-signin' })), 'NONCE_MISMATCH');
  assert.equal(await code(verify(await token({ claims: { nonce: undefined } }), { nonce: NONCE })), 'NONCE_MISMATCH');
});

test('verifying without a nonce is a programming error, not a way to skip the check', async () => {
  await assert.rejects(verify(await token()), { name: 'TypeError' });
  await assert.rejects(verify(await token(), { nonce: '' }), { name: 'TypeError' });
});

test('no token, or something that is not a token, is refused', async () => {
  assert.equal(await code(verify(undefined, { nonce: NONCE })), 'MISSING_TOKEN');
  assert.equal(await code(verify('', { nonce: NONCE })), 'MISSING_TOKEN');
  assert.equal(await code(verify('not-a-jwt', { nonce: NONCE })), 'INVALID_TOKEN');
});

test('an unreachable key set is reported as such', async () => {
  const failingKeys = async () => {
    const err = new Error('timed out');
    err.code = 'ERR_JWKS_TIMEOUT';
    throw err;
  };
  const v = createIdTokenVerifier({ clientId: CLIENT_ID, jwks: failingKeys });
  assert.equal(await code(v(await token(), { nonce: NONCE })), 'KEYS_UNAVAILABLE');
});

test('the verifier needs the app client id', () => {
  assert.throws(() => createIdTokenVerifier({}), { name: 'TypeError' });
});

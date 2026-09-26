'use strict';

// Verifying the id_token Xero returns when the app asks for the identity scopes
// (openid profile email). It says WHO signed in: the account is keyed on the token's stable
// subject (`sub`; Xero also sends `xero_userid`), never on the email, which can change.
//
// A token is accepted only if all of these hold:
//   - signed (RS256) by a key in Xero's published key set;
//   - issued by Xero (iss) for this app (aud = the app's client id);
//   - not expired (a small clock tolerance);
//   - carrying the nonce we generated for this sign-in (a replayed or foreign token fails).

const { createRemoteJWKSet, jwtVerify } = require('jose');

const XERO_ISSUER = 'https://identity.xero.com';
const XERO_JWKS_URL = 'https://identity.xero.com/.well-known/openid-configuration/jwks';

// Stable codes, so a caller can decide what to tell the user and what to log.
class OidcError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function mapJoseError(err) {
  switch (err?.code) {
    case 'ERR_JWT_EXPIRED':
      return new OidcError('EXPIRED', 'The id_token has expired', err);
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (err.claim === 'iss') return new OidcError('ISSUER', 'The id_token was not issued by Xero', err);
      if (err.claim === 'aud') return new OidcError('AUDIENCE', 'The id_token was not issued for this app', err);
      return new OidcError('INVALID_TOKEN', `The id_token claim "${err.claim}" failed validation`, err);
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JOSE_GENERIC':
      return new OidcError('KEYS_UNAVAILABLE', 'Could not fetch Xero\'s signing keys', err);
    default:
      // Bad signature, unknown key, malformed token, disallowed algorithm.
      if (err && err.name === 'TypeError') return new OidcError('KEYS_UNAVAILABLE', 'Could not fetch Xero\'s signing keys', err);
      return new OidcError('INVALID_TOKEN', 'The id_token could not be verified', err);
  }
}

// jwks: the key set to check signatures against. In production the default fetches Xero's (and
// caches it, refetching when a token names a key it has not seen); tests pass a local set.
function createIdTokenVerifier({ clientId, issuer = XERO_ISSUER, jwks, clockToleranceSec = 30 } = {}) {
  if (!clientId) throw new TypeError('createIdTokenVerifier needs the app client id (the expected audience)');
  const keys = jwks || createRemoteJWKSet(new URL(XERO_JWKS_URL), { timeoutDuration: 5000, cooldownDuration: 30000 });

  // expectedNonce is required: verifying without it would accept a token from another sign-in.
  return async function verifyIdToken(idToken, { nonce: expectedNonce } = {}) {
    if (!expectedNonce) throw new TypeError('verifyIdToken needs the nonce for this sign-in');
    if (typeof idToken !== 'string' || idToken === '') throw new OidcError('MISSING_TOKEN', 'No id_token was returned');

    let claims;
    try {
      ({ payload: claims } = await jwtVerify(idToken, keys, {
        issuer,
        audience: clientId,
        algorithms: ['RS256'],
        clockTolerance: clockToleranceSec,
      }));
    } catch (err) {
      throw mapJoseError(err);
    }

    if (claims.nonce !== expectedNonce) throw new OidcError('NONCE_MISMATCH', 'The id_token nonce does not match this sign-in');

    const subject = [claims.sub, claims.xero_userid].find((v) => typeof v === 'string' && v !== '');
    if (!subject) throw new OidcError('NO_SUBJECT', 'The id_token has no subject');

    const name = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || null;
    return {
      subject,
      xeroUserId: claims.xero_userid || null,
      email: claims.email || claims.preferred_username || null,
      name,
    };
  };
}

let defaultVerifier = null;
// The production verifier, built on first use from the app's client id.
function verifyXeroIdToken(idToken, options) {
  if (!defaultVerifier) defaultVerifier = createIdTokenVerifier({ clientId: process.env.XERO_CLIENT_ID });
  return defaultVerifier(idToken, options);
}

module.exports = { createIdTokenVerifier, verifyXeroIdToken, OidcError, XERO_ISSUER, XERO_JWKS_URL };

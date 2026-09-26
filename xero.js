// Direct calls to Xero's OAuth2 + Connections endpoints.
// Using plain HTTP calls (not the xero-node SDK wrapper) so every request/response
// is transparent and easy to debug — swap in xero-node later if preferred.

const fetch = require('node-fetch');

const AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

const CLIENT_ID = process.env.XERO_CLIENT_ID;
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const REDIRECT_URI = process.env.XERO_REDIRECT_URI; // e.g. https://auth.fasttrackledger.com/oauth/callback
const SCOPES = process.env.XERO_SCOPES; // space-separated, same list you're already using

// The scopes that make Xero return an id_token saying who signed in (see oidc.js).
const IDENTITY_SCOPES = ['openid', 'profile', 'email'];

// The configured scopes plus any identity scope that is missing. Adding them here as well as in
// the XERO_SCOPES setting means a sign-in never fails because one setting was forgotten.
function withIdentityScopes(scopes) {
  const have = String(scopes || '').split(/\s+/).filter(Boolean);
  return [...have, ...IDENTITY_SCOPES.filter((s) => !have.includes(s))].join(' ');
}

// identity: ask Xero for the id_token as well (the fastledger sign-in). nonce is then required: it
// comes back inside the id_token, which is how oidc.js knows the token belongs to this sign-in.
function buildAuthUrl(state, { identity = false, nonce } = {}) {
  if (identity && !nonce) throw new TypeError('An identity sign-in needs a nonce');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: identity ? withIdentityScopes(SCOPES) : SCOPES,
    state,
  });
  if (identity) params.set('nonce', nonce);
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Xero token exchange failed: ${JSON.stringify(data)}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`Xero token refresh failed: ${JSON.stringify(data)}`);
    err.xeroError = data.error; // e.g. 'invalid_grant' when the client has revoked access in Xero
    throw err;
  }
  return data; // includes a NEW refresh_token — old one is now invalid (rotation)
}

// The orgs connected to this Xero user. With authEventId (from the access token) only the orgs
// ticked in THIS consent come back; without it Xero returns every org the user ever connected to
// the app, which would quietly re-link orgs they did not choose this time.
async function fetchConnections(accessToken, authEventId = null) {
  const url = authEventId ? `${CONNECTIONS_URL}?authEventId=${encodeURIComponent(authEventId)}` : CONNECTIONS_URL;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Xero connections fetch failed: ${JSON.stringify(data)}`);
  return data; // array of { tenantId, tenantName, ... }
}

// The consent this access token came from. Xero puts it in the access token's claims; the token
// was received directly from Xero over TLS, so it is read here, not re-verified.
function authEventIdFromToken(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.authentication_event_id === 'string' && payload.authentication_event_id !== '' ? payload.authentication_event_id : null;
  } catch (_) {
    return null;
  }
}

// The org's own record: name, base currency, country, timezone.
async function fetchOrganisation(accessToken, tenantId) {
  const res = await fetch('https://api.xero.com/api.xro/2.0/Organisation', {
    headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, Accept: 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Xero organisation fetch failed: ${res.status}`);
  return (data.Organisations || [])[0] || null;
}

module.exports = { buildAuthUrl, withIdentityScopes, IDENTITY_SCOPES, exchangeCodeForToken, refreshAccessToken, fetchConnections, authEventIdFromToken, fetchOrganisation };

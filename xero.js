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

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
  });
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

async function fetchConnections(accessToken) {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Xero connections fetch failed: ${JSON.stringify(data)}`);
  return data; // array of { tenantId, tenantName, ... }
}

module.exports = { buildAuthUrl, exchangeCodeForToken, refreshAccessToken, fetchConnections };

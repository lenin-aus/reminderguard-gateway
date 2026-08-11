// Direct calls to Xero's OAuth2 + Connections endpoints, 
// combined with microservice base currency fetching and OAuth callback handlers.
const fetch = require('node-fetch');
const axios = require('axios');
const { pool } = require('./db');
const Redis = require('ioredis');
const config = require('./config');
const { getValidXeroToken } = require('./tokenManager');

const redis = new Redis(config.redisConnectionString);
const baseCurrencyInFlight = new Map();

const AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

const CLIENT_ID = process.env.XERO_CLIENT_ID;
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const REDIRECT_URI = process.env.XERO_REDIRECT_URI; // e.g. https://auth.fasttrackledger.com/oauth/callback
const SCOPES = process.env.XERO_SCOPES; // space-separated scopes

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

async function handleOAuthCallback(clientId, newTenantId, tokens) {
    const { rows } = await pool.query('SELECT xero_tenant_id FROM client_config WHERE id = $1', [clientId]);
    const currentTenantId = rows[0]?.xero_tenant_id;

    // Check if newly connected tenant_id differs from stored client_config.xero_tenant_id
    if (newTenantId !== currentTenantId) {
        await pool.query(
            `UPDATE client_config 
             SET xero_tenant_id = $1, base_currency = NULL, xero_access_token = $2, xero_refresh_token = $3 
             WHERE id = $4`,
            [newTenantId, tokens.access_token, tokens.refresh_token, clientId]
        );
    } else {
        await pool.query(
            `UPDATE client_config 
             SET xero_access_token = $1, xero_refresh_token = $2 
             WHERE id = $3`,
            [tokens.access_token, tokens.refresh_token, clientId]
        );
    }
}

async function getOrFetchBaseCurrency(clientId) {
    // Wrap in finally-cleared in-flight Promise cache
    if (baseCurrencyInFlight.has(clientId)) {
        return baseCurrencyInFlight.get(clientId);
    }

    const promise = (async () => {
        let acquiredLock = false;
        const lockKey = `lock:base_currency:${clientId}`;
        try {
            // Check DB first
            const { rows } = await pool.query('SELECT base_currency, xero_tenant_id FROM client_config WHERE id = $1', [clientId]);
            const client = rows[0];
            
            if (client?.base_currency) {
                return client.base_currency;
            }

            // Acquire Redis lock (poll 200ms up to 5s)
            const startTime = Date.now();
            while (Date.now() - startTime < config.BASE_CURRENCY_TIMEOUT) {
                acquiredLock = await redis.set(lockKey, 'locked', 'NX', 'EX', config.BASE_CURRENCY_LOCK_TTL);
                if (acquiredLock) break;
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            if (!acquiredLock) throw new Error('BASE_CURRENCY_TIMEOUT');

            const token = await getValidXeroToken(clientId);
            
            // Call /Organisation scoped strictly to statements route
            const response = await axios.get('https://api.xero.com/api.xro/2.0/Organisation', {
                headers: { 'Authorization': `Bearer ${token}`, 'xero-tenant-id': client.xero_tenant_id, 'Accept': 'application/json' }
            });

            const baseCurrency = response.data.Organisations[0].BaseCurrency;
            
            // On success, store code in DB
            await pool.query('UPDATE client_config SET base_currency = $1 WHERE id = $2', [baseCurrency, clientId]);
            return baseCurrency;
        } catch (error) {
            console.error('Failed to fetch organisation base currency. Using fallback.', error);
            // Try/catch with 'AUD' fallback
            return 'AUD'; 
        } finally {
            if (acquiredLock) await redis.del(lockKey);
            baseCurrencyInFlight.delete(clientId);
        }
    })();

    baseCurrencyInFlight.set(clientId, promise);
    return promise;
}

// Single source of truth for date generation
function getTenantTodayDateString(timeZone = 'Australia/Melbourne') {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

module.exports = { 
  buildAuthUrl, 
  exchangeCodeForToken, 
  refreshAccessToken, 
  fetchConnections, 
  handleOAuthCallback, 
  getOrFetchBaseCurrency, 
  getTenantTodayDateString 
};

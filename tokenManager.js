const pool = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { refreshAccessToken } = require('./xero');
const Redis = require('ioredis');
const config = require('./config');

const redis = new Redis(config.redisConnectionString);
const inFlightRefreshes = new Map();

const EXPIRY_BUFFER_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Creates a new connection row and stores its token. Returns connection id.
async function createConnection(tokenResponse, connectionOwnerType, ownerLabel) {
  const expiryTime = new Date(Date.now() + tokenResponse.expires_in * 1000);
  const { rows } = await pool.query(
    `INSERT INTO connections (connection_owner_type, owner_label, access_token, refresh_token, expiry_time, is_refreshing, updated_at)
     VALUES ($1, $2, $3, $4, $5, false, now())
     RETURNING id`,
    [connectionOwnerType, ownerLabel, encrypt(tokenResponse.access_token), encrypt(tokenResponse.refresh_token), expiryTime]
  );
  return rows[0].id;
}

// Links a client_config row to a connection + specific tenant.
async function linkClientToConnection(clientId, connectionId, tenantId) {
  await pool.query(
    `INSERT INTO oauth_tokens (client_id, connection_id, xero_tenant_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (client_id) DO UPDATE SET
       connection_id = EXCLUDED.connection_id,
       xero_tenant_id = EXCLUDED.xero_tenant_id,
       updated_at = now()`,
    [clientId, connectionId, tenantId]
  );
}

async function getMapping(clientId) {
  const { rows } = await pool.query('SELECT * FROM oauth_tokens WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

async function getConnection(connectionId) {
  const { rows } = await pool.query('SELECT * FROM connections WHERE id = $1', [connectionId]);
  return rows[0] || null;
}

// Called only when Xero confirms the refresh token itself is dead (invalid_grant)
async function markConnectionRevoked(connectionId) {
  await pool.query(
    `UPDATE connections SET access_token = NULL, refresh_token = NULL, is_refreshing = false, updated_at = now()
     WHERE id = $1`,
    [connectionId]
  );
}

async function saveRefreshedTokens(connectionId, tokenResponse) {
  const expiryTime = new Date(Date.now() + tokenResponse.expires_in * 1000);
  await pool.query(
    `UPDATE connections SET access_token = $1, refresh_token = $2, expiry_time = $3, is_refreshing = false, updated_at = now()
     WHERE id = $4`,
    [encrypt(tokenResponse.access_token), encrypt(tokenResponse.refresh_token), expiryTime, connectionId]
  );
}

// New architecture method: Returns raw access token string, protected by in-flight Promise cache and distributed Redis lock
async function getValidXeroToken(clientId) {
  if (inFlightRefreshes.has(clientId)) {
    return inFlightRefreshes.get(clientId);
  }

  const promise = (async () => {
    const mapping = await getMapping(clientId);
    if (!mapping) {
      const err = new Error('Client is not linked to any Xero connection yet.');
      err.code = 'NOT_CONNECTED';
      throw err;
    }

    const connectionId = mapping.connection_id;
    const lockKey = `lock:xero:token:${connectionId}`;

    try {
      // Distributed Redis Lock (Prevents concurrent refresh race conditions across worker processes)[cite: 3]
      const acquired = await redis.set(lockKey, 'locked', 'NX', 'EX', 15);

      let conn = await getConnection(connectionId);
      if (!conn) {
        const err = new Error('Linked connection no longer exists.');
        err.code = 'CONNECTION_MISSING';
        throw err;
      }

      if (!conn.access_token || !conn.refresh_token) {
        const err = new Error('Xero connection was disconnected by the client. Reconnect required.');
        err.code = 'RECONNECT_REQUIRED';
        throw err;
      }

      const expiryTime = new Date(conn.expiry_time);
      const isExpiringSoon = expiryTime.getTime() - Date.now() < EXPIRY_BUFFER_MS;

      if (!isExpiringSoon) {
        if (acquired) await redis.del(lockKey);
        return decrypt(conn.access_token);
      }

      if (!acquired) {
        // Poll for refreshed token if another worker/process holds the lock
        for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
          await sleep(POLL_INTERVAL_MS);
          conn = await getConnection(connectionId);
          if (conn && new Date(conn.expiry_time).getTime() - Date.now() >= EXPIRY_BUFFER_MS) {
            return decrypt(conn.access_token);
          }
        }
        throw new Error(`Timeout waiting for concurrent token refresh, connection ${connectionId}`);
      }

      try {
        const refreshed = await refreshAccessToken(decrypt(conn.refresh_token));
        await saveRefreshedTokens(connectionId, refreshed);
        await redis.del(lockKey);
        return refreshed.access_token;
      } catch (e) {
        if (e.xeroError === 'invalid_grant') {
          await markConnectionRevoked(connectionId);
          await redis.del(lockKey);
          const err = new Error('Xero connection was disconnected by the client. Reconnect required.');
          err.code = 'RECONNECT_REQUIRED';
          throw err;
        }
        await redis.del(lockKey);
        const err = new Error(`Token refresh failed for connection ${connectionId}: ${e.message}`);
        err.code = 'REFRESH_FAILED';
        throw err;
      }
    } finally {
      inFlightRefreshes.delete(clientId);
    }
  })();

  inFlightRefreshes.set(clientId, promise);
  return promise;
}

// Backward-compatible wrapper returning { accessToken, tenantId }
async function getValidToken(clientId) {
  const mapping = await getMapping(clientId);
  if (!mapping) {
    const err = new Error('Client is not linked to any Xero connection yet.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const accessToken = await getValidXeroToken(clientId);
  return { accessToken, tenantId: mapping.xero_tenant_id };
}

module.exports = { 
  createConnection, 
  linkClientToConnection, 
  getMapping, 
  getConnection, 
  getValidToken, 
  getValidXeroToken,
  saveRefreshedTokens, 
  markConnectionRevoked 
};

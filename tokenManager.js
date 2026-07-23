const pool = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { refreshAccessToken } = require('./xero');

const EXPIRY_BUFFER_MS = 2 * 60 * 1000;
const STALE_LOCK_MS = 30 * 1000;
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

// Called only when Xero confirms the refresh token itself is dead (invalid_grant) —
// i.e. the client disconnected the app in Xero. Nulls stored tokens so future
// attempts fail fast instead of retrying a token that will never work again.
// Deliberately does NOT touch oauth_tokens (breaks Branch A reconnect matching)
// or sessions (client should still see a clear "reconnect" message, not be logged out).
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

// Returns { accessToken, tenantId } for a given client_id.
// Refresh locking is keyed on connection_id — safe when many clients share one connection (practice model).
async function getValidToken(clientId) {
  const mapping = await getMapping(clientId);
  if (!mapping) {
    const err = new Error('Client is not linked to any Xero connection yet.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const connectionId = mapping.connection_id;
  let conn = await getConnection(connectionId);
  if (!conn) {
    const err = new Error('Linked connection no longer exists.');
    err.code = 'CONNECTION_MISSING';
    throw err;
  }

  if (!conn.access_token || !conn.refresh_token) {
    // Already marked dead by a previous failed refresh attempt — fail fast, no point retrying.
    const err = new Error('Xero connection was disconnected by the client. Reconnect required.');
    err.code = 'RECONNECT_REQUIRED';
    throw err;
  }

  const isExpiringSoon = new Date(conn.expiry_time).getTime() - Date.now() < EXPIRY_BUFFER_MS;

  if (!isExpiringSoon) {
    return { accessToken: decrypt(conn.access_token), tenantId: mapping.xero_tenant_id };
  }

  const lockResult = await pool.query(
    `UPDATE connections
     SET is_refreshing = true, refresh_locked_at = now()
     WHERE id = $1
       AND (is_refreshing = false OR refresh_locked_at < now() - interval '${STALE_LOCK_MS / 1000} seconds')
     RETURNING *`,
    [connectionId]
  );

  if (lockResult.rows.length > 0) {
    const lockedConn = lockResult.rows[0];
    try {
      const refreshed = await refreshAccessToken(decrypt(lockedConn.refresh_token));
      await saveRefreshedTokens(connectionId, refreshed);
      return { accessToken: refreshed.access_token, tenantId: mapping.xero_tenant_id };
    } catch (e) {
      if (e.xeroError === 'invalid_grant') {
        // Client disconnected the app in Xero — this refresh token will never work again.
        await markConnectionRevoked(connectionId);
        const err = new Error('Xero connection was disconnected by the client. Reconnect required.');
        err.code = 'RECONNECT_REQUIRED';
        throw err;
      }
      await pool.query('UPDATE connections SET is_refreshing = false WHERE id = $1', [connectionId]);
      const err = new Error(`Token refresh failed for connection ${connectionId}: ${e.message}`);
      err.code = 'REFRESH_FAILED';
      throw err;
    }
  }

  // Someone else (possibly a different client under the same connection) is refreshing — poll
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    conn = await getConnection(connectionId);
    if (!conn.is_refreshing) {
      return { accessToken: decrypt(conn.access_token), tenantId: mapping.xero_tenant_id };
    }
  }
  const err = new Error(`Timed out waiting for concurrent token refresh, connection ${connectionId}`);
  err.code = 'REFRESH_TIMEOUT';
  throw err;
}

module.exports = { createConnection, linkClientToConnection, getMapping, getConnection, getValidToken, saveRefreshedTokens, markConnectionRevoked };

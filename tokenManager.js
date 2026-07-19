const pool = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { refreshAccessToken } = require('./xero');

const EXPIRY_BUFFER_MS = 2 * 60 * 1000; // refresh 2 min before actual expiry
const STALE_LOCK_MS = 30 * 1000; // a lock older than this is assumed crashed, safe to steal
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 10;

async function saveTokens(clientId, tokenResponse, tenantId, connectionOwnerType = 'self_serve') {
  const expiryTime = new Date(Date.now() + tokenResponse.expires_in * 1000);
  await pool.query(
    `INSERT INTO oauth_tokens (client_id, connection_owner_type, xero_tenant_id, access_token, refresh_token, expiry_time, is_refreshing, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, now())
     ON CONFLICT (client_id) DO UPDATE SET
       xero_tenant_id = EXCLUDED.xero_tenant_id,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expiry_time = EXCLUDED.expiry_time,
       is_refreshing = false,
       updated_at = now()`,
    [clientId, connectionOwnerType, tenantId, encrypt(tokenResponse.access_token), encrypt(tokenResponse.refresh_token), expiryTime]
  );
}

async function getRow(clientId) {
  const { rows } = await pool.query('SELECT * FROM oauth_tokens WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns { accessToken, tenantId } — a guaranteed-valid token for this client.
// Handles proactive refresh with atomic locking so two concurrent requests
// for the same client never both try to use the same (about-to-rotate) refresh token.
async function getValidToken(clientId) {
  let row = await getRow(clientId);
  if (!row) {
    const err = new Error('Client has no Xero connection. They need to connect via /oauth/connect.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const isExpiringSoon = new Date(row.expiry_time).getTime() - Date.now() < EXPIRY_BUFFER_MS;

  if (!isExpiringSoon) {
    return { accessToken: decrypt(row.access_token), tenantId: row.xero_tenant_id };
  }

  // Try to atomically acquire the refresh lock
  const lockResult = await pool.query(
    `UPDATE oauth_tokens
     SET is_refreshing = true, refresh_locked_at = now()
     WHERE client_id = $1
       AND (is_refreshing = false OR refresh_locked_at < now() - interval '${STALE_LOCK_MS / 1000} seconds')
     RETURNING *`,
    [clientId]
  );

  if (lockResult.rows.length > 0) {
    // We hold the lock — do the actual refresh
    const lockedRow = lockResult.rows[0];
    try {
      const refreshed = await refreshAccessToken(decrypt(lockedRow.refresh_token));
      await saveTokens(clientId, refreshed, lockedRow.xero_tenant_id, lockedRow.connection_owner_type);
      return { accessToken: refreshed.access_token, tenantId: lockedRow.xero_tenant_id };
    } catch (e) {
      // Release the lock even on failure, so it's not stuck for STALE_LOCK_MS
      await pool.query('UPDATE oauth_tokens SET is_refreshing = false WHERE client_id = $1', [clientId]);
      const err = new Error(`Token refresh failed for client ${clientId}: ${e.message}`);
      err.code = 'REFRESH_FAILED';
      throw err;
    }
  }

  // Someone else is already refreshing — poll until they finish
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    row = await getRow(clientId);
    if (!row.is_refreshing) {
      return { accessToken: decrypt(row.access_token), tenantId: row.xero_tenant_id };
    }
  }
  const err = new Error(`Timed out waiting for concurrent token refresh, client ${clientId}`);
  err.code = 'REFRESH_TIMEOUT';
  throw err;
}

module.exports = { getValidToken, saveTokens, getRow };

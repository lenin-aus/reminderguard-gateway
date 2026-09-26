// Persistent login sessions — an opaque token stored hashed in Postgres, not a JWT. Chosen over a
// JWT specifically so a session can be revoked instantly (DELETE the row) once the Xero disconnect
// webhook gets real signature validation — a JWT would need separate blocklist infrastructure to
// get the same revocation behaviour.
//
// A session belongs to an ACCOUNT (a person, who can have many orgs) or, for sessions created
// before accounts existed, to one client. An account session does not fix which org is in use:
// every /clients/:clientId/... route checks that the account has that org (requireClientAccess).

const crypto = require('crypto');
const pool = require('./db');
const { canAccessClient } = require('./accounts');

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_THRESHOLD_MS = 29 * 24 * 60 * 60 * 1000; // bump expiry once older than this (sliding expiration)

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// db is a pg Pool, or a client inside a transaction (tests).
function createSessionHandlers(db) {
  // The legacy session: one client. Kept for the self-serve app and for sessions that predate
  // accounts, which stay valid until they expire. Returns the RAW token — only this raw value ever
  // leaves the server (in the cookie / redirect URL); the database only stores its hash.
  async function createSession(clientId) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (token_hash, client_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [hashToken(rawToken), clientId]
    );
    return rawToken;
  }

  // A session for a person. It is not tied to any one org.
  async function createAccountSession(accountId) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (token_hash, account_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [hashToken(rawToken), accountId]
    );
    return rawToken;
  }

  // Express middleware. Reads a raw token from ?token= or an Authorization header and verifies it
  // against the sessions table. Sets req.account_id (an account session) or req.session_client_id
  // (a legacy session); req.client_id stays null for an account session until requireClientAccess
  // has checked a route's org, and is the session's client for a legacy session.
  // Responds 401 directly and does not call next() on failure.
  async function resolveSession(req, res, next) {
    const rawToken = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!rawToken) return res.status(401).json({ error: 'No token' });

    const tokenHash = hashToken(rawToken);

    try {
      const { rows } = await db.query(
        'SELECT client_id, account_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > NOW()',
        [tokenHash]
      );
      if (rows.length === 0) return res.status(401).json({ error: 'Invalid or expired session' });

      req.account_id = rows[0].account_id ?? null;
      req.session_client_id = rows[0].client_id ?? null;
      req.client_id = req.session_client_id;

      // Sliding expiration: only write if the session is more than a day from
      // needing it, so a normal page load doesn't cause a DB write every time.
      const isAging = new Date(rows[0].expires_at).getTime() - Date.now() < REFRESH_THRESHOLD_MS;
      if (isAging) {
        await db.query(`UPDATE sessions SET expires_at = NOW() + INTERVAL '30 days' WHERE token_hash = $1`, [tokenHash]);
      }
      next();
    } catch (e) {
      console.error('resolveSession error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }

  // For routes with a :clientId, after resolveSession. The account must have that org (any role),
  // or, for a legacy session, it must be the session's own client. Sets req.client_id to the org.
  async function requireClientAccess(req, res, next) {
    if (!/^\d+$/.test(String(req.params.clientId))) return res.status(403).json({ error: 'Forbidden' });
    const clientId = Number(req.params.clientId);
    try {
      const allowed = req.account_id ? await canAccessClient(db, req.account_id, clientId) : req.session_client_id === clientId;
      if (!allowed) return res.status(403).json({ error: 'Forbidden' });
      req.client_id = clientId;
      next();
    } catch (e) {
      console.error('requireClientAccess error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }

  return { createSession, createAccountSession, resolveSession, requireClientAccess };
}

const handlers = createSessionHandlers(pool);

// Deletes expired session rows on an hourly interval. Call once at startup.
function startSessionCleanupJob() {
  setInterval(async () => {
    try {
      const result = await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
      if (result.rowCount > 0) console.log(`Session cleanup: removed ${result.rowCount} expired session(s).`);
    } catch (e) {
      console.error('Session cleanup job failed:', e);
    }
  }, 60 * 60 * 1000);
}

module.exports = { ...handlers, createSessionHandlers, hashToken, startSessionCleanupJob, SESSION_MAX_AGE_MS };

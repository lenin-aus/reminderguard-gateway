// Persistent self-serve login sessions — an opaque token stored hashed in
// Postgres, not a JWT. Chosen over a JWT specifically so a session can be
// revoked instantly (DELETE the row) once the Xero disconnect webhook gets
// real signature validation — a JWT would need separate blocklist
// infrastructure to get the same revocation behaviour.

const crypto = require('crypto');
const pool = require('./db');

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_THRESHOLD_MS = 29 * 24 * 60 * 60 * 1000; // bump expiry once older than this (sliding expiration)

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Creates a session row for clientId. Returns the RAW token — only this
// raw value ever leaves the server (in the cookie / redirect URL); the
// database only ever stores its hash.
async function createSession(clientId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (token_hash, client_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [hashToken(rawToken), clientId]
  );
  return rawToken;
}

// Express middleware. Reads a raw token from ?token= or an Authorization
// header, verifies it against the sessions table, and sets req.client_id.
// Responds 401 directly and does not call next() on failure.
async function resolveSession(req, res, next) {
  const rawToken = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!rawToken) return res.status(401).json({ error: 'No token' });

  const tokenHash = hashToken(rawToken);

  try {
    const { rows } = await pool.query(
      'SELECT client_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid or expired session' });

    req.client_id = rows[0].client_id;

    // Sliding expiration: only write if the session is more than a day from
    // needing it, so a normal page load doesn't cause a DB write every time.
    const isAging = new Date(rows[0].expires_at).getTime() - Date.now() < REFRESH_THRESHOLD_MS;
    if (isAging) {
      await pool.query(`UPDATE sessions SET expires_at = NOW() + INTERVAL '30 days' WHERE token_hash = $1`, [tokenHash]);
    }
    next();
  } catch (e) {
    console.error('resolveSession error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}

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

module.exports = { createSession, resolveSession, startSessionCleanupJob, SESSION_MAX_AGE_MS };

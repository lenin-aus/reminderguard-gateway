-- ============================================================
-- Migration: self-serve persistent sessions + tenant uniqueness
--
-- Run these statements in order, against the same Postgres database
-- this Gateway already connects to. Stop and investigate if the
-- pre-check query (step 1) returns any rows before running step 3.
-- ============================================================

-- 1. Pre-check: confirm no existing duplicate xero_tenant_id in oauth_tokens.
--    Must return ZERO rows before continuing to step 3.
SELECT xero_tenant_id, COUNT(*)
FROM oauth_tokens
GROUP BY xero_tenant_id
HAVING COUNT(*) > 1;

-- 2. New table: persistent self-serve login sessions (opaque token, hashed).
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- 3. Only run this if step 1 returned zero rows.
--    Prevents two client_config rows from ever mapping to the same Xero org —
--    this is what makes the Branch B race-condition fallback in server.js work
--    (a concurrent duplicate insert will now raise a real 23505 error to catch).
ALTER TABLE oauth_tokens ADD CONSTRAINT unique_xero_tenant UNIQUE (xero_tenant_id);

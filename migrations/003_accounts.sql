-- 003_accounts.sql: accounts for multi-org (see context/docs/multiorg.md in the frontend repo).
--
-- NOT APPLIED. Run by the database owner (not by gateway_user), once, before the gateway version
-- that uses it is deployed:  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f 003_accounts.sql
--
-- Purely additive: existing code ignores the new tables and columns, and existing sessions keep
-- working (a session with client_id and no account_id is the legacy single-org session). The only
-- change to an existing column is that sessions.client_id may now be NULL.
--
-- Numbering: 001_selfserve_sessions.sql exists; 002 is left for scheduled_runs (held for its own commit).

BEGIN;

-- A person. Not unique on email: the Xero user id (account_identities.subject) is what identifies them.
CREATE TABLE IF NOT EXISTS accounts (
    id             serial PRIMARY KEY,
    display_name   text,
    email          text,
    -- The last-used org, kept here so it follows the person across devices.
    last_client_id integer REFERENCES client_config(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- How a person signs in. One account can have several Xero logins; a login belongs to one account.
CREATE TABLE IF NOT EXISTS account_identities (
    id            serial PRIMARY KEY,
    account_id    integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider      text NOT NULL DEFAULT 'xero',
    subject       text NOT NULL,          -- the id_token "sub" (stable; the email can change)
    email         text,                   -- as at the last sign-in, for display and for unpicking
    display_name  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,
    CONSTRAINT account_identities_provider_subject_key UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_account_identities_account ON account_identities (account_id);

-- Which orgs (client_config rows) an account can use. An org has exactly one owner.
CREATE TABLE IF NOT EXISTS account_clients (
    account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    client_id  integer NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    role       text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, client_id)
);
-- The rule "one owner per org", enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS account_clients_one_owner ON account_clients (client_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS idx_account_clients_client ON account_clients (client_id);

-- Every time an org was refused because another account owns it. Read by the operator to unpick a
-- lock-out (for example signing in with a different Xero login). Never shown to the user.
CREATE TABLE IF NOT EXISTS account_connect_rejections (
    id                    serial PRIMARY KEY,
    created_at            timestamptz NOT NULL DEFAULT now(),
    xero_tenant_id        text NOT NULL,
    tenant_name           text,
    client_id             integer REFERENCES client_config(id) ON DELETE SET NULL,
    owning_account_id     integer REFERENCES accounts(id) ON DELETE SET NULL,
    attempting_account_id integer REFERENCES accounts(id) ON DELETE SET NULL,
    attempting_subject    text,           -- the Xero login that tried
    attempting_email      text,
    intent                text            -- 'signin' or 'add'
);
CREATE INDEX IF NOT EXISTS idx_account_connect_rejections_created ON account_connect_rejections (created_at DESC);

-- Sessions belong to an account. client_id stays for legacy single-org sessions until they expire.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS account_id integer REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE sessions ALTER COLUMN client_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_has_account_or_client') THEN
        ALTER TABLE sessions
            ADD CONSTRAINT sessions_has_account_or_client CHECK (account_id IS NOT NULL OR client_id IS NOT NULL);
    END IF;
END $$;

-- The gateway connects as the restricted gateway_user.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE accounts, account_identities, account_clients TO gateway_user;
GRANT SELECT, INSERT ON TABLE account_connect_rejections TO gateway_user;
GRANT SELECT, USAGE ON SEQUENCE accounts_id_seq, account_identities_id_seq, account_connect_rejections_id_seq TO gateway_user;

COMMIT;

-- Rollback (only if nothing has started using it; sessions.client_id cannot go back to NOT NULL
-- while any session has NULL there):
--   BEGIN;
--   DROP TABLE account_connect_rejections, account_clients, account_identities;
--   ALTER TABLE sessions DROP CONSTRAINT sessions_has_account_or_client;
--   ALTER TABLE sessions DROP COLUMN account_id;
--   DROP TABLE accounts;
--   -- then, if every remaining session has a client_id:  ALTER TABLE sessions ALTER COLUMN client_id SET NOT NULL;
--   COMMIT;

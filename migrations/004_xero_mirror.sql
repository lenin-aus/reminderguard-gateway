-- A synced copy of the Xero data that statements and the customer list read (see xeroSync.js and
-- xeroDataLocal.js; design in the frontend repo's context/docs/xero-sync.md).
--
-- Purely additive: nothing reads these tables until an org's xero_read_mode is set to 'shadow' or
-- 'local' (every org starts on 'live', which is today's behaviour). Amounts are integer cents,
-- dates are org-local 'YYYY-MM-DD' text (Xero's transaction dates are date-only, never converted),
-- and ids are Xero's GUIDs as text.

BEGIN;

-- live: read Xero for every request (as before). shadow: still answer from Xero, but also read the
-- copy and log any difference. local: answer from the copy (a send still refreshes its contact live).
ALTER TABLE client_config ADD COLUMN IF NOT EXISTS xero_read_mode text NOT NULL DEFAULT 'live';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_config_xero_read_mode_check') THEN
        ALTER TABLE client_config
            ADD CONSTRAINT client_config_xero_read_mode_check CHECK (xero_read_mode IN ('live', 'shadow', 'local'));
    END IF;
END $$;

-- Per org and resource ('invoices', 'contacts', 'creditNote', 'overpayment', 'prepayment').
CREATE TABLE IF NOT EXISTS xero_sync_state (
    client_id        integer NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    resource         text NOT NULL,
    -- The next incremental pull asks Xero for changes since this (If-Modified-Since).
    watermark        timestamptz,
    last_run_at      timestamptz,
    last_full_at     timestamptz,
    -- Rows the last full pull had to add, change or remove that the incremental pulls had not. Zero
    -- means incremental sync is keeping up; a steady non-zero count means it is missing changes.
    fixed_by_full    integer NOT NULL DEFAULT 0,
    last_error       text,
    last_error_at    timestamptz,
    PRIMARY KEY (client_id, resource)
);

CREATE TABLE IF NOT EXISTS xero_contacts (
    client_id   integer NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    contact_id  text NOT NULL,
    name        text NOT NULL DEFAULT '',
    email       text NOT NULL DEFAULT '',
    archived    boolean NOT NULL DEFAULT false,
    synced_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, contact_id)
);

-- Only AUTHORISED and PAID receivable invoices are kept; a void or delete removes the row.
CREATE TABLE IF NOT EXISTS xero_invoices (
    client_id       integer NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    invoice_id      text NOT NULL,
    number          text NOT NULL DEFAULT '',
    type            text NOT NULL,
    status          text NOT NULL,
    contact_id      text,
    contact_name    text NOT NULL DEFAULT '',
    currency        text,
    date            text,
    due_date        text,
    total           bigint NOT NULL DEFAULT 0,
    amount_paid     bigint NOT NULL DEFAULT 0,
    amount_credited bigint NOT NULL DEFAULT 0,
    amount_due      bigint NOT NULL DEFAULT 0,
    updated_at      timestamptz,
    payments        jsonb NOT NULL DEFAULT '[]',
    synced_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_xero_invoices_contact ON xero_invoices (client_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_xero_invoices_status ON xero_invoices (client_id, status);

-- Posted receivable credit notes, overpayments and prepayments.
CREATE TABLE IF NOT EXISTS xero_credits (
    client_id    integer NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('creditNote', 'overpayment', 'prepayment')),
    credit_id    text NOT NULL,
    contact_id   text,
    number       text NOT NULL DEFAULT '',
    status       text NOT NULL,
    currency     text,
    date         text,
    total        bigint NOT NULL DEFAULT 0,
    remaining    bigint NOT NULL DEFAULT 0,
    allocations  jsonb NOT NULL DEFAULT '[]',
    synced_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, kind, credit_id)
);
CREATE INDEX IF NOT EXISTS idx_xero_credits_contact ON xero_credits (client_id, contact_id);

-- The gateway and its workers connect as the restricted gateway_user.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE xero_sync_state, xero_contacts, xero_invoices, xero_credits TO gateway_user;

COMMIT;

-- Rollback (only while every org is on 'live'):
--   BEGIN;
--   DROP TABLE xero_credits, xero_invoices, xero_contacts, xero_sync_state;
--   ALTER TABLE client_config DROP CONSTRAINT client_config_xero_read_mode_check;
--   ALTER TABLE client_config DROP COLUMN xero_read_mode;
--   COMMIT;

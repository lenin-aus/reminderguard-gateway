-- Action Queue (Parse & Pause): a debtor's reply to a statement pauses chasing on that
-- contact+currency bucket, an LLM (or a cheap regex/chrono-node pass first) extracts intent and a
-- promised date, and the bookkeeper approves from a new dashboard before anything is sent or
-- written to Xero. See inboundReply.js. Purely additive.

BEGIN;

-- So the threaded reply (Approve & Send) can set In-Reply-To/References against the statement
-- that was actually replied to. Captured from Brevo's send response; never set for a send that
-- predates this feature.
ALTER TABLE statement_logs ADD COLUMN IF NOT EXISTS sent_message_id text;

-- The authoritative pause: autoStatementsWorker must skip any bucket with a row here whose
-- resume_after is in the future, regardless of what Xero itself says. PAUSED_PENDING_REVIEW is set
-- the instant a reply arrives, before classification; PAUSED_AGREED_DATE replaces it once the
-- bookkeeper approves a parsed promise date.
-- resume_after NULL means paused indefinitely (PAUSED_PENDING_REVIEW, nothing decided yet); a real
-- timestamp (PAUSED_AGREED_DATE) means paused only until then. Either way, a row present at all is
-- a pause: the worker's guard is "no row, or resume_after in the past" = chaseable.
CREATE TABLE IF NOT EXISTS chase_pause (
    client_id    integer NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    bucket_key   text NOT NULL,
    status       text NOT NULL CHECK (status IN ('PAUSED_PENDING_REVIEW', 'PAUSED_AGREED_DATE')),
    resume_after timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, bucket_key)
);

-- One row per inbound reply: the parse result and the Action Queue card built from it. Unique on
-- (client_id, message_id) so a webhook retry (Brevo, or any provider) cannot double-queue the same
-- email. in_reply_to is the original statement's Brevo Message-ID, kept so the eventual reply can
-- thread under it; sent_message_id is filled in once Approve & Send actually fires one.
CREATE TABLE IF NOT EXISTS inbound_reply (
    id                    serial PRIMARY KEY,
    client_id             integer NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    bucket_key            text NOT NULL,
    contact_name          text NOT NULL DEFAULT '',
    from_email            text NOT NULL,
    subject               text NOT NULL DEFAULT '',
    body_text             text NOT NULL DEFAULT '',
    message_id            text NOT NULL,
    in_reply_to           text,
    source                text NOT NULL CHECK (source IN ('regex', 'llm')),
    intent                text NOT NULL,
    confidence            numeric,
    target_date           date,
    draft_reply           text NOT NULL DEFAULT '',
    proposed_resume_after timestamptz,
    status                text NOT NULL DEFAULT 'PENDING_REVIEW'
                               CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED')),
    decided_at            timestamptz,
    sent_message_id       text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inbound_reply_client_message_key UNIQUE (client_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_reply_pending
    ON inbound_reply (client_id, status) WHERE status = 'PENDING_REVIEW';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE chase_pause TO gateway_user;
GRANT SELECT, INSERT, UPDATE ON TABLE inbound_reply TO gateway_user;
GRANT USAGE, SELECT ON SEQUENCE inbound_reply_id_seq TO gateway_user;

COMMIT;

-- Rollback:
--   BEGIN;
--   DROP TABLE inbound_reply, chase_pause;
--   ALTER TABLE statement_logs DROP COLUMN sent_message_id;
--   COMMIT;

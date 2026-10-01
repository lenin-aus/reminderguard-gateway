-- Payment Receipt automation (AR Canvas 4.3): config on client_config, a dedup/audit log, and a
-- small state table the planner uses to decide who is due (see paymentReceiptPlan.js and
-- paymentReceiptWorker.js). Purely additive; every org starts with receipts_enabled = false.

BEGIN;

ALTER TABLE client_config ADD COLUMN IF NOT EXISTS receipts_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE client_config ADD COLUMN IF NOT EXISTS receipts_schedule_mode text;
ALTER TABLE client_config ADD COLUMN IF NOT EXISTS receipts_schedule_time text;
ALTER TABLE client_config ADD COLUMN IF NOT EXISTS receipt_test_email text;
ALTER TABLE client_config ADD COLUMN IF NOT EXISTS receipt_cc_email text;
ALTER TABLE client_config ADD COLUMN IF NOT EXISTS receipt_alert_email text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_config_receipts_schedule_mode_check') THEN
        ALTER TABLE client_config
            ADD CONSTRAINT client_config_receipts_schedule_mode_check
            CHECK (receipts_schedule_mode IS NULL OR receipts_schedule_mode IN ('every_15_min', 'every_30_min', 'hourly', 'daily_at'));
    END IF;
END $$;

-- The dedup check (a payment is processed once, ever) and the audit trail are the same row.
CREATE TABLE IF NOT EXISTS payment_receipt_log (
    id            serial PRIMARY KEY,
    client_id     integer NOT NULL REFERENCES client_config(id) ON DELETE CASCADE,
    payment_id    text NOT NULL,
    invoice_number text NOT NULL DEFAULT '',
    contact_name  text NOT NULL DEFAULT '',
    amount_paid   bigint NOT NULL DEFAULT 0,
    status        text NOT NULL CHECK (status IN ('SENT', 'SKIPPED_NO_EMAIL', 'FAILED')),
    error_message text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payment_receipt_log_client_payment_key UNIQUE (client_id, payment_id)
);

-- Per org: when it was last checked, so the planner knows who is due, and the last error.
CREATE TABLE IF NOT EXISTS payment_receipt_state (
    client_id      integer PRIMARY KEY REFERENCES client_config(id) ON DELETE CASCADE,
    last_checked_at timestamptz,
    last_error     text,
    last_error_at  timestamptz
);

GRANT SELECT, INSERT, UPDATE ON TABLE payment_receipt_log, payment_receipt_state TO gateway_user;
GRANT USAGE, SELECT ON SEQUENCE payment_receipt_log_id_seq TO gateway_user;

COMMIT;

-- Rollback:
--   BEGIN;
--   DROP TABLE payment_receipt_state, payment_receipt_log;
--   ALTER TABLE client_config DROP CONSTRAINT client_config_receipts_schedule_mode_check;
--   ALTER TABLE client_config DROP COLUMN receipts_enabled, DROP COLUMN receipts_schedule_mode,
--     DROP COLUMN receipts_schedule_time, DROP COLUMN receipt_test_email, DROP COLUMN receipt_cc_email,
--     DROP COLUMN receipt_alert_email;
--   COMMIT;

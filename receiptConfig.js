// receiptConfig.js
// Pure validation and shaping for the Payment Receipt settings served by
// GET/PUT /clients/:clientId/receipt-config. No DB, no Express, no side effects.
// Mirrors scheduleConfig.js (the statement schedule's own validator) — kept separate because the
// two settings are unrelated (different worker, different columns, different cadence shape).

const SCHEDULE_MODES = ['every_15_min', 'every_30_min', 'hourly', 'daily_at'];
const TIMES = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Keys a client may send. Everything else (client_id, id, ...) is rejected.
const WRITABLE_KEYS = [
  'receipts_enabled',
  'receipts_schedule_mode',
  'receipts_schedule_time',
  'receipt_test_email',
  'receipt_cc_email',
  'receipt_alert_email',
];

const READ_KEYS = [...WRITABLE_KEYS];

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function emailField(value, { required }) {
  if (value === null) return required ? 'Required while receipts are on' : null;
  if (typeof value !== 'string' || !EMAIL_RE.test(value)) return 'Must be a valid email address, or null';
  return null;
}

const FIELD_CHECKS = {
  receipts_enabled: (value) => (typeof value === 'boolean' ? null : 'Must be true or false'),
  receipts_schedule_mode: (value) =>
    value === null || SCHEDULE_MODES.includes(value)
      ? null
      : `Must be null or one of: ${SCHEDULE_MODES.join(', ')}`,
  receipts_schedule_time: (value) =>
    value === null || TIMES.includes(value) ? null : `Must be null or one of: ${TIMES.join(', ')}`,
  receipt_test_email: (value) => emailField(value, { required: false }),
  receipt_cc_email: (value) => emailField(value, { required: false }),
  receipt_alert_email: (value, body) => emailField(value, { required: body.receipts_enabled === true }),
};

// Returns { ok: true, value } with the six writable keys, or { ok: false, fields } where fields
// maps a key to a message for inline display.
function validateReceiptConfig(body) {
  if (!isPlainObject(body)) {
    return { ok: false, fields: { _body: 'Body must be a JSON object' } };
  }

  const fields = {};

  for (const key of Object.keys(body)) {
    if (!WRITABLE_KEYS.includes(key)) fields[key] = 'Unknown field';
  }
  for (const key of WRITABLE_KEYS) {
    if (!(key in body)) fields[key] = 'Required';
    else if (!fields[key]) {
      const problem = FIELD_CHECKS[key](body[key], body);
      if (problem) fields[key] = problem;
    }
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  const { receipts_enabled: enabled, receipts_schedule_mode: mode, receipts_schedule_time: time } = body;

  // A schedule mode and (for daily_at) a time are only required while receipts are actually on:
  // a paused row is allowed to be incomplete, the same rule the statement schedule uses.
  if (enabled) {
    if (mode === null) fields.receipts_schedule_mode = 'Choose how often to check for new payments';
    if (mode === 'daily_at' && time === null) fields.receipts_schedule_time = 'Choose a time';
  }
  if (mode !== 'daily_at' && time !== null) {
    fields.receipts_schedule_time = 'Only used with "a specific time each day"';
  }

  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, value: body };
}

// Shapes a client_config row for the API: only the receipt columns, '' treated as null (a
// not-yet-configured row may hold '' from older direct writes, same convention as scheduleConfig).
function toApiReceiptConfig(row) {
  const config = {};
  for (const key of READ_KEYS) {
    const value = row[key];
    config[key] = value === '' || value === undefined ? null : value;
  }
  return config;
}

module.exports = {
  validateReceiptConfig,
  toApiReceiptConfig,
  SCHEDULE_MODES,
  TIMES,
  WRITABLE_KEYS,
  READ_KEYS,
};

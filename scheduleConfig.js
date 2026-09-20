// scheduleConfig.js
// Pure validation and shaping for the auto-statement schedule settings served by
// GET/PUT /clients/:clientId/config. No DB, no Express, no side effects.

const { normalizeConfig } = require('./scheduleCalc');

const TIMEZONE = 'Australia/Melbourne';
const MAX_INTERVAL = 52;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const UNITS = ['week', 'month'];
const TIMES = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
const PERIOD_END_RULES = ['last_day_previous_month'];
const RECIPIENT_LISTS = ['all'];
const RECIPIENT_FILTERS = ['active', 'outstanding', 'outstanding_or_credits', 'overdue'];
const RECIPIENT_TARGETS = ['primary'];

function ordinalLabel(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `the ${n}${suffix}`;
}

// Canonical stored form, as written by the Appsmith form: 'the 1st'..'the 28th', 'the last'.
const ORDINALS = ['the last', ...Array.from({ length: 28 }, (_, i) => ordinalLabel(i + 1))];
const WEEKDAY_ORDINALS = ['the last', ...Array.from({ length: 4 }, (_, i) => ordinalLabel(i + 1))];

// Keys a client may send. Everything else (client_id, id, schedule_timezone, next_run_at, ...)
// is rejected, so nothing outside this whitelist can ever be written.
const WRITABLE_KEYS = [
  'auto_statements_enabled',
  'schedule_unit',
  'schedule_interval',
  'schedule_day',
  'schedule_ordinal',
  'schedule_time',
  'statement_period_end_rule',
  'recipient_list',
  'recipient_filter',
  'recipient_target',
];

// Columns returned by GET and PUT (the writable keys plus the server-set timezone).
const READ_KEYS = [
  'auto_statements_enabled',
  'schedule_interval',
  'schedule_unit',
  'schedule_ordinal',
  'schedule_day',
  'schedule_time',
  'schedule_timezone',
  'statement_period_end_rule',
  'recipient_list',
  'recipient_filter',
  'recipient_target',
];

const oneOf = (allowed) => (value) =>
  allowed.includes(value) ? null : `Must be one of: ${allowed.join(', ')}`;
const oneOfOrNull = (allowed) => (value) =>
  value === null || allowed.includes(value) ? null : `Must be null or one of: ${allowed.join(', ')}`;

const FIELD_CHECKS = {
  auto_statements_enabled: (value) => (typeof value === 'boolean' ? null : 'Must be true or false'),
  schedule_unit: oneOf(UNITS),
  schedule_interval: (value) =>
    Number.isInteger(value) && value >= 1 && value <= MAX_INTERVAL
      ? null
      : `Must be a whole number from 1 to ${MAX_INTERVAL}`,
  schedule_day: oneOfOrNull(['day', ...WEEKDAYS]),
  schedule_ordinal: oneOfOrNull(ORDINALS),
  schedule_time: oneOf(TIMES),
  statement_period_end_rule: oneOf(PERIOD_END_RULES),
  recipient_list: oneOf(RECIPIENT_LISTS),
  recipient_filter: oneOf(RECIPIENT_FILTERS),
  recipient_target: oneOf(RECIPIENT_TARGETS),
};

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Returns { ok: true, value } with the ten writable keys plus schedule_timezone, or
// { ok: false, fields } where fields maps a key to a message for inline display.
function validateScheduleConfig(body) {
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
      const problem = FIELD_CHECKS[key](body[key]);
      if (problem) fields[key] = problem;
    }
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  const { auto_statements_enabled: enabled, schedule_unit: unit, schedule_day: day } = body;
  const ordinal = body.schedule_ordinal;
  const isWeekday = WEEKDAYS.includes(day);

  // Contradictions are rejected whether or not the schedule is enabled.
  if (unit === 'week') {
    if (day === 'day') fields.schedule_day = 'A weekly schedule needs a weekday, not "day"';
    if (ordinal !== null) fields.schedule_ordinal = 'A weekly schedule has no ordinal';
  } else if (isWeekday && ordinal !== null && !WEEKDAY_ORDINALS.includes(ordinal)) {
    fields.schedule_ordinal = 'With a weekday, choose the 1st to 4th or the last';
  }

  // Missing values are only allowed while the schedule is paused: real rows are incomplete.
  if (enabled) {
    if (unit === 'week') {
      if (day === null) fields.schedule_day = 'Choose a weekday';
    } else {
      if (day === null) fields.schedule_day = 'Choose "day" or a weekday';
      if (ordinal === null) fields.schedule_ordinal = 'Choose an ordinal';
    }
  }

  const value = { ...body, schedule_timezone: TIMEZONE };

  // Safety net: anything accepted for an enabled schedule must be computable by the heartbeat.
  if (enabled && Object.keys(fields).length === 0) {
    try {
      normalizeConfig(value);
    } catch (e) {
      fields._schedule = e.message;
    }
  }

  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, value };
}

// Shapes a client_config row for the API: only the schedule columns, empty strings as null
// (real rows hold '' for unset ordinals and recipient fields), next_run_at as ISO or null.
function toApiConfig(row) {
  const config = {};
  for (const key of READ_KEYS) {
    const value = row[key];
    config[key] = value === '' || value === undefined ? null : value;
  }
  config.next_run_at = row.next_run_at ? new Date(row.next_run_at).toISOString() : null;
  return config;
}

module.exports = {
  validateScheduleConfig,
  toApiConfig,
  ordinalLabel,
  TIMEZONE,
  MAX_INTERVAL,
  WEEKDAYS,
  ORDINALS,
  WEEKDAY_ORDINALS,
  TIMES,
  WRITABLE_KEYS,
  READ_KEYS,
};

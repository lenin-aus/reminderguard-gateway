'use strict';

// Resolves and validates the statement date range a user picks in the send modal.
//
// Boundaries are calendar days in the CLIENT's timezone (client_config.schedule_timezone,
// default Australia/Melbourne), never UTC: start is 00:00:00.000 local and end is
// 23:59:59.999 local. Xero's transaction dates are date-only local dates, so the range is
// compared against them as 'YYYY-MM-DD' strings; the UTC instants (startUtc/endUtc) are for
// anything that filters on timestamps (a cache, a database column) and are correct across
// daylight-saving changes because luxon computes them from the local wall-clock time.

const { DateTime, IANAZone } = require('luxon');

const DEFAULT_TIMEZONE = 'Australia/Melbourne';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Same shape as the schedule config PUT's validation failure: { error, code, fields }.
class StatementOptionsError extends Error {
  constructor(fields, message = 'Invalid statement options') {
    super(message);
    this.name = 'StatementOptionsError';
    this.code = 'VALIDATION_FAILED';
    this.fields = fields;
  }
}

function assertTimezone(timezone) {
  if (!IANAZone.isValidZone(timezone)) throw new Error(`Unknown timezone: ${timezone}`);
}

// Today's calendar date in the client's timezone, as 'YYYY-MM-DD'.
function todayInTimezone(timezone = DEFAULT_TIMEZONE, now = Date.now) {
  assertTimezone(timezone);
  return DateTime.fromMillis(now(), { zone: timezone }).toISODate();
}

function parseDate(value, timezone) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const dt = DateTime.fromISO(value, { zone: timezone });
  return dt.isValid ? dt : null;
}

// Returns null when no range was requested (a scheduled send), a resolved range when both
// dates are valid, and throws StatementOptionsError otherwise.
function resolveRange({ startDate, endDate } = {}, { timezone = DEFAULT_TIMEZONE, now = Date.now } = {}) {
  assertTimezone(timezone);
  const hasStart = startDate !== undefined && startDate !== null;
  const hasEnd = endDate !== undefined && endDate !== null;
  if (!hasStart && !hasEnd) return null;

  const fields = {};
  if (!hasStart) fields.start_date = 'A start date is needed when an end date is given';
  if (!hasEnd) fields.end_date = 'An end date is needed when a start date is given';

  const start = hasStart ? parseDate(startDate, timezone) : null;
  const end = hasEnd ? parseDate(endDate, timezone) : null;
  if (hasStart && !start) fields.start_date = 'Use a date in the form YYYY-MM-DD';
  if (hasEnd && !end) fields.end_date = 'Use a date in the form YYYY-MM-DD';

  if (start && end) {
    if (end < start) fields.end_date = 'The end date cannot be before the start date';
    else if (end.toISODate() > todayInTimezone(timezone, now)) fields.end_date = 'The end date cannot be in the future';
  }

  if (Object.keys(fields).length > 0) throw new StatementOptionsError(fields);

  return {
    start: start.toISODate(),
    end: end.toISODate(),
    startUtc: start.startOf('day').toUTC().toISO(),
    endUtc: end.endOf('day').toUTC().toISO(),
    timezone,
  };
}

module.exports = { resolveRange, todayInTimezone, StatementOptionsError, DEFAULT_TIMEZONE };

'use strict';

// Validation and identity of the per-send options the send modal collects. They apply to one
// send only and ride on the queued job; nothing here is saved as a client default.
//
//   { start_date, end_date, reply_to, bcc, subject, body }   all optional
//
// Failures throw StatementOptionsError, whose { error, code: 'VALIDATION_FAILED', fields }
// is the same shape the schedule config PUT returns.

const crypto = require('crypto');
const { resolveRange, StatementOptionsError, DEFAULT_TIMEZONE } = require('./statementRange');
const { placeholdersIn, unknownPlaceholders, MAX_SUBJECT, MAX_BODY } = require('./statementTemplate');

const KEYS = ['start_date', 'end_date', 'reply_to', 'bcc', 'subject', 'body'];
const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;
const RANGE_PLACEHOLDERS = new Set(['start_date', 'end_date']);

function text(input, key, fields) {
  const value = input[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    fields[key] = 'Must be text';
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// Returns null when there are no options (a scheduled send, or an empty modal), otherwise
// { range, replyTo, bcc, subject, body } with null for anything not given.
function validateStatementOptions(input, { timezone = DEFAULT_TIMEZONE, now = Date.now } = {}) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new StatementOptionsError({ options: 'Must be an object' });
  }

  const fields = {};
  for (const key of Object.keys(input)) {
    if (!KEYS.includes(key)) fields[key] = 'Unknown field';
  }

  const replyTo = text(input, 'reply_to', fields);
  const bcc = text(input, 'bcc', fields);
  for (const [key, value] of [['reply_to', replyTo], ['bcc', bcc]]) {
    if (value !== null && (value.length > 254 || !EMAIL.test(value))) fields[key] = 'Enter a single valid email address';
  }

  const subject = text(input, 'subject', fields);
  const body = text(input, 'body', fields);
  if (subject !== null && subject.length > MAX_SUBJECT) fields.subject = `Keep the subject under ${MAX_SUBJECT} characters`;
  if (body !== null && body.length > MAX_BODY) fields.body = `Keep the body under ${MAX_BODY} characters`;

  let range = null;
  try {
    range = resolveRange({ startDate: emptyToUndefined(input.start_date), endDate: emptyToUndefined(input.end_date) }, { timezone, now });
  } catch (err) {
    if (!(err instanceof StatementOptionsError)) throw err;
    Object.assign(fields, err.fields);
  }

  for (const [key, value] of [['subject', subject], ['body', body]]) {
    if (value === null || fields[key]) continue;
    const unknown = unknownPlaceholders(value);
    if (unknown.length > 0) {
      fields[key] = `Unknown placeholder: ${unknown.map((n) => `{{${n}}}`).join(', ')}`;
    } else if (!range && placeholdersIn(value).some((n) => RANGE_PLACEHOLDERS.has(n))) {
      fields[key] = 'Uses {{start_date}} or {{end_date}}, but no date range was given';
    }
  }

  if (Object.keys(fields).length > 0) throw new StatementOptionsError(fields);
  if (!range && replyTo === null && bcc === null && subject === null && body === null) return null;
  return { range, replyTo, bcc, subject, body };
}

function emptyToUndefined(value) {
  return value === '' ? undefined : value;
}

// Identifies "the same send": an identical resend on the same day is blocked as before, while a
// corrected one (different range, subject, ...) is a different send and goes out.
function statementOptionsHash(options) {
  if (!options) return 'default';
  const canonical = JSON.stringify([
    options.range ? [options.range.start, options.range.end] : null,
    options.replyTo,
    options.bcc,
    options.subject,
    options.body,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

// The Redis key that marks a statement as sent today. Without options it is exactly the key the
// system has always used, so sends queued before a deploy keep their protection.
function statementLockKey(clientId, bucketKey, todayDateString, optionsHash = 'default') {
  const base = `sent-statement:${clientId}:${bucketKey}:${todayDateString}`;
  return optionsHash === 'default' ? base : `${base}:${optionsHash}`;
}

module.exports = { validateStatementOptions, statementOptionsHash, statementLockKey, StatementOptionsError };

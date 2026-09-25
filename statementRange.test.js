'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRange, todayInTimezone, StatementOptionsError } = require('./statementRange');

const at = (iso) => () => Date.parse(iso);
const NOON_MELBOURNE_25_SEP = at('2026-09-25T02:00:00Z');

function fieldsOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof StatementOptionsError, `expected StatementOptionsError, got ${err}`);
    assert.equal(err.code, 'VALIDATION_FAILED');
    return err.fields;
  }
  assert.fail('expected a validation error');
}

test('no dates means no range (a scheduled send)', () => {
  assert.equal(resolveRange({}, { now: NOON_MELBOURNE_25_SEP }), null);
  assert.equal(resolveRange({ startDate: null, endDate: undefined }, { now: NOON_MELBOURNE_25_SEP }), null);
});

test('a range is midnight to 23:59:59.999 in the client timezone, converted to UTC', () => {
  const r = resolveRange({ startDate: '2026-08-01', endDate: '2026-08-31' }, { timezone: 'Australia/Melbourne', now: NOON_MELBOURNE_25_SEP });
  assert.deepEqual(r, {
    start: '2026-08-01',
    end: '2026-08-31',
    startUtc: '2026-07-31T14:00:00.000Z', // 00:00 AEST (+10) is 14:00 UTC the day before
    endUtc: '2026-08-31T13:59:59.999Z',
    timezone: 'Australia/Melbourne',
  });
});

test('daylight saving: the boundaries follow the wall clock across the 4 Oct 2026 change', () => {
  const now = at('2026-11-01T00:00:00Z');
  const before = resolveRange({ startDate: '2026-10-04', endDate: '2026-10-04' }, { now });
  assert.equal(before.startUtc, '2026-10-03T14:00:00.000Z', '00:00 on 4 Oct is still AEST (+10)');
  assert.equal(before.endUtc, '2026-10-04T12:59:59.999Z', '23:59 on 4 Oct is AEDT (+11)');
  const after = resolveRange({ startDate: '2026-10-05', endDate: '2026-10-05' }, { now });
  assert.equal(after.startUtc, '2026-10-04T13:00:00.000Z');
});

test('the timezone decides what "today" is: just after midnight in Melbourne it is already tomorrow in UTC', () => {
  const justAfterMidnightMelbourne = at('2026-09-25T14:30:00Z'); // 00:30 on 26 Sep in Melbourne
  assert.equal(todayInTimezone('Australia/Melbourne', justAfterMidnightMelbourne), '2026-09-26');
  assert.equal(todayInTimezone('UTC', justAfterMidnightMelbourne), '2026-09-25');
  const r = resolveRange({ startDate: '2026-09-01', endDate: '2026-09-26' }, { now: justAfterMidnightMelbourne });
  assert.equal(r.end, '2026-09-26');
});

test('an end date of today is allowed, tomorrow is not', () => {
  assert.equal(resolveRange({ startDate: '2026-09-01', endDate: '2026-09-25' }, { now: NOON_MELBOURNE_25_SEP }).end, '2026-09-25');
  assert.deepEqual(fieldsOf(() => resolveRange({ startDate: '2026-09-01', endDate: '2026-09-26' }, { now: NOON_MELBOURNE_25_SEP })), {
    end_date: 'The end date cannot be in the future',
  });
});

test('an end date before the start date is rejected; the same day is fine', () => {
  assert.deepEqual(fieldsOf(() => resolveRange({ startDate: '2026-09-10', endDate: '2026-09-09' }, { now: NOON_MELBOURNE_25_SEP })), {
    end_date: 'The end date cannot be before the start date',
  });
  assert.equal(resolveRange({ startDate: '2026-09-10', endDate: '2026-09-10' }, { now: NOON_MELBOURNE_25_SEP }).start, '2026-09-10');
});

test('one date without the other, and malformed dates, are field errors', () => {
  assert.deepEqual(fieldsOf(() => resolveRange({ startDate: '2026-09-01' }, { now: NOON_MELBOURNE_25_SEP })), {
    end_date: 'An end date is needed when a start date is given',
  });
  assert.deepEqual(fieldsOf(() => resolveRange({ endDate: '2026-09-01' }, { now: NOON_MELBOURNE_25_SEP })), {
    start_date: 'A start date is needed when an end date is given',
  });
  const bad = fieldsOf(() => resolveRange({ startDate: '01/09/2026', endDate: '2026-02-30' }, { now: NOON_MELBOURNE_25_SEP }));
  assert.deepEqual(bad, { start_date: 'Use a date in the form YYYY-MM-DD', end_date: 'Use a date in the form YYYY-MM-DD' });
});

test('an unknown timezone is a programming error, not a validation error', () => {
  assert.throws(() => resolveRange({ startDate: '2026-09-01', endDate: '2026-09-02' }, { timezone: 'Mars/Olympus' }), /Unknown timezone/);
});

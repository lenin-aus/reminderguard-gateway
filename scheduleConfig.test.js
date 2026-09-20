const test = require('node:test');
const assert = require('node:assert/strict');

const { computeFirstRun } = require('./scheduleCalc');
const {
  validateScheduleConfig,
  toApiConfig,
  ordinalLabel,
  WEEKDAYS,
  ORDINALS,
  WEEKDAY_ORDINALS,
  TIMES,
  WRITABLE_KEYS,
  READ_KEYS,
} = require('./scheduleConfig');

const monthlyDay = () => ({
  auto_statements_enabled: true,
  schedule_unit: 'month',
  schedule_interval: 1,
  schedule_day: 'day',
  schedule_ordinal: 'the 16th',
  schedule_time: '11:00',
  statement_period_end_rule: 'last_day_previous_month',
  recipient_list: 'all',
  recipient_filter: 'active',
  recipient_target: 'primary',
});

const weekly = () => ({ ...monthlyDay(), schedule_unit: 'week', schedule_day: 'Sunday', schedule_ordinal: null });
const paused = (overrides) => ({ ...monthlyDay(), auto_statements_enabled: false, ...overrides });

const fieldsOf = (body) => {
  const result = validateScheduleConfig(body);
  assert.equal(result.ok, false, 'expected validation to fail');
  return result.fields;
};

test('ordinal labels use the right suffixes', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 24, 28].map(ordinalLabel),
    ['the 1st', 'the 2nd', 'the 3rd', 'the 4th', 'the 11th', 'the 12th', 'the 13th', 'the 21st', 'the 22nd', 'the 23rd', 'the 24th', 'the 28th'],
  );
  assert.equal(ORDINALS.length, 29);
  assert.deepEqual(WEEKDAY_ORDINALS, ['the last', 'the 1st', 'the 2nd', 'the 3rd', 'the 4th']);
});

test('accepts a monthly calendar-day schedule and sets the timezone itself', () => {
  const result = validateScheduleConfig(monthlyDay());
  assert.equal(result.ok, true);
  assert.equal(result.value.schedule_timezone, 'Australia/Melbourne');
  assert.deepEqual(Object.keys(result.value).sort(), READ_KEYS.slice().sort());
});

test('accepts weekly, and monthly on a weekday', () => {
  assert.equal(validateScheduleConfig(weekly()).ok, true);
  assert.equal(
    validateScheduleConfig({ ...monthlyDay(), schedule_day: 'Tuesday', schedule_ordinal: 'the last' }).ok,
    true,
  );
  assert.equal(
    validateScheduleConfig({ ...monthlyDay(), schedule_day: 'Tuesday', schedule_ordinal: 'the 4th' }).ok,
    true,
  );
});

test('rejects every key outside the whitelist, including a client id in the body', () => {
  for (const key of ['client_id', 'id', 'schedule_timezone', 'next_run_at', 'xero_tenant_id', 'base_currency']) {
    assert.deepEqual(fieldsOf({ ...monthlyDay(), [key]: 1 }), { [key]: 'Unknown field' });
  }
});

test('requires all ten keys', () => {
  for (const key of WRITABLE_KEYS) {
    const body = monthlyDay();
    delete body[key];
    assert.deepEqual(fieldsOf(body), { [key]: 'Required' });
  }
});

test('rejects a body that is not a JSON object', () => {
  for (const body of [null, undefined, [], 'x', 5]) {
    assert.ok('_body' in fieldsOf(body));
  }
});

test('rejects week combined with day, enabled or not', () => {
  assert.ok('schedule_day' in fieldsOf({ ...weekly(), schedule_day: 'day' }));
  assert.ok('schedule_day' in fieldsOf({ ...weekly(), schedule_day: 'day', auto_statements_enabled: false }));
});

test('rejects an ordinal on a weekly schedule', () => {
  assert.ok('schedule_ordinal' in fieldsOf({ ...weekly(), schedule_ordinal: 'the 1st' }));
});

test('rejects a weekday with the 5th to 28th', () => {
  for (const n of [5, 6, 15, 28]) {
    const body = { ...monthlyDay(), schedule_day: 'Friday', schedule_ordinal: ordinalLabel(n) };
    assert.ok('schedule_ordinal' in fieldsOf(body), `the ${n}th`);
    assert.ok('schedule_ordinal' in fieldsOf({ ...body, auto_statements_enabled: false }), `paused ${n}`);
  }
});

test('an enabled schedule must be complete', () => {
  assert.ok('schedule_day' in fieldsOf({ ...weekly(), schedule_day: null }));
  assert.ok('schedule_day' in fieldsOf({ ...monthlyDay(), schedule_day: null }));
  assert.ok('schedule_ordinal' in fieldsOf({ ...monthlyDay(), schedule_ordinal: null }));
});

test('a paused schedule may be incomplete', () => {
  assert.equal(validateScheduleConfig(paused({ schedule_day: null, schedule_ordinal: null })).ok, true);
  assert.equal(validateScheduleConfig(paused({ schedule_unit: 'week', schedule_day: null, schedule_ordinal: null })).ok, true);
});

test('rejects wrong types and out-of-range values', () => {
  const bad = {
    auto_statements_enabled: ['true', 1, null],
    schedule_unit: ['year', 'Month', null],
    schedule_interval: [0, 53, 1.5, '1', null, -1],
    schedule_day: ['monday', 'Someday', 3],
    schedule_ordinal: ['the 29th', '16', 16, 'the 0th', 'last'],
    schedule_time: ['06:30', '6:00', '24:00', 6, null],
    statement_period_end_rule: ['first_day', null],
    recipient_list: ['some', null],
    recipient_filter: ['everyone', null],
    recipient_target: ['all', null],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const value of values) {
      assert.ok(key in fieldsOf({ ...monthlyDay(), [key]: value }), `${key}=${JSON.stringify(value)}`);
    }
  }
});

test('accepts the interval limits', () => {
  assert.equal(validateScheduleConfig({ ...monthlyDay(), schedule_interval: 1 }).ok, true);
  assert.equal(validateScheduleConfig({ ...monthlyDay(), schedule_interval: 52 }).ok, true);
});

// The guarantee that matters: whatever is accepted for an enabled schedule can be scheduled
// by the heartbeat, so a saved row can never make computeFirstRun throw.
test('every accepted enabled schedule is computable by the heartbeat', () => {
  const now = new Date('2026-09-20T05:00:00Z');
  let accepted = 0;
  const check = (overrides) => {
    const result = validateScheduleConfig({ ...monthlyDay(), ...overrides });
    assert.equal(result.ok, true, JSON.stringify(overrides));
    assert.doesNotThrow(() => computeFirstRun(result.value, now), JSON.stringify(overrides));
    accepted += 1;
  };

  for (const time of TIMES) {
    for (const day of WEEKDAYS) check({ schedule_unit: 'week', schedule_day: day, schedule_ordinal: null, schedule_time: time });
  }
  for (const ordinal of ORDINALS) check({ schedule_day: 'day', schedule_ordinal: ordinal });
  for (const day of WEEKDAYS) {
    for (const ordinal of WEEKDAY_ORDINALS) check({ schedule_day: day, schedule_ordinal: ordinal });
  }
  assert.equal(accepted, 24 * 7 + 29 + 7 * 5);
});

test('the calculator really does throw for the week-with-day case Appsmith allowed', () => {
  const body = { ...weekly(), schedule_day: 'day' };
  assert.equal(validateScheduleConfig(body).ok, false);
  assert.throws(() => computeFirstRun(body, new Date()), /invalid schedule_day/);
});

test('toApiConfig returns only schedule columns, turns empty strings into null, and formats next_run_at', () => {
  const row = {
    id: 7,
    client_name: 'Leninorg',
    xero_tenant_id: 'secret-tenant',
    report_email: 'a@b.c',
    auto_statements_enabled: true,
    schedule_interval: 1,
    schedule_unit: 'week',
    schedule_ordinal: '',
    schedule_day: 'Sunday',
    schedule_time: '06:00',
    schedule_timezone: 'Australia/Melbourne',
    statement_period_end_rule: 'last_day_previous_month',
    recipient_list: '',
    recipient_filter: 'outstanding',
    recipient_target: null,
    next_run_at: new Date('2026-09-26T20:00:00Z'),
  };
  const config = toApiConfig(row);

  assert.deepEqual(Object.keys(config), [...READ_KEYS, 'next_run_at']);
  assert.equal(config.schedule_ordinal, null);
  assert.equal(config.recipient_list, null);
  assert.equal(config.recipient_target, null);
  assert.equal(config.schedule_day, 'Sunday');
  assert.equal(config.next_run_at, '2026-09-26T20:00:00.000Z');
  assert.equal(toApiConfig({ ...row, next_run_at: null }).next_run_at, null);
});

test('toApiConfig passes legacy stored values through unchanged', () => {
  const config = toApiConfig({ ...paused(), schedule_day: 'Friday', schedule_ordinal: 'the 9th', next_run_at: null });
  assert.equal(config.schedule_ordinal, 'the 9th');
});

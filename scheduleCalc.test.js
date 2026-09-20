// scheduleCalc.test.js
// Standalone test runner. No framework, no DB, no network.
// Run with:  node scheduleCalc.test.js
// Exits 0 if every case passes, 1 if any case fails.

const { DateTime } = require('luxon');
const { computeFirstRun, computeNextRun } = require('./scheduleCalc');

const ZONE = 'Australia/Melbourne';
let passed = 0;
let failed = 0;

function fmt(jsDate) {
  return DateTime.fromJSDate(jsDate, { zone: ZONE }).toFormat('ccc dd LLL yyyy HH:mm ZZ');
}

function cfg(overrides) {
  return Object.assign({
    schedule_unit: 'month',
    schedule_interval: 1,
    schedule_time: '06:00',
    schedule_timezone: ZONE,
    schedule_day: null,
    schedule_ordinal: null
  }, overrides);
}

function check(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`PASS  ${label}  ->  ${actual}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}\n        expected: ${expected}\n        actual:   ${actual}`);
  }
}

// Asserts computeFirstRun lands on the expected local date/time.
function firstRun(label, config, fromIso, expectedLocal) {
  let actual;
  try {
    actual = fmt(computeFirstRun(config, DateTime.fromISO(fromIso, { zone: ZONE }).toJSDate()));
  } catch (e) {
    actual = `THREW: ${e.message}`;
  }
  check(label, actual, expectedLocal);
}

// Asserts normalizeConfig/computeFirstRun rejects the config.
function throws(label, config, fromIso) {
  let actual;
  try {
    computeFirstRun(config, DateTime.fromISO(fromIso, { zone: ZONE }).toJSDate());
    actual = 'did not throw';
  } catch (e) {
    actual = 'threw';
  }
  check(label, actual, 'threw');
}

// Runs computeNextRun three times in a row and asserts each result is
// strictly later than the one before it.
function strictlyIncreasing(label, config, fromIso) {
  let actual = 'increasing';
  try {
    let prev = DateTime.fromISO(fromIso, { zone: ZONE }).toJSDate();
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const next = computeNextRun(config, prev);
      if (!(next > prev)) {
        actual = `not increasing at step ${i + 1}: ${fmt(next)} <= ${fmt(prev)}`;
        break;
      }
      seen.push(fmt(next));
      prev = next;
    }
    if (actual === 'increasing') console.log(`        seq: ${seen.join('  |  ')}`);
  } catch (e) {
    actual = `THREW: ${e.message}`;
  }
  check(label, actual, 'increasing');
}

console.log('--- Monthly, calendar day (schedule_day = "day") ---');

firstRun(
  'day + the 1st',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the 1st' }),
  '2027-01-10T09:00',
  'Mon 01 Feb 2027 06:00 +11:00'
);

firstRun(
  'day + the 15th',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the 15th' }),
  '2027-01-10T09:00',
  'Fri 15 Jan 2027 06:00 +11:00'
);

firstRun(
  'day + the 28th',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the 28th' }),
  '2027-01-10T09:00',
  'Thu 28 Jan 2027 06:00 +11:00'
);

console.log('--- Monthly, "the last" calendar day across month lengths ---');

firstRun(
  'day + the last  (Jan 2027, 31 days)',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the last' }),
  '2027-01-10T09:00',
  'Sun 31 Jan 2027 06:00 +11:00'
);

firstRun(
  'day + the last  (Feb 2027, 28 days)',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the last' }),
  '2027-02-10T09:00',
  'Sun 28 Feb 2027 06:00 +11:00'
);

firstRun(
  'day + the last  (Feb 2028, leap year, 29 days)',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the last' }),
  '2028-02-10T09:00',
  'Tue 29 Feb 2028 06:00 +11:00'
);

firstRun(
  'day + the last  (Apr 2027, 30 days)',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the last' }),
  '2027-04-10T09:00',
  'Fri 30 Apr 2027 06:00 +10:00'
);

console.log('--- Monthly, nth weekday (in range) ---');

firstRun(
  'Monday + the 1st',
  cfg({ schedule_day: 'Monday', schedule_ordinal: 'the 1st' }),
  '2027-01-10T09:00',
  'Mon 01 Feb 2027 06:00 +11:00'
);

firstRun(
  'Friday + the 4th',
  cfg({ schedule_day: 'Friday', schedule_ordinal: 'the 4th' }),
  '2027-01-10T09:00',
  'Fri 22 Jan 2027 06:00 +11:00'
);

firstRun(
  'Tuesday + the last',
  cfg({ schedule_day: 'Tuesday', schedule_ordinal: 'the last' }),
  '2027-01-10T09:00',
  'Tue 26 Jan 2027 06:00 +11:00'
);

console.log('--- Monthly, nth weekday out of range -> falls back to "the last" ---');

firstRun(
  'Wednesday + the 10th  (expect last Wednesday)',
  cfg({ schedule_day: 'Wednesday', schedule_ordinal: 'the 10th' }),
  '2027-01-10T09:00',
  'Wed 27 Jan 2027 06:00 +11:00'
);

firstRun(
  'Wednesday + the 28th  (expect last Wednesday)',
  cfg({ schedule_day: 'Wednesday', schedule_ordinal: 'the 28th' }),
  '2027-01-10T09:00',
  'Wed 27 Jan 2027 06:00 +11:00'
);

console.log('--- Weekly (ordinal ignored) ---');

firstRun(
  'week + Thursday, no ordinal',
  cfg({ schedule_unit: 'week', schedule_day: 'Thursday' }),
  '2027-01-10T09:00',
  'Thu 14 Jan 2027 06:00 +11:00'
);

console.log('--- Invalid configs must throw ---');

throws(
  'month + day, no ordinal',
  cfg({ schedule_day: 'day', schedule_ordinal: null }),
  '2027-01-10T09:00'
);

throws(
  'week + day  ("day" is not a weekday)',
  cfg({ schedule_unit: 'week', schedule_day: 'day', schedule_ordinal: 'the 1st' }),
  '2027-01-10T09:00'
);

throws(
  'month + no schedule_day',
  cfg({ schedule_day: null, schedule_ordinal: 'the 1st' }),
  '2027-01-10T09:00'
);

console.log('--- computeNextRun must advance strictly, three runs deep ---');

strictlyIncreasing(
  'seq: day + the 31st-equivalent (the last)',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the last' }),
  '2027-01-10T09:00'
);

strictlyIncreasing(
  'seq: day + the 15th',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the 15th' }),
  '2027-01-10T09:00'
);

strictlyIncreasing(
  'seq: day + the 28th',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the 28th' }),
  '2027-01-10T09:00'
);

strictlyIncreasing(
  'seq: Monday + the 1st',
  cfg({ schedule_day: 'Monday', schedule_ordinal: 'the 1st' }),
  '2027-01-10T09:00'
);

strictlyIncreasing(
  'seq: Wednesday + the 10th (fallback)',
  cfg({ schedule_day: 'Wednesday', schedule_ordinal: 'the 10th' }),
  '2027-01-10T09:00'
);

strictlyIncreasing(
  'seq: Tuesday + the last',
  cfg({ schedule_day: 'Tuesday', schedule_ordinal: 'the last' }),
  '2027-01-10T09:00'
);

strictlyIncreasing(
  'seq: week + Thursday',
  cfg({ schedule_unit: 'week', schedule_day: 'Thursday' }),
  '2027-01-10T09:00'
);

strictlyIncreasing(
  'seq: fortnightly, week + Thursday, interval 2',
  cfg({ schedule_unit: 'week', schedule_day: 'Thursday', schedule_interval: 2 }),
  '2027-01-10T09:00'
);

strictlyIncreasing(
  'seq: quarterly, day + the last, interval 3',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the last', schedule_interval: 3 }),
  '2027-01-10T09:00'
);

console.log('--- DST boundaries (Australia/Melbourne) ---');

// Spring forward 2026-10-04 02:00 -> 03:00. A 06:00 slot is unaffected but
// the offset changes from +10:00 to +11:00.
firstRun(
  'day + the 5th, across spring forward',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the 5th' }),
  '2026-10-01T09:00',
  'Mon 05 Oct 2026 06:00 +11:00'
);

// Fall back 2027-04-04 03:00 -> 02:00. Offset returns to +10:00.
firstRun(
  'day + the 5th, across fall back',
  cfg({ schedule_day: 'day', schedule_ordinal: 'the 5th' }),
  '2027-04-01T09:00',
  'Mon 05 Apr 2027 06:00 +10:00'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

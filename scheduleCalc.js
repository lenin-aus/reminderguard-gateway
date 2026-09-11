// scheduleCalc.js
// Pure next-run calculator. No DB, no Redis, no side effects.
// All arithmetic happens in the client's IANA zone, then converts to UTC.

const { DateTime } = require('luxon');

const DEFAULT_ZONE = 'Australia/Melbourne';

const WEEKDAY_INDEX = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6, sunday: 7
};

// Accepts both storage formats seen in this project:
// 'the 1st'..'the 28th' / 'the last', and bare 1..28 / 'last'.
function parseOrdinal(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase().replace(/^the\s+/, '');
  if (s === 'last') return 'last';
  const n = parseInt(s, 10);
  if (Number.isInteger(n) && n >= 1 && n <= 28) return n;
  return null;
}

// ScheduleDay offers the literal 'day' (calendar day-of-month) alongside the
// seven weekday names.
function isDayToken(raw) {
  return String(raw || '').trim().toLowerCase() === 'day';
}

function parseWeekday(raw) {
  if (!raw) return null;
  return WEEKDAY_INDEX[String(raw).trim().toLowerCase()] || null;
}

// '06:00' -> { hour: 6, minute: 0 }
function parseTime(raw) {
  const m = String(raw || '06:00').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function normalizeConfig(config) {
  const unit = String(config.schedule_unit || '').trim().toLowerCase();
  if (unit !== 'week' && unit !== 'month') {
    throw new Error(`scheduleCalc: invalid schedule_unit "${config.schedule_unit}"`);
  }

  const time = parseTime(config.schedule_time);
  if (!time) {
    throw new Error(`scheduleCalc: invalid schedule_time "${config.schedule_time}"`);
  }

  let interval = parseInt(config.schedule_interval, 10);
  if (!Number.isInteger(interval) || interval < 1) interval = 1;

  const rawZone = config.schedule_timezone || DEFAULT_ZONE;
  const zone = DateTime.local().setZone(rawZone).isValid ? rawZone : DEFAULT_ZONE;

  const base = { unit, interval, zone, hour: time.hour, minute: time.minute };

  // Weekly always lands on a named weekday. 'day' is meaningless without a
  // month to count within, and the ordinal is ignored entirely.
  if (unit === 'week') {
    const weekday = parseWeekday(config.schedule_day);
    if (!weekday) {
      throw new Error(`scheduleCalc: invalid schedule_day "${config.schedule_day}" for weekly schedule`);
    }
    return { ...base, mode: 'nthWeekday', weekday, ordinal: null };
  }

  const ordinal = parseOrdinal(config.schedule_ordinal);
  if (ordinal === null) {
    throw new Error(`scheduleCalc: invalid schedule_ordinal "${config.schedule_ordinal}" for monthly schedule`);
  }

  // Monthly, calendar day: 'the 1st'..'the 28th' is a day number, 'the last'
  // is the final day of the month.
  if (isDayToken(config.schedule_day)) {
    return { ...base, mode: 'dayOfMonth', weekday: null, ordinal };
  }

  // Monthly, nth weekday. A weekday occurs at most 4-5 times in a month, so
  // anything past the 4th falls back to the last occurrence. This mirrors the
  // Appsmith Settings page, which restricts the dropdown the same way — the
  // fallback here is the safety net for rows saved before that restriction.
  const weekday = parseWeekday(config.schedule_day);
  if (!weekday) {
    throw new Error(`scheduleCalc: invalid schedule_day "${config.schedule_day}"`);
  }
  const safeOrdinal = (typeof ordinal === 'number' && ordinal > 4) ? 'last' : ordinal;
  return { ...base, mode: 'nthWeekday', weekday, ordinal: safeOrdinal };
}

// Nth (or last) occurrence of a weekday within the month that `dt` falls in.
// A 5th occurrence that doesn't exist clamps down to the last one that does.
function ordinalWeekdayOfMonth(dt, ordinal, weekday, hour, minute) {
  const firstOfMonth = dt.set({ day: 1 }).startOf('day');
  const daysInMonth = firstOfMonth.daysInMonth;
  const offset = (weekday - firstOfMonth.weekday + 7) % 7;

  let day;
  if (ordinal === 'last') {
    day = 1 + offset;
    while (day + 7 <= daysInMonth) day += 7;
  } else {
    day = 1 + offset + (ordinal - 1) * 7;
    while (day > daysInMonth) day -= 7;
  }

  return firstOfMonth.set({ day, hour, minute, second: 0, millisecond: 0 });
}

// Calendar day of the month that `dt` falls in. 'last' resolves to the final
// day, so 28/29/30/31 depending on the month. Numbers are capped at 28 by
// parseOrdinal, so the Math.min is belt-and-braces only.
function dayOfMonthSlot(dt, ordinal, hour, minute) {
  const firstOfMonth = dt.set({ day: 1 }).startOf('day');
  const daysInMonth = firstOfMonth.daysInMonth;
  const day = ordinal === 'last' ? daysInMonth : Math.min(ordinal, daysInMonth);
  return firstOfMonth.set({ day, hour, minute, second: 0, millisecond: 0 });
}

// Single entry point for "the slot inside this month", whichever mode applies.
function monthSlot(c, dt) {
  return c.mode === 'dayOfMonth'
    ? dayOfMonthSlot(dt, c.ordinal, c.hour, c.minute)
    : ordinalWeekdayOfMonth(dt, c.ordinal, c.weekday, c.hour, c.minute);
}

function toDateTime(value, zone) {
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  if (typeof value === 'string') return DateTime.fromISO(value, { zone });
  if (value && typeof value.toJSDate === 'function') return value.setZone(zone);
  throw new Error('scheduleCalc: fromDate must be a Date, ISO string, or DateTime');
}

// Advance one full interval past `from`, then land on the configured slot.
function advance(c, from, intervalOverride) {
  const interval = intervalOverride === undefined ? c.interval : intervalOverride;

  if (c.unit === 'week') {
    let base = from.plus({ weeks: interval });
    let candidate = base.set({
      weekday: c.weekday, hour: c.hour, minute: c.minute, second: 0, millisecond: 0
    });
    if (candidate <= from) candidate = candidate.plus({ weeks: 1 });
    return candidate;
  }

  let base = from.plus({ months: interval });
  let candidate = monthSlot(c, base);
  if (candidate <= from) {
    candidate = monthSlot(c, base.plus({ months: 1 }));
  }
  return candidate;
}

/**
 * First run for a schedule that has never run (next_run_at IS NULL).
 * Interval is deliberately ignored — a fortnightly schedule saved today
 * should start at the next matching day, not two weeks out.
 */
function computeFirstRun(config, fromDate) {
  const c = normalizeConfig(config);
  const from = toDateTime(fromDate, c.zone);

  if (c.unit === 'week') {
    let candidate = from.set({
      weekday: c.weekday, hour: c.hour, minute: c.minute, second: 0, millisecond: 0
    });
    if (candidate <= from) candidate = candidate.plus({ weeks: 1 });
    return candidate.toUTC().toJSDate();
  }

  let candidate = monthSlot(c, from);
  if (candidate <= from) {
    candidate = monthSlot(c, from.plus({ months: 1 }));
  }
  return candidate.toUTC().toJSDate();
}

/**
 * Next run after a run that just fired. `fromDate` must be that run's
 * scheduled_for, never now() — anchoring to now() would drift the cadence
 * forward by however late the heartbeat picked the run up.
 * Guaranteed to return a time strictly after fromDate.
 */
function computeNextRun(config, fromDate) {
  const c = normalizeConfig(config);
  const from = toDateTime(fromDate, c.zone);

  let candidate = advance(c, from);

  // Safety net: never hand back a non-advancing timestamp, which would
  // make the heartbeat re-fire the same slot forever.
  let guard = 0;
  while (candidate <= from && guard < 24) {
    candidate = advance(c, candidate, c.interval);
    guard++;
  }
  if (candidate <= from) {
    throw new Error('scheduleCalc: failed to advance next run past fromDate');
  }

  return candidate.toUTC().toJSDate();
}

module.exports = { computeFirstRun, computeNextRun, normalizeConfig, ordinalWeekdayOfMonth, dayOfMonthSlot, monthSlot };

'use strict';

// The "Last sent" text the customer list shows for one contact, from its latest statement_logs row.
//   Sending...            queued or sending (a job stuck for more than 15 minutes counts as failed)
//   Today                 delivered today            N day(s) ago       delivered earlier
//   Failed today          failed today               Failed yesterday   failed the day before
//   Failed N days ago     failed longer ago          Failed             a job stuck sending
//   Never                 no send yet, or the contact has no email address
// Days are calendar days in the client's timezone, so "yesterday" means the previous local date
// whatever the hour, and a failure never keeps saying "today" once the day has passed.

const STALE_PROCESSING_MS = 15 * 60 * 1000;

function localDate(instant, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

// Whole calendar days from one 'YYYY-MM-DD' to another.
function calendarDaysBetween(fromIso, toIso) {
  const ms = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return Math.round((ms(toIso) - ms(fromIso)) / 86400000);
}

function lastSentLabel(row, { nowMs = Date.now(), timeZone = 'Australia/Melbourne' } = {}) {
  const created = new Date(row.created_at);

  if (row.status === 'PROCESSING') {
    return nowMs - created.getTime() <= STALE_PROCESSING_MS ? 'Sending...' : 'Failed';
  }

  if (row.status === 'FAILED' && row.error_reason === 'MISSING_EMAIL') return 'Never';

  if (row.status === 'FAILED' || row.status === 'DELIVERED') {
    const days = Math.max(0, calendarDaysBetween(localDate(created, timeZone), localDate(new Date(nowMs), timeZone)));
    if (row.status === 'DELIVERED') {
      if (days === 0) return 'Today';
      return `${days} day${days === 1 ? '' : 's'} ago`;
    }
    if (days === 0) return 'Failed today';
    if (days === 1) return 'Failed yesterday';
    return `Failed ${days} days ago`;
  }

  return 'Never';
}

module.exports = { lastSentLabel, calendarDaysBetween };

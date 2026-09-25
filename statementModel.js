'use strict';

// Turns a contact's invoices and credits into the four statement sections, as plain data.
// Pure: no I/O, no clock. Inputs are the normalised shapes from xeroData.js (integer cents,
// local 'YYYY-MM-DD' dates), so a cache-backed data layer can feed it unchanged.
//
//   1. Unallocated credits   credits with a balance left (omitted when there are none)
//   2. Outstanding items     as at today, NOT date filtered
//   3. Age analysis          as at today, NOT date filtered, aged on the date raised
//   4. Activity              ledger for [range.start, range.end] (only when a range is given)
//
// SIGN CONVENTION (fixed here so it is never guessed later). In the ledger an INVOICE is
// POSITIVE (the customer owes more); a PAYMENT or a CREDIT (credit note, overpayment,
// prepayment) is NEGATIVE. The Activity "Debit" column is a positive amount, the "Credit"
// column is the magnitude of a negative one. Balances are running sums, everything per
// currency: a bucket is one contact in one currency, never a mix.
//
// Sections 2/3 and section 4 can legitimately disagree (for example when the range ends
// before recent activity); they are labelled "as at <today>" and "from ... to ..." and are
// deliberately not forced to match.
//
// The opening balance is computed forward from the contact's complete history (everything
// dated before the range start). That gives an independent check: the same history summed
// over ALL dates should equal the balance Xero reports now (open invoices minus remaining
// credits). A non-zero difference is a movement this data cannot see, such as a refund or
// a manual journal on the receivables account, and is returned in `checks` instead of being
// hidden.

const AGE_BUCKETS = ['d90plus', 'd60', 'd30', 'current'];

// Exact days since the date raised: Current 0-30, "30 days" 31-60, "60 days" 61-90, "90 days+" 91 or more.
function ageBucket(days) {
  if (days <= 30) return 'current';
  if (days <= 60) return 'd30';
  if (days <= 90) return 'd60';
  return 'd90plus';
}

function daysBetween(fromIso, toIso) {
  const ms = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return Math.round((ms(toIso) - ms(fromIso)) / 86400000);
}

function emptyBuckets() {
  return { d90plus: 0, d60: 0, d30: 0, current: 0 };
}

const KIND_ORDER = { invoice: 0, creditNote: 1, overpayment: 1, prepayment: 1, payment: 2 };

function creditLabel(credit) {
  const generic = { creditNote: 'Credit note', overpayment: 'Overpayment', prepayment: 'Prepayment' }[credit.kind];
  return credit.number && credit.number !== generic ? `${generic} ${credit.number}` : generic;
}

function byDateThenNumber(a, b) {
  return (a.date || '').localeCompare(b.date || '') || (a.number || '').localeCompare(b.number || '');
}

function buildStatementModel({ currency, today, range = null, invoices, credits }) {
  const wanted = String(currency).toUpperCase();
  const inCurrency = (x) => String(x.currency || '').toUpperCase() === wanted;
  const invs = invoices.filter(inCurrency);
  const creds = credits.filter(inCurrency);

  // ── 2. Outstanding items ─────────────────────────────────────────────
  const openInvoices = invs.filter((i) => i.status === 'AUTHORISED' && i.amountDue > 0);
  const openCredits = creds.filter((c) => c.status === 'AUTHORISED' && c.remaining > 0);
  // Xero always dates a document; one without a date means the data is broken, and an ageing
  // guess would put a wrong figure on a customer's statement. Fail with a clear reason instead.
  for (const doc of [...openInvoices, ...openCredits]) {
    if (!doc.date) throw new Error(`Cannot build a statement: ${doc.number || doc.id} has no date`);
  }

  const rows = [
    ...openInvoices.map((i) => ({
      date: i.date,
      number: i.number,
      activity: i.number,
      dueDate: i.dueDate,
      amount: i.total,
      deductions: i.amountDue - i.total, // payments and credits applied, shown negative
      balance: i.amountDue,
      kind: 'invoice',
    })),
    ...openCredits.map((c) => ({
      date: c.date,
      number: c.number,
      activity: creditLabel(c),
      dueDate: null,
      amount: -c.total,
      deductions: c.total - c.remaining, // the part already used, shown positive
      balance: -c.remaining,
      kind: c.kind,
    })),
  ].sort(byDateThenNumber);
  const totalOutstanding = rows.reduce((sum, r) => sum + r.balance, 0);

  // ── 3. Age analysis ──────────────────────────────────────────────────
  const ageing = { invoices: emptyBuckets(), credits: emptyBuckets() };
  for (const i of openInvoices) ageing.invoices[ageBucket(daysBetween(i.date, today))] += i.amountDue;
  for (const c of openCredits) ageing.credits[ageBucket(daysBetween(c.date, today))] += c.remaining;

  // ── 1. Unallocated credits ───────────────────────────────────────────
  const unallocatedCredits = openCredits
    .map((c) => ({ kind: c.kind, number: c.number, label: creditLabel(c), date: c.date, remaining: c.remaining }))
    .sort(byDateThenNumber);

  // ── 4. Activity (ranged sends only) ──────────────────────────────────
  let activity = null;
  let checks = null;
  if (range) {
    const txns = [];
    for (const i of invs) {
      txns.push({ date: i.date, kind: 'invoice', number: i.number, label: `Invoice ${i.number}`, amount: i.total });
      for (const p of i.payments) {
        txns.push({ date: p.date, kind: 'payment', number: i.number, label: 'Payment received', note: `Applied to invoice ${i.number}`, amount: -p.amount });
      }
    }
    for (const c of creds) {
      txns.push({ date: c.date, kind: c.kind, number: c.number, label: creditLabel(c), amount: -c.total });
    }
    const dated = txns.filter((t) => t.date);

    const opening = dated.filter((t) => t.date < range.start).reduce((sum, t) => sum + t.amount, 0);
    const inRange = dated
      .filter((t) => t.date >= range.start && t.date <= range.end)
      .sort((a, b) => a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.number.localeCompare(b.number));

    let running = opening;
    const activityRows = inRange.map((t) => {
      running += t.amount;
      return {
        date: t.date,
        label: t.label,
        note: t.note || null,
        debit: t.amount > 0 ? t.amount : 0,
        credit: t.amount < 0 ? -t.amount : 0,
        balance: running,
      };
    });
    activity = { start: range.start, end: range.end, opening, rows: activityRows, closing: running };

    // The same history over every date, against the balance Xero reports now.
    const ledgerBalance = dated.reduce((sum, t) => sum + t.amount, 0);
    checks = {
      ledgerBalance,
      currentBalance: totalOutstanding,
      difference: totalOutstanding - ledgerBalance,
      undatedTransactions: txns.length - dated.length,
    };
  }

  return {
    currency: wanted,
    today,
    range,
    unallocatedCredits,
    outstanding: { rows, total: totalOutstanding },
    ageing,
    activity,
    checks,
  };
}

module.exports = { buildStatementModel, ageBucket, daysBetween, AGE_BUCKETS };

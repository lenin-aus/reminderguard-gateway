'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStatementModel, ageBucket, daysBetween } = require('./statementModel');
const { normalizeInvoice, normalizeCredit } = require('./xeroData');
const { rawInvoices, rawCreditNotes } = require('./statementFixtures');

const TODAY = '2026-09-25';
const RANGE_90 = { start: '2026-06-26', end: TODAY };

// The City Limousines data, through the real normalisers so the data layer and the builder are
// tested against the same contract.
const invoices = rawInvoices.map(normalizeInvoice);
const credits = rawCreditNotes.filter((c) => c.Type === 'ACCRECCREDIT').map((c) => normalizeCredit('creditNote', c));

// Builders for edge cases, in the normalised shapes.
const inv = (over) => ({ id: over.number, type: 'ACCREC', status: 'AUTHORISED', currency: 'AUD', dueDate: null, total: 0, amountPaid: 0, amountCredited: 0, amountDue: 0, payments: [], ...over });
const cr = (over) => ({ kind: 'creditNote', id: over.number, status: 'AUTHORISED', currency: 'AUD', total: 0, remaining: 0, allocations: [], ...over });

test('age buckets use exact days: 0-30 current, 31-60, 61-90, 91+', () => {
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91, 400].map(ageBucket), ['current', 'current', 'd30', 'd30', 'd60', 'd60', 'd90plus', 'd90plus']);
  assert.equal(ageBucket(-5), 'current', 'a future-dated document is current');
  assert.equal(daysBetween('2026-07-03', '2026-09-25'), 84);
  assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
});

test('the City Limousines statement: every section matches the reference figures', () => {
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: RANGE_90, invoices, credits });

  assert.deepEqual(m.unallocatedCredits, [{ kind: 'creditNote', number: 'ORC1037', label: 'Credit note ORC1037', date: '2026-08-23', remaining: 6050 }]);

  assert.deepEqual(
    m.outstanding.rows.map((r) => [r.date, r.activity, r.dueDate, r.amount, r.deductions, r.balance]),
    [
      ['2026-07-03', 'ORC1002', '2026-07-13', 110000, -85000, 25000],
      ['2026-07-23', 'ORC1012', '2026-08-08', 66000, 0, 66000],
      ['2026-08-23', 'Credit note ORC1037', null, -6050, 0, -6050],
    ]
  );
  assert.equal(m.outstanding.total, 84950);

  // ORC1002 is 84 days old and ORC1012 is 64: both in "60 days"; the credit is 33 days: "30 days".
  assert.deepEqual(m.ageing.invoices, { d90plus: 0, d60: 91000, d30: 0, current: 0 });
  assert.deepEqual(m.ageing.credits, { d90plus: 0, d60: 0, d30: 6050, current: 0 });

  assert.equal(m.activity.opening, 0);
  assert.deepEqual(
    m.activity.rows.map((r) => [r.date, r.label, r.note, r.debit, r.credit, r.balance]),
    [
      ['2026-07-03', 'Invoice ORC1002', null, 110000, 0, 110000],
      ['2026-07-13', 'Payment received', 'Applied to invoice ORC1002', 0, 85000, 25000],
      ['2026-07-23', 'Invoice ORC1012', null, 66000, 0, 91000],
      ['2026-08-23', 'Credit note ORC1037', null, 0, 6050, 84950],
    ]
  );
  assert.equal(m.activity.closing, 84950);
  assert.deepEqual(m.checks, { ledgerBalance: 84950, currentBalance: 84950, difference: 0, undatedTransactions: 0 });
});

test('the supplier credit in the raw data never reaches the statement', () => {
  assert.equal(credits.length, 1);
});

test('a range that starts later carries earlier activity into the opening balance', () => {
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: { start: '2026-07-20', end: TODAY }, invoices, credits });
  assert.equal(m.activity.opening, 25000, '1,100 invoiced and 850 paid before 20 Jul');
  assert.deepEqual(m.activity.rows.map((r) => r.balance), [91000, 84950]);
  assert.equal(m.activity.closing, 84950);
});

test('a range ending before recent activity legitimately disagrees with Total Outstanding', () => {
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: { start: '2026-07-01', end: '2026-08-01' }, invoices, credits });
  assert.equal(m.activity.closing, 91000);
  assert.equal(m.outstanding.total, 84950, 'sections 2 and 3 are as at today and never date filtered');
});

test('a range with nothing in it still shows opening and closing balances', () => {
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: { start: '2026-09-01', end: TODAY }, invoices, credits });
  assert.deepEqual(m.activity.rows, []);
  assert.equal(m.activity.opening, 84950);
  assert.equal(m.activity.closing, 84950);
});

test('without a range there is no Activity and no ledger check (a scheduled send)', () => {
  const openOnly = invoices.filter((i) => i.status === 'AUTHORISED' && i.amountDue > 0);
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: null, invoices: openOnly, credits });
  assert.equal(m.activity, null);
  assert.equal(m.checks, null);
  assert.equal(m.outstanding.total, 84950, 'credits are netted in scheduled statements too');
  assert.equal(m.unallocatedCredits.length, 1);
});

test('with no credits the Unallocated Credits section is empty', () => {
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: null, invoices, credits: [] });
  assert.deepEqual(m.unallocatedCredits, []);
  assert.equal(m.outstanding.total, 91000);
});

test('a paid invoice appears in Activity but not in Outstanding Items', () => {
  const paid = inv({ number: 'P1', date: '2026-08-10', total: 50000, amountPaid: 50000, status: 'PAID', payments: [{ id: 'p', date: '2026-08-20', amount: 50000, reference: '' }] });
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: RANGE_90, invoices: [paid], credits: [] });
  assert.equal(m.outstanding.rows.length, 0);
  assert.equal(m.outstanding.total, 0);
  assert.deepEqual(m.activity.rows.map((r) => [r.label, r.debit, r.credit, r.balance]), [['Invoice P1', 50000, 0, 50000], ['Payment received', 0, 50000, 0]]);
  assert.equal(m.checks.difference, 0);
});

test('currencies are never mixed: each bucket has its own rows, balances and totals', () => {
  const usd = inv({ number: 'U1', currency: 'USD', date: '2026-08-01', total: 10000, amountDue: 10000 });
  const usdCredit = cr({ number: 'UC1', currency: 'USD', date: '2026-08-05', total: 2500, remaining: 2500 });
  const all = { today: TODAY, range: RANGE_90, invoices: [...invoices, usd], credits: [...credits, usdCredit] };
  const aud = buildStatementModel({ currency: 'AUD', ...all });
  const usdModel = buildStatementModel({ currency: 'USD', ...all });

  assert.equal(aud.outstanding.total, 84950);
  assert.equal(usdModel.outstanding.total, 7500);
  assert.deepEqual(usdModel.activity.rows.map((r) => r.balance), [10000, 7500]);
  assert.equal(usdModel.activity.opening, 0);
  assert.equal(aud.checks.difference, 0);
  assert.equal(usdModel.checks.difference, 0);
});

test('overpayments and prepayments count as credits in every section', () => {
  const over = cr({ kind: 'overpayment', number: 'Overpayment', date: '2026-09-01', total: 3000, remaining: 3000 });
  const pre = cr({ kind: 'prepayment', number: 'Deposit', date: '2026-05-01', total: 10000, remaining: 10000 });
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: RANGE_90, invoices, credits: [...credits, over, pre] });

  assert.deepEqual(m.unallocatedCredits.map((c) => [c.label, c.remaining]), [['Prepayment Deposit', 10000], ['Credit note ORC1037', 6050], ['Overpayment', 3000]]);
  assert.equal(m.outstanding.total, 84950 - 3000 - 10000);
  assert.equal(m.ageing.credits.d90plus, 10000, 'the May prepayment is 147 days old');
  assert.equal(m.ageing.credits.current, 3000);
  assert.equal(m.activity.opening, -10000, 'the prepayment predates the range');
  assert.equal(m.checks.difference, 0);
});

test('a part-used credit note: the row shows what was used, the ledger uses the full credit', () => {
  const a = inv({ number: 'A', date: '2026-07-01', total: 20000, amountCredited: 6000, amountDue: 14000 });
  const c = cr({ number: 'CN9', date: '2026-08-01', total: 10000, remaining: 4000, allocations: [{ date: '2026-08-01', amount: 6000, invoiceId: 'A', invoiceNumber: '' }] });
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: RANGE_90, invoices: [a], credits: [c] });

  assert.deepEqual(m.outstanding.rows.map((r) => [r.activity, r.amount, r.deductions, r.balance]), [['A', 20000, -6000, 14000], ['Credit note CN9', -10000, 6000, -4000]]);
  assert.equal(m.outstanding.total, 10000);
  assert.equal(m.activity.closing, 10000);
  assert.equal(m.checks.difference, 0);
});

test('a movement the data cannot see (a refund) shows up as a non-zero check, not a silent shift', () => {
  // A 100.00 credit note of which 80.00 was refunded in cash: 20.00 remains, but nothing in the
  // data says where the other 80.00 went.
  const refunded = cr({ number: 'CN-R', date: '2026-08-01', total: 10000, remaining: 2000 });
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: RANGE_90, invoices: [], credits: [refunded] });
  assert.equal(m.checks.currentBalance, -2000);
  assert.equal(m.checks.ledgerBalance, -10000);
  assert.equal(m.checks.difference, 8000);
});

test('rows on the same day are ordered invoice, then credit, then payment', () => {
  const a = inv({ number: 'A', date: '2026-08-01', total: 1000, amountDue: 0, status: 'PAID', payments: [{ id: 'p', date: '2026-08-01', amount: 1000, reference: '' }] });
  const c = cr({ number: 'CN1', date: '2026-08-01', total: 100, remaining: 100 });
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: RANGE_90, invoices: [a], credits: [c] });
  assert.deepEqual(m.activity.rows.map((r) => r.label), ['Invoice A', 'Credit note CN1', 'Payment received']);
});

test('a settled invoice with no date is left out of the ledger and counted', () => {
  const broken = inv({ number: 'X', date: null, status: 'PAID', total: 500, amountPaid: 500 });
  const m = buildStatementModel({ currency: 'AUD', today: TODAY, range: RANGE_90, invoices: [broken], credits: [] });
  assert.equal(m.checks.undatedTransactions, 1);
  assert.deepEqual(m.activity.rows, []);
});

test('an open invoice or credit with no date fails loudly instead of being aged by guesswork', () => {
  const openNoDate = inv({ number: 'X', date: null, total: 500, amountDue: 500 });
  assert.throws(() => buildStatementModel({ currency: 'AUD', today: TODAY, range: null, invoices: [openNoDate], credits: [] }), /X has no date/);
  const creditNoDate = cr({ number: 'CN0', date: null, total: 100, remaining: 100 });
  assert.throws(() => buildStatementModel({ currency: 'AUD', today: TODAY, range: null, invoices: [], credits: [creditNoDate] }), /CN0 has no date/);
});

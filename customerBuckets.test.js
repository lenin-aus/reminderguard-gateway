'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCustomerBuckets } = require('./customerBuckets');

const TODAY = '2026-09-25';
const inv = (o) => ({ type: 'ACCREC', currency: 'AUD', contactName: 'X', dueDate: null, amountDue: 0, ...o });
const cr = (o) => ({ currency: 'AUD', remaining: 0, ...o });
const build = (invoices, credits = [], emails = {}) => buildCustomerBuckets({ invoices, credits, emailByContactId: emails, today: TODAY });

test('one bucket per contact per currency, in dollars, with email flags', () => {
  const list = build(
    [inv({ contactId: 'c1', contactName: 'Bayside', amountDue: 343400, dueDate: '2026-09-08' }), inv({ contactId: 'c1', contactName: 'Bayside', currency: 'USD', amountDue: 10000, dueDate: '2026-09-20' }), inv({ contactId: 'c2', contactName: 'Pinnacle', amountDue: 308000 })],
    [],
    { c1: true, c2: false }
  );
  assert.deepEqual(list.map((c) => [c.bucketKey, c.contactName, c.currencyCode, c.hasEmail, c.theyOwe, c.overdueAmount, c.daysOverdue]), [
    ['c1_AUD', 'Bayside', 'AUD', true, 3434, 3434, 17],
    ['c1_USD', 'Bayside', 'USD', true, 100, 100, 5],
    ['c2_AUD', 'Pinnacle', 'AUD', false, 3080, 0, 0],
  ]);
});

test('credits are netted off the matching contact and currency only', () => {
  const list = build(
    [inv({ contactId: 'c1', amountDue: 91000, dueDate: '2026-08-08' }), inv({ contactId: 'c1', currency: 'USD', amountDue: 5000 })],
    [cr({ contactId: 'c1', remaining: 6050 }), cr({ contactId: 'c1', currency: 'USD', remaining: 1000 }), cr({ contactId: 'other', remaining: 999999 })],
    {}
  );
  assert.deepEqual(list.map((c) => [c.bucketKey, c.theyOwe]), [['c1_AUD', 849.5], ['c1_USD', 40]]);
});

test('overdue never exceeds what is owed after credits', () => {
  const [c] = build([inv({ contactId: 'c1', amountDue: 30000, dueDate: '2026-08-01' })], [cr({ contactId: 'c1', remaining: 20000 })]);
  assert.equal(c.theyOwe, 100);
  assert.equal(c.overdueAmount, 100);
  assert.equal(c.daysOverdue, 55);
});

test('a customer whose credits cover the debt is left out; so is a credit-only contact', () => {
  const list = build([inv({ contactId: 'c1', amountDue: 5000 })], [cr({ contactId: 'c1', remaining: 5000 }), cr({ contactId: 'c9', remaining: 1000 })]);
  assert.deepEqual(list, []);
});

test('payables, paid invoices and invoices without a contact are ignored', () => {
  const list = build([inv({ contactId: 'c1', type: 'ACCPAY', amountDue: 100 }), inv({ contactId: 'c2', amountDue: 0 }), inv({ contactId: null, amountDue: 100 })]);
  assert.deepEqual(list, []);
});

test('an invoice with no currency falls back to the base currency', () => {
  const [c] = buildCustomerBuckets({ invoices: [inv({ contactId: 'c1', currency: undefined, amountDue: 100 })], credits: [], emailByContactId: {}, today: TODAY, baseCurrency: 'NZD' });
  assert.equal(c.bucketKey, 'c1_NZD');
});

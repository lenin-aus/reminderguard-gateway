'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStatementModel } = require('./statementModel');
const { renderStatementHtml, money } = require('./statementHtml');
const { normalizeInvoice, normalizeCredit } = require('./xeroData');
const { rawInvoices, rawCreditNotes } = require('./statementFixtures');

const invoices = rawInvoices.map(normalizeInvoice);
const credits = rawCreditNotes.filter((c) => c.Type === 'ACCRECCREDIT').map((c) => normalizeCredit('creditNote', c));
const meta = { companyName: 'Acme Pty Ltd', contactName: 'City Limousines' };
const ranged = () => buildStatementModel({ currency: 'AUD', today: '2026-09-25', range: { start: '2026-06-26', end: '2026-09-25' }, invoices, credits });

// Visible text in order, to assert on structure without depending on markup details.
const text = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('money: negatives read -$60.50, zero reads $0.00, the currency comes from the bucket', () => {
  assert.equal(money(-6050, 'AUD'), '-$60.50');
  assert.equal(money(0, 'AUD'), '$0.00');
  assert.equal(money(123456, 'AUD'), '$1,234.56');
});

test('the four sections appear in order with the labels the spec asks for', () => {
  const t = text(renderStatementHtml(ranged(), meta));
  const order = ['Unallocated Credits', 'Outstanding Items as at 25 Sep 2026', 'Age Analysis as at 25 Sep 2026', 'Activity from 26 Jun 2026 to 25 Sep 2026'].map((s) => t.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `a heading is missing: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections are out of order');
});

test('outstanding items: columns, rows, and the Total Outstanding footer', () => {
  const t = text(renderStatementHtml(ranged(), meta));
  assert.match(t, /Date Activity Due Date Amount Payments \/ Deductions Balance/);
  assert.match(t, /03 Jul 2026 ORC1002 13 Jul 2026 \$1,100\.00 -\$850\.00 \$250\.00/);
  assert.match(t, /23 Aug 2026 Credit note ORC1037 -\$60\.50 \$0\.00 -\$60\.50/);
  assert.match(t, /Total Outstanding \$849\.50/);
});

test('age analysis: columns, both rows, and the footnote', () => {
  const t = text(renderStatementHtml(ranged(), meta));
  assert.match(t, /90 days \+.*60 days.*30 days.*Current/);
  assert.match(t, /Outstanding Invoices \$0\.00 \$910\.00 \$0\.00 \$0\.00/);
  assert.match(t, /Available Credits \$0\.00 \$0\.00 \$60\.50 \$0\.00/);
  assert.match(t, /Based on date raised and aged by exact days\./);
});

test('activity: opening balance first, a payment sub-line, and a closing Balance row', () => {
  const t = text(renderStatementHtml(ranged(), meta));
  assert.match(t, /Date Activity Debit Credit Balance Opening balance \$0\.00/);
  assert.match(t, /13 Jul 2026 Payment received \$850\.00 \$250\.00 Applied to invoice ORC1002/);
  assert.match(t, /23 Aug 2026 Credit note ORC1037 \$60\.50 \$849\.50 Balance \$849\.50/);
});

test('with no credits the Unallocated Credits section is omitted entirely', () => {
  const model = buildStatementModel({ currency: 'AUD', today: '2026-09-25', range: null, invoices, credits: [] });
  assert.ok(!renderStatementHtml(model, meta).includes('Unallocated Credits'));
});

test('a scheduled statement has sections 2 and 3 and no Activity', () => {
  const model = buildStatementModel({ currency: 'AUD', today: '2026-09-25', range: null, invoices, credits });
  const html = renderStatementHtml(model, meta);
  assert.ok(html.includes('Outstanding Items') && html.includes('Age Analysis') && html.includes('Unallocated Credits'));
  assert.ok(!html.includes('<h2>Activity') && !html.includes('Opening balance'));
});

test('Xero-supplied text is escaped', () => {
  const evil = { ...meta, companyName: '<script>alert(1)</script>', contactName: 'Tom & "Jerry" <img src=x>' };
  const html = renderStatementHtml(ranged(), evil);
  assert.ok(!html.includes('<script>alert') && !html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('Tom &amp; &quot;Jerry&quot;'));
});

test('a reference from Xero cannot inject markup into the table', () => {
  const inj = rawInvoices.map((i, n) => (n === 0 ? { ...i, InvoiceNumber: '</td><td onclick=x>' } : i)).map(normalizeInvoice);
  const model = buildStatementModel({ currency: 'AUD', today: '2026-09-25', range: null, invoices: inj, credits: [] });
  assert.ok(!renderStatementHtml(model, meta).includes('<td onclick=x>'));
});

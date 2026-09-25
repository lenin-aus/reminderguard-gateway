'use strict';

// Renders a statement model (statementModel.js) as the HTML that Gotenberg turns into the PDF.
// Every dynamic value goes through escapeHtml: contact names and references come from Xero
// and are typed by users.

const { escapeHtml, formatDate } = require('./statementTemplate');

function money(cents, currency) {
  const formatted = new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  }).format(Math.abs(cents) / 100);
  return cents < 0 ? `-${formatted}` : formatted;
}

const CSS = `
body{font-family:Arial,sans-serif;color:#333;margin:0;padding:0;}
.wrap{max-width:750px;margin:0 auto;padding:40px 30px;}
.hdr{border-bottom:3px solid #1a56db;padding-bottom:20px;margin-bottom:24px;}
.co{font-size:22px;font-weight:bold;color:#1a56db;}
.ttl{font-size:16px;color:#555;margin-top:4px;}
.meta{display:flex;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:16px;}
.mb{font-size:13px;line-height:1.8;}
.mb strong{display:block;font-size:11px;text-transform:uppercase;color:#888;margin-bottom:2px;}
h2{font-size:15px;margin:28px 0 8px;color:#111;page-break-after:avoid;}
h2 .lbl{font-size:12px;font-weight:normal;color:#777;margin-left:6px;}
table{width:100%;border-collapse:collapse;font-size:12px;}
thead th{background:#f1f5f9;color:#555;padding:8px 10px;text-align:left;font-weight:600;border-bottom:1px solid #d5dbe3;}
td{padding:8px 10px;border-bottom:1px solid #e8ebef;}
tr{page-break-inside:avoid;}
thead{display:table-header-group;}
.r{text-align:right;} .c{text-align:center;}
th.r{text-align:right;}
tfoot td, tr.total td{font-weight:bold;background:#f8fafc;border-top:2px solid #1a56db;border-bottom:none;}
tr.opening td{color:#555;background:#f8fafc;}
tr.note td{color:#777;font-size:11px;padding-top:0;padding-bottom:8px;}
.sub{display:block;font-weight:normal;font-size:10px;color:#888;}
.credit-line{font-size:13px;padding:8px 12px;border:1px solid #e0e0e0;border-radius:4px;margin-bottom:6px;display:flex;justify-content:space-between;}
.fn{font-size:11px;color:#777;font-style:italic;margin-top:6px;}
.ftr{margin-top:40px;padding-top:20px;border-top:1px solid #e0e0e0;font-size:11px;color:#999;text-align:center;}
`;

function unallocatedSection(model) {
  if (model.unallocatedCredits.length === 0) return '';
  const lines = model.unallocatedCredits
    .map(
      (c) =>
        `<div class="credit-line"><span>${escapeHtml(c.label)}</span><span>${escapeHtml(money(c.remaining, model.currency))} remaining</span></div>`
    )
    .join('');
  return `<h2>Unallocated Credits</h2>${lines}`;
}

function outstandingSection(model) {
  const { currency } = model;
  const rows = model.outstanding.rows
    .map(
      (r) => `<tr>
      <td>${escapeHtml(formatDate(r.date))}</td>
      <td>${escapeHtml(r.activity)}</td>
      <td>${r.dueDate ? escapeHtml(formatDate(r.dueDate)) : ''}</td>
      <td class="r">${escapeHtml(money(r.amount, currency))}</td>
      <td class="r">${escapeHtml(money(r.deductions, currency))}</td>
      <td class="r">${escapeHtml(money(r.balance, currency))}</td>
    </tr>`
    )
    .join('');
  return `<h2>Outstanding Items<span class="lbl">as at ${escapeHtml(formatDate(model.today))}</span></h2>
  <table>
    <thead><tr><th>Date</th><th>Activity</th><th>Due Date</th><th class="r">Amount</th><th class="r">Payments / Deductions</th><th class="r">Balance</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="5">Total Outstanding</td><td class="r">${escapeHtml(money(model.outstanding.total, currency))}</td></tr></tfoot>
  </table>`;
}

function ageingSection(model) {
  const { currency, ageing } = model;
  const cells = (buckets) =>
    ['d90plus', 'd60', 'd30', 'current'].map((k) => `<td class="r">${escapeHtml(money(buckets[k], currency))}</td>`).join('');
  return `<h2>Age Analysis<span class="lbl">as at ${escapeHtml(formatDate(model.today))}</span></h2>
  <table>
    <thead><tr><th></th>
      <th class="r">90 days +<span class="sub">over 90 days</span></th>
      <th class="r">60 days<span class="sub">61 to 90 days</span></th>
      <th class="r">30 days<span class="sub">31 to 60 days</span></th>
      <th class="r">Current<span class="sub">0 to 30 days</span></th></tr></thead>
    <tbody>
      <tr><td>Outstanding Invoices</td>${cells(ageing.invoices)}</tr>
      <tr><td>Available Credits</td>${cells(ageing.credits)}</tr>
    </tbody>
  </table>
  <p class="fn">Based on date raised and aged by exact days.</p>`;
}

function activitySection(model) {
  const a = model.activity;
  if (!a) return '';
  const { currency } = model;
  const rows = a.rows
    .map((r) => {
      const main = `<tr>
      <td>${escapeHtml(formatDate(r.date))}</td>
      <td>${escapeHtml(r.label)}</td>
      <td class="r">${r.debit ? escapeHtml(money(r.debit, currency)) : ''}</td>
      <td class="r">${r.credit ? escapeHtml(money(r.credit, currency)) : ''}</td>
      <td class="r">${escapeHtml(money(r.balance, currency))}</td>
    </tr>`;
      return r.note ? `${main}<tr class="note"><td></td><td colspan="4">${escapeHtml(r.note)}</td></tr>` : main;
    })
    .join('');
  return `<h2>Activity<span class="lbl">from ${escapeHtml(formatDate(a.start))} to ${escapeHtml(formatDate(a.end))}</span></h2>
  <table>
    <thead><tr><th>Date</th><th>Activity</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
    <tbody>
      <tr class="opening"><td colspan="4">Opening balance</td><td class="r">${escapeHtml(money(a.opening, currency))}</td></tr>
      ${rows}
      <tr class="total"><td colspan="4">Balance</td><td class="r">${escapeHtml(money(a.closing, currency))}</td></tr>
    </tbody>
  </table>`;
}

// meta: { companyName, contactName }
function renderStatementHtml(model, { companyName, contactName }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}</style></head><body><div class="wrap">
<div class="hdr"><div class="co">${escapeHtml(companyName)}</div><div class="ttl">Statement of Account</div></div>
<div class="meta">
  <div class="mb"><strong>Prepared By</strong>${escapeHtml(companyName)}</div>
  <div class="mb"><strong>Statement Date</strong>${escapeHtml(formatDate(model.today))}</div>
  <div class="mb"><strong>Account</strong>${escapeHtml(contactName)}</div>
  <div class="mb"><strong>Currency</strong>${escapeHtml(model.currency)}</div>
</div>
${unallocatedSection(model)}
${outstandingSection(model)}
${ageingSection(model)}
${activitySection(model)}
<div class="ftr">Statement generated automatically on ${escapeHtml(formatDate(model.today))}.<br>
Please contact us if you have any questions regarding your account.</div>
</div></body></html>`;
}

module.exports = { renderStatementHtml, money };

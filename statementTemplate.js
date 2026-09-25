'use strict';

// Placeholders and safe text handling for the email subject, body and the PDF labels.
//   {{start_date}}, {{end_date}}   the statement range, e.g. "01 Aug 2026"
//   {{your_company_name}}          the client's name
// Whitespace inside the braces is allowed ("{{ your_company_name }}"). Unknown placeholders
// are rejected up front so a typo never reaches a customer as literal "{{...}}" text.

const { DateTime } = require('luxon');

const ALLOWED = new Set(['start_date', 'end_date', 'your_company_name']);
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// '2026-08-01' -> '01 Aug 2026'. The English locale, not en-AU: ICU writes September as "Sept".
function formatDate(isoDate) {
  if (!isoDate) return '';
  return DateTime.fromISO(isoDate, { zone: 'utc' }).setLocale('en').toFormat('dd LLL yyyy');
}

function placeholdersIn(text) {
  return [...String(text ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]);
}

function unknownPlaceholders(text) {
  return [...new Set(placeholdersIn(text).filter((name) => !ALLOWED.has(name)))];
}

// vars: { start_date, end_date, your_company_name }; dates are ISO 'YYYY-MM-DD'.
function renderTemplate(text, vars) {
  return String(text ?? '').replace(PLACEHOLDER, (whole, name) => {
    if (!ALLOWED.has(name)) throw new Error(`Unknown placeholder {{${name}}}`);
    const value = vars[name];
    if (value === undefined || value === null) throw new Error(`No value for {{${name}}}`);
    return name === 'your_company_name' ? String(value) : formatDate(value);
  });
}

// An email subject is one line: strip line breaks (header injection) and tidy spaces.
function toSubject(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Plain text to HTML: escaped, blank lines separate paragraphs, single line breaks stay.
function bodyToHtml(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

module.exports = { ALLOWED, MAX_SUBJECT, MAX_BODY, escapeHtml, formatDate, placeholdersIn, unknownPlaceholders, renderTemplate, toSubject, bodyToHtml };

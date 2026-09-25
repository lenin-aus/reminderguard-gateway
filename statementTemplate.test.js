'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('./statementTemplate');

const vars = { start_date: '2026-08-01', end_date: '2026-09-25', your_company_name: 'Acme & Sons' };

test('dates are written as "01 Aug 2026", with "Sep" for September', () => {
  assert.equal(t.formatDate('2026-08-01'), '01 Aug 2026');
  assert.equal(t.formatDate('2026-09-25'), '25 Sep 2026');
  assert.equal(t.formatDate(null), '');
});

test('placeholders are replaced, with or without spaces inside the braces', () => {
  assert.equal(
    t.renderTemplate('Statement {{start_date}} to {{ end_date }} from {{  your_company_name }}', vars),
    'Statement 01 Aug 2026 to 25 Sep 2026 from Acme & Sons'
  );
});

test('unknown placeholders are reported, and rendering refuses them', () => {
  assert.deepEqual(t.unknownPlaceholders('Hi {{first_name}}, {{start_date}} {{first_name}} {{amount}}'), ['first_name', 'amount']);
  assert.deepEqual(t.unknownPlaceholders('{{start_date}} {{ end_date }}'), []);
  assert.throws(() => t.renderTemplate('Hi {{first_name}}', vars), /Unknown placeholder/);
});

test('a placeholder with no value is an error, not an empty string', () => {
  assert.throws(() => t.renderTemplate('{{start_date}}', { end_date: '2026-09-25' }), /No value for \{\{start_date\}\}/);
});

test('a subject is a single tidy line', () => {
  assert.equal(t.toSubject('Your statement\r\nBcc: x@y.z   for  Sep'), 'Your statement Bcc: x@y.z for Sep');
});

test('a body becomes escaped paragraphs and line breaks', () => {
  assert.equal(t.bodyToHtml('Hi <b>there</b>\nsecond line\n\nThanks & bye'), '<p>Hi &lt;b&gt;there&lt;/b&gt;<br>second line</p><p>Thanks &amp; bye</p>');
});

test('escapeHtml covers the five characters that matter', () => {
  assert.equal(t.escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

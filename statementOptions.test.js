'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateStatementOptions, statementOptionsHash, statementLockKey, StatementOptionsError } = require('./statementOptions');

const now = () => Date.parse('2026-09-25T02:00:00Z');
const ok = (input) => validateStatementOptions(input, { now });
function fields(input) {
  try {
    validateStatementOptions(input, { now });
  } catch (err) {
    assert.ok(err instanceof StatementOptionsError);
    assert.equal(err.code, 'VALIDATION_FAILED');
    return err.fields;
  }
  assert.fail('expected a validation error');
}

test('no options, or an empty object, means a plain send', () => {
  assert.equal(ok(undefined), null);
  assert.equal(ok(null), null);
  assert.equal(ok({}), null);
  assert.equal(ok({ subject: '  ', body: '' }), null, 'blank text counts as not given');
});

test('a full set of options is normalised', () => {
  assert.deepEqual(
    ok({ start_date: '2026-07-01', end_date: '2026-09-25', reply_to: ' me@example.com ', bcc: 'ops@example.com', subject: 'Statement to {{end_date}}', body: 'Hi\n{{start_date}}' }),
    {
      range: { start: '2026-07-01', end: '2026-09-25', startUtc: '2026-06-30T14:00:00.000Z', endUtc: '2026-09-25T13:59:59.999Z', timezone: 'Australia/Melbourne' },
      replyTo: 'me@example.com',
      bcc: 'ops@example.com',
      subject: 'Statement to {{end_date}}',
      body: 'Hi\n{{start_date}}',
    }
  );
});

test('unknown keys are rejected, including the client id', () => {
  assert.deepEqual(fields({ client_id: 1, subject: 'x' }), { client_id: 'Unknown field' });
  assert.deepEqual(fields({ sender_email: 'a@b.co' }), { sender_email: 'Unknown field' });
});

test('email fields take exactly one valid address', () => {
  for (const bad of ['nope', 'a@b', 'a@b.co, c@d.co', 'a@b.co\r\nBcc: x@y.z', '<a@b.co>']) {
    assert.deepEqual(fields({ reply_to: bad }), { reply_to: 'Enter a single valid email address' }, bad);
  }
  assert.deepEqual(fields({ bcc: 'x'.repeat(250) + '@b.co' }), { bcc: 'Enter a single valid email address' });
});

test('subject and body have length limits and must be text', () => {
  assert.deepEqual(fields({ subject: 'x'.repeat(201) }), { subject: 'Keep the subject under 200 characters' });
  assert.deepEqual(fields({ body: 'x'.repeat(5001) }), { body: 'Keep the body under 5000 characters' });
  assert.deepEqual(fields({ subject: 42 }), { subject: 'Must be text' });
});

test('unknown placeholders are rejected in the subject and the body', () => {
  assert.deepEqual(fields({ subject: 'Hi {{name}}', body: 'Total {{amount}} {{ your_company_name }}' }), {
    subject: 'Unknown placeholder: {{name}}',
    body: 'Unknown placeholder: {{amount}}',
  });
});

test('date placeholders need a date range; the company name does not', () => {
  assert.deepEqual(fields({ subject: 'Up to {{end_date}}' }), { subject: 'Uses {{start_date}} or {{end_date}}, but no date range was given' });
  assert.deepEqual(ok({ subject: 'From {{your_company_name}}' }).subject, 'From {{your_company_name}}');
});

test('range problems come back as field errors alongside the others', () => {
  assert.deepEqual(fields({ start_date: '2026-09-10', end_date: '2026-09-01', reply_to: 'bad' }), {
    end_date: 'The end date cannot be before the start date',
    reply_to: 'Enter a single valid email address',
  });
  assert.deepEqual(fields({ start_date: '2026-09-01', end_date: '2026-09-30' }), { end_date: 'The end date cannot be in the future' });
});

test('the hash separates a corrected send from an identical one', () => {
  const a = ok({ start_date: '2026-07-01', end_date: '2026-09-25', subject: 'S' });
  const same = ok({ start_date: '2026-07-01', end_date: '2026-09-25', subject: 'S' });
  const otherRange = ok({ start_date: '2026-08-01', end_date: '2026-09-25', subject: 'S' });
  const otherSubject = ok({ start_date: '2026-07-01', end_date: '2026-09-25', subject: 'T' });
  assert.equal(statementOptionsHash(a), statementOptionsHash(same));
  assert.notEqual(statementOptionsHash(a), statementOptionsHash(otherRange));
  assert.notEqual(statementOptionsHash(a), statementOptionsHash(otherSubject));
  assert.equal(statementOptionsHash(null), 'default');
  assert.match(statementOptionsHash(a), /^[0-9a-f]{12}$/);
});

test('the lock key is unchanged for plain sends, and carries the hash for custom ones', () => {
  assert.equal(statementLockKey(7, 'c1_AUD', '2026-09-25'), 'sent-statement:7:c1_AUD:2026-09-25');
  assert.equal(statementLockKey(7, 'c1_AUD', '2026-09-25', 'default'), 'sent-statement:7:c1_AUD:2026-09-25');
  assert.equal(statementLockKey(7, 'c1_AUD', '2026-09-25', 'abc123def456'), 'sent-statement:7:c1_AUD:2026-09-25:abc123def456');
});

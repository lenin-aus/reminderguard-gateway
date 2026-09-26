'use strict';

// Needs PG_TEST_URL (the dev-stack Postgres with migrations 003 and 004), like the other .db tests.
// Every test runs in a transaction that is rolled back. Xero is a scripted in-memory fake, and the
// real client, limiter, data layer and sync run on top of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXeroClient } = require('./xeroClient');
const { createMemoryLimiter } = require('./xeroLimiter');
const { createXeroData } = require('./xeroData');
const { createXeroSync, OVERLAP_MS } = require('./xeroSync');
const { createLocalData } = require('./xeroDataLocal');
const { createFakeXero, rawInvoice, rawContact, rawCreditNote, guid } = require('./xeroFake');

const url = process.env.PG_TEST_URL;
const skip = !url && 'set PG_TEST_URL to run';
const CLIENT = 7; // any seeded client_config row

let pool;
test.before(() => {
  if (!url) return;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: url });
});
test.after(async () => {
  if (pool) await pool.end();
});

async function inTx(fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    for (const t of ['xero_invoices', 'xero_credits', 'xero_contacts', 'xero_sync_state']) await db.query(`DELETE FROM ${t} WHERE client_id = $1`, [CLIENT]);
    const fake = createFakeXero();
    const client = createXeroClient({ limiter: createMemoryLimiter(), fetchImpl: fake.fetchImpl, sleep: async () => {}, log: { warn() {} } });
    const logged = [];
    const sync = createXeroSync({ db, client, now: () => fake.clock.now, log: { log: (m) => logged.push(m), warn() {} } });
    const ctx = { clientId: CLIENT, tenantId: 'T', accessToken: 'x' };
    await fn({ db, fake, client, sync, ctx, logged });
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

const count = async (db, table, where = '') => Number((await db.query(`SELECT count(*) FROM ${table} WHERE client_id = $1 ${where}`, [CLIENT])).rows[0].count);
const invoiceRow = async (db, id) => (await db.query('SELECT * FROM xero_invoices WHERE client_id = $1 AND invoice_id = $2', [CLIENT, id])).rows[0];
const stateOf = async (db, resource) => (await db.query('SELECT * FROM xero_sync_state WHERE client_id = $1 AND resource = $2', [CLIENT, resource])).rows[0];

// A small organisation: two customers, invoices of every status and type, credits of every kind.
function seed(fake) {
  fake.add('Contacts', rawContact(1));
  fake.add('Contacts', rawContact(2, { EmailAddress: '' }));
  fake.add('Contacts', rawContact(3, { ContactStatus: 'ARCHIVED' }));
  fake.add('Invoices', rawInvoice(1));
  fake.add('Invoices', rawInvoice(2, { Contact: { ContactID: guid(2), Name: 'Customer 2' }, Total: 300, AmountDue: 300 }));
  fake.add('Invoices', rawInvoice(3, { Status: 'PAID', AmountPaid: 100, AmountDue: 0, Payments: [{ PaymentID: guid(9), Date: '/Date(1782259200000+0000)/', Amount: 100, Reference: 'EFT' }] }));
  fake.add('Invoices', rawInvoice(4, { Status: 'VOIDED' }));
  fake.add('Invoices', rawInvoice(5, { Status: 'DRAFT' }));
  fake.add('Invoices', rawInvoice(6, { Type: 'ACCPAY' }));
  fake.add('CreditNotes', rawCreditNote(1));
  fake.add('CreditNotes', rawCreditNote(2, { Type: 'ACCPAYCREDIT' }));
  fake.add('CreditNotes', rawCreditNote(3, { Status: 'VOIDED' }));
  fake.add('Overpayments', { OverpaymentID: guid(3001), Type: 'RECEIVE-OVERPAYMENT', Status: 'AUTHORISED', Contact: { ContactID: guid(1) }, CurrencyCode: 'AUD', DateString: '2026-08-20T00:00:00', Total: 25, RemainingCredit: 25, Allocations: [] });
  fake.add('Prepayments', { PrepaymentID: guid(3002), Reference: 'Deposit', Type: 'RECEIVE-PREPAYMENT', Status: 'AUTHORISED', Contact: { ContactID: guid(2) }, CurrencyCode: 'AUD', DateString: '2026-08-21T00:00:00', Total: 50, RemainingCredit: 50, Allocations: [] });
}

test('the first run copies everything Xero has that statements read, and nothing else', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    const summary = await sync.syncClient(ctx, { mode: 'incremental' }); // no watermark yet: a full backfill
    assert.deepEqual(summary.errors, {});
    assert.equal(summary.resources.invoices.full, true);

    assert.equal(await count(db, 'xero_contacts'), 3, 'archived contacts are kept (flagged)');
    assert.equal(await count(db, 'xero_invoices'), 3, 'authorised and paid receivable invoices only');
    assert.deepEqual((await db.query('SELECT number FROM xero_invoices WHERE client_id = $1 ORDER BY number', [CLIENT])).rows.map((r) => r.number), ['INV-1', 'INV-2', 'INV-3']);
    assert.equal(await count(db, 'xero_credits'), 3, 'one credit note, one overpayment, one prepayment');
    assert.equal((await db.query('SELECT archived FROM xero_contacts WHERE client_id = $1 AND contact_id = $2', [CLIENT, guid(3)])).rows[0].archived, true);

    const watermark = (await stateOf(db, 'invoices')).watermark;
    assert.equal(watermark.getTime(), fake.clock.now.getTime() - OVERLAP_MS);
  }));

test('an incremental run asks only for changes, in one call per resource when nothing changed', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    await sync.syncClient(ctx);
    fake.calls.length = 0;
    fake.advance(30 * 60 * 1000);
    await sync.syncClient(ctx, { mode: 'incremental' });

    assert.equal(fake.calls.length, 5, 'contacts, invoices and the three credit kinds');
    assert.ok(fake.calls.every((c) => c.since), 'every call carries If-Modified-Since');
    assert.equal(fake.calls.find((c) => c.path === 'Invoices').since, new Date(new Date('2026-09-01T00:00:00Z').getTime() - OVERLAP_MS).toISOString().slice(0, 19));
    assert.equal(await count(db, 'xero_invoices'), 3);
  }));

test('a payment, a void, a new invoice, an archived contact and a new credit arrive incrementally', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    await sync.syncClient(ctx);
    fake.advance(60 * 60 * 1000);

    fake.touch('Invoices', guid(1001), { Status: 'PAID', AmountPaid: 100, AmountDue: 0, Payments: [{ PaymentID: guid(10), Date: '/Date(1790000000000+0000)/', Amount: 100, Reference: 'x' }] });
    fake.touch('Invoices', guid(1002), { Status: 'VOIDED' });
    fake.add('Invoices', rawInvoice(7, { Total: 70, AmountDue: 70 }));
    fake.touch('Contacts', guid(2), { ContactStatus: 'ARCHIVED' });
    fake.add('CreditNotes', rawCreditNote(4));
    const summary = await sync.syncClient(ctx, { mode: 'incremental' });
    assert.deepEqual(summary.errors, {});

    const paid = await invoiceRow(db, guid(1001));
    assert.deepEqual([paid.status, Number(paid.amount_due), Number(paid.amount_paid), paid.payments.length], ['PAID', 0, 10000, 1]);
    assert.equal(await invoiceRow(db, guid(1002)), undefined, 'a void takes the row out');
    assert.ok(await invoiceRow(db, guid(1007)));
    assert.equal((await db.query('SELECT archived FROM xero_contacts WHERE client_id = $1 AND contact_id = $2', [CLIENT, guid(2)])).rows[0].archived, true);
    assert.equal(await count(db, 'xero_credits', `AND kind = 'creditNote'`), 2);
  }));

test('a payment that does NOT move UpdatedDateUTC is missed by incremental sync and found by the full one', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx, logged }) => {
    seed(fake);
    fake.advance(60 * 60 * 1000); // the records are older than the first run's watermark, as in real life
    await sync.syncClient(ctx);
    fake.advance(60 * 60 * 1000);

    fake.touch('Invoices', guid(1001), { Status: 'PAID', AmountPaid: 100, AmountDue: 0 }, { bump: false });
    await sync.syncClient(ctx, { mode: 'incremental' });
    assert.equal(Number((await invoiceRow(db, guid(1001))).amount_due), 10000, 'the copy still shows it owing');
    assert.equal((await stateOf(db, 'invoices')).fixed_by_full, 0);

    fake.advance(20 * 60 * 60 * 1000);
    const summary = await sync.syncClient(ctx, { mode: 'full' });
    const fixed = await invoiceRow(db, guid(1001));
    assert.deepEqual([fixed.status, Number(fixed.amount_due)], ['PAID', 0], 'the nightly full pull corrects it');
    assert.ok(summary.resources.invoices.fixed >= 1);
    assert.ok((await stateOf(db, 'invoices')).fixed_by_full >= 1, 'and the miss is counted');
    assert.ok(logged.some((m) => m.includes('full done')));
  }));

test('a full pull does not count a first backfill as a miss', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    await sync.syncClient(ctx, { mode: 'full' });
    assert.equal((await stateOf(db, 'invoices')).fixed_by_full, 0);
  }));

test('a row Xero no longer returns is confirmed by id, then removed; one the list only skipped stays', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    await sync.syncClient(ctx);

    fake.remove('Invoices', guid(1002)); // gone from Xero
    fake.options.hideFromLists.add(guid(1001)); // still there, but the list skipped it (paging over a changing list)
    fake.calls.length = 0;
    await sync.syncClient(ctx, { mode: 'full' });

    assert.equal(await invoiceRow(db, guid(1002)), undefined, 'removed');
    assert.ok(await invoiceRow(db, guid(1001)), 'kept, because a by-id read found it');
    assert.ok(fake.calls.some((c) => c.path === 'Invoices' && c.query.IDs), 'confirmed by id before removing');
  }));

test('an archived contact stays as archived, a contact Xero no longer has is removed', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    await sync.syncClient(ctx);
    fake.remove('Contacts', guid(2));
    await sync.syncClient(ctx, { mode: 'full' });
    assert.equal(await count(db, 'xero_contacts'), 2);
    assert.equal((await db.query('SELECT archived FROM xero_contacts WHERE client_id = $1 AND contact_id = $2', [CLIENT, guid(3)])).rows[0].archived, true);
  }));

test('credits that become voided, or vanish, leave the copy', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    await sync.syncClient(ctx);
    fake.advance(60 * 1000);
    fake.touch('CreditNotes', guid(2001), { Status: 'VOIDED' });
    await sync.syncClient(ctx, { mode: 'incremental' });
    assert.equal(await count(db, 'xero_credits', `AND kind = 'creditNote'`), 0);

    fake.remove('Overpayments', guid(3001));
    await sync.syncClient(ctx, { mode: 'full' });
    assert.equal(await count(db, 'xero_credits'), 1, 'only the prepayment is left');
  }));

test('a run never empties the copy: a wrong answer from Xero removes nothing', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    for (let n = 1; n <= 60; n++) fake.add('Invoices', rawInvoice(100 + n));
    await sync.syncClient(ctx);
    assert.equal(await count(db, 'xero_invoices'), 60);

    for (let n = 1; n <= 60; n++) fake.remove('Invoices', guid(1100 + n)); // Xero suddenly returns none
    const summary = await sync.syncClient(ctx, { mode: 'full' });

    assert.equal(summary.errors.invoices, 'TOO_MANY_REMOVALS');
    assert.equal(await count(db, 'xero_invoices'), 60, 'nothing was removed');
    assert.match((await stateOf(db, 'invoices')).last_error, /refusing to remove/);
  }));

test('one resource failing is recorded and does not stop the others', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    fake.options.failLists.add('Overpayments');
    const summary = await sync.syncClient(ctx);
    assert.deepEqual(Object.keys(summary.errors), ['overpayment']);
    assert.ok(summary.resources.invoices && summary.resources.prepayment);
    assert.ok((await stateOf(db, 'overpayment')).last_error);
    assert.equal(await stateOf(db, 'overpayment').then((s) => s.last_run_at), null, 'a failed resource is not marked as synced');
    assert.equal(await count(db, 'xero_invoices'), 3);
  }));

test('refreshing one contact live corrects its invoices and credits and drops what Xero no longer has', { skip }, () =>
  inTx(async ({ db, fake, sync, ctx }) => {
    seed(fake);
    await sync.syncClient(ctx);
    fake.advance(60 * 60 * 1000);
    fake.touch('Invoices', guid(1001), { Status: 'PAID', AmountPaid: 100, AmountDue: 0 }, { bump: false }); // incremental would miss this
    fake.touch('Invoices', guid(1003), { Status: 'VOIDED' }, { bump: false });
    fake.touch('CreditNotes', guid(2001), { RemainingCredit: 5 }, { bump: false });

    await sync.refreshContact(ctx, guid(1));

    assert.equal(Number((await invoiceRow(db, guid(1001))).amount_due), 0);
    assert.equal(await invoiceRow(db, guid(1003)), undefined);
    assert.equal(Number((await db.query(`SELECT remaining FROM xero_credits WHERE client_id = $1 AND credit_id = $2`, [CLIENT, guid(2001)])).rows[0].remaining), 500);
    assert.ok(await invoiceRow(db, guid(1002)), 'other contacts are not touched');
  }));

test('the local data layer answers exactly like the live one, for every read', { skip }, () =>
  inTx(async ({ db, fake, client, sync, ctx }) => {
    seed(fake);
    fake.add('Invoices', rawInvoice(8, { Contact: { ContactID: guid(2), Name: 'Customer 2' }, CurrencyCode: 'USD', DueDateString: '2026-09-30T00:00:00', Total: 40, AmountDue: 40 }));
    await sync.syncClient(ctx);

    const live = createXeroData(client);
    const local = createLocalData({ db, live });
    const byId = (a, b) => String(a.id).localeCompare(String(b.id));
    const norm = (list) => [...list].sort(byId);

    for (const contactId of [guid(1), guid(2)]) {
      assert.deepEqual(norm(await local.getOpenInvoices(ctx, contactId)), norm(await live.getOpenInvoices(ctx, contactId)), `open invoices of ${contactId}`);
      assert.deepEqual(norm(await local.getInvoiceHistory(ctx, contactId)), norm(await live.getInvoiceHistory(ctx, contactId)), `history of ${contactId}`);
      assert.deepEqual(norm(await local.getCredits(ctx, contactId)), norm(await live.getCredits(ctx, contactId)), `credits of ${contactId}`);
      assert.deepEqual(await local.getContact(ctx, contactId), await live.getContact(ctx, contactId));
    }
    assert.deepEqual(norm(await local.listOpenInvoices(ctx)), norm(await live.listOpenInvoices(ctx)), 'org-wide open invoices');
    assert.deepEqual(norm(await local.listOpenCredits(ctx)), norm(await live.listOpenCredits(ctx)), 'org-wide open credits');
    assert.deepEqual(norm(await local.getContactsByIds(ctx, [guid(1), guid(2), guid(3), guid(99)])), norm(await live.getContactsByIds(ctx, [guid(1), guid(2), guid(3), guid(99)])));
    await assert.rejects(local.getContact(ctx, guid(99)), { code: 'XERO_NOT_FOUND' });
    assert.deepEqual(await local.getContactsByIds(ctx, []), []);
  }));

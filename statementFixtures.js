'use strict';

// Xero-shaped JSON for one contact, taken from the structure of a real Xero demo organisation
// (ids replaced). Dates and amounts follow the City Limousines statement used as the layout
// reference: two open invoices, one part-paid, and one unallocated credit note.
//   Payments[] carry only the legacy '/Date(ms)/' date, as Xero really returns them.

const CONTACT_ID = '0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff';
const contact = { ContactID: CONTACT_ID, Name: 'City Limousines' };

const rawInvoices = [
  {
    InvoiceID: '11111111-1111-4111-8111-111111111111',
    InvoiceNumber: 'ORC1002',
    Type: 'ACCREC',
    Status: 'AUTHORISED',
    Contact: contact,
    CurrencyCode: 'AUD',
    Date: '/Date(1783036800000+0000)/',
    DateString: '2026-07-03T00:00:00',
    DueDate: '/Date(1783900800000+0000)/',
    DueDateString: '2026-07-13T00:00:00',
    Total: 1100,
    AmountPaid: 850,
    AmountCredited: 0,
    AmountDue: 250,
    UpdatedDateUTCString: '2016-06-24T17:10:04',
    Payments: [
      { PaymentID: '22222222-2222-4222-8222-222222222222', Date: '/Date(1783900800000+0000)/', Amount: 850, Reference: 'Part', CurrencyRate: 1, HasAccount: false, HasValidationErrors: false },
    ],
    CreditNotes: [],
    Prepayments: [],
    Overpayments: [],
  },
  {
    InvoiceID: '33333333-3333-4333-8333-333333333333',
    InvoiceNumber: 'ORC1012',
    Type: 'ACCREC',
    Status: 'AUTHORISED',
    Contact: contact,
    CurrencyCode: 'AUD',
    DateString: '2026-07-23T00:00:00',
    DueDateString: '2026-08-08T00:00:00',
    Total: 660,
    AmountPaid: 0,
    AmountCredited: 0,
    AmountDue: 660,
    UpdatedDateUTCString: '2016-06-24T17:09:13',
    Payments: [],
    CreditNotes: [],
    Prepayments: [],
    Overpayments: [],
  },
];

const rawCreditNotes = [
  {
    CreditNoteID: '44444444-4444-4444-8444-444444444444',
    CreditNoteNumber: 'ORC1037',
    Type: 'ACCRECCREDIT',
    Status: 'AUTHORISED',
    Contact: contact,
    CurrencyCode: 'AUD',
    DateString: '2026-08-23T00:00:00',
    Total: 60.5,
    RemainingCredit: 60.5,
    Allocations: [],
    Payments: [],
  },
  // A supplier credit for the same contact: never part of a customer statement.
  {
    CreditNoteID: '55555555-5555-4555-8555-555555555555',
    CreditNoteNumber: 'SUP-77',
    Type: 'ACCPAYCREDIT',
    Status: 'PAID',
    Contact: contact,
    CurrencyCode: 'AUD',
    DateString: '2026-05-01T00:00:00',
    Total: 500,
    RemainingCredit: 0,
    Allocations: [],
    Payments: [],
  },
];

module.exports = { CONTACT_ID, rawInvoices, rawCreditNotes };

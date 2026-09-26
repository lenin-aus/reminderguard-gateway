'use strict';

// Keeps a copy of the Xero data that statements and the customer list read (migration 004), so
// they can be answered from Postgres instead of calling Xero on every request.
//
//   incremental  asks Xero only for records changed since the last run (If-Modified-Since).
//                Cheap: about one call per resource when nothing changed.
//   full         pulls everything and diffs it against the copy. It is how the first copy is made
//                (backfill) and the nightly safety net: it fixes what an incremental pull missed,
//                and removes what Xero no longer returns. A row Xero did not return is fetched by id
//                before it is removed, because paging a list that changes underneath can skip a row.
//   contact      refreshContact() re-reads ONE contact live (history and credits) into the copy.
//                A statement is built from that, so it is never older than the moment it was sent.
//
// The copy holds only what xeroData.js returns: AUTHORISED and PAID receivable invoices, posted
// receivable credits, and contacts. A void or delete removes the row. Reads exclude everything else.
// fixed_by_full in xero_sync_state counts what a full pull had to fix; zero means incremental sync
// is keeping up. Read-only against Xero (GET), like the rest of the data layer.

const {
  createXeroData,
  normalizeInvoice,
  normalizeCredit,
  normalizeContact,
  CREDIT_KINDS,
  POSTED_CREDIT_STATUSES,
} = require('./xeroData');

const RESOURCES = ['contacts', 'invoices', 'creditNote', 'overpayment', 'prepayment'];
// Ask Xero for changes since a little before the last run started, so clock differences and
// records saved while it ran are not missed. Re-reading a few rows is harmless (upserts).
const OVERLAP_MS = 5 * 60 * 1000;
const CONFIRM_CHUNK = 40;
const UPSERT_CHUNK = 200;
// A single run never removes more than this share of the copy (or this many rows, whichever is
// larger): a wrong or truncated answer from Xero must not empty it.
const MAX_REMOVE_SHARE = 0.5;
const MAX_REMOVE_FLOOR = 50;

class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

// Deep, key-order-independent form, so a row read back from Postgres compares equal to the
// normalised object it was written from.
function sortKeys(v) {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort()
      .reduce((o, k) => {
        o[k] = sortKeys(v[k]);
        return o;
      }, {});
  }
  return v;
}
const canon = (v) => JSON.stringify(sortKeys(v));

const iso = (value) => (value ? new Date(value).toISOString() : null);

// ── The tables ────────────────────────────────────────────────────────────────────────────────

const contactsSpec = {
  table: 'xero_contacts',
  kind: null,
  idCol: 'contact_id',
  contactCol: 'contact_id',
  cols: ['contact_id', 'name', 'email', 'archived'],
  jsonCols: new Set(),
  toRow: (c) => [c.id, c.name, c.email, c.archived],
  fromRow: (r) => ({ id: r.contact_id, name: r.name, email: r.email, archived: r.archived }),
};

const invoicesSpec = {
  table: 'xero_invoices',
  kind: null,
  idCol: 'invoice_id',
  contactCol: 'contact_id',
  cols: ['invoice_id', 'number', 'type', 'status', 'contact_id', 'contact_name', 'currency', 'date', 'due_date', 'total', 'amount_paid', 'amount_credited', 'amount_due', 'updated_at', 'payments'],
  jsonCols: new Set(['payments']),
  toRow: (i) => [i.id, i.number, i.type, i.status, i.contactId, i.contactName, i.currency, i.date, i.dueDate, i.total, i.amountPaid, i.amountCredited, i.amountDue, i.updatedAt, JSON.stringify(i.payments)],
  fromRow: (r) => ({
    id: r.invoice_id,
    number: r.number,
    type: r.type,
    status: r.status,
    contactId: r.contact_id,
    contactName: r.contact_name,
    currency: r.currency,
    date: r.date,
    dueDate: r.due_date,
    total: Number(r.total),
    amountPaid: Number(r.amount_paid),
    amountCredited: Number(r.amount_credited),
    amountDue: Number(r.amount_due),
    updatedAt: iso(r.updated_at),
    payments: r.payments,
  }),
};

const creditSpec = (kind) => ({
  table: 'xero_credits',
  kind,
  idCol: 'credit_id',
  contactCol: 'contact_id',
  cols: ['credit_id', 'contact_id', 'number', 'status', 'currency', 'date', 'total', 'remaining', 'allocations'],
  jsonCols: new Set(['allocations']),
  toRow: (c) => [c.id, c.contactId, c.number, c.status, c.currency, c.date, c.total, c.remaining, JSON.stringify(c.allocations)],
  fromRow: (r) => ({
    kind: r.kind,
    id: r.credit_id,
    contactId: r.contact_id,
    number: r.number,
    status: r.status,
    currency: r.currency,
    date: r.date,
    total: Number(r.total),
    remaining: Number(r.remaining),
    allocations: r.allocations,
  }),
});

const SPECS = {
  contacts: contactsSpec,
  invoices: invoicesSpec,
  creditNote: creditSpec('creditNote'),
  overpayment: creditSpec('overpayment'),
  prepayment: creditSpec('prepayment'),
};

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const isPostedInvoice = (i) => i.type === 'ACCREC' && (i.status === 'AUTHORISED' || i.status === 'PAID');

// ── The engine ────────────────────────────────────────────────────────────────────────────────

function createXeroSync({ db, client, now = () => new Date(), log = console }) {
  const live = createXeroData(client);

  // ── Copy access

  async function readRows(spec, clientId, contactId = null) {
    const params = [clientId];
    let where = 'client_id = $1';
    if (spec.kind) where += ` AND kind = $${params.push(spec.kind)}`;
    if (contactId) where += ` AND ${spec.contactCol} = $${params.push(contactId)}`;
    const { rows } = await db.query(`SELECT * FROM ${spec.table} WHERE ${where}`, params);
    return rows.map(spec.fromRow);
  }

  async function upsert(spec, clientId, items) {
    const cols = ['client_id', ...(spec.kind ? ['kind'] : []), ...spec.cols];
    const conflict = ['client_id', ...(spec.kind ? ['kind'] : []), spec.idCol].join(', ');
    const updates = [...spec.cols.filter((c) => c !== spec.idCol).map((c) => `${c} = EXCLUDED.${c}`), 'synced_at = now()'].join(', ');
    for (const part of chunks(items, UPSERT_CHUNK)) {
      const params = [];
      const tuples = part.map((item) => {
        const values = [clientId, ...(spec.kind ? [spec.kind] : []), ...spec.toRow(item)];
        const marks = values.map((value, i) => `$${params.push(value)}${spec.jsonCols.has(cols[i]) ? '::jsonb' : ''}`);
        return `(${marks.join(', ')}, now())`;
      });
      await db.query(
        `INSERT INTO ${spec.table} (${cols.join(', ')}, synced_at) VALUES ${tuples.join(', ')}
         ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`,
        params
      );
    }
  }

  async function remove(spec, clientId, ids) {
    if (ids.length === 0) return;
    const params = [clientId];
    let where = 'client_id = $1';
    if (spec.kind) where += ` AND kind = $${params.push(spec.kind)}`;
    where += ` AND ${spec.idCol} = ANY($${params.push(ids)}::text[])`;
    await db.query(`DELETE FROM ${spec.table} WHERE ${where}`, params);
  }

  async function getStates(clientId) {
    const { rows } = await db.query('SELECT * FROM xero_sync_state WHERE client_id = $1', [clientId]);
    return new Map(rows.map((r) => [r.resource, r]));
  }

  async function saveState(clientId, resource, patch) {
    const cols = Object.keys(patch);
    await db.query(
      `INSERT INTO xero_sync_state (client_id, resource, ${cols.join(', ')})
       VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (client_id, resource) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
      [clientId, resource, ...cols.map((c) => patch[c])]
    );
  }

  // ── Pulling from Xero. Each returns normalised records; `since` is an If-Modified-Since instant.

  const sinceHeader = (since) => ({ 'If-Modified-Since': since.toISOString().slice(0, 19) });

  async function pullContacts(ctx, since) {
    const raw = await client.getAllPages(ctx, 'Contacts', {
      query: { includeArchived: 'true' },
      listKey: 'Contacts',
      ...(since ? { headers: sinceHeader(since) } : {}),
    });
    return { present: raw.map(normalizeContact), removals: [] };
  }

  async function pullInvoices(ctx, since) {
    if (!since) {
      const raw = await client.getAllPages(ctx, 'Invoices', { query: { Statuses: 'AUTHORISED,PAID' }, listKey: 'Invoices' });
      return { present: raw.map(normalizeInvoice).filter(isPostedInvoice), removals: [] };
    }
    // Changes include voids and deletes, which take the row out of the copy.
    const raw = await client.getAllPages(ctx, 'Invoices', {
      query: { where: 'Type=="ACCREC"' },
      listKey: 'Invoices',
      headers: sinceHeader(since),
    });
    const all = raw.map(normalizeInvoice).filter((i) => i.type === 'ACCREC');
    return { present: all.filter(isPostedInvoice), removals: all.filter((i) => !isPostedInvoice(i)).map((i) => i.id) };
  }

  const pullCredits = (kind) => async (ctx, since) => {
    const spec = CREDIT_KINDS[kind];
    const raw = await client.getAllPages(ctx, spec.path, {
      query: {},
      listKey: spec.listKey,
      ...(since ? { headers: sinceHeader(since) } : {}),
    });
    const receivable = raw.filter(spec.isReceivable);
    const posted = (x) => POSTED_CREDIT_STATUSES.has(x.Status);
    return {
      present: receivable.filter(posted).map((x) => normalizeCredit(kind, x)),
      removals: receivable.filter((x) => !posted(x)).map((x) => x[spec.idField]),
    };
  };

  const PULLS = {
    contacts: pullContacts,
    invoices: pullInvoices,
    creditNote: pullCredits('creditNote'),
    overpayment: pullCredits('overpayment'),
    prepayment: pullCredits('prepayment'),
  };

  // ── Confirming a row the list did not return (by id, before it is removed)

  async function confirmInvoices(ctx, ids) {
    const upserts = [];
    const removals = [];
    for (const part of chunks(ids, CONFIRM_CHUNK)) {
      const data = await client.request(ctx, 'Invoices', { query: { IDs: part.join(',') } });
      const found = new Map((data.Invoices || []).map((x) => [x.InvoiceID, normalizeInvoice(x)]));
      for (const id of part) {
        const inv = found.get(id);
        if (inv && isPostedInvoice(inv)) upserts.push(inv);
        else removals.push(id);
      }
    }
    return { upserts, removals };
  }

  async function confirmContacts(ctx, ids) {
    const upserts = [];
    const removals = [];
    for (const part of chunks(ids, CONFIRM_CHUNK)) {
      const data = await client.request(ctx, 'Contacts', { query: { IDs: part.join(','), includeArchived: 'true' } });
      const found = new Map((data.Contacts || []).map((x) => [x.ContactID, normalizeContact(x)]));
      for (const id of part) {
        if (found.has(id)) upserts.push(found.get(id));
        else removals.push(id);
      }
    }
    return { upserts, removals };
  }

  const confirmCredits = (kind) => async (ctx, ids) => {
    const spec = CREDIT_KINDS[kind];
    const upserts = [];
    const removals = [];
    for (const id of ids) {
      let x = null;
      try {
        x = ((await client.request(ctx, `${spec.path}/${id}`))[spec.listKey] || [])[0] || null;
      } catch (e) {
        if (e.code !== 'XERO_NOT_FOUND') throw e;
      }
      if (x && spec.isReceivable(x) && POSTED_CREDIT_STATUSES.has(x.Status)) upserts.push(normalizeCredit(kind, x));
      else removals.push(id);
    }
    return { upserts, removals };
  }

  const CONFIRMS = {
    contacts: confirmContacts,
    invoices: confirmInvoices,
    creditNote: confirmCredits('creditNote'),
    overpayment: confirmCredits('overpayment'),
    prepayment: confirmCredits('prepayment'),
  };

  // ── Reconciling a pulled set with the copy

  // `scope`: null for the whole org, or a contact id. `pulled` is the COMPLETE set for that scope.
  async function reconcile(ctx, resource, pulled, { contactId = null, countFixes = true } = {}) {
    const spec = SPECS[resource];
    const existing = new Map((await readRows(spec, ctx.clientId, contactId)).map((x) => [x.id, x]));
    const changed = pulled.filter((p) => !existing.has(p.id) || canon(existing.get(p.id)) !== canon(p));
    const pulledIds = new Set(pulled.map((p) => p.id));
    const missing = [...existing.keys()].filter((id) => !pulledIds.has(id));

    const confirmed = missing.length ? await CONFIRMS[resource](ctx, missing) : { upserts: [], removals: [] };
    const limit = Math.max(MAX_REMOVE_FLOOR, Math.floor(existing.size * MAX_REMOVE_SHARE));
    if (confirmed.removals.length > limit) {
      throw new SyncError('TOO_MANY_REMOVALS', `${resource}: refusing to remove ${confirmed.removals.length} of ${existing.size} rows in one run`);
    }

    await upsert(spec, ctx.clientId, [...changed, ...confirmed.upserts]);
    await remove(spec, ctx.clientId, confirmed.removals);
    return {
      upserted: changed.length + confirmed.upserts.length,
      removed: confirmed.removals.length,
      fixed: countFixes ? changed.length + missing.length : 0,
    };
  }

  // ── A run

  async function syncResource(ctx, resource, mode, state) {
    const startedAt = now();
    const hadPrior = Boolean(state && state.watermark);
    const full = mode === 'full' || !hadPrior;

    let result;
    if (full) {
      const { present } = await PULLS[resource](ctx, null);
      result = await reconcile(ctx, resource, present, { countFixes: hadPrior });
    } else {
      const { present, removals } = await PULLS[resource](ctx, new Date(state.watermark));
      const spec = SPECS[resource];
      await upsert(spec, ctx.clientId, present);
      await remove(spec, ctx.clientId, removals);
      result = { upserted: present.length, removed: removals.length, fixed: 0 };
    }

    await saveState(ctx.clientId, resource, {
      watermark: new Date(startedAt.getTime() - OVERLAP_MS),
      last_run_at: startedAt,
      ...(full ? { last_full_at: startedAt, fixed_by_full: result.fixed } : {}),
      last_error: null,
      last_error_at: null,
    });
    return { ...result, full };
  }

  // Runs every resource. One resource failing is recorded and does not stop the others, except when
  // Xero says the day's calls are used up or the token is rejected (nothing further can work).
  async function syncClient(ctx, { mode = 'incremental' } = {}) {
    const states = await getStates(ctx.clientId);
    const summary = { mode, resources: {}, errors: {} };
    for (const resource of RESOURCES) {
      try {
        summary.resources[resource] = await syncResource(ctx, resource, mode, states.get(resource));
      } catch (err) {
        summary.errors[resource] = err.code || err.message;
        await saveState(ctx.clientId, resource, { last_error: String(err.message).slice(0, 500), last_error_at: now() }).catch(() => {});
        log.warn?.(`[xero-sync] client=${ctx.clientId} ${resource} ${mode} failed: ${err.code || ''} ${err.message}`);
        if (err.code === 'XERO_DAILY_LIMIT' || err.code === 'XERO_UNAUTHORIZED' || err.code === 'XERO_FORBIDDEN') break;
      }
    }
    const fixed = Object.values(summary.resources).reduce((n, r) => n + (r.full ? r.fixed : 0), 0);
    if (mode === 'full' || fixed > 0) log.log?.(`[xero-sync] client=${ctx.clientId} ${mode} done: ${JSON.stringify(summary.resources)}`);
    return summary;
  }

  // One contact, live: the contact, its complete history and its credits go into the copy, and rows
  // of that contact Xero no longer returns come out (after a by-id confirmation).
  async function refreshContact(ctx, contactId) {
    let contact = null;
    try {
      contact = await live.getContact(ctx, contactId);
    } catch (e) {
      if (e.code !== 'XERO_NOT_FOUND') throw e;
    }
    if (contact) await upsert(contactsSpec, ctx.clientId, [contact]);
    else await remove(contactsSpec, ctx.clientId, [contactId]);

    const [invoices, credits] = await Promise.all([live.getInvoiceHistory(ctx, contactId), live.getCredits(ctx, contactId)]);
    await reconcile(ctx, 'invoices', invoices, { contactId, countFixes: false });
    for (const kind of Object.keys(CREDIT_KINDS)) {
      await reconcile(ctx, kind, credits.filter((c) => c.kind === kind), { contactId, countFixes: false });
    }
    return { contact };
  }

  return { syncClient, refreshContact, getStates, RESOURCES };
}

module.exports = { createXeroSync, SyncError, RESOURCES, SPECS, canon, OVERLAP_MS };

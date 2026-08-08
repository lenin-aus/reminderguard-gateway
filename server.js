require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Queue } = require('bullmq');
const pool = require('./db');
const xero = require('./xero');
const tokenManager = require('./tokenManager');
const { encrypt, decrypt } = require('./crypto');
const { isConfigComplete } = require('./config');
const { createSession, resolveSession, startSessionCleanupJob } = require('./session');
const { registerAllRepeatableJobs } = require('./scheduler');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Self-serve Appsmith app + n8n trigger target — all resolved via env, not hardcoded.
const SELF_SERVE_HOMEPAGE_URL = process.env.SELF_SERVE_HOMEPAGE_URL;
const SELF_SERVE_SETUP_WIZARD_URL = process.env.SELF_SERVE_SETUP_WIZARD_URL;
const SELF_SERVE_DASHBOARD_URL = process.env.SELF_SERVE_DASHBOARD_URL;
const N8N_NIGHTLY_REPORT_URL = process.env.N8N_NIGHTLY_REPORT_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
// fastledger is a second Appsmith app consuming this same Gateway — its
// post-connect destination, set alongside the other SELF_SERVE_*_URL vars.
const FASTLEDGER_URL = process.env.FASTLEDGER_URL;

const autoStatementsQueue = new Queue('auto-statements', {
  connection: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT || 6379,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD
  }
});

// Dedicated queue for the daily per-client schedule check (see scheduler.js /
// scheduledCheckWorker.js) — kept separate from autoStatementsQueue above,
// which carries the actual send jobs.
const schedulerQueue = new Queue('auto-statements-scheduler', {
  connection: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT || 6379,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD
  }
});

function encodeState(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function decodeState(b64) {
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}

// Resolves where a self-serve login should land after connecting, based on
// which app it came from (returnApp) and whether onboarding is complete.
// Shared by /oauth/callback and /oauth/select-org so both paths agree.
function resolveDestination(returnApp, complete) {
  if (returnApp === 'fastledger') return FASTLEDGER_URL;
  return complete ? SELF_SERVE_DASHBOARD_URL : SELF_SERVE_SETUP_WIZARD_URL;
}

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Self-serve: public "Connect to Xero" entry point ───────────────────────
app.get('/oauth/connect', (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const returnApp = req.query.returnApp === 'fastledger' ? 'fastledger' : 'reminderguard';
  const state = encodeState({ mode: 'self_serve', nonce, returnApp });
  res.cookie('oauth_state', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(xero.buildAuthUrl(state));
});

// ── Practice: one bookkeeper (e.g. Marissa) authorizes access to MANY orgs ─
app.get('/oauth/connect-practice', (req, res) => {
  const ownerLabel = req.query.owner_label || 'Practice';
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = encodeState({ mode: 'practice', nonce, owner_label: ownerLabel });
  res.cookie('oauth_state', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(xero.buildAuthUrl(state));
});

// ── Xero redirects back here after "Allow access" ──────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    let mode = null;
    try { mode = decodeState(state).mode; } catch (_) { /* fall through to default */ }
    res.clearCookie('oauth_state');
    if (mode === 'practice') {
      return res.status(400).send(`<h2>Access denied.</h2><p>Xero returned: ${error}</p>`);
    }
    return res.redirect(`${SELF_SERVE_HOMEPAGE_URL}?error=access_denied`);
  }

  let parsedState;
  try {
    parsedState = decodeState(state);
    if (!parsedState.nonce || parsedState.nonce !== req.cookies.oauth_state) {
      throw new Error('Nonce mismatch');
    }
  } catch (e) {
    return res.status(403).send('Invalid or expired request. Please try connecting again.');
  }
  res.clearCookie('oauth_state');

  try {
    const tokenResponse = await xero.exchangeCodeForToken(code);
    const orgs = await xero.fetchConnections(tokenResponse.access_token);
    if (!orgs.length) return res.status(400).send('No Xero organisation was authorized.');

    if (parsedState.mode === 'practice') {
      const connectionId = await tokenManager.createConnection(tokenResponse, 'practice', parsedState.owner_label);

      const { rows: clients } = await pool.query('SELECT id, client_name, xero_tenant_id FROM client_config');
      const matched = [];
      const unmatched = [];

      for (const org of orgs) {
        const byTenantId = clients.find((c) => c.xero_tenant_id === org.tenantId);
        const byName = clients.find((c) => c.client_name === org.tenantName);
        const match = byTenantId || byName;
        if (match) {
          await tokenManager.linkClientToConnection(match.id, connectionId, org.tenantId);
          matched.push(`${match.client_name} → ${org.tenantName}`);
        } else {
          unmatched.push(org.tenantName);
        }
      }

      const html = `
        <h2>Practice connection created.</h2>
        <p><strong>Matched (${matched.length}):</strong></p>
        <ul>${matched.map((m) => `<li>${m}</li>`).join('') || '<li>None</li>'}</ul>
        <p><strong>Unmatched orgs (${unmatched.length}) — no client_config row found for these:</strong></p>
        <ul>${unmatched.map((m) => `<li>${m}</li>`).join('') || '<li>None</li>'}</ul>
        <p>Unmatched orgs need a client_config row created (matching client_name or xero_tenant_id) then re-run this connect flow, or link manually.</p>
      `;
      return res.send(html);
    }

    if (parsedState.mode === 'self_serve') {
      if (orgs.length > 1) {
        const selectionId = crypto.randomBytes(32).toString('hex');
        await pool.query(
          `INSERT INTO pending_connections (selection_id, encrypted_access_token, encrypted_refresh_token, expires_in, return_app)
           VALUES ($1, $2, $3, $4, $5)`,
          [selectionId, encrypt(tokenResponse.access_token), encrypt(tokenResponse.refresh_token), tokenResponse.expires_in, parsedState.returnApp]
        );

        const { rows: existingClients } = await pool.query('SELECT xero_tenant_id FROM client_config');
        const connectedTenantIds = new Set(existingClients.map((c) => c.xero_tenant_id));

        const optionsHtml = orgs.map((org) => `
          <form method="POST" action="/oauth/select-org" style="margin-bottom: 10px;">
            <input type="hidden" name="selectionId" value="${selectionId}" />
            <input type="hidden" name="tenant_id" value="${org.tenantId}" />
            <button type="submit">${org.tenantName} ${connectedTenantIds.has(org.tenantId) ? '(already connected)' : '(new)'}</button>
          </form>
        `).join('');

        return res.send(`<h2>Choose your organisation</h2>${optionsHtml}`);
      }

      const tenantId = orgs[0].tenantId;
      const tenantName = orgs[0].tenantName;

      const existing = await pool.query(
        'SELECT client_id, connection_id FROM oauth_tokens WHERE xero_tenant_id = $1',
        [tenantId]
      );

      let clientId;

      if (existing.rows.length > 0) {
        clientId = existing.rows[0].client_id;
        await tokenManager.saveRefreshedTokens(existing.rows[0].connection_id, tokenResponse);
      } else {
        try {
          const c = await pool.query(
            "INSERT INTO client_config (client_name, xero_tenant_id, super_payment_mode) VALUES ($1, $2, 'payday') RETURNING id",
            [tenantName, tenantId]
          );
          clientId = c.rows[0].id;
          const connectionId = await tokenManager.createConnection(tokenResponse, 'self_serve', tenantName);
          await tokenManager.linkClientToConnection(clientId, connectionId, tenantId);
        } catch (e) {
          if (e.code === '23505') {
            const retry = await pool.query(
              'SELECT client_id, connection_id FROM oauth_tokens WHERE xero_tenant_id = $1',
              [tenantId]
            );
            clientId = retry.rows[0].client_id;
            await tokenManager.saveRefreshedTokens(retry.rows[0].connection_id, tokenResponse);
          } else {
            throw e;
          }
        }
      }

      const { rows: configRows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
      const complete = isConfigComplete(configRows[0]);

      const sessionToken = await createSession(clientId);
      res.cookie('rg_token', sessionToken, {
        domain: '.fasttrackledger.com',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      const destination = resolveDestination(parsedState.returnApp, complete);
      return res.redirect(`${destination}?token=${sessionToken}`);
    }

    res.status(400).send('Unknown OAuth mode in state.');
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send(`Connection failed: ${e.message}`);
  }
});

// ── Multi-org picker: user's chosen tenant lands here ──────────────────────
app.post('/oauth/select-org', async (req, res) => {
  const { selectionId, tenant_id: tenantId } = req.body;
  if (!selectionId || !tenantId) return res.status(400).send('Missing selection.');

  try {
    const { rows } = await pool.query(
      `SELECT * FROM pending_connections WHERE selection_id = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
      [selectionId]
    );
    if (!rows.length) return res.status(400).send('This selection has expired. Please reconnect to Xero.');

    await pool.query('DELETE FROM pending_connections WHERE selection_id = $1', [selectionId]);

    const pending = rows[0];
    const accessToken = decrypt(pending.encrypted_access_token);
    const refreshToken = decrypt(pending.encrypted_refresh_token);
    const tokenResponse = { access_token: accessToken, refresh_token: refreshToken, expires_in: pending.expires_in };
    const returnApp = pending.return_app;

    const freshOrgs = await xero.fetchConnections(accessToken);
    const chosenOrg = freshOrgs.find((o) => o.tenantId === tenantId);
    if (!chosenOrg) return res.status(400).send('Selected organisation is not authorized for this connection.');

    const tenantName = chosenOrg.tenantName;

    const existing = await pool.query(
      'SELECT client_id, connection_id FROM oauth_tokens WHERE xero_tenant_id = $1',
      [tenantId]
    );

    let clientId;

    if (existing.rows.length > 0) {
      clientId = existing.rows[0].client_id;
      await tokenManager.saveRefreshedTokens(existing.rows[0].connection_id, tokenResponse);
    } else {
      try {
        const c = await pool.query(
          "INSERT INTO client_config (client_name, xero_tenant_id, super_payment_mode) VALUES ($1, $2, 'payday') RETURNING id",
          [tenantName, tenantId]
        );
        clientId = c.rows[0].id;
        const connectionId = await tokenManager.createConnection(tokenResponse, 'self_serve', tenantName);
        await tokenManager.linkClientToConnection(clientId, connectionId, tenantId);
      } catch (e) {
        if (e.code === '23505') {
          const retry = await pool.query(
            'SELECT client_id, connection_id FROM oauth_tokens WHERE xero_tenant_id = $1',
            [tenantId]
          );
          clientId = retry.rows[0].client_id;
          await tokenManager.saveRefreshedTokens(retry.rows[0].connection_id, tokenResponse);
        } else {
          throw e;
        }
      }
    }

    const { rows: configRows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
    const complete = isConfigComplete(configRows[0]);

    const sessionToken = await createSession(clientId);
    res.cookie('rg_token', sessionToken, {
      domain: '.fasttrackledger.com',
      secure: true,
      httpOnly: false,
      sameSite: 'Lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    const destination = resolveDestination(returnApp, complete);
    return res.redirect(`${destination}?token=${sessionToken}`);
  } catch (e) {
    console.error('Select-org error:', e);
    res.status(500).send(`Connection failed: ${e.message}`);
  }
});

// ── Self-serve session check — Appsmith's onPageLoad calls this ───────────
app.get('/session/whoami', resolveSession, async (req, res) => {
  const connResult = await pool.query(
    `SELECT c.access_token, c.refresh_token
     FROM oauth_tokens ot
     JOIN connections c ON c.id = ot.connection_id
     WHERE ot.client_id = $1`,
    [req.client_id]
  );

  const conn = connResult.rows[0];
  const reconnectRequired = !conn || conn.access_token === null || conn.refresh_token === null;

  res.json({
    client_id: req.client_id,
    status: reconnectRequired ? 'RECONNECT_REQUIRED' : 'active'
  });
});

// ── Self-serve report trigger — checks completeness, then forwards to n8n ──
app.post('/trigger/nightly-report/:clientId', async (req, res) => {
  const { clientId } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!isConfigComplete(rows[0])) {
      return res.status(400).json({ error: 'Client not fully configured. Complete the Setup Wizard first.' });
    }

    const n8nRes = await fetch(N8N_NIGHTLY_REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': N8N_API_KEY },
      body: JSON.stringify({ client_id: clientId }),
    });
    const body = await n8nRes.text();
    res.status(n8nRes.status).type('application/json').send(body);
  } catch (e) {
    console.error('Trigger nightly report error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Self-serve Auto Statements trigger — BullMQ, replaces old n8n forwarder ─
app.post('/trigger/auto-statements/:clientId', resolveSession, async (req, res) => {
  const { clientId } = req.params;
  const { contactIds } = req.body;

  if (String(req.client_id) !== String(clientId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ error: 'No contacts selected' });
  }

  try {
    const job = await autoStatementsQueue.add('send-statements', { clientId, contactIds });
    return res.json({ success: true, jobId: job.id, message: `Queued statements for ${contactIds.length} contact(s).` });
  } catch (e) {
    console.error('Trigger auto-statements error:', e);
    return res.status(500).json({ error: 'Failed to queue statements job' });
  }
});

// ── Generic Xero API proxy ──────────────────────────────────────────────
app.all('/proxy/xero/:clientId/*', async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  const { clientId } = req.params;
  const xeroPath = req.params[0];
  const queryString = req.url.split('?')[1] || '';

  try {
    const { accessToken, tenantId } = await tokenManager.getValidToken(clientId);

    const xeroUrl = `https://api.xero.com/${xeroPath}${queryString ? '?' + queryString : ''}`;

    const xeroRes = await fetch(xeroUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });

    ['X-DayLimit-Remaining', 'X-MinLimit-Remaining', 'X-AppMinLimit-Remaining', 'Retry-After'].forEach((h) => {
      const val = xeroRes.headers.get(h);
      if (val) res.set(h, val);
    });

    const body = await xeroRes.text();
    console.log(`[${correlationId}] ${req.method} ${xeroPath} client=${clientId} -> ${xeroRes.status}`);

    res.status(xeroRes.status).type('application/json').send(body);
  } catch (e) {
    console.error(`[${correlationId}] Proxy error client=${clientId}:`, e.message);
    if (e.code === 'NOT_CONNECTED') return res.status(409).json({ error: e.message, code: e.code });
    if (e.code === 'RECONNECT_REQUIRED') return res.status(401).json({ error: e.message, code: e.code });
    res.status(502).json({ error: e.message, code: e.code || 'PROXY_ERROR' });
  }
});

// ── Self-serve Auto Statements customer list ──────────────────────────────
app.get('/clients/:clientId/statements/customers', resolveSession, async (req, res) => {
  const { clientId } = req.params;

  if (String(req.client_id) !== String(clientId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { accessToken, tenantId } = await tokenManager.getValidToken(clientId);

    const invoicesRes = await fetch(
      'https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED&summaryOnly=false',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Xero-tenant-id': tenantId,
          Accept: 'application/json',
        },
      }
    );
    const invoicesData = await invoicesRes.json();
    if (!invoicesRes.ok) {
      return res.status(502).json({ error: 'Xero request failed', detail: invoicesData });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    function parseXeroDate(dateVal) {
      if (!dateVal) return null;
      if (typeof dateVal === 'string' && dateVal.startsWith('/Date(')) {
        const ms = parseInt(dateVal.replace('/Date(', '').replace(/[^0-9]/g, ''));
        return new Date(ms);
      }
      const d = new Date(dateVal);
      return isNaN(d.getTime()) ? null : d;
    }

    function daysDiff(date) {
      if (!date) return 0;
      return Math.floor((today - date) / (1000 * 60 * 60 * 24));
    }

    const allInvoices = invoicesData.Invoices || [];
    const buckets = {};

    for (const inv of allInvoices) {
      if (inv.Type !== 'ACCREC') continue;

      const contact = inv.Contact || {};
      const contactId = contact.ContactID;
      if (!contactId) continue;

      const amountDue = parseFloat(inv.AmountDue) || 0;
      if (amountDue <= 0) continue;

      if (inv.CurrencyCode && inv.CurrencyCode !== 'AUD') continue;

      if (!buckets[contactId]) {
        buckets[contactId] = {
          contactId,
          contactName: contact.Name || contactId,
          hasEmail: false,
          theyOwe: 0,
          overdueAmount: 0,
          daysOverdue: 0,
        };
      }

      const bucket = buckets[contactId];
      const dueDate = parseXeroDate(inv.DueDateString || inv.DueDate);
      const daysOverdueForInvoice = dueDate ? Math.max(0, daysDiff(dueDate)) : 0;

      bucket.theyOwe += amountDue;
      if (daysOverdueForInvoice > 0) {
        bucket.overdueAmount += amountDue;
      }
      if (daysOverdueForInvoice > bucket.daysOverdue) {
        bucket.daysOverdue = daysOverdueForInvoice;
      }
    }

    const contactIds = Object.keys(buckets);

    await Promise.all(
      contactIds.map(async (contactId) => {
        try {
          const contactRes = await fetch(
            `https://api.xero.com/api.xro/2.0/Contacts/${contactId}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Xero-tenant-id': tenantId,
                Accept: 'application/json',
              },
            }
          );
          const contactData = await contactRes.json();
          const xeroContact = (contactData.Contacts || [])[0] || {};
          const email = (xeroContact.EmailAddress || '').trim();
          buckets[contactId].hasEmail = email.length > 0;
        } catch (e) {
          buckets[contactId].hasEmail = false;
        }
      })
    );

    const customers = Object.values(buckets).map((b) => ({
      ...b,
      theyOwe: parseFloat(b.theyOwe.toFixed(2)),
      overdueAmount: parseFloat(b.overdueAmount.toFixed(2)),
    }));

    res.json({ customers });
  } catch (e) {
    console.error('Statements customers error:', e);
    if (e.code === 'NOT_CONNECTED') return res.status(409).json({ error: e.message, code: e.code });
    if (e.code === 'RECONNECT_REQUIRED') return res.status(401).json({ error: e.message, code: e.code });
    res.status(502).json({ error: e.message, code: e.code || 'GATEWAY_ERROR' });
  }
});

// ── Xero disconnect webhook ─────────────────────────────────────────────
app.post('/webhooks/xero', express.raw({ type: '*/*' }), async (req, res) => {
  console.log('Received Xero webhook (signature validation not yet implemented)');
  res.sendStatus(200);
});

startSessionCleanupJob();
registerAllRepeatableJobs(schedulerQueue).catch((e) =>
  console.error('[Scheduler] Failed to register repeatable jobs at boot:', e.message)
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Gateway listening on port ${PORT}`));

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const axios = require('axios');
const { Queue } = require('bullmq');
const pool = require('./db');
const xero = require('./xero');
const tokenManager = require('./tokenManager');
const { encrypt, decrypt } = require('./crypto');
const { isConfigComplete } = require('./config');
const { createSession, resolveSession, startSessionCleanupJob } = require('./session');
const { registerAllRepeatableJobs, registerRepeatableJob } = require('./scheduler');
const Redis = require('ioredis');
const config = require('./config');
const { getTenantTodayDateString, getOrFetchBaseCurrency } = require('./xero');
const autoStatementsQueue = require('./autoStatementsQueue');

const redis = new Redis(config.redisConnectionString);
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
const FASTLEDGER_URL = process.env.FASTLEDGER_URL;

// Dedicated queue for the daily per-client schedule check
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

// ── Practice: one bookkeeper authorizes access to MANY orgs ─
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
    try { mode = decodeState(state).mode; } catch (_) { /* fall through */ }
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
        <p>Unmatched orgs need a client_config row created then re-run this connect flow, or link manually.</p>
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

// ── GET Dashboard Route (Multi-currency Bucket Formatting & Batching) ─────
app.get('/statements/customers/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const token = await tokenManager.getValidXeroToken(clientId);
        const { rows: configRows } = await pool.query('SELECT xero_tenant_id FROM client_config WHERE id = $1', [clientId]);
        const tenantId = configRows[0].xero_tenant_id;

        // Fetch invoices
        const invoicesRes = await axios.get('https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED&Type=ACCREC', {
            headers: { 'Authorization': `Bearer ${token}`, 'xero-tenant-id': tenantId, 'Accept': 'application/json' }
        });

        const buckets = {};
        for (const inv of invoicesRes.data.Invoices) {
            // Skip amountDue <= 0
            if (inv.AmountDue <= 0) continue; 
            
            // Bucket by contactId_invoiceCurrency
            const contactId = inv.Contact.ContactID;
            const currency = inv.CurrencyCode;
            const bucketKey = config.BUCKET_KEY_FORMAT(contactId, currency);
            
            if (!buckets[bucketKey]) {
                buckets[bucketKey] = { bucketKey, contactId, contactName: inv.Contact.Name, currency, totalDue: 0, invoices: [] };
            }
            buckets[bucketKey].totalDue += inv.AmountDue;
            buckets[bucketKey].invoices.push(inv);
        }

        // Batch Xero contact fetch (max 30) preserving hasEmail
        const contactIds = [...new Set(Object.values(buckets).map(b => b.contactId))];
        const contactEmailMap = {};
        
        for (let i = 0; i < contactIds.length; i += 30) {
            const batch = contactIds.slice(i, i + 30);
            const contactsRes = await axios.get(`https://api.xero.com/api.xro/2.0/Contacts?IDs=${batch.join(',')}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'xero-tenant-id': tenantId, 'Accept': 'application/json' }
            });
            for (const contact of contactsRes.data.Contacts) {
                contactEmailMap[contact.ContactID] = !!contact.EmailAddress;
            }
        }

        // Compute lastSent via SELECT DISTINCT ON (bucket_key)
        const { rows: logs } = await pool.query(`
            SELECT DISTINCT ON (bucket_key) bucket_key, status, created_at 
            FROM statement_logs 
            WHERE client_id = $1 
            ORDER BY bucket_key, created_at DESC
        `, [clientId]);

        const logMap = logs.reduce((acc, log) => { acc[log.bucket_key] = log; return acc; }, {});

        const results = Object.values(buckets).map(b => ({
            ...b,
            hasEmail: contactEmailMap[b.contactId] || false,
            lastSent: logMap[b.bucketKey] ? logMap[b.bucketKey].created_at : null,
            status: logMap[b.bucketKey] ? logMap[b.bucketKey].status : null
        }));

        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── POST Trigger Route (Multi-currency bucketKeys, Redis mget & Idempotency) ──
app.post('/trigger/auto-statements/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const { bucketKeys } = req.body; 
        
        if (!Array.isArray(bucketKeys) || bucketKeys.length === 0) {
            return res.status(400).json({ error: 'bucketKeys array is required' });
        }

        // Dedupe
        const uniqueBucketKeys = [...new Set(bucketKeys)];
        
        // Compute base_currency and todayDateString once
        const baseCurrency = await getOrFetchBaseCurrency(clientId);
        const todayDateString = getTenantTodayDateString();

        // Execute batch Redis mget() for idempotency
        const mgetKeys = uniqueBucketKeys.map(bk => `sent-statement:${clientId}:${bk}:${todayDateString}`);
        const existingLocks = await redis.mget(mgetKeys);

        const keysToProcess = uniqueBucketKeys.filter((_, idx) => !existingLocks[idx]);

        if (keysToProcess.length === 0) {
            return res.status(202).json({ message: 'All requested statements are already processing or sent today' });
        }

        const jobsToAdd = [];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const bucketKey of keysToProcess) {
                const [contactId, currencyCode] = bucketKey.split('_');
                
                // Bulk-insert PROCESSING rows returning log_id per row
                const { rows } = await client.query(`
                    INSERT INTO statement_logs 
                    (client_id, contact_id, bucket_key, currency_code, trigger_type, status) 
                    VALUES ($1, $2, $3, $4, 'MANUAL', 'PROCESSING') 
                    RETURNING id
                `, [clientId, contactId, bucketKey, currencyCode]);
                
                const logId = rows[0].id;
                
                // Payload strictly includes logId
                jobsToAdd.push({
                    name: `statement_${bucketKey}`,
                    data: { clientId, bucketKey, logId, triggerType: 'MANUAL' },
                    opts: { jobId: `manual_${logId}_${bucketKey}` }
                });
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        // Await addBulk() before 202 Accepted
        if (jobsToAdd.length > 0) {
            await autoStatementsQueue.addBulk(jobsToAdd);
        }

        res.status(202).json({ message: 'Statements queued successfully', count: jobsToAdd.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── GET /statement-logs (Sent Items bounded query) ────────────────────────
app.get('/statement-logs/:clientId', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id, trigger_type, recipient_name, recipient_email, status, error_reason, error_message, created_at 
            FROM statement_logs 
            WHERE client_id = $1 
              AND created_at >= NOW() - INTERVAL '90 days' 
            ORDER BY created_at DESC 
            LIMIT 500
        `, [req.params.clientId]);
        
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
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

app.post('/clients/:clientId/register-schedule', resolveSession, async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const { rows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
    const clientConfig = rows[0];
    if (!clientConfig) {
      return res.status(404).json({ error: 'Client not found' });
    }
    await registerRepeatableJob(schedulerQueue, clientConfig);
    return res.json({ success: true, message: `Schedule registered for client ${clientId}` });
  } catch (e) {
    console.error('[register-schedule] Failed:', e.message);
    return res.status(500).json({ error: 'Failed to register schedule' });
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

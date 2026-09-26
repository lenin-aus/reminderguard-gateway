require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const pool = require('./db');
const xero = require('./xero');
const tokenManager = require('./tokenManager');
const { encrypt, decrypt } = require('./crypto');
const { isConfigComplete } = require('./config');
const { createSession, resolveSession, startSessionCleanupJob } = require('./session');
const { registerHeartbeat } = require('./scheduler');
const { getOrFetchBaseCurrency, getTenantTodayDateString } = require('./shared');
const { validateScheduleConfig, toApiConfig, READ_KEYS } = require('./scheduleConfig');
const { getXeroContext, getXeroTenantId, CALLS_PER_STATEMENT } = require('./xeroContext');
const { getXeroData } = require('./xeroData');
const { validateStatementOptions, statementOptionsHash, statementLockKey, StatementOptionsError } = require('./statementOptions');
const { todayInTimezone } = require('./statementRange');
const { buildCustomerBuckets } = require('./customerBuckets');
const { lastSentLabel } = require('./lastSent');
const { requestLog } = require('./requestLog');
const { startFlow, redeemConnectTicket } = require('./oauthFlow');

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

// Plain Redis connection for direct commands (GET/SET/MGET on the
// sent-statement:... idempotency keys). BullMQ's Queue instances don't
// reliably expose a ready-to-use client for this, so this is separate from
// autoStatementsQueue/schedulerQueue above.
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD
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

// If this client_id's stored xero_tenant_id differs from the tenant they just
// reconnected to, null out base_currency so getOrFetchBaseCurrency() re-fetches
// fresh instead of silently keeping the previous org's currency.
async function nullBaseCurrencyIfTenantChanged(clientId, newTenantId) {
  const { rows } = await pool.query(
    'SELECT xero_tenant_id FROM client_config WHERE id = $1',
    [clientId]
  );
  const storedTenantId = rows[0]?.xero_tenant_id;
  if (storedTenantId && storedTenantId !== newTenantId) {
    await pool.query('UPDATE client_config SET base_currency = NULL WHERE id = $1', [clientId]);
  }
}

// bucketKey format contract: ${contactId}_${currencyCode}, currency always
// exactly 3 uppercase chars. Constructed here in the GET route below and
// deconstructed via BUCKET_KEY_REGEX in the POST trigger route further down —
// if this format ever changes, both sites must be updated together.
const BUCKET_KEY_REGEX = /^(.+)_([A-Za-z]{3})$/;

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Self-serve: public "Connect to Xero" entry point ───────────────────────
app.get('/oauth/connect', async (req, res) => {
  const returnApp = req.query.returnApp === 'fastledger' ? 'fastledger' : 'reminderguard';
  const cookieOptions = { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 10 * 60 * 1000 };

  // The self-serve app (returnApp=reminderguard) keeps the original flow, unchanged.
  if (returnApp !== 'fastledger') {
    const nonce = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', nonce, cookieOptions);
    return res.redirect(xero.buildAuthUrl(encodeState({ mode: 'self_serve', nonce, returnApp })));
  }

  // fastledger asks Xero who is signing in (the id_token) as well as for access. "Connect another
  // org" (intent=add) starts from a one-time ticket the signed-in app asked for, which binds the
  // round trip to that account without putting the session token in a URL.
  try {
    const intent = req.query.intent === 'add' ? 'add' : 'signin';
    let accountId = null;
    if (intent === 'add') {
      accountId = await redeemConnectTicket(redis, String(req.query.ticket || ''));
      if (accountId === null) {
        return res.status(400).send('This link has expired. Go back to FastLedger and choose "Connect another org" again.');
      }
    }
    const { nonce, oidcNonce } = await startFlow(redis, { intent, accountId, returnApp });
    res.cookie('oauth_state', nonce, cookieOptions);
    res.redirect(xero.buildAuthUrl(encodeState({ mode: 'self_serve', nonce, returnApp, intent }), { identity: true, nonce: oidcNonce }));
  } catch (e) {
    console.error('OAuth connect error:', e);
    res.status(500).send('Could not start the Xero connection. Please try again.');
  }
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
        await nullBaseCurrencyIfTenantChanged(clientId, tenantId);
      } else {
        try {
          const c = await pool.query(
            "INSERT INTO client_config (client_name, xero_tenant_id, super_payment_mode, sender_email, sender_name) VALUES ($1, $2, 'payday', $3, $4) RETURNING id",
            [tenantName, tenantId, process.env.DEFAULT_SENDER_EMAIL || null, process.env.DEFAULT_SENDER_NAME || null]
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
            await nullBaseCurrencyIfTenantChanged(clientId, tenantId);
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
      await nullBaseCurrencyIfTenantChanged(clientId, tenantId);
    } else {
      try {
        const c = await pool.query(
          "INSERT INTO client_config (client_name, xero_tenant_id, super_payment_mode, sender_email, sender_name) VALUES ($1, $2, 'payday', $3, $4) RETURNING id",
          [tenantName, tenantId, process.env.DEFAULT_SENDER_EMAIL || null, process.env.DEFAULT_SENDER_NAME || null]
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
          await nullBaseCurrencyIfTenantChanged(clientId, tenantId);
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
app.post('/trigger/auto-statements/:clientId', requestLog('trigger'), resolveSession, async (req, res) => {
  const { clientId } = req.params;
  const { bucketKeys } = req.body;

  if (String(req.client_id) !== String(clientId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!Array.isArray(bucketKeys) || bucketKeys.length === 0) {
    return res.status(400).json({ error: "Invalid payload. 'bucketKeys' array is required." });
  }

  const uniqueBucketKeys = [...new Set(bucketKeys)];

  const parsed = [];
  for (const bucketKey of uniqueBucketKeys) {
    const match = bucketKey.match(BUCKET_KEY_REGEX);
    if (!match) {
      return res.status(400).json({ error: `Invalid bucketKey format: ${bucketKey}` });
    }
    const [, contactId, currencyCode] = match;
    parsed.push({ bucketKey, contactId, currencyCode: currencyCode.toUpperCase() });
  }

  try {
    // Per-send options from the send modal (date range, reply-to, BCC, subject, body). They apply to
    // this send only and travel on the job; nothing is saved as a client default.
    const { rows: tzRows } = await pool.query('SELECT schedule_timezone FROM client_config WHERE id = $1', [clientId]);
    const timezone = tzRows[0]?.schedule_timezone || 'Australia/Melbourne';
    let options;
    try {
      options = validateStatementOptions(req.body.options, { timezone });
    } catch (e) {
      if (e instanceof StatementOptionsError) {
        return res.status(400).json({ error: e.message, code: e.code, fields: e.fields });
      }
      throw e;
    }
    const optionsHash = statementOptionsHash(options);

    const baseCurrency = await getOrFetchBaseCurrency(clientId);
    const todayDateString = getTenantTodayDateString(timezone);

    // Batch idempotency pre-check (optimization only — the worker's atomic
    // SET NX lock is the actual duplicate-prevention mechanism). The key includes a hash of the
    // options, so an identical resend is blocked but a corrected one goes out.
    const redisKeys = parsed.map((p) => statementLockKey(clientId, p.bucketKey, todayDateString, optionsHash));
    const sentFlags = redisKeys.length > 0 ? await redis.mget(redisKeys) : [];

    const toEnqueue = parsed.filter((_, i) => !sentFlags[i]);
    if (toEnqueue.length === 0) {
      return res.status(202).json({ success: true, queuedCount: 0, message: 'All selected statements already sent today.' });
    }

    // Xero's daily call limit is per organisation. Refuse the whole batch up front, with a clear
    // reason, if the statements already queued plus this batch need more calls than are left today.
    const xeroData = getXeroData();
    const tenantId = await getXeroTenantId(clientId);
    const estimatedCalls = toEnqueue.length * CALLS_PER_STATEMENT;
    if (tenantId) {
      try {
        await xeroData.assertBudget({ tenantId }, estimatedCalls);
      } catch (e) {
        if (e.code === 'XERO_DAILY_LIMIT') return res.status(429).json({ error: e.message, code: e.code });
        throw e;
      }
    }

    // Bulk-insert PROCESSING rows now, not left to the worker at execution
    // start — closes the gap where a queued-but-not-yet-picked-up job would
    // show no row at all while waiting on the limiter/concurrency caps.
    const insertValues = [];
    const insertParams = [];
    let paramIndex = 1;
    for (const p of toEnqueue) {
      insertValues.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, 'PROCESSING')`);
      insertParams.push(clientId, p.contactId, p.bucketKey, p.currencyCode, 'manual');
    }
    const { rows: insertedLogs } = await pool.query(
      `INSERT INTO statement_logs (client_id, contact_id, bucket_key, currency_code, trigger_type, status)
       VALUES ${insertValues.join(', ')}
       RETURNING id, bucket_key`,
      insertParams
    );
    const logIdByBucketKey = {};
    for (const row of insertedLogs) {
      logIdByBucketKey[row.bucket_key] = row.id;
    }

    const minuteWindow = Math.floor(Date.now() / 60000);
    const jobs = toEnqueue.map((p) => ({
      name: 'send-statements',
      data: {
        clientId,
        bucketKey: p.bucketKey,
        currencyCode: p.currencyCode,
        contactId: p.contactId,
        baseCurrency,
        todayDateString,
        logId: logIdByBucketKey[p.bucketKey],
        options,
        optionsHash,
        estimatedCalls: CALLS_PER_STATEMENT,
      },
      opts: {
        jobId: `send-manual-${clientId}-${p.bucketKey}-${todayDateString}-${optionsHash}-${minuteWindow}`,
       backoff: { type: 'custom' },
        attempts: 5,
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 604800, count: 500 },
      },
    }));

    // Reserve the calls before queueing so a job that finishes at once cannot give back budget
    // that was not added yet; undo the reservation if queueing fails.
    if (tenantId) await xeroData.addPending(tenantId, estimatedCalls);
    try {
      await autoStatementsQueue.addBulk(jobs);
    } catch (queueErr) {
      if (tenantId) await xeroData.takePending(tenantId, estimatedCalls).catch(() => {});
      throw queueErr;
    }

    return res.status(202).json({
      success: true,
      queuedCount: toEnqueue.length,
      message: `Queued statements for ${toEnqueue.length} recipient(s).`,
    });
  } catch (e) {
    console.error('Trigger auto-statements error:', e);
    return res.status(500).json({ error: 'Failed to queue statements job' });
  }
});

// ── Generic Xero API proxy ──────────────────────────────────────────────
// Requires a session and only serves the session's own client, like every other
// /clients/:clientId route. Without this, anyone who could guess a client id could
// read (and, with POST/PUT/DELETE, modify) that client's Xero organisation.
app.all('/proxy/xero/:clientId/*', resolveSession, async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  const { clientId } = req.params;
  if (String(req.client_id) !== String(clientId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const xeroPath = req.params[0];
  let queryString = req.url.split('?')[1] || '';
  if (req.query.token !== undefined) {
    // resolveSession also accepts ?token=; never forward the session token to Xero.
    const forwarded = new URLSearchParams(queryString);
    forwarded.delete('token');
    queryString = forwarded.toString();
  }

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

// The Xero side of the customer list: open invoices, remaining credits, and which contacts have
// an email. Cached in Redis so post-send polling never calls Xero; a fresh load refreshes it.
const CUSTOMER_CACHE_TTL_S = 10 * 60;
async function loadCustomerSource(clientId, { useCache }) {
  const cacheKey = `xero:cache:customers:${clientId}`;
  if (useCache) {
    const hit = await redis.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }
  const data = getXeroData();
  const ctx = await getXeroContext(clientId);
  const [invoices, credits] = await Promise.all([data.listOpenInvoices(ctx), data.listOpenCredits(ctx)]);
  const contactIds = [...new Set(invoices.map((i) => i.contactId).filter(Boolean))];
  const emailByContactId = {};
  for (const contact of await data.getContactsByIds(ctx, contactIds)) {
    emailByContactId[contact.id] = contact.email.length > 0;
  }
  const source = { invoices, credits, emailByContactId };
  await redis.set(cacheKey, JSON.stringify(source), 'EX', CUSTOMER_CACHE_TTL_S).catch(() => {});
  return source;
}

// ── Self-serve Auto Statements customer list ──────────────────────────────
app.get('/clients/:clientId/statements/customers', resolveSession, async (req, res) => {
  const { clientId } = req.params;

  if (String(req.client_id) !== String(clientId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const baseCurrency = await getOrFetchBaseCurrency(clientId);
    const { rows: tzRows } = await pool.query('SELECT schedule_timezone FROM client_config WHERE id = $1', [clientId]);
    const timezone = tzRows[0]?.schedule_timezone || 'Australia/Melbourne';

    // A normal load reads Xero fresh. The post-send polling passes ?poll=1: it only wants each
    // row's live lastSent (read from the database below), so it may reuse the Xero data from
    // the last fresh load and costs no Xero calls.
    const source = await loadCustomerSource(clientId, { useCache: req.query.poll === '1' });

    const buckets = {};
    for (const customer of buildCustomerBuckets({
      invoices: source.invoices,
      credits: source.credits,
      emailByContactId: source.emailByContactId,
      today: todayInTimezone(timezone),
      baseCurrency,
    })) {
      buckets[customer.bucketKey] = customer;
    }

    // Compute "Last sent" per bucketKey from the latest statement_logs row.
    const bucketKeys = Object.keys(buckets);
    const lastSentByBucketKey = {};
    if (bucketKeys.length > 0) {
      const { rows: logRows } = await pool.query(
        `SELECT DISTINCT ON (bucket_key) bucket_key, status, error_reason, created_at
         FROM statement_logs
         WHERE client_id = $1 AND bucket_key = ANY($2)
         ORDER BY bucket_key, created_at DESC`,
        [clientId, bucketKeys]
      );

      const nowMs = Date.now();
      for (const row of logRows) {
        lastSentByBucketKey[row.bucket_key] = lastSentLabel(row, { nowMs, timeZone: timezone });
      }
    }

    const customers = Object.values(buckets).map((b) => ({
      ...b,
      lastSent: lastSentByBucketKey[b.bucketKey] || 'Never',
    }));

    res.json({ customers });
  } catch (e) {
    console.error('Statements customers error:', e);
    if (e.code === 'XERO_DAILY_LIMIT') return res.status(429).json({ error: e.message, code: e.code });
    if (e.code === 'NOT_CONNECTED') return res.status(409).json({ error: e.message, code: e.code });
    if (e.code === 'RECONNECT_REQUIRED') return res.status(401).json({ error: e.message, code: e.code });
    res.status(502).json({ error: e.message, code: e.code || 'GATEWAY_ERROR' });
  }
});

// ── Sent Items page — bounded audit log ────────────────────────────────────
app.get('/clients/:clientId/statement-logs', resolveSession, async (req, res) => {
  const { clientId } = req.params;

  if (String(req.client_id) !== String(clientId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, trigger_type, recipient_name, recipient_email, status, error_reason, error_message, created_at
       FROM statement_logs
       WHERE client_id = $1
         AND created_at >= NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC
       LIMIT 500`,
      [clientId]
    );
    res.json({ logs: rows });
  } catch (e) {
    console.error('Statement logs error:', e);
    res.status(500).json({ error: e.message });
  }
});



// ── Auto-statement schedule settings ───────────────────────────────────────
// Only the whitelisted schedule columns are readable or writable here. The client id always
// comes from the session (req.client_id), never from the request body.
const CONFIG_COLUMNS = READ_KEYS.join(', ');

// Read-only extras the send modal shows: who statements are sent as, and the company name used
// by {{your_company_name}}. They are not part of the writable config (a PUT containing them is a 400).
function withSender(apiConfig, row) {
  return {
    ...apiConfig,
    client_name: row.client_name ?? null,
    sender_name: row.sender_name ?? null,
    sender_email: row.sender_email ?? null,
  };
}

app.get('/clients/:clientId/config', resolveSession, async (req, res) => {
  if (String(req.client_id) !== String(req.params.clientId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT ${CONFIG_COLUMNS}, next_run_at, client_name, sender_email, sender_name FROM client_config WHERE id = $1`,
      [req.client_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json(withSender(toApiConfig(rows[0]), rows[0]));
  } catch (e) {
    console.error('Get client config error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/clients/:clientId/config', resolveSession, async (req, res) => {
  if (String(req.client_id) !== String(req.params.clientId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const result = validateScheduleConfig(req.body);
  if (!result.ok) {
    return res.status(400).json({
      error: 'Invalid schedule settings',
      code: 'VALIDATION_FAILED',
      fields: result.fields,
    });
  }
  const c = result.value;

  try {
    // next_run_at is cleared (so the heartbeat backfills it) only when a schedule field
    // changed. In an UPDATE, the right-hand sides see the row's old values, so the comparison
    // and the write are one atomic statement. Saving only recipient changes keeps the cadence.
    const { rows } = await pool.query(
      `UPDATE client_config SET
         auto_statements_enabled = $1,
         schedule_unit = $2,
         schedule_interval = $3,
         schedule_day = $4,
         schedule_ordinal = $5,
         schedule_time = $6,
         schedule_timezone = $7,
         statement_period_end_rule = $8,
         recipient_list = $9,
         recipient_filter = $10,
         recipient_target = $11,
         next_run_at = CASE
           WHEN (auto_statements_enabled, schedule_unit, schedule_interval, schedule_day,
                 schedule_ordinal, schedule_time, schedule_timezone)
                IS DISTINCT FROM
                ($1::boolean, $2::text, $3::integer, $4::text, $5::text, $6::text, $7::text)
           THEN NULL
           ELSE next_run_at
         END
       WHERE id = $12
       RETURNING ${CONFIG_COLUMNS}, next_run_at, client_name, sender_email, sender_name`,
      [
        c.auto_statements_enabled,
        c.schedule_unit,
        c.schedule_interval,
        c.schedule_day,
        c.schedule_ordinal,
        c.schedule_time,
        c.schedule_timezone,
        c.statement_period_end_rule,
        c.recipient_list,
        c.recipient_filter,
        c.recipient_target,
        req.client_id,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json(withSender(toApiConfig(rows[0]), rows[0]));
  } catch (e) {
    console.error('Update client config error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Xero disconnect webhook ─────────────────────────────────────────────
app.post('/webhooks/xero', express.raw({ type: '*/*' }), async (req, res) => {
  console.log('Received Xero webhook (signature validation not yet implemented)');
  res.sendStatus(200);
});

startSessionCleanupJob();
registerHeartbeat(schedulerQueue).catch((e) =>
  console.error('[Heartbeat] Failed to register heartbeat job at boot:', e.message)
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Gateway listening on port ${PORT}`));

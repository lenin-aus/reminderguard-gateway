require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const pool = require('./db');
const xero = require('./xero');
const tokenManager = require('./tokenManager');
const { isConfigComplete } = require('./config');
const { createSession, resolveSession, startSessionCleanupJob } = require('./session');

const app = express();
app.use(express.json());
app.use(cookieParser());

// Self-serve Appsmith app + n8n trigger target — all resolved via env, not hardcoded.
const SELF_SERVE_HOMEPAGE_URL = process.env.SELF_SERVE_HOMEPAGE_URL;
const SELF_SERVE_SETUP_WIZARD_URL = process.env.SELF_SERVE_SETUP_WIZARD_URL;
const SELF_SERVE_DASHBOARD_URL = process.env.SELF_SERVE_DASHBOARD_URL;
const N8N_NIGHTLY_REPORT_URL = process.env.N8N_NIGHTLY_REPORT_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;

function encodeState(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function decodeState(b64) {
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Self-serve: public "Connect to Xero" entry point ───────────────────────
// No client_id needed anymore — identity (new vs returning tenant) is
// resolved entirely in the callback, from Xero's own /connections response.
// A random nonce + short-lived httpOnly cookie protects against CSRF.
app.get('/oauth/connect', (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = encodeState({ mode: 'self_serve', nonce });
  res.cookie('oauth_state', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 10 * 60 * 1000, // 10 minutes — only needs to survive the Xero round trip
  });
  res.redirect(xero.buildAuthUrl(state));
});

// ── Practice: one bookkeeper (e.g. Marissa) authorizes access to MANY orgs ─
// Call: GET /oauth/connect-practice?owner_label=Marissa
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

  // Consent denial — Xero echoes state back even on denial, so route by mode
  // if we can decode it; fall back to the self-serve homepage if we can't.
  if (error) {
    let mode = null;
    try { mode = decodeState(state).mode; } catch (_) { /* fall through to default */ }
    res.clearCookie('oauth_state');
    if (mode === 'practice') {
      return res.status(400).send(`<h2>Access denied.</h2><p>Xero returned: ${error}</p>`);
    }
    return res.redirect(`${SELF_SERVE_HOMEPAGE_URL}?error=access_denied`);
  }

  // Decode + verify state — this is the CSRF check. A missing/malformed
  // state, or a nonce that doesn't match the cookie set at /oauth/connect,
  // means this request didn't originate from a browser we sent to Xero.
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

    // ── Practice mode: business logic untouched, only state parsing changed ──
    if (parsedState.mode === 'practice') {
      const connectionId = await tokenManager.createConnection(tokenResponse, 'practice', parsedState.owner_label);

      // Auto-match each returned org against client_config, by existing xero_tenant_id
      // first, then by exact client_name == org name as a fallback.
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

    // ── Self-serve mode: connect-first — identity resolved here, not upfront ──
    if (parsedState.mode === 'self_serve') {
      const tenantId = orgs[0].tenantId;
      const tenantName = orgs[0].tenantName;

      const existing = await pool.query(
        'SELECT client_id, connection_id FROM oauth_tokens WHERE xero_tenant_id = $1',
        [tenantId]
      );

      let clientId;

      if (existing.rows.length > 0) {
        // Branch A: known tenant — refresh tokens on the existing connection.
        // "Known" only means we've seen this tenant before; whether the
        // client finished onboarding is decided separately below.
        clientId = existing.rows[0].client_id;
        await tokenManager.saveRefreshedTokens(existing.rows[0].connection_id, tokenResponse);
      } else {
        // Branch B: new tenant — auto-create client_config + connection + mapping.
        try {
          // super_payment_mode defaults to 'payday' here — quarterly mode is no
          // longer relevant post-July, so this is never asked in the Setup Wizard.
          const c = await pool.query(
            "INSERT INTO client_config (client_name, xero_tenant_id, super_payment_mode) VALUES ($1, $2, 'payday') RETURNING id",
            [tenantName, tenantId]
          );
          clientId = c.rows[0].id;
          const connectionId = await tokenManager.createConnection(tokenResponse, 'self_serve', tenantName);
          await tokenManager.linkClientToConnection(clientId, connectionId, tenantId);
        } catch (e) {
          if (e.code === '23505') {
            // Lost a race to a concurrent callback for the same tenant (e.g. a
            // double-click) — fall back to the Branch A update path instead
            // of leaving a duplicate client_config row with no valid tokens.
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

      // "Known tenant" and "fully configured" are not the same condition —
      // check completeness fresh every time, so an abandoned Setup Wizard
      // routes back to the wizard on the next connect, not straight to the Dashboard.
      const { rows: configRows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
      const complete = isConfigComplete(configRows[0]);

      const sessionToken = await createSession(clientId);
      res.cookie('rg_token', sessionToken, {
        domain: '.fasttrackledger.com',
        secure: true,
        httpOnly: false, // must be readable by Appsmith's client-side JS for the smuggling flow
        sameSite: 'Lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });

      const destination = complete ? SELF_SERVE_DASHBOARD_URL : SELF_SERVE_SETUP_WIZARD_URL;
      return res.redirect(`${destination}?token=${sessionToken}`);
    }

    res.status(400).send('Unknown OAuth mode in state.');
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send(`Connection failed: ${e.message}`);
  }
});

// ── Self-serve session check — Appsmith's onPageLoad calls this ───────────
app.get('/session/whoami', resolveSession, (req, res) => {
  res.json({ client_id: req.client_id, status: 'active' });
});

// ── Self-serve report trigger — checks completeness, then forwards to n8n ──
// Practice mode (Marissa's existing Execute page button) is UNCHANGED and
// still calls n8n directly — this route exists only so a self-serve client
// can't fire a report run through an incomplete config, however it's called.
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

// ── Generic Xero API proxy ──────────────────────────────────────────────
// n8n calls: https://auth.fasttrackledger.com/proxy/xero/:clientId/<same path Xero expects>
// e.g. /proxy/xero/5/api.xro/2.0/Invoices  ->  forwarded to api.xero.com/api.xro/2.0/Invoices
// Deliberately NOT wrapped in resolveSession — n8n calls this server-to-server
// with no session token to send; it's authenticated by knowing clientId at all.
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

    // Relay rate-limit headers so n8n can back off correctly
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
    res.status(502).json({ error: e.message, code: e.code || 'PROXY_ERROR' });
  }
});

// ── Xero disconnect webhook ─────────────────────────────────────────────
// TODO before go-live: validate the HMAC-SHA256 signature Xero sends in the
// 'x-xero-signature' header, using your webhook signing key from the Xero
// Developer Portal. Must respond within 5 seconds. See:
// https://developer.xero.com/documentation/guides/webhooks/overview/
app.post('/webhooks/xero', express.raw({ type: '*/*' }), async (req, res) => {
  // Placeholder: accept and log only. DO NOT rely on this for real disconnect
  // handling until signature validation is added.
  console.log('Received Xero webhook (signature validation not yet implemented)');
  res.sendStatus(200);
});

startSessionCleanupJob();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Gateway listening on port ${PORT}`));

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const pool = require('./db');
const xero = require('./xero');
const tokenManager = require('./tokenManager');

const app = express();
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Self-serve: one client authorizes their own single Xero org ───────────
// Call: GET /oauth/connect?client_id=5
app.get('/oauth/connect', (req, res) => {
  const clientId = req.query.client_id;
  if (!clientId) return res.status(400).send('Missing client_id');
  const state = Buffer.from(JSON.stringify({ mode: 'self_serve', client_id: clientId })).toString('base64');
  res.redirect(xero.buildAuthUrl(state));
});

// ── Practice: one bookkeeper (e.g. Marissa) authorizes access to MANY orgs ─
// Call: GET /oauth/connect-practice?owner_label=Marissa
app.get('/oauth/connect-practice', (req, res) => {
  const ownerLabel = req.query.owner_label || 'Practice';
  const state = Buffer.from(JSON.stringify({ mode: 'practice', owner_label: ownerLabel })).toString('base64');
  res.redirect(xero.buildAuthUrl(state));
});

// ── Xero redirects back here after "Allow access" ──────────────────────────
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Xero returned an error: ${error}`);

    const parsedState = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    const tokenResponse = await xero.exchangeCodeForToken(code);
    const orgs = await xero.fetchConnections(tokenResponse.access_token);

    if (!orgs.length) return res.status(400).send('No Xero organisation was authorized.');

    if (parsedState.mode === 'self_serve') {
      const clientId = parsedState.client_id;
      const tenantId = orgs[0].tenantId;
      const connectionId = await tokenManager.createConnection(tokenResponse, 'self_serve', `client-${clientId}`);
      await tokenManager.linkClientToConnection(clientId, connectionId, tenantId);
      await pool.query('UPDATE client_config SET xero_tenant_id = $1 WHERE id = $2', [tenantId, clientId]);
      return res.send('<h2>Xero connected successfully.</h2><p>You can close this window.</p>');
    }

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

    res.status(400).send('Unknown OAuth mode in state.');
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send(`Connection failed: ${e.message}`);
  }
});

// ── Generic Xero API proxy ──────────────────────────────────────────────
// n8n calls: https://auth.fasttrackledger.com/proxy/xero/:clientId/<same path Xero expects>
// e.g. /proxy/xero/5/api.xro/2.0/Invoices  ->  forwarded to api.xero.com/api.xro/2.0/Invoices
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Gateway listening on port ${PORT}`));

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

// ── Step 1: Start OAuth — redirect client to Xero's consent screen ────────
// Call: GET /oauth/connect?client_id=5
app.get('/oauth/connect', (req, res) => {
  const clientId = req.query.client_id;
  if (!clientId) return res.status(400).send('Missing client_id');

  // state carries client_id through the redirect round-trip.
  // (MVP: no separate nonce/session store yet — fine for now, harden later if needed.)
  const state = Buffer.from(JSON.stringify({ client_id: clientId })).toString('base64');
  res.redirect(xero.buildAuthUrl(state));
});

// ── Step 2: Xero redirects back here after the user clicks "Allow access" ─
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Xero returned an error: ${error}`);

    const { client_id: clientId } = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));

    const tokenResponse = await xero.exchangeCodeForToken(code);
    const connections = await xero.fetchConnections(tokenResponse.access_token);

    if (!connections.length) {
      return res.status(400).send('No Xero organisation was authorized.');
    }
    // Self-serve: one client = one org. Take the first (only) connection.
    const tenantId = connections[0].tenantId;

    await tokenManager.saveTokens(clientId, tokenResponse, tenantId, 'self_serve');

    // Keep client_config.xero_tenant_id in sync for this client
    await pool.query('UPDATE client_config SET xero_tenant_id = $1 WHERE id = $2', [tenantId, clientId]);

    res.send('<h2>Xero connected successfully.</h2><p>You can close this window.</p>');
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

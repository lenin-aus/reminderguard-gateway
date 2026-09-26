'use strict';

// Local dev stack only. GET /dev/login runs the REAL sign-in logic (completeFastledgerSignIn:
// ownership decisions, connections, sessions) with the Xero parts faked, then redirects exactly
// like /oauth/callback does. Registered only when XERO_FIXTURES=1 (see server.js).
//
//   /dev/login?subject=alice&orgs=<tenantId>:<name>,<tenantId>:<name>
//   /dev/login?subject=alice&orgs=...&intent=add&ticket=<from POST /accounts/me/connect-ticket>

const { startFlow, redeemConnectTicket } = require('./oauthFlow');
const { completeFastledgerSignIn, makeTransaction, redirectUrlFor } = require('./fastledgerAuth');
const { createAccountSession } = require('./session');

function registerDevAuth(app, { pool, redis, xero, tokenManager, accounts, FASTLEDGER_URL }) {
  if (process.env.XERO_FIXTURES !== '1') throw new Error('devAuth is for the local dev stack only');

  app.get('/dev/login', async (req, res) => {
    try {
      const subject = String(req.query.subject || '');
      if (!subject) return res.status(400).send('subject is required');
      const orgs = String(req.query.orgs || '')
        .split(',')
        .filter(Boolean)
        .map((pair) => {
          const [tenantId, ...name] = pair.split(':');
          return { tenantId, tenantName: name.join(':') || tenantId };
        });
      const intent = req.query.intent === 'add' ? 'add' : 'signin';
      let accountId = null;
      if (intent === 'add') {
        accountId = await redeemConnectTicket(redis, String(req.query.ticket || ''));
        if (accountId === null) return res.status(400).send('This link has expired.');
      }
      const { nonce, oidcNonce } = await startFlow(redis, { intent, accountId, returnApp: 'fastledger' });

      const result = await completeFastledgerSignIn(
        {
          pool,
          redis,
          tokenManager,
          accounts,
          xero: {
            ...xero,
            fetchConnections: async () => orgs,
            authEventIdFromToken: () => null,
            fetchOrganisation: async () => ({ BaseCurrency: 'AUD' }),
          },
          verifyIdToken: async (_idToken, { nonce: n }) => {
            if (n !== oidcNonce) throw new Error('nonce mismatch');
            return { subject, xeroUserId: null, email: `${subject}@dev.example`, name: subject };
          },
          createAccountSession,
          transaction: makeTransaction(pool),
          senderDefaults: { email: process.env.DEFAULT_SENDER_EMAIL, name: process.env.DEFAULT_SENDER_NAME },
        },
        { csrfNonce: nonce, tokenResponse: { access_token: 'dev-access-token', refresh_token: 'dev-refresh-token', expires_in: 1800, id_token: 'dev' } }
      );
      if (!result.ok) return res.status(result.status).send(result.message);
      res.redirect(redirectUrlFor(result, FASTLEDGER_URL));
    } catch (e) {
      console.error('dev login error:', e);
      res.status(500).send(String(e.message));
    }
  });
}

module.exports = { registerDevAuth };

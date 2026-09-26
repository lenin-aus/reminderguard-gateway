'use strict';

// Handlers for the signed-in person (as opposed to one org): who am I and which orgs do I have,
// the one-time ticket that starts "Connect another org", and remembering the last org used.
// All run after resolveSession. They are built from their dependencies so tests can fake them.

const { createConnectTicket } = require('./oauthFlow');

function createAccountHandlers({ db, redis, accounts }) {
  // Backward compatible with the legacy answer ({ client_id, status }): for an account, client_id
  // and status describe the org the app should open first, and the rest is new.
  async function whoami(req, res) {
    try {
      if (!req.account_id) {
        const { rows } = await db.query(
          `SELECT c.access_token, c.refresh_token
             FROM oauth_tokens ot JOIN connections c ON c.id = ot.connection_id
            WHERE ot.client_id = $1`,
          [req.client_id]
        );
        const conn = rows[0];
        const reconnectRequired = !conn || conn.access_token === null || conn.refresh_token === null;
        return res.json({ client_id: req.client_id, status: reconnectRequired ? 'RECONNECT_REQUIRED' : 'active' });
      }

      const [account, clients] = await Promise.all([accounts.getAccount(db, req.account_id), accounts.listAccountClients(db, req.account_id)]);
      if (!account) return res.status(401).json({ error: 'Invalid or expired session' });
      const lastId = clients.some((c) => c.client_id === account.last_client_id) ? account.last_client_id : null;
      const active = clients.find((c) => c.client_id === lastId) || clients[0] || null;
      res.json({
        client_id: active ? active.client_id : null,
        status: active ? active.status : 'NO_ORGS',
        last_client_id: lastId,
        account: { id: account.id, display_name: account.display_name, email: account.email },
        clients,
      });
    } catch (e) {
      console.error('whoami error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }

  // The ticket binds "Connect another org" to this account without putting the session token in a
  // URL. Legacy sessions have no account, so they cannot add orgs.
  async function connectTicket(req, res) {
    if (!req.account_id) return res.status(403).json({ error: 'This session cannot add organisations. Sign in again.' });
    try {
      const ticket = await createConnectTicket(redis, req.account_id);
      res.json({ ticket });
    } catch (e) {
      console.error('connect-ticket error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }

  async function setLastClient(req, res) {
    if (!req.account_id) return res.status(403).json({ error: 'Forbidden' });
    const clientId = req.body && req.body.client_id;
    if (!Number.isInteger(clientId)) return res.status(400).json({ error: 'client_id must be a number' });
    try {
      const ok = await accounts.setLastClient(db, req.account_id, clientId);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
      res.json({ last_client_id: clientId });
    } catch (e) {
      console.error('last-client error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }

  return { whoami, connectTicket, setLastClient };
}

module.exports = { createAccountHandlers };

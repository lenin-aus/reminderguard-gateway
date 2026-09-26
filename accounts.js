'use strict';

// Accounts for multi-org (see context/docs/multiorg.md in the frontend repo; tables in
// migrations/003_accounts.sql). An account is a person, identified by a Xero login (the id_token
// "sub"); an account owns orgs (client_config rows); an org has exactly one owner.
//
// Every database function takes `db` first: a pg Pool or, inside a transaction, the client. None
// of them opens a transaction; the caller decides what must succeed or fail together.

const PROVIDER = 'xero';

// ── The rule for an org that Xero returns during a connect ────────────────────────────────────
// org: null when the tenant is not connected anywhere, otherwise
//   { clientId, ownerAccountId (null when the row predates accounts), accountHasAccess }
//
//   create     the tenant is new: create the org, and this account owns it
//   claim      the org exists but has no owner: this account becomes the owner
//   reconnect  this account already has the org (owner, or a member later): refresh its access
//   reject     another account owns it: touch nothing, and record why
function decideOrgOwnership({ accountId, org }) {
  if (!org) return { action: 'create' };
  if (org.ownerAccountId === null || org.ownerAccountId === undefined) {
    return { action: 'claim', clientId: org.clientId };
  }
  if (org.ownerAccountId === accountId || org.accountHasAccess) {
    return { action: 'reconnect', clientId: org.clientId };
  }
  return { action: 'reject', clientId: org.clientId, ownerAccountId: org.ownerAccountId };
}

// The org row for a Xero tenant plus what the decision needs, or null.
async function getOrgByTenant(db, tenantId, accountId) {
  const { rows } = await db.query(
    `SELECT ot.client_id, ot.connection_id,
            (SELECT ac.account_id FROM account_clients ac
              WHERE ac.client_id = ot.client_id AND ac.role = 'owner') AS owner_account_id,
            EXISTS (SELECT 1 FROM account_clients ac
                     WHERE ac.client_id = ot.client_id AND ac.account_id = $2) AS account_has_access
       FROM oauth_tokens ot
      WHERE ot.xero_tenant_id = $1`,
    [tenantId, accountId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    clientId: r.client_id,
    connectionId: r.connection_id,
    ownerAccountId: r.owner_account_id,
    accountHasAccess: r.account_has_access,
  };
}

// ── People and their Xero logins ──────────────────────────────────────────────────────────────

// Sign in: the account for this Xero login, created the first time. The email and name are kept
// for display and for unpicking a lock-out; the login is identified by `subject`, never by email.
async function findOrCreateAccountForIdentity(db, { subject, email = null, displayName = null, provider = PROVIDER }) {
  const existing = await db.query(
    `UPDATE account_identities
        SET last_login_at = now(), email = COALESCE($3, email), display_name = COALESCE($4, display_name)
      WHERE provider = $1 AND subject = $2
  RETURNING account_id`,
    [provider, subject, email, displayName]
  );
  if (existing.rows.length > 0) return { accountId: existing.rows[0].account_id, created: false };

  const account = await db.query(`INSERT INTO accounts (display_name, email) VALUES ($1, $2) RETURNING id`, [displayName, email]);
  const accountId = account.rows[0].id;
  const identity = await db.query(
    `INSERT INTO account_identities (account_id, provider, subject, email, display_name, last_login_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider, subject) DO NOTHING
     RETURNING id`,
    [accountId, provider, subject, email, displayName]
  );
  if (identity.rows.length > 0) return { accountId, created: true };

  // Two first sign-ins raced and the other won: drop the account just made and use theirs.
  await db.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
  const winner = await db.query(`SELECT account_id FROM account_identities WHERE provider = $1 AND subject = $2`, [provider, subject]);
  return { accountId: winner.rows[0].account_id, created: false };
}

// "Connect another org" while signed in, with a Xero login that may not be on this account yet.
//   added                     the login is now on this account
//   already_on_account        nothing to do
//   moved_from_empty_account  the login sat on an account with no orgs (for example one created by
//                             signing in with it first); moved here, and that account deleted if
//                             nothing else uses it. This is the way out of a lock-out without SQL.
//   conflict                  the login belongs to an account that owns orgs: refused, and the
//                             caller records it. Merging two people's accounts is never automatic.
async function addIdentityToAccount(db, accountId, { subject, email = null, displayName = null, provider = PROVIDER }) {
  const found = await db.query(`SELECT id, account_id FROM account_identities WHERE provider = $1 AND subject = $2`, [provider, subject]);

  if (found.rows.length === 0) {
    await db.query(
      `INSERT INTO account_identities (account_id, provider, subject, email, display_name, last_login_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [accountId, provider, subject, email, displayName]
    );
    return { result: 'added' };
  }

  const otherAccountId = found.rows[0].account_id;
  if (otherAccountId === accountId) {
    await db.query(`UPDATE account_identities SET last_login_at = now() WHERE id = $1`, [found.rows[0].id]);
    return { result: 'already_on_account' };
  }

  const orgs = await db.query(`SELECT 1 FROM account_clients WHERE account_id = $1 LIMIT 1`, [otherAccountId]);
  if (orgs.rows.length > 0) return { result: 'conflict', otherAccountId };

  await db.query(
    `UPDATE account_identities SET account_id = $1, last_login_at = now(),
            email = COALESCE($2, email), display_name = COALESCE($3, display_name)
      WHERE id = $4`,
    [accountId, email, displayName, found.rows[0].id]
  );
  const left = await db.query(`SELECT 1 FROM account_identities WHERE account_id = $1 LIMIT 1`, [otherAccountId]);
  if (left.rows.length === 0) await db.query(`DELETE FROM accounts WHERE id = $1`, [otherAccountId]);
  return { result: 'moved_from_empty_account', otherAccountId };
}

// ── Orgs of an account ────────────────────────────────────────────────────────────────────────

// Everything the org picker needs. status mirrors /session/whoami: an org whose connection has lost
// its tokens (or has none) needs reconnecting, and so does every other org on that connection.
async function listAccountClients(db, accountId) {
  const { rows } = await db.query(
    `SELECT cc.id AS client_id, cc.client_name AS name, cc.base_currency, ac.role,
            (c.access_token IS NOT NULL AND c.refresh_token IS NOT NULL) AS connected
       FROM account_clients ac
       JOIN client_config cc ON cc.id = ac.client_id
  LEFT JOIN oauth_tokens ot ON ot.client_id = cc.id
  LEFT JOIN connections c ON c.id = ot.connection_id
      WHERE ac.account_id = $1
   ORDER BY lower(cc.client_name), cc.id`,
    [accountId]
  );
  return rows.map((r) => ({
    client_id: r.client_id,
    name: r.name,
    base_currency: r.base_currency,
    role: r.role,
    status: r.connected ? 'active' : 'RECONNECT_REQUIRED',
  }));
}

async function canAccessClient(db, accountId, clientId) {
  const { rows } = await db.query(`SELECT 1 FROM account_clients WHERE account_id = $1 AND client_id = $2`, [accountId, clientId]);
  return rows.length > 0;
}

// The last-used org follows the person across devices. Only an org the account can use is stored.
async function setLastClient(db, accountId, clientId) {
  const { rows } = await db.query(
    `UPDATE accounts SET last_client_id = $2
      WHERE id = $1
        AND EXISTS (SELECT 1 FROM account_clients WHERE account_id = $1 AND client_id = $2)
  RETURNING id`,
    [accountId, clientId]
  );
  return rows.length > 0;
}

async function getAccount(db, accountId) {
  const { rows } = await db.query(`SELECT id, display_name, email, last_client_id FROM accounts WHERE id = $1`, [accountId]);
  return rows[0] || null;
}

// Make this account the owner of the org, unless a different account already owns it. Returns
// whether the account is now the owner. Two claims racing can make the database's one-owner index
// raise 23505 for the loser; the caller treats that as "decide again".
async function claimOrg(db, accountId, clientId) {
  const { rows } = await db.query(
    `INSERT INTO account_clients (account_id, client_id, role)
     SELECT $1, $2, 'owner'
      WHERE NOT EXISTS (SELECT 1 FROM account_clients WHERE client_id = $2 AND role = 'owner' AND account_id <> $1)
     ON CONFLICT (account_id, client_id) DO UPDATE SET role = 'owner'
     RETURNING account_id`,
    [accountId, clientId]
  );
  return rows.length > 0;
}

// ── Refusals ──────────────────────────────────────────────────────────────────────────────────
// Recorded so the operator can unpick a lock-out (a person who connected an org under one Xero
// login and later signs in with another). Never shown to the user: the response only says the org
// is already connected to another account.

function formatRejectionLog({ tenantId, clientId, ownerAccountId, attemptingAccountId, attemptingSubject, intent }) {
  const v = (x) => (x === null || x === undefined ? '-' : x);
  return `[org-connect] REJECTED tenant=${v(tenantId)} client=${v(clientId)} owner_account=${v(ownerAccountId)} attempting_account=${v(attemptingAccountId)} attempting_login=${v(attemptingSubject)} intent=${v(intent)}`;
}

async function recordRejection(db, { tenantId, tenantName = null, clientId, ownerAccountId, attemptingAccountId, attemptingSubject = null, attemptingEmail = null, intent = null }) {
  await db.query(
    `INSERT INTO account_connect_rejections
       (xero_tenant_id, tenant_name, client_id, owning_account_id, attempting_account_id, attempting_subject, attempting_email, intent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, tenantName, clientId, ownerAccountId, attemptingAccountId, attemptingSubject, attemptingEmail, intent]
  );
}

module.exports = {
  PROVIDER,
  decideOrgOwnership,
  getOrgByTenant,
  findOrCreateAccountForIdentity,
  addIdentityToAccount,
  listAccountClients,
  canAccessClient,
  setLastClient,
  getAccount,
  claimOrg,
  formatRejectionLog,
  recordRejection,
};

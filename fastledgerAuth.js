'use strict';

// The fastledger half of the OAuth callback: who signed in, which orgs they get, and a session.
// Dependencies are passed in so the whole decision logic runs in tests with fakes and a rolled-back
// transaction; server.js wires the real ones.
//
//   1. The round trip's server-side record (oauthFlow) says what this sign-in was for.
//   2. The id_token says WHO signed in (oidc.js). The account is found or created from that login.
//   3. Each org Xero returned for THIS consent is decided by the ownership rule (accounts.js):
//        create     a new org row, owned by this account
//        claim      an org from before accounts, now owned by this account
//        reconnect  an org this account already has: refresh its access
//        reject     another account owns it: nothing is touched, and the refusal is recorded
//      New tokens always become a NEW connection and only the orgs of this consent are re-pointed to
//      it, so reconnecting one org cannot break another that shared the old connection.
//   4. A session for the account (a plain sign-in) and where the user goes next.

const { consumeFlow } = require('./oauthFlow');
const { OidcError } = require('./oidc');

const fail = (status, code, message) => ({ ok: false, status, code, message });

const REJECT_MESSAGE = 'That organisation is already connected to another FastLedger account.';

async function completeFastledgerSignIn(deps, { csrfNonce, tokenResponse }) {
  const { pool, redis, verifyIdToken, xero, tokenManager, accounts, createAccountSession, transaction, senderDefaults = {}, log = console } = deps;

  // 1. The round trip.
  const flow = await consumeFlow(redis, csrfNonce);
  if (!flow) return fail(403, 'FLOW_EXPIRED', 'This sign-in has expired. Please go back and try again.');

  // 2. Who signed in.
  let identity;
  try {
    identity = await verifyIdToken(tokenResponse.id_token, { nonce: flow.oidcNonce });
  } catch (err) {
    const code = err instanceof OidcError ? err.code : 'ERROR';
    log.warn?.(`[org-connect] id_token refused (${code})`);
    if (code === 'KEYS_UNAVAILABLE') return fail(502, code, 'We could not verify your Xero sign-in just now. Please try again in a minute.');
    return fail(403, code, 'Your Xero sign-in could not be verified. Please try again.');
  }

  let accountId;
  if (flow.intent === 'add') {
    accountId = flow.accountId;
    if (!(await accounts.getAccount(pool, accountId))) return fail(403, 'NO_ACCOUNT', 'Your session has ended. Please sign in again.');
    const added = await accounts.addIdentityToAccount(pool, accountId, identity);
    if (added.result === 'conflict') {
      log.warn?.(`[org-connect] IDENTITY_CONFLICT account=${accountId} other_account=${added.otherAccountId} login=${identity.subject}`);
      return fail(409, 'IDENTITY_CONFLICT', 'That Xero login already belongs to another FastLedger account.');
    }
  } else {
    ({ accountId } = await accounts.findOrCreateAccountForIdentity(pool, identity));
  }

  // 3. The orgs ticked in this consent.
  const orgs = await xero.fetchConnections(tokenResponse.access_token, xero.authEventIdFromToken(tokenResponse.access_token));
  if (!orgs.length) return fail(400, 'NO_ORGS', 'No Xero organisation was authorised.');

  let connectionId = null; // created for the first org that is accepted, shared by all of them
  const replaced = new Set();
  const connected = [];
  const skipped = [];

  for (const org of orgs) {
    const found = await accounts.getOrgByTenant(pool, org.tenantId, accountId);
    const decision = accounts.decideOrgOwnership({ accountId, org: found });

    if (decision.action === 'reject') {
      log.warn?.(accounts.formatRejectionLog({ tenantId: org.tenantId, clientId: decision.clientId, ownerAccountId: decision.ownerAccountId, attemptingAccountId: accountId, attemptingSubject: identity.subject, intent: flow.intent }));
      await accounts.recordRejection(pool, { tenantId: org.tenantId, tenantName: org.tenantName, clientId: decision.clientId, ownerAccountId: decision.ownerAccountId, attemptingAccountId: accountId, attemptingSubject: identity.subject, attemptingEmail: identity.email, intent: flow.intent });
      skipped.push({ name: org.tenantName, reason: 'OWNED_BY_ANOTHER_ACCOUNT' });
      continue;
    }

    try {
      // Read the org's own record first (a network call, kept out of the transaction). If it cannot
      // be read the base currency is left empty, and it is looked up the first time it is needed.
      let baseCurrency = null;
      if (decision.action === 'create') {
        const info = await xero.fetchOrganisation(tokenResponse.access_token, org.tenantId).catch(() => null);
        baseCurrency = info?.BaseCurrency ? String(info.BaseCurrency).toUpperCase() : null;
      }

      let createdHere = null;
      const clientId = await transaction(async (db) => {
        createdHere = null;
        if (!connectionId) createdHere = await tokenManager.createConnection(tokenResponse, 'self_serve', identity.email || 'Xero sign-in', db);
        const useConnection = connectionId || createdHere;
        let id = decision.clientId;
        if (decision.action === 'create') {
          const created = await db.query(
            `INSERT INTO client_config (client_name, xero_tenant_id, super_payment_mode, sender_email, sender_name, base_currency)
             VALUES ($1, $2, 'payday', $3, $4, $5) RETURNING id`,
            [org.tenantName, org.tenantId, senderDefaults.email || null, senderDefaults.name || null, baseCurrency]
          );
          id = created.rows[0].id;
        }
        if (found?.connectionId && found.connectionId !== useConnection) replaced.add(found.connectionId);
        await tokenManager.linkClientToConnection(id, useConnection, org.tenantId, db);
        // A reconnect is an account that already has the org, so only create and claim take ownership.
        if (decision.action !== 'reconnect') {
          if (!(await accounts.claimOrg(db, accountId, id))) throw Object.assign(new Error('lost the ownership race'), { code: 'OWNERSHIP_RACE' });
        }
        return id;
      });
      // Only remembered once its transaction committed, so a rolled-back org cannot leave a dangling id.
      if (createdHere) connectionId = createdHere;
      connected.push({ clientId, name: org.tenantName, action: decision.action });
    } catch (err) {
      // One org failing must not undo the others. The connection created for it may now be unused.
      log.error?.(`[org-connect] could not connect tenant=${org.tenantId}: ${err.message}`);
      skipped.push({ name: org.tenantName, reason: err.code === 'OWNERSHIP_RACE' ? 'OWNED_BY_ANOTHER_ACCOUNT' : 'ERROR' });
    }
  }

  // Connections nothing points at any more (replaced, or created for an org that failed).
  for (const id of [...replaced, connectionId].filter(Boolean)) await tokenManager.deleteConnectionIfUnused(id, pool);

  if (connected.length === 0 && flow.intent === 'signin' && (await accounts.listAccountClients(pool, accountId)).length === 0) {
    const owned = skipped.some((s) => s.reason === 'OWNED_BY_ANOTHER_ACCOUNT');
    return fail(owned ? 403 : 500, owned ? 'ORG_OWNED_BY_ANOTHER_ACCOUNT' : 'CONNECT_FAILED', owned ? REJECT_MESSAGE : 'We could not connect your organisation. Please try again.');
  }

  // 4. Where they land: a newly connected org first, otherwise the org they used last.
  let activeClientId = null;
  if (connected.length > 0) {
    activeClientId = connected[0].clientId;
    await accounts.setLastClient(pool, accountId, activeClientId);
  } else {
    activeClientId = (await accounts.getAccount(pool, accountId))?.last_client_id ?? null;
  }

  // A plain sign-in starts a session. "Connect another org" happens inside one, so it keeps it.
  const sessionToken = flow.intent === 'signin' ? await createAccountSession(accountId) : null;
  return { ok: true, intent: flow.intent, accountId, sessionToken, connected, skipped, activeClientId };
}

// Runs fn(db) in one transaction on a dedicated connection.
function makeTransaction(pool) {
  return async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}

module.exports = { completeFastledgerSignIn, makeTransaction, REJECT_MESSAGE };
